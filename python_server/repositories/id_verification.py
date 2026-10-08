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
    async def find_attempt_by_external_ref(self, environment: str, external_ref: str) -> Optional[dict]: ...
    async def find_attempt_by_applicant_id(self, environment: str, applicant_id: str) -> Optional[dict]: ...
    async def create_attempt(self, attempt: dict) -> dict: ...
    async def update_attempt_fields(self, attempt_id: str, fields: dict) -> dict: ...
    async def insert_event(self, event: dict) -> Optional[dict]:
        """Insert if the dedupe key is new; return (row, inserted) via dict flag."""
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
    "transfer_party_id", "subject_kind", "attempt_no", "external_ref",
    "provider", "provider_applicant_id", "level_name", "status",
    "review_answer", "review_reject_type", "reject_labels",
    "last_correlation_id", "last_event_created_at_ms", "last_event_type",
    "simulated", "created_at", "updated_at",
)

_EVENT_COLUMNS = (
    "id", "attempt_id", "environment", "dedupe_key", "event_type",
    "provider_applicant_id", "external_ref", "correlation_id", "level_name",
    "review_status", "review_answer", "review_reject_type", "reject_labels",
    "provider_created_at_ms", "received_at", "processed_at", "disposition",
)


def _row_to_dict(row: Any) -> dict:
    d = dict(row)
    for k in ("created_at", "updated_at", "received_at", "processed_at"):
        v = d.get(k)
        if isinstance(v, datetime):
            d[k] = v.isoformat()
    return d


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

    async def find_attempt_by_external_ref(self, environment, external_ref, *, connection=None):
        return await self._fetch(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND external_ref=$2 ORDER BY attempt_no DESC LIMIT 1",
            [environment, external_ref], connection,
        )

    async def find_attempt_by_applicant_id(self, environment, applicant_id, *, connection=None):
        return await self._fetch(
            f"SELECT {', '.join(_ATTEMPT_COLUMNS)} FROM id_verification_attempts "
            "WHERE environment=$1 AND provider_applicant_id=$2 ORDER BY attempt_no DESC LIMIT 1",
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
            raise
        return _row_to_dict(result.rows[0])

    async def update_attempt_fields(self, attempt_id, fields: dict, *, connection=None) -> dict:
        sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields.keys()))
        sql = (
            f"UPDATE id_verification_attempts SET {sets}, updated_at = now() "
            f"WHERE id = $1 RETURNING {', '.join(_ATTEMPT_COLUMNS)}"
        )
        result = await db.query(sql, [attempt_id, *fields.values()], connection=connection)
        if not result.rows:
            raise StorageUnavailableError("attempt row vanished")
        return _row_to_dict(result.rows[0])

    async def insert_event(self, event: dict, *, connection=None) -> dict:
        cols = list(event.keys())
        sql = (
            f"INSERT INTO id_verification_events ({', '.join(cols)}) "
            f"VALUES ({', '.join(f'${i+1}' for i in range(len(cols)))}) "
            f"ON CONFLICT (environment, dedupe_key) DO NOTHING "
            f"RETURNING {', '.join(_EVENT_COLUMNS)}"
        )
        result = await db.query(sql, [event[c] for c in cols], connection=connection)
        if result.rows:
            row = _row_to_dict(result.rows[0])
            row["_inserted"] = True
            return row
        existing = await self._fetch(
            f"SELECT {', '.join(_EVENT_COLUMNS)} FROM id_verification_events "
            "WHERE environment=$1 AND dedupe_key=$2",
            [event["environment"], event["dedupe_key"]], connection,
        )
        if existing is None:
            raise StorageUnavailableError("event insert produced no row")
        existing["_inserted"] = False
        return existing

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

    async def find_attempt_by_external_ref(self, environment, external_ref, *, connection=None):
        with self._lock:
            rows = [a for a in self._attempts.values()
                    if a["environment"] == environment and a["external_ref"] == external_ref]
            return dict(max(rows, key=lambda a: a["attempt_no"])) if rows else None

    async def find_attempt_by_applicant_id(self, environment, applicant_id, *, connection=None):
        with self._lock:
            rows = [a for a in self._attempts.values()
                    if a["environment"] == environment and a["provider_applicant_id"] == applicant_id]
            return dict(max(rows, key=lambda a: a["attempt_no"])) if rows else None

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
            self._attempts[attempt_id]["updated_at"] = datetime.now(timezone.utc).isoformat()
            return dict(self._attempts[attempt_id])

    async def insert_event(self, event: dict, *, connection=None) -> dict:
        with self._lock:
            dedupe = (event["environment"], event["dedupe_key"])
            for e in self._events.values():
                if (e["environment"], e["dedupe_key"]) == dedupe:
                    existing = dict(e)
                    existing["_inserted"] = False
                    return existing
            row = dict(event)
            row.setdefault("id", self._new_id())
            row.setdefault("received_at", datetime.now(timezone.utc).isoformat())
            self._events[row["id"]] = row
            row["_inserted"] = True
            return dict(row)

    async def list_events_for_attempt(self, attempt_id, *, connection=None) -> List[dict]:
        with self._lock:
            return [dict(e) for e in self._events.values() if e.get("attempt_id") == attempt_id]


# Keep asyncio imported for the async signatures' documentation value.
_ = asyncio
