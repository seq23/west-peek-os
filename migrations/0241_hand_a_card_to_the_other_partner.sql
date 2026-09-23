-- 0241 — Hand a work card to the other partner, with a primary and a secondary (owner, 23 Sep 2026).
--
-- Until now `work_card.requested_by_email` was fixed for life: only the partner who asked could
-- steer, approve, send missing items or publish. From this migration a card has TWO partners:
--
--   PRIMARY   = `work_card.requested_by_email` (unchanged meaning: every requester guard in the
--               Worker, the Mac and 0220's force trigger already reads it, so moving it moves every
--               power with it — nothing had to learn a second column to stay safe).
--   SECONDARY = `work_card.secondary_partner_email` (new, nullable). Cc'd on every PREVIEW and the
--               finished email; may add notes (read as context, never approval); may "take this back".
--
-- The ONE writer of both columns during a hand-off is `services/handOff.ts`, which decides through the
-- pure rules in `shared/work/partnerOwnership.ts` (partners only; only the current primary hands off;
-- only the current secondary takes back).
--
--   1 · `work_card.secondary_partner_email`.
--   2 · `work_card_hand_off` — the history (HAND_OFF, TAKE_BACK, and CLAIM: "Take responsibility" on
--       a work card's notification makes the partner who pressed it primary): who handed what to whom, how, what they wrote, and the
--       message id of the ONE email the new primary got (and of the one-line ack, when there was one).
--   3 · Triggers that hold the rule at the row, whatever the code does:
--         a · the secondary is never the primary;
--         b · a plan approval and a landing approval recorded against a PARTNER must name the
--             card's CURRENT primary — a secondary or an ex-primary can never approve (0220's force
--             trigger already holds the same line for `forced_by`, against the same column).
--
-- Additive: no existing row is rewritten; the triggers fire only on a NEW approval.
ALTER TABLE work_card ADD COLUMN secondary_partner_email TEXT;

CREATE TABLE IF NOT EXISTS work_card_hand_off (
  id                  TEXT PRIMARY KEY,
  work_card_id        TEXT NOT NULL REFERENCES work_card (id),
  action              TEXT NOT NULL CHECK (action IN ('HAND_OFF', 'TAKE_BACK', 'CLAIM')),
  -- The partner who acted (the old primary for HAND_OFF, the old secondary for TAKE_BACK, the
  -- partner who pressed "Take responsibility" on the card's notification for CLAIM).
  by_email            TEXT NOT NULL,
  -- The new primary, and who became secondary.
  primary_email       TEXT NOT NULL,
  secondary_email     TEXT NOT NULL,
  via                 TEXT NOT NULL CHECK (via IN ('REPLY', 'NOTE', 'API', 'NOTIFICATION')),
  said                TEXT,
  -- The thread token of the ONE email the new primary received; later notices to them thread under it.
  message_id          TEXT,
  sent                INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0, 1)),
  detail              TEXT,
  ack_message_id      TEXT,
  firm_scope          TEXT NOT NULL DEFAULT 'west-peek',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (lower(primary_email) <> lower(secondary_email))
);
CREATE INDEX IF NOT EXISTS idx_work_card_hand_off_card ON work_card_hand_off (work_card_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_work_card_secondary_is_not_the_primary
BEFORE UPDATE OF secondary_partner_email, requested_by_email ON work_card
WHEN NEW.secondary_partner_email IS NOT NULL
  AND lower(trim(NEW.secondary_partner_email)) = lower(trim(COALESCE(NEW.requested_by_email, '')))
BEGIN
  SELECT RAISE(ABORT, 'the secondary partner cannot also be the primary (0241)');
END;

CREATE TRIGGER IF NOT EXISTS trg_web_property_change_plan_approval_is_the_primary
BEFORE UPDATE OF plan_approved_at ON web_property_change
WHEN NEW.plan_approved_at IS NOT NULL AND OLD.plan_approved_at IS NULL
  AND EXISTS (
    SELECT 1 FROM work_card c JOIN firm_user f
        ON NEW.plan_approved_by = f.id OR NEW.plan_approved_by LIKE f.id || ' %' OR lower(NEW.plan_approved_by) = lower(f.email)
     WHERE c.id = NEW.work_card_id
       AND c.requested_by_email IS NOT NULL
       AND lower(f.email) <> lower(c.requested_by_email)
  )
BEGIN
  SELECT RAISE(ABORT, 'only the card''s primary partner can approve the plan (0241)');
END;

CREATE TRIGGER IF NOT EXISTS trg_web_property_change_land_approval_is_the_primary
BEFORE UPDATE OF land_approved_at ON web_property_change
WHEN NEW.land_approved_at IS NOT NULL AND OLD.land_approved_at IS NULL
  AND EXISTS (
    SELECT 1 FROM work_card c JOIN firm_user f
        ON NEW.land_approved_by = f.id OR lower(NEW.land_approved_by) = lower(f.email)
     WHERE c.id = NEW.work_card_id
       AND c.requested_by_email IS NOT NULL
       AND lower(f.email) <> lower(c.requested_by_email)
  )
BEGIN
  SELECT RAISE(ABORT, 'only the card''s primary partner can approve the landing (0241)');
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0241_hand_a_card_to_the_other_partner');
