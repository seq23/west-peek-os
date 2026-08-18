import type { AcquiredItem } from "../services/intelligence";

/**
 * Outbound feed client for HTTP_FEED sources (P29).
 *
 * Until now `feedFetch` was absent by design and every HTTP_FEED source failed closed with
 * EGRESS_GATED. The Managing Partner has authorised outbound retrieval with **no allowlist**: any
 * registered source URL may be fetched, so that adding a news source needs no approval step.
 *
 * That decision is honoured. What is NOT permitted is fetching addresses that could never be a news
 * feed but could read the runtime from the inside:
 *
 *   - loopback and link-local (`localhost`, `127.x`, `::1`, `169.254.x`)
 *   - RFC1918 private ranges (`10.x`, `192.168.x`, `172.16–31.x`)
 *   - the cloud metadata address `169.254.169.254`
 *   - any scheme other than https
 *
 * A source row is data. Without this, anyone able to register a source could make the Worker issue
 * requests against its own internal network and return the result into the briefing — the classic
 * SSRF shape. Blocking these costs no legitimate source anything, because none of them serves news.
 *
 * The client only ever issues GET. It sends no firm data outward: no body, no credentials, no
 * identifying headers beyond a User-Agent. Reading the outside world is not the same as leaking to
 * it, and this keeps the two apart.
 */

/** Hard caps so a hostile or broken feed cannot exhaust the Worker. */
const FETCH_TIMEOUT_MS = 8_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS_PER_SOURCE = 25;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

/** True when the host is one no public feed can legitimately live on. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "[::1]") return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0) return true;                    // loopback / this-network
    if (a === 10) return true;                                 // RFC1918
    if (a === 192 && b === 168) return true;                   // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;          // RFC1918
    if (a === 169 && b === 254) return true;                   // link-local incl. metadata
    if (a >= 224) return true;                                 // multicast / reserved
  }
  // IPv6 unique-local and link-local, written bare or bracketed.
  if (/^\[?(fc|fd|fe80)/i.test(h)) return true;
  return false;
}

export interface FeedGuardResult {
  ok: boolean;
  reason?: string;
}

/** Decide whether a source URL may be fetched at all. */
export function guardFeedUrl(raw: string | null | undefined): FeedGuardResult {
  if (!raw || !raw.trim()) return { ok: false, reason: "source has no url" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "source url is not a valid URL" };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: `refused scheme ${u.protocol} — only https is fetched` };
  }
  if (isBlockedHost(u.hostname)) {
    return {
      ok: false,
      reason:
        `refused host ${u.hostname} — loopback, private and link-local addresses are never ` +
        "fetched, because no public feed lives there and the Worker's own network does",
    };
  }
  return { ok: true };
}

// ── Parsing ──────────────────────────────────────────────────────────────────
// RSS and Atom, without a dependency. Deliberately forgiving: a feed that half-parses should
// still yield the items it did produce rather than failing the whole sweep.

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decodeEntities(m[1]!) : undefined;
}

function atomLink(block: string): string | undefined {
  const m = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);
  return m ? decodeEntities(m[1]!) : undefined;
}

function isoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Parse an RSS or Atom document into acquired items. Exported for direct testing. */
export function parseFeed(xml: string, sourceCategory: string, sourceUrl: string): AcquiredItem[] {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const out: AcquiredItem[] = [];
  for (const block of blocks.slice(0, MAX_ITEMS_PER_SOURCE)) {
    const title = stripTags(tag(block, "title") ?? "");
    if (!title) continue; // an item with no title is not usable intelligence
    const link = tag(block, "link") || atomLink(block) || undefined;
    const body = stripTags(
      tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "",
    ).slice(0, 4000);
    const published =
      isoDate(tag(block, "pubDate")) ?? isoDate(tag(block, "updated")) ?? isoDate(tag(block, "published"));
    const guid = tag(block, "guid") ?? tag(block, "id") ?? link ?? title;

    out.push({
      external_id: guid.slice(0, 200),
      title: title.slice(0, 500),
      ...(link ? { url: link } : {}),
      body,
      ...(published ? { published_at: published } : {}),
      category: sourceCategory as AcquiredItem["category"],
      privacy_label: "PUBLIC",
      citation: {
        locator: `feed:${sourceUrl}`,
        ...(link ? { url: link } : {}),
        ...(body ? { quote: body.slice(0, 280) } : {}),
      },
    });
  }
  return out;
}

// ── The client ───────────────────────────────────────────────────────────────

export interface FeedSourceLike {
  source_key: string;
  url: string | null;
  category: string;
}

/**
 * Fetch and parse one HTTP_FEED source.
 *
 * Throws with a readable reason on refusal or failure. `runIntelligence` catches it, marks that
 * source FAILED with the reason, and continues — one bad feed never fails the whole sweep.
 */
export async function fetchFeed(
  source: FeedSourceLike,
  fetchImpl: typeof fetch = fetch,
): Promise<AcquiredItem[]> {
  const guard = guardFeedUrl(source.url);
  if (!guard.ok) throw new Error(guard.reason ?? "refused");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(source.url!, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Identify ourselves; send nothing about the firm.
        "user-agent": "WestPeekOS/1.0 (+intelligence sweep)",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      },
    });
    if (!res.ok) throw new Error(`feed responded ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) throw new Error(`feed too large (${declared} bytes)`);
    const text = (await res.text()).slice(0, MAX_BYTES);

    const items = parseFeed(text, source.category, source.url!);
    if (items.length === 0) throw new Error("feed parsed to zero usable items");
    return items;
  } finally {
    clearTimeout(timer);
  }
}
