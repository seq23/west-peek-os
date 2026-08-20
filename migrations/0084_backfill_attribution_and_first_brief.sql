-- Backfill: attribute the runs that already happened, and file the brief that already exists.
--
-- Two fixes landed today that only applied FORWARD, which is not what somebody looking at the pages
-- experiences. The operator's reading was "did this regress already" — fair, because from the
-- outside a fix that changes nothing you can see is indistinguishable from no fix.
--
-- ONE: every machine still read zero. `ai_run_attribution.machine_id` was NULL in all 64 rows,
-- because the only caller that ever set it is the work-packet flow, which has never been used.
-- Employee work and the brief now name their machine — but nothing rewrote history, so the
-- Machines page kept showing the same zeros it always had.
--
-- The mapping below is INFERENCE FROM PURPOSE, and it is worth being plain about that: these runs
-- were not attributed at the time, so this is a reading of what they were for rather than a record
-- of it. Every pattern is one this system generates itself, so the reading is a safe one — but
-- anything that does not match is deliberately left NULL rather than guessed into a bucket. A
-- governance evaluation and a credential-scrubber probe genuinely belong to no department.
--
-- TWO: Home has a "Prepared for you" section and the morning brief was not in it, which the
-- operator noticed immediately. One brief is READY and no deliverable exists for it, because
-- deliverables were built after it was delivered — and because `deliver()` threw on every call
-- until the ON CONFLICT fix. The brief is filed here from its own sections, signed by the reader's
-- Chief of Staff, exactly as a new one would be.

-- ── One: attribution ──
UPDATE ai_run_attribution SET machine_id = 23
 WHERE machine_id IS NULL
   AND ai_run_id IN (
     SELECT id FROM ai_run
      WHERE purpose LIKE 'daily intelligence report%'
         OR purpose LIKE 'daily market levels%'
         OR purpose LIKE 'daily brief synthesis%'
         OR purpose LIKE 'Wyatt working%'
         OR purpose LIKE 'live research search%'
   );

UPDATE ai_run_attribution SET machine_id = 1
 WHERE machine_id IS NULL
   AND ai_run_id IN (SELECT id FROM ai_run WHERE purpose LIKE 'weekly review%');

UPDATE ai_run_attribution SET machine_id = 42
 WHERE machine_id IS NULL
   AND ai_run_id IN (SELECT id FROM ai_run WHERE purpose LIKE 'drafting a work card%');

-- Wyatt did the work; the runs said so in their purpose and the column stayed empty.
UPDATE ai_run SET ai_employee_id = 'aie_wyatt'
 WHERE ai_employee_id IS NULL AND purpose LIKE 'Wyatt working%';

-- ── Two: file the brief that already exists ──
INSERT INTO deliverable (id, kind, title, body, prepared_by, prepared_for, source_type, source_id, privacy_label, firm_scope)
SELECT
  'dlv_backfill_' || r.id,
  'daily_brief',
  'Morning brief — ' || r.report_date,
  (SELECT group_concat('## ' || s.heading || char(10) || char(10) || s.body_md, char(10) || char(10))
     FROM intelligence_report_section s WHERE s.report_id = r.id),
  -- Signed by the reader's own Chief of Staff, the same rule the live path applies.
  CASE WHEN lower(u.full_name) LIKE 'scooter%' THEN 'Walker' ELSE 'Wren' END,
  r.firm_user_id,
  'intelligence_report',
  r.id,
  'INTERNAL',
  r.firm_scope
FROM intelligence_report r
JOIN firm_user u ON u.id = r.firm_user_id
WHERE r.status = 'READY'
  AND EXISTS (SELECT 1 FROM intelligence_report_section s WHERE s.report_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM deliverable d WHERE d.source_type = 'intelligence_report' AND d.source_id = r.id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0084_backfill_attribution_and_first_brief');
