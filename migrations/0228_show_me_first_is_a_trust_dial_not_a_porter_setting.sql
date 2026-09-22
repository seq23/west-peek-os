-- 0228 — "Show me the finished email before it goes" is a trust dial, not a Porter setting
-- (Addendum 8, 22 Sep 2026).
--
-- HER CORRECTION: this was written up and built as if it belongs to Porter / WEB_PROPERTY_CHANGE.
-- It doesn't. Her own words: "it just happens to be that I am still early days with these agents
-- and I want to tail them and see what emails they are sending... maybe we change this to be a
-- setting I can apply to all work cards, or turn off when I feel confident I don't need to tail
-- them and approve emails and plans etc." A firm-wide trust dial across every AI employee, not a
-- per-kind rule that happens to exist for one kind today.
--
-- SAME SHAPE AS `mp_home_preference` (0013): versioned and append-only — a change is a NEW row,
-- latest wins, and the row history IS the change history, so "when did she turn this off" is
-- always answerable without a separate audit table. Firm-wide rather than per-partner: the two
-- Managing Partners are one firm reading one dial, and `set_by` already records who last moved it.
--
-- DEFAULT ON WITH ZERO ROWS, matching her 22 Sep decision to keep it on. A firm that has never
-- touched this dial is a firm still tailing its employees, which is the honest starting state.
--
-- THE PER-KIND RULE STAYS, AS THE OVERRIDE. `done_reply_preview_first` (`work_kind_rule`,
-- `ON_OFF_RULE_KEYS`) still exists for a future case where she wants an exception for one kind.
-- `kindRules.ts`'s `doneReplyLaneFor` now reads it as an EXPLICIT override — a kind with no row for
-- that rule key inherits this global; a kind that has one (today, only WEB_PROPERTY_CHANGE, seeded
-- ON by 0223 and, per her 22 Sep decision, left untouched) keeps deciding for itself.

CREATE TABLE IF NOT EXISTS email_preview_preference (
  id                          TEXT PRIMARY KEY,
  version_no                  INTEGER NOT NULL,
  preview_all_partner_emails  INTEGER NOT NULL DEFAULT 1 CHECK (preview_all_partner_emails IN (0, 1)),
  set_by                      TEXT NOT NULL,
  firm_scope                  TEXT NOT NULL DEFAULT 'west-peek',
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (firm_scope, version_no)
);

CREATE TRIGGER IF NOT EXISTS email_preview_preference_reject_update
BEFORE UPDATE ON email_preview_preference
BEGIN
  SELECT RAISE(ABORT, 'email_preview_preference is versioned/immutable: UPDATE rejected — write a new version');
END;

CREATE TRIGGER IF NOT EXISTS email_preview_preference_reject_delete
BEFORE DELETE ON email_preview_preference
BEGIN
  SELECT RAISE(ABORT, 'email_preview_preference is versioned/immutable: DELETE rejected');
END;

-- The `email_preview_preference.set` action key, the P4 convention: declared in
-- src/shared/registry/actionTypes.ts, emitted into 0003's generated block for a fresh database,
-- and repeated here as the compensating insert for one already applied.
INSERT OR IGNORE INTO action_type (key, name, description, is_reserved, is_external_effect) VALUES
  ('email_preview_preference.set', 'Set the firm-wide email preview dial', 'Turn "preview every partner-facing email before it sends" on or off for the whole firm — the default every card kind inherits unless it carries its own override.', 0, 0);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0228_show_me_first_is_a_trust_dial_not_a_porter_setting');
