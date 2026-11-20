-- 0313 · WHAT SPEECH-TO-TEXT SPENT TODAY, SO IT CAN STOP BEFORE IT BILLS (20 Nov 2026).
--
-- Live Meet notes went through Nova-3 at ~28,000 neurons an hour; 15 and 16 Nov ran 115,203 and
-- 34,902 neurons, ~$1.40 past the free 10,000 a day. The owner's bar is $0, and never above $0.99
-- a month of Cloudflare overage. Every transcription call now adds what it spent to today's row
-- (UTC day, the day Cloudflare's free allowance resets on), and `transcriptionBudget.ts` reads it
-- before any call: Nova-3 only while today is under the budget, and past it the notes pause by name.
--
-- Additive: one new table. Nothing is rewritten.
CREATE TABLE IF NOT EXISTS transcription_neuron_day (
  day         TEXT PRIMARY KEY,           -- YYYY-MM-DD, UTC
  neurons     REAL NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  stopped     INTEGER NOT NULL DEFAULT 0, -- calls refused because the day's budget was spent
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0313_transcription_neuron_day');
