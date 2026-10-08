"""Storage for ID-verification attempts and webhook events.

Two implementations behind one protocol:

* ``PostgresIdVerificationRepository`` — durable store for configured
  provider modes (sandbox/live). Uses the existing ``db.query`` /
  ``db.with_transaction`` pattern and tenant columns. A missing table (030
  migration not applied) surfaces as ``StorageUnavailableError`` so callers
  fail closed rather than silently dropping verification state.

* ``InMemoryIdVerificationRepository`` — fixture mode ONLY
  (``SUMSUB_MODE=fixture``). Per-process, clearly labelled; never used as
  durable webhook storage and never in provider modes.

Row shapes are plain dicts; only allowlisted fields are persisted — never
raw webhook bodies, document images, OCR payloads or tokens.
"""

import asyncio
import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Protocol

import db

OPEN_STATUSES = ("started", "pending", "review_required")
TERMINAL_STATUSES = ("verified", "declined")


class StorageUnavailableError(Exception):
    """Durable storage is not available — fail closed."""


class AttemptConflictError(Exception):
    """Concurrent start raced; caller should re-read the winning row."""


class AttemptRepository(Protocol):
    async def get_attempt(self, environment: str, ai: int, transfer_party_id: str, attempt_no: int) -> Optional[dict]: ...
    async def get_open_attempt(self, environment: str, ai: int, transfer_party_id: str) -> Optional[dict]: ...
    async def get_latest_attempt(self, environment: str, ai: int, transfer_party_id: str) -> Optional[dict]: ...
    async def list_attempts_by_external_ref(self, environment: str, external_ref: str) -> List[dict]: ...
    async def list_attempts_by_applicant_id(self, environment: str, applicant_id: str) -> List[dict]: ...
    async def create_attempt(self, attempt: dict) -> dict: ...
    async def update_attempt_fields(self, attempt_id: str, fields: dict) -> dict: ...
    async def apply_event(self, event: dict, *, attempt_id: Optional[str], fields: Optional[dict], incoming_ts: Optional[float], mark_processed: bool = True, confirmed: bool = False, expected_version: Optional[int] = None) -> dict:
        """Atomic event receipt + state application. See implementations."""
        ...
    async def list_events_for_attempt(self, attempt_id: str) -> List[dict]: ...


def event_dedupe_key(environment: str, event_type: str, applicant_id: str,
                     correlation_id: Optional[str], review_status: Optional[str],
                     review_answer: Optional[str], created_at_ms: Optional[str]) -> str:
    """Composite dedupe key — correlationId is shared across related events
    and cannot dedupe alone (Sumsub docs, accessed 2026-10-08)."""
    raw = "|".join(
        (environment or "", event_type or "", applicant_id or "",
         correlation_id or "", review_status or "", review_answer or "", created_at_ms or "")
    )
    return hashlib.sha256(raw.encode()).hexdigest()


# --------------------------------------------------------------------------
# Durable Postgres implementation
# --------------------------------------------------------------------------

_ATTEMPT_COLUMNS = (
    "id", "environment", "accountable_institution_id", "transfer_id",
    "transfer_party_id", "subject_kind", "on_behalf_of_party_id", "attempt_no",
    "external_ref", "provider", "provider_applicant_id", "level_name",
    "inspection_id", "status",
    "review_answer", "review_reject_type", "reject_labels",
    "last_correlation_id", "last_event_created_at_ms", "last_event_type",
    "version", "simulated", "created_at", "updated_at",
)

_EVENT_COLUMNS = (
    "id", "attempt_id", "environment", "dedupe_key", "event_type",
    "provider_applicant_id", "external_ref", "correlation_id", "level_name",
    "inspection_id", "review_status", "review_answer", "review_reject_type",
    "reject_labels", "provider_created_at_ms", "received_at", "processed_at",
    "disposition",
)


def _row_to_dict(row: Any) -> dict:
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            d[k] = str(v)
    for k in ("created_at", "updated_at", "received_at", "processed_at"):
        v = d.get(k)
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


def _storage_failure(exc: Exception) -> StorageUnavailableError:
    """Sanitised storage failure — never carries SQL or parameter detail."""
    return StorageUnavailableError("verification storage operation failed")


def _ms_ts(raw: Any) -> Optional[float]:
    """Parse the provider's 'yyyy-MM-dd HH:mm:ss.fff' UTC timestamp."""
    if not isinstance(raw, str):
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    return None


class PostgresIdVerificationRepository:
    """Durable storage — requires migration 030. Fails closed if absent."""

    async def _fetch(self, sql: str, params: list, connection=None) -> Optional[dict]:
        result = await db.query(sql, params, connection=connection)
        return _row_to_dict(result.rows[0]) if result.rows else None

    async def _fetch_all(self, sql: str, params: list, connection=None) -> List[dict]:
        result = await db.query(sql, params, connection=connection)
        return [_row_to_dict(r) for r in result.rows]

    async def get_attempt(self, environment, ai, transfer_party_id, attempt_no, *, connection=None):
        return await self._fetch(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND accountable_institution_id=$2 AND transfer_party_id=$3 AND attempt_no=$4",
            [environment, ai, transfer_party_id, attempt_no], connection,
        )

    async def get_open_attempt(self, environment, ai, transfer_party_id, *, connection=None):
        return await self._fetch(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND accountable_institution_id=$2 AND transfer_party_id=$3 AND status = ANY($4)",
            [environment, ai, transfer_party_id, list(OPEN_STATUSES)], connection,
        )

    async def get_latest_attempt(self, environment, ai, transfer_party_id, *, connection=None):
        return await self._fetch(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND accountable_institution_id=$2 AND transfer_party_id=$3 "
            "ORDER BY attempt_no DESC LIMIT 1",
            [environment, ai, transfer_party_id], connection,
        )

    async def list_attempts_by_external_ref(self, environment, external_ref, *, connection=None):
        return await self._fetch_all(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND external_ref=$2 ORDER BY attempt_no DESC",
            [environment, external_ref], connection,
        )

    async def list_attempts_by_applicant_id(self, environment, applicant_id, *, connection=None):
        return await self._fetch_all(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND provider_applicant_id=$2 ORDER BY attempt_no DESC",
            [environment, applicant_id], connection,
        )

    async def create_attempt(self, attempt: dict, *, connection=None) -> dict:
        cols = list(attempt.keys())
        sql = (
            f"INSERT INTO id_verification_attempts ({', '.join(cols)}) "
            f"VALUES ({', '.join(f'${i+1}' for i in range(len(cols)))}) "
            f"RETURNING {', '.join(_ATTEMPT_COLUMNS)}"
        )
        try:
            result = await db.query(sql, [attempt[c] for c in cols], connection=connection)
        except Exception as exc:
            name = type(exc).__name__
            if "UniqueViolation" in name:
                raise AttemptConflictError("attempt already exists") from exc
            raise _storage_failure(exc) from exc
        return _row_to_dict(result.rows[0])

    async def update_attempt_fields(self, attempt_id, fields: dict, *, connection=None) -> dict:
        sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields.keys()))
        sql = (
            f"UPDATE id_verification_attempts SET {sets}, "
            f"version = version + 1, updated_at = now() "
            f"WHERE id = $1 RETURNING {', '.join(_ATTEMPT_COLUMNS)}"
        )
        try:
            result = await db.query(sql, [attempt_id, *fields.values()], connection=connection)
        except Exception as exc:
            raise _storage_failure(exc) from exc
        if not result.rows:
            raise StorageUnavailableError("attempt row vanished")
        return _row_to_dict(result.rows[0])

    async def apply_event(
        self,
        event: dict,
        *,
        attempt_id: Optional[str],
        fields: Optional[dict],
        incoming_ts: Optional[float],
        mark_processed: bool = True,
        confirmed: bool = False,
        expected_version: Optional[int] = None,
    ) -> dict:
        """Atomically (a) dedupe-insert the event, (b) apply the attempt
        update under the attempt row lock with the staleness guard re-checked
        inside the lock, and (c) mark the event processed.

        An insert-then-update failure rolls the whole transaction back, so a
        replay re-runs the full path; a previously *unprocessed* stored event
        is resumed rather than reported as duplicate.

        Ordering is revalidated under the row lock so two deliveries that
        resolved before either committed cannot both apply: strictly older
        than the last applied event is ``stale``; an equal provider
        timestamp is ``ambiguous`` and never applies — only an explicitly
        ``confirmed`` (provider-reconciled) apply may proceed on equality.
        When ``expected_version`` is supplied (a provider-reconciled apply),
        the attempt's state version is compared under the same lock: if the
        state moved while the provider lookup was in flight the apply is
        refused with ``conflict`` and the event is left unprocessed, so
        redelivery resumes it against fresh state. ``ambiguous`` and
        ``conflict`` outcomes never mark the event processed — acknowledging
        an unapplied event would lose it. The lock is never held
        across a provider call; reconciliation happens beforehand and only
        its verdict plus the pre-lookup version enters the transaction.
        Returns {"outcome": "applied"|"stale"|"ambiguous"|"conflict"|"recorded"|"duplicate"}.
        """
        async def work(conn) -> dict:
            cols = list(event.keys())
            ins_sql = (
                f"INSERT INTO id_verification_events ({', '.join(cols)}) "
                f"VALUES ({', '.join(f'${i+1}' for i in range(len(cols)))}) "
                "ON CONFLICT (environment, dedupe_key) DO NOTHING RETURNING id"
            )
            ins = await db.query(ins_sql, [event[c] for c in cols], connection=conn)
            event_id = None
            if ins.rows:
                event_id = ins.rows[0]["id"]
            else:
                # Same delivery re-seen: if it was never durably processed,
                # resume its application instead of reporting a duplicate.
                existing = await db.query(
                    "SELECT id, processed_at FROM id_verification_events "
                    "WHERE environment=$1 AND dedupe_key=$2 FOR UPDATE",
                    [event["environment"], event["dedupe_key"]], connection=conn,
                )
                if not existing.rows:
                    raise StorageUnavailableError("event insert produced no row")
                row = existing.rows[0]
                if row["processed_at"] is not None:
                    return {"outcome": "duplicate"}
                event_id = row["id"]

            outcome = "recorded"
            if attempt_id and fields:
                lock = await db.query(
                    "SELECT last_event_created_at_ms, version "
                    "FROM id_verification_attempts WHERE id=$1 FOR UPDATE",
                    [attempt_id], connection=conn,
                )
                row_version = lock.rows[0]["version"] if lock.rows else None
                last_ts = (
                    _ms_ts(lock.rows[0]["last_event_created_at_ms"]) if lock.rows else None
                )
                if expected_version is not None and row_version != expected_version:
                    # The attempt moved while the provider reconciliation was
                    # in flight — the snapshot is stale. Leave the event
                    # unprocessed so redelivery resumes it.
                    await db.query(
                        "UPDATE id_verification_events SET disposition='version_conflict' WHERE id=$1",
                        [event_id], connection=conn,
                    )
                    outcome = "conflict"
                elif incoming_ts is not None and last_ts is not None and incoming_ts < last_ts:
                    await db.query(
                        "UPDATE id_verification_events SET disposition='out_of_order' WHERE id=$1",
                        [event_id], connection=conn,
                    )
                    outcome = "stale"
                elif (incoming_ts is not None and last_ts is not None
                      and incoming_ts == last_ts and not confirmed):
                    await db.query(
                        "UPDATE id_verification_events SET disposition='ambiguous_not_applied' WHERE id=$1",
                        [event_id], connection=conn,
                    )
                    outcome = "ambiguous"
                else:
                    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields.keys()))
                    upd = (
                        f"UPDATE id_verification_attempts SET {sets}, "
                        f"version = version + 1, updated_at = now() WHERE id = $1"
                    )
                    await db.query(upd, [attempt_id, *fields.values()], connection=conn)
                    outcome = "applied"

            if mark_processed and outcome not in ("conflict", "ambiguous"):
                await db.query(
                    "UPDATE id_verification_events SET processed_at = now() WHERE id=$1",
                    [event_id], connection=conn,
                )
            return {"outcome": outcome}

        try:
            return await db.with_transaction(work)
        except StorageUnavailableError:
            raise
        except Exception as exc:
            raise _storage_failure(exc) from exc

    async def list_events_for_attempt(self, attempt_id, *, connection=None) -> List[dict]:
        return await self._fetch_all(
            f"SELECT {', '.join(_EVENT_COLUMNS)} FROM id_verification_events "
            "WHERE attempt_id=$1 ORDER BY received_at",
            [attempt_id], connection,
        )


# --------------------------------------------------------------------------
# In-memory fixture implementation — SUMSUB_MODE=fixture only.
# --------------------------------------------------------------------------

class InMemoryIdVerificationRepository:
    """Per-process fixture store. Labelled non-durable by construction."""

    durable = False

    def __init__(self) -> None:
        self._attempts: Dict[str, dict] = {}
        self._events: Dict[str, dict] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _new_id() -> str:
        return str(uuid.uuid4())

    async def get_attempt(self, environment, ai, transfer_party_id, attempt_no, *, connection=None):
        with self._lock:
            for a in self._attempts.values():
                if (a["environment"] == environment and a["accountable_institution_id"] == ai
                        and a["transfer_party_id"] == transfer_party_id and a["attempt_no"] == attempt_no):
                    return dict(a)
        return None

    async def get_open_attempt(self, environment, ai, transfer_party_id, *, connection=None):
        with self._lock:
            for a in self._attempts.values():
                if (a["environment"] == environment and a["accountable_institution_id"] == ai
                        and a["transfer_party_id"] == transfer_party_id and a["status"] in OPEN_STATUSES):
                    return dict(a)
        return None

    async def get_latest_attempt(self, environment, ai, transfer_party_id, *, connection=None):
        with self._lock:
            rows = [a for a in self._attempts.values()
                    if a["environment"] == environment and a["accountable_institution_id"] == ai
                    and a["transfer_party_id"] == transfer_party_id]
            return dict(max(rows, key=lambda a: a["attempt_no"])) if rows else None

    async def list_attempts_by_external_ref(self, environment, external_ref, *, connection=None):
        with self._lock:
            rows = [dict(a) for a in self._attempts.values()
                    if a["environment"] == environment and a["external_ref"] == external_ref]
            rows.sort(key=lambda a: a["attempt_no"], reverse=True)
            return rows

    async def list_attempts_by_applicant_id(self, environment, applicant_id, *, connection=None):
        with self._lock:
            rows = [dict(a) for a in self._attempts.values()
                    if a["environment"] == environment and a["provider_applicant_id"] == applicant_id]
            rows.sort(key=lambda a: a["attempt_no"], reverse=True)
            return rows

    async def create_attempt(self, attempt: dict, *, connection=None) -> dict:
        with self._lock:
            key = (attempt["environment"], attempt["accountable_institution_id"],
                   attempt["transfer_party_id"], attempt["attempt_no"])
            for a in self._attempts.values():
                if (a["environment"], a["accountable_institution_id"],
                        a["transfer_party_id"], a["attempt_no"]) == key:
                    raise AttemptConflictError("attempt already exists")
                if (a["environment"] == attempt["environment"]
                        and a["accountable_institution_id"] == attempt["accountable_institution_id"]
                        and a["transfer_party_id"] == attempt["transfer_party_id"]
                        and a["status"] in OPEN_STATUSES
                        and attempt["status"] in OPEN_STATUSES):
                    raise AttemptConflictError("open attempt already exists")
            row = dict(attempt)
            row.setdefault("id", self._new_id())
            row.setdefault("version", 0)
            now = datetime.now(timezone.utc).isoformat()
            row.setdefault("created_at", now)
            row.setdefault("updated_at", now)
            self._attempts[row["id"]] = row
            return dict(row)

    async def update_attempt_fields(self, attempt_id, fields: dict, *, connection=None) -> dict:
        with self._lock:
            if attempt_id not in self._attempts:
                raise StorageUnavailableError("attempt row vanished")
            self._attempts[attempt_id].update(fields)
            self._attempts[attempt_id]["version"] = self._attempts[attempt_id].get("version", 0) + 1
            self._attempts[attempt_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
            return dict(self._attempts[attempt_id])

    async def apply_event(
        self,
        event: dict,
        *,
        attempt_id: Optional[str],
        fields: Optional[dict],
        incoming_ts: Optional[float],
        mark_processed: bool = True,
        confirmed: bool = False,
        expected_version: Optional[int] = None,
    ) -> dict:
        """In-memory mirror of the durable apply_event: one critical section
        (the lock serialises application), unprocessed stored events resume,
        a failed attempt update rolls the staged insert back, and ordering is
        revalidated inside the critical section — strictly older is stale,
        an equal timestamp is ambiguous unless provider-confirmed. Same
        transaction semantics as the Postgres implementation."""
        with self._lock:
            dedupe = (event["environment"], event["dedupe_key"])
            staged = False
            row = None
            for e in self._events.values():
                if (e["environment"], e["dedupe_key"]) == dedupe:
                    if e.get("processed_at") is not None:
                        return {"outcome": "duplicate"}
                    row = e
                    break
            if row is None:
                row = dict(event)
                row.setdefault("id", self._new_id())
                row.setdefault("received_at", datetime.now(timezone.utc).isoformat())
                row.setdefault("processed_at", None)
                self._events[row["id"]] = row
                staged = True
            try:
                outcome = "recorded"
                if attempt_id and fields:
                    if attempt_id not in self._attempts:
                        raise StorageUnavailableError("attempt row vanished")
                    attempt = self._attempts[attempt_id]
                    last_ts = _ms_ts(attempt.get("last_event_created_at_ms"))
                    if (expected_version is not None
                            and attempt.get("version", 0) != expected_version):
                        row["disposition"] = "version_conflict"
                        outcome = "conflict"
                    elif incoming_ts is not None and last_ts is not None and incoming_ts < last_ts:
                        row["disposition"] = "out_of_order"
                        outcome = "stale"
                    elif (incoming_ts is not None and last_ts is not None
                          and incoming_ts == last_ts and not confirmed):
                        row["disposition"] = "ambiguous_not_applied"
                        outcome = "ambiguous"
                    else:
                        self._apply_fields(attempt, fields)
                        outcome = "applied"
                if mark_processed and outcome not in ("conflict", "ambiguous"):
                    row["processed_at"] = datetime.now(timezone.utc).isoformat()
                return {"outcome": outcome}
            except Exception:
                if staged:
                    del self._events[row["id"]]
                raise

    def _apply_fields(self, attempt: dict, fields: dict) -> None:
        """Test seam: the attempt-field write inside apply_event — a test
        subclass can inject a failure here to prove rollback semantics."""
        attempt.update(fields)
        attempt["version"] = attempt.get("version", 0) + 1
        attempt["updated_at"] = datetime.now(timezone.utc).isoformat()

    async def list_events_for_attempt(self, attempt_id, *, connection=None) -> List[dict]:
        with self._lock:
            return [dict(e) for e in self._events.values() if e.get("attempt_id") == attempt_id]


# Keep asyncio imported for the async signatures' documentation value.
_ = asyncio
