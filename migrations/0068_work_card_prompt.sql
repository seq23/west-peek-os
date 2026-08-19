-- An optional instruction to whoever works the card.
--
-- The employee loop builds its own prompt from the title, the next action and what has happened so
-- far — which is right as a default and wrong as a ceiling. A partner often knows something that
-- shapes HOW the work should be done and has nowhere to put it: which sources to trust, what to
-- ignore, what a good answer looks like, a constraint the title cannot carry without becoming a
-- paragraph.
--
-- Optional on purpose. A card with no prompt behaves exactly as before, so this adds a way to say
-- more without making anybody say more.
ALTER TABLE work_card ADD COLUMN prompt TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0068_work_card_prompt');
