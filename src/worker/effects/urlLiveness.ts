import { guardFeedUrl } from "./feedClient";

/**
 * Does a cited page answer? (15 Sep 2026)
 *
 * WHY THIS EXISTS. Walker's West Peek Productions research returns organisations, writers and
 * pages from a search-grounded model. The model's citations are URLs it read, and that is the whole
 * value of it over a remembered answer — but a URL that has since moved, or that the model
 * transcribed wrongly, would still reach Scooter's inbox as a lead. This asks each cited page for
 * its status before the entry is kept. Nothing else: no body is read, so nothing is parsed (CPU)
 * and nothing on the page can reach a prompt (injection).
 *
 * READ-ONLY BY CONSTRUCTION — a GET with the body discarded, https only, the same host guard as
 * feed acquisition (loopback, RFC1918, link-local and metadata addresses are never fetched), and a
 * short timeout. It carries nothing out: no headers beyond a User-Agent, no body, no firm data.
 */
export const LIVENESS_TIMEOUT_MS = 8_000;

export async function urlIsLive(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const guard = guardFeedUrl(url);
  if (!guard.ok) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "WestPeekOS/1.0 (+https://os.joinwestpeek.com)" },
    });
    // The body is never read: a status is enough to know the page exists, and reading it is CPU.
    try { await res.body?.cancel(); } catch { /* a body that will not cancel is still a status */ }
    return res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE FIRST 150 KB OF A PAGE, AS TEXT — enough to read an address off an author page, a masthead
 * or a contact page (15 Sep 2026: the address hunt in services/productions.ts). Same guard and
 * timeout as the liveness check; the body is read only up to the cap, never parsed here.
 */
export const PAGE_TEXT_BYTES = 150_000;

export async function pageTextOf(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const guard = guardFeedUrl(url);
  if (!guard.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "WestPeekOS/1.0 (+https://os.joinwestpeek.com)", accept: "text/html,text/plain" },
    });
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < PAGE_TEXT_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      got += value.length;
    }
    try { await reader.cancel(); } catch { /* enough was read */ }
    const merged = new Uint8Array(Math.min(got, PAGE_TEXT_BYTES));
    let at = 0;
    for (const c of chunks) {
      const room = merged.length - at;
      if (room <= 0) break;
      merged.set(c.subarray(0, Math.min(c.length, room)), at);
      at += Math.min(c.length, room);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
