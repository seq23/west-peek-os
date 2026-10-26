-- 0273 · WYNN LISTENS (owner, 26 Oct 2026). services/tlcBrandReply.ts.
-- Her change note to a brand reply (TLR-EL84CT) was cut at 600 characters and only the email was rewritten: her
-- standing instructions were lost and the research and report she asked for never happened. Now:
--   · tlc_wynn_rule holds Wynn's standing rules from her. Every TLC brand reply draft reads the active rows, and a
--     standing instruction in any later note of hers is added here (source = the approval reference it came in).
--     `code` marks a rule the code itself enforces as well as the prompt (NO_MONEY_EARLY rejects a draft that
--     mentions money before a call; NO_CALL_ASK rejects a draft that asks for a call the brand did not propose; WE_HOST rejects "your team leads …"; WHO_WE_ARE's text is the facts of who we are, which every first reply or introduction to a brand must explain).
--   · a reply she asks to have researched waits (research_due) until Wynn's research ran, and the approval email
--     carries his report (report_text) above the new draft.
CREATE TABLE IF NOT EXISTS tlc_wynn_rule (
  id          TEXT PRIMARY KEY,
  code        TEXT,
  rule        TEXT NOT NULL,
  source      TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tlc_wynn_rule_active ON tlc_wynn_rule (firm_scope, active);

INSERT OR IGNORE INTO tlc_wynn_rule (id, code, rule, source) VALUES
  ('wr_no_money_early', 'NO_MONEY_EARLY',
   'Never discuss money this early: no prices, budgets, fees or partnership tiers in a first reply or at any point before a call has happened.',
   'her note on TLR-EL84CT, 26 Oct 2026'),
  ('wr_who_we_are', 'WHO_WE_ARE',
   'West Peek Ventures is a community of more than 5,000 people; our founding GP, Scooter Taylor, went viral in 2020 with Quarantine Con. West Peek Rooms is our in-person event series in New York, and The Learning Club is its hands-on part.',
   'her note to the coordinator, 26 Oct 2026'),
  ('wr_build_together', NULL,
   'Frame it as partnering to build something special together, not as selling a sponsorship package.',
   'her note on TLR-EL84CT, 26 Oct 2026'),
  ('wr_who_they_reach', NULL,
   'Ask who they most want to reach, and offer to explore together how we reach those people.',
   'her note on TLR-EL84CT, 26 Oct 2026'),
  ('wr_no_call_ask', 'NO_CALL_ASK',
   'Never suggest or ask for a call in any brand email; the brand may propose one, and then she says yes. Deals are closed over email. The default next step is an offer to send three things: a sample run of show for the evening, a sketch of what a series of six could look like, and a breakdown of the kind of people in the room.',
   'her rule to the coordinator, 26 Oct 2026'),
  ('wr_we_host', 'WE_HOST',
   'We host every segment ourselves or bring in a host, so the brand never has to send a rep or speaker unless they want to. Never write a brand''s segment as "your team leads X"; write "led by the brand or by our host".',
   'her rule to the coordinator, 26 Oct 2026'),
  ('wr_month_tentative', NULL,
   'A club''s month is tentative: say it could move, or the club could repeat.',
   'her note on TLR-EL84CT, 26 Oct 2026');

ALTER TABLE tlc_brand_reply ADD COLUMN report_text TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN research_due TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN research_tries INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0273_wynn_rules');
