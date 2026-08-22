-- Who may edit a company record.
--
-- Operator, 21 Aug 2026, asked directly: "the MPs should be able to edit and the host employee and
-- maybe investment lead?"
--
-- THE HOLE THIS FILLS. `authorize()` had exactly two tiers above nothing: RESERVED — never for an AI
-- actor, human needs the approver role, and even then it executes only behind an approved approval
-- card — and everything else, whose last line reads "ordinary internal action: allowed for any actor
-- inside firm scope". `company.update` was ordinary, so any authenticated identity inside the firm
-- could rewrite a company record, including the read-only service account a Cloudflare Access
-- service token resolves to. The choke point ran and decided nothing.
--
-- Reserved was the wrong instrument. Reserved means an approval CARD per action, and raising a card
-- every time somebody corrects a spelling would make the whole approval queue unreadable — which is
-- how a governance control gets switched off in practice.
--
-- So: RESTRICTED. Role-gated, not approval-gated. Named roles act immediately; everyone else is
-- refused. The edit is still attributed and still lands on the event spine with per-field from→to,
-- which was already true and is what makes acting immediately safe.
--
-- AN AI EMPLOYEE CAN HOLD A RESTRICTED ROLE, and that is the point of the third tier. Wyatt hosts
-- Companies and keeping the register straight is his job; barring him from it would leave the firm
-- with a host who cannot do the work his own page is for. What he cannot do is anything RESERVED —
-- that boundary is untouched.
CREATE TABLE IF NOT EXISTS restricted_action (
  key             TEXT PRIMARY KEY REFERENCES action_type (key),
  description     TEXT NOT NULL,
  -- Human roles, and/or AI employee names, permitted to take the action directly.
  allowed_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Plain INSERT, never INSERT OR IGNORE: this repo has twice shipped a migration that reported
-- success while a CHECK or a foreign key silently swallowed the row, and the thing the row was
-- supposed to protect then went unprotected with nothing anywhere saying so.
INSERT INTO restricted_action (key, description, allowed_json) VALUES
  ('company.update',
   'Edit a company record. Attributed and on the event spine field by field.',
   '{"roles":["MANAGING_PARTNER","INVESTMENT_TEAM"],"employees":["Wyatt"]}');

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a
-- re-apply is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0125_some_actions_are_restricted_not_reserved');
