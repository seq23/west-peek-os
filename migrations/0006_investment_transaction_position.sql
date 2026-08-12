-- 0006_investment_transaction_position.sql — P6 investment workflow: opportunities,
-- security classes, block links, transactions, positions, ownership snapshots,
-- pricing observations, deal math packets, IC packets/decisions/dissent.
-- Convention: lowercase snake_case (P1); CREATE IF NOT EXISTS / INSERT OR IGNORE so
-- re-application is a no-op. firm_scope on every firm-data table (§11.7).
-- Material mutations append to the event spine (D15) at the service layer.
-- "transaction" is quoted everywhere: it is a SQL keyword.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0006_investment_transaction_position');

-- ── Action vocabulary additions (P6) ──
-- The registry sources (src/shared/registry/actionTypes.ts + reservedActions.ts)
-- carry these keys and the 0003 generated seed section includes them for fresh
-- databases. These compensating INSERT OR IGNORE statements cover databases that
-- applied 0003 before P6 existed.

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('security_class.create', 'Create security class', 'Record a distinct share class for a canonical company (classes are never merged).', 0, 0),
  ('opportunity.create', 'Create opportunity', 'Record an investment opportunity on a canonical company (secondaries keep seller/block provenance).', 0, 0),
  ('opportunity.update', 'Update opportunity', 'Update opportunity fields (price, quantity, fees, terms, provenance).', 0, 0),
  ('opportunity.transition', 'Transition opportunity', 'Move an opportunity through its lifecycle (NEW→SCREENING→DILIGENCE→IC_READY→IC_DECIDED→CLOSED, or PASS/WITHDRAWN).', 0, 0),
  ('opportunity_block_link.propose', 'Propose block link', 'Link two opportunities as duplicate candidates or related blocks. Linking never merges.', 0, 0),
  ('opportunity_block_link.decide', 'Decide block link', 'Human confirm/reject of a proposed duplicate/related block link (human only).', 0, 0),
  ('transaction.create', 'Create transaction', 'Draft a transaction (PURCHASE/SALE/PRIMARY_INVESTMENT/FOLLOW_ON/EXIT_*); approval via the type-specific reserved action.', 0, 0),
  ('transaction.execute', 'Execute transaction', 'Mark an approved transaction EXECUTED with a valid reserved-action receipt; creates/updates positions.', 0, 0),
  ('transaction.party.add', 'Add transaction party', 'Attach a seller/buyer/broker/fund-entity party to a transaction.', 0, 0),
  ('ownership_snapshot.create', 'Create ownership snapshot', 'Record an as-of ownership snapshot with dilution assumptions and source.', 0, 0),
  ('pricing_observation.create', 'Create pricing observation', 'Record a pricing observation (BID/ASK/INDICATION/EXECUTED_TRANSACTION/PRIMARY_ROUND/INTERNAL_ESTIMATE — statuses stay distinct).', 0, 0),
  ('deal_math_packet.create', 'Create deal math packet', 'Create a deal math packet by manual entry (D6: manual entry is always supported).', 0, 0),
  ('deal_math_packet.update', 'Update deal math packet', 'Change packet inputs/assumptions; every change appends to the assumption ledger.', 0, 0),
  ('deal_math.calculate', 'Calculate deal math', 'Run the independently verified deal-math functions over packet inputs (entry_mode=CALCULATED).', 0, 0),
  ('deal_math_packet.review', 'Review deal math packet', 'Human review transition of a packet''s math quality status.', 0, 0),
  ('ic_packet.assemble', 'Assemble IC packet', 'Assemble an IC packet: deal math + evidence summary + unresolved material contradictions (never filtered). AI may draft; humans decide.', 0, 0),
  ('dissent.create', 'Record dissent', 'Attach a dissent record to an IC decision (append-only).', 0, 0),
  ('transaction.void', 'transaction.void', 'Void a transaction (reverses its position effect; the record is preserved).', 0, 1);

INSERT OR IGNORE INTO human_reserved_action (key, category, description, approver_roles_json) VALUES
  ('transaction.void', 'INVESTMENT_CAPITAL', 'Void a transaction (reverses its position effect; the record is preserved).', '["MANAGING_PARTNER"]');

-- ── Security classes (share classes stay DISTINCT per company; never merged) ──

CREATE TABLE IF NOT EXISTS security_class (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES canonical_company (id),
  class_name  TEXT NOT NULL,
  seniority   TEXT,
  notes       TEXT,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_security_class_company ON security_class (company_id);

-- ── Investment opportunities ──
-- Secondaries preserve seller/share-class/fees/terms/broker provenance on the row.

CREATE TABLE IF NOT EXISTS investment_opportunity (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES canonical_company (id),
  opportunity_type  TEXT NOT NULL
                    CHECK (opportunity_type IN ('EARLY_STAGE_PRIMARY','FOLLOW_ON','SECONDARY_PURCHASE','SECONDARY_SALE','OTHER')),
  title             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'NEW'
                    CHECK (status IN ('NEW','SCREENING','DILIGENCE','IC_READY','IC_DECIDED','CLOSED','PASS','WITHDRAWN')),
  source_channel    TEXT,
  security_class_id TEXT REFERENCES security_class (id),
  price_per_share   REAL,
  discount_premium  REAL,
  quantity          REAL,
  seller_name       TEXT,
  broker_name       TEXT,
  fees              REAL,
  carry             REAL,
  terms_json        TEXT NOT NULL DEFAULT '{}',
  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_investment_opportunity_company ON investment_opportunity (company_id);
CREATE INDEX IF NOT EXISTS idx_investment_opportunity_status ON investment_opportunity (status, firm_scope);

-- ── Opportunity block links ──
-- Duplicate/related blocks are LINKED, never destructively merged. There is no
-- merge path for opportunities; confirm/reject only records the human review.

CREATE TABLE IF NOT EXISTS opportunity_block_link (
  id                TEXT PRIMARY KEY,
  opportunity_id_a  TEXT NOT NULL REFERENCES investment_opportunity (id),
  opportunity_id_b  TEXT NOT NULL REFERENCES investment_opportunity (id),
  link_type         TEXT NOT NULL
                    CHECK (link_type IN ('DUPLICATE_CANDIDATE','RELATED_BLOCK')),
  basis_json        TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'PROPOSED'
                    CHECK (status IN ('PROPOSED','CONFIRMED','REJECTED')),
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_block_link_a ON opportunity_block_link (opportunity_id_a);
CREATE INDEX IF NOT EXISTS idx_block_link_b ON opportunity_block_link (opportunity_id_b);

-- ── Transactions ──
-- Approval runs through the type-specific reserved action (secondary_purchase.approve,
-- secondary_sale.approve, follow_on.approve, exit.approve, investment.approve) with an
-- approved approval-card receipt; EXECUTED requires that receipt. VOID requires the
-- MP-reserved transaction.void receipt. The record is preserved in every case.

CREATE TABLE IF NOT EXISTS "transaction" (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES canonical_company (id),
  opportunity_id    TEXT REFERENCES investment_opportunity (id),
  transaction_type  TEXT NOT NULL
                    CHECK (transaction_type IN ('PURCHASE','SALE','PRIMARY_INVESTMENT','FOLLOW_ON','EXIT_PARTIAL','EXIT_FULL')),
  security_class_id TEXT NOT NULL REFERENCES security_class (id),
  quantity          REAL NOT NULL,
  price_per_share   REAL NOT NULL,
  gross_amount      REAL NOT NULL,
  fees              REAL NOT NULL DEFAULT 0,
  carry             REAL NOT NULL DEFAULT 0,
  net_amount        REAL NOT NULL,
  transaction_date  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','EXECUTED','VOID')),
  approval_card_id  TEXT REFERENCES approval_card (id),
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_transaction_company ON "transaction" (company_id);
CREATE INDEX IF NOT EXISTS idx_transaction_opportunity ON "transaction" (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_transaction_status ON "transaction" (status, firm_scope);

CREATE TABLE IF NOT EXISTS transaction_party (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES "transaction" (id),
  party_type     TEXT NOT NULL
                 CHECK (party_type IN ('SELLER','BUYER','BROKER','FUND_ENTITY','OTHER')),
  party_name     TEXT NOT NULL,
  party_ref_id   TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_transaction_party_txn ON transaction_party (transaction_id);

-- ── Positions ──

CREATE TABLE IF NOT EXISTS position (
  id                          TEXT PRIMARY KEY,
  company_id                  TEXT NOT NULL REFERENCES canonical_company (id),
  fund_id                     TEXT NOT NULL REFERENCES fund (id),
  security_class_id           TEXT NOT NULL REFERENCES security_class (id),
  quantity                    REAL NOT NULL,
  cost_basis                  REAL NOT NULL,
  acquired_via_transaction_id TEXT REFERENCES "transaction" (id),
  status                      TEXT NOT NULL DEFAULT 'OPEN'
                              CHECK (status IN ('OPEN','CLOSED')),
  firm_scope                  TEXT NOT NULL DEFAULT 'west-peek',
  opened_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_position_company ON position (company_id);
CREATE INDEX IF NOT EXISTS idx_position_fund ON position (fund_id);

-- ── Ownership snapshots ──

CREATE TABLE IF NOT EXISTS ownership_snapshot (
  id                       TEXT PRIMARY KEY,
  company_id               TEXT NOT NULL REFERENCES canonical_company (id),
  fund_id                  TEXT NOT NULL REFERENCES fund (id),
  as_of_date               TEXT NOT NULL,
  ownership_pct            REAL NOT NULL,
  fully_diluted_shares     REAL,
  dilution_assumptions_json TEXT NOT NULL DEFAULT '{}',
  source                   TEXT NOT NULL,
  firm_scope               TEXT NOT NULL DEFAULT 'west-peek',
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ownership_snapshot_company ON ownership_snapshot (company_id);

-- ── Pricing observations (observation types stay DISTINCT — BID is not ASK is not
-- an executed trade; nothing collapses them) ──

CREATE TABLE IF NOT EXISTS pricing_observation (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES canonical_company (id),
  observation_type  TEXT NOT NULL
                    CHECK (observation_type IN ('BID','ASK','INDICATION','EXECUTED_TRANSACTION','PRIMARY_ROUND','INTERNAL_ESTIMATE')),
  price_per_share   REAL,
  implied_valuation REAL,
  block_size        REAL,
  seller_type       TEXT,
  fees              REAL,
  carry             REAL,
  observed_at       TEXT NOT NULL,
  source            TEXT NOT NULL,
  privacy_label     TEXT NOT NULL DEFAULT 'INTERNAL',
  firm_scope        TEXT NOT NULL DEFAULT 'west-peek',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_pricing_observation_company ON pricing_observation (company_id);

-- ── Deal math packets ──
-- D6 + ADR-005: manual entry is always supported; the CALCULATED path fills derived
-- metrics ONLY from independently verified functions (docs/DEAL_MATH_VERIFICATION.md).
-- tvpi/dpi have no verified portfolio-level computation — manual entry only.

CREATE TABLE IF NOT EXISTS deal_math_packet (
  id                          TEXT PRIMARY KEY,
  opportunity_id              TEXT NOT NULL REFERENCES investment_opportunity (id),
  deal_type                   TEXT NOT NULL,
  source_inputs_json          TEXT NOT NULL DEFAULT '{}',
  assumption_set_json         TEXT NOT NULL DEFAULT '{}',
  valuation                   REAL,
  check_size                  REAL,
  ownership_at_close          REAL,
  expected_exit_ownership     REAL,
  dilution_assumptions_json   TEXT NOT NULL DEFAULT '{}',
  pro_rata_status             TEXT,
  reserve_requirement         REAL,
  moic                        REAL,
  tvpi                        REAL,
  dpi                         REAL,
  xirr                        REAL,
  fund_contribution           REAL,
  concentration_impact        REAL,
  secondary_discount_premium  REAL,
  margin_of_safety_note       TEXT,
  math_quality_status         TEXT NOT NULL DEFAULT 'NOT_STARTED'
                              CHECK (math_quality_status IN ('NOT_STARTED','INPUTS_MISSING','DRAFT_MATH_COMPLETE','NEEDS_REVIEW','IC_READY','EXCEPTION_MEMO_REQUIRED','REJECTED','MATH_DOES_NOT_WORK')),
  missing_inputs_json         TEXT NOT NULL DEFAULT '[]',
  entry_mode                  TEXT NOT NULL DEFAULT 'MANUAL'
                              CHECK (entry_mode IN ('MANUAL','CALCULATED')),
  reviewed_by                 TEXT,
  approval_status             TEXT NOT NULL DEFAULT 'NOT_REQUESTED'
                              CHECK (approval_status IN ('NOT_REQUESTED','PENDING','APPROVED','REJECTED')),
  ic_ready                    INTEGER NOT NULL DEFAULT 0,
  firm_scope                  TEXT NOT NULL DEFAULT 'west-peek',
  created_by                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deal_math_packet_opportunity ON deal_math_packet (opportunity_id);

CREATE TABLE IF NOT EXISTS deal_math_assumption (
  id               TEXT PRIMARY KEY,
  packet_id        TEXT NOT NULL REFERENCES deal_math_packet (id),
  assumption_key   TEXT NOT NULL,
  assumption_value TEXT NOT NULL,
  source           TEXT NOT NULL,
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deal_math_assumption_packet ON deal_math_assumption (packet_id);

-- Assumption ledger: APPEND-ONLY. UPDATE and DELETE are rejected at the DB layer.
CREATE TABLE IF NOT EXISTS assumption_ledger (
  id          TEXT PRIMARY KEY,
  packet_id   TEXT NOT NULL REFERENCES deal_math_packet (id),
  change_json TEXT NOT NULL,
  firm_scope  TEXT NOT NULL DEFAULT 'west-peek',
  changed_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_assumption_ledger_packet ON assumption_ledger (packet_id);

CREATE TRIGGER IF NOT EXISTS assumption_ledger_reject_update
BEFORE UPDATE ON assumption_ledger
BEGIN
  SELECT RAISE(ABORT, 'assumption_ledger is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS assumption_ledger_reject_delete
BEFORE DELETE ON assumption_ledger
BEGIN
  SELECT RAISE(ABORT, 'assumption_ledger is append-only: DELETE rejected (D15)');
END;

-- ── IC packets, decisions, dissent ──
-- AI may DRAFT a packet (drafted_by_type='AI', ai_run_id recorded; quarantine rules
-- apply). Decisions are human-only via the reserved action investment.approve.

CREATE TABLE IF NOT EXISTS ic_packet (
  id                             TEXT PRIMARY KEY,
  opportunity_id                 TEXT NOT NULL REFERENCES investment_opportunity (id),
  deal_math_packet_id            TEXT REFERENCES deal_math_packet (id),
  evidence_summary_json          TEXT NOT NULL DEFAULT '{}',
  unresolved_contradictions_json TEXT NOT NULL DEFAULT '[]',
  drafted_by_type                TEXT NOT NULL
                                 CHECK (drafted_by_type IN ('HUMAN','AI')),
  drafted_by_id                  TEXT NOT NULL,
  ai_run_id                      TEXT,
  status                         TEXT NOT NULL DEFAULT 'DRAFT'
                                 CHECK (status IN ('DRAFT','IN_REVIEW','DECIDED')),
  firm_scope                     TEXT NOT NULL DEFAULT 'west-peek',
  created_at                     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ic_packet_opportunity ON ic_packet (opportunity_id);

-- IC decisions: APPEND-ONLY. UPDATE and DELETE are rejected at the DB layer.
CREATE TABLE IF NOT EXISTS ic_decision (
  id           TEXT PRIMARY KEY,
  ic_packet_id TEXT NOT NULL REFERENCES ic_packet (id),
  decision     TEXT NOT NULL
               CHECK (decision IN ('APPROVE','REJECT','DEFER')),
  decided_by   TEXT NOT NULL,
  rationale    TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ic_decision_packet ON ic_decision (ic_packet_id);

CREATE TRIGGER IF NOT EXISTS ic_decision_reject_update
BEFORE UPDATE ON ic_decision
BEGIN
  SELECT RAISE(ABORT, 'ic_decision is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS ic_decision_reject_delete
BEFORE DELETE ON ic_decision
BEGIN
  SELECT RAISE(ABORT, 'ic_decision is append-only: DELETE rejected (D15)');
END;

-- Dissent records: APPEND-ONLY.
CREATE TABLE IF NOT EXISTS dissent_record (
  id             TEXT PRIMARY KEY,
  ic_decision_id TEXT NOT NULL REFERENCES ic_decision (id),
  dissenter_id   TEXT NOT NULL,
  dissent_text   TEXT NOT NULL,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_dissent_record_decision ON dissent_record (ic_decision_id);

CREATE TRIGGER IF NOT EXISTS dissent_record_reject_update
BEFORE UPDATE ON dissent_record
BEGIN
  SELECT RAISE(ABORT, 'dissent_record is append-only: UPDATE rejected (D15)');
END;

CREATE TRIGGER IF NOT EXISTS dissent_record_reject_delete
BEFORE DELETE ON dissent_record
BEGIN
  SELECT RAISE(ABORT, 'dissent_record is append-only: DELETE rejected (D15)');
END;
