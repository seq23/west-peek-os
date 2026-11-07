-- 0299 · A BRAND REPLY KEEPS ITS THREAD'S REF FOR LIFE (owner, 7 Nov 2026: "do not forget to incl the special email code
--   in the subject from wynn… that code is still important"; the Pinecone thread is TLR-BYC4L9 and its v2 email went out
--   as TLR-DPA7BZ).
--   · tlc_brand_reply.thread_ref: the ref of the first approval email for this reply. Every later version's subject
--     carries it, and an "approved" quoting it reaches the reply's current email, as does one quoting that email's own ref.
-- Additive only; no row changes.
ALTER TABLE tlc_brand_reply ADD COLUMN thread_ref TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0299_tlc_brand_reply_thread_ref');
