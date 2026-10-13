-- Personal owner-authenticated email/passport POC. Applied to deedly_pilot 13 October 2026.
-- Separate records: no canonical matter, party, Golden Record or checklist writes.
BEGIN;
CREATE TABLE transfers.veriff_email_poc_codes (
 id UUID PRIMARY KEY, owner_hash TEXT NOT NULL, code_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 used BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX veriff_poc_code_owner ON transfers.veriff_email_poc_codes(owner_hash,created_at);
CREATE TABLE transfers.veriff_email_poc_cases (
 id UUID PRIMARY KEY, owner_hash TEXT NOT NULL, integration_scope TEXT NOT NULL,
 request_id UUID NOT NULL, request_hash TEXT NOT NULL, external_ref TEXT NOT NULL,
 contact_encrypted TEXT NOT NULL, capture_encrypted TEXT, session_id TEXT,
 creation_state TEXT NOT NULL DEFAULT 'creating' CHECK (creation_state IN ('creating','ready','uncertain')),
 email_state TEXT NOT NULL DEFAULT 'not_sent' CHECK (email_state IN ('not_sent','sending','accepted','failed','uncertain')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','started','verified','declined','review_required','retry_requested','expired','abandoned')),
 summary JSONB NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_hash,request_id), UNIQUE(integration_scope,session_id)
);
CREATE INDEX veriff_poc_case_owner ON transfers.veriff_email_poc_cases(owner_hash,created_at);
COMMIT;
