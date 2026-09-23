-- 0237 — Every card asks for its missing materials, and a reply's files reach the next run (owner, 23 Sep 2026).
--
-- HER QUESTION: "is he going to send me a list of missing materials and ask me to upload them?"
-- And then: "all agents do it this way, not just Porter." Two facts every card can now carry:
--
--   1 · `work_card.missing_materials_json` — what the work still needs from the requester, as
--       [{ item, where }]: the thing, and where it goes. ONE list per card, written by whichever
--       employee's run found the gap (Porter's plan and rebuild, or any employee that blocks on a
--       file), and read by ONE renderer (`shared/work/missingMaterials.ts`) into every ask, preview
--       and finished email, so no two components each keep their own copy.
--   2 · `request_attachment.source` — REQUEST (the opening email, 0221) or REPLY (a requester's
--       reply on the card's own thread). A reply's files were dropped until today: the thread door
--       read the text and threw the MIME away. They are kept by the same mechanism the door uses —
--       a name against the card, extracted on demand from the stored .eml — so the card's next run,
--       whatever its kind, is handed them.

ALTER TABLE work_card ADD COLUMN missing_materials_json TEXT NOT NULL DEFAULT '[]';
-- 3 · `web_property_change.assets_json` — the Drive assets the approved plan will use, by manifest
--     path. Drive is MAPPED, never downloaded whole (owner, 23 Sep 2026: a 14.6 GB recording hung the
--     whole-folder pull); BUILD fetches exactly these, on the model's behalf, from any Mac.
ALTER TABLE web_property_change ADD COLUMN assets_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE request_attachment ADD COLUMN source TEXT NOT NULL DEFAULT 'REQUEST' CHECK (source IN ('REQUEST', 'REPLY'));

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0237_every_card_asks_for_its_missing_materials');
