-- 0243 — Proposing a person to Network OS is RESTRICTED, not an approval-gated external effect (27 Sep 2026).
--
-- WHY. `network_os.propose_person` was seeded with is_external_effect = 1, and authorize() answers
-- REQUIRE_APPROVAL for every external effect until an approval receipt is presented. The proposal
-- handler treated anything but ALLOW as 403. So the "Send to Network OS" button on the Network page
-- could never have sent anybody: production on 27 Sep 2026 held 0 network.person_proposed events,
-- 5 captures all archived unresolved, and 4,715 synced contacts with 0 linked to a person.
--
-- WHAT WAS MEANT (the registry comment, unchanged since the key was added): the far end's intake
-- queue is the review — a human in Network OS decides whether the person becomes a contact — so an
-- approval card here would be ceremony in front of every captured business card. A human acts at
-- once; an AI actor is refused; every send is an event. That is the RESTRICTED tier.
--
-- WHAT THIS DOES. Flips the flag on the row every applied database already holds (0003/0100 are
-- INSERT OR IGNORE, so regenerating them reaches new databases only), and names who may act.
-- Capture is resolved by whoever met the person, so the roles are the ones that work captures.

UPDATE action_type SET is_external_effect = 0 WHERE key = 'network_os.propose_person';

INSERT OR IGNORE INTO restricted_action (key, description, allowed_json) VALUES
  ('network_os.propose_person',
   'Propose a captured person to Network OS''s intake queue. A human there decides; this never writes a contact. Humans in the named roles act at once, an AI actor is refused.',
   '{"roles":["MANAGING_PARTNER","INVESTMENT_TEAM","OPERATIONS"],"employees":[]}');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0243_proposing_a_person_is_restricted_not_an_external_effect');
