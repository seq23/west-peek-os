-- 0236 — One website job can span several repos (owner, 23 Sep 2026).
--
-- HER WORDS: "there is a world where we ask you to fix something on the community site and
-- westpeek live in the same email." Until today one web-property job was one repo, one PR: sites
-- in two repos read as "unresolved". Now one email naming sites in DIFFERENT repos is ONE card
-- with ONE PART PER REPO.
--
-- WHY A CHILD TABLE, keyed (work_card_id, repo), and not columns on web_property_change:
--
--   · Everything that is ONE per job stays on the parent row, untouched: the request, the plan and
--     its approval, the preview gate and its second approval, the force record, the lease on the
--     Mac. A multi-repo job still has one plan, one approval email, one preview email, one "approved"
--     and one DONE email, so those facts must not be duplicated per repo.
--   · Everything that is ONE PER PR moves to the part: the repo, its sites, its slice of the
--     request, the PR, its observed check, its preview link, its proof, its merge and live proof.
--   · A single-repo job has NO part rows and runs exactly as before. The parent row keeps the
--     aggregate of its parts (every PR url, GREEN only when every part is GREEN, every merge), so
--     0219's DONE trigger and 0220's preview trigger keep governing the job as a whole.
--
-- ALL OR NOTHING, AT THE ROW (not only in code):
--   1 · A part cannot be recorded as merged unless EVERY part of the card has a recorded green
--       check, the plan is approved, and — when the job previews first — the second approval or a
--       named force is on the parent. One red PR means none lands.
--   2 · A card with parts cannot go DONE while any part lacks its merge.

CREATE TABLE IF NOT EXISTS web_property_change_part (
  work_card_id   TEXT NOT NULL REFERENCES web_property_change (work_card_id),
  repo           TEXT NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  -- The hosts of this repo the job names, comma-joined (sitesOf reads the folders back).
  property_host  TEXT NOT NULL,
  -- This repo's slice of the request when the email separated them; the whole request otherwise.
  ask            TEXT NOT NULL DEFAULT '',
  pr_url         TEXT,
  pr_number      INTEGER,
  branch         TEXT,
  check_state    TEXT CHECK (check_state IS NULL OR check_state IN ('PENDING', 'GREEN', 'RED')),
  check_url      TEXT,
  check_green_at TEXT,
  preview_url    TEXT,
  build_proof    TEXT,
  merge_sha      TEXT,
  landed_at      TEXT,
  live_proof     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (work_card_id, repo)
);

DROP TRIGGER IF EXISTS trg_web_property_change_part_lands_all_or_none;
CREATE TRIGGER trg_web_property_change_part_lands_all_or_none
BEFORE UPDATE OF merge_sha ON web_property_change_part
WHEN NEW.merge_sha IS NOT NULL AND length(trim(NEW.merge_sha)) > 0
  AND (
    EXISTS (
      SELECT 1 FROM web_property_change_part s
       WHERE s.work_card_id = NEW.work_card_id
         AND (s.check_green_at IS NULL OR s.check_state IS NOT 'GREEN' OR s.pr_url IS NULL)
    )
    OR NOT EXISTS (
      SELECT 1 FROM web_property_change w
       WHERE w.work_card_id = NEW.work_card_id
         AND w.plan_approved_at IS NOT NULL
         AND ((w.publish_ready = 1 AND w.preview_only = 0) OR w.land_approved_at IS NOT NULL OR w.forced_by IS NOT NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'a part of a multi-repo web change cannot be recorded as merged unless every part is green, the plan is approved and any preview was approved — all or nothing (0236)');
END;

DROP TRIGGER IF EXISTS trg_web_property_change_done_needs_every_part;
CREATE TRIGGER trg_web_property_change_done_needs_every_part
BEFORE UPDATE OF state ON work_card
WHEN NEW.state = 'DONE' AND OLD.state <> 'DONE' AND NEW.kind = 'WEB_PROPERTY_CHANGE'
  AND EXISTS (
    SELECT 1 FROM web_property_change_part p
     WHERE p.work_card_id = NEW.id AND (p.merge_sha IS NULL OR length(trim(p.merge_sha)) = 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'a multi-repo web change cannot be DONE while any repo''s PR is unmerged — every part lands or the card is not done (0236)');
END;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0236_one_website_job_can_span_several_repos');
