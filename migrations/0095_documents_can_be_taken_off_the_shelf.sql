-- A document can be taken off the shelf, and the record of who did it survives.
--
-- The operator asked to clean up and delete documents with a timestamp and who did it. There was no
-- delete route of any kind, for anyone — five document routes existed and none of them removed
-- anything — so there was nothing to record either.
--
-- WHY THIS IS AN ARCHIVE AND NOT A DELETE. The event spine is append-only by design, and a document
-- is referenced by deliverables and by R2 objects. Destroying the row would break those references
-- and erase the very history the operator is asking to keep. So the document leaves the shelf and
-- the trail stays: who archived it, when, and why. In practice it is the same thing — it is gone
-- from every list — with the difference that the firm can still answer "what happened to that?".
--
-- This is the pattern `deliverables.ts` already uses for dismissal: "DISMISSED IS HIDDEN, NOT GONE".

ALTER TABLE document ADD COLUMN archived_at TEXT;
ALTER TABLE document ADD COLUMN archived_by TEXT;
ALTER TABLE document ADD COLUMN archive_reason TEXT;

-- The shelf query. Everything not archived, newest first.
CREATE INDEX IF NOT EXISTS idx_document_shelf ON document (firm_scope, archived_at);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0095_documents_can_be_taken_off_the_shelf');
