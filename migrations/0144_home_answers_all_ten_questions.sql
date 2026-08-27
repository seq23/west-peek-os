-- 0144 — Home named ten questions and left four of them unanswered.
--
-- Operator, 23 Aug 2026, reading her own Home: "make sure all the items here have a module", with
-- four of the ten reading "no module enabled for this yet" — what is at risk, what the AI employees
-- are doing, what is costing money, and what is broken.
--
-- Two separate causes, both fixed:
--
-- 1. `DEFAULT_HOME_MODULES` carried seven of the twelve modules, so a partner who never customised
--    anything still got four unanswered questions. Widened in `mpHome.ts`.
--
-- 2. "What is broken?" was answered by RECONCILIATION — places where the firm's figures and the
--    administrator's disagree. That is a money problem, and a real one, but a partner asking what is
--    broken means the system: is the brief running, did anything fail overnight. `health_fault` is
--    what knows that, escalates what persists and announces recoveries — and had no module at all.
--    So the one question with a live checking system behind it was the one Home could not answer,
--    while a module that sounded right occupied the slot. Reconciliation now answers "Where is money
--    or execution at risk?", which is what it genuinely reports.
--
-- THE SAVED LAYOUTS ARE THE OTHER HALF. Both partners have an explicit layout that predates the
-- health module, so widening the default would not have reached either of them. This appends a NEW
-- VERSION per partner rather than editing theirs — `mp_home_preference` refuses UPDATE by trigger,
-- and their chosen order is kept with the missing modules added after it. Reverting is choosing the
-- earlier version, which is the point of versioning it.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0144_home_answers_all_ten_questions');

INSERT INTO mp_home_preference (id, firm_user_id, version_no, modules_json, briefing_json, set_by, firm_scope)
SELECT
  'mphp_0144_' || p.firm_user_id,
  p.firm_user_id,
  (SELECT MAX(version_no) + 1 FROM mp_home_preference m WHERE m.firm_user_id = p.firm_user_id),
  -- Their own order first, then whatever is missing, so nothing they arranged moves.
  json_insert(
    p.modules_json,
    '$[#]', 'portfolio_risk',
    '$[#]', 'employees',
    '$[#]', 'ai_spend',
    '$[#]', 'health'
  ),
  p.briefing_json,
  'migration:0144',
  p.firm_scope
FROM mp_home_preference p
WHERE p.version_no = (SELECT MAX(version_no) FROM mp_home_preference m WHERE m.firm_user_id = p.firm_user_id)
  -- Only where something is actually missing, and only the modules not already there: json_insert
  -- leaves an existing path alone, so a partner who already has one does not get it twice.
  AND EXISTS (
    SELECT 1 WHERE p.modules_json NOT LIKE '%"health"%'
  );
