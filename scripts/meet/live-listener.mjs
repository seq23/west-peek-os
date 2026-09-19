#!/usr/bin/env node
/**
 * THE LIVE LISTENER — the OS's ears in a Google Meet, on the owner's Mac (Phase Meet, tier 4).
 *
 *   npm run vault:run -- node scripts/meet/live-listener.mjs              run until killed
 *   npm run vault:run -- node scripts/meet/live-listener.mjs --once       one cycle, then exit
 *   npm run vault:run -- node scripts/meet/live-listener.mjs --doctor     check the machine, join nothing
 *   node scripts/meet/live-listener.mjs --self-test                       no network, no browser, pure logic
 *   node scripts/meet/live-listener.mjs --fixture tests/fixtures/x.wav --session <id> [--base http://127.0.0.1:96xx]
 *                                                                          play a WAV through the real peer page into a session
 *
 * ── WHY THIS RUNS HERE AND NOT IN THE WORKER ─────────────────────────────────────────────────
 *
 * The Meet Media API hands out media over WebRTC: an SDP exchange, then ICE over UDP, DTLS, SRTP,
 * Opus at 48 kHz, for as long as the call lasts. A Cloudflare Worker has `fetch` and a request
 * lifetime; it cannot hold a peer connection, and neither can a Durable Object (same runtime). A
 * Cloudflare Container could — with a Chromium image inside it and a bill for every hour it sits
 * idle — and AGENTS.md says no new Cloudflare product without a real requirement. Google's own
 * reference client runs in Chrome. So the peer is a headless Chromium driven by the Playwright
 * this repo already installs for e2e, on the Mac that already runs the seat claimer under launchd
 * (`deployment/launchd/`). It costs nothing and it is the runtime the API was built for. The
 * honest limit: her Mac must be awake — when it is not, the meeting row says
 * `meet_live_no_listener` rather than pretending.
 *
 * ── WHAT THIS PROCESS MAY AND MAY NOT DO ─────────────────────────────────────────────────────
 *
 * It may: say it is awake, learn which firm-hosted Meets are in their window, read a space to see
 * whether its conference is running, ask the Worker to open a session (the Worker holds the
 * gates), join through the Media API as the firm, post each minute of audio to the Worker, and say
 * when the call ended or why the join failed. It may NOT: choose a model, write a note, decide
 * consent, join a meeting the Worker did not offer, or send audio anywhere but the Worker's chunk
 * route. `scripts/meet/lib/listener-core.mjs` is the decision loop with everything injected;
 * `scripts/meet/lib/meet-media-page.js` is the peer; this file wires the two to the real world.
 *
 * ── THE IDENTITY IT JOINS AS ─────────────────────────────────────────────────────────────────
 *
 * The service account impersonating the ONE partner mailbox the calendar sync reads
 * (`shared/meetings/calendarSources.ts`), because Google's Media API joins "on behalf of a specific
 * user" and the plain service-account identity is refused on the space (probed 19 Sep 2026:
 * `spaces.get` → 403 PERMISSION_DENIED without a subject, 200 with one). Meet shows the joined
 * participant to everyone in the call; that announcement is the consent basis the Worker records.
 *
 * ── SECRETS ──────────────────────────────────────────────────────────────────────────────────
 *
 * Read from the environment the vault injects, never written, echoed or logged: the service-account
 * JSON (GSC_SERVICE_ACCOUNT_JSON, aliased WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON) and the two halves of
 * the Access service token (CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET — the same token the seat
 * claimer presents, so the Worker sees the same Mac identity). The private key is used by the
 * Worker's own client, bundled from TypeScript, and never enters the browser page.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createListener, selfTest, VERSION } from "./lib/listener-core.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PAGE_SCRIPT = readFileSync(path.join(ROOT, "scripts", "meet", "lib", "meet-media-page.js"), "utf8");

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const arg = (f) => { const i = ARGS.indexOf(f); return i >= 0 ? ARGS[i + 1] : undefined; };

const BASE_URL = arg("--base") ?? process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const DEVICE_ID = process.env.WP_OS_LISTENER_DEVICE_ID ?? `mac-${hostname()}`;
const POLL_MS = Number(process.env.WP_OS_LISTENER_POLL_MS ?? 30_000);

// ── The wire to the Worker ───────────────────────────────────────────────────

/**
 * Both halves of the Access service token, or — for a LOCAL Worker only — the dev identity header
 * the local build accepts. The dev header is refused unless the base URL is loopback, so a
 * production URL can never be reached with a header instead of a token.
 */
function workerHeaders() {
  const u = new URL(BASE_URL);
  // A LOCAL Worker (WP_OS_ENV=local) reads the dev identity header and ignores Access headers; a
  // production URL is reached only with the service token, never with a header.
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return { "x-wpos-dev-user": "subscription-claimer@joinwestpeek.com", "content-type": "application/json" };
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" };
  return null;
}

async function workerCall(pathname, body, method = "POST") {
  const headers = workerHeaders();
  if (!headers) throw new Error("CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not in the environment (run under `npm run vault:run --`)");
  const res = await fetch(`${BASE_URL}${pathname}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* reported by status */ }
  return { status: res.status, body: parsed };
}

// ── Google, through the Worker's own client ──────────────────────────────────

async function googleClient() {
  const { loadTs } = await import("../validate/lib/load-ts.mjs");
  const g = await loadTs(path.join(ROOT, "src", "worker", "effects", "googleWorkspaceClient.ts"));
  const { CALENDAR_SOURCES } = await loadTs(path.join(ROOT, "src", "shared", "meetings", "calendarSources.ts"));
  const env = { WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: process.env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON ?? process.env.GSC_SERVICE_ACCOUNT_JSON };
  if (!g.isServiceAccountConfigured(env)) throw new Error("GSC_SERVICE_ACCOUNT_JSON / WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON is not in the environment");
  return {
    subject: CALENDAR_SOURCES[0].subjectEmail,
    token: (scopes, subject) => g.serviceAccountToken(env, scopes, subject),
    getSpace: (token, name) => g.getSpace(token, name),
    connectActiveConference: (token, name, offer) => g.connectActiveConference(token, name, offer),
  };
}

// ── The peer: a headless Chromium page ───────────────────────────────────────

let browser = null;
async function getBrowser() {
  if (browser) return browser;
  const { chromium } = await import("@playwright/test");
  browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  return browser;
}

async function createPeerPage(log, { sliceMs } = {}) {
  const b = await getBrowser();
  const context = await b.newContext();
  const page = await context.newPage();
  let onSlice = () => {};
  let onStatus = () => {};
  await page.exposeFunction("__wposSlice", (s) => { try { onSlice(s); } catch (err) { log(`slice handler: ${err.message}`); } });
  await page.exposeFunction("__wposStatus", (s) => { try { onStatus(s); } catch (err) { log(`status handler: ${err.message}`); } });
  await page.exposeFunction("__wposLog", (l) => log(`page: ${l}`));
  await page.goto("about:blank");
  await page.addScriptTag({ content: PAGE_SCRIPT });
  if (sliceMs) await page.evaluate((ms) => window.__wpos.configure({ sliceMs: ms }), sliceMs);
  return {
    page,
    createOffer: () => page.evaluate(() => window.__wpos.createOffer()),
    setAnswer: (sdp) => page.evaluate((a) => window.__wpos.setAnswer(a), sdp),
    onSlice: (cb) => { onSlice = cb; },
    onStatus: (cb) => { onStatus = cb; },
    playFixture: (b64) => page.evaluate((w) => window.__wpos.playFixture(w), b64),
    stop: () => page.evaluate(() => window.__wpos.stop()),
    leave: async () => { try { await page.evaluate(() => window.__wpos.leave()); } catch { /* page gone */ } await context.close().catch(() => {}); },
  };
}

// ── Modes ────────────────────────────────────────────────────────────────────

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

async function doctor() {
  const rows = [];
  const row = (what, ok, detail) => { rows.push(ok); console.log(`${ok ? "OK     " : "MISSING"} ${what}${detail ? ` — ${detail}` : ""}`); };
  row("service account in the environment", Boolean(process.env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON ?? process.env.GSC_SERVICE_ACCOUNT_JSON), "GSC_SERVICE_ACCOUNT_JSON via vault:run");
  row("Access service token in the environment", Boolean(process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET), "CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET via vault:run");
  try { const b = await getBrowser(); row("headless Chromium (Playwright)", true, b.version()); await b.close(); browser = null; } catch (err) { row("headless Chromium (Playwright)", false, `${err.message} — npx playwright install chromium`); }
  try {
    const g = await googleClient();
    await g.token([g.subject ? "https://www.googleapis.com/auth/meetings.space.readonly" : ""], g.subject);
    row("meetings.space.readonly mints for the partner", true, g.subject);
    try { await g.token(["https://www.googleapis.com/auth/meetings.conference.media.readonly"], g.subject); row("Media API scope delegated", true); }
    catch (err) { row("Media API scope delegated", false, err.code === "scope_missing" ? "the named stop: add https://www.googleapis.com/auth/meetings.conference.media.readonly to client 109529914046573753934 in the westpeek.ventures admin console" : err.message); }
  } catch (err) { row("Google client", false, err.message); }
  try { const r = await workerCall("/api/meet/live/heartbeat", { device_id: `${DEVICE_ID}-doctor`, version: VERSION, media_scope: "UNKNOWN", detail: "doctor" }); row(`Worker heartbeat at ${BASE_URL}`, r.status === 200, r.status === 200 ? `${r.body.due.length} meeting(s) in window` : `${r.status} ${r.body?.error ?? ""}`); }
  catch (err) { row(`Worker at ${BASE_URL}`, false, err.message); }
  process.exit(rows.every(Boolean) ? 0 : 1);
}

/** Play a WAV through the real peer page into a session the caller already opened. Proves the pipe without a Meet. */
async function fixture() {
  const wav = arg("--fixture");
  const sessionId = arg("--session");
  if (!wav || !sessionId) { console.error("--fixture <wav> --session <id> [--base <url>] [--slice-ms <n>]"); process.exit(2); }
  if (!existsSync(wav)) { console.error(`no such file: ${wav}`); process.exit(2); }
  const sliceMs = Number(arg("--slice-ms") ?? 4000);
  const peer = await createPeerPage(log, { sliceMs });
  const results = [];
  let seq = 0;
  const pending = [];
  // --dump <dir>: keep each slice on disk as well, so the exact bytes the peer page produced can be
  // played to a transcription service by hand (the encoding proof).
  const dump = arg("--dump");
  peer.onSlice((slice) => {
    if (dump) writeFileSync(path.join(dump, `slice-${seq}.webm`), Buffer.from(slice.audio_base64, "base64"));
    const p = workerCall(`/api/meet/live/sessions/${sessionId}/chunk`, { ...slice, sequence: seq++ }).then((r) => { results.push(r); log(`slice ${results.length}: HTTP ${r.status} ${r.body?.error ?? ""} ${r.body?.detail ?? ""} ${r.body?.turns_written !== undefined ? `${r.body.turns_written} turn(s)` : ""}`.trim()); });
    pending.push(p);
  });
  peer.onStatus(async (s) => { if (s.state === "JOINED") await workerCall(`/api/meet/live/sessions/${sessionId}/report`, { state: "LISTENING", detail: "fixture playing through the peer page" }); });
  const b64 = readFileSync(wav).toString("base64");
  const duration = await peer.playFixture(b64);
  log(`fixture played: ${duration.toFixed(1)}s`);
  await peer.stop();
  await new Promise((r) => setTimeout(r, 500));
  await Promise.all(pending);
  await peer.leave();
  await browser?.close();
  console.log(JSON.stringify({ slices: results.length, statuses: results.map((r) => r.status) }));
  process.exit(results.length > 0 ? 0 : 1);
}

async function run() {
  const g = await googleClient();
  const listener = createListener({
    worker: workerCall,
    google: g,
    createPeer: () => createPeerPage(log),
    now: () => Date.now(),
    log,
    deviceId: DEVICE_ID,
    subject: g.subject,
  });
  const stop = async (sig) => { log(`${sig}: leaving every call`); await listener.shutdown(`listener stopped (${sig})`); await browser?.close(); process.exit(0); };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  log(`listener ${VERSION} on ${DEVICE_ID} → ${BASE_URL}, joining as ${g.subject}`);
  for (;;) {
    try {
      const out = await listener.cycle();
      if (has("--once")) { console.log(JSON.stringify(out)); await listener.shutdown("once"); await browser?.close(); process.exit(0); }
    } catch (err) {
      log(`cycle failed: ${err?.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (has("--self-test")) {
  selfTest().then((r) => { console.log(`LIVE-LISTENER SELF-TEST PASSED: ${r.calls} calls, ${r.reports} reports, ${r.chunks} slices through the fake Meet`); process.exit(0); })
    .catch((err) => { console.error(`LIVE-LISTENER SELF-TEST FAILED: ${err.message}`); process.exit(1); });
} else if (has("--doctor")) {
  doctor().catch((err) => { console.error(err.message); process.exit(1); });
} else if (has("--fixture")) {
  fixture().catch((err) => { console.error(err.message); process.exit(1); });
} else {
  run().catch((err) => { console.error(err.message); process.exit(1); });
}
