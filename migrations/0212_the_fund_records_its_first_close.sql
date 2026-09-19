-- 0212 — The fund records its first close, so the pace against the plan has a clock.
--
-- Fund strategy's redesign (design/FUND_STRATEGY_DESIGN.md §3.2, approved 19 Sep 2026) draws one
-- chart Portfolio does not: initial-cheque capital deployed against the plan over the investment
-- period. A pace needs an origin, and the fund carried none — `vintage_year` is a year, not a date,
-- and the mandate's investment period counts from the first close. Approval question 3, decided:
-- record it.
--
-- WRITTEN TWO WAYS, NEVER GUESSED. A Managing Partner types it behind Amend (the same
-- `fund.set_size` authority that sets the fund's size), or the LP page sets it the moment the
-- first SIGNED commitment lands on a fund that has none — `committed_on` if the commitment carries
-- one, else the day it was recorded. Until one of those happens the pace band says the clock has
-- not started and draws no plan line (§3.2 state 1); the alternative, drawing from the vintage
-- year, was rejected as honest but blunt.
--
-- ADD COLUMN, NOT A TABLE REBUILD: a nullable column needs none of that, and `fund` is the root a
-- dozen tables point at with foreign keys.
ALTER TABLE fund ADD COLUMN first_close_on TEXT;

CREATE TABLE migration_guard_0212 (matched INTEGER NOT NULL CHECK (matched = 1));
INSERT INTO migration_guard_0212 (matched)
SELECT COUNT(*) FROM pragma_table_info('fund') WHERE name = 'first_close_on';
DROP TABLE migration_guard_0212;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0212_the_fund_records_its_first_close');
