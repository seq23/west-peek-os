-- Let a work card carry standing permission to look at web pages, and let a look know which card
-- it belongs to.
--
-- WHY THE PERMISSION SITS ON THE CARD. Every browser task needed its own human approval, which was
-- right when the only way to raise one was a floating button on the Work page: a person typing a
-- URL should say yes to that URL. But zero tasks have ever run, because it required somebody to
-- remember the capability existed at the moment they wanted it — and the employee actually doing
-- the diligence could not ask.
--
-- The approval does not disappear, it MOVES UP A LEVEL. A human still decides, once, that this
-- particular piece of work may involve reading web pages — which is a more meaningful decision than
-- approving the eleventh careers-page check on a card whose whole purpose is checking careers
-- pages. Scope is the card: permission granted for "Diligence Psyflo" says nothing about any other
-- work, and revoking it is one click.
--
-- What does NOT change: https only, the SSRF guard that refuses loopback, RFC1918 and cloud
-- metadata addresses, and results fenced as untrusted. Standing permission to READ public pages is
-- a different thing from unattended authority, and none of the guards were approval-shaped.
ALTER TABLE work_card ADD COLUMN allows_browser INTEGER NOT NULL DEFAULT 0 CHECK (allows_browser IN (0, 1));

-- Who granted it and when. A standing permission with no record of who gave it is not a permission,
-- it is a setting.
ALTER TABLE work_card ADD COLUMN browser_granted_by TEXT;
ALTER TABLE work_card ADD COLUMN browser_granted_at TEXT;

-- The card a look was done for, so the result comes back where the work is rather than on a page
-- nobody opens.
ALTER TABLE browser_task ADD COLUMN work_card_id TEXT REFERENCES work_card (id);

CREATE INDEX IF NOT EXISTS idx_browser_task_card ON browser_task (work_card_id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0067_browser_work_on_cards');
