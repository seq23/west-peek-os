-- 0222 — "the site" means the one you had me on this morning (owner, 21 Sep 2026).
--
-- Scooter's second email opened "Hey Porter!" and asked for a newsletter signup "on the site" —
-- no host named. The door read it as blog help (the word "newsletter"), then as nothing, and the
-- chief of staff's general loop tried to browse and emailed him a permission block. Now: a request
-- addressed to Porter that says "the site" is a web property change whose host is INFERRED from
-- this partner's most recent web-property card in the last seven days; the RECEIVED email states
-- the assumption ("I'm reading 'the site' as westpeek.ventures — reply if not"), and Porter asks
-- only when there is nothing recent to infer from.
ALTER TABLE web_property_change ADD COLUMN property_assumed_from TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0222_the_site_means_the_one_you_had_me_on');
