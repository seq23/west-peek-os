-- 0301 — The developer may direct any job (owner ruling, 13 Nov 2026, #363).
--
-- Her words: "i like the safety rule but i should have a developer role that bypasses it" and "i
-- should be able to direct any job as the developer host of west peek os."
--
-- The safety rule stays exactly as it is (0241): only the partner who asked for a job may change it.
-- This adds ONE role, DEVELOPER, held by the owner. A "changes: …" work instruction from the developer
-- is accepted on any job, whoever asked for it, in the OS, by email reply, or entered on her behalf
-- by her partner tail through the Mac's own identity (recorded as such). It covers work instructions
-- ONLY: approving a plan or a preview, publish, land, force, sending outside the firm and spending
-- still take the signed-in partner the OS already requires (`src/worker/services/developerDirection.ts`,
-- tests/developerDirection.test.ts).
--
-- The role is granted here and nowhere else. No route, job or script grants it.

INSERT OR IGNORE INTO role (id, key, name) VALUES ('role_developer', 'DEVELOPER', 'Developer');
INSERT OR IGNORE INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_sequoia_taylor', 'role_developer');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0301_the_developer_directs_any_job');
