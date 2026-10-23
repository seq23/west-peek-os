import type { Env } from "../env";

/**
 * HTML → PDF through Browser Rendering (the BROWSER binding the deck and Room packets already use).
 * `onePage` lays a one-sheet out on ONE letter page: it shrinks the print scale until it fits, so a
 * long sources list never spills onto a second page. $0: the binding is on the Workers plan.
 */
export type PdfRender = { pdfBase64: string; pageCount: number } | { pdfBase64: null; reason: string };
export type PdfRenderer = (html: string) => Promise<PdfRender>;

const LETTER_PRINTABLE_PX = { width: 730, height: 970 }; // 8.5in x 11in less 0.45in margins, at 96 px/in

export function pdfPageCount(bytes: Uint8Array): number {
  return (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

export async function renderHtmlPdf(env: Env, html: string, opts: { onePage?: boolean } = {}): Promise<PdfRender> {
  const binding = (env as unknown as { BROWSER?: unknown }).BROWSER;
  if (!binding) return { pdfBase64: null, reason: "no browser is available here — the BROWSER binding is not configured" };
  let browser: { newPage(): Promise<any>; close(): Promise<void> } | null = null;
  try {
    const puppeteer = await import("@cloudflare/puppeteer");
    browser = (await puppeteer.launch(binding as never)) as unknown as { newPage(): Promise<any>; close(): Promise<void> };
    const page = await browser.newPage();
    await page.setViewport(LETTER_PRINTABLE_PX);
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const tall: number = opts.onePage ? await page.evaluate(() => document.documentElement.scrollHeight) : LETTER_PRINTABLE_PX.height;
    const print = async (scale: number) => new Uint8Array(await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true, scale }));
    let scale = Math.max(0.35, Math.min(1, LETTER_PRINTABLE_PX.height / Math.max(1, tall)));
    let bytes = await print(scale);
    if (opts.onePage) {
      // Shrink until it fits on one page, then grow back as far as one page allows: the largest type that fits.
      for (let i = 0; i < 6 && pdfPageCount(bytes) > 1 && scale > 0.35; i++) bytes = await print((scale = Math.max(0.35, scale * 0.9)));
      let lo = scale;
      let hi = 1;
      let best = bytes;
      if (pdfPageCount(bytes) <= 1 && lo < 1) {
        const atOne = await print(1);
        if (pdfPageCount(atOne) <= 1) best = atOne;
        else {
          for (let i = 0; i < 5; i++) {
            const mid = (lo + hi) / 2;
            const b = await print(mid);
            if (pdfPageCount(b) <= 1) { lo = mid; best = b; } else hi = mid;
          }
        }
      }
      bytes = best;
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { pdfBase64: btoa(binary), pageCount: pdfPageCount(bytes) };
  } catch (err) {
    return { pdfBase64: null, reason: `the browser could not render the page: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
