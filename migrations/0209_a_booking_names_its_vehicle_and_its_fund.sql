-- 0209 — A booking names its vehicle and its fund (Phase D: portfolio, owner-approved 18 Sep 2026).
--
-- design/DEALS_SECTION_DESIGN.md §6, decision Q1: a partner's approval of the `investment.approve`
-- card EXECUTES the booking. Until now the fund a position would be booked to was typed at the
-- last rung — `POST /api/transactions/:id/execute { fund_id }` — by whoever came back with the
-- receipt. If approval is the last human act, the draft has to carry everything execution needs,
-- so the fund moves onto the transaction itself, named when the terms are entered.
--
--   fund_id   the fund the position is booked to on execution. NULL on a draft written through the
--             older API without one; such a draft still executes only through the explicit route,
--             with the fund named there, because the ledger cannot book to a fund nobody named.
--   vehicle   which entity holds it — "SPV", "Fund I direct", "Warehouse". Today only the closed
--             opportunity's `terms_json.vehicle` knows this; the transaction is what the fund's own
--             record reads, so it is recorded on the transaction too.
--
-- Additive: both columns are nullable, every row that exists keeps its shape, and nothing here
-- rewrites an applied migration.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0209_a_booking_names_its_vehicle_and_its_fund');

ALTER TABLE "transaction" ADD COLUMN fund_id TEXT REFERENCES fund (id);
ALTER TABLE "transaction" ADD COLUMN vehicle TEXT;

CREATE INDEX IF NOT EXISTS idx_transaction_fund ON "transaction" (fund_id) WHERE fund_id IS NOT NULL;
