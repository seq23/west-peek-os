-- 0031_ai_workspace_access.sql — P36: Revoke All (V1 #27, canon §9.6.2E).
--
-- WHY THIS IS A STATE AND NOT A BULK DELETE. The obvious implementation of "Revoke All AI
-- Employees" is to release every seated employee. That is wrong, and canon says why in one line:
-- "AI access resumes only if an authorized human re-grants access." A bulk release leaves the room
-- in exactly the state it was in before anyone was seated — so the next person to open the Live
-- Help picker can seat someone straight back in, and the revocation silently expired.
--
-- So revocation is a LATCH on the meeting. While it is held:
--   · no AI employee can be seated,
--   · no AI employee can answer in the room,
--   · the close-out cannot run extraction over the room's notes.
-- Humans keep taking notes exactly as before. Canon §9.6.2E lists those five prohibitions; each one
-- is enforced at its own entry point rather than trusted to the UI hiding a button.
--
-- WHAT THE AUDIT MUST CAPTURE, verbatim from §9.6.2E: who revoked access, when, which AI employees
-- were affected, and what access was removed. "Which employees" is the part a bulk delete destroys
-- — once the seats are gone there is no record of who had been in the room. So the revocation
-- event carries the affected list, captured before the seats are cleared.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0031_ai_workspace_access');

ALTER TABLE meeting ADD COLUMN ai_access_state TEXT NOT NULL DEFAULT 'GRANTED'
  CHECK (ai_access_state IN ('GRANTED','REVOKED'));

ALTER TABLE meeting ADD COLUMN ai_access_changed_by TEXT REFERENCES firm_user (id);
ALTER TABLE meeting ADD COLUMN ai_access_changed_at TEXT;
-- Free text: the operator may say why they pulled AI out of the room, and that reason is often the
-- most useful thing in the audit trail six months later.
ALTER TABLE meeting ADD COLUMN ai_access_note TEXT;
