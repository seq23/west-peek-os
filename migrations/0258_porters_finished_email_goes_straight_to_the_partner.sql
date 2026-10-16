-- 0258 — Porter's finished-work email goes straight to the partner who asked (owner, 15 Oct 2026).
--
-- WHAT CHANGED. 0223 (22 Sep 2026) seeded `done_reply_preview_first` ON for WEB_PROPERTY_CHANGE, so
-- every "it's live" DONE email to Scooter was held on her Home for Send it / Send it back / Dismiss.
-- On 15 Oct 2026 she turned that off: Porter's DONE emails to partners are no longer held for her.
--
-- WHY A MIGRATION AND NOT A CLICK. The switch on the Work page (`handleSetWorkKindRule`) writes this
-- same row in place — `work_kind_rule` is one row per (kind, rule_key), not a versioned table — but
-- it records no reason, and 0223's note ("Her decision, 22 Sep 2026", ON) would have kept saying the
-- opposite of the truth. This writes exactly what the route writes (value, set_by, set_at) plus the
-- note, so the Work page states the current decision and its date.
--
-- AND THE FIRM-WIDE DIAL GOES OFF TOO (same evening, her scope update). `email_preview_preference`
-- (0228) had zero rows in production, which `previewAllPartnerEmailsIsOn` reads as ON, so every kind
-- with no rule of its own still held its DONE email. Reason, hers: "15 Oct 2026: owner turned
-- show-me-first off firm-wide; partner tail stays on to 4 Jan 2027". The table is append-only
-- (0228's triggers refuse UPDATE/DELETE) and has no reason column, so this writes the NEXT version,
-- exactly as `handleSetEmailPreviewPreference` does, and the reason lives here and in the commit.
-- Together: no kind resolves to the preview lane for DONE unless a card's own tick asks for it.
--
-- WHAT IS UNTOUCHED. The per-kind row stays (WEB_PROPERTY_CHANGE's explicit override, now OFF). It
-- stays editable: she can turn it back on from the Work page. A card's own
-- "Show me first?" tick still files that card's DONE email for whoever ticked it.
-- `tests/doneReplyPreview.test.ts` pins both shipped values OFF.

UPDATE work_kind_rule
   SET value = 'off',
       set_by = 'fu_sequoia_taylor',
       set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       note = 'Porter''s finished-work email goes straight to the partner who asked. 15 Oct 2026: owner turned off show-me-first for Porter DONE emails (it had been on since 22 Sep 2026). Turn it on to have them shown to Sequoia first again; a card''s own "Show me first?" tick still holds that card''s email.'
 WHERE kind = 'WEB_PROPERTY_CHANGE' AND rule_key = 'done_reply_preview_first';

INSERT INTO email_preview_preference (id, version_no, preview_all_partner_emails, set_by, firm_scope)
SELECT 'epp_0258_owner_off_15_oct_2026',
       COALESCE((SELECT MAX(version_no) FROM email_preview_preference WHERE firm_scope = 'west-peek'), 0) + 1,
       0, 'fu_sequoia_taylor', 'west-peek'
 WHERE NOT EXISTS (SELECT 1 FROM email_preview_preference WHERE id = 'epp_0258_owner_off_15_oct_2026');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0258_porters_finished_email_goes_straight_to_the_partner');
