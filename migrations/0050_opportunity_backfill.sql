-- Pre-dated holdings: a lane for deals that happened before the system did.
--
-- The lifecycle machine only reaches CLOSED through SCREENING → DILIGENCE → IC_READY →
-- IC_DECIDED. That is right for anything the firm decides from here on. It is wrong for history:
-- Sensori is a $10K SPV that closed before Fund I existed and never saw an IC, and the only ways
-- to record it were to walk it up the ladder — minting an ic_decision that never happened — or to
-- leave a closed holding sitting in the pipeline at NEW. Both are lies; they just fail differently.
--
-- So the status is allowed to be set directly, and the record says it was. A backfilled row is
-- permanently marked as one, with a reason and the date it actually happened, so nobody later
-- mistakes an entered fact for a decision this firm made. The audit trail stays true by admitting
-- what it does not know, which is the same reason UPDATE is blocked elsewhere (D15).
--
-- backfilled_at is the moment of ENTRY. as_of_date is when the thing really occurred, and the two
-- are deliberately separate: recording in 2026 that a deal closed in 2024 is exactly the case, and
-- collapsing them would lose the distinction that makes the row honest.

ALTER TABLE investment_opportunity ADD COLUMN backfilled_at TEXT;
ALTER TABLE investment_opportunity ADD COLUMN backfill_reason TEXT;
ALTER TABLE investment_opportunity ADD COLUMN as_of_date TEXT;

-- Backfilled rows are rare and always interesting: every "is this real history or our decision?"
-- question filters on exactly this.
CREATE INDEX IF NOT EXISTS idx_opportunity_backfilled
  ON investment_opportunity (backfilled_at)
  WHERE backfilled_at IS NOT NULL;
