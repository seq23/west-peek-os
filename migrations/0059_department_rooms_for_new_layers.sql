-- A room for every department that actually exists.
--
-- Department rooms are DERIVED from `ai_employee.layer` — migration 0014 slugifies the layer into a
-- room key. That is a good shape and it has the same trap as every other generated seed: 0014 has
-- already been applied everywhere, so it never runs again, and the roster v4.0 consolidation renamed
-- every layer. Existing databases are left holding rooms for departments nobody is in
-- ("investment_ic_meeting") and no room for the ones people moved to ("investment").
--
-- So this creates a room for any layer currently on the roster that has none. It reads the layers
-- out of `ai_employee` rather than carrying its own list, which means the next consolidation is
-- covered by re-running the same statement rather than by somebody remembering to write another
-- migration.
--
-- INSERT … SELECT … WHERE NOT EXISTS rather than INSERT OR IGNORE. That idiom has hidden a real
-- constraint failure twice in this repo (BACKLOG, "INSERT OR IGNORE hides constraint failures"):
-- it turns a violation into a silent no-op, and a migration that reports success while writing
-- nothing is the worst outcome available. This form is idempotent AND still fails loudly.
--
-- The slug expression is copied verbatim from 0014 so both produce identical keys; if they ever
-- diverge a database would end up with two rooms for one department.
--
-- Old rooms are deliberately LEFT ALONE. Their messages are append-only by trigger (D15) and the
-- conversations really happened; deleting the room to tidy the list would orphan the record of
-- work that was genuinely done.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0059_department_rooms_for_new_layers');

INSERT INTO department_room (id, room_key, name, department, purpose)
SELECT
  'droom_' || lower(replace(replace(replace(e.layer, ' ', '_'), '/', '_'), '+', 'and')),
  lower(replace(replace(replace(e.layer, ' ', '_'), '/', '_'), '+', 'and')),
  e.layer || ' room',
  e.layer,
  'Governed collaboration for the ' || e.layer || ' department. Every message references work, a run, a handoff, or a firm announcement.'
FROM (SELECT DISTINCT layer FROM ai_employee WHERE status <> 'RETIRED') e
WHERE NOT EXISTS (
  SELECT 1 FROM department_room r
   WHERE r.room_key = lower(replace(replace(replace(e.layer, ' ', '_'), '/', '_'), '+', 'and'))
);
