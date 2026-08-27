-- 0145 — 0144 gave Scooter `portfolio_risk` twice.
--
-- MY OWN COMMENT WAS STRICTER THAN MY CODE, which is the exact defect this repo keeps producing and
-- which I had spent the day removing from other people's work. 0144 said:
--
--   "json_insert leaves an existing path alone, so a partner who already has one does not get it
--    twice."
--
-- `json_insert` skips an insert when the PATH already exists. `$[#]` is the append path and it never
-- exists, so every value was appended unconditionally. Sequoia's layout did not contain
-- `portfolio_risk` and came out right; Scooter's did, and came out with it twice — his Home would
-- render the same module in two places.
--
-- The guard also has to be on the VALUE, not on the array. This rebuilds each partner's list as a
-- new version, keeping first-appearance order and dropping any repeat — so the fix works whatever
-- shape a layout is in rather than only for the two rows that are wrong today.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0145_a_home_module_appears_once');

INSERT INTO mp_home_preference (id, firm_user_id, version_no, modules_json, briefing_json, set_by, firm_scope)
SELECT
  'mphp_0145_' || p.firm_user_id,
  p.firm_user_id,
  (SELECT MAX(version_no) + 1 FROM mp_home_preference m WHERE m.firm_user_id = p.firm_user_id),
  (
    SELECT json_group_array(value)
    FROM (
      SELECT j.value AS value, MIN(j.key) AS first_at
      FROM json_each(p.modules_json) AS j
      GROUP BY j.value
      ORDER BY first_at
    )
  ),
  p.briefing_json,
  'migration:0145',
  p.firm_scope
FROM mp_home_preference p
WHERE p.version_no = (SELECT MAX(version_no) FROM mp_home_preference m WHERE m.firm_user_id = p.firm_user_id)
  -- Only where a value actually repeats. A layout that is already clean is left entirely alone.
  AND (SELECT COUNT(*) FROM json_each(p.modules_json)) >
      (SELECT COUNT(DISTINCT value) FROM json_each(p.modules_json));
