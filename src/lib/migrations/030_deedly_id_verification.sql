-- Migration 030: DEEDLY identity-verification attempts + webhook events (Sumsub POC).
--
-- Status: PROPOSED — authored for review. Do NOT apply to any shared, pilot or
-- production database without separate approval. Numbering continues the
-- existing sequence (029 is the latest landed migration at authoring time).
--
-- Rollback: DROP TABLE transfers.id_verification_events,
--                 transfers.id_verification_attempts;
-- Both tables are additive-only; rollback carries no data-loss risk to
-- existing tables. Grants are NOT included — they follow the existing
-- deployment runbook, not this file.
--
-- Only allowlisted decision/audit fields are stored: never raw webhook bodies,
-- document images, OCR payloads, tokens or secrets.

BEGIN;

SET LOCAL search_path TO transfers, public;

CREATE TABLE IF NOT EXISTS transfers.id_verification_attempts (
    id                          UUID PRIMARY KEY,
    environment                 TEXT NOT NULL CHECK (environment IN ('fixture', 'sandbox', 'live')),
    accountable_institution_id  INTEGER NOT NULL,
    transfer_id                 UUID NOT NULL REFERENCES transfers.transfers(id),
    transfer_party_id           UUID NOT NULL REFERENCES transfers.transfer_parties(id),
    subject_kind                TEXT NOT NULL,  -- 'party' | 'representative'
    on_behalf_of_party_id       UUID REFERENCES transfers.transfer_parties(id),
    attempt_no                  INTEGER NOT NULL,
    external_ref                TEXT NOT NULL,  -- opaque provider externalUserId
    provider                    TEXT NOT NULL,
    provider_applicant_id       TEXT,
    level_name                  TEXT,
    inspection_id               TEXT,  -- provider review-cycle identifier, bound on first event
    status                      TEXT NOT NULL CHECK (status IN (
        'not_started', 'started', 'pending', 'verified',
        'retry_requested', 'declined', 'review_required')),
    review_answer               TEXT,
    review_reject_type          TEXT,
    reject_labels               TEXT[] NOT NULL DEFAULT '{}',
    last_correlation_id         TEXT,
    last_event_created_at_ms    TEXT,
    last_event_type             TEXT,
    version                     INTEGER NOT NULL DEFAULT 0,  -- state version, bumped on every applied update
    simulated                   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (environment, accountable_institution_id, transfer_party_id, attempt_no)
);

-- One open attempt per subject per environment/institution at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_idv_attempt_open
    ON transfers.id_verification_attempts
        (environment, accountable_institution_id, transfer_party_id)
    WHERE status IN ('started', 'pending', 'review_required');

-- Provider event routing: externalUserId (and applicantId) must resolve
-- an attempt quickly and only within the same environment.
CREATE INDEX IF NOT EXISTS idx_idv_attempt_external_ref
    ON transfers.id_verification_attempts (environment, external_ref);
CREATE INDEX IF NOT EXISTS idx_idv_attempt_applicant
    ON transfers.id_verification_attempts (environment, provider_applicant_id)
    WHERE provider_applicant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS transfers.id_verification_events (
    id                      UUID PRIMARY KEY,
    attempt_id              UUID REFERENCES transfers.id_verification_attempts(id),
    environment             TEXT NOT NULL,
    dedupe_key              TEXT NOT NULL,
    event_type              TEXT NOT NULL,
    provider_applicant_id   TEXT,
    external_ref            TEXT,
    correlation_id          TEXT,
    level_name              TEXT,
    inspection_id           TEXT,
    review_status           TEXT,
    review_answer           TEXT,
    review_reject_type      TEXT,
    reject_labels           TEXT[] NOT NULL DEFAULT '{}',
    provider_created_at_ms  TEXT,
    received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at            TIMESTAMPTZ,
    disposition             TEXT NOT NULL,  -- matched | unmatched | binding_mismatch | test_mode | duplicate | out_of_order | unhandled | previous_cycle | ambiguous_not_applied
    UNIQUE (environment, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_idv_events_attempt
    ON transfers.id_verification_events (attempt_id) WHERE attempt_id IS NOT NULL;

COMMIT;
