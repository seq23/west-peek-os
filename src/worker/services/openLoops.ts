/**
 * OPEN LOOPS: a named stop becomes a row on Boss OS's Open Loops list (seq23/boss-os docs/open-loops.md).
 *
 * The one-call reporter that doc names (seq23/keepmyproof scripts/lib/open-loops.mjs), ported line for line to the
 * Worker: every stop still in force is upserted (one row per repo#CODE); every known code that has cleared is posted
 * `cleared: true`, which closes its row "outcome reached". With no token here it records one line and sends nothing; a
 * failed post is one line and never fails the caller.
 *
 * WHERE IT POSTS: the intake URL docs/open-loops.md names, given as `WP_OS_BOSS_OPEN_LOOPS_URL`. It is configuration, not
 * a constant: Boss OS is a different business, and its domain appears in no source file here (validate:employee-sender).
 *
 * THE CREDENTIAL, BY NAME ONLY: Boss OS's `BOSS_OPEN_LOOPS_TOKEN`, given to this Worker as the secret
 * `WP_OS_BOSS_OPEN_LOOPS_TOKEN` (aliased by scripts/vault/cloudflare-mapping.json; the WP_OS_ prefix is this repo's
 * binding rule). It can only post to the intake. Never logged, never echoed.
 */

export interface OpenLoopStop { code: string; why?: string; title?: string }
export interface OpenLoopsReport {
  repo: string;
  /** A brain slug. */
  business: string;
  /** The real outcome the stops stand in the way of, in plain words. */
  finish: string;
  /** Every stop this gate can raise. */
  known: readonly string[];
  /** The stops still in force now. */
  stops: readonly OpenLoopStop[];
  /** Per-code words for her page and email: title, next_step, owner, next_date. */
  words?: Record<string, Record<string, string>>;
}

/** The posts one report makes, in order. PURE. */
export function intakePosts({ repo, business, finish, known, stops, words = {} }: OpenLoopsReport): Array<Record<string, unknown>> {
  const live = new Map(stops.map((s) => [s.code, s]));
  const posts: Array<Record<string, unknown>> = stops.map((s) => ({ repo, stop: s.code, business, finish_line: finish, ...(words[s.code] ?? {}) }));
  for (const code of known) if (!live.has(code)) posts.push({ repo, stop: code, cleared: true });
  return posts;
}

export async function reportToOpenLoops(
  report: OpenLoopsReport,
  { url, token, fetchImpl = fetch, log = () => undefined }: { url: string | undefined; token: string | undefined; fetchImpl?: typeof fetch; log?: (line: string) => void },
): Promise<{ sent: number; failed: number; skipped: number; line: string }> {
  const posts = intakePosts(report);
  if (!token || !url || !/^https:\/\//.test(url)) {
    const line = `open loops: not reported (no ${!token ? "BOSS_OPEN_LOOPS_TOKEN" : "intake URL"} here); ${posts.length} stop(s) would be sent.`;
    log(line);
    return { sent: 0, failed: 0, skipped: posts.length, line };
  }
  let sent = 0;
  let failed = 0;
  for (const body of posts) {
    try {
      const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      if (r.ok) sent++;
      else { failed++; log(`open loops: ${String(body.stop)} refused (${r.status})`); }
    } catch (e) {
      failed++;
      log(`open loops: ${String(body.stop)} not sent (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const line = `open loops: ${sent} reported, ${failed} failed (${posts.filter((p) => p.cleared).length} cleared).`;
  log(line);
  return { sent, failed, skipped: 0, line };
}
