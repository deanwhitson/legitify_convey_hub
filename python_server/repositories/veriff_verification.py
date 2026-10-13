"""Durable Veriff reservations; no provider-mode in-memory fallback."""
import json
from uuid import uuid4
import db
from services.id_verification_service import IdVerificationError


class VeriffStorageError(IdVerificationError):
    def __init__(self):
        super().__init__("storage_unavailable")


def row_dict(row):
    if not row:
        return None
    d = dict(row)
    for k in ("id", "transfer_id", "transfer_party_id", "on_behalf_of_party_id"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    if isinstance(d.get("summary"), str):
        d["summary"] = json.loads(d["summary"])
    return d


class VeriffRepository:
    async def _query(self, sql, params, connection=None):
        try:
            return await db.query(sql, params, connection=connection)
        except Exception:
            raise VeriffStorageError() from None

    async def _transaction(self, work):
        try:
            return await db.with_transaction(work)
        except IdVerificationError:
            raise
        except Exception:
            raise VeriffStorageError() from None

    async def _party(self, ai, transfer_id, party_id, conn):
        parent = await self._query("SELECT id FROM transfers WHERE id=$1 AND accountable_institution_id=$2 FOR SHARE", [transfer_id, ai], conn)
        subject = await self._query("""SELECT id, entity_type, party_source, manual_name, manual_id_type,
            manual_id_number, manual_passport_country, cached_name FROM transfer_parties
            WHERE id=$1 AND transfer_id=$2 AND accountable_institution_id=$3 FOR SHARE""", [party_id, transfer_id, ai], conn)
        if not parent.rows or not subject.rows or subject.rows[0]["entity_type"] != "person":
            raise IdVerificationError("subject_not_eligible")
        return dict(subject.rows[0])

    async def _representative(self, ai, transfer_id, target, conn):
        if target:
            r = await self._query("SELECT entity_type FROM transfer_parties WHERE id=$1 AND transfer_id=$2 AND accountable_institution_id=$3 FOR SHARE", [target, transfer_id, ai], conn)
            if not r.rows or r.rows[0]["entity_type"] not in ("company", "trust"):
                raise IdVerificationError("subject_not_eligible")

    async def reserve(self, scope, mode, ai, transfer_id, party_id, subject_kind, target, *, retry=False):
        from services.veriff_verification import fingerprint

        async def work(conn):
            await self._query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [f"veriff|{scope}|{ai}|{party_id}"], conn)
            party = await self._party(ai, transfer_id, party_id, conn)
            await self._representative(ai, transfer_id, target, conn)
            rows = await self._query("SELECT * FROM veriff_verifications WHERE integration_scope=$1 AND accountable_institution_id=$2 AND transfer_party_id=$3 ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE", [scope, ai, party_id], conn)
            latest = row_dict(rows.rows[0]) if rows.rows else None
            if latest and (latest["transfer_id"] != transfer_id or latest["on_behalf_of_party_id"] != target or latest["subject_kind"] != subject_kind):
                raise IdVerificationError("subject_context_conflict")
            if latest and fingerprint(party) != latest["subject_fingerprint"]:
                raise IdVerificationError("subject_changed")
            if retry and (not latest or latest["status"] not in ("declined", "retry_requested")):
                raise IdVerificationError("not_retryable")
            if latest and latest["status"] in ("started", "pending", "review_required"):
                return latest, False
            if latest and latest["status"] == "verified":
                raise IdVerificationError("not_retryable")
            result = await self._query("""INSERT INTO veriff_verifications
                (id, integration_scope, environment, accountable_institution_id, transfer_id,
                 transfer_party_id, subject_kind, on_behalf_of_party_id, attempt_no, external_ref,
                 subject_fingerprint, creation_state, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'creating','started') RETURNING *""",
                [str(uuid4()), scope, mode, ai, transfer_id, party_id, subject_kind, target,
                 (latest["attempt_no"] + 1) if latest else 1, "dly-" + uuid4().hex, fingerprint(party)], conn)
            return row_dict(result.rows[0]), True
        return await self._transaction(work)

    async def creation_failed(self, attempt_id):
        await self._query("UPDATE veriff_verifications SET creation_state='uncertain', updated_at=now() WHERE id=$1 AND creation_state='creating'", [attempt_id])

    async def bind(self, attempt_id, session_id, encrypted_url):
        from services.veriff_verification import fingerprint

        async def work(conn):
            stored = await self._query("SELECT * FROM veriff_verifications WHERE id=$1", [attempt_id], conn)
            if not stored.rows:
                raise VeriffStorageError()
            row = row_dict(stored.rows[0])
            party = await self._party(row["accountable_institution_id"], row["transfer_id"], row["transfer_party_id"], conn)
            await self._representative(row["accountable_institution_id"], row["transfer_id"], row["on_behalf_of_party_id"], conn)
            if fingerprint(party) != row["subject_fingerprint"]:
                raise IdVerificationError("subject_changed")
            r = await self._query("""UPDATE veriff_verifications SET session_id=$2, capture_url_encrypted=$3,
                creation_state='ready', version=version+1, updated_at=now()
                WHERE id=$1 AND creation_state='creating' AND session_id IS NULL RETURNING *""", [attempt_id, session_id, encrypted_url], conn)
            if not r.rows:
                raise VeriffStorageError()
            return row_dict(r.rows[0])
        return await self._transaction(work)

    async def latest(self, scope, ai, party_id):
        async def work(conn):
            r = await self._query("SELECT * FROM veriff_verifications WHERE integration_scope=$1 AND accountable_institution_id=$2 AND transfer_party_id=$3 ORDER BY attempt_no DESC LIMIT 1", [scope, ai, party_id], conn)
            if not r.rows:
                return None, None
            row = row_dict(r.rows[0])
            party = await self._party(ai, row["transfer_id"], party_id, conn)
            await self._representative(ai, row["transfer_id"], row["on_behalf_of_party_id"], conn)
            return row, party
        return await self._transaction(work)

    async def apply(self, row, incoming):
        from services.veriff_verification import fingerprint

        async def work(conn):
            ai = row["accountable_institution_id"]
            party = await self._party(ai, row["transfer_id"], row["transfer_party_id"], conn)
            await self._representative(ai, row["transfer_id"], row["on_behalf_of_party_id"], conn)
            summary = incoming if fingerprint(party) == row["subject_fingerprint"] else {
                "status": "review_required", "checks": [{"check": "selected_subject_match", "state": "review_required"}]}
            if summary["status"] == "pending" and row["status"] not in ("started", "pending"):
                return row
            r = await self._query("""UPDATE veriff_verifications SET status=$2, summary=$3::jsonb,
                version=version+1, updated_at=now() WHERE id=$1 AND version=$4
                AND integration_scope=$5 AND accountable_institution_id=$6 RETURNING *""",
                [row["id"], summary["status"], json.dumps(summary), row["version"], row["integration_scope"], ai], conn)
            if r.rows:
                return row_dict(r.rows[0])
            current = await self._query("SELECT * FROM veriff_verifications WHERE id=$1 AND integration_scope=$2 AND accountable_institution_id=$3", [row["id"], row["integration_scope"], ai], conn)
            if not current.rows:
                raise VeriffStorageError()
            return row_dict(current.rows[0])
        return await self._transaction(work)
