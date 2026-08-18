-- 0037_browser_tasks.sql — P44: governed browser tasks (Browserbase).
--
-- WHY THIS NEEDS MORE GOVERNANCE THAN A NORMAL ADAPTER. A browser task combines three things this
-- system treats carefully on their own, and this is the first feature that has all three at once:
--
--   1. EGRESS to an arbitrary URL, chosen at runtime rather than from a registry.
--   2. UNTRUSTED CONTENT returning as input to an AI employee — a web page is the classic
--      prompt-injection surface, and unlike an RSS feed the page is picked by the task.
--   3. MONEY. Browserbase's x402 lane is pay-per-use: an HTTP 402 answered automatically by the
--      caller. An agent that can answer 402 by itself is an agent that can spend without asking.
--
-- So a browser task is a REQUEST first and an execution second, and the two are separate rows in
-- the lifecycle below. Nothing runs on the strength of an employee deciding it should.
--
-- x402 IS OFF AND STAYS OFF UNTIL A HUMAN TURNS IT ON. `payment_mode` defaults to 'NONE'.
-- Autonomous payment is the single most consequential capability in this file: canon §22A.7 puts
-- external actions behind approval, and paying for something is an external action with a receipt
-- attached. `max_price_usd` exists so that when it is enabled it is enabled with a ceiling, not as
-- an open tab.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: enable anything. There is no live transport wired
-- to it yet, exactly as the operator asked — "$0 now, scaffolding for paid later". A task created
-- today records intent and refuses at execution with a stated reason.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0037_browser_tasks');

CREATE TABLE IF NOT EXISTS browser_task (
  id              TEXT PRIMARY KEY,
  -- What the operator or employee wants done, in plain language.
  objective       TEXT NOT NULL,
  -- The starting URL. https only, and checked against the same SSRF guard the feed client uses:
  -- a browser task pointed at 169.254.169.254 is a credential exfiltration, not a research task.
  start_url       TEXT NOT NULL,
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('HUMAN','AI')),
  requested_by_id TEXT NOT NULL,
  -- The employee the result comes back to, if any.
  ai_employee_id  TEXT REFERENCES ai_employee (id),

  status          TEXT NOT NULL DEFAULT 'REQUESTED'
                  CHECK (status IN ('REQUESTED','APPROVED','RUNNING','SUCCEEDED','FAILED','REFUSED','DENIED')),
  -- Approval receipt. A task cannot leave REQUESTED without one.
  approval_card_id TEXT REFERENCES approval_card (id),

  -- ── Payment ──
  -- NONE      : no payment is possible; the task runs only on a plan with prepaid capacity.
  -- X402_AUTO : the caller may answer HTTP 402 automatically, up to max_price_usd.
  payment_mode    TEXT NOT NULL DEFAULT 'NONE'
                  CHECK (payment_mode IN ('NONE','X402_AUTO')),
  max_price_usd   REAL NOT NULL DEFAULT 0,
  spent_usd       REAL NOT NULL DEFAULT 0,

  -- ── Result ──
  -- Extracted TEXT only, never a raw page. What comes back is treated as untrusted data, and
  -- storing the whole DOM would invite someone to feed it to a model verbatim later.
  result_text     TEXT,
  result_url      TEXT,
  refusal_reason  TEXT,
  session_id      TEXT,
  ai_run_id       TEXT REFERENCES ai_run (id),

  privacy_label   TEXT NOT NULL DEFAULT 'PUBLIC',
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_browser_task_status ON browser_task (status, created_at DESC);

-- Every payment, itemised. Separate from the task so a task that pays several times over a session
-- has a per-charge record rather than one running total nobody can decompose.
CREATE TABLE IF NOT EXISTS browser_task_charge (
  id              TEXT PRIMARY KEY,
  browser_task_id TEXT NOT NULL REFERENCES browser_task (id),
  amount_usd      REAL NOT NULL,
  reason          TEXT NOT NULL,
  provider_ref    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_browser_charge_task ON browser_task_charge (browser_task_id);

-- Append-only: a charge is a financial fact. Correcting one means writing a compensating row, not
-- editing history.
CREATE TRIGGER IF NOT EXISTS browser_task_charge_reject_update
BEFORE UPDATE ON browser_task_charge
BEGIN
  SELECT RAISE(ABORT, 'browser_task_charge is append-only: UPDATE rejected (D15)');
END;

-- Registered DISABLED. Its presence declares the capability exists; `enabled = 0` is what stops it
-- being used, and only a human can change that.
INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json, base_url, firm_scope)
VALUES
  ('prv_browserbase', 'browserbase', 'Browserbase (headless browser)', 0, 0,
   '["browser.navigate","browser.extract"]',
   '{"billing":"per-session","x402":"supported, disabled by default"}',
   'https://api.browserbase.com', 'west-peek');
