-- 0284 · HER EMAILED BRAND CONTACT REACHES THE BRAND'S DEAL (31 Oct 2026). services/tlcOwnerInstruction.ts.
-- On 29 Oct 2026 she replied to a brand-reply approval email naming a contact for a must-pitch brand and how to frame
-- the pitch; the reply door read it as her change to the other brand's answer and the brand stayed at "Needs a way
-- in". Additive only:
--   · tlc_owner_instruction — one row per (her message, brand) read, so each email is applied once; brand_key '' marks
--     a message read that named no contact.
--   · tlc_way_in.contact_months_json — the club months her contact is for (NULL = every month on her list).
--   · tlc_deal.owner_angle — her framing for the brand, word for word; Wynn writes email 1 to it.
-- And one data repair: a learned "standing rule" that carries an email address is a brand's contact, not a rule for
-- every brand (shared/tlc/brandReply.ts#standingRulesIn no longer learns one). It is switched off, never deleted.
CREATE TABLE IF NOT EXISTS tlc_owner_instruction (
  message_id    TEXT NOT NULL,
  brand_key     TEXT NOT NULL,
  contact_email TEXT,
  months_json   TEXT,
  result        TEXT NOT NULL,
  applied_at    TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  PRIMARY KEY (message_id, brand_key)
);

ALTER TABLE tlc_way_in ADD COLUMN contact_months_json TEXT;
ALTER TABLE tlc_deal ADD COLUMN owner_angle TEXT;

UPDATE tlc_wynn_rule SET active = 0
 WHERE active = 1 AND code IS NULL AND source LIKE 'her note on %' AND rule GLOB '*[A-Za-z0-9]@[A-Za-z0-9]*.[A-Za-z]*';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0284_tlc_owner_email_brand_contact');
