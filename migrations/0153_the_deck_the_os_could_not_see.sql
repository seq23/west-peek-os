-- 0153 — The firm's most consequential document lived nowhere the OS could see.
--
-- Operator, 9 Sep 2026: "we should have our deck displayed prominently in the OS and when we want to
-- make updates to it we can assign the same employee to do so and changes are tracked and the latest
-- edits and date and timestamps in the OS".
--
-- THE DEFECT IS NOT THAT THE DECK IS UGLY OR WRONG. It is that the single document this firm sends
-- to limited partners existed only in Canva and in a Downloads folder, while the OS held the fund
-- records the deck is supposed to be about — and nothing connected them. That gap is what produced
-- every discrepancy found on 9 Sep: the deck says early stage is $21M, the OS said $17.0M against a
-- $24.0M base, and NOBODY CAN SAY WHICH CAME FIRST. Not because the answer is hidden, but because no
-- version of the deck ever recorded the numbers it was built from.
--
-- `records_snapshot_json` IS THE COLUMN THAT WOULD HAVE PREVENTED THE WHOLE DAY, and it is NOT NULL
-- for exactly that reason. A version that cannot say what it was built from is not a tracked
-- version, it is a file with a date on it. With it, "which fund figures were in the deck we sent in
-- August" has an answer for ever, and "this deck is eleven days old and two fund figures have moved
-- since" is a comparison rather than an investigation.
--
-- V1 IS THE HISTORICAL RECORD, NOT A CORRECTED DOCUMENT. The August PDF is ingested exactly as LPs
-- received it, discrepancies and all, with a snapshot of what the OS held at the moment of ingest.
-- Corrections land as v2 with the delta visible. Overwriting v1 with a fixed version would destroy
-- the only evidence of what was actually sent, which is the same mistake as a policy table that
-- allows UPDATE.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0153_the_deck_the_os_could_not_see');

CREATE TABLE IF NOT EXISTS deck_version (
  id                    TEXT PRIMARY KEY,
  fund_id               TEXT NOT NULL REFERENCES fund (id),
  version_no            INTEGER NOT NULL,
  title                 TEXT NOT NULL,

  -- BUILT | UPLOADED. An employee's render and a partner's own export are different provenance and
  -- a reader must never have to guess which one they are looking at.
  origin                TEXT NOT NULL CHECK (origin IN ('BUILT','UPLOADED')),
  -- The roster name of the employee who rendered it, or the firm_user who uploaded it. Never blank:
  -- a document that reaches an LP has an author.
  created_by            TEXT NOT NULL,
  created_by_type       TEXT NOT NULL CHECK (created_by_type IN ('HUMAN','AI')),

  -- The PDF itself, in R2 via the documents road, so it inherits privacy labelling and retrieval.
  document_id           TEXT REFERENCES document (id),
  page_count            INTEGER,

  /*
   * THE SNAPSHOT. Every fund figure this render was built from, as it stood at build time — fund
   * size, the fee assumption, the investable base, each sleeve percentage and its derived dollars,
   * the reserve, the sector list, the cheque range, the position count, and the policy version
   * numbers those came from.
   *
   * NOT NULL WITHOUT A DEFAULT, deliberately. A default of '{}' would let a version claim to carry
   * its inputs while carrying nothing, which is the "exists but is inert" failure this repo names.
   * A caller that cannot supply the snapshot must fail loudly rather than write a version that
   * cannot be compared to anything.
   */
  records_snapshot_json TEXT NOT NULL,

  -- What changed from the previous version, in words and in numbers. Null on v1: there is nothing
  -- before it to differ from, and inventing a diff against nothing would be prose pretending to be
  -- a measurement.
  change_summary        TEXT,
  changed_fields_json   TEXT NOT NULL DEFAULT '[]',

  -- CURRENT is what the firm would send today. An outward-facing LP document publishes nothing by
  -- itself, so a render arrives PROPOSED and only a human moves it to CURRENT.
  state                 TEXT NOT NULL DEFAULT 'PROPOSED'
                        CHECK (state IN ('PROPOSED','CURRENT','SUPERSEDED','REJECTED')),
  approved_by           TEXT REFERENCES firm_user (id),
  approved_at           TEXT,
  rejected_reason       TEXT,

  firm_scope            TEXT NOT NULL DEFAULT 'west-peek',
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (fund_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_deck_version_current
  ON deck_version (fund_id, state, version_no DESC);

/*
 * IMMUTABLE ONCE WRITTEN, except for the approval decision.
 *
 * The same reasoning as the policy version tables: a deck version is evidence of what was sent, and
 * evidence that can be edited is not evidence. The trigger permits ONLY the state/approval columns
 * to move, because approving a proposed render is a legitimate later act — everything describing
 * what the document IS stays frozen.
 */
CREATE TRIGGER IF NOT EXISTS deck_version_reject_content_update
BEFORE UPDATE ON deck_version
WHEN OLD.records_snapshot_json <> NEW.records_snapshot_json
  OR OLD.document_id IS NOT NEW.document_id
  OR OLD.version_no <> NEW.version_no
  OR OLD.created_by <> NEW.created_by
  OR OLD.origin <> NEW.origin
BEGIN
  SELECT RAISE(ABORT, 'deck_version content is immutable: a new version is how a deck changes');
END;

CREATE TRIGGER IF NOT EXISTS deck_version_reject_delete
BEFORE DELETE ON deck_version
BEGIN
  SELECT RAISE(ABORT, 'deck_version is append-only: what was sent to an LP is not deletable');
END;
