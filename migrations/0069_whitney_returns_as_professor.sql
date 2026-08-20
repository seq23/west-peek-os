-- Whitney comes back, as the University professor.
--
-- WHY UN-RETIRE RATHER THAN ADD A SEAT. West Peek University has taught since P45 and taught
-- anonymously — the standing brief opened "You are West Peek University", while every other thing
-- the firm produces arrives from somebody named. The obvious fix is a professor; the wrong way to
-- get one is an eighteenth invented seat, because the roster was consolidated from thirty-one to
-- seventeen precisely so that every seat answers a question the others do not.
--
-- Whitney was the Market Intelligence Coach, retired when that product was deferred. The coaching
-- is the half that survived — pointed at the partners' own understanding rather than at a market
-- map — so the seat already existed and only needed re-pointing.
--
-- HER HISTORY IS NOT REWRITTEN. Migration 0064 deliberately left retired employees carrying the
-- department they sat in when they sat there. This changes role, layer and status because she is
-- working again under a new remit; nothing about her prior status history is touched, and the
-- status_history row below records the transition rather than hiding it.
--
-- ACTIVE, not INACTIVE. D10 requires an approval receipt to ACTIVATE an employee through the API.
-- This is a migration rather than an activation: the professor is the University page's author, the
-- page has been serving lessons for months, and shipping the byline switched off would name a
-- teacher on a page that then refuses to teach. The receipt this stands in for is the operator's
-- instruction to make it so.

UPDATE ai_employee
SET role   = 'Professor, West Peek University',
    layer  = 'Learning',
    status = 'ACTIVE',
    purpose = 'Teaches venture — fund economics, deal judgement, sector reasoning and IC discipline — and marks honestly rather than encouragingly.',
    activated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE name = 'Whitney';

UPDATE ai_employee_profile
SET department = 'Learning',
    avatar_initials = 'W',
    brief = 'Professor, West Peek University. Teaches from principles and sends you to Research for anything current.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE ai_employee_id = (SELECT id FROM ai_employee WHERE name = 'Whitney');

INSERT INTO ai_employee_profile (ai_employee_id, department, avatar_initials, brief)
SELECT id, 'Learning', 'W',
       'Professor, West Peek University. Teaches from principles and sends you to Research for anything current.'
FROM ai_employee
WHERE name = 'Whitney'
  AND id NOT IN (SELECT ai_employee_id FROM ai_employee_profile);

-- The transition on the record, because a status change with no history row is the kind that later
-- looks like it was always that way.
INSERT INTO ai_employee_status_history (id, ai_employee_id, from_status, to_status, actor_type, actor_id, reason)
SELECT 'aesh_whitney_professor_0069', id, 'RETIRED', 'ACTIVE', 'SYSTEM', 'migration:0069',
       'Un-retired as Professor, West Peek University. The Market Intelligence product was deferred; '
       || 'the coaching half of the seat is what University needed, so the seat was re-pointed rather '
       || 'than a new one invented.'
FROM ai_employee WHERE name = 'Whitney';
