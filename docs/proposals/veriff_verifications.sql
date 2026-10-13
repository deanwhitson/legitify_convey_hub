-- Additive Veriff storage proposal, 2026-10-13. NOT APPLIED.
-- Assign a migration number and runtime grants during deployment review.
-- Outside the migration runner to avoid accidental application.
BEGIN;
SET LOCAL search_path TO transfers, public;
CREATE TABLE transfers.veriff_verifications (
    id UUID PRIMARY KEY,
    integration_scope TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('test','trial','live')),
    accountable_institution_id INTEGER NOT NULL,
    transfer_id UUID NOT NULL REFERENCES transfers.transfers(id),
    transfer_party_id UUID NOT NULL REFERENCES transfers.transfer_parties(id),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('party','representative')),
    on_behalf_of_party_id UUID REFERENCES transfers.transfer_parties(id),
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    external_ref TEXT NOT NULL,
    subject_fingerprint TEXT NOT NULL,
    creation_state TEXT NOT NULL CHECK (creation_state IN ('creating','ready','uncertain')),
    session_id TEXT,
    capture_url_encrypted TEXT,
    status TEXT NOT NULL CHECK (status IN ('started','pending','verified','declined','retry_requested','review_required')),
    summary JSONB NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (integration_scope, accountable_institution_id, transfer_party_id, attempt_no),
    UNIQUE (integration_scope, session_id),
    CHECK ((creation_state='ready') = (session_id IS NOT NULL AND capture_url_encrypted IS NOT NULL)),
    CHECK ((subject_kind='representative') = (on_behalf_of_party_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_veriff_active_subject ON transfers.veriff_verifications
    (integration_scope, accountable_institution_id, transfer_party_id)
    WHERE status IN ('started','pending','review_required');
COMMIT;
-- Code rollback: retain table/bindings to prevent duplicate checks. Dropping
-- it destroys verification history and requires a separate retention decision.
