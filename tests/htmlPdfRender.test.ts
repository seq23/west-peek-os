import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A SELF-CONTAINED PAGE RENDERS WITHOUT WAITING FOR NETWORK IDLE (10 Nov 2026: Pinecone's approved pricing reply
 * did not go; the partner-levels sheet failed with "Navigation timeout of 30000 ms exceeded"). The remote browser
 * does not always send Chrome's networkIdle event after setContent, so a render that waits for it can time out on a
 * page that makes no request at all. The fake browser below behaves that way: any network-idle wait never finishes.
 */
const calls: Array<{ waitUntil: unknown; timeout: unknown }> = [];
vi.mock("@cloudflare/puppeteer", () => ({
  launch: async () => ({
    newPage: async () => ({
      setViewport: async () => undefined,
      emulateMediaType: async () => undefined,
      setContent: async (_html: string, o: { waitUntil?: unknown; timeout?: number } = {}) => {
        calls.push({ waitUntil: o.waitUntil, timeout: o.timeout });
        const waits = ([] as unknown[]).concat(o.waitUntil ?? "load");
        if (waits.some((w) => /networkidle/.test(String(w)))) throw new Error(`Navigation timeout of ${o.timeout ?? 30000} ms exceeded`);
      },
      evaluate: async () => 900,
      pdf: async () => new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF"),
    }),
    close: async () => undefined,
  }),
}));

afterEach(() => { calls.length = 0; });

describe("renderHtmlPdf", () => {
  it("prints the partner-levels sheet (inline fonts, no network) instead of timing out on a network-idle wait", async () => {
    const { renderHtmlPdf, PDF_RENDER_TIMEOUT_MS } = await import("../src/worker/effects/htmlPdf");
    const { renderBrandPitch, sponsorOf } = await import("../src/shared/tlc/pitch");
    const html = renderBrandPitch({ topic: "Build Your Own AI Agent", angle: "A hackathon-style evening.", month: "2027-03", eventDate: "2027-03-18", slot: "EVENING", whyNow: null, sources: [], categories: [], handsOn: null, takeHome: null, recap: null }, sponsorOf({ brand: "Acme Vector", category: "Vector database" }));
    const out = await renderHtmlPdf({ BROWSER: {} } as never, html, { onePage: true });
    expect(out).toMatchObject({ pageCount: 1 });
    expect(out.pdfBase64).not.toBeNull();
    expect(calls).toHaveLength(1);
    // The page wait is bounded by the render's own limit, never puppeteer's 30-second default.
    expect(calls[0]!.timeout).toBe(PDF_RENDER_TIMEOUT_MS);
  });
});
