-- Copied from: seq23/boss-os src/worker/boss/lib/operatingStop.ts @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
CREATE TABLE owner_operating_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  wren_mail_until_ms INTEGER
);

INSERT INTO owner_operating_control (id) VALUES (1);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0316_owner_operating_controls');
