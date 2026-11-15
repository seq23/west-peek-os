-- 0309 · THE FIRST READ'S BRIEF (15 Nov 2026, west-peek-ventures brain: "Every partner email to os@ gets a first read
-- by Claude…" and "Out of Claude usage never stops partner mail").
--
-- Every partner email gets a first read that writes a brief onto the card: every ask in his words (partner_ask rows,
-- 0306, unchanged), his holds, and his files with what each is for. The holds and files ride on the email's
-- partner_understood row beside the asks; `reader` names who read it (CLAUDE, CODEX, WORKERS_AI, GEMINI, or OS when no
-- reader was free and the OS's own read was used). Every employee's input carries the same brief (`briefBlockFor`).
--
-- Additive: two new nullable columns. Nothing is rewritten.
ALTER TABLE partner_understood ADD COLUMN brief_json TEXT;
ALTER TABLE partner_understood ADD COLUMN reader TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0309_the_first_read_brief');
