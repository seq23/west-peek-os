-- 0030_ic_portal.sql — P34: the IC Decision Portal gets the diligence record it decides against.
--
-- V1 #26 and canon §28.6. The decision machinery already existed and worked — ic_packet,
-- append-only ic_decision carrying rationale and decider, contradiction surfacing at submit,
-- submit → approval card → decide. What was missing was the diligence the decision is supposed to
-- rest on, and any surface to conduct it in.
--
-- This migration adds that record, shaped by the West Peek IC Diligence Framework the Managing
-- Partner authored on 17 Aug 2026. The framework itself is code, not data
-- (src/shared/ic/diligenceFramework.ts) — it is the firm's method and belongs in version control
-- where a change to it shows up in a diff. What lives here is the ANSWERS.
--
-- TWO RULES FROM THE FRAMEWORK ARE STRUCTURAL, NOT ADVISORY:
--
--   1. THE DEAL CHAMPION MAY NOT WRITE THE BEAR CASE. "Otherwise IC has a nasty tendency to become
--      a sales meeting for the investment rather than an actual decision process." So the packet
--      records who the champion is, and the service refuses a kill_case answer authored by them.
--      A rule enforced only by a tooltip is a rule that quietly stops happening under time
--      pressure — which is exactly when it matters.
--
--   2. COVERAGE IS TRACKED, NOT SCORED. A section is ANSWERED, OPEN, or NOT_APPLICABLE with a
--      reason. There is deliberately no percentage: the operator's framing is "the point isn't to
--      mechanically ask 50 questions in every IC; it's to prevent us from falling in love with a
--      story and forgetting an entire category of risk". A completion percentage would turn a
--      thinking tool into a form to clear, and would let a packet look 92% done while the entire
--      kill case sits empty.
--
-- An honest NOT_APPLICABLE is a complete answer. It requires a reason, because "n/a" with no
-- reason is how a forgotten category disguises itself as a considered one.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0030_ic_portal');

-- Sector drives which module layers on top of the core eleven sections.
ALTER TABLE ic_packet ADD COLUMN sector TEXT NOT NULL DEFAULT 'OTHER'
  CHECK (sector IN ('AI','HEALTH_TECH','EDTECH','CONSUMER','B2B_SAAS','FINTECH','MARKETPLACE','BIOTECH','CYBERSECURITY','OTHER'));

-- Who is championing this deal. Nullable: a packet can exist before a champion is named, and
-- forcing a value would just produce a placeholder that defeats the rule below.
ALTER TABLE ic_packet ADD COLUMN champion_user_id TEXT REFERENCES firm_user (id);

-- ── Diligence answers ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ic_diligence_answer (
  id            TEXT PRIMARY KEY,
  ic_packet_id  TEXT NOT NULL REFERENCES ic_packet (id),
  -- Section id from the framework, or 'closing_1'…'closing_6' for the Closing Six. Not constrained
  -- to a CHECK list: the framework is versioned in code and will gain sections, and a schema that
  -- has to be migrated every time the firm sharpens its method discourages sharpening it.
  section_id    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (state IN ('OPEN','ANSWERED','NOT_APPLICABLE')),
  body          TEXT,
  -- Required when state = 'NOT_APPLICABLE'. Enforced in the service.
  na_reason     TEXT,
  answered_by   TEXT REFERENCES firm_user (id),
  answered_at   TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (ic_packet_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_ic_diligence_packet ON ic_diligence_answer (ic_packet_id);

-- ── Follow-up (§28.6 "Follow-Up" tab) ───────────────────────────────────────
--
-- What the decision obliges us to do. Distinct from meeting_commitment: that comes out of a
-- conversation, this comes out of a DECISION and survives the meeting that produced it.
-- Reuses the same assignee vocabulary as P33 so "AI does it by default, humans are recommended"
-- means the same thing in both places rather than drifting into two dialects.

CREATE TABLE IF NOT EXISTS ic_followup (
  id             TEXT PRIMARY KEY,
  ic_packet_id   TEXT NOT NULL REFERENCES ic_packet (id),
  ic_decision_id TEXT REFERENCES ic_decision (id),
  item_text      TEXT NOT NULL,
  assignee_kind  TEXT NOT NULL DEFAULT 'UNASSIGNED'
                 CHECK (assignee_kind IN ('AI_EMPLOYEE','AI_WITH_HUMAN_TOUCH','HUMAN_RECOMMENDED','UNASSIGNED')),
  ai_employee_id TEXT REFERENCES ai_employee (id),
  human_touch_reason TEXT,
  due_date       TEXT,
  state          TEXT NOT NULL DEFAULT 'OPEN'
                 CHECK (state IN ('OPEN','DONE','DROPPED')),
  work_card_id   TEXT REFERENCES work_card (id),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_ic_followup_packet ON ic_followup (ic_packet_id);
