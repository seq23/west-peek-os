-- 0220 — A plan that is not publish-ready previews first (owner, 21 Sep 2026).
--
-- THE ASK. Some packages are not publish-ready — the Community site rebuild package has a dozen
-- open items (Airtable links, a partner's logo, episode and winner records, the approved orange
-- hex) where the honest default is a structured placeholder. Porter must be able to SAY SO and NOT
-- land. So the PLAN carries `publish_ready` and the named `placeholders`; when it is not ready (or
-- the partner replies "preview"), "approved" means BUILD → PR → the Cloudflare Pages PREVIEW URL →
-- a second email with the preview, the PR, the placeholders and the proof → BLOCKED "preview
-- ready — reply approved to land". LAND needs that SECOND recorded approval. Land-on-green applies
-- only when the plan is publish-ready and nobody asked for a preview.
--
-- THE ROW REFUSES A MERGE WITHOUT THE SECOND APPROVAL: a trigger below aborts any write of
-- `merge_sha` on a row that needs a preview and carries no `land_approved_at`. The Worker's LAND
-- gate and the Mac script's gate refuse earlier; this is the last line, at the row.

ALTER TABLE web_property_change ADD COLUMN publish_ready INTEGER NOT NULL DEFAULT 1 CHECK (publish_ready IN (0, 1));
ALTER TABLE web_property_change ADD COLUMN placeholders_json TEXT NOT NULL DEFAULT '[]';
-- The partner asked for a preview even though the plan was ready ("preview" as the reply).
ALTER TABLE web_property_change ADD COLUMN preview_only INTEGER NOT NULL DEFAULT 0 CHECK (preview_only IN (0, 1));
ALTER TABLE web_property_change ADD COLUMN preview_url TEXT;
ALTER TABLE web_property_change ADD COLUMN preview_emailed_at TEXT;
-- The SECOND approval: the requesting partner's "approved" AFTER the preview email.
ALTER TABLE web_property_change ADD COLUMN land_approved_at TEXT;
ALTER TABLE web_property_change ADD COLUMN land_approved_by TEXT;
-- THE FORCE-TO-PRODUCTION BYPASS, NAMED. The requesting partner may decide the placeholders do not
-- matter ("approved to production"): the preview gate is skipped and the row records who forced
-- it, when, and exactly which placeholders shipped. The DONE email tells BOTH partners.
ALTER TABLE web_property_change ADD COLUMN forced_by TEXT REFERENCES firm_user (id);
ALTER TABLE web_property_change ADD COLUMN forced_at TEXT;
ALTER TABLE web_property_change ADD COLUMN forced_placeholders_json TEXT;
-- PRE-APPROVAL IN THE REQUEST. "your call" / "you decide" / "no need to ask" / "just do it" /
-- "pick everything" / "no options" in the partner's OWN authenticated request text: Porter decides
-- everything, the plan is approved at filing, the email is an FYI. Written ONLY at the door from
-- the verified request, never from a later message. A force phrase in the same request is kept
-- beside it, so a not-ready plan lands named rather than stopping at the preview.
ALTER TABLE web_property_change ADD COLUMN pre_approved_phrase TEXT;
ALTER TABLE web_property_change ADD COLUMN force_phrase TEXT;

DROP TRIGGER IF EXISTS trg_web_property_change_preview_needs_second_approval;
CREATE TRIGGER trg_web_property_change_preview_needs_second_approval
BEFORE UPDATE OF merge_sha ON web_property_change
WHEN NEW.merge_sha IS NOT NULL AND length(trim(NEW.merge_sha)) > 0
  AND (NEW.publish_ready = 0 OR NEW.preview_only = 1)
  AND NEW.land_approved_at IS NULL
  AND NEW.forced_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a change that previews first cannot be recorded as merged without the second approval after the preview, or a named force to production (0220)');
END;

-- ONLY THE PARTNER WHO ASKED CAN FORCE. The row checks the forcing firm_user's address against the
-- card's authenticated `requested_by_email`; a force by anyone else is refused at the row.
DROP TRIGGER IF EXISTS trg_web_property_change_force_is_the_requester;
CREATE TRIGGER trg_web_property_change_force_is_the_requester
BEFORE UPDATE OF forced_by ON web_property_change
WHEN NEW.forced_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM work_card c JOIN firm_user f ON f.id = NEW.forced_by
     WHERE c.id = NEW.work_card_id
       AND (c.requested_by_email IS NULL OR lower(c.requested_by_email) = lower(f.email))
  )
BEGIN
  SELECT RAISE(ABORT, 'only the partner who asked for a change can force it to production (0220)');
END;

INSERT OR IGNORE INTO work_kind_rule (kind, rule_key, label, value, editable, note, set_by) VALUES
  ('WEB_PROPERTY_CHANGE', 'preview_when_not_ready', 'Preview before landing when the plan is not publish-ready', 'on', 0,
   'A plan that would ship placeholders, or a partner who replies "preview", gets a PR and a Cloudflare Pages preview link first; landing needs a second "approved". Land on green applies only to a publish-ready plan.', NULL);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0220_a_plan_that_is_not_publish_ready_previews_first');
