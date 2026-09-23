-- 0240 — A preview at every stopping point; the approval binds to the LATEST preview (owner, 23 Sep 2026).
--
-- HER WORDS: "porter should be sending us a preview link before the missing items applied and
-- after", then "just … a preview link at every email back at every stopping point". A site change
-- builds with placeholders straight after the plan is approved (preview 1); when she replies — or
-- presses "I added missing items" — the Mac re-maps the Drive folder (documents only) and picks up
-- the reply's files, and rebuilds ONLY IF THE MATERIAL SET ACTUALLY CHANGED (a new preview). No
-- polling: nothing re-maps a card that is waiting unless she did something.
--
--   · materials_fingerprint — the material set (Drive file ids + size + modified time, and the
--     card's attachment ids) the last BUILD used. The Mac compares against it and answers
--     "unchanged" rather than rebuilding the same thing.
--   · refresh_requested_at / refresh_intent — a reply or the button asked for that check, and what
--     to do if something changed: PREVIEW (a new preview), PUBLISH (fill in and land without
--     another preview — her option 3), CHANGES (rebuild with her words whatever the materials).
--   · publish_approved_at / publish_approved_by — option 3, recorded like the named force: the
--     requesting partner only, and it lands only a build that went green AFTER it.
--   · filled_json — what the latest rebuild filled in, for the next preview email.
--
-- AND THE GATE AT THE ROW. 0220 refuses a merge on a previewing row with no landing approval; this
-- adds that the approval must be for the LATEST preview (land_approved_at >= preview_emailed_at),
-- and that a publish-with-materials approval admits only a build that went green after it. Never a
-- stale "approved" landing a build that has since been superseded.
ALTER TABLE web_property_change ADD COLUMN materials_fingerprint TEXT;
ALTER TABLE web_property_change ADD COLUMN refresh_requested_at TEXT;
ALTER TABLE web_property_change ADD COLUMN refresh_intent TEXT CHECK (refresh_intent IS NULL OR refresh_intent IN ('PREVIEW', 'PUBLISH', 'CHANGES'));
ALTER TABLE web_property_change ADD COLUMN publish_approved_at TEXT;
ALTER TABLE web_property_change ADD COLUMN publish_approved_by TEXT;
ALTER TABLE web_property_change ADD COLUMN filled_json TEXT NOT NULL DEFAULT '[]';

DROP TRIGGER IF EXISTS trg_web_property_change_approval_binds_latest_preview;
CREATE TRIGGER trg_web_property_change_approval_binds_latest_preview
BEFORE UPDATE OF merge_sha ON web_property_change
WHEN NEW.merge_sha IS NOT NULL AND length(trim(NEW.merge_sha)) > 0
  AND (NEW.publish_ready = 0 OR NEW.preview_only = 1)
  AND NEW.forced_by IS NULL
  AND (
    (NEW.land_approved_at IS NOT NULL AND NEW.preview_emailed_at IS NOT NULL AND NEW.land_approved_at < NEW.preview_emailed_at)
    OR (NEW.publish_approved_at IS NOT NULL AND (NEW.check_green_at IS NULL OR NEW.check_green_at <= NEW.publish_approved_at))
  )
BEGIN
  SELECT RAISE(ABORT, 'a stale approval cannot land: the landing approval predates the latest preview, or a publish-with-materials approval has no green build after it (0240)');
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0240_every_preview_binds_its_approval');
