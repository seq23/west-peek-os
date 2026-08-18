import { describe, expect, it } from "vitest";
import { fetchFeed, guardFeedUrl, isBlockedHost, parseFeed } from "../src/worker/effects/feedClient";

describe("the feed client refuses what can never be a news feed", () => {
  // The MP authorised fetching with NO allowlist. These are not an allowlist — they are the
  // addresses that could only ever be the Worker's own network, and a source row is data.
  it("blocks loopback, private, link-local and metadata addresses", () => {
    for (const h of [
      "localhost", "127.0.0.1", "0.0.0.0", "::1",
      "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", "metadata.google.internal", "foo.internal", "box.local",
      "fd00::1", "fe80::1",
    ]) {
      expect(isBlockedHost(h), `${h} should be blocked`).toBe(true);
    }
  });

  it("allows ordinary public hosts — there is no allowlist", () => {
    for (const h of ["feeds.reuters.com", "www.ft.com", "techcrunch.com", "news.ycombinator.com", "8.8.8.8"]) {
      expect(isBlockedHost(h), `${h} should be allowed`).toBe(false);
    }
  });

  it("requires https and a valid url", () => {
    expect(guardFeedUrl("http://example.com/feed").ok).toBe(false);
    expect(guardFeedUrl("file:///etc/passwd").ok).toBe(false);
    expect(guardFeedUrl("not a url").ok).toBe(false);
    expect(guardFeedUrl("").ok).toBe(false);
    expect(guardFeedUrl("https://example.com/feed").ok).toBe(true);
  });

  it("refuses the metadata address even before any network call", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    await expect(
      fetchFeed({ source_key: "s", url: "https://169.254.169.254/latest/meta-data/", category: "AI_TECH" }, spy),
    ).rejects.toThrow(/refused host/);
    expect(called, "it must not issue the request at all").toBe(false);
  });
});

describe("feed parsing", () => {
  const RSS = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Nvidia announces new inference chip</title>
      <link>https://example.com/a</link>
      <description><![CDATA[<p>Margins &amp; supply implications.</p>]]></description>
      <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
      <guid>abc-123</guid>
    </item>
    <item>
      <title>Second story</title>
      <link>https://example.com/b</link>
    </item>
  </channel></rss>`;

  const ATOM = `<?xml version="1.0"?><feed>
    <entry>
      <title>Secondaries pricing firms up</title>
      <link href="https://example.com/c"/>
      <summary>NAV discounts narrowed.</summary>
      <updated>2026-08-12T10:00:00Z</updated>
      <id>urn:x:1</id>
    </entry>
  </feed>`;

  it("parses RSS, decoding entities and stripping markup", () => {
    const items = parseFeed(RSS, "AI_TECH", "https://example.com/rss");
    expect(items).toHaveLength(2);
    expect(items[0]!.title).toBe("Nvidia announces new inference chip");
    expect(items[0]!.body).toBe("Margins & supply implications.");
    expect(items[0]!.url).toBe("https://example.com/a");
    expect(items[0]!.external_id).toBe("abc-123");
    expect(items[0]!.published_at).toBe("2026-08-12T09:00:00.000Z");
    expect(items[0]!.category).toBe("AI_TECH");
    // Provenance is mandatory: an item with no citation is not usable as evidence later.
    expect(items[0]!.citation.locator).toContain("https://example.com/rss");
  });

  it("parses Atom entries and their href links", () => {
    const items = parseFeed(ATOM, "SECONDARIES", "https://example.com/atom");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Secondaries pricing firms up");
    expect(items[0]!.url).toBe("https://example.com/c");
    expect(items[0]!.category).toBe("SECONDARIES");
  });

  it("labels everything it fetches PUBLIC", () => {
    // Public news is public. Mislabelling it higher would let it reach surfaces it should not.
    for (const i of parseFeed(RSS, "AI_TECH", "u")) expect(i.privacy_label).toBe("PUBLIC");
  });

  it("drops untitled items rather than emitting blanks", () => {
    expect(parseFeed(`<rss><item><link>https://x/1</link></item></rss>`, "AI_TECH", "u")).toHaveLength(0);
  });

  it("survives malformed input without throwing", () => {
    expect(() => parseFeed("<rss><item><title>unclosed", "AI_TECH", "u")).not.toThrow();
    expect(() => parseFeed("", "AI_TECH", "u")).not.toThrow();
  });
});

describe("fetching", () => {
  it("sends no firm data outward — GET only, no body, no credentials", async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response(`<rss><item><title>T</title></item></rss>`, { status: 200 });
    }) as unknown as typeof fetch;

    await fetchFeed({ source_key: "s", url: "https://example.com/f", category: "AI_TECH" }, spy);
    expect(seen?.method).toBe("GET");
    expect(seen?.body).toBeUndefined();
    const headers = (seen?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("cookie");
  });

  it("treats a non-200 as a source failure, not as an empty feed", async () => {
    const spy = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchFeed({ source_key: "s", url: "https://example.com/f", category: "AI_TECH" }, spy),
    ).rejects.toThrow(/503/);
  });

  it("treats a feed that yields nothing usable as a failure", async () => {
    const spy = (async () => new Response("<rss></rss>", { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchFeed({ source_key: "s", url: "https://example.com/f", category: "AI_TECH" }, spy),
    ).rejects.toThrow(/zero usable items/);
  });
});

describe("every runIntelligence entry point injects the feed client", () => {
  // THE BUG THIS CATCHES: P29 wired `feedFetch` into the manual sweep but not the scheduled job,
  // so a scheduled sweep reported "no outbound feed client is configured" for all 11 sources —
  // indistinguishable from a deliberate egress policy. A source-level assertion is the only thing
  // that scales here, because the failure is an OMISSION at a call site, not wrong behaviour in
  // any function a normal unit test would reach.
  it("no call site of runIntelligence omits feedFetch", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");

    const root = fileURLToPath(new URL("../src/worker", import.meta.url));
    const files: string[] = [];
    (function walk(d: string) {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        statSync(f).isDirectory() ? walk(f) : f.endsWith(".ts") && files.push(f);
      }
    })(root);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Each `await runIntelligence(` that is not the definition itself.
      for (const m of src.matchAll(/await runIntelligence\(/g)) {
        // Take the following ~700 chars: enough to cover the deps object literal.
        const window = src.slice(m.index!, m.index! + 700);
        if (!window.includes("feedFetch")) {
          const line = src.slice(0, m.index!).split("\n").length;
          offenders.push(`${f.split("/src/")[1]}:${line}`);
        }
      }
    }
    expect(offenders, `these runIntelligence call sites do not inject feedFetch: ${offenders.join(", ")}`).toEqual([]);
  });
});
