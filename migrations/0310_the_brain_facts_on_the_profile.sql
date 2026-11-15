-- 0310 · THE BRAIN'S SETTLED FACTS, ON THE PARTNER PROFILE (15 Nov 2026).
--
-- The first read was flagging what the business already settled ("west Peek productions and top barz are diff
-- entities why would anything re top barz be unclear?"). The west-peek brain lives in Boss OS; the Worker does not
-- read it. The Mac does: its local-jobs claimer extracts the brain's `## Partners` and `## Businesses and projects`
-- sections and the word lookup from ~/Brains/west-peek.md (private spans removed) and writes them here through the
-- existing POST /api/partner-profiles/:email route, as the Mac's own identity. The first read then passes the sender's
-- own section, the card's business section(s) and the lookup to its reader, whole.
--
-- Additive: two new nullable columns. Nothing is rewritten.
ALTER TABLE partner_profile ADD COLUMN brain_md TEXT;
ALTER TABLE partner_profile ADD COLUMN brain_synced_at TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0310_the_brain_facts_on_the_profile');
