-- 0149 — Removing the "Sensori Deck" alias, because the deck decides the name now.
--
-- `0148` aliased "Sensori Deck" to Sensori so that subject would find the right company. Operator,
-- reading it: "why do u have to alias sensori deck to sensori? shouldnt the deck itself be the
-- deciding factor on what the name is?"
--
-- She is right, and the alias was a patch on a symptom. She had already told me "the subjects will
-- all be different", which is exactly why aliasing one subject STRING is close to useless: it helps
-- only if that same subject arrives again, and the next one reads "Sensori deck v3".
--
-- `deckReader` now extracts the company's own name for itself, and `deckQueue` reads the deck BEFORE
-- deciding who it belongs to. "Sensori Deck" fails to match, the deck says "Sensori", and the lookup
-- on that finds the company already on the board — no word list, no alias, and it works for every
-- subject shape rather than the ones I happened to think of.
--
-- The alias is removed rather than left as harmless clutter, because it encodes a wrong idea: that
-- an email subject is a name a company goes by. Aliases are how the firm records that a company is
-- ALSO known as something; "Sensori Deck" is not a name anybody knows Sensori by.
--
-- Aliases the DECK proposes are a different thing entirely and are kept: those come from the company
-- itself, and each one raises a card asking whether the register should be renamed to match.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0149_the_deck_names_the_company');

DELETE FROM company_alias WHERE id = 'ca_0148_sensori_deck';
