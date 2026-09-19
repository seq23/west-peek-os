-- 0197 · every company is in the pipeline (18 Sep 2026)
--
-- Owner: "all companies should be in the pipeline, no matter how they come in. They are top of
-- funnel if they are in the system. From email we have to DECIDE on them."
--
-- WHAT WAS WRONG. Only the manual door opened an investment_opportunity. Email, Network OS and the
-- analyst's scouting created the canonical_company row and raised a card that said "open it at the
-- top of the funnel", and nothing ever checked that the card did. In production two companies sat
-- in the register with no opportunity at all: Northwind Robotics (22 Aug, created by Wyatt, no card
-- ever raised) and Vynlo (24 Aug, arrived by email, deck read, the card marked DONE with no
-- opportunity behind it). A company that is "in the system" and not on the board is a deal the firm
-- does not know it has.
--
-- The code fix is in services/dealIntake.ts: every route opens the opportunity at arrival. This is
-- the backfill for everything that arrived before that — written generically, not as two ids, so a
-- third company in the same state on any other database is caught too.
--
-- WHAT THIS DOES. For every canonical_company that is not MERGED and has no opportunity that is
-- still on the board (archived_at IS NULL — an archived record was taken off as a typo or a
-- duplicate and is not a fact about the company), open one at NEW:
--   · dated to the company's own created_at, so the stage clock does not start today for a deal
--     the firm has been sitting on since August;
--   · source_channel from the `via` the identity.company_created event recorded (EMAIL, SCOUT,
--     NETWORK_OS, MANUAL), lower-cased, suffixed `:backfill` — so an emailed one still wears the
--     board's "by email · not yet looked at" badge, which keys on the `email:` prefix — and plain
--     'backfill' when no event says how it came in;
--   · created_by 'migration:0197', because nobody at the firm decided anything here;
--   · an event on the spine saying why, per row, so the company's history explains the deal.
--
-- Plain INSERT … SELECT, never INSERT OR IGNORE: a CHECK or foreign key that swallows a row would
-- leave exactly the state this migration exists to end, with the migration reporting success.

INSERT INTO investment_opportunity
  (id, company_id, opportunity_type, title, status, source_channel, terms_json, privacy_label,
   relationship_origin, firm_scope, created_by, placeholder_fields, created_at)
SELECT
  'opp_0197_' || substr(c.id, 4),
  c.id,
  'EARLY_STAGE_PRIMARY',
  c.canonical_name,
  'NEW',
  COALESCE(
    (SELECT lower(json_extract(e.payload_json, '$.via')) || ':backfill'
       FROM event_record e
      WHERE e.event_type = 'identity.company_created' AND e.object_id = c.id
        AND json_extract(e.payload_json, '$.via') IS NOT NULL
      ORDER BY e.created_at LIMIT 1),
    'backfill'),
  '{}',
  c.privacy_label,
  'UNRECORDED',
  c.firm_scope,
  'migration:0197',
  '[]',
  c.created_at
FROM canonical_company c
WHERE c.status <> 'MERGED'
  AND NOT EXISTS (
    SELECT 1 FROM investment_opportunity o
     WHERE o.company_id = c.id AND o.archived_at IS NULL
  );

-- WHY, ON THE SPINE, ONE EVENT PER ROW OPENED. The id is derived from the opportunity id, and the
-- NOT EXISTS makes a re-apply write nothing rather than collide — the opportunity insert above is
-- already a no-op the second time, since every company it matched now has a row on the board.
INSERT INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json)
SELECT
  'evt_0197_' || substr(o.id, 10),
  'investment.opportunity_created',
  'system',
  'migration:0197',
  'investment_opportunity',
  o.id,
  o.firm_scope,
  json_object(
    'company_id', o.company_id,
    'opportunity_type', o.opportunity_type,
    'title', o.title,
    'backfilled_by', '0197_every_company_is_in_the_pipeline',
    'why', 'Every company in the system is in the pipeline (owner, 18 Sep 2026). This company was on record with no opportunity on the board, so one was opened at the top of the funnel, dated to when the company arrived.'
  )
FROM investment_opportunity o
WHERE o.created_by = 'migration:0197'
  AND NOT EXISTS (SELECT 1 FROM event_record e WHERE e.id = 'evt_0197_' || substr(o.id, 10));

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0197_every_company_is_in_the_pipeline');
