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
