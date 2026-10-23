-- 0267_tlc_playbook_title_is_version_2.sql — owner, 23 Oct 2026.
--
-- The Learning Club playbook sat on Documents titled "The Learning Club Playbook (owner-approved,
-- 22 Oct 2026)". It is NOT approved, and version 2 was uploaded on 23 Oct 2026. The title is
-- corrected on that one row only, matched on its id AND the wrong wording, so a later rename is
-- never overwritten. No version, no bytes and no other row changes. Additive: nothing is deleted.
-- Its shelf group (Playbooks & plans) is derived from the title in src/shared/documents/shelf.ts.
UPDATE document
   SET title = 'The Learning Club Playbook (version 2, 23 Oct 2026)'
 WHERE id = 'doc_tlc_playbook'
   AND title LIKE '%owner-approved%';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0267_tlc_playbook_title_is_version_2');
