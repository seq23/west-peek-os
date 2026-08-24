-- 0142 — The Integrations page was describing a Network OS that no longer exists.
--
-- WHAT IT SAID, read in production 22 Aug 2026: "Not set up · reads only", "NETWORK_OS_API_TOKEN is
-- not populated in this environment", and "No client is configured, so live calls fail closed."
--
-- WHAT IS TRUE: the client is written (effects/networkOsClient.ts), it authenticates by minting the
-- same signed wpn_session Network OS issues to a browser, it pulls contacts/events/touches, and it
-- proposes people into Network OS's intake queue. It is configured in production and it works.
--
-- NETWORK_OS_API_TOKEN never existed. Not in wrangler.toml, not in the vault, not in env.ts, not in
-- any line of code — it was a design-time placeholder written in 0021 when Network OS was still a
-- hypothesis, and nothing updated it when the real thing landed. So the status surface was checking
-- for a credential that could never be present and reporting its absence forever.
--
-- The lesson is the one this repo keeps relearning: a row that DESCRIBES a system is a second
-- source of truth and will drift from the system. The code half of this fix stops deriving Network
-- OS's status from this row at all — it now reads env and asks the far end. What stays here is only
-- the part a table is actually good for: what it owns, which way it goes, and what stands in front.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0142_the_integrations_page_told_the_truth_about_network_os');

UPDATE connector SET
  direction = 'BIDIRECTIONAL',
  credential_name = 'WP_OS_NETWORK_OS_SESSION_SECRET',
  scopes_json = '["contacts:read","relationships:read","events:read","intake:propose"]',
  approval_gate = 'a pull is gated on network_sync.pull; proposing a person is gated on network_os.propose_person; writing to a contact record stays MP-reserved under network_os.writeback',
  owns = 'Contacts, relationships, touches, and Gmail-derived relationship truth. Network OS is authoritative for its own domain and West Peek OS never mirrors it. West Peek OS can propose a new person into Network OS''s intake queue, where a human over there decides.',
  detail = 'Live. West Peek OS mints a Network OS session to read its snapshot, and proposes new people into its intake queue rather than writing contacts directly.'
WHERE connector_key = 'network_os';
