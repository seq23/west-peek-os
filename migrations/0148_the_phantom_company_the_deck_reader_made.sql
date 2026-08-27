-- 0148 — Retiring "Sensori Deck", a company that only exists because of a bug.
--
-- On 23 Aug 2026 the deck reader matched an emailed deck on its WHOLE subject line. Scooter's
-- message read "Sensori Deck"; `sensori deck` is not `sensori`; so instead of finding the Sensori
-- that had been on the board since 18 Aug, it created a second company named after the subject.
-- Operator: "just get rid of the phantom company."
--
-- RETIRED, NOT DELETED, and the distinction is the whole reason this is a migration rather than a
-- DELETE. One event on the spine references this id. Deleting the row would leave an event pointing
-- at nothing — erasing the record of the mistake along with the mistake, which is exactly what the
-- append-only spine exists to prevent. `status = 'MERGED'` is the same retirement a real merge
-- writes, and `handleListCompanies` now excludes it from the register while `?status=MERGED` still
-- returns it.
--
-- NO MERGE RECEIPT IS WRITTEN, deliberately. A real merge is MP-reserved and receipt-gated, and
-- `identity_merge_receipt` records which approval card authorised it. Nothing here was approved
-- through that path, and fabricating a receipt to make the row look properly merged would put a
-- false authorisation on the record — a worse defect than the phantom it tidies. This is a data
-- correction, attributed as one.
--
-- THE ALIAS IS THE USEFUL PART. "Sensori Deck" now resolves to the real Sensori, so the next message
-- with that subject lands on the right company even from a client that has not been updated.
--
-- EVERY STATEMENT IS GUARDED ON THE ROWS EXISTING, and the first version was not. It named two
-- production company ids outright, so on a fresh database — every test run, every new environment —
-- the alias insert hit a foreign key that could not resolve and took SIXTY test files down with it.
-- A migration that only works where the rows happen to exist is not a migration. Caught by the suite
-- within a minute, which is the whole argument for replaying migrations in tests.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0148_the_phantom_company_the_deck_reader_made');

UPDATE canonical_company
   SET status = 'MERGED'
 WHERE id = 'cc_e671b08b-c129-4d70-ade1-4fafc0394848'
   AND canonical_name = 'Sensori Deck';

INSERT INTO company_alias (id, company_id, alias)
SELECT 'ca_0148_sensori_deck', c.id, 'Sensori Deck'
  FROM canonical_company c
 WHERE c.id = 'cc_167f3ea9-37a9-40b8-942a-95a82faf2d21'
   AND NOT EXISTS (SELECT 1 FROM company_alias WHERE alias = 'Sensori Deck');
