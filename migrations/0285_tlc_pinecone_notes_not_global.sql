-- Three sentences from Sequoia's 29 Oct notes on Pinecone's reply (TLR-MCZF63) were saved as standing
-- rules for EVERY brand: two are Pinecone-specific pitch notes and one was a one-off timing remark
-- ("start tomorrow when credits free up"). They are not standing rules; switch them off.
-- The source fix (sentences from a reply note are no longer saved as global rules) landed in 0284 / PR #306.
UPDATE tlc_wynn_rule SET active = 0
 WHERE id IN ('wr_38889500-d1c3-4263-9d47-443653326eeb',
              'wr_876d6d22-2f60-4c25-9ea8-63b063b4f601',
              'wr_41d8d936-94f9-44fa-8f57-6c35bc511f75');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0285_tlc_pinecone_notes_not_global');
