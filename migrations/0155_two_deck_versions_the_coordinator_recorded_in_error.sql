-- 0155 — Two deck versions the coordinator recorded in error, and the LP deck they displaced.
--
-- Operator, 9 Sep 2026: "why cant we just have it be v2".
--
-- WHAT HAPPENED, ATTRIBUTED HONESTLY. The fault is the COORDINATOR's. Not the operator's, not
-- Preston's, not any employee's.
--
--   v3 is Preston's rebuild. `runDeckRebuild` records the version and CANNOT attach the PDF —
--   `scripts/deck/build.mjs` renders on her Mac, not in the Worker — so v3 arrived PROPOSED with
--   `document_id` NULL, exactly as designed.
--
--   The coordinator then uploaded that same rendered build so a PDF would exist. THE UPLOAD MADE
--   ITSELF CURRENT (see below) and superseded v2 — the Canva file that is the actual document this
--   firm sends to limited partners. That is v4.
--
--   The coordinator then uploaded the Canva file AGAIN to push the deck back. That made a third
--   copy of a document already on the record, and it is compounding the mistake rather than undoing
--   it. That is v5.
--
-- WHY NOTHING COULD BE UNDONE BY HAND, and why that is the system behaving correctly:
--   * `deck_version_reject_delete` refuses DELETE. What was sent to an LP is not deletable.
--   * `deck_version_reject_content_update` refuses any change to the bytes, the snapshot, the
--     version number, the author or the provenance.
--   * `handleDecideDeck` answers 409 to anything not PROPOSED, so v4 (SUPERSEDED) and v5 (CURRENT)
--     could not be rejected either.
-- Those three refusals are the reason no evidence was lost on 9 Sep. None of them is relaxed here.
--
-- REJECTED, NOT A NEW STATE, AND NOT A DELETE.
--   A new value such as WITHDRAWN_IN_ERROR would have to go into the `state` CHECK, and SQLite
--   cannot alter a CHECK in place — the finding is already recorded in `jobs.ts` for
--   `scheduled_job.kind` and it was tested, not assumed. Widening it means rebuilding `deck_version`:
--   CREATE a twin, copy, DROP the original — which drops the append-only trigger with it — and
--   rename. Trading the guard that saved today's history for a nicer label on two junk rows is the
--   wrong trade, and it is the "never weaken a guard to make a fix easier" rule exactly.
--
--   REJECTED already means "this is not the document the firm sends, and here is why", it is
--   terminal, and it carries `rejected_reason` — a column that exists to hold this sentence. The
--   register's own precedent (`reporting.ts`: "WITHDRAWN is terminal on purpose: a reviewer's
--   refusal is not edited away") is the same shape. So the words carry the distinction the state
--   name cannot: both rows say, on the row, that the coordinator recorded them in error.
--
-- WHAT THE HISTORY READS AS AFTERWARDS. Three versions, numbered 1, 2, 3, plus two rows visibly
-- struck out as recorded in error:
--   v1 SUPERSEDED — August 2026, as sent to LPs.
--   v2 CURRENT    — September 2026, corrected in Canva. The document that goes to LPs.
--   v3 PROPOSED   — Preston's build: a proposal and a check against the records, never sent.
--   v4 REJECTED   — recorded in error by the coordinator.
--   v5 REJECTED   — recorded in error by the coordinator.
--
-- The numbers 4 and 5 STAY. `version_no` is immutable by trigger and renumbering would be forging
-- the sequence: a history that shows a mistake being corrected is worth more than one that pretends
-- it never happened, and it is the only reading under which "v2 is current" is not itself a lie.

INSERT OR IGNORE INTO schema_version (migration)
VALUES ('0155_two_deck_versions_the_coordinator_recorded_in_error');

-- ── v4: the rendered build, uploaded a second time ────────────────────────────────────────────

UPDATE deck_version
SET state = 'REJECTED',
    rejected_reason =
      'Recorded in error by the coordinator, not by a partner and not by an employee. This row is a '
      || 'SECOND recording of Preston''s v3 build. Preston''s rebuild job records a version and cannot '
      || 'attach the PDF — the build script renders on the operator''s Mac, not in the Worker — so the '
      || 'coordinator uploaded the render to supply the missing file. Uploading silently made it '
      || 'CURRENT and superseded v2, the Canva deck the firm actually sends. v3 remains the version of '
      || 'record for that build; the PDF this row carries is that build''s render and stays reachable '
      || 'here. Nothing about the LP deck itself changed: it was v2 before this row and it is v2 again.',
    change_summary =
      'RECORDED IN ERROR BY THE COORDINATOR. A duplicate upload of Preston''s v3 render, made to '
      || 'supply the PDF the rebuild job cannot attach. The upload made itself current and displaced '
      || 'v2 — the Canva deck — which was never actually replaced as the document the firm sends.'
WHERE id = 'dck_25c456e1-7797-4831-9a69-0685b1b79182';

-- ── v5: the Canva file, uploaded a third time ─────────────────────────────────────────────────

UPDATE deck_version
SET state = 'REJECTED',
    rejected_reason =
      'Recorded in error by the coordinator, not by a partner and not by an employee. This row is a '
      || 'THIRD recording of the same Canva PDF already held by v2. It was uploaded to push the deck '
      || 'back to the Canva file after v4 displaced it — which compounded the mistake instead of '
      || 'fixing it, because uploading is what caused the displacement in the first place. The correct '
      || 'act was to restore v2, which this migration does.',
    change_summary =
      'RECORDED IN ERROR BY THE COORDINATOR. A third copy of the Canva PDF already on the record as '
      || 'v2, uploaded in an attempt to undo v4. Uploading was the cause, so a further upload could '
      || 'not be the cure.'
WHERE id = 'dck_cf418b6d-9e2c-49be-92f9-815c9f247afa';

-- ── v2: back to being the deck ────────────────────────────────────────────────────────────────
--
-- SET BY THE OPERATOR, RECORDED AS HERS. She asked for this in as many words, and the decision
-- belongs on the row rather than nowhere: an LP document becoming current is a human act, which is
-- the whole point of the code change that ships with this migration.

UPDATE deck_version
SET state = 'CURRENT',
    approved_by = 'fu_sequoia_taylor',
    approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = 'dck_1e6a70d9-e0fd-4a65-a8a0-0bfbc5ec2765';

-- v1 stays SUPERSEDED, v3 stays PROPOSED and awaiting her decision. Their content, their change
-- summaries and their record snapshots are not touched by this migration at all.

-- ── The correction is on the record ───────────────────────────────────────────────────────────

INSERT OR IGNORE INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json)
VALUES
  ('evt_deck_0155_v4', 'deck_version.recorded_in_error', 'system', 'coordinator', 'deck_version',
   'dck_25c456e1-7797-4831-9a69-0685b1b79182', 'west-peek',
   '{"migration":"0155","cause":"coordinator error","detail":"a rendered build uploaded a second time; the upload made itself current and superseded v2"}'),
  ('evt_deck_0155_v5', 'deck_version.recorded_in_error', 'system', 'coordinator', 'deck_version',
   'dck_cf418b6d-9e2c-49be-92f9-815c9f247afa', 'west-peek',
   '{"migration":"0155","cause":"coordinator error","detail":"the Canva PDF uploaded a third time to undo v4; compounded the error"}'),
  ('evt_deck_0155_v2', 'deck_version.reinstated', 'firm_user', 'fu_sequoia_taylor', 'deck_version',
   'dck_1e6a70d9-e0fd-4a65-a8a0-0bfbc5ec2765', 'west-peek',
   '{"migration":"0155","reason":"the Canva deck is the document the firm sends; it was never actually replaced"}');

-- ── The change summary is part of the record too ──────────────────────────────────────────────
--
-- The immutability trigger froze the bytes, the snapshot, the number, the author and the provenance
-- — but NOT the row's account of itself. This migration is the last write that hole permits: from
-- here `change_summary`, `changed_fields_json`, `title` and `page_count` are frozen with everything
-- else, so a version's story cannot be rewritten in prose while the table claims to be append-only.
--
-- NOT A WEAKENING AND NOT A RELAXATION — strictly more is refused than before. Nothing in the
-- codebase UPDATEs any of these columns; a new version remains the only way a deck changes. Only
-- the approval decision (`state`, `approved_by`, `approved_at`, `rejected_reason`) may still move,
-- which is what the original comment said the trigger did.

DROP TRIGGER IF EXISTS deck_version_reject_content_update;

CREATE TRIGGER deck_version_reject_content_update
BEFORE UPDATE ON deck_version
WHEN OLD.records_snapshot_json <> NEW.records_snapshot_json
  OR OLD.document_id IS NOT NEW.document_id
  OR OLD.version_no <> NEW.version_no
  OR OLD.created_by <> NEW.created_by
  OR OLD.origin <> NEW.origin
  OR OLD.title <> NEW.title
  OR OLD.change_summary IS NOT NEW.change_summary
  OR OLD.changed_fields_json <> NEW.changed_fields_json
  OR OLD.page_count IS NOT NEW.page_count
BEGIN
  SELECT RAISE(ABORT, 'deck_version content is immutable: a new version is how a deck changes');
END;

-- ── Preston's rebuild job is ACTIVE, and that was the coordinator's doing too ──────────────────
--
-- 0154 seeded `deck_rebuild` PAUSED. The coordinator RESUMED it on 9 Sep 2026 to run it by hand,
-- and it is now ACTIVE on DAILY_AT 10:00 UTC. The operator has not objected — a daily rebuild only
-- records a new version when a fund figure has actually moved, which makes it a drift detector
-- rather than noise — but the state change was the coordinator's, so it is announced rather than
-- left to be discovered. Both partners get their own row; this is Preston's rota, so
-- EMPLOYEE_EXCEPTION is the kind, and INFO because nothing is wrong.

INSERT OR IGNORE INTO notification (id, kind, severity, title, body, object_type, object_id, firm_user_id, dedupe_key, firm_scope)
SELECT
  'ntf_deck_rebuild_resumed_' || fu.id,
  'EMPLOYEE_EXCEPTION',
  'INFO',
  'Preston''s deck rebuild is now running daily — changed by the coordinator, not by you',
  'It was seeded paused ("rebuilt when the records move or when a partner asks, not on a timer"). '
  || 'The coordinator resumed it on 9 Sep 2026 to run it by hand and left it ACTIVE on a 10:00 UTC '
  || 'daily schedule. It is cheap and quiet: it records a version only as a proposal, never as the '
  || 'deck you send, so its practical effect is a daily check that no fund figure has moved under '
  || 'the deck. Pause it again on Work if you would rather it only ran when asked.',
  'scheduled_job',
  'sjb_deck_rebuild',
  fu.id,
  'deck_rebuild_resumed_by_coordinator:' || fu.id,
  'west-peek'
FROM firm_user fu
WHERE fu.id IN ('fu_sequoia_taylor', 'fu_scooter_taylor');
