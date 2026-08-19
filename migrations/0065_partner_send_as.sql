-- Whether a partner's approved email goes out as THEM rather than as the firm.
--
-- This is possible at all because westpeek.ventures is a verified sending domain, so any address on
-- it can be a From. It therefore needs no Google permission, no mailbox access and no second
-- consent screen — which is worth saying plainly, because "send as me" sounds like it should
-- require reading someone's mail and it does not.
--
-- OFF BY DEFAULT, and the default is the point. Sending as a named partner is the system speaking
-- in a person's voice to people who trust that person, so it starts off and stays off until that
-- partner turns it on themselves.
--
-- SELF-SERVICE ONLY, enforced in the handler: a Managing Partner may flip their own switch and
-- nobody else's. One partner enabling "send as" for the other would be arranging to have mail sent
-- in a colleague's name without asking them, which is the one thing this table must not permit.
--
-- The address is stored as resolved at the moment of enabling rather than derived at send time, so
-- a later change to somebody's login address cannot silently redirect who the firm appears to be.
CREATE TABLE IF NOT EXISTS partner_send_as (
  firm_user_id TEXT PRIMARY KEY REFERENCES firm_user (id),
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  from_address TEXT,
  -- Who flipped it and when. Equal to firm_user_id today by construction; recorded anyway so an
  -- auditor reads the fact rather than trusting the rule.
  changed_by   TEXT NOT NULL,
  changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek'
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0065_partner_send_as');
