-- 0029_community_overlay_correction.sql — P33 correction: Community OS is an overlay, not a roster.
--
-- WHAT WENT WRONG IN 0028. `com_member` was built as a membership roster: name, type, status. Canon
-- §12A.2 gives the membership record to NETWORK OS — person records, contact fields, and
-- explicitly "community membership fields". Storing the roster here created a second source of
-- truth for who is a member, which §0E.4 forbids and which 0028's own header warned against.
--
-- WHAT COMMUNITY OS ACTUALLY OWNS (§12A.4) is interpretation over that population:
-- segmentation, engagement intelligence, founder/investor/operator grouping, contribution
-- patterns, community-to-deal and community-to-portfolio-support signals, programming
-- opportunities, ambassador/scout potential, and LP proof candidates.
--
-- AND HOW IT DIFFERS FROM RELATIONSHIP OS (§12A.3): Relationship OS reasons about ONE relationship
-- — why it matters, the warm path, the next move, the promise made. Community OS reasons about the
-- POPULATION — which segment is going quiet, who is behaving like a scout. Same people, different
-- unit of analysis. Neither owns the contact record.
--
-- THE FIX, kept small because this is scaffolding: the row stays, its MEANING changes. It is now an
-- interpretation attached to a person, and the columns say so. `display_name` survives only as a
-- cache for display before Network OS resolution, and is documented as non-authoritative.
--
-- Not renaming the table: it is one release old, unreferenced by any other table, and a rename
-- would cost a rebuild for no behavioural gain. The columns and the UI carry the correction.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0029_community_overlay_correction');

-- Which segment the firm has placed this person in. Community OS's own judgement — this is the
-- thing §12A.4 actually owns.
ALTER TABLE com_member ADD COLUMN segment TEXT NOT NULL DEFAULT 'UNSEGMENTED'
  CHECK (segment IN ('UNSEGMENTED','CORE','CONTRIBUTOR','AMBASSADOR','SCOUT','LAPSING','OBSERVER'));

-- Engagement read, stated as a level rather than a score: a number implies a precision the firm
-- cannot currently evidence, and canon §28.4 bans vanity metrics.
ALTER TABLE com_member ADD COLUMN engagement TEXT NOT NULL DEFAULT 'UNKNOWN'
  CHECK (engagement IN ('UNKNOWN','HIGH','STEADY','FADING','DORMANT'));

-- What this person's community behaviour suggests for the firm — sourcing, portfolio support,
-- programming, or LP proof. Free text while the signal taxonomy is still unproven.
ALTER TABLE com_member ADD COLUMN signal_note TEXT;

-- Provenance of the underlying membership. NETWORK_OS once the live pull works; LOCAL_UNRESOLVED
-- while it does not, so a reader can always tell whether the person behind this interpretation has
-- been reconciled to the canonical record yet.
ALTER TABLE com_member ADD COLUMN membership_source TEXT NOT NULL DEFAULT 'LOCAL_UNRESOLVED'
  CHECK (membership_source IN ('NETWORK_OS','LOCAL_UNRESOLVED'));
