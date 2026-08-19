-- Each partner's own mailbox and calendar.
--
-- The `connector` registry is FIRM-scoped: it records that this firm intends to have email and a
-- calendar, what each owns, and which approval gates apply. That is the right shape for a policy
-- register and the wrong shape for the thing itself — a mailbox belongs to a person. Scooter
-- connecting his calendar says nothing about Sequoia's, and a single firm-level "connected" flag
-- would claim otherwise.
--
-- So a connection is per firm_user per connector, and the registry row stays what it is: the
-- firm's declaration that this capability exists and how it is governed.
--
-- NO TOKEN IS STORED IN THIS TABLE. Access and refresh tokens are credentials; they belong in the
-- encrypted vault and Worker secret storage like every other credential in this system, and a
-- column here would put them in every database dump and every D1 console query. What is stored is
-- the FACT of a connection — who, which account, when, which scopes, and whether it still works —
-- which is what every screen actually needs to ask.
--
-- `scopes_json` records what was granted rather than what was requested. Those diverge whenever a
-- provider's consent screen lets somebody tick fewer boxes, and the difference is exactly what
-- explains a feature silently doing nothing later.

CREATE TABLE IF NOT EXISTS partner_connection (
  id              TEXT PRIMARY KEY,
  firm_user_id    TEXT NOT NULL REFERENCES firm_user (id),
  connector_key   TEXT NOT NULL REFERENCES connector (connector_key),
  -- The account actually connected, so a partner can see WHICH mailbox this is. Not a credential.
  account_label   TEXT,
  provider        TEXT NOT NULL DEFAULT 'GOOGLE',
  status          TEXT NOT NULL DEFAULT 'DISCONNECTED'
                  CHECK (status IN ('DISCONNECTED','PENDING','CONNECTED','EXPIRED','REVOKED','FAILED')),
  -- What the provider actually granted. See the note above on requested versus granted.
  scopes_json     TEXT NOT NULL DEFAULT '[]',
  -- Where the credential lives, by NAME. The value never appears here.
  credential_name TEXT,
  connected_at    TEXT,
  last_checked_at TEXT,
  last_error      TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- One connection per person per connector. Reconnecting updates rather than accumulating.
  UNIQUE (firm_user_id, connector_key)
);

CREATE INDEX IF NOT EXISTS idx_partner_connection_user ON partner_connection (firm_user_id, status);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0062_partner_connections');
