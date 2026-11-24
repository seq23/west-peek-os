-- 0314 · PRESTON ANSWERS A DECK CHANGE ON THE THREAD THE PARTNER WROTE IT ON (24 Nov 2026).
--
-- Scooter sent his round-1 deck changes as a reply to "Our Fund I deck: a new way we'll finish it".
-- Preston's answer went out under "Re: Fund I deck", the round's newest thread, outside the
-- conversation it answered. The change now keeps the email_thread token it came in on, and the
-- sweep answers there (deckPreview.ts `onTheirThread`).
--
-- Additive: one new nullable column. Nothing is rewritten.
ALTER TABLE deck_preview_change ADD COLUMN reply_thread_token TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0314_deck_change_reply_thread');
