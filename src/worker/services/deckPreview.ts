import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, type Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import { sendPartnersLetter } from "./execEmail";
import {
  DECK_OWNER, driftSince, figuresFromRecords, recordDeckVersion, summariseDrift, takeRecordsSnapshot, theFund,
  type RecordsSnapshot,
} from "./deck";
import { DECK_SLIDES, type Slide } from "../../shared/deck/definition";
import { MEASURE_OVERFLOW_JS, renderDeckHtml, renderDeckPages, type DeckAssets } from "../../shared/deck/render";
import { PREVIEW_URL, checkSlides, isApproval, renderPreviewPage, typedFigures } from "../../shared/deck/preview";
import { PARTNERS, partnerByEmail } from "../../shared/registry/partners";
import { OUTBOUND_ATTACHMENTS_MAX_BYTES, attachmentsBytes, type EmailAttachment } from "../effects/emailTransport";

/**
 * THE LP DECK IS FINISHED AS A PREVIEW, AND A PDF ONLY ON "APPROVED" (owner's design, 26 Oct 2026).
 *
 *   1. The fund records change, or a partner asks for a change → Preston builds a DECK PREVIEW: a
 *      page inside the OS (GET /api/deck/preview, partner sign-in) with every slide as a page and a
 *      short note at the top on what changed. No PDF.
 *   2. ONE email per round, to both partners together (`sendRound`). A second send is refused.
 *   3. Either partner replies in plain words. The reply is recorded at once (`recordReply`) and
 *      applied by the diagnostics sweep (`applyPending`) to the SAME preview; Preston replies on the
 *      thread with what he changed and anything he could not do.
 *   4. "approved" from BOTH partners, on the same slides → `finishDeck`: the final PDF, recorded in
 *      deck_version as the current deck. The last step, and the only PDF.
 *
 * THE WORKFLOW AROUND IT (owner, 11 Nov 2026):
 *   0. A partner emails the OS (or writes to their chief of staff) that they are ready to work on the
 *      deck → `startDeckFromEmail` starts the round, with no model deciding it (shared/deck/start.ts).
 *   4. "We should both say 'approved' before a new pdf is printed": the first partner's "approved" is
 *      recorded and answered; the PDF is made when the other one approves too. Any change applied to
 *      the preview in between (a request, a records move) clears the approvals (`clearApprovals`).
 *      "PDF should arrive as attachment and a link": the final reply carries the PDF and the OS link.
 *   5. More work after the final PDF → the approved deck goes back into the preview link as the next
 *      round, carrying what was asked; the current deck stays current until that round is approved.
 *
 * Before this, every records move and every request produced a PDF version (v3–v18), most of them
 * rejected unread; the partners reviewed by downloading files. The preview is the one document
 * under discussion, and the PDF is the record of what they agreed.
 */

export interface PreviewRow {
  id: string;
  fund_id: string;
  round_no: number;
  state: "OPEN" | "APPROVED" | "FINAL" | "SUPERSEDED";
  slides_json: string;
  what_changed_json: string;
  reason: string | null;
  hold: number;
  sent_at: string | null;
  sent_to: string | null;
  thread_token: string | null;
  kept_note: string | null;
  policy_versions_json: string;
  approved_by: string | null;
  approved_at: string | null;
  final_deck_version_id: string | null;
  final_note: string | null;
  firm_scope: string;
  created_at: string;
  updated_at: string;
}

interface ChangeRow {
  id: string;
  preview_id: string;
  kind: "BUILT" | "RECORDS" | "REQUEST" | "APPROVAL" | "FINAL";
  state: "PENDING" | "DONE" | "REFUSED";
  by_whom: string | null;
  said: string | null;
  applied: string | null;
  replied_at: string | null;
  created_at: string;
}

/** Both partners, Scooter first — the order the owner's first email greets them in. */
export function previewRecipients(): string[] {
  return [...PARTNERS].sort((a, b) => (a.firstName === "Scooter" ? -1 : b.firstName === "Scooter" ? 1 : 0)).map((p) => p.email);
}

const nowIso = () => new Date().toISOString();
const SIGN_OFF = "Preston\nWest Peek OS";
const partnerNamed = (firstName: string | null | undefined) => PARTNERS.find((x) => x.firstName === firstName) ?? null;
/** The one sentence on how a round ends, used by every email that asks for a reply. */
const BOTH_APPROVE = "When both of you have replied \"approved\", I'll make the final PDF.";

/** The final PDF a FINAL round made: its version number and its link in the OS. */
async function approvedVersion(env: Env, p: PreviewRow | null): Promise<{ versionNo: number; link: string | null } | null> {
  if (!p || p.state !== "FINAL" || !p.final_deck_version_id) return null;
  const v = await env.WP_OS_DB.prepare("SELECT version_no FROM deck_version WHERE id = ?1").bind(p.final_deck_version_id).first<{ version_no: number }>();
  return v ? { versionNo: v.version_no, link: p.final_note } : null;
}

/**
 * THE DECK CHANGED, SO NOBODY HAS APPROVED IT YET. An approval is of the slides the partner saw; a
 * change applied after it (a request, a records move) clears every approval on the round, and the
 * round is open again. Returns who had approved, so the caller can say so on the thread.
 */
async function clearApprovals(env: Env, previewId: string): Promise<string[]> {
  const rows = (await env.WP_OS_DB.prepare("SELECT DISTINCT by_whom FROM deck_preview_change WHERE preview_id = ?1 AND kind = 'APPROVAL' AND state IN ('DONE', 'PENDING')").bind(previewId).all<{ by_whom: string | null }>()).results ?? [];
  if (rows.length === 0) return [];
  await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = 'REFUSED', applied = 'cleared: the deck changed after this approval', updated_at = ?2 WHERE preview_id = ?1 AND kind = 'APPROVAL' AND state IN ('DONE', 'PENDING')").bind(previewId, nowIso()).run();
  await env.WP_OS_DB.prepare("UPDATE deck_preview SET state = 'OPEN', approved_by = NULL, approved_at = NULL, updated_at = ?2 WHERE id = ?1 AND state = 'APPROVED'").bind(previewId, nowIso()).run();
  return rows.map((r) => r.by_whom).filter((n): n is string => !!n);
}
const approveAgain = (cleared: readonly string[]) => (cleared.length ? `The deck changed after ${cleared.join(" and ")} approved, so both of you need to reply "approved" again.` : "");

export async function openPreview(env: Env, fundId: string): Promise<PreviewRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE fund_id = ?1 AND state IN ('OPEN', 'APPROVED') ORDER BY round_no DESC LIMIT 1")
    .bind(fundId).first<PreviewRow>();
}

async function latestPreview(env: Env, fundId: string): Promise<PreviewRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE fund_id = ?1 ORDER BY round_no DESC LIMIT 1").bind(fundId).first<PreviewRow>();
}

async function addChange(env: Env, previewId: string, c: { kind: ChangeRow["kind"]; state?: ChangeRow["state"]; by?: string | null; said?: string | null; applied?: string | null }): Promise<string> {
  const id = `dpc_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare("INSERT INTO deck_preview_change (id, preview_id, kind, state, by_whom, said, applied) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, previewId, c.kind, c.state ?? "DONE", c.by ?? null, c.said ?? null, c.applied ?? null).run();
  return id;
}

// ── The pictures ──────────────────────────────────────────────────────────────────────────────

export async function knownAssets(env: Env): Promise<Set<string>> {
  const rows = (await env.WP_OS_DB.prepare("SELECT name FROM deck_asset").all<{ name: string }>()).results ?? [];
  return new Set(rows.map((r) => r.name));
}

/** Every picture the slides name, as data URIs. A picture that cannot be read renders as a visible gap. */
export async function loadAssets(env: Env, slides: readonly Slide[]): Promise<DeckAssets> {
  const names = new Set<string>();
  for (const s of slides) {
    if (s.aside?.asset) names.add(s.aside.asset);
    for (const slot of [...s.slots, ...(s.right ?? [])]) {
      if (slot.kind === "image") names.add(slot.asset);
      if (slot.kind === "images") slot.items.forEach((i) => names.add(i.asset));
      if (slot.kind === "person") { if (slot.photo) names.add(slot.photo); (slot.logos ?? []).forEach((l) => names.add(l)); }
      if (slot.kind === "table") for (const r of slot.rows) for (const c of r) if (typeof c === "object" && "asset" in c) names.add(c.asset);
    }
  }
  const bucket = (env as unknown as { WP_OS_DOCUMENTS?: R2Bucket }).WP_OS_DOCUMENTS;
  const out: Record<string, string> = {};
  if (!bucket || names.size === 0) return out;
  for (const name of names) {
    const row = await env.WP_OS_DB.prepare("SELECT r2_key, content_type FROM deck_asset WHERE name = ?1").bind(name).first<{ r2_key: string; content_type: string }>();
    if (!row) continue;
    const obj = await bucket.get(row.r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out[name] = `data:${row.content_type};base64,${btoa(bin)}`;
  }
  return out;
}

// ── Building a round ──────────────────────────────────────────────────────────────────────────

/**
 * Start a round, or — when one is already open — fold this into it. The slides carry forward from
 * the last preview (whatever its state), so a round never starts from scratch; the very first one
 * starts from the deck definition unless the caller hands it slides.
 */
export async function startOrUpdatePreview(
  env: Env,
  input: { reason: string; changes: readonly string[]; slides?: Slide[]; kept?: string | null; hold?: boolean; snapshot?: RecordsSnapshot | null; /** The partner (first name) who asked for this round, when one did. */ askedBy?: string | null },
): Promise<{ preview: PreviewRow; created: boolean }> {
  const fund = await theFund(env);
  const open = await openPreview(env, fund.id);
  const snapshot = input.snapshot ?? (await takeRecordsSnapshot(env, fund.id).catch(() => null));
  if (open) {
    const changes = [...(JSON.parse(open.what_changed_json) as string[]), ...input.changes];
    await env.WP_OS_DB.prepare("UPDATE deck_preview SET what_changed_json = ?2, slides_json = COALESCE(?3, slides_json), policy_versions_json = COALESCE(?4, policy_versions_json), updated_at = ?5 WHERE id = ?1")
      .bind(open.id, JSON.stringify(changes), input.slides ? JSON.stringify(input.slides) : null, snapshot ? JSON.stringify(snapshot) : null, nowIso()).run();
    return { preview: (await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE id = ?1").bind(open.id).first<PreviewRow>())!, created: false };
  }
  const last = await latestPreview(env, fund.id);
  const slides = input.slides ?? (last ? (JSON.parse(last.slides_json) as Slide[]) : [...DECK_SLIDES]);
  const id = `dpv_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO deck_preview (id, fund_id, round_no, state, slides_json, what_changed_json, reason, hold, kept_note, policy_versions_json)
     VALUES (?1, ?2, ?3, 'OPEN', ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(id, fund.id, (last?.round_no ?? 0) + 1, JSON.stringify(slides), JSON.stringify(input.changes), input.reason, input.hold ? 1 : 0, input.kept ?? last?.kept_note ?? null, JSON.stringify(snapshot ?? {})).run();
  await addChange(env, id, { kind: "BUILT", by: input.askedBy ?? DECK_OWNER, applied: input.reason });
  await appendEvent(env, { eventType: "deck_preview.built", actorType: "system", actorId: "aie_preston", objectType: "deck_preview", objectId: id, firmScope: "west-peek", payload: { round_no: (last?.round_no ?? 0) + 1, hold: !!input.hold, reason: input.reason } });
  return { preview: (await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE id = ?1").bind(id).first<PreviewRow>())!, created: true };
}

/**
 * THE RECORDS MOVED → THE PREVIEW SAYS SO. Compares the records with the snapshot the open preview
 * (or, with none open, the last preview — or the newest deck version) was built against. A move
 * folds into the open round, with a note on the thread if it was already emailed; with no round open
 * it starts one. Never a PDF.
 */
export async function previewIfRecordsMoved(env: Env): Promise<{ moved: boolean; reason: string }> {
  const fund = await env.WP_OS_DB.prepare("SELECT id FROM fund LIMIT 1").first<{ id: string }>();
  if (!fund) return { moved: false, reason: "no fund" };
  const now = await takeRecordsSnapshot(env, fund.id);
  const base = (await openPreview(env, fund.id)) ?? (await latestPreview(env, fund.id));
  let then: RecordsSnapshot | null = null;
  if (base) {
    try { then = JSON.parse(base.policy_versions_json) as RecordsSnapshot; } catch { then = null; }
  } else {
    const v = await env.WP_OS_DB.prepare("SELECT records_snapshot_json FROM deck_version WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1").bind(fund.id).first<{ records_snapshot_json: string }>();
    if (!v) return { moved: false, reason: "no deck to compare against" };
    try { then = JSON.parse(v.records_snapshot_json) as RecordsSnapshot; } catch { then = null; }
  }
  const was = then?.policy_versions ?? null;
  const keys = ["mandate", "sleeve", "reserve"] as const;
  const moved = was ? keys.filter((k) => now.policy_versions[k] !== null && was[k] !== null && was[k] !== undefined && (now.policy_versions[k] as number) > (was[k] as number)) : [];
  if (moved.length === 0) return { moved: false, reason: "the deck preview reads the latest records" };
  const drift = then ? driftSince(then, now) : [];
  const line = `The fund records changed (${moved.map((k) => `${k} v${was![k]} → v${now.policy_versions[k]}`).join(", ")}): ${summariseDrift(drift)}`;
  const { preview, created } = await startOrUpdatePreview(env, { reason: line, changes: [line], snapshot: now });
  if (!created) {
    await addChange(env, preview.id, { kind: "RECORDS", by: DECK_OWNER, applied: line });
    const again = approveAgain(await clearApprovals(env, preview.id));
    if (preview.sent_at && preview.thread_token) {
      await sendPartnersLetter(env, {
        to: previewRecipients(), employee: DECK_OWNER, subject: `Re: ${roundSubject(preview)}`, replyOnThread: preview.thread_token,
        text: `Hi Scooter and Sequoia,\n\nThe fund records changed, so I updated the same preview: ${PREVIEW_URL}\n\n${line}${again ? `\n\n${again}` : ""}\n\n${SIGN_OFF}`,
        objectType: "deck_preview", objectId: preview.id, firmScope: preview.firm_scope,
      });
    }
  }
  return { moved: true, reason: line };
}

// ── The one email per round ───────────────────────────────────────────────────────────────────

export function roundSubject(p: Pick<PreviewRow, "round_no">): string {
  return p.round_no <= 1 ? "Our Fund I deck: a new way we'll finish it" : `Our Fund I deck: preview round ${p.round_no}`;
}

/** What a round's email needs beyond the row: who asked for the round, and what is already asked. */
export interface RoundContext {
  /** The partner (first name) whose email or reply started this round, when one did. */
  startedBy?: string | null;
  /** The final PDF's version number, when this round reopens an approved deck. */
  approvedVersionNo?: number | null;
  /** Requests already waiting on this round when its email goes: the partner's own words. */
  asks?: ReadonlyArray<{ by: string; said: string }>;
}

/**
 * The round's email. Round one is the owner's own (26 Oct 2026), with step 4 as she changed it on
 * 11 Nov 2026 (both partners approve). A round a partner asked for says who asked, that the approved
 * deck is back in the link, and what they asked for.
 */
export function roundEmailText(p: Pick<PreviewRow, "round_no" | "what_changed_json" | "kept_note">, ctx: RoundContext = {}): string {
  const all = JSON.parse(p.what_changed_json) as string[];
  const kept = p.kept_note ? `\n\nKept from earlier decks: ${p.kept_note}` : "";
  const asks = (ctx.asks ?? []).filter((a) => a.said.trim());
  const asked = asks.length
    ? `${asks.map((a) => `${a.by} asked:\n"${a.said.trim().slice(0, 1500)}"`).join("\n\n")}\n\nI'm working on that now and will reply here with what I changed.`
    : "";
  if (p.round_no <= 1) {
    return [
      "Hi Scooter and Sequoia,",
      "Sequoia has asked me, Preston, to put together our latest Fund I deck. Here's how we'll do it from now on:",
      "1. I build a preview of the whole deck as a web page, every slide in order, with a short note at the top on what changed. No PDF yet.\n" +
        `2. You both look at it here: ${PREVIEW_URL}\n` +
        "3. Either of you replies to this email with any changes, in plain words (\"page 4 should say…\"). I update the same preview and reply here with what I changed.\n" +
        "4. We go back and forth until it's perfect. When both of you have replied \"approved\", I make the final PDF deck. That's the version that goes to LPs.",
      `What's in this first preview:\n${all.map((c) => `- ${c}`).join("\n")}${kept}`,
      asked,
      SIGN_OFF,
    ].filter(Boolean).join("\n\n");
  }
  if (ctx.startedBy) {
    // The first line of what changed is the note that this partner asked; the email says it in its opening instead.
    const more = all.slice(1);
    const v = ctx.approvedVersionNo;
    return [
      "Hi Scooter and Sequoia,",
      v
        ? `${ctx.startedBy} asked for more work on our Fund I deck, so the approved deck (v${v}) is back in the preview: ${PREVIEW_URL}`
        : `${ctx.startedBy} asked to work on our Fund I deck, so the latest deck is in the preview: ${PREVIEW_URL}`,
      asked,
      more.length || kept ? `${more.length ? `Also in this preview:\n${more.map((c) => `- ${c}`).join("\n")}` : ""}${kept}`.trim() : "",
      `${v ? `v${v} stays the current deck until this round is approved. ` : ""}Reply here with any changes in plain words, or with "approved". ${v ? BOTH_APPROVE.replace("the final PDF", "the next final PDF") : BOTH_APPROVE}`,
      SIGN_OFF,
    ].filter(Boolean).join("\n\n");
  }
  return [
    "Hi Scooter and Sequoia,",
    `I've built a new preview of our Fund I deck: ${PREVIEW_URL}`,
    `What changed:\n${all.map((c) => `- ${c}`).join("\n")}${kept}`,
    asked,
    `Reply here with any changes in plain words, or with "approved". ${BOTH_APPROVE}`,
    SIGN_OFF,
  ].filter(Boolean).join("\n\n");
}

/** Who asked for this round and what is already waiting on it, read from the rows. */
async function roundContext(env: Env, p: PreviewRow): Promise<RoundContext> {
  const built = await env.WP_OS_DB.prepare("SELECT by_whom FROM deck_preview_change WHERE preview_id = ?1 AND kind = 'BUILT' ORDER BY created_at LIMIT 1").bind(p.id).first<{ by_whom: string | null }>();
  const startedBy = partnerNamed(built?.by_whom)?.firstName ?? null;
  const before = startedBy
    ? await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE fund_id = ?1 AND round_no < ?2 ORDER BY round_no DESC LIMIT 1").bind(p.fund_id, p.round_no).first<PreviewRow>()
    : null;
  const asks = (await env.WP_OS_DB.prepare("SELECT by_whom, said FROM deck_preview_change WHERE preview_id = ?1 AND kind = 'REQUEST' AND state = 'PENDING' ORDER BY created_at").bind(p.id).all<{ by_whom: string | null; said: string | null }>()).results ?? [];
  return { startedBy, approvedVersionNo: (await approvedVersion(env, before))?.versionNo ?? null, asks: asks.map((a) => ({ by: a.by_whom ?? "A partner", said: a.said ?? "" })) };
}

/**
 * ONE EMAIL PER ROUND. Sends only an OPEN, un-held round that has not been sent; the row records the
 * send and the thread, and a second call finds `sent_at` set and sends nothing.
 */
export async function sendRound(env: Env, previewId: string): Promise<{ sent: boolean; reason: string }> {
  const p = await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE id = ?1").bind(previewId).first<PreviewRow>();
  if (!p) return { sent: false, reason: "no such preview" };
  if (p.state !== "OPEN") return { sent: false, reason: `the preview is ${p.state}` };
  if (p.hold) return { sent: false, reason: "held for Sequoia's own look first" };
  if (p.sent_at) return { sent: false, reason: `this round was already emailed on ${p.sent_at.slice(0, 10)}; one email per round` };
  // CLAIM FIRST, so two sweeps a second apart cannot both send.
  const claimed = await env.WP_OS_DB.prepare("UPDATE deck_preview SET sent_at = ?2, updated_at = ?2 WHERE id = ?1 AND sent_at IS NULL AND hold = 0 AND state = 'OPEN'").bind(p.id, nowIso()).run();
  if ((claimed.meta?.changes ?? 0) === 0) return { sent: false, reason: "another pass is sending it" };
  const out = await sendPartnersLetter(env, {
    to: previewRecipients(), employee: DECK_OWNER, subject: roundSubject(p), text: roundEmailText(p, await roundContext(env, p)),
    objectType: "deck_preview", objectId: p.id, firmScope: p.firm_scope,
  });
  if (!out.sent) {
    await env.WP_OS_DB.prepare("UPDATE deck_preview SET sent_at = NULL WHERE id = ?1").bind(p.id).run();
    return { sent: false, reason: out.reason };
  }
  await env.WP_OS_DB.prepare("UPDATE deck_preview SET sent_to = ?2, thread_token = ?3 WHERE id = ?1").bind(p.id, out.recipients.join(", "), out.threadToken ?? null).run();
  return { sent: true, reason: `emailed to ${out.recipients.join(" and ")}` };
}

// ── A reply ───────────────────────────────────────────────────────────────────────────────────

/**
 * A partner's reply on the preview thread, recorded at once (inside the email handler: no model call
 * here). "approved" is an APPROVAL; anything else is a REQUEST. The sweep does the work.
 */
export async function recordReply(env: Env, previewId: string, written: string, partnerAddress: string): Promise<{ kind: "REQUEST" | "APPROVAL"; id: string } | null> {
  const p = await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE id = ?1").bind(previewId).first<PreviewRow>();
  if (!p) return null;
  const who = partnerByEmail(partnerAddress)?.firstName ?? partnerAddress;
  const kind = isApproval(written) ? "APPROVAL" : "REQUEST";
  const id = await addChange(env, p.id, { kind, state: "PENDING", by: who, said: written.slice(0, 4000) });
  await appendEvent(env, { eventType: "deck_preview.reply", actorType: "firm_user", actorId: partnerByEmail(partnerAddress)?.firmUserId ?? "unknown", objectType: "deck_preview", objectId: p.id, firmScope: p.firm_scope, payload: { kind, change_id: id } });
  return { kind, id };
}

/** What a model is asked to do with a request. Injectable, so the reply → update path is testable. */
export type DeckEditor = (input: { slides: Slide[]; said: string; assets: string[] }) => Promise<{ slides?: Slide[]; changes: string[]; cannot: string[] } | null>;

const defaultEditor = (env: Env): DeckEditor => async ({ slides, said, assets }) => {
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] };
  const prompt = [
    "You are Preston, editing the West Peek Ventures Fund I LP deck preview at a Managing Partner's request.",
    "The deck is JSON: an array of slides. Return the WHOLE deck with the requested change applied, and nothing else changed.",
    "Rules: keep every slide, block and picture the request does not touch; keep every {\"bind\": …} figure as a bind (fund figures come from the records — never type a number a record holds, and if asked to change one, say in `cannot` that it is changed on Fund strategy);",
    `pictures may only use these names: ${JSON.stringify(assets)}; block kinds are text, heading, figure, derivation, image, images, quote, table, person.`,
    "Write US English. Keep the deck's voice: short, plain, confident, true.",
    "Return ONLY JSON: {\"slides\": [...], \"changes\": [\"page 4 now says …\", …], \"cannot\": [\"what you could not do and why\", …]}.",
    `THE REQUEST, in the partner's words:\n${said}`,
    `THE DECK:\n${JSON.stringify(slides)}`,
  ].join("\n");
  const { run } = await runAi(env, {
    purpose: "Apply a partner's change to the LP deck preview",
    actor,
    inputs: [prompt],
    sensitivity: "INTERNAL" as never,
    budgetContext: { interpretation: true, expectedOutputTokens: 12_000 },
    routing: { category: "RESEARCH", taskClass: "deck_editing" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return null;
  const m = /\{[\s\S]*\}/.exec(run.output_text);
  if (!m) return null;
  try {
    const out = JSON.parse(m[0]) as { slides?: Slide[]; changes?: string[]; cannot?: string[] };
    return { slides: out.slides, changes: out.changes ?? [], cannot: out.cannot ?? [] };
  } catch {
    return null;
  }
};

async function replyOnThread(env: Env, p: PreviewRow, body: string, attachments?: readonly EmailAttachment[]): Promise<boolean> {
  if (!p.thread_token) return false;
  const out = await sendPartnersLetter(env, {
    to: previewRecipients(), employee: DECK_OWNER, subject: `Re: ${roundSubject(p)}`, replyOnThread: p.thread_token,
    text: `Hi Scooter and Sequoia,\n\n${body}\n\n${SIGN_OFF}`, objectType: "deck_preview", objectId: p.id, firmScope: p.firm_scope,
    ...(attachments?.length ? { attachments } : {}),
  });
  return out.sent;
}

/**
 * Apply every waiting request to its preview, in order, and answer each on the thread. A request the
 * editor cannot apply safely changes nothing and says why. A model that is down leaves the request
 * waiting for the next sweep — it is never dropped.
 */
export async function applyPending(env: Env, deps: { editor?: DeckEditor; launch?: PdfLauncher } = {}): Promise<string[]> {
  const notes: string[] = [];
  const pending = (await env.WP_OS_DB.prepare("SELECT * FROM deck_preview_change WHERE state = 'PENDING' ORDER BY created_at LIMIT 5").all<ChangeRow>()).results ?? [];
  for (const c of pending) {
    const p = await env.WP_OS_DB.prepare("SELECT * FROM deck_preview WHERE id = ?1").bind(c.preview_id).first<PreviewRow>();
    if (!p) continue;
    // A change applied earlier in this pass may have cleared this approval: read it again.
    const live = await env.WP_OS_DB.prepare("SELECT state FROM deck_preview_change WHERE id = ?1").bind(c.id).first<{ state: string }>();
    if (live?.state !== "PENDING") continue;
    if (p.state === "FINAL" || p.state === "SUPERSEDED") {
      notes.push(await afterTheRoundClosed(env, p, c));
      continue;
    }
    if (c.kind === "APPROVAL") {
      notes.push(await recordApproval(env, p, c, deps.launch));
      continue;
    }
    const slides = JSON.parse(p.slides_json) as Slide[];
    const assets = await knownAssets(env);
    const edited = await (deps.editor ?? defaultEditor(env))({ slides, said: c.said ?? "", assets: [...assets] });
    if (!edited) { notes.push(`request ${c.id} waits: the editor did not answer`); continue; }
    let applied = edited.changes.filter(Boolean);
    const cannot = [...edited.cannot.filter(Boolean)];
    let next: Slide[] | null = null;
    if (edited.slides && applied.length) {
      const checked = checkSlides(edited.slides, assets);
      if (!checked.ok) {
        cannot.push(`I did not save the edit because it would have left ${checked.why}`);
        applied = [];
      } else {
        // A figure typed as prose that neither the old deck nor the partner said is a guess: refused.
        const before = new Set(typedFigures(slides));
        const said = (c.said ?? "").replace(/\s+/g, "");
        const added = typedFigures(checked.slides).filter((f) => !before.has(f) && !said.includes(f));
        if (added.length) {
          cannot.push(`I did not save the edit because it typed figures nobody asked for (${[...new Set(added)].join(", ")}); fund figures come from the records`);
          applied = [];
        } else next = checked.slides;
      }
    }
    if (next) {
      const changes = [...(JSON.parse(p.what_changed_json) as string[]), ...applied];
      await env.WP_OS_DB.prepare("UPDATE deck_preview SET slides_json = ?2, what_changed_json = ?3, updated_at = ?4 WHERE id = ?1")
        .bind(p.id, JSON.stringify(next), JSON.stringify(changes), nowIso()).run();
    }
    // The slides moved, so an approval of the old ones no longer counts.
    const again = next ? approveAgain(await clearApprovals(env, p.id)) : "";
    const summary = [next ? `Changed: ${applied.join("; ")}` : "Nothing changed.", cannot.length ? `Could not: ${cannot.join("; ")}` : ""].filter(Boolean).join(" ");
    const body = [
      next ? `I updated the same preview: ${PREVIEW_URL}` : `I left the preview as it was: ${PREVIEW_URL}`,
      next ? `What I changed:\n${applied.map((a) => `- ${a}`).join("\n")}` : "",
      cannot.length ? `What I couldn't do:\n${cannot.map((a) => `- ${a}`).join("\n")}` : "",
      again,
      `Reply here with anything else, or with "approved" when it's ready. ${BOTH_APPROVE}`,
    ].filter(Boolean).join("\n\n");
    const replied = await replyOnThread(env, p, body);
    await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = ?2, applied = ?3, replied_at = ?4, updated_at = ?5 WHERE id = ?1")
      .bind(c.id, next ? "DONE" : "REFUSED", summary.slice(0, 4000), replied ? nowIso() : null, nowIso()).run();
    notes.push(`request ${next ? "applied" : "refused"}${replied ? ", answered on the thread" : ""}`);
  }
  return notes;
}

// ── "approved" → the final PDF ───────────────────────────────────────────────────────────────

export type PdfLauncher = (binding: unknown) => Promise<{ newPage(): Promise<any>; close(): Promise<void> }>;

/**
 * Render the approved preview to PDF, refusing if any block runs past a footer (measured in the
 * browser, MEASURE_OVERFLOW_JS — the same function the validator runs).
 */
export async function renderFinalPdf(env: Env, html: string, launch?: PdfLauncher): Promise<{ pdfBase64: string; pageCount: number } | { pdfBase64: null; reason: string }> {
  const binding = (env as unknown as { BROWSER?: unknown }).BROWSER;
  if (!launch && !binding) return { pdfBase64: null, reason: "no browser is available here — the BROWSER binding is not configured" };
  let browser: { newPage(): Promise<any>; close(): Promise<void> } | null = null;
  try {
    browser = await (launch ?? (async (b: unknown) => (await (await import("@cloudflare/puppeteer")).launch(b as never)) as unknown as { newPage(): Promise<any>; close(): Promise<void> }))(binding);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html, { waitUntil: "load", timeout: 90_000 }); // "load", never "networkidle0": see htmlPdf.ts
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const over = (await page.evaluate(MEASURE_OVERFLOW_JS)) as Array<{ page: number; what: string }>;
    if (Array.isArray(over) && over.length > 0) {
      return { pdfBase64: null, reason: `page ${over[0]!.page} would cut "${over[0]!.what}" under the footer (${over.length} block(s) in all)` };
    }
    const bytes = new Uint8Array(await page.pdf({ width: "13.333in", height: "7.5in", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } }));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const pageCount = (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return { pdfBase64: btoa(bin), pageCount };
  } catch (err) {
    return { pdfBase64: null, reason: `the browser could not render the deck: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * A PARTNER'S "approved" MAKES THE DECK CURRENT. The decision is the partner's — an authenticated
 * reply from a Managing Partner's own address on the preview thread — so the CURRENT write carries
 * their name, exactly as the Fund strategy button does (handleDecideDeck).
 */
export async function makeApprovedDeckCurrent(env: Env, actor: Actor, versionId: string, fundId: string): Promise<void> {
  if (actor.type !== "HUMAN" || !actor.firmUserId) throw new Error("approving what goes to an LP is a human act");
  await env.WP_OS_DB.prepare("UPDATE deck_version SET state = 'SUPERSEDED' WHERE fund_id = ?1 AND id <> ?2 AND state = 'CURRENT'").bind(fundId, versionId).run();
  await env.WP_OS_DB.prepare("UPDATE deck_version SET state = 'CURRENT', approved_by = ?2, approved_at = ?3 WHERE id = ?1").bind(versionId, actor.firmUserId, nowIso()).run();
  // Any older proposal is closed by this decision, as a newer build always closed it.
  await env.WP_OS_DB.prepare("UPDATE deck_version SET state = 'REJECTED', rejected_reason = 'SUPERSEDED', approved_at = ?3 WHERE fund_id = ?1 AND id <> ?2 AND state = 'PROPOSED'").bind(fundId, versionId, nowIso()).run();
}

/**
 * A REPLY ON A ROUND THAT IS ALREADY FINISHED (owner, 11 Nov 2026: "if they ask for more work after
 * that, the latest approved deck goes back into a link and the loop starts again").
 *
 * A change request opens the NEXT round from the latest deck's slides and travels with it as that
 * round's first request; the round's one email tells both partners. A second "approved" changes
 * nothing and is answered with the PDF that already exists — link only, never a second attachment.
 */
async function afterTheRoundClosed(env: Env, p: PreviewRow, c: ChangeRow): Promise<string> {
  const done = await approvedVersion(env, p);
  if (c.kind === "APPROVAL") {
    const replied = await replyOnThread(env, p, done
      ? `This deck is already approved and final: v${done.versionNo}.${done.link ? ` Open it here: ${done.link}` : ""}\n\nNothing has changed. Reply here with any change and I'll put the deck back into a preview.`
      : `This round was closed without a final PDF, so there is nothing to approve here. Reply with any change and I'll put the latest deck back into a preview: ${PREVIEW_URL}`);
    await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = 'REFUSED', applied = ?2, replied_at = ?3, updated_at = ?4 WHERE id = ?1")
      .bind(c.id, done ? `already final: v${done.versionNo}; nothing changed` : "this round was closed without a final PDF", replied ? nowIso() : null, nowIso()).run();
    return `approval on a finished round answered${done ? ` with v${done.versionNo}` : ""}`;
  }
  const partner = partnerNamed(c.by_whom);
  if (!partner) {
    await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = 'REFUSED', applied = 'the request did not come from a Managing Partner', updated_at = ?2 WHERE id = ?1").bind(c.id, nowIso()).run();
    return "request on a finished round refused: not a partner";
  }
  const round = await roundFor(env, partner.firstName);
  // The request moves to the round that will do it, still waiting: the sweep applies it there and answers on that thread.
  await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET preview_id = ?2, updated_at = ?3 WHERE id = ?1").bind(c.id, round.preview.id, nowIso()).run();
  return round.created ? `${partner.firstName} asked for more work after the final PDF: round ${round.preview.round_no} opened from the approved deck` : `${partner.firstName}'s request moved to open round ${round.preview.round_no}`;
}

/** The round a partner's ask belongs to: the open one, or a new one built from the latest deck. */
async function roundFor(env: Env, who: string): Promise<{ preview: PreviewRow; created: boolean }> {
  const fund = await theFund(env);
  const open = await openPreview(env, fund.id);
  if (open) return { preview: open, created: false };
  const done = await approvedVersion(env, await latestPreview(env, fund.id));
  const line = done ? `${who} asked for more work, so the approved deck (v${done.versionNo}) is back in this preview` : `${who} asked to work on the deck, so the latest deck is in this preview`;
  return startOrUpdatePreview(env, { reason: line, changes: [line], askedBy: who });
}

/**
 * A PARTNER SAID THEY ARE READY TO WORK ON THE DECK (owner, 11 Nov 2026; matched by
 * shared/deck/start.ts, called from the email handler — so no model call and no PDF here).
 *
 * No round open → one starts from the latest deck, and its one email goes to both partners on the
 * next sweep. A round already open and emailed → no second round: both partners get the link again
 * on that round's thread, saying who asked. Whatever else the partner wrote is their first request.
 */
export async function startDeckFromEmail(env: Env, input: { partnerAddress: string; words: string }): Promise<{ outcome: "STARTED" | "JOINED_UNSENT" | "ALREADY_OPEN"; previewId: string; roundNo: number; detail: string }> {
  const partner = partnerByEmail(input.partnerAddress);
  if (!partner) throw new Error("only a Managing Partner starts a deck round");
  const who = partner.firstName;
  // "approved" here is never an approval: nobody approves a deck in the email that opens it.
  const words = input.words.trim() && !isApproval(input.words) ? input.words.trim() : "";
  const round = await roundFor(env, who);
  let p = round.preview;
  if (!round.created && !p.sent_at) {
    // Open but not emailed yet (held, or waiting for the sweep): the ask releases it, so both partners get the link.
    const asked = `${who} asked to work on the deck`;
    p = (await startOrUpdatePreview(env, { reason: asked, changes: [asked] })).preview;
    await env.WP_OS_DB.prepare("UPDATE deck_preview SET hold = 0, updated_at = ?2 WHERE id = ?1").bind(p.id, nowIso()).run();
  }
  if (words) await recordReply(env, p.id, words, input.partnerAddress);
  await appendEvent(env, { eventType: "deck_preview.start_asked", actorType: "firm_user", actorId: partner.firmUserId, objectType: "deck_preview", objectId: p.id, firmScope: p.firm_scope, payload: { round_no: p.round_no, created: round.created, already_emailed: !!p.sent_at, with_request: !!words } });
  if (!round.created && p.sent_at) {
    const replied = await replyOnThread(env, p, [
      `${who} asked to work on the deck. Round ${p.round_no} is already open, so we carry on in the same preview: ${PREVIEW_URL}`,
      words ? `${who} asked:\n"${words.slice(0, 1500)}"\n\nI'm working on that now and will reply here with what I changed.` : "",
      `Reply here with any changes in plain words, or with "approved". ${BOTH_APPROVE}`,
    ].filter(Boolean).join("\n\n"));
    return { outcome: "ALREADY_OPEN", previewId: p.id, roundNo: p.round_no, detail: `round ${p.round_no} was already open${replied ? "; both partners were sent the link again on its thread" : "; the reminder could not be sent"}` };
  }
  return { outcome: round.created ? "STARTED" : "JOINED_UNSENT", previewId: p.id, roundNo: p.round_no, detail: `deck preview round ${p.round_no} ${round.created ? "started" : "was waiting to be emailed"}; its email goes to both partners on the next sweep` };
}

/**
 * A PARTNER'S "approved". BOTH MUST SAY IT (owner, 11 Nov 2026: "We should both say 'approved'
 * before a new pdf is printed"). The first is recorded against the round and answered once; the PDF
 * is made when the other partner approves the same slides (`clearApprovals` is what "same" means).
 * A partner approving twice counts once.
 */
async function recordApproval(env: Env, p: PreviewRow, c: ChangeRow, launch?: PdfLauncher): Promise<string> {
  const partner = partnerNamed(c.by_whom);
  if (!partner) {
    await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = 'REFUSED', applied = 'the approval did not come from a Managing Partner', updated_at = ?2 WHERE id = ?1").bind(c.id, nowIso()).run();
    return "approval refused: not a partner";
  }
  const counted = [...new Set(((await env.WP_OS_DB.prepare("SELECT by_whom FROM deck_preview_change WHERE preview_id = ?1 AND kind = 'APPROVAL' AND state = 'DONE' ORDER BY created_at").bind(p.id).all<{ by_whom: string | null }>()).results ?? [])
    .map((r) => partnerNamed(r.by_whom)?.firstName).filter((n): n is string => !!n))];
  const twice = counted.includes(partner.firstName);
  const approvers = twice ? counted : [...counted, partner.firstName];
  const waitingOn = PARTNERS.filter((x) => !approvers.includes(x.firstName)).map((x) => x.firstName);
  if (waitingOn.length === 0 && !twice) return finishDeck(env, p, c, approvers, launch);
  const replied = waitingOn.length
    ? await replyOnThread(env, p, twice
        ? `${partner.firstName}'s "approved" is already counted. I'll make the final PDF when ${waitingOn.join(" and ")} also replies "approved" here.`
        : `${partner.firstName} approved the deck as it is in the preview: ${PREVIEW_URL}\n\nNo PDF yet. I'll make the final PDF when ${waitingOn.join(" and ")} also replies "approved" here. If the deck changes before then, I'll ask you both to approve again.`)
    : false;
  await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = 'DONE', applied = ?2, replied_at = ?3, updated_at = ?4 WHERE id = ?1")
    .bind(c.id, twice ? "already approved; counted once" : `approved; waiting for ${waitingOn.join(" and ")}`, replied ? nowIso() : null, nowIso()).run();
  return twice ? `${partner.firstName} approved again; counted once` : `${partner.firstName} approved; no PDF until ${waitingOn.join(" and ")} approves`;
}

/** The final PDF as the partners receive it: a copy of the approved version, named with its number. */
export function finalPdfFilename(versionNo: number): string {
  return `West-Peek-Ventures-Fund-I-deck-v${versionNo}.pdf`;
}

/** Both partners approved the same slides: make the PDF, make it current, send it. `c` is the approval that completed the pair. */
async function finishDeck(env: Env, p: PreviewRow, c: ChangeRow, approvers: readonly string[], launch?: PdfLauncher): Promise<string> {
  const partner = partnerNamed(c.by_whom)!;
  const both = approvers.join(" and ");
  const bothFull = approvers.map((n) => partnerNamed(n)?.fullName ?? n).join(" and ");
  await env.WP_OS_DB.prepare("UPDATE deck_preview SET state = 'APPROVED', approved_by = ?2, approved_at = COALESCE(approved_at, ?3), updated_at = ?3 WHERE id = ?1").bind(p.id, partner.firmUserId, nowIso()).run();
  const slides = JSON.parse(p.slides_json) as Slide[];
  const figures = await figuresFromRecords(env, p.fund_id);
  const html = renderDeckHtml(figures, slides, await loadAssets(env, slides));
  const pdf = await renderFinalPdf(env, html, launch);
  // A NAMED STOP: the approvals stand and the PDF is retried every sweep; the partners hear once.
  const waits = async (reason: string): Promise<string> => {
    if (!c.replied_at) {
      await replyOnThread(env, p, `${both} both approved the deck. I couldn't make the PDF yet: ${reason}. I'm on it and will reply here the moment it's done; nothing has gone to anyone.`);
      await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET replied_at = ?2, applied = ?3, updated_at = ?2 WHERE id = ?1").bind(c.id, nowIso(), `PDF not made yet: ${reason}`).run();
    }
    return `final PDF waits: ${reason}`;
  };
  if (!pdf.pdfBase64) return waits("reason" in pdf ? pdf.reason : "unknown");
  // The decision carries the name of the partner whose "approved" completed the pair; the record names both.
  const actor: Actor = { type: "HUMAN", firmUserId: partner.firmUserId, roles: ["MANAGING_PARTNER"], firmScopes: [p.firm_scope] };
  // A PDF the OS cannot file (the document store's size limit) is the same named stop, never a throw that ends the sweep unsaid.
  let version: Awaited<ReturnType<typeof recordDeckVersion>>;
  try {
    version = await recordDeckVersion(env, actor, {
      fundId: p.fund_id,
      title: `West Peek Ventures Fund I — approved by ${both}`,
      origin: "BUILT",
      createdBy: DECK_OWNER,
      createdByType: "AI",
      pdfBase64: pdf.pdfBase64,
      pageCount: pdf.pageCount,
      changeSummary: `Final PDF of deck preview round ${p.round_no}, approved by ${bothFull} by email. ${(JSON.parse(p.what_changed_json) as string[]).join(" · ")}`.slice(0, 3000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return waits(/upload limit/.test(why) ? "the PDF is too big for the OS to file (over 5 MB)" : `the OS could not file it (${why})`);
  }
  await makeApprovedDeckCurrent(env, actor, version.id, p.fund_id);
  const link = version.document_id ? `https://os.joinwestpeek.com/api/documents/${version.document_id}/download` : null;
  await env.WP_OS_DB.prepare("UPDATE deck_preview SET state = 'FINAL', final_deck_version_id = ?2, final_note = ?3, updated_at = ?4 WHERE id = ?1").bind(p.id, version.id, link, nowIso()).run();
  await addChange(env, p.id, { kind: "FINAL", by: DECK_OWNER, applied: `v${version.version_no}, ${pdf.pageCount} pages, approved by ${both}` });
  /*
   * THE PDF ARRIVES AS AN ATTACHMENT AND A LINK (owner, 11 Nov 2026) — to the two partners, on this
   * thread, and nowhere else. The OS copy is the record either way, so a file too big for an email,
   * or an attached send the transport refuses, becomes the same reply with the link and one line
   * saying why there is no file: the partners never get silence and the round is finished regardless.
   */
  const made = (how: string) => `${both} both approved the deck, so I made the final PDF: v${version.version_no}, ${pdf.pageCount} pages. ${how}${link ? `\n\nOpen it here: ${link}` : ""}\n\nIt's now the current deck on Fund strategy. That's the version that goes to LPs.`;
  const file: EmailAttachment = { filename: finalPdfFilename(version.version_no), content: pdf.pdfBase64, contentType: "application/pdf" };
  // The document store takes less than an email does today, so a filed PDF always fits; the check stays for the day that limit is raised.
  const fits = attachmentsBytes([file]) <= OUTBOUND_ATTACHMENTS_MAX_BYTES;
  let attached = fits && (await replyOnThread(env, p, made("It's attached, and the same file is in the OS."), [file]));
  if (!attached) {
    await replyOnThread(env, p, made(fits ? "I couldn't attach the file to this email, so please use the link." : "The file is too big to attach to an email, so please use the link."));
    attached = false;
  }
  await env.WP_OS_DB.prepare("UPDATE deck_preview_change SET state = 'DONE', applied = ?2, replied_at = ?3, updated_at = ?3 WHERE id = ?1").bind(c.id, `final PDF v${version.version_no}${attached ? ", attached" : ", link only"}`, nowIso()).run();
  await appendEvent(env, { eventType: "deck_preview.final", actorType: "firm_user", actorId: partner.firmUserId, objectType: "deck_version", objectId: version.id, firmScope: p.firm_scope, payload: { preview_id: p.id, round_no: p.round_no, version_no: version.version_no, approved_by: approvers, pdf_attached: attached } });
  return `final PDF v${version.version_no}`;
}

// ── The sweep ─────────────────────────────────────────────────────────────────────────────────

/** Runs on the diagnostics sweep: records → preview, replies → preview, the round's one email. */
export async function deckPreviewTick(env: Env, deps: { editor?: DeckEditor; launch?: PdfLauncher } = {}): Promise<string> {
  const notes: string[] = [];
  const moved = await previewIfRecordsMoved(env).catch((err: unknown) => ({ moved: false, reason: `deck preview check failed: ${err instanceof Error ? err.message : String(err)}` }));
  if (moved.moved || moved.reason.startsWith("deck preview check failed")) notes.push(moved.reason);
  notes.push(...(await applyPending(env, deps)));
  const fund = await env.WP_OS_DB.prepare("SELECT id FROM fund LIMIT 1").first<{ id: string }>();
  const open = fund ? await openPreview(env, fund.id) : null;
  if (open && open.state === "OPEN" && !open.hold && !open.sent_at) {
    const sent = await sendRound(env, open.id);
    notes.push(sent.sent ? `deck preview round ${open.round_no} ${sent.reason}` : `deck preview not emailed: ${sent.reason}`);
  }
  return notes.join(" · ");
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

function partnerOnly(ctx: RouteContext): Actor | Response {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN" || !partnerByEmail(ctx.identity!.email)) {
    return new Response("The deck preview is for the Managing Partners.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return actor;
}

/** GET /api/deck/preview — the open round (or the latest one), as the review page. */
export async function handleGetDeckPreview(ctx: RouteContext): Promise<Response> {
  const a = partnerOnly(ctx);
  if (a instanceof Response) return a;
  const fund = await theFund(ctx.env);
  const p = (await openPreview(ctx.env, fund.id)) ?? (await latestPreview(ctx.env, fund.id));
  if (!p) return new Response("There is no deck preview yet.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const slides = JSON.parse(p.slides_json) as Slide[];
  const figures = await figuresFromRecords(ctx.env, fund.id);
  const pages = renderDeckPages(figures, slides, await loadAssets(ctx.env, slides));
  const history = ((await ctx.env.WP_OS_DB.prepare("SELECT * FROM deck_preview_change WHERE preview_id = ?1 AND kind IN ('REQUEST','APPROVAL','RECORDS') ORDER BY created_at").bind(p.id).all<ChangeRow>()).results ?? [])
    .map((h) => ({ when: h.created_at, who: h.by_whom, said: h.said, applied: h.applied, state: h.state }));
  const html = renderPreviewPage({
    roundNo: p.round_no, state: p.state, hold: p.hold === 1, sentAt: p.sent_at,
    whatChanged: JSON.parse(p.what_changed_json) as string[], kept: p.kept_note, pages, history, finalLink: p.final_note,
  });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

/** POST /api/deck/preview/release — a partner lets the held round go: one email, to both. */
export async function handleReleaseDeckPreview(ctx: RouteContext): Promise<Response> {
  const a = partnerOnly(ctx);
  if (a instanceof Response) return a;
  const fund = await theFund(ctx.env);
  const p = await openPreview(ctx.env, fund.id);
  if (!p) return json({ error: "not_found", detail: "there is no open deck preview" }, { status: 404 });
  await ctx.env.WP_OS_DB.prepare("UPDATE deck_preview SET hold = 0, updated_at = ?2 WHERE id = ?1").bind(p.id, nowIso()).run();
  await appendEvent(ctx.env, { eventType: "deck_preview.released", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "deck_preview", objectId: p.id, firmScope: p.firm_scope, payload: { round_no: p.round_no } });
  const out = await sendRound(ctx.env, p.id);
  // A form post lands back on the page it came from, which now says it was emailed.
  if ((ctx.request.headers.get("accept") ?? "").includes("text/html")) return new Response(null, { status: 303, headers: { location: "/api/deck/preview" } });
  return json(out);
}
