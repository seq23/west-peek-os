import { textBodyOf } from "../effects/mimeAttachments";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { mailAuthority } from "../../shared/intake/partnerAuthority";
import { newTextOf } from "../../shared/events/packetDecisionToken";
import { NOTICE_REF_RE, isEmptyReply, parseDraftReply } from "../../shared/tlc/draftReply";
import { herNoteOf } from "../../shared/tlc/brandReply";
import { BRAND_GUESTS, BRAND_ROOM_WORDS, TLC_INTERNAL_NOTE, TLC_OWNER, TLC_PS_BY_STEP, TLC_SAMPLES_OFFER, TLC_SEATS, TLC_SIGNATURE, brandDisplayName, dripEmail, monthWords, seatsOf } from "../../shared/tlc/learningClub";
import { actorForFirmUser, type Actor } from "./authorize";

/**
 * ONE TLC EMAIL A WEEK, APPROVED BY REPLY (owner, 24 Oct 2026).
 *
 * "NO TLC email except ONE per week containing ALL the week's brands (all clubs) at once." The email goes on a
 * drip pass once the week's brand batch card has FINISHED (every club, every search, retries included) and none
 * has gone for that card. A club whose searches came back short is named in the same email, with why. Every
 * draft waiting for her is listed, numbered, grouped by club, with its full copy; a brand that said yes is in it
 * with its pitch email to approve. No per-draft email, no "draft ready" ping.
 *
 * Her reply ("approve all", "approve 1, 3", "skip 2", "change 2: …") binds ONLY to the drafts listed in the
 * email it answers (the newest reference in it), and only from her authenticated address. The answer — what was
 * approved and sent, and any redraft in full — is ONE reply on the same thread, carrying its own reference so
 * she can answer it the same way. The Approvals screen keeps working.
 */

type ItemKind = "drip" | "pitch";
interface NoticeItem { n: number; kind?: ItemKind; message_id: string; card_id: string; brand: string; month: string; step: number }

interface PendingDraft {
  kind: ItemKind; message_id: string; card_id: string; subject: string; body: string; step: number; redraft_note: string | null; created_at: string;
  brand: string; contact_name: string | null; contact_email: string; why_fit: string | null; month: string; topic: string | null;
}

async function pendingDrafts(env: Env, firmScope: string): Promise<PendingDraft[]> {
  const drip = (await env.WP_OS_DB.prepare(
    `SELECT 'drip' AS kind, m.id AS message_id, m.approval_card_id AS card_id, m.subject, m.body, m.step, m.redraft_note, m.created_at,
            d.brand, d.contact_name, d.contact_email, d.why_fit, e.month, e.topic
       FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN tlc_event e ON e.id = d.event_id
       JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review'`,
  ).bind(firmScope).all<PendingDraft>()).results ?? [];
  const pitch = (await env.WP_OS_DB.prepare(
    `SELECT 'pitch' AS kind, f.deal_id AS message_id, f.approval_card_id AS card_id, f.subject, f.body, 0 AS step, NULL AS redraft_note, d.updated_at AS created_at,
            d.brand, d.contact_name, d.contact_email, d.why_fit, e.month, e.topic
       FROM tlc_pitch_followup f JOIN tlc_deal d ON d.id = f.deal_id JOIN tlc_event e ON e.id = d.event_id
       JOIN approval_card a ON a.id = f.approval_card_id
      WHERE d.firm_scope = ?1 AND f.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review'`,
  ).bind(firmScope).all<PendingDraft>()).results ?? [];
  // Brands that said yes first (they are waiting on us), then the new drafts, nearest club first.
  const rank = (d: PendingDraft) => (d.kind === "pitch" ? 0 : 1);
  return [...pitch, ...drip].sort((a, b) => rank(a) - rank(b) || a.month.localeCompare(b.month) || a.brand.localeCompare(b.brand) || a.step - b.step);
}

function mintRef(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `TLC-${[...bytes].map((b) => abc[b % abc.length]).join("")}`;
}

/** The numbered list (bullets, by club) and the full copy of each draft (details). */
function listOf(all: readonly PendingDraft[]): { items: NoticeItem[]; sections: Array<{ label: string; bullets: string[] }>; copy: string } {
  const items: NoticeItem[] = all.map((d, i) => ({ n: i + 1, kind: d.kind, message_id: d.message_id, card_id: d.card_id, brand: d.brand, month: d.month, step: d.step }));
  const groups: Array<[string, number[]]> = [];
  all.forEach((d, i) => {
    const key = d.kind === "pitch" ? "Said yes: their pitch email" : monthWords(d.month);
    const g = groups.find((x) => x[0] === key);
    if (g) g[1].push(i); else groups.push([key, [i]]);
  });
  const sections: Array<{ label: string; bullets: string[] }> = [];
  for (const [label, idx] of groups) {
    const rows = idx.map((i) => {
      const d = all[i]!;
      return `${i + 1} · ${d.brand} — ${d.contact_name ? `${d.contact_name} ` : ""}<${d.contact_email}>${d.kind === "pitch" ? ` (${monthWords(d.month)})` : d.step > 0 ? `, email ${d.step + 1} of 4` : ""}${d.redraft_note ? " (redrafted)" : ""}`;
    });
    for (let i = 0; i < rows.length; i += 6) sections.push({ label: rows.length > 6 ? `${label} (${i / 6 + 1} of ${Math.ceil(rows.length / 6)})` : label, bullets: rows.slice(i, i + 6) });
  }
  const copy = all.map((d, i) => [
    `── ${i + 1} · ${d.brand} · ${monthWords(d.month)}${d.topic ? ` (${d.topic})` : ""} · ${d.kind === "pitch" ? "pitch email (they said yes)" : `email ${d.step + 1} of 4`} ──`,
    `To: ${d.contact_name ? `${d.contact_name} ` : ""}<${d.contact_email}>`,
    `Why this brand: ${d.why_fit ?? "on your must-pitch list"}`,
    ...(d.redraft_note ? [`Redrafted for your note: ${d.redraft_note}`] : []),
    `Subject: ${d.subject}`,
    "",
    d.body,
  ].join("\n")).join("\n\n");
  return { items, sections, copy };
}

/** Clubs this week's batch came back short for, with why — said in the weekly email, never a separate one. */
async function shortClubs(env: Env, cardId: string, firmScope: string, now: Date): Promise<string[]> {
  const rows = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'tlc.batch_club_done' ORDER BY created_at").bind(cardId).all<{ payload_json: string }>()).results ?? [];
  const byMonth = new Map<string, { n: number; why: string[] }>();
  for (const r of rows) {
    const p = JSON.parse(r.payload_json) as { month: string; added?: string[]; queued?: string[]; dropped?: string[]; wayIn?: string[] };
    const m = byMonth.get(p.month) ?? { n: 0, why: [] };
    m.n += (p.added?.length ?? 0) + (p.queued?.length ?? 0);
    m.why.push(...(p.dropped ?? []).slice(0, 2), ...(p.wayIn ?? []).map((w) => w.split(". Pages checked")[0]!).slice(0, 2));
    byMonth.set(p.month, m);
  }
  const events = (await env.WP_OS_DB.prepare("SELECT id, month FROM tlc_event WHERE firm_scope = ?1 AND status IN ('TOPIC_READY','GO','ESCALATED') ORDER BY month").bind(firmScope).all<{ id: string; month: string }>()).results ?? [];
  // A club that started new brands this week from Parker's list is not short, whatever Wynn's own search found.
  const { startedThisWeek } = await import("./tlcVolume");
  const fromList = new Set<string>();
  for (const e of events) if ((await startedThisWeek(env, e.id, now)) > 0) fromList.add(e.month);
  return events.filter((e) => (byMonth.get(e.month)?.n ?? 0) === 0 && !fromList.has(e.month)).map((e) => {
    const why = byMonth.get(e.month)?.why ?? [];
    return `${monthWords(e.month)}: no new brand this week${why.length ? ` — ${why.slice(0, 2).join("; ")}` : byMonth.has(e.month) ? "" : " — its searches did not finish"}`.slice(0, 300);
  });
}

/** This week's email, once the week's batch card has finished. Returns what it did, in words, for the job summary. */
export async function sendDraftNotice(env: Env, now: Date, firmScope = "west-peek"): Promise<string> {
  const card = await env.WP_OS_DB.prepare("SELECT id, state FROM work_card WHERE kind = 'TLC_BRAND_BATCH' AND firm_scope = ?1 AND state != 'CANCELLED' ORDER BY created_at DESC LIMIT 1").bind(firmScope).first<{ id: string; state: string }>();
  if (!card) return "no brand batch yet";
  if (!["DONE", "BLOCKED"].includes(card.state)) return "waiting for the week's batch to finish";
  if (await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_draft_notice WHERE batch_card_id = ?1").bind(card.id).first()) return "this week's email already went";
  const all = await pendingDrafts(env, firmScope);
  const short = await shortClubs(env, card.id, firmScope, now);
  // WHERE EACH CLUB STANDS (owner, 26 Oct 2026): agreed cash against the $25,000 goal, and pitched / replied / yes.
  const { clubProgress } = await import("./tlcVolume");
  const progress = await clubProgress(env, firmScope, now);
  const ref = mintRef();
  const { items, sections, copy } = listOf(all);
  const { emailOwner } = await import("./learningClub");
  const sent = await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: `TLC: this week's brands, ${all.length} to approve · ${ref}`,
      tldr: all.length
        ? `${all.length} brand email${all.length === 1 ? " is" : "s are"} ready for you, every club at once; the full text of each is below. Nothing goes to a brand until you approve it.`
        : "No brand email is waiting for you this week; why is below.",
      ...(all.length ? { tldrBullets: ['Reply "approve all"', 'Or "approve 1, 3" · "skip 2" · "change 2: what to change"'] } : {}),
      sections: [
        ...(progress.length ? [{ label: "Where each club stands", bullets: progress }] : []),
        ...sections,
        ...(short.length ? [{ label: "Short this week", bullets: short.slice(0, 6) }] : []),
        { label: "Also on Approvals", bullets: ["Each draft is on the Approvals screen too, if you would rather decide there."] },
      ],
      details: [`Ref ${ref}`, "", copy].join("\n"),
    },
    objectType: "tlc_drip",
    objectId: ref,
    cardId: null,
    cardKind: null,
    firmScope,
  }).catch(() => [] as string[]);
  if (sent.length === 0) return `this week's email (${all.length} draft(s)) could not be sent; the next pass tries again`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_draft_notice (ref, items_json, firm_scope, batch_card_id, root_ref) VALUES (?1, ?2, ?3, ?4, ?1)").bind(ref, JSON.stringify(items), firmScope, card.id).run();
  for (const it of items) if (it.kind !== "pitch") await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET notice_ref = ?2 WHERE id = ?1").bind(it.message_id, ref).run();
  return `this week's email ${ref} listing ${all.length} draft(s)${short.length ? `, ${short.length} club(s) short` : ""} sent to ${sent.join(", ")}`;
}

// ── Her reply ───────────────────────────────────────────────────────────────────────────────────

export type Redrafter = (env: Env, actor: Actor, input: { subject: string; body: string; note: string; brand: string }) => Promise<{ ok: boolean; subject: string; body: string; detail: string }>;

const defaultRedraft: Redrafter = async (env, actor, input) => {
  const prompt = [
    "You are Wynn, who writes The Learning Club's partnership emails for Sequoia Taylor of West Peek Ventures. Rewrite this email to a brand following her note exactly.",
    "Keep it short, warm and plain. Keep any facts already in it; add no new facts, numbers, prices or claims. No attachments, no price unless her note asks.",
    "Do NOT include a signature or a P.S.; they are added after.",
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

/** The words alone: the stored body without its signature and P.S. */
function wordsOf(body: string): string {
  const cut = body.indexOf(`\n${TLC_SIGNATURE[0]}`);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
}

export interface DraftReplyOutcome { handled: boolean; ref: string | null; detail: string }

export async function applyTlcDraftReply(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; body: string },
  deps: { now?: Date; redraft?: Redrafter } = {},
): Promise<DraftReplyOutcome> {
  // THE NEWEST REFERENCE: her reply quotes the email it answers first, so the body's first reference is that
  // email's; the subject keeps the week's first reference, so it is the fallback.
  // THE WORDS, NOT THE MIME: a raw message's header block starts with "From:", which `newTextOf` reads as a quote
  // marker, so her "Approve all" on TLC-ZF84KK (24 Oct 2026) came out empty. Decoding is a no-op on plain text.
  const body = textBodyOf(message.body);
  const ref = NOTICE_REF_RE.exec(body)?.[0] ?? NOTICE_REF_RE.exec(message.subject)?.[0] ?? null;
  if (!ref) return { handled: false, ref: null, detail: "no notice reference" };
  const notice = await env.WP_OS_DB.prepare("SELECT * FROM tlc_draft_notice WHERE ref = ?1").bind(ref).first<{ ref: string; items_json: string; firm_scope: string; root_ref: string | null }>();
  if (!notice) return { handled: false, ref, detail: "unknown notice reference" };
  const firmScope = notice.firm_scope;
  const rootRef = notice.root_ref ?? notice.ref;
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
  // Her words without her signature (owner, 26 Oct 2026): a change note runs onto later lines, so the sign-off must go.
  const reply = parseDraftReply(herNoteOf(newTextOf(body), TLC_OWNER.name));
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
  const live = async (it: NoticeItem): Promise<boolean> => {
    const row = it.kind === "pitch"
      ? await env.WP_OS_DB.prepare("SELECT f.state, a.state AS card_state FROM tlc_pitch_followup f JOIN approval_card a ON a.id = f.approval_card_id WHERE f.deal_id = ?1 AND f.approval_card_id = ?2").bind(it.message_id, it.card_id).first<{ state: string; card_state: string }>()
      : await env.WP_OS_DB.prepare("SELECT m.state, a.state AS card_state FROM tlc_drip_message m JOIN approval_card a ON a.id = m.approval_card_id WHERE m.id = ?1 AND m.approval_card_id = ?2").bind(it.message_id, it.card_id).first<{ state: string; card_state: string }>();
    return Boolean(row && row.state === "AWAITING_APPROVAL" && row.card_state === "pending_review");
  };
  const unknown = [...new Set([...approve, ...skipped, ...changed])].filter((n) => !byN.has(n));
  if (unknown.length) lines.problems.push(`${unknown.join(", ")}: not in that email, so nothing was done for ${unknown.length === 1 ? "it" : "them"}`);

  for (const n of [...approve].sort((a, b) => a - b)) {
    const it = byN.get(n);
    if (!it) continue;
    if (!(await live(it))) { lines.problems.push(`${label(it)}: already decided, left as it was`); continue; }
    try {
      await decideApproval(env, actor, it.card_id, "approved", `Approved by email reply (${ref}).`);
      lines.approved.push(label(it));
    } catch (err) {
      lines.problems.push(`${label(it)}: could not be approved (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  for (const n of [...skipped].sort((a, b) => a - b)) {
    const it = byN.get(n);
    if (!it) continue;
    if (!(await live(it))) { lines.problems.push(`${label(it)}: already decided, left as it was`); continue; }
    await decideApproval(env, actor, it.card_id, "rejected", `Skipped by email reply (${ref}).`).catch(() => undefined);
    if (it.kind === "pitch") {
      await env.WP_OS_DB.prepare("UPDATE tlc_pitch_followup SET state = 'HELD', held_reason = ?2 WHERE deal_id = ?1").bind(it.message_id, `skipped by Sequoia (${ref})`).run();
    } else {
      await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = ?2 WHERE id = ?1").bind(it.message_id, `skipped by Sequoia (${ref})`).run();
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = NULL, updated_at = ?2 WHERE id = (SELECT deal_id FROM tlc_drip_message WHERE id = ?1)").bind(it.message_id, now.toISOString()).run();
    }
    lines.skipped.push(label(it));
  }
  const wynn = { type: "AI", aiEmployeeId: "aie_wynn", roles: [], firmScopes: [firmScope] } as unknown as Actor;
  for (const c of reply.change) {
    const it = byN.get(c.n);
    if (!it) continue;
    if (it.kind === "pitch") { lines.problems.push(`${label(it)}: the pitch email is changed on Approvals, not by reply`); continue; }
    if (!(await live(it))) { lines.problems.push(`${label(it)}: already decided, left as it was`); continue; }
    const row = (await env.WP_OS_DB.prepare(
      "SELECT m.subject, m.body, d.id AS deal_id, d.brand, d.contact_email, d.drip_step FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id WHERE m.id = ?1",
    ).bind(it.message_id).first<{ subject: string; body: string; deal_id: string; brand: string; contact_email: string; drip_step: number }>())!;
    const { brandGateFor, fileDraft } = await import("./learningClub");
    // The same gate as the drip: a redraft is filed only while brand sending is approved and on.
    const gate = await brandGateFor(env);
    if (!gate.open) { lines.problems.push(`${label(it)}: not redrafted, brand sending is off (${gate.reasons.join("; ")})`); continue; }
    const out = await (deps.redraft ?? defaultRedraft)(env, wynn, { subject: row.subject, body: wordsOf(row.body), note: c.note, brand: row.brand });
    if (!out.ok) { lines.problems.push(`${label(it)}: Wynn could not redraft it (${out.detail}); it is unchanged and still waiting`); continue; }
    await decideApproval(env, actor, it.card_id, "rejected", `Redraft asked by email reply (${ref}): ${c.note}`.slice(0, 1000)).catch(() => undefined);
    await fileDraft(env, { id: row.deal_id, brand: row.brand, contact_email: row.contact_email, drip_step: row.drip_step }, { subject: out.subject, text: [out.body, "", ...TLC_SIGNATURE, "", TLC_PS_BY_STEP[Math.min(row.drip_step, 3)]!].join("\n") }, firmScope, c.note);
    lines.changed.push(`${label(it)}: redrafted for "${c.note}"`);
  }

  // What she approved goes now (inside the warm-up allowance); the rest goes on the next pass with room.
  const { runDrip, emailOwner } = await import("./learningClub");
  const drip = lines.approved.length ? await runDrip(env, now, firmScope) : null;

  /*
   * ONE ANSWER, ON THE SAME THREAD (owner, 24 Oct 2026): what was approved and sent, and every draft still waiting
   * — redrafts in full — under a new reference she can reply to the same way. The subject is the week's first
   * email's, and In-Reply-To names it, so it reads as one conversation.
   */
  const waiting = await pendingDrafts(env, firmScope);
  const nextRef = waiting.length ? mintRef() : null;
  const listed = listOf(waiting);
  const root = await env.WP_OS_DB.prepare("SELECT items_json FROM tlc_draft_notice WHERE ref = ?1").bind(rootRef).first<{ items_json: string }>();
  const rootCount = root ? (JSON.parse(root.items_json) as unknown[]).length : waiting.length;
  const thread = await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_type = 'tlc_drip' AND object_id = ?1 ORDER BY created_at LIMIT 1").bind(rootRef).first<{ token: string }>().catch(() => null);
  await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: `TLC: this week's brands, ${rootCount} to approve · ${rootRef}`,
      tldr: `Done: ${lines.approved.length} approved${drip ? ` (${drip.sentBrands.length} sent now${drip.waitingForAllowance ? `, ${drip.waitingForAllowance} on the next day's warm-up allowance` : ""})` : ""}, ${lines.skipped.length} skipped, ${lines.changed.length} redrafted.${waiting.length ? ` ${waiting.length} still waiting for you, below.` : ""}`,
      ...(waiting.length ? { tldrBullets: ['Reply "approve all"', 'Or "approve 1, 3" · "skip 2" · "change 2: what to change"'] } : {}),
      sections: [
        { label: "Approved", bullets: lines.approved.length ? lines.approved.slice(0, 6) : ["None"] },
        { label: "Sent now", bullets: drip?.sentBrands.length ? drip.sentBrands.slice(0, 6) : ["None yet"] },
        ...(lines.skipped.length ? [{ label: "Skipped (not sent)", bullets: lines.skipped.slice(0, 6) }] : []),
        ...(lines.changed.length ? [{ label: "Redrafted (full text below)", bullets: lines.changed.slice(0, 6) }] : []),
        ...(lines.problems.length ? [{ label: "Not done", bullets: lines.problems.slice(0, 6) }] : []),
        ...listed.sections,
      ],
      details: nextRef ? [`Ref ${nextRef}`, "", listed.copy].join("\n") : null,
    },
    objectType: "tlc_drip",
    objectId: `${rootRef}:answer:${nextRef ?? ref}`,
    cardId: null,
    cardKind: null,
    firmScope,
    replyOnThread: thread?.token ?? null,
  }).catch(() => []);
  if (nextRef) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_draft_notice (ref, items_json, firm_scope, batch_card_id, root_ref) VALUES (?1, ?2, ?3, NULL, ?4)").bind(nextRef, JSON.stringify(listed.items), firmScope, rootRef).run();
    for (const it of listed.items) if (it.kind !== "pitch") await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET notice_ref = ?2 WHERE id = ?1").bind(it.message_id, nextRef).run();
  }
  await appendEvent(env, {
    eventType: "tlc.draft_reply", actorType: "firm_user", actorId: TLC_OWNER.firmUserId, objectType: "tlc_draft_notice", objectId: ref, firmScope,
    payload: { approved: lines.approved, skipped: lines.skipped, changed: lines.changed, problems: lines.problems, sent: drip?.sentBrands ?? [], next_ref: nextRef },
  });
  return { handled: true, ref, detail: `${lines.approved.length} approved, ${lines.skipped.length} skipped, ${lines.changed.length} redrafted` };
}

/*
 * A DRAFT THAT CARRIES THE RESEARCH NOTE IS RE-COMPOSED, AND HER LIST RE-SENT ONCE (partner tail, 24 Oct 2026).
 * The first batch (TLC-ZF84KK) was composed by a dripEmail that pasted Parker's whole why_fit note — "Limits:",
 * "Caveat:", tiers, shared inboxes — into seven brand emails, and her "approve all" was then lost to a MIME bug.
 * Her approval must be of the words that go, so nothing is approved on her behalf: each UNDECIDED draft whose
 * lead is the old pasted note gets the current template's text in place (same card, same request, same number),
 * and she gets ONE email on the week's thread with the clean copy under a new reference. A repaired draft no
 * longer carries the note, so this runs once. Her own redrafts and approved day-zero text are never touched.
 */
const oldLead = (why: string): string => {
  const reason = why.trim().replace(/\.?$/, ".");
  return `I am writing because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
};
export async function repairLeakedDrafts(env: Env, now: Date, firmScope = "west-peek"): Promise<string> {
  const rows = (await env.WP_OS_DB.prepare(
    `SELECT m.id, m.body, m.step, m.effect_request_id, m.approval_card_id, m.notice_ref, d.brand, d.contact_name, d.why_fit,
            e.topic, e.month, e.event_date, e.seats_min, e.seats_max
       FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN tlc_event e ON e.id = d.event_id
       JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.state = 'AWAITING_APPROVAL' AND a.state = 'pending_review' AND m.redraft_note IS NULL AND d.why_fit IS NOT NULL`,
  ).bind(firmScope).all<{ id: string; body: string; step: number; effect_request_id: string; approval_card_id: string; notice_ref: string | null; brand: string; contact_name: string | null; why_fit: string; topic: string; month: string; event_date: string; seats_min: number | null; seats_max: number | null }>()).results ?? [];
  const leaked = rows.filter((r) => TLC_INTERNAL_NOTE.test(r.why_fit) && r.body.includes(oldLead(r.why_fit)));
  if (leaked.length === 0) return "no draft carries a research note";
  const roots = new Set<string>();
  const repaired: string[] = [];
  for (const r of leaked) {
    const mail = dripEmail({ step: r.step, brand: r.brand, contactName: r.contact_name, topic: r.topic, month: r.month, eventDate: r.event_date, why: r.why_fit, seats: seatsOf(r) });
    if (TLC_INTERNAL_NOTE.test(mail.text)) continue;
    const req = await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id).first<{ payload_json: string }>();
    if (!req) continue;
    const payload = { ...(JSON.parse(req.payload_json) as Record<string, unknown>), subject: mail.subject, text: mail.text };
    await env.WP_OS_DB.batch([
      env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id, JSON.stringify(payload)),
      env.WP_OS_DB.prepare("UPDATE approval_card SET summary = ?2 WHERE id = ?1 AND state = 'pending_review'").bind(r.approval_card_id, `${mail.subject}\n\n${mail.text}`.slice(0, 1800)),
      env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET subject = ?2, body = ?3 WHERE id = ?1").bind(r.id, mail.subject, mail.text),
    ]);
    repaired.push(r.brand);
    if (r.notice_ref) {
      const n = await env.WP_OS_DB.prepare("SELECT root_ref, ref FROM tlc_draft_notice WHERE ref = ?1").bind(r.notice_ref).first<{ root_ref: string | null; ref: string }>();
      if (n) roots.add(n.root_ref ?? n.ref);
    }
  }
  if (repaired.length === 0) return `${leaked.length} draft(s) carry a research note the template could not clean; left for her on Approvals`;
  const { emailOwner } = await import("./learningClub");
  const waiting = await pendingDrafts(env, firmScope);
  for (const rootRef of roots) {
    const nextRef = mintRef();
    const listed = listOf(waiting);
    const thread = await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_type = 'tlc_drip' AND object_id = ?1 ORDER BY created_at LIMIT 1").bind(rootRef).first<{ token: string }>().catch(() => null);
    await emailOwner(env, {
      employee: "Wynn",
      email: {
        what: `TLC: this week's brands, ${waiting.length} to approve · ${rootRef}`,
        tldr: `Nothing has gone to a brand. Your reply was not read (our bug, now fixed), and ${repaired.length} draft${repaired.length === 1 ? "" : "s"} had my research notes pasted into the email itself. Everything waiting for you (${waiting.length}) is below in full, clean.`,
        tldrBullets: ['Reply "approve all"', 'Or "approve 1, 3" · "skip 2" · "change 2: what to change"'],
        sections: [
          { label: "What happened", bullets: [`Re-written without the notes: ${repaired.join(", ")}`.slice(0, 300), "The notes stay on Approvals for you; a brand only ever sees one plain sentence of why", "Nothing was approved for you; your next reply decides them"] },
          ...listed.sections,
        ],
        details: [`Ref ${nextRef}`, "", listed.copy].join("\n"),
      },
      objectType: "tlc_drip",
      objectId: `${rootRef}:repaired:${nextRef}`,
      cardId: null,
      cardKind: null,
      firmScope,
      replyOnThread: thread?.token ?? null,
    });
    await env.WP_OS_DB.prepare("INSERT INTO tlc_draft_notice (ref, items_json, firm_scope, batch_card_id, root_ref) VALUES (?1, ?2, ?3, NULL, ?4)").bind(nextRef, JSON.stringify(listed.items), firmScope, rootRef).run();
    for (const it of listed.items) if (it.kind !== "pitch") await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET notice_ref = ?2 WHERE id = ?1").bind(it.message_id, nextRef).run();
  }
  await appendEvent(env, {
    eventType: "tlc.drafts_repaired", actorType: "system", actorId: "tlc_drip", objectType: "tlc_draft_notice", objectId: [...roots].join(",") || "none", firmScope,
    payload: { repaired, at: now.toISOString() },
  });
  return `${repaired.length} draft(s) re-composed without the research note; the clean list re-sent on ${[...roots].join(", ") || "no thread"}`;
}

/**
 * A BRAND'S NAME WITHOUT ITS QUALIFIER, IN DRAFTS ALREADY WRITTEN (owner, 24 Oct 2026: "Osmo (Generation)" →
 * "Osmo"). The composer now writes the clean name; this re-composes, in place, the drafts that still carry the
 * old one and have not gone: undecided OR approved-but-unsent (waiting for the warm-up allowance). Nothing is
 * approved, unapproved or re-sent for approval; the card keeps its state. Only a draft that is EXACTLY the old
 * template output is touched, so her own redrafts and approved day-zero text are never rewritten. Runs before
 * the drip each pass and is a no-op once nothing matches.
 */
/**
 * EMAIL 2 OFFERS THE THREE SAMPLES (owner, 26 Oct 2026), in follow-ups already queued too. An unsent email 2 —
 * undecided, or approved and waiting for the warm-up allowance — that is the old template's (it asked "Would you be
 * open to exploring a partnership?" after the picture of the room, and carries no offer) gets the current template's
 * text in place, at her instruction. Her own redrafts are never touched, and sent mail never is.
 */
const OLD_SECOND_EMAIL_MARK = "A quick picture of the room, in case it helps.";
export async function recomposeSecondEmails(env: Env, firmScope = "west-peek"): Promise<string[]> {
  const rows = (await env.WP_OS_DB.prepare(
    `SELECT m.id, m.subject, m.body, m.step, m.effect_request_id, m.approval_card_id, d.brand, d.contact_name, d.why_fit,
            e.topic, e.month, e.event_date, e.seats_min, e.seats_max
       FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN tlc_event e ON e.id = d.event_id
       JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.step = 1 AND m.state = 'AWAITING_APPROVAL' AND a.state IN ('pending_review','approved')
        AND m.redraft_note IS NULL AND instr(m.body, ?2) > 0`,
  ).bind(firmScope, OLD_SECOND_EMAIL_MARK).all<{ id: string; subject: string; body: string; step: number; effect_request_id: string; approval_card_id: string; brand: string; contact_name: string | null; why_fit: string | null; topic: string; month: string; event_date: string; seats_min: number | null; seats_max: number | null }>()).results ?? [];
  const done: string[] = [];
  for (const r of rows) {
    const mail = dripEmail({ step: 1, brand: r.brand, contactName: r.contact_name, topic: r.topic, month: r.month, eventDate: r.event_date, why: r.why_fit, seats: seatsOf(r) });
    const req = await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id).first<{ payload_json: string }>();
    if (!req) continue;
    const payload = { ...(JSON.parse(req.payload_json) as Record<string, unknown>), subject: mail.subject, text: mail.text };
    await env.WP_OS_DB.batch([
      env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id, JSON.stringify(payload)),
      env.WP_OS_DB.prepare("UPDATE approval_card SET summary = ?2 WHERE id = ?1 AND state IN ('pending_review','approved')").bind(r.approval_card_id, `${mail.subject}\n\n${mail.text}`.slice(0, 1800)),
      env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET subject = ?2, body = ?3 WHERE id = ?1 AND state = 'AWAITING_APPROVAL'").bind(r.id, mail.subject, mail.text),
    ]);
    done.push(brandDisplayName(r.brand));
  }
  if (done.length) {
    await appendEvent(env, { eventType: "tlc.second_emails_offer_samples", actorType: "system", actorId: "tlc_drip", objectType: "tlc_drip_message", objectId: done.join(",").slice(0, 200), firmScope, payload: { recomposed: done } });
  }
  return done;
}

/**
 * A BRAND IS TOLD 25 TO 100+ GUESTS PER EVENT, FLEXIBLE (owner, 30 Oct 2026), in queued drafts too. An unsent drip draft
 * (undecided, or approved and waiting for its allowance) whose room size is the club's planned size ("60 to 75
 * people spending…", "80 to 120 New Yorkers, each…") gets the standard words in place; nothing else in it changes.
 * Sent mail is never touched; nor is her own redraft.
 */
export function standardGuestWords(body: string): string {
  return body
    .replace(/\b\d+(?: to \d+)? people spending\b/g, `${BRAND_GUESTS} spending`)
    .replace(/\b\d+(?: to \d+)? New Yorkers, each\b/g, `${BRAND_ROOM_WORDS} New Yorkers (flexible to your goals), each`);
}
export async function recomposeGuestCounts(env: Env, firmScope = "west-peek"): Promise<string[]> {
  const rows = (await env.WP_OS_DB.prepare(
    `SELECT m.id, m.subject, m.body, m.effect_request_id, m.approval_card_id, d.brand
       FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.state = 'AWAITING_APPROVAL' AND a.state IN ('pending_review','approved') AND m.redraft_note IS NULL`,
  ).bind(firmScope).all<{ id: string; subject: string; body: string; effect_request_id: string; approval_card_id: string; brand: string }>()).results ?? [];
  const done: string[] = [];
  for (const r of rows) {
    const text = standardGuestWords(r.body);
    if (text === r.body) continue;
    const req = await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id).first<{ payload_json: string }>();
    if (!req) continue;
    const payload = { ...(JSON.parse(req.payload_json) as Record<string, unknown>), text };
    await env.WP_OS_DB.batch([
      env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id, JSON.stringify(payload)),
      env.WP_OS_DB.prepare("UPDATE approval_card SET summary = ?2 WHERE id = ?1 AND state IN ('pending_review','approved')").bind(r.approval_card_id, `${r.subject}\n\n${text}`.slice(0, 1800)),
      env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET body = ?2 WHERE id = ?1 AND state = 'AWAITING_APPROVAL'").bind(r.id, text),
    ]);
    done.push(brandDisplayName(r.brand));
  }
  if (done.length) await appendEvent(env, { eventType: "tlc.drafts_guest_count", actorType: "system", actorId: "tlc_drip", objectType: "tlc_drip_message", objectId: done.join(",").slice(0, 200), firmScope, payload: { recomposed: done } });
  return done;
}

export async function recomposeBrandNames(env: Env, firmScope = "west-peek"): Promise<string[]> {
  const rows = (await env.WP_OS_DB.prepare(
    `SELECT m.id, m.subject, m.body, m.step, m.effect_request_id, m.approval_card_id, d.brand, d.contact_name, d.why_fit,
            e.topic, e.month, e.event_date, e.seats_min, e.seats_max
       FROM tlc_drip_message m JOIN tlc_deal d ON d.id = m.deal_id JOIN tlc_event e ON e.id = d.event_id
       JOIN approval_card a ON a.id = m.approval_card_id
      WHERE d.firm_scope = ?1 AND m.state = 'AWAITING_APPROVAL' AND a.state IN ('pending_review','approved')
        AND m.redraft_note IS NULL AND d.brand LIKE '%(%'`,
  ).bind(firmScope).all<{ id: string; subject: string; body: string; step: number; effect_request_id: string; approval_card_id: string; brand: string; contact_name: string | null; why_fit: string | null; topic: string; month: string; event_date: string; seats_min: number | null; seats_max: number | null }>()).results ?? [];
  const done: string[] = [];
  for (const r of rows) {
    if (brandDisplayName(r.brand) === r.brand) continue;
    const input = { step: r.step, contactName: r.contact_name, topic: r.topic, month: r.month, eventDate: r.event_date, why: r.why_fit, seats: seatsOf(r) };
    const old = oldTemplate({ ...input, brand: r.brand });
    if (r.subject !== old.subject || r.body !== old.text) continue;
    const mail = dripEmail({ ...input, brand: r.brand });
    const req = await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id).first<{ payload_json: string }>();
    if (!req) continue;
    const payload = { ...(JSON.parse(req.payload_json) as Record<string, unknown>), subject: mail.subject, text: mail.text };
    await env.WP_OS_DB.batch([
      env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1 AND executed_at IS NULL").bind(r.effect_request_id, JSON.stringify(payload)),
      env.WP_OS_DB.prepare("UPDATE approval_card SET summary = ?2 WHERE id = ?1 AND state IN ('pending_review','approved')").bind(r.approval_card_id, `${mail.subject}\n\n${mail.text}`.slice(0, 1800)),
      env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET subject = ?2, body = ?3 WHERE id = ?1 AND state = 'AWAITING_APPROVAL'").bind(r.id, mail.subject, mail.text),
    ]);
    done.push(brandDisplayName(r.brand));
  }
  // The pitch email after a yes: only its subject carried the name.
  const pitches = (await env.WP_OS_DB.prepare(
    `SELECT f.deal_id, f.subject, f.effect_request_id, d.brand FROM tlc_pitch_followup f JOIN tlc_deal d ON d.id = f.deal_id
      WHERE d.firm_scope = ?1 AND f.state IN ('HELD','AWAITING_APPROVAL') AND d.brand LIKE '%(%'`,
  ).bind(firmScope).all<{ deal_id: string; subject: string; effect_request_id: string | null; brand: string }>()).results ?? [];
  for (const p of pitches) {
    const subject = `${brandDisplayName(p.brand)} + a small room in New York`;
    if (p.subject !== `${p.brand} + a small room in New York` || subject === p.subject) continue;
    await env.WP_OS_DB.prepare("UPDATE tlc_pitch_followup SET subject = ?2 WHERE deal_id = ?1").bind(p.deal_id, subject).run();
    if (p.effect_request_id) {
      const req = await env.WP_OS_DB.prepare("SELECT payload_json FROM external_effect_request WHERE id = ?1 AND executed_at IS NULL").bind(p.effect_request_id).first<{ payload_json: string }>();
      if (req) await env.WP_OS_DB.prepare("UPDATE external_effect_request SET payload_json = ?2 WHERE id = ?1 AND executed_at IS NULL").bind(p.effect_request_id, JSON.stringify({ ...(JSON.parse(req.payload_json) as Record<string, unknown>), subject })).run();
    }
    done.push(brandDisplayName(p.brand));
  }
  if (done.length) {
    await appendEvent(env, { eventType: "tlc.drafts_brand_named", actorType: "system", actorId: "tlc_drip", objectType: "tlc_drip_message", objectId: done.join(",").slice(0, 200), firmScope, payload: { recomposed: done } });
  }
  return done;
}

/** What the composer wrote before the display name: the stored brand, parenthetical and all. */
function oldTemplate(input: Parameters<typeof dripEmail>[0]): { subject: string; text: string } {
  const placeholder = "\u0000BRAND\u0000";
  const mail = dripEmail({ ...input, brand: placeholder });
  return { subject: mail.subject.split(placeholder).join(input.brand), text: mail.text.split(placeholder).join(input.brand) };
}
