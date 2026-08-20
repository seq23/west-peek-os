-- A read-only identity for the firm's own browser.
--
-- WHY. Percy reviews interfaces from screenshots, and the one set of pages he could not look at was
-- West Peek's own: os.joinwestpeek.com sits behind Cloudflare Access, so a browser task pointed at
-- it got a login screen. The same gap meant every interface change this session was written by
-- somebody who had never seen it render — which is exactly how a card title ended up rendering
-- outside its own card, and why the operator has had to be the eyes all day.
--
-- A service token gets PAST Access. It does not carry a human identity, so the application's own
-- auth still answered 401 — correctly, because `resolveFirmUser` requires a known firm_user. This
-- row is that firm_user, and it is deliberately the weakest principal in the system.
--
-- WHAT IT CAN DO: read pages that are not privacy-sensitive.
--
-- WHAT IT CANNOT DO. None of this is convention; it is the existing machinery, applied:
--   * NO ROLES. `authorize()` denies every human-reserved action to an actor without the approver
--     role, so it cannot approve, activate an employee, change policy or decide anything.
--   * Not a Managing Partner, so `canAccessPrivacyLabel` filters RESTRICTED, LP_PRIVATE,
--     CONFIDENTIAL, MNPI_SENSITIVE and BANKING_RESTRICTED out of everything it reads.
--   * Seated on no machine and owning no work, so nothing routes to it.
--   * `requireHuman()` refuses it any lifecycle change — it is a HUMAN row by table, but it holds
--     no role, and every one of those paths checks the role rather than the row.
--
-- THE HONEST RISK, stated because a control whose cost is not written down stops being reviewed:
-- anyone holding the service token can read this firm's non-sensitive records. The token lives in
-- the encrypted vault and in Worker secret storage. REVOCATION IS ONE API CALL — delete the token
-- in Cloudflare Access and this identity is inert immediately, with no deploy and no code change.
-- That reversibility is the whole reason this is a token rather than a password.

INSERT OR IGNORE INTO firm_user (id, email, full_name, status)
VALUES ('fu_browser_agent', 'browser-agent@westpeek.ventures', 'West Peek browser', 'ACTIVE');

-- Deliberately NO firm_user_role rows. The absence is the control.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0085_browser_agent_identity');
