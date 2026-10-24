import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { mailAuthority } from "../../shared/intake/partnerAuthority";
import { newTextOf } from "../../shared/events/packetDecisionToken";
import { NOTICE_REF_RE, isEmptyReply, parseDraftReply } from "../../shared/tlc/draftReply";
import { TLC_OPT_OUT_LINE, TLC_OWNER, TLC_SIGNATURE, monthWords } from "../../shared/tlc/learningClub";
import { actorForFirmUser, type Actor } from "./authorize";

/**
 * ONE EMAIL FOR A BATCH OF BRAND DRAFTS, APPROVED BY REPLY (owner, 24 Oct 2026).
 *
 * "All drafts awaiting approval come together in ONE email … numbered 1..N with full copy each, approvable by
 * one reply." Never one email per draft. The notice goes on a drip pass when there are drafts no notice has
 * listed yet AND the week's brand batch is finished (or a draft has waited a day), and at
 * most once a day — except that a redraft she asked for ("change 2: …") comes straight back. Drafts that
 * arrive after a notice roll into the next one.
 *
 * Her reply binds ONLY to the drafts listed in the notice it answers (the reference in its subject), and only
 * when the receiving resolver authenticated it as her address. Every brand email still waits for her: a reply
 * is her approval, given the same way as on the Approvals screen, which keeps working.
 */

/** The longest a draft waits for the batch to finish before the notice goes anyway. */
export const DRAFT_MAX_WAIT_MS = 24 * 3_600_000;

interface NoticeItem { n: number; message_id: string; card_id: string; brand: string; month: string; step: number }

interface PendingDraft {
  message_id: string; card_id: string; subject: string; body: string; step: number; redraft_note: string | null; created_at: string;
  brand: string; contact_name: string | null; contact_email: string; why_fit: string | null; month: string; topic: string | null;
}

async function pendingDrafts(env: Env, firmScope: string, onlyUnnoticed: boolean): Promise<PendingDraft[]> {
  return (await env.WP_OS_DB.prepare(
    `SELECT m.id AS message_id, m.approval_card_id AS card_id, m.subject, m.body, m.step, m.redraft_note, m.created_at,
            d.brand, d.contact_name, d.contact_email, d.why_fit, e.month, e.topic
       FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN tlc_event e ON e.id = d.event_id
       JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review'${onlyUnnoticed ? " AND m.notice_ref IS NULL" : ""}
      ORDER BY e.month, d.brand, m.step`,
  ).bind(firmScope).all<PendingDraft>()).results ?? [];
}

function mintRef(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `TLC-${[...bytes].map((b) => abc[b % abc.length]).join("")}`;
}

/** The notice, when one is due. Returns what it did, in words, for the job summary. */
export async function sendDraftNotice(env: Env, now: Date, firmScope = "west-peek", opts: { force?: boolean } = {}): Promise<string> {
  const drafts = await pendingDrafts(env, firmScope, true);
  if (drafts.length === 0) return "no new drafts to list";
  const redraft = drafts.some((d) => d.redraft_note);
  if (!opts.force && !redraft) {
    const today = now.toISOString().slice(0, 10);
    const sentToday = await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_draft_notice WHERE firm_scope = ?1 AND substr(created_at, 1, 10) = ?2 LIMIT 1").bind(firmScope, today).first();
    if (sentToday) return `${drafts.length} new draft(s) roll into tomorrow's notice (one notice a day)`;
    const batchOpen = await env.WP_OS_DB.prepare("SELECT 1 FROM work_card WHERE kind = 'TLC_BRAND_BATCH' AND firm_scope = ?1 AND state NOT IN ('DONE','CANCELLED','BLOCKED') LIMIT 1").bind(firmScope).first();
    // THE BATCH FIRST (owner, 24 Oct 2026: "all drafts … in ONE email"): while the week's batch is still finding
    // brands the notice waits for it, so the whole batch arrives together — unless a draft has already waited a day.
    const oldest = Math.min(...drafts.map((d) => Date.parse(d.created_at)));
    if (batchOpen && now.getTime() - oldest < DRAFT_MAX_WAIT_MS) return `${drafts.length} draft(s) wait for the week's batch to finish`;
  }
  // Every undecided draft is listed — the new ones and any an earlier notice listed that she has not decided —
  // so one email always carries the whole queue, numbered once.
  const all = await pendingDrafts(env, firmScope, false);
  const ref = mintRef();
  const items: NoticeItem[] = all.map((d, i) => ({ n: i + 1, message_id: d.message_id, card_id: d.card_id, brand: d.brand, month: d.month, step: d.step }));
  const months = [...new Set(all.map((d) => d.month))];
  const sections = months.flatMap((m) => {
    const rows = items.filter((it) => it.month === m).map((it) => {
      const d = all[it.n - 1]!;
      return `${it.n} · ${d.brand} — ${d.contact_name ? `${d.contact_name} ` : ""}<${d.contact_email}>${d.step > 0 ? `, email ${d.step + 1} of 4` : ""}${d.redraft_note ? " (redrafted)" : ""}`;
    });
    const chunks: string[][] = [];
    for (let i = 0; i < rows.length; i += 6) chunks.push(rows.slice(i, i + 6));
    return chunks.map((bullets, i) => ({ label: `${monthWords(m)}${chunks.length > 1 ? ` (${i + 1} of ${chunks.length})` : ""}`, bullets }));
  });
  const details = all.map((d, i) => [
    `── ${i + 1} · ${d.brand} · ${monthWords(d.month)}${d.topic ? ` (${d.topic})` : ""} · email ${d.step + 1} of 4 ──`,
    `To: ${d.contact_name ? `${d.contact_name} ` : ""}<${d.contact_email}>`,
    `Why this brand: ${d.why_fit ?? "on your must-pitch list"}`,
    ...(d.redraft_note ? [`Redrafted for your note: ${d.redraft_note}`] : []),
    `Subject: ${d.subject}`,
    "",
    d.body,
  ].join("\n")).join("\n\n");
  const { emailOwner } = await import("./learningClub");
  const sent = await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: `TLC: ${all.length} brand email${all.length === 1 ? "" : "s"} to approve · ${ref}`,
      tldr: `${all.length} brand email${all.length === 1 ? " is" : "s are"} drafted and waiting for you; the full text of each is below. Nothing goes to a brand until you approve it.`,
      tldrBullets: ['Reply "approve all"', 'Or "approve 1, 3" · "skip 2" · "change 2: what to change"'],
      sections: [...sections, { label: "Also on Approvals", bullets: ["Each draft is on the Approvals screen too, if you would rather decide there."] }],
      details,
    },
    objectType: "tlc_drip",
    objectId: ref,
    cardId: null,
    cardKind: null,
    firmScope,
  }).catch(() => [] as string[]);
  if (sent.length === 0) return `the notice for ${all.length} draft(s) could not be sent; the next pass tries again`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_draft_notice (ref, items_json, firm_scope) VALUES (?1, ?2, ?3)").bind(ref, JSON.stringify(items), firmScope).run();
  for (const it of items) await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET notice_ref = ?2 WHERE id = ?1").bind(it.message_id, ref).run();
  return `notice ${ref} listing ${all.length} draft(s) sent to ${sent.join(", ")}`;
}

// ── Her reply ───────────────────────────────────────────────────────────────────────────────────

export type Redrafter = (env: Env, actor: Actor, input: { subject: string; body: string; note: string; brand: string }) => Promise<{ ok: boolean; subject: string; body: string; detail: string }>;

const defaultRedraft: Redrafter = async (env, actor, input) => {
  const prompt = [
    "You are Wynn, who writes The Learning Club's partnership emails for Sequoia Taylor of West Peek Ventures. Rewrite this email to a brand following her note exactly.",
    "Keep it short, warm and plain. Keep any facts already in it; add no new facts, numbers, prices or claims. No attachments, no price unless her note asks.",
    "Do NOT include a signature or an unsubscribe line; they are added after.",
    `Her note: ${input.note}`,
    `Brand: ${input.brand}`,
    `Current subject: ${input.subject}`,
    "Current body:",
    input.body,
    'Return ONLY JSON: {"subject":"","body":""}',
  ].join("\n");
  const { run } = await runAi(env, {
    purpose: "The Learning Club: redraft a brand email",
    actor,
    inputs: [prompt],
    sensitivity: "PUBLIC" as never,
    budgetContext: { requiresSearch: false, expectedOutputTokens: 900 },
    routing: { category: "INTELLIGENCE" },
  } as never);
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, subject: "", body: "", detail: run.failure_reason ?? `run ${run.status}` };
  const m = /\{[\s\S]*\}/.exec(run.output_text);
  try {
    const j = JSON.parse(m?.[0] ?? "") as { subject?: string; body?: string };
    if (!j.subject?.trim() || !j.body?.trim()) return { ok: false, subject: "", body: "", detail: "the redraft came back empty" };
    return { ok: true, subject: j.subject.trim().slice(0, 160), body: j.body.trim(), detail: "ok" };
  } catch {
    return { ok: false, subject: "", body: "", detail: "the redraft could not be read" };
  }
};

/** Strip a signature/opt-out the stored body already carries, so a redraft is shown the words alone. */
function wordsOf(body: string): string {
  const cut = body.indexOf(`\n${TLC_SIGNATURE[0]}`);
  return (cut > 0 ? body.slice(0, cut) : body.replace(TLC_OPT_OUT_LINE, "")).trim();
}

export interface DraftReplyOutcome { handled: boolean; ref: string | null; detail: string }

export async function applyTlcDraftReply(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; body: string },
  deps: { now?: Date; redraft?: Redrafter } = {},
): Promise<DraftReplyOutcome> {
  const ref = NOTICE_REF_RE.exec(message.subject)?.[0] ?? NOTICE_REF_RE.exec(message.body)?.[0] ?? null;
  if (!ref) return { handled: false, ref: null, detail: "no notice reference" };
  const notice = await env.WP_OS_DB.prepare("SELECT * FROM tlc_draft_notice WHERE ref = ?1").bind(ref).first<{ ref: string; items_json: string; firm_scope: string }>();
  if (!notice) return { handled: false, ref, detail: "unknown notice reference" };
  const firmScope = notice.firm_scope;
  const authority = mailAuthority({ fromHeader: message.fromHeader, authenticationResults: message.authenticationResults });
  const refuse = async (why: string): Promise<DraftReplyOutcome> => {
    await appendEvent(env, {
      eventType: "tlc.draft_reply_refused", actorType: "system", actorId: "inbound_email", objectType: "tlc_draft_notice", objectId: ref, firmScope,
      payload: { why, from: authority.partnerAddress ?? message.fromHeader, spf: authority.verdict.spf, dkim: authority.verdict.dkim, dmarc: authority.verdict.dmarc },
    });
    return { handled: false, ref, detail: why };
  };
  // HER ADDRESS ONLY, as the receiving resolver authenticated it — never a forwarded origin, never the other partner.
  if (!authority.isAssignment || (authority.partnerAddress ?? "").toLowerCase() !== TLC_OWNER.email.toLowerCase()) {
    return refuse(`a reply to ${ref} was not accepted as coming from ${TLC_OWNER.email}: ${authority.reason ?? "another sender"}`);
  }
  const reply = parseDraftReply(newTextOf(message.body));
  if (isEmptyReply(reply)) return refuse(`a reply to ${ref} carried no approve / skip / change instruction`);
  const actor = await actorForFirmUser(env, TLC_OWNER.firmUserId);
  if (!actor) return refuse(`${TLC_OWNER.email} is not an active person in the OS`);

  const now = deps.now ?? new Date();
  const items = JSON.parse(notice.items_json) as NoticeItem[];
  const byN = new Map(items.map((it) => [it.n, it]));
  const changed = new Set(reply.change.map((c) => c.n));
  const skipped = new Set(reply.skip);
  const approve = new Set(reply.approveAll ? items.map((it) => it.n) : reply.approve);
  for (const n of [...changed, ...skipped]) approve.delete(n);
  const lines: { approved: string[]; skipped: string[]; changed: string[]; problems: string[] } = { approved: [], skipped: [], changed: [], problems: [] };
  const { decideApproval } = await import("./approvals");
  const label = (it: NoticeItem) => `${it.n} · ${it.brand} (${monthWords(it.month)})`;
  const live = async (it: NoticeItem) => {
    const row = await env.WP_OS_DB.prepare("SELECT m.state, a.state AS card_state FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.id = ?1 AND m.approval_card_id = ?2").bind(it.message_id, it.card_id).first<{ state: string; card_state: string }>();
    return row && row.state === "AWAITING_APPROVAL" && row.card_state === "pending_review";
  };
  const unknown = [...new Set([...approve, ...skipped, ...changed])].filter((n) => !byN.has(n));
  if (unknown.length) lines.problems.push(`${unknown.join(", ")}: not in ${ref}, so nothing was done for ${unknown.length === 1 ? "it" : "them"}`);

  for (const n of [...approve].sort((a, b) => a - b)) {
    const it = byN.get(n);
    if (!it) continue;
    if (!(await live(it))) { lines.problems.push(`${label(it)}: already decided, left as it was`); continue; }
    try {
      await decideApproval(env, actor, it.card_id, "approved", `Approved by email reply to ${ref}.`);
      lines.approved.push(label(it));
    } catch (err) {
      lines.problems.push(`${label(it)}: could not be approved (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  for (const n of [...skipped].sort((a, b) => a - b)) {
    const it = byN.get(n);
    if (!it) continue;
    if (!(await live(it))) { lines.problems.push(`${label(it)}: already decided, left as it was`); continue; }
    await decideApproval(env, actor, it.card_id, "rejected", `Skipped by email reply to ${ref}.`).catch(() => undefined);
    await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = ?2 WHERE id = ?1").bind(it.message_id, `skipped by Sequoia (${ref})`).run();
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = NULL, updated_at = ?2 WHERE id = (SELECT deal_id FROM tlc_drip_message WHERE id = ?1)").bind(it.message_id, now.toISOString()).run();
    lines.skipped.push(label(it));
  }
  const wynn: Actor = { type: "AI", aiEmployeeId: "aie_wynn", roles: [], firmScopes: [firmScope] } as Actor;
  for (const c of reply.change) {
    const it = byN.get(c.n);
    if (!it) continue;
    if (!(await live(it))) { lines.problems.push(`${label(it)}: already decided, left as it was`); continue; }
    const row = (await env.WP_OS_DB.prepare(
      "SELECT m.subject, m.body, d.id AS deal_id, d.brand, d.contact_email, d.drip_step FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id WHERE m.id = ?1",
    ).bind(it.message_id).first<{ subject: string; body: string; deal_id: string; brand: string; contact_email: string; drip_step: number }>())!;
    const out = await (deps.redraft ?? defaultRedraft)(env, wynn, { subject: row.subject, body: wordsOf(row.body), note: c.note, brand: row.brand });
    if (!out.ok) { lines.problems.push(`${label(it)}: Wynn could not redraft it (${out.detail}); it is unchanged and still waiting — reply "change ${c.n}: …" again or decide it on Approvals`); continue; }
    const { brandGateFor, fileDraft } = await import("./learningClub");
    // The same gate as the drip: a redraft is filed only while brand sending is approved and on.
    const gate = await brandGateFor(env);
    if (!gate.open) { lines.problems.push(`${label(it)}: not redrafted, brand sending is off (${gate.reasons.join("; ")})`); continue; }
    await decideApproval(env, actor, it.card_id, "rejected", `Redraft asked by email reply to ${ref}: ${c.note}`.slice(0, 1000)).catch(() => undefined);
    await fileDraft(env, { id: row.deal_id, brand: row.brand, contact_email: row.contact_email, drip_step: row.drip_step }, { subject: out.subject, text: [out.body, "", ...TLC_SIGNATURE, "", TLC_OPT_OUT_LINE].join("\n") }, firmScope, c.note);
    lines.changed.push(`${label(it)}: redrafted for "${c.note}"`);
  }

  // What she approved goes now (inside the warm-up allowance); the rest goes on the next pass with room.
  const { runDrip } = await import("./learningClub");
  const drip = lines.approved.length ? await runDrip(env, now, firmScope) : null;
  const { emailOwner } = await import("./learningClub");
  await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: `TLC: your reply to ${ref}, done`,
      tldr: `${lines.approved.length} approved${drip ? ` (${drip.sentBrands.length} sent now${drip.waitingForAllowance ? `, ${drip.waitingForAllowance} go out on the next day's warm-up allowance` : ""})` : ""}, ${lines.skipped.length} skipped, ${lines.changed.length} redrafted.`,
      sections: [
        { label: "Approved", bullets: lines.approved.length ? lines.approved.slice(0, 6) : ["None"] },
        { label: "Sent now", bullets: drip?.sentBrands.length ? drip.sentBrands.slice(0, 6) : ["None yet"] },
        ...(lines.skipped.length ? [{ label: "Skipped (not sent)", bullets: lines.skipped.slice(0, 6) }] : []),
        ...(lines.changed.length ? [{ label: "Redrafted (a new email asks you to approve them)", bullets: lines.changed.slice(0, 6) }] : []),
        ...(lines.problems.length ? [{ label: "Not done", bullets: lines.problems.slice(0, 6) }] : []),
      ],
      details: [...lines.approved.slice(6), ...lines.skipped.slice(6), ...lines.changed.slice(6), ...lines.problems.slice(6)].join("\n") || null,
    },
    objectType: "tlc_drip",
    objectId: `${ref}:reply`,
    cardId: null,
    cardKind: null,
    firmScope,
  }).catch(() => []);
  await appendEvent(env, {
    eventType: "tlc.draft_reply", actorType: "firm_user", actorId: TLC_OWNER.firmUserId, objectType: "tlc_draft_notice", objectId: ref, firmScope,
    payload: { approved: lines.approved, skipped: lines.skipped, changed: lines.changed, problems: lines.problems, sent: drip?.sentBrands ?? [] },
  });
  if (lines.changed.length) await sendDraftNotice(env, now, firmScope, { force: true });
  return { handled: true, ref, detail: `${lines.approved.length} approved, ${lines.skipped.length} skipped, ${lines.changed.length} redrafted` };
}
