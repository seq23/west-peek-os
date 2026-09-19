-- A message is handled once, however many times it is delivered.
--
-- Cloudflare Email Routing re-delivers when the handler does not answer cleanly, and the local
-- dev harness drops the RPC stream under load ("Network connection lost") after the handler has
-- already finished. Without a record of what has been handled, each re-delivery opened a second
-- capture, a second card, a second deck. The Message-ID header is the sender's own identity for
-- the message (RFC 5322 §3.6.4); it is recorded when the handler completes and checked on entry.
CREATE TABLE IF NOT EXISTS inbound_email_seen (
  message_id TEXT PRIMARY KEY,
  firm_scope TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
