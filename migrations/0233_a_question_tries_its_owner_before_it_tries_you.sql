-- 0233 — A question tries its owner before it tries you (Addendum 12, 22 Sep 2026).
--
-- Her question: shouldn't `QUESTION_NEEDS_REPLY` (Addendum 10, migration 0229) try the right AI
-- employee first — "each page has someone who can answer questions about it" — before every plain
-- question lands on her directly? `services/questionRouting.ts` is that attempt: whoever owns the
-- card's kind (`shared/work/kindHosts.ts`) is asked, grounded in their real persona, and only a
-- confident answer ever reaches the partner without her. A LOW-confidence answer, no registered
-- kind host, or an inactive employee all still fall through to the EXACT `a_question_for_you`
-- block this file already used — that safety net does not change shape.
--
-- ONE ADDITIVE COLUMN, NO NEW CHECK VALUE ON AN EXISTING CONSTRAINT. `work_card.auto_resolution`
-- (0229) is CHECK-constrained to `NO_ACTION_NEEDED` alone, and SQLite cannot ALTER a CHECK in
-- place — only rebuild the table, which 0229's own header declines for `work_card` because of how
-- many real `REFERENCES work_card (id)` foreign keys it carries. Reusing `NO_ACTION_NEEDED` here
-- would also be a lie: a card an employee actually answered is not "no action needed", it is
-- answered. So this is a brand new, unconstrained, nullable column instead — set only when a
-- confident employee answer resolved the card, read by nothing else, checked by nothing else,
-- costing the existing CHECK constraints nothing.
--
-- A CARD RESOLVED THIS WAY IS `state = 'CANCELLED'`, the same terminal, reopenable state banter
-- resolves to — but `auto_resolution` stays NULL: it was not banter and the purge job
-- (`noActionPurge.ts`, which filters on `auto_resolution = 'NO_ACTION_NEEDED'`) never touches it.
-- Real correspondence, kept, exactly like every other real thing this firm has done.

ALTER TABLE work_card ADD COLUMN question_auto_answered_at TEXT;

CREATE INDEX IF NOT EXISTS idx_work_card_question_auto_answered ON work_card (question_auto_answered_at)
  WHERE question_auto_answered_at IS NOT NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0233_a_question_tries_its_owner_before_it_tries_you');
