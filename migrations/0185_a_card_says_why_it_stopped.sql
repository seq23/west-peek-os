-- 0185 · A work card says why it stopped, and she can fix it from the card (17 Sep 2026)
--
-- WHAT HAPPENED. Parker's card "Draft event kit: October workshop with Kirx Diaz" failed three
-- times over fourteen minutes. Two steps completed on OpenRouter each time; the third routed to the
-- direct Anthropic lane and was refused — "your credit balance is too low to access the Anthropic
-- API". The step deferred, the card went back in the queue, the sweep picked it up again.
--
-- WHAT THE OWNER SAW: "Open · queued — picked up within 5 min." Three times. The reason existed
-- only as `ai_run.failure_reason = 'provider_failure:provider_http_400'`, and the fix was disabling
-- one row in this database. Her words: "without you I can't fix anything that goes wrong in work
-- cards."
--
-- THE DIAGNOSIS IS NOT THAT BLOCKS ARE MISSING — 0173 built them, and `validate:blocks` already
-- holds every block to a sentence a non-engineer can act on. It is that the TECHNICAL failure path
-- never used any of it. A card blocked on a decision she owes gets four sentences and four buttons;
-- a card failing on infrastructure got a silent retry loop and a word that said "queued".
--
-- ── What these columns are for ──────────────────────────────────────────────────────────────
--
-- `block_lane` / `block_lane_name`  which lane refused, so "stand that one down" can name it and
--                                   actually do it rather than describing it.
-- `block_raw`                       the provider's verbatim text INCLUDING the status code, kept
--                                   for the one person who wants it and never shown by default.
--                                   The headline is a sentence; this is the appendix.
-- `work_last_failure` / `_at`       what went wrong on the LAST attempt, while the card is still
--                                   retrying and not yet blocked. This is the column that stops a
--                                   failing card from looking like a waiting one: `work_attempts`
--                                   reached 3 in silence tonight because nothing read it out.
--
-- `provider_registry.paused_until`  a lane she has stood down from a card. NOT `enabled = 0`: that
--                                   is an operator setting with its own page and no clock, and a
--                                   button that switches something off for ever with no way back
--                                   from where she pressed it is a trap, not a fix. A pause names
--                                   itself, names who set it, and expires — six hours for "try a
--                                   different model", a week for "stop using this one".

ALTER TABLE work_card ADD COLUMN block_lane           TEXT;
ALTER TABLE work_card ADD COLUMN block_lane_name      TEXT;
ALTER TABLE work_card ADD COLUMN block_raw            TEXT;
ALTER TABLE work_card ADD COLUMN work_last_failure    TEXT;
ALTER TABLE work_card ADD COLUMN work_last_failure_at TEXT;

ALTER TABLE provider_registry ADD COLUMN paused_until  TEXT;
ALTER TABLE provider_registry ADD COLUMN paused_reason TEXT;
ALTER TABLE provider_registry ADD COLUMN paused_by     TEXT;

-- The sweep asks "which cards are failing" on every tick, and the Work page asks it on every load.
CREATE INDEX IF NOT EXISTS idx_work_card_last_failure ON work_card (state, work_last_failure_at);
CREATE INDEX IF NOT EXISTS idx_provider_registry_paused ON provider_registry (enabled, paused_until);

-- ── A pause has to say what it is and who did it ────────────────────────────────────────────
--
-- Same reasoning as 0173's block triggers: a validator reads source, and a row-level refusal does
-- not depend on the scan being able to read the SQL that wrote it. A lane found switched off with
-- nobody's name on it is the failure this whole migration exists to end — an unexplained state a
-- person cannot act on.

CREATE TRIGGER IF NOT EXISTS provider_pause_must_say_who_and_why
BEFORE UPDATE ON provider_registry
WHEN NEW.paused_until IS NOT NULL AND (OLD.paused_until IS NULL OR NEW.paused_until <> OLD.paused_until)
BEGIN
  SELECT RAISE(ABORT, 'a paused lane must say who paused it and why (0185)')
   WHERE IFNULL(length(trim(NEW.paused_reason)), 0) = 0
      OR IFNULL(length(trim(NEW.paused_by)), 0) = 0;
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0185_a_card_says_why_it_stopped');
