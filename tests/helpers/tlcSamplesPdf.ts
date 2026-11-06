import type { BrandReplyDeps } from "../../src/worker/services/tlcBrandReply";

/**
 * THE BRAND'S 3-PAGE SAMPLES PDF, FAKED FOR A TEST (owner, 4 Nov 2026: email 1 is filed only once the samples PDF is
 * made, and email 2 carries it). No browser runs in a test, so the renderer returns a fixed three-page PDF; the words
 * come from the plain fallback (no model call). The document store is the test database's own R2 bucket.
 */
export const THREE_PAGE_PDF = { pdfBase64: Buffer.from("%PDF-1.4 /Type /Page a /Type /Page b /Type /Page c").toString("base64"), pageCount: 3, reason: "" };
export const DRIP_DEPS: BrandReplyDeps = {
  samples: { renderPdf: async () => THREE_PAGE_PDF, writer: async () => ({ ok: false, text: "" }) },
};
