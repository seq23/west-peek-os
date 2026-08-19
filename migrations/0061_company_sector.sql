-- What a company actually does, so the register can be eyeballed.
--
-- `canonical_company` carried a name, a status and a created date. That is enough to be the
-- identity spine — which is its job — and not enough to scan: a partner looking at the list cannot
-- tell an ed-tech company from a beverage brand without opening each one.
--
-- Sector is a free-text label rather than an enum on purpose. The fund's five sectors live in the
-- thesis, which is EDITED — the operator said it would be tweaked often, and it already has been.
-- An enum here would have to be migrated every time the thesis moves, and the two would drift the
-- first time somebody added a sector in the mandate and forgot the CHECK constraint. The thesis is
-- the source of truth for what the firm invests in; this column records what a company is.
--
-- one_liner is the other half of eyeballing: "Psyflo" tells you nothing a year later.

ALTER TABLE canonical_company ADD COLUMN sector TEXT;
ALTER TABLE canonical_company ADD COLUMN one_liner TEXT;

CREATE INDEX IF NOT EXISTS idx_company_sector ON canonical_company (sector) WHERE sector IS NOT NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0061_company_sector');
