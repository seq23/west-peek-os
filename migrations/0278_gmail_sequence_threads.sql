-- Gmail's provider ids and the RFC Message-ID actually sent, on the existing effect record.
-- Old sends remain unknown; no backfill or changes to existing messages.
ALTER TABLE external_effect_request ADD COLUMN gmail_message_id TEXT;
ALTER TABLE external_effect_request ADD COLUMN gmail_thread_id TEXT;
ALTER TABLE external_effect_request ADD COLUMN rfc_message_id TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0278_gmail_sequence_threads');
