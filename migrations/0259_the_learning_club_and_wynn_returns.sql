-- WEST PEEK ROOMS — THE LEARNING CLUB (TLC) EDITION, and the seat that sells it.
--
-- Owner, 22 Oct 2026: in-person learning clubs, 25–40 people, one topic, New York City only, one a
-- month from January 2027, selling from early November 2026. $10,000 net per club from brand
-- sponsors ($7,500 floor, costs capped at $5,000); every attendee buys a $10 ticket. The rules are
-- code in `src/shared/tlc/learningClub.ts`; this file holds only the tables and the jobs.
--
-- ── WYNN COMES BACK, AS TLC SALES & PARTNERSHIPS ──────────────────────────────────────────────
--
-- WHY UN-RETIRE RATHER THAN HIRE. The live roster has no sales or partnerships seat: Parker is the
-- Event Marketing Coordinator and stays on topics (the owner's words). Wynn was the Sponsorship
-- Scout — the Room sponsorship pipeline was his desk (P51, services/sponsors.ts) — retired in the
-- cull when events and sponsorship were merged. Selling TLC sponsorships is that job, so the seat
-- that already exists is re-pointed, the precedent being Whitney (0069) and the roster's own rule
-- that every seat answers a question the others do not.
--
-- THE LIFECYCLE PATH, BOTH STEPS ON THE RECORD. RETIRED → INACTIVE is the un-retirement (what
-- POST /api/workforce/:id/unretire writes), and INACTIVE → ACTIVE is the employment the owner
-- approved on 22 Oct 2026 ("Pick the TLC sales agent … brought back via the existing lifecycle
-- path"). Written as HUMAN fu_sequoia_taylor exactly as 0136 recorded the owner's own direction.
-- His history is not rewritten; two rows are appended.

UPDATE ai_employee
   SET role = 'TLC Sales & Partnerships',
       layer = 'Portfolio & operations',
       purpose = 'Sells The Learning Club: the trend story with real sources, the one-pagers, the weekly brand drip, the deals, and the decision emails both partners answer. Never spends money; sends nothing to a brand until the owner has approved the one-pager and the playbook.',
       primary_machines_json = '["brand_sponsorship_revenue"]'
 WHERE id = 'aie_wynn';

INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason)
SELECT 'aesh_wynn_unretired_0259', id, 'RETIRED', 'INACTIVE', 'HUMAN', 'fu_sequoia_taylor',
       'Un-retired as TLC Sales & Partnerships on the owner''s approval of The Learning Club, 22 Oct 2026. '
       || 'No live seat sells; the Sponsorship Scout seat already existed and is re-pointed rather than a new hire.'
  FROM ai_employee WHERE id = 'aie_wynn' AND status = 'RETIRED';

INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason)
SELECT 'aesh_wynn_employed_0259', id, 'INACTIVE', 'ACTIVE', 'HUMAN', 'fu_sequoia_taylor',
       'Employed on the owner''s direction, 22 Oct 2026: The Learning Club sales seat.'
  FROM ai_employee WHERE id = 'aie_wynn' AND status = 'RETIRED';

UPDATE ai_employee
   SET status = 'ACTIVE', activated_by = 'fu_sequoia_taylor', activated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'aie_wynn' AND status = 'RETIRED';

UPDATE ai_employee_profile
   SET department = 'Portfolio & operations',
       brief = 'TLC Sales & Partnerships. Sells The Learning Club to brands; the partners book and pay.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE ai_employee_id = 'aie_wynn';

-- ── THE TABLES ────────────────────────────────────────────────────────────────────────────────
-- Sponsor names and amounts live HERE and nowhere in the repository (the repo is public).

CREATE TABLE tlc_event (
  id                     TEXT PRIMARY KEY,
  month                  TEXT NOT NULL UNIQUE CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND month >= '2027-01'),
  event_date             TEXT NOT NULL,
  -- 3–4 hours: one afternoon (Sat 1–5 pm) or one evening (Thu 6–10 pm). See TLC_SLOTS.
  slot                   TEXT NOT NULL DEFAULT 'EVENING' CHECK (slot IN ('AFTERNOON','EVENING')),
  topic                  TEXT,
  angle                  TEXT,
  status                 TEXT NOT NULL DEFAULT 'PLANNING'
                         CHECK (status IN ('PLANNING','TOPIC_PROPOSED','TOPIC_READY','SWAP_FLAGGED','ESCALATED','GO','DONE','CANCELLED')),
  -- Parker's pick PROCEEDS unless either partner says no before this moment (3 days; owner, 22 Oct 2026).
  veto_until             TEXT,
  topic_card_id          TEXT,
  -- Topics a partner said no to for this month, so Parker never offers them again for it.
  vetoed_topics_json     TEXT,
  packet_json            TEXT,
  sponsor_categories_json TEXT,
  booking_pack_json      TEXT,
  booking_pack_at        TEXT,
  -- West Peek's own ticket link (money IN). Set by a partner from West Peek's payment account.
  ticket_url             TEXT,
  sponsor_payment_url    TEXT,
  committed_costs_usd    REAL NOT NULL DEFAULT 0,
  swap_flagged_at        TEXT,
  go_checks_json         TEXT,
  recap                  TEXT,
  firm_scope             TEXT NOT NULL DEFAULT 'west-peek',
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tlc_deal (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES tlc_event(id),
  brand              TEXT NOT NULL,
  category           TEXT,
  contact_name       TEXT,
  contact_email      TEXT NOT NULL,
  contact_source_url TEXT NOT NULL,
  why_fit            TEXT,
  stage              TEXT NOT NULL DEFAULT 'PROSPECT'
                     CHECK (stage IN ('PROSPECT','PITCHED','CALL','WAITING_ON_OWNERS','AGREED','PAID','DELIVERED','DECLINED','STOPPED')),
  cash_offer_usd     REAL,
  in_kind_offer      TEXT,
  in_kind_value_usd  REAL,
  wants              TEXT,
  decision           TEXT CHECK (decision IS NULL OR decision IN ('YES','NO','COUNTER')),
  decision_by        TEXT,
  counter_usd        REAL,
  drip_step          INTEGER NOT NULL DEFAULT 0,
  next_send_at       TEXT,
  first_sent_at      TEXT,
  last_sent_at       TEXT,
  replied_at         TEXT,
  stop_reason        TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('REPLIED','BOUNCED','UNSUBSCRIBED','DECLINED')),
  decision_card_id   TEXT,
  firm_scope         TEXT NOT NULL DEFAULT 'west-peek',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (event_id, contact_email)
);
CREATE INDEX idx_tlc_deal_contact ON tlc_deal (contact_email);
CREATE INDEX idx_tlc_deal_due ON tlc_deal (next_send_at);

CREATE TABLE tlc_drip_message (
  id                 TEXT PRIMARY KEY,
  deal_id            TEXT NOT NULL REFERENCES tlc_deal(id),
  step               INTEGER NOT NULL CHECK (step BETWEEN 0 AND 3),
  subject            TEXT NOT NULL,
  body               TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('HELD','AWAITING_APPROVAL','SENT','FAILED')),
  held_reason        TEXT,
  effect_request_id  TEXT,
  approval_card_id   TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at            TEXT,
  UNIQUE (deal_id, step)
);

CREATE TABLE tlc_ticket (
  id           TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES tlc_event(id),
  buyer_name   TEXT,
  buyer_email  TEXT NOT NULL,
  amount_usd   REAL NOT NULL CHECK (amount_usd > 0 AND amount_usd <= 10),
  fee_usd      REAL,
  payment_ref  TEXT NOT NULL UNIQUE,
  source       TEXT NOT NULL,
  paid_at      TEXT NOT NULL,
  refunded_at  TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE tlc_story (
  id          TEXT PRIMARY KEY,
  quarter     TEXT NOT NULL UNIQUE,
  story       TEXT NOT NULL,
  card_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every claim in a story points at a page that answered when Wynn stored it.
CREATE TABLE tlc_source (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL REFERENCES tlc_story(id),
  title       TEXT NOT NULL,
  publisher   TEXT,
  url         TEXT NOT NULL,
  published_on TEXT,
  claim       TEXT NOT NULL,
  checked_at  TEXT NOT NULL
);

CREATE TABLE tlc_setting (
  key     TEXT PRIMARY KEY,
  value   TEXT,
  set_by  TEXT,
  set_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- THE SEND SWITCH, OFF. Nothing reaches a brand until the owner approves the one-pager mock and
-- the playbook (two more rows, written by POST /api/tlc/approve) and a partner turns this on.
INSERT INTO tlc_setting (key, value, set_by) VALUES ('brand_send', 'off', 'migration:0259');

-- ── THE JOBS ──────────────────────────────────────────────────────────────────────────────────
-- WHERE NOT EXISTS, never OR IGNORE (tests/seededJobs.test.ts).

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, day_of_month, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope, next_run_at)
SELECT 'sjb_tlc_topics', 'tlc_topics', 'The Learning Club: three topics ahead (Parker)',
       'EMPLOYEE_TASK', 'MONTHLY', '14:00', 1, 'EMPLOYEE', 'aie_parker', 'work_card.create',
       'INTELLIGENCE', 1.50, 'PUBLIC', 'ACTIVE', 'system', 'west-peek',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'tlc_topics');

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope)
SELECT 'sjb_tlc_daily', 'tlc_daily', 'The Learning Club: daily (booking packs, swap flags, go-ahead, drip)',
       'EMPLOYEE_TASK', 'DAILY_AT', '13:30', 'EMPLOYEE', 'aie_wynn', 'work_card.create',
       'INTELLIGENCE', 0, 'INTERNAL', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'tlc_daily');

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, day_of_week, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope)
SELECT 'sjb_tlc_brand_batch', 'tlc_brand_batch', 'The Learning Club: Monday brand batch (Wynn)',
       'EMPLOYEE_TASK', 'WEEKLY', '14:00', 1, 'EMPLOYEE', 'aie_wynn', 'work_card.create',
       'INTELLIGENCE', 1.50, 'PUBLIC', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'tlc_brand_batch');

INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, day_of_month, target_kind, target_id, capability_key,
   task_class, budget_usd, data_class, status, created_by, firm_scope, next_run_at)
SELECT 'sjb_tlc_trend_story', 'tlc_trend_story', 'The Learning Club: the trend story, quarterly (Wynn)',
       'EMPLOYEE_TASK', 'MONTHLY', '15:00', 1, 'EMPLOYEE', 'aie_wynn', 'work_card.create',
       'INTELLIGENCE', 1.50, 'PUBLIC', 'ACTIVE', 'system', 'west-peek',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'tlc_trend_story');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0259_the_learning_club_and_wynn_returns');
