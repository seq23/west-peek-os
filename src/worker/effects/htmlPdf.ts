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
    let scale = Math.min(1, LETTER_PRINTABLE_PX.height / Math.max(1, tall));
    let bytes = new Uint8Array();
    for (let attempt = 0; attempt < 6; attempt++) {
      bytes = new Uint8Array(await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true, scale: Math.max(0.35, scale) }));
      if (!opts.onePage || pdfPageCount(bytes) <= 1 || scale <= 0.35) break;
      scale *= 0.92;
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
