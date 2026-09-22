-- 0223 — Porter's finished-work email to a partner is shown to Sequoia first (owner, 22 Sep 2026).
--
-- WHAT HAPPENED. Scooter emailed "westpeek.ventures forms are down". Porter planned it, built it,
-- landed it and the card went DONE — and the DONE reply to Scooter would have gone out on its own.
-- The owner wanted to read it first, and to add her own words to it. Getting that done today took
-- five hand-written steps against production: `preview_first = 1` and `preview_owner_id` set on the
-- card by hand, a `work_card_notice` row inserted with `sent = 0` to stop the automatic reply, the
-- email rendered by hand, and a `preview_approval` row inserted directly so it would appear on Home.
--
-- Her rule is not about one card. A finished-work email from an employee to a PARTNER is the one
-- message that leaves with nobody's hand on it — `previewFirstFor` sends straight out to either
-- partner by design, because Scooter is inside the firm. That default is right for a note and wrong
-- for "here is the finished thing", which is the message the firm is judged by.
--
-- SO IT IS A ROW, NOT A PATCH. `done_reply_preview_first` is editable and ON. When it is on, the
-- DONE reply for a WEB_PROPERTY_CHANGE takes the preview lane — filed for Sequoia on Home with
-- Send it / Send it back / Dismiss — even when the card's own "Show me first?" tick was never set.
-- RECEIVED, PLAN, PREVIEW, QUESTION and STUCK are untouched: those are the back-and-forth of the
-- work, and holding them would make the partner wait on her to ask a question.
--
-- Read in ONE place: `doneReplyLaneFor` in `src/worker/services/kindRules.ts`, consulted by both
-- doors that can send a DONE reply (`services/requestReply.ts` and `webPropertyChange.tellRequester`).
-- Off restores exactly the old behaviour. `tests/doneReplyPreview.test.ts` proves both directions.

INSERT OR IGNORE INTO work_kind_rule (kind, rule_key, label, value, editable, note, set_by) VALUES
  ('WEB_PROPERTY_CHANGE', 'done_reply_preview_first', 'Show me the finished email before it goes', 'on', 1,
   'Porter''s finished-work email to a partner is shown to Sequoia first. It lands on her Home with Send it / Send it back / Dismiss, and she can add her own words to it on the card. Questions and progress notes still go straight to whoever asked. Her decision, 22 Sep 2026.', 'fu_sequoia_taylor');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0223_porters_finished_email_is_shown_to_sequoia_first');
