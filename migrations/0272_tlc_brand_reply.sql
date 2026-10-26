-- 0272 · WYNN ANSWERS A BRAND'S REPLY, SEQUOIA APPROVES IT (owner, 26 Oct 2026). services/tlcBrandReply.ts.
-- Every message from a brand we wrote to is one row, keyed on its Message-ID (the intake door and her inbox both
-- see a reply; it is taken once). An auto-reply or a "no" is CLOSED on arrival; a real reply carries Wynn's draft of
-- her answer and moves DRAFTED → NOTIFIED (in the day's approval email) → SENDING (her "approved", claimed once) → SENT.
CREATE TABLE IF NOT EXISTS tlc_brand_reply (
  id                TEXT PRIMARY KEY,
  deal_id           TEXT NOT NULL REFERENCES tlc_deal(id),
  brand_message_id  TEXT NOT NULL,
  their_subject     TEXT NOT NULL,
  their_text        TEXT NOT NULL,
  received_at       TEXT NOT NULL,
  intent            TEXT NOT NULL CHECK (intent IN ('QUESTION','CALL','YES','AUTO_REPLY','NO')),
  draft_subject     TEXT NOT NULL,
  draft_body        TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'DRAFTED' CHECK (state IN ('DRAFTED','NOTIFIED','SENDING','SENT','SKIPPED','FAILED','CLOSED')),
  notice_ref        TEXT,
  change_note       TEXT,
  effect_request_id TEXT,
  approval_card_id  TEXT,
  sent_at           TEXT,
  held_reason       TEXT,
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (deal_id, brand_message_id)
);
CREATE INDEX IF NOT EXISTS idx_tlc_brand_reply_state ON tlc_brand_reply (firm_scope, state);

-- One approval email a day (Chicago date); `forced` marks one sent early (her change request, the operator lever).
CREATE TABLE IF NOT EXISTS tlc_brand_reply_notice (
  ref            TEXT PRIMARY KEY,
  reply_ids_json TEXT NOT NULL,
  day            TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  sent_at        TEXT NOT NULL,
  sent_to        TEXT,
  forced         INTEGER NOT NULL DEFAULT 0,
  gmail_id       TEXT
);

-- A reply used to file the pitch email (PDF attached) as if it were a yes. Those not yet sent are withdrawn: Wynn
-- reads each reply again and drafts her answer, and the PDF goes only in answer to a yes.
UPDATE approval_card SET state = 'rejected'
 WHERE state = 'pending_review'
   AND id IN (SELECT approval_card_id FROM tlc_pitch_followup WHERE state IN ('HELD','AWAITING_APPROVAL') AND approval_card_id IS NOT NULL);
DELETE FROM tlc_pitch_followup
 WHERE state IN ('HELD','FAILED')
    OR (state = 'AWAITING_APPROVAL' AND approval_card_id IN (SELECT id FROM approval_card WHERE state = 'rejected'));

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0272_tlc_brand_reply');
