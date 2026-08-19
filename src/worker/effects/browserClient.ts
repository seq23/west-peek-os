import type { Env } from "../env";
import { fenceUntrusted, isBlockedBrowserHost } from "../../shared/browser/taskPolicy";

/**
 * Browser Rendering transport (P44) — Cloudflare's own headless browser.
 *
 * WHY THIS AND NOT BROWSERBASE. The scaffold was written against Browserbase and its x402 lane.
 * Cloudflare Browser Rendering is a BINDING on the platform this Worker already runs on, which
 * removes three problems rather than managing them:
 *
 *   · no second vendor and no second credential to rotate;
 *   · no x402 — autonomous agent payment exists to pay strangers, and there is no stranger here.
 *     It bills through the account that already pays for this Worker;
 *   · no egress exemption. `env.BROWSER` is a binding, not fetch(), so the authority scan has
 *     nothing to allow. Fewer exceptions is a better security posture than well-managed ones.
 *
 * WHAT COMES BACK IS UNTRUSTED. A page is chosen at runtime, so its text is fenced before it can
 * reach a model. This is the same defence the intelligence pipeline uses and it matters more here:
 * a feed URL was registered in advance by an operator, a task URL was not.
 *
 * NO SCREENSHOTS, NO PDFs, NO FORM FILLING. Read-only navigation and text extraction. Each of those
 * is a separate capability with its own consequences, and adding them because the library supports
 * them is how a research tool quietly becomes something that can act on the web.
 */

export interface BrowseResult {
  ok: boolean;
  /** Fenced, truncated page text. Never raw HTML. */
  text: string | null;
  finalUrl: string | null;
  title: string | null;
  detail: string;
}

const NAV_TIMEOUT_MS = 20_000;
const MAX_TEXT = 20_000;

/** True when the platform gave this Worker a browser to use. */
export function browserConfigured(env: Env): boolean {
  return Boolean((env as unknown as { BROWSER?: unknown }).BROWSER);
}

export function browserBlockedReason(env: Env): string | null {
  if (!browserConfigured(env)) {
    return "Browser Rendering is not bound to this Worker. Add the [browser] binding and redeploy.";
  }
  return null;
}

/**
 * Fetch one page and return its readable text.
 *
 * `launch` is injected so tests drive the whole path — guard, extraction, fencing, cleanup —
 * without a real browser, the same pattern feedClient and the Network OS client use.
 */
/** A browser that never starts must not hold a request open until the platform kills it. */
const LAUNCH_TIMEOUT_MS = 20_000;
/** Time for a framework to paint after load. Short: this is a cost as well as a wait. */
const SETTLE_MS = 1_200;

/** Reject with a readable reason rather than hanging, and never leave the timer running. */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function browsePage(
  env: Env,
  startUrl: string,
  launch?: (binding: unknown) => Promise<BrowserLike>,
): Promise<BrowseResult> {
  const blocked = browserBlockedReason(env);
  if (blocked) return { ok: false, text: null, finalUrl: null, title: null, detail: blocked };

  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return { ok: false, text: null, finalUrl: null, title: null, detail: `"${startUrl}" is not a URL.` };
  }
  if (url.protocol !== "https:") {
    return { ok: false, text: null, finalUrl: null, title: null, detail: "Browser tasks run over https only." };
  }
  // Re-checked here even though the request was already validated: this is the last line before a
  // real browser opens a socket, and a guard that only runs at request time is one redirect away
  // from being bypassed.
  if (isBlockedBrowserHost(url.hostname)) {
    return { ok: false, text: null, finalUrl: null, title: null, detail: `${url.hostname} is an internal address and is never reachable.` };
  }

  // Fail fast when there is no browser to launch.
  //
  // Found by running a task in local dev, where the binding does not exist: puppeteer.launch()
  // against an undefined binding does not throw, it HANGS — the request sat for six minutes before
  // it was killed. In production the binding is there, so this would only bite if Browser Rendering
  // were removed from the account or the binding dropped from a config; both are exactly the sort
  // of change nobody connects to "tasks stopped finishing" a week later.
  const binding = (env as unknown as { BROWSER?: unknown }).BROWSER;
  if (!launch && !binding) {
    return {
      ok: false,
      text: null,
      finalUrl: null,
      title: null,
      detail: "No browser is available in this environment — the BROWSER binding is not configured.",
    };
  }

  let browser: BrowserLike | null = null;
  try {
    const doLaunch = launch ?? (async (b: unknown) => {
      const puppeteer = await import("@cloudflare/puppeteer");
      return (await puppeteer.launch(b as never)) as unknown as BrowserLike;
    });
    // Bounded even so. The navigation timeout only covers goto(); a launch that never resolves is
    // not covered by it, and an unbounded await inside a Worker is a request that dies silently
    // rather than reporting anything the operator can act on.
    browser = await withDeadline(doLaunch(binding), LAUNCH_TIMEOUT_MS, "the browser did not start");

    const page = await browser.newPage();
    // WAIT FOR THE PAGE TO ACTUALLY EXIST. `domcontentloaded` fires before client-side rendering,
    // and most of what this system needs to read — careers pages, pricing pages, anything built
    // this decade — paints after that. Reading at domcontentloaded returns an empty shell or a
    // skeleton, and the employee reasonably concludes the answer is not there. `load` waits for
    // subresources; the settle below covers frameworks that render on an effect after that.
    await page.goto(url.toString(), { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const finalUrl = await page.url();
    // A redirect can land somewhere the original guard never saw. Check again after navigation.
    try {
      const landed = new URL(finalUrl);
      if (isBlockedBrowserHost(landed.hostname)) {
        return { ok: false, text: null, finalUrl, title: null, detail: `Redirected to ${landed.hostname}, an internal address. Nothing was read.` };
      }
    } catch { /* an unparseable final URL is handled by the extraction below */ }

    const title = await page.title().catch(() => null);
    const raw = await page.evaluate(() => document.body?.innerText ?? "");

    // LINKS, BECAUSE innerText THROWS THEM AWAY. Without them a page can be read but never
    // followed: an employee reaching a directory or a search result has the words and no way to
    // reach what they point at, which is most of why multi-step lookups went nowhere. Same-page
    // anchors and javascript: are dropped — they lead nowhere worth a second request.
    const links = await page
      .evaluate(() => {
        const out: string[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 400)) {
          const href = (a as HTMLAnchorElement).href;
          const label = ((a as HTMLAnchorElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
          if (!href.startsWith("http")) continue;
          if (label) out.push(`${label} → ${href}`);
        }
        return Array.from(new Set(out)).slice(0, 60);
      })
      .catch(() => [] as string[]);

    // Defensive: anything that is not an array of strings is treated as no links. The page decides
    // what comes back from evaluate, and a value of an unexpected shape must degrade the extras
    // rather than lose the page text that was successfully read.
    const linkLines = Array.isArray(links) ? links.filter((l): l is string => typeof l === "string") : [];

    return {
      ok: true,
      text: fenceUntrusted(
        [
          String(raw).replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT),
          linkLines.length ? `\n\nLINKS ON THIS PAGE:\n${linkLines.join("\n")}` : "",
        ].join(""),
      ),
      finalUrl,
      title,
      detail: "ok",
    };
  } catch (err) {
    return { ok: false, text: null, finalUrl: null, title: null, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    // A leaked browser session is a leaked bill as much as a leaked resource.
    await browser?.close().catch(() => undefined);
  }
}

/** The slice of puppeteer this module uses. Narrow on purpose — it is also the test seam. */
export interface BrowserLike {
  newPage(): Promise<{
    goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    url(): Promise<string> | string;
    title(): Promise<string>;
    evaluate<T>(fn: () => T): Promise<T>;
    evaluate<T>(fn: () => T[]): Promise<T[]>;
  }>;
  close(): Promise<void>;
}
