-- The operator changes the rota, and the default stays the default.
--
-- Operator, 22 Aug 2026: "what is dutyroster's flow? i want a default flow and one that i can
-- change in the admin section ---i should be able to adj hours for an employee"
--
-- ONLY THE DIFFERENCES LIVE HERE. `src/shared/workforce/dutyRoster.ts` holds the rota, and its own
-- docstring is the reason this table is shaped the way it is: "a second roster is a second source
-- of truth". Copying SHIFT_PREFERENCE into D1 would have produced exactly that — two rotas able to
-- disagree with no way to tell which is wrong — so this table stores DIFFERENCES from the code
-- default and nothing else. The code default keeps its hand-written reasons, a newly seated
-- employee inherits a sensible shift with nobody remembering to add them, the page can say "this is
-- the default" against "you changed this", and REVERTING IS DELETING A ROW rather than restoring a
-- remembered value — which is the failure mode of every save-the-old-value design.
--
-- WHY THIS TABLE IS DELETABLE when almost nothing else in this system is. The history of the rota
-- is not in this table; it is on the event spine (duty.override_set / duty.override_cleared), which
-- IS append-only. This table is the CURRENT difference, and a difference that has been reverted is
-- not a smaller difference, it is no difference at all. Keeping a tombstone here would mean the
-- resolver had to know which rows are dead, which is precisely the "three sources silently
-- competing" the module warns about.
--
-- TWO KINDS, BOTH PER EMPLOYEE, and the CHECK below makes them genuinely exclusive rather than
-- conventionally so:
--   SHIFT — on or off for one named shift. The common case. "Wyatt is not on Overnight."
--   HOURS — an explicit local from/to that supersedes the shift model for that person entirely.
--           This is the operator's "adj hours for an employee": Wyatt available 6am to 8pm however
--           the firm happens to divide its day. Precedence (HOURS over SHIFT over the code default)
--           is stated once, in DUTY_PRECEDENCE, and read once by the resolver.
--
-- WHO, WHEN, AND WHY ARE NOT NULLABLE. Same rule as every other authority change here: a rota that
-- changed for reasons nobody recorded cannot be reviewed later, and "who moved Wyatt off overnight"
-- is exactly the question somebody asks three weeks afterwards.
CREATE TABLE IF NOT EXISTS duty_override (
  id            TEXT PRIMARY KEY,
  -- By NAME, not by id. `ai_employee.name` is UNIQUE, so this is a real foreign key and an override
  -- can never point at somebody who does not exist; and the pure resolver is keyed by name, so no
  -- translation table sits between the record and the rota.
  employee_name TEXT NOT NULL REFERENCES ai_employee (name),
  kind          TEXT NOT NULL CHECK (kind IN ('SHIFT','HOURS')),
  -- SHIFT only. The four shift keys are the ones SHIFTS declares; they are never shown raw.
  shift_key     TEXT CHECK (shift_key IN ('MORNING','MIDDAY','EVENING','OVERNIGHT')),
  on_duty       INTEGER CHECK (on_duty IN (0,1)),
  -- HOURS only, local 24h. to_hour below from_hour is a window that wraps midnight, which is a
  -- legitimate thing to want and is why these are not ordered.
  from_hour     INTEGER CHECK (from_hour BETWEEN 0 AND 23),
  to_hour       INTEGER CHECK (to_hour BETWEEN 0 AND 23),
  reason        TEXT NOT NULL CHECK (IFNULL(length(trim(reason)), 0) >= 4),
  set_by        TEXT NOT NULL REFERENCES firm_user (id),
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- The two kinds cannot bleed into each other. A row carrying both a shift verdict and a window
  -- would be a third, undocumented kind of override, and the resolver would have to guess.
  CHECK (
    (kind = 'SHIFT'
       AND shift_key IS NOT NULL AND on_duty IS NOT NULL
       AND from_hour IS NULL AND to_hour IS NULL)
    OR
    (kind = 'HOURS'
       AND shift_key IS NULL AND on_duty IS NULL
       AND from_hour IS NOT NULL AND to_hour IS NOT NULL)
  ),

  -- IFNULL, and it is load-bearing. SQLite PASSES a CHECK that evaluates to NULL — only an explicit
  -- FALSE fails one — so `from_hour <> to_hour` against a NULL from_hour yields NULL and the
  -- constraint silently does not constrain. That exact trap was hit in this repo yesterday. A
  -- window whose ends are equal covers nothing, which is a way of switching somebody off that does
  -- not say so; taking them off each shift is how you say it.
  CHECK (kind <> 'HOURS' OR IFNULL(from_hour <> to_hour, 0))
);

-- One verdict per person per shift, and one window per person. Without these, "Wyatt off Overnight"
-- and "Wyatt on Overnight" could both be true rows and the rota would depend on read order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_override_shift
  ON duty_override (employee_name, shift_key) WHERE kind = 'SHIFT';
CREATE UNIQUE INDEX IF NOT EXISTS idx_duty_override_hours
  ON duty_override (employee_name) WHERE kind = 'HOURS';

-- A row is never edited in place. Every column here is part of one statement — this person, this
-- shift, this reason, set by this partner at this time — and editing any of it would leave today's
-- reason attached to yesterday's decision. Setting an override that already exists replaces the row
-- outright, so the reason and the timestamp always describe the verdict standing beside them.
CREATE TRIGGER IF NOT EXISTS duty_override_is_not_edited
BEFORE UPDATE ON duty_override
BEGIN
  SELECT RAISE(ABORT, 'a duty override is never edited — set it again, or put it back to default');
END;

-- Compensating action-type rows (the P4 convention). These keys are in the TS registry
-- (src/shared/registry/actionTypes.ts) and belong in the generated 0003 seed block, which reaches
-- new databases only; this reaches the database that is already live. Without it authorize()
-- denies the key and the surface 403s in production while every local test passes.
--
-- ON CONFLICT DO NOTHING and not INSERT OR IGNORE: the generator legitimately re-emits the same
-- key, so a duplicate key is a genuine no-op — but OR IGNORE would ALSO swallow a CHECK failure
-- silently, which has shipped a bug in this repo twice. This form ignores exactly one thing.
--
-- TWO KEYS, because they are two authorities. Changing who covers the firm's hours is a decision;
-- putting a shift back to the default the whole system already agrees on is the safe direction, and
-- a control that makes the system do LESS should never be harder to reach than the one that made it
-- do more — the same rule that already governs revoking a standing grant and pausing an employee.
INSERT INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('duty_override.set',
   'Change who is on duty',
   'Put an employee on or off a named shift, or give them explicit working hours that supersede the shift model for them. Stored as a difference from the firm''s default rota, never as a copy of it, and always with who changed it and why.',
   0, 0),
  ('duty_override.clear',
   'Put a duty change back to default',
   'Remove a duty override so the employee follows the firm''s default rota again. The change and its removal both stay on the event spine.',
   0, 0)
ON CONFLICT (key) DO NOTHING;

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0137_the_operator_changes_the_rota');
