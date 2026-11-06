import type { Env } from "../env";
import { appendEvent } from "../events";
import { BRAND_SEND_SETTING, SPAM_PAUSE_SETTING, brandDisplayName } from "../../shared/tlc/learningClub";

/**
 * A SPAM COMPLAINT PAUSES ALL BRAND SENDING (owner, 6 Nov 2026; risk brain R-EML-04). One complaint, from any brand,
 * turns the brand-send switch off, so nothing more goes to any brand, and raises a named stop she sees:
 *   1. ONE email to her ("Brand emails are paused: a spam complaint"), saying which brand and what restarts it;
 *   2. TLC_SPAM_COMPLAINT on Boss OS Open Loops (seq23/west-peek-os#TLC_SPAM_COMPLAINT), posted cleared once she has
 *      turned sending back on and the gate is open again (`clearSpamPause`, called by the drip pass).
 * The brand that complained is stopped for good by the caller (stage STOPPED). Sending restarts only on her switch.
 */
export const SPAM_PAUSE_LOOP = "seq23/west-peek-os#TLC_SPAM_COMPLAINT";
const OPEN_LOOPS_REPO = "seq23/west-peek-os";
const OPEN_LOOPS_BUSINESS = "west-peek-ventures";

async function reportSpamStop(env: Env, why: string | null): Promise<string> {
  const { reportToOpenLoops } = await import("./openLoops");
  const out = await reportToOpenLoops({
    repo: OPEN_LOOPS_REPO,
    business: OPEN_LOOPS_BUSINESS,
    finish: "Learning Club brand emails are sending again",
    known: ["TLC_SPAM_COMPLAINT"],
    stops: why ? [{ code: "TLC_SPAM_COMPLAINT", why }] : [],
    words: { TLC_SPAM_COMPLAINT: { title: "Learning Club brand emails are paused: a spam complaint", next_step: "Read Wynn's email, then turn brand sending back on when you are ready", owner: "sequoia" } },
  }, { url: env.WP_OS_BOSS_OPEN_LOOPS_URL ?? "", token: env.WP_OS_BOSS_OPEN_LOOPS_TOKEN ?? "" }).catch((err) => ({ line: `open loops: not sent (${err instanceof Error ? err.message : String(err)})` }));
  return out.line;
}

const putSetting = (env: Env, key: string, value: string, by: string, at: string) =>
  env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by, set_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at")
    .bind(key, value, by, at).run();

/** A complaint arrived: switch off, the pause recorded, her email and the named stop. Returns a line for the log. */
export async function pauseForSpamComplaint(env: Env, input: { brands: readonly string[]; subject: string; now: Date; firmScope: string }): Promise<string> {
  const at = input.now.toISOString();
  const brands = [...new Set(input.brands.map(brandDisplayName))];
  const who = brands.join(", ") || "a brand";
  await putSetting(env, BRAND_SEND_SETTING, "off", "tlc_spam_complaint", at);
  await putSetting(env, SPAM_PAUSE_SETTING, JSON.stringify({ at, brands }), "tlc_spam_complaint", at);
  const day = input.now.toLocaleDateString("en-US", { timeZone: "America/Chicago", day: "numeric", month: "long", year: "numeric" });
  const { emailOwner } = await import("./learningClub");
  const sent = await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: "Brand emails are paused · a spam complaint",
      tldr: `Brand emails are paused: ${who} marked our email as spam on ${day}. Nothing goes to any brand until you turn brand sending back on.`,
      tldrBullets: [`${who} is stopped for good`, "Every other brand's emails wait, nothing is lost"],
      sections: [
        { label: "What happened", bullets: [`A spam complaint about our email to ${who}`, `Their message: "${input.subject.slice(0, 160)}"`] },
        { label: "To restart", bullets: ["Open the Learning Club page in West Peek OS and turn brand sending back on", "Emails already approved go on the next pass after that"] },
      ],
    },
    objectType: "tlc_spam_pause", objectId: at, cardId: null, cardKind: null, firmScope: input.firmScope,
  }).catch(() => [] as string[]);
  const reported = await reportSpamStop(env, `${who} marked our email as spam on ${day}; all brand sending is off until she turns it back on`);
  await appendEvent(env, { eventType: "tlc.spam_complaint", actorType: "system", actorId: "inbound_email", objectType: "open_loop", objectId: SPAM_PAUSE_LOOP, firmScope: input.firmScope, payload: { brands, told: sent.length > 0, open_loops: reported } });
  return `NAMED STOP [TLC_SPAM_COMPLAINT] ${who}: all brand sending paused; ${sent.length ? "she was told by email" : "her email could not be sent (the Open Loops row stands)"}; ${reported}`;
}

/** The gate is open again (she turned sending back on): the pause record goes and the stop is posted cleared. */
export async function clearSpamPause(env: Env, firmScope: string): Promise<string | null> {
  const row = await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(SPAM_PAUSE_SETTING).first<{ value: string | null }>();
  if (!row) return null;
  await env.WP_OS_DB.prepare("DELETE FROM tlc_setting WHERE key = ?1").bind(SPAM_PAUSE_SETTING).run();
  const reported = await reportSpamStop(env, null);
  await appendEvent(env, { eventType: "tlc.spam_complaint", actorType: "system", actorId: "tlc_drip", objectType: "open_loop", objectId: SPAM_PAUSE_LOOP, firmScope, payload: { cleared: true, open_loops: reported } });
  return `spam-complaint pause cleared (${reported})`;
}
