-- 0253 — Porter works on any repo a partner names, and a secret can be emailed (owner, 6 Oct 2026).
--
-- HER WORDS. "porter needs to work on anything sequoia or scooter send him. 'registered west peek
-- repos only' is a problem. scootr has some west peek productions work that is his only that is
-- allowed and any new repo we request is allowed" — and — "new repo secrets needs an easier hands
-- off approach — we should be able to email them and u should look them up in the vault when
-- necessary without approval".
--
-- WHAT WAS WRONG. The property list was a closed TypeScript array (`WEB_PROPERTIES`): a repo not on
-- it could not be a Porter job at all, and the week before this she landed thirteen PRs by hand on
-- seq23/topbarz-voting because the door answered "not a West Peek property". A Pages secret the
-- partner's README said must stay server-side was set by hand too, because the only way a value
-- reached the Mac was her typing it into the vault.
--
-- THREE TABLES, each a guard at the row rather than a sentence in a prompt:
--
--   1 · `web_property_registry` — the open list. Seeded here from today's eight rows so nothing
--       changes for the sites she already has (`seeded = 1`, and the door may never re-point a
--       seeded host: an email cannot send joinwestpeek.com to another repo). A partner's email
--       naming a GitHub repo (`owner/name` or a github.com link) adds a row with `seeded = 0`,
--       `requested_by` = the authenticated address. `secret_names_json` is the per-repo allow-list
--       of secret NAMES the duty may inject (its RUNBOOK's `## Secrets` plus vendor matches found
--       in the vault), written by the duty from what it read, never from the email.
--   2 · `secret_handoff` — a value emailed as `SECRET NAME=value`, AES-GCM under the Worker secret
--       WP_OS_SECRET_HANDOFF_KEY, held until the Mac's claimer pulls it into the local vault and
--       the row is deleted. The plaintext is in no other column of any table, in no event, in no
--       email, and is scrubbed from the stored .eml. `expires_at` bounds how long an unclaimed
--       value may sit here.
--   3 · `work_card_file` — a file the job produced for the partner (an export, a QR code), kept in
--       R2 and attached to the DONE / preview email when the set fits (≤ 10 MB), or linked when it
--       does not. Never the bytes in D1.

CREATE TABLE IF NOT EXISTS web_property_registry (
  id               TEXT PRIMARY KEY,
  -- The host a partner would name; NULL until the repo's own config says what it serves.
  host             TEXT UNIQUE,
  -- The checkout under ~/GitHub on her Mac (the GitHub repo's name).
  repo             TEXT NOT NULL,
  -- owner/name on GitHub, for `gh repo clone` when the checkout is missing.
  github_repo      TEXT,
  site             TEXT NOT NULL DEFAULT '.',
  words_json       TEXT NOT NULL DEFAULT '[]',
  aliases_json     TEXT NOT NULL DEFAULT '[]',
  pages_host       TEXT,
  -- 1 for the rows this migration wrote: their host → repo binding is immutable from email.
  seeded           INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1)),
  requested_by     TEXT,
  -- Secret NAMES (never values) the duty may inject for this repo. JSON list of strings.
  secret_names_json TEXT NOT NULL DEFAULT '[]',
  -- The partner's standing constraints for this repo, read by the duty from the build package's
  -- README / PRD at the first job (exclusions, preview-only test data, keys server-side, brand
  -- words) and injected into every later job's prompt. JSON list of strings. Never from the email.
  constraints_json TEXT NOT NULL DEFAULT '[]',
  firm_scope       TEXT NOT NULL DEFAULT 'west-peek',
  position         INTEGER NOT NULL DEFAULT 100,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_web_property_registry_repo ON web_property_registry (repo);

-- THE SEED: today's WEB_PROPERTIES rows, verbatim (src/shared/intake/webPropertyChange.ts, 23 Sep
-- 2026 hosts). `validate:open-repo-door` holds this block to that array: same hosts, same repos.
INSERT OR IGNORE INTO web_property_registry (id, host, repo, github_repo, site, words_json, aliases_json, pages_host, seeded, position) VALUES
  ('wpr_westpeek_ventures', 'westpeek.ventures', 'join-west-peek-main', 'seq23/join-west-peek-main', 'sites/ventures',
   '["ventures site","ventures website","ventures page","the fund site","the fund website","west peek ventures site"]', '[]', 'west-peek-ventures.pages.dev', 1, 1),
  ('wpr_westpeekproductions_com', 'westpeekproductions.com', 'join-west-peek-main', 'seq23/join-west-peek-main', 'sites/productions',
   '["productions site","productions website","agency site","agency website","west peek productions site"]', '[]', 'west-peek-productions.pages.dev', 1, 2),
  ('wpr_joinwestpeek_com', 'joinwestpeek.com', 'join-west-peek-main', 'seq23/join-west-peek-main', 'sites/community',
   '["community site","community website","join west peek site","the community page"]', '[]', 'west-peek-community.pages.dev', 1, 3),
  ('wpr_westpeek_live', 'westpeek.live', 'westpeek-live', 'seq23/westpeek-live', '.',
   '["westpeek live","west peek live","westpeek.live","the live site","the live website","the events site","the events platform","the event platform"]', '[]', NULL, 1, 4),
  ('wpr_pitch_joinwestpeek_com', 'pitch.joinwestpeek.com', 'west-peek-pitch-lab', 'seq23/west-peek-pitch-lab', '.',
   '["pitch lab","pitchlab","the pitch site","pitch lab site"]', '["pitchlab.joinwestpeek.com"]', 'west-peek-pitch-lab.pages.dev', 1, 5),
  ('wpr_network_joinwestpeek_com', 'network.joinwestpeek.com', 'west-peek-network-os', 'seq23/west-peek-network-os', '.',
   '["network os","the network app","network os app"]', '[]', NULL, 1, 6),
  ('wpr_venturedeals_joinwestpeek_com', 'venturedeals.joinwestpeek.com', 'secondaries', 'seq23/secondaries', '.',
   '["venture deals","venturedeals","secondaries site","the secondaries page","secondaries page","secondaries website"]', '[]', NULL, 1, 7),
  ('wpr_dilution_joinwestpeek_com', 'dilution.joinwestpeek.com', 'founder-dilution-dashboard', 'seq23/founder-dilution-dashboard', '.',
   '["dilution dashboard","dilution calculator","the dilution site","dilution site","founder dilution"]', '[]', NULL, 1, 8);

-- A SEEDED BINDING CANNOT BE RE-POINTED, whatever the Worker code does. The trigger is the guard.
DROP TRIGGER IF EXISTS trg_web_property_registry_seeded_is_immutable;
CREATE TRIGGER trg_web_property_registry_seeded_is_immutable
BEFORE UPDATE OF host, repo, site ON web_property_registry
WHEN OLD.seeded = 1 AND (NEW.host IS NOT OLD.host OR NEW.repo IS NOT OLD.repo OR NEW.site IS NOT OLD.site)
BEGIN
  SELECT RAISE(ABORT, 'a seeded web property binding (host → repo) is immutable; it changes only by migration');
END;
DROP TRIGGER IF EXISTS trg_web_property_registry_seeded_is_kept;
CREATE TRIGGER trg_web_property_registry_seeded_is_kept
BEFORE DELETE ON web_property_registry
WHEN OLD.seeded = 1
BEGIN
  SELECT RAISE(ABORT, 'a seeded web property is never deleted at runtime');
END;

CREATE TABLE IF NOT EXISTS secret_handoff (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) >= 3),
  repo          TEXT,
  -- AES-GCM ciphertext and its IV, base64. NEVER a plaintext column.
  ciphertext    TEXT NOT NULL,
  iv            TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  inbound_message_id TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secret_handoff_expires ON secret_handoff (expires_at);

CREATE TABLE IF NOT EXISTS work_card_file (
  id            TEXT PRIMARY KEY,
  work_card_id  TEXT NOT NULL REFERENCES work_card (id),
  filename      TEXT NOT NULL CHECK (length(trim(filename)) >= 1),
  media_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes         INTEGER NOT NULL DEFAULT 0,
  -- Where the bytes live. Never the bytes themselves in D1.
  r2_key        TEXT,
  -- When the file was too large to attach and was shared from Drive instead.
  drive_url     TEXT,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_work_card_file_card ON work_card_file (work_card_id, created_at);

-- Keys the job still lacks after the vault was searched (JSON list of { name, vendor_url?, searched }).
-- Never a value. Every email about the card carries the "Still missing" line until the SECRET arrives,
-- and the hand-off door resumes the card when it does.
ALTER TABLE web_property_change ADD COLUMN missing_secrets_json TEXT NOT NULL DEFAULT '[]';

-- A HOST OUTSIDE HER CLOUDFLARE ZONES (her words, 6 Oct 2026: "topbarz.xyz was not a cloudflare domain i
-- owned and we needed to send scooter some DNS stuff — can porter do that too?"). The duty adds the
-- custom domain to the Pages project through the API and READS BACK the record Cloudflare requires
-- (the project's own `subdomain` as the CNAME target; any TXT from validation_data) — never guessed.
-- This row is what the partner is emailed, what the Mac re-checks every ~15 minutes for 7 days, and
-- what closes when Cloudflare reports the domain active. Not a block: the site is live on pages.dev.
CREATE TABLE IF NOT EXISTS web_property_dns (
  id             TEXT PRIMARY KEY,
  work_card_id   TEXT REFERENCES work_card (id),
  repo           TEXT NOT NULL,
  host           TEXT NOT NULL,
  project        TEXT NOT NULL,
  record_type    TEXT NOT NULL CHECK (record_type IN ('CNAME', 'A', 'AAAA')),
  record_name    TEXT NOT NULL CHECK (length(trim(record_name)) >= 1),
  record_target  TEXT NOT NULL CHECK (length(trim(record_target)) >= 1),
  txt_name       TEXT,
  txt_value      TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  requested_by   TEXT NOT NULL,
  emailed_at     TEXT,
  reminded_at    TEXT,
  active_at      TEXT,
  last_checked_at TEXT,
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (host, project)
);
CREATE INDEX IF NOT EXISTS idx_web_property_dns_open ON web_property_dns (active_at, last_checked_at);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0253_porter_works_on_any_repo_a_partner_names');
