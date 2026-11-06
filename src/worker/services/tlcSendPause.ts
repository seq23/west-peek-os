import type { Env } from "../env";
import { appendEvent } from "../events";
import { textBodyOf } from "../effects/mimeAttachments";
import { addressIn, authenticationVerdict } from "../../shared/intake/partnerAuthority";
import { newTextOf } from "../../shared/events/packetDecisionToken";
import { herNoteOf } from "../../shared/tlc/brandReply";
import { PITCH_APPROVAL_HASH_SETTING, PLAYBOOK_APPROVAL_HASH_SETTING, TLC_OWNER, approvalState } from "../../shared/tlc/learningClub";

/**
 * BRAND EMAILS NEVER STOP SILENTLY (owner, 4 Nov 2026). Approved drafts sat unsent for three days: a sales-playbook
 * change (#313) and a brand-pitch change (#319) each voided her approval of the old text (approvals are of exact
 * content), so the send gate read CHANGED / CHANGED for 186 drip passes, and said so only inside a job summary.
 *
 * Now, when the gate is closed because the pitch or the playbook CHANGED:
 *   1. Wynn sends her ONE email per new content (de-duplicated on the hashes): "Brand emails are paused: the pitch
 *      changed on <date>. What changed: <the changed lines>. Reply 'approve' to restart." Her authenticated "approve"
 *      on that thread approves exactly the content the email described (a newer change gets its own email).
 *   2. A named stop, TLC_SEND_PAUSED, is reported to Boss OS Open Loops through its one-call reporter
 *      (services/openLoops.ts; a row seq23/west-peek-os#TLC_SEND_PAUSED), and posted cleared (cleared: true) once the
 *      gate opens again. Each report is also on the event spine (`tlc.send_paused`).
 * A code change that alters brand copy therefore pauses sending AND tells her, in the same pass.
 */

export const SEND_PAUSE_REF_RE = /\bTLP-[A-Z0-9]{6}\b/;
export const SEND_PAUSE_LOOP = "seq23/west-peek-os#TLC_SEND_PAUSED";
/** The last notice: { key, ref, at, pitch, playbook } as JSON. */
export const PAUSE_NOTICE_SETTING = "send_pause_notice";
/** Present while the named stop is raised. */
export const PAUSE_RAISED_SETTING = "send_pause_raised";
/** The words she approved, kept so a change can be listed line by line. */
export const APPROVED_TEXT_SETTING = { pitch: "pitch_approved_text", playbook: "playbook_approved_text" } as const;

const OPEN_LOOPS_REPO = "seq23/west-peek-os";
const OPEN_LOOPS_BUSINESS = "west-peek-ventures";

/** The stop on Boss OS Open Loops: raised with plain words for her page, or (stop = null) posted cleared. */
async function reportStop(env: Env, stop: { why: string } | null): Promise<string> {
  const { reportToOpenLoops } = await import("./openLoops");
  const out = await reportToOpenLoops({
    repo: OPEN_LOOPS_REPO,
    business: OPEN_LOOPS_BUSINESS,
    finish: "Learning Club brand emails are sending again",
    known: ["TLC_SEND_PAUSED"],
    stops: stop ? [{ code: "TLC_SEND_PAUSED", why: stop.why }] : [],
    words: { TLC_SEND_PAUSED: { title: "Learning Club brand emails are paused", next_step: "Reply approve to Wynn's paused-emails email", owner: "sequoia" } },
  }, { url: env.WP_OS_BOSS_OPEN_LOOPS_URL ?? "", token: env.WP_OS_BOSS_OPEN_LOOPS_TOKEN ?? "" }).catch((err) => ({ line: `open loops: not sent (${err instanceof Error ? err.message : String(err)})` }));
  return out.line;
}

interface PauseNotice { key: string; ref: string; at: string; pitch: string; playbook: string }

const mintRef = (): string => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `TLP-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => abc[b % abc.length]).join("")}`;
};
const dayWords = (at: Date): string => at.toLocaleDateString("en-US", { timeZone: "America/Chicago", day: "numeric", month: "long", year: "numeric" });

async function getSetting(env: Env, key: string): Promise<string | null> {
  return (await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(key).first<{ value: string | null }>())?.value ?? null;
}
async function putSetting(env: Env, key: string, value: string | null, by: string): Promise<void> {
  if (value === null) { await env.WP_OS_DB.prepare("DELETE FROM tlc_setting WHERE key = ?1").bind(key).run(); return; }
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by, set_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at")
    .bind(key, value, by, new Date().toISOString()).run();
}

/** The changed lines, in plain words: what is new or reworded, and what went. PURE. */
export function changedLines(before: string | null, now: string, max = 12): string[] {
  const cut = (l: string) => (l.length > 220 ? `${l.slice(0, 219)}…` : l);
  if (before === null) return ["The words you approved before were not kept (they are from now on), so the old lines cannot be shown. Open the Learning Club page to read the current pitch and playbook."];
  const was = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
  const is = new Set(now.split("\n").map((l) => l.trim()).filter(Boolean));
  const added = [...is].filter((l) => !was.has(l)).map((l) => `Now: ${cut(l)}`);
  const removed = [...was].filter((l) => !is.has(l)).map((l) => `Was: ${cut(l)}`);
  const all = [...added, ...removed];
  return all.length > max ? [...all.slice(0, max), `…and ${all.length - max} more line(s), on the Learning Club page.`] : all;
}

/**
 * Each drip pass. Gate closed for a CHANGED reason and not yet told for these hashes: one email to her, the stop raised.
 * Gate open with the stop raised: the stop cleared. Returns a line for the job summary.
 */
export async function tellSendPause(env: Env, now: Date, firmScope: string, gate: { open: boolean }): Promise<string> {
  const { contentHashes, contentTexts, emailOwner, tlcSettings } = await import("./learningClub");
  const raised = await getSetting(env, PAUSE_RAISED_SETTING);
  if (gate.open) {
    if (!raised) return "sending is on";
    await putSetting(env, PAUSE_RAISED_SETTING, null, "tlc_drip");
    const reported = await reportStop(env, null);
    await appendEvent(env, { eventType: "tlc.send_paused", actorType: "system", actorId: "tlc_drip", objectType: "open_loop", objectId: SEND_PAUSE_LOOP, firmScope, payload: { loop: SEND_PAUSE_LOOP, cleared: true, ref: raised, open_loops: reported } });
    return `brand sending reopened; ${SEND_PAUSE_LOOP} cleared (${reported})`;
  }
  const settings = await tlcSettings(env);
  const hashes = await contentHashes(env);
  const pitch = approvalState(settings, PITCH_APPROVAL_HASH_SETTING, hashes.pitch, hashes.pitchWords) === "CHANGED";
  const playbook = approvalState(settings, PLAYBOOK_APPROVAL_HASH_SETTING, hashes.playbook, hashes.playbookWords) === "CHANGED";
  if (!pitch && !playbook) return "sending is off for another reason (no content change to tell her about)";
  const key = `${pitch ? hashes.pitch : "-"}|${playbook ? hashes.playbook : "-"}`;
  const last = (() => { try { return JSON.parse(settings[PAUSE_NOTICE_SETTING] ?? "null") as PauseNotice | null; } catch { return null; } })();
  if (last?.key === key) return `paused; she was told on ${last.at.slice(0, 10)} (${last.ref})`;

  const texts = await contentTexts(env);
  const what = pitch && playbook ? "the brand pitch and the sales playbook" : pitch ? "the brand pitch" : "the sales playbook";
  const lines = [
    ...(pitch ? changedLines(settings[APPROVED_TEXT_SETTING.pitch] ?? null, texts.pitch).map((l) => `Pitch · ${l}`) : []),
    ...(playbook ? changedLines(settings[APPROVED_TEXT_SETTING.playbook] ?? null, texts.playbook).map((l) => `Playbook · ${l}`) : []),
  ];
  const ref = mintRef();
  const sent = await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: `Brand emails are paused · ${ref}`,
      tldr: `Brand emails are paused: ${what} changed on ${dayWords(now)}. Reply 'approve' to restart.`,
      tldrBullets: ["Reply \"approve\" to restart sending"],
      sections: [
        { label: "What changed", bullets: lines.slice(0, 6) },
        { label: "On your word", bullets: ["\"approve\" approves exactly the content this email describes", "Emails you already approved are kept, and go on the next pass", "Until then, nothing goes to a brand"] },
      ],
      details: ["What changed, in full:", ...lines, "", `Ref ${ref}`].join("\n"),
    },
    objectType: "tlc_send_pause", objectId: ref, cardId: null, cardKind: null, firmScope,
  });
  if (sent.length === 0) return "paused; the notice to her could not be sent, the next pass tries again";
  const notice: PauseNotice = { key, ref, at: now.toISOString(), pitch: hashes.pitch, playbook: hashes.playbook };
  await putSetting(env, PAUSE_NOTICE_SETTING, JSON.stringify(notice), "aie_wynn");
  await putSetting(env, PAUSE_RAISED_SETTING, ref, "aie_wynn");
  const reported = await reportStop(env, { why: `${what} changed on ${dayWords(now)}; her approval of the old text no longer holds` });
  await appendEvent(env, { eventType: "tlc.send_paused", actorType: "ai_employee", actorId: "aie_wynn", objectType: "open_loop", objectId: SEND_PAUSE_LOOP, firmScope, payload: { loop: SEND_PAUSE_LOOP, cleared: false, ref, changed: what, open_loops: reported } });
  return `paused; she was told (${ref}): ${what} changed (${reported})`;
}

/**
 * HER "APPROVE" ON THE PAUSE EMAIL. From her authenticated address only; it approves exactly the content the email
 * described (both hashes are stored, with the words), so the next drip pass sends again. A content that changed again
 * since that email is not approved by it: the next pass sends her a new notice.
 */
export async function applySendPauseApproval(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; body: string },
): Promise<{ handled: boolean; ref: string | null; detail: string }> {
  const body = textBodyOf(message.body);
  const ref = SEND_PAUSE_REF_RE.exec(body)?.[0] ?? SEND_PAUSE_REF_RE.exec(message.subject)?.[0] ?? null;
  if (!ref) return { handled: false, ref: null, detail: "no send-pause reference" };
  const last = await getSetting(env, PAUSE_NOTICE_SETTING).then((v) => { try { return JSON.parse(v ?? "null") as PauseNotice | null; } catch { return null; } });
  if (!last || last.ref !== ref) return { handled: false, ref, detail: "not the current send-pause notice" };
  const from = (addressIn(message.fromHeader) ?? "").toLowerCase();
  const approver = ((await getSetting(env, "brand_reply_approver_email")) ?? TLC_OWNER.email).toLowerCase();
  const verdict = authenticationVerdict(message.authenticationResults, from || null);
  if (![TLC_OWNER.email.toLowerCase(), approver].includes(from) || !verdict.passed) {
    await appendEvent(env, { eventType: "tlc.send_pause_refused", actorType: "system", actorId: "inbound_email", objectType: "tlc_send_pause", objectId: ref, payload: { from } });
    return { handled: false, ref, detail: `a reply to ${ref} was not accepted as hers` };
  }
  const said = herNoteOf(newTextOf(body).split(/\r?\n/).filter((l) => !/^\s*Ref\s+TLP-[A-Z0-9]{6}\s*$/.test(l)).join("\n"), TLC_OWNER.name);
  if (!/^\s*(?:approve|approved|yes,? approve)\b/i.test(said)) return { handled: false, ref, detail: `a reply to ${ref} did not say approve` };
  const { contentHashes, contentTexts } = await import("./learningClub");
  const hashes = await contentHashes(env);
  if (hashes.pitch !== last.pitch || hashes.playbook !== last.playbook) {
    return { handled: true, ref, detail: "the content changed again after that email; nothing approved, a new notice follows on the next pass" };
  }
  const texts = await contentTexts(env);
  const by = TLC_OWNER.firmUserId;
  await putSetting(env, PITCH_APPROVAL_HASH_SETTING, hashes.pitch, by);
  await putSetting(env, PLAYBOOK_APPROVAL_HASH_SETTING, hashes.playbook, by);
  await putSetting(env, APPROVED_TEXT_SETTING.pitch, texts.pitch, by);
  await putSetting(env, APPROVED_TEXT_SETTING.playbook, texts.playbook, by);
  await appendEvent(env, { eventType: "tlc.setting", actorType: "firm_user", actorId: by, objectType: "tlc_setting", objectId: "pitch_and_playbook", payload: { what: "approve by email", ref, pitch: hashes.pitch, playbook: hashes.playbook } });
  return { handled: true, ref, detail: "the current brand pitch and playbook are approved; sending restarts on the next pass" };
}
