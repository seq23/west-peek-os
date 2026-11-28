-- Mail that arrives while the owner has paused West Peek OS agents is kept here by its stored .eml key and worked
-- after she resumes (review of #618, 28 Nov 2026, F2). Additive only.
CREATE TABLE operating_held_mail (
  eml_key TEXT PRIMARY KEY,
  route_as_json TEXT,
  held_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  replayed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT
);

CREATE INDEX operating_held_mail_waiting ON operating_held_mail (held_at) WHERE replayed_at IS NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0317_operating_held_mail');
