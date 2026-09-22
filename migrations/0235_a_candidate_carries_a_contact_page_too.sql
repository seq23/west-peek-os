-- 0235 — a hire-search candidate carries a contact method too, when one has a page behind it (22 Sep 2026).
--
-- Sequoia told Walker, via a recovered partner email and `work_steer`, to always attempt a
-- legitimate contact-email lookup for reported candidates going forward. `steerFor` correctly held
-- that against `HIRE_SEARCH_STEPS` (services/productionsHire.ts), found nothing declared there
-- covers it, and correctly blocked rather than guessing — the block on the manually-created card
-- `wc_hire_followup_20260922` is that working as designed. The fix widens the declared job itself
-- (HIRE_CONTACT_RULE, now in HIRE_SEARCH_STEPS and in the search prompt) rather than bolting on a
-- second, separate lookup call — the same search Walker already runs now also looks for this.
--
-- Two columns, additive, both nullable: a row written before this migration reads as "not checked
-- yet", which is honest — nothing claims a contact method was looked for on a candidate found
-- before this shipped. A row written after always carries one of two true states: a page-backed
-- email, or an explicit "none found" (the code path always sets one or leaves both null; the note
-- says which). `email` is kept only alongside `contact_url` — the same rule
-- `services/productions.ts` already applies to press-pitch contacts: an address with no page is a
-- guess and is discarded before it ever reaches this table.

ALTER TABLE productions_candidate ADD COLUMN email TEXT;
ALTER TABLE productions_candidate ADD COLUMN contact_url TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0235_a_candidate_carries_a_contact_page_too');
