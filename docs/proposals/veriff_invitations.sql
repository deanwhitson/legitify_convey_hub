-- Additive email invitation proposal. NOT APPLIED. Requires veriff_verifications.sql.
-- Assign migration numbering/grants during deployment review.
BEGIN;
SET LOCAL search_path TO transfers,public;
CREATE TABLE transfers.veriff_verification_invitations (
  id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL UNIQUE REFERENCES transfers.veriff_verifications(id),
  recipient_hash TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('sending','accepted','uncertain')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
-- Retain rows on code rollback: deleting ambiguous send records can cause duplicate emails.
