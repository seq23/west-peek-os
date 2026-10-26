import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { textBodyOf } from "../effects/mimeAttachments";
import { listGmailRaw } from "../effects/googleClient";
import { serviceAccountToken } from "../effects/googleWorkspaceClient";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import { addressIn, authenticationVerdict } from "../../shared/intake/partnerAuthority";
import { newTextOf } from "../../shared/events/packetDecisionToken";
import { isEmptyReply, parseDraftReply } from "../../shared/tlc/draftReply";
import {
  BRAND_MUST_STAFF, BRAND_REPLY_ASK, BRAND_REPLY_REF_RE, CALL_ASK, WE_HOST, MONEY_WORDS, NO_CALL_ASK, THREE_THINGS_OFFER, WHO_WE_ARE, classifyBrandReply, fallbackReplyBody, herNoteOf, noMoneyNow, readResearch, reportText,
  stageAfterReply, standingRulesIn, theirNewText, tierLines, wantsResearch,
  type BrandReplyIntent, type ReplyDraftInput, type WynnRule,
} from "../../shared/tlc/brandReply";
import { TLC_DRIP_DAYS, TLC_OWNER, TLC_SIGNATURE, brandDisplayName, monthWords, nextDripAt } from "../../shared/tlc/learningClub";
import { TLC_BRAND_SALES_JOB } from "../../shared/policy/outsideEmail";
import { actorForFirmUser, type Actor } from "./authorize";
import type { TlcDealRow, TlcEventRow } from "./learningClub";

/**
 * WYNN ANSWERS A BRAND'S REPLY, SEQUOIA APPROVES IT (owner, 26 Oct 2026).
 *
 * The defect this closes: a brand replied (stop_reason REPLIED), the drip stopped, and nothing drafted an answer
 * or asked her anything; any message that was not a bounce or an unsubscribe counted as a reply, out-of-office
 * included. Now every brand message is read by `classifyBrandReply` and:
 *   - an auto-reply resumes the drip the day after they are back (no email to anybody);
 *   - a "no" makes the deal DECLINED;
 *   - a real reply gets Sequoia's answer drafted by Wynn, and the approval email goes to her AT ONCE (owner, 26 Oct
 *     2026: "Why 4pm?" — replies are rare and time-sensitive; the once-a-week rule is for outbound drafts only), to
 *     her approval address (tlc_setting `brand_reply_approver_email`, else her own) with their message and the
 *     draft word for word.
 * Her "approved" sends it once (a state claim makes a second "approved" a no-op), from the mailbox the brand email
 * went from (her own Gmail, through the executor's brand-sales lane), threaded on their message, and moves the
 * stage (a call or a yes → CALL). "change: …" redrafts and asks again; "skip" sends nothing.
 *
 * WYNN LISTENS (owner, 26 Oct 2026, TLR-EL84CT). Her whole note is read (her signature off, never a character cut);
 * every instruction in it is in the redraft prompt; a request to research makes Wynn research the brand on a search
 * lane first and put a short report ABOVE the new draft; and the standing parts of a note ("don't discuss money this
 * early") become Wynn's rules (`tlc_wynn_rule`), which every later draft reads and the code enforces where it can.
 *
 * Replies arrive two ways and are de-duplicated on their Message-ID: the intake door (Reply-To names it) and her
 * own inbox, polled each drip pass for messages from deal contacts (a brand she wrote to by hand replies to her
 * alone).
 */

export const APPROVER_SETTING = "brand_reply_approver_email";
/** How long a reply waits before Wynn tries its research again, and how many tries before the draft goes without it. */
export const RESEARCH_RETRY_MINUTES = 30;
export const RESEARCH_TRIES = 3;
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const WYNN = "aie_wynn";
const wynnActor = (firmScope: string): Actor => ({ type: "AI", aiEmployeeId: WYNN, roles: [], firmScopes: [firmScope] } as unknown as Actor);

export interface BrandMessage { messageId: string; subject: string; text: string; receivedAt: string }
export interface DraftExtras {
  note: string | null;
  previous: string | null;
  /** Wynn's standing rules from her, every active row of `tlc_wynn_rule`. */
  rules: WynnRule[];
  /** True before a call has happened while her no-money rule stands: no price, tier or budget in the draft. */
  noMoney: boolean;
  /** What Wynn found when she asked for research, for the draft to use. */
  research: string | null;
}
export type ReplyDrafter = (env: Env, actor: Actor, input: ReplyDraftInput & DraftExtras) => Promise<{ ok: boolean; body: string; detail: string }>;
export type BrandResearcher = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;
export type MailboxReader = (env: Env, query: string) => Promise<Array<BrandMessage & { from: string }>>;
export interface BrandReplyDeps { now?: Date; drafter?: ReplyDrafter; mailbox?: MailboxReader | null; researcher?: BrandResearcher }

interface ReplyRow {
  id: string; deal_id: string; brand_message_id: string; their_subject: string; their_text: string; received_at: string; intent: string;
  draft_subject: string; draft_body: string; state: string; notice_ref: string | null; firm_scope: string;
  change_note?: string | null; report_text?: string | null; research_due?: string | null; research_tries?: number;
}

export const normalizeMid = (id: string | null | undefined): string => (id ?? "").trim().replace(/^<|>$/g, "");

/** Wynn's standing rules from her, oldest first. Never throws: an unreadable table reads as no rules. */
export async function wynnRules(env: Env, firmScope = "west-peek"): Promise<WynnRule[]> {
  try {
    return (await env.WP_OS_DB.prepare("SELECT code, rule FROM tlc_wynn_rule WHERE active = 1 AND firm_scope = ?1 ORDER BY added_at, id").bind(firmScope).all<WynnRule>()).results ?? [];
  } catch {
    return [];
  }
}

/** The standing parts of her note, kept as rules for every later draft (each sentence once). */
export async function learnRules(env: Env, note: string, source: string, firmScope = "west-peek"): Promise<number> {
  const have = new Set((await wynnRules(env, firmScope)).map((r) => r.rule.trim().toLowerCase()));
  let added = 0;
  for (const rule of standingRulesIn(note)) {
    if (have.has(rule.toLowerCase())) continue;
    await env.WP_OS_DB.prepare("INSERT INTO tlc_wynn_rule (id, code, rule, source, firm_scope) VALUES (?1, NULL, ?2, ?3, ?4)").bind(`wr_${crypto.randomUUID()}`, rule, `her note on ${source}`, firmScope).run();
    have.add(rule.toLowerCase());
    added += 1;
  }
  return added;
}

const chicago = (at: Date): { day: string; hour: number } => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

async function setting(env: Env, key: string): Promise<string | null> {
  return (await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(key).first<{ value: string | null }>())?.value ?? null;
}

// ── Drafting ───────────────────────────────────────────────────────────────────────────────────

const PROMPT_RULES = [
  "You are Wynn, who runs sales for The Learning Club at West Peek Ventures. Draft Sequoia Taylor's answer to a brand that replied to her partnership email.",
  "Write as Sequoia, first person, warm, plain and short (under 220 words). Answer exactly what they asked.",
  "Use ONLY the facts given here: who we are, the club, its topic and month, and anything listed below. Invent nothing: no numbers, dates, names or claims that are not below.",
  "No postal address. No P.S. No signature (it is added after). Never name anyone at West Peek other than Sequoia, except Scooter Taylor as our founding GP where the rules below say so.",
  "Do not attach or mention a PDF or deck unless they asked for one or said yes.",
  "End with one clear next step, as Wynn's standing rules below say.",
];

/** Wynn's rules as the prompt states them; the WHO_WE_ARE row is the facts a first answer must explain. */
export function rulesBlock(rules: readonly WynnRule[]): string[] {
  if (rules.length === 0) return [];
  return [
    "WYNN'S STANDING RULES FROM SEQUOIA — follow every one, in every draft:",
    ...rules.map((r) => (r.code === WHO_WE_ARE ? `- Every first reply or introduction to a brand explains who we are, in these facts: ${r.rule}` : `- ${r.rule}`)),
  ];
}

const defaultDrafter: ReplyDrafter = async (env, actor, i) => {
  const prompt = [
    ...PROMPT_RULES,
    "",
    ...rulesBlock(i.rules),
    "",
    `Brand: ${brandDisplayName(i.brand)}. Their first name: ${i.contactName?.split(" ")[0] ?? "(unknown: open with \"Hi,\")"}.`,
    `The club: The Learning Club, ${i.topic}, in ${monthWords(i.month)}, New York.`,
    `Why this brand fits (one sentence may be used): ${i.why ?? "a natural fit for the room"}`,
    ...(i.noMoney
      ? ["No money yet: do NOT mention any price, fee, budget, amount or partnership level; that waits for the call."]
      : ["Partnership levels (no category exclusivity; never promise any):", ...tierLines().map((l) => `- ${l}`)]),
    ...(i.research ? ["", "What Wynn found researching them (use it; invent nothing beyond it):", i.research] : []),
    i.intent === "YES" && i.pitchUrl ? `They said yes: say the one-page pitch PDF is attached and also at ${i.pitchUrl}.` : "",
    ...(i.rules.some((r) => r.code === NO_CALL_ASK)
      ? i.intent === "CALL"
        ? [`They proposed a call: say yes to it.${i.callLink ? ` Her booking link: ${i.callLink}` : " Ask which times suit them."}`]
        : [`Never suggest or ask for a call. Next step: ${THREE_THINGS_OFFER}`]
      : [i.callLink ? `Her booking link for a call: ${i.callLink}` : "No booking link: ask for two times that suit them."]),
    "",
    "Their message, word for word:",
    i.theirText,
    ...(i.note && i.previous ? ["", "Her previous draft:", i.previous, "", "Her note, word for word. Follow EVERY instruction in it, each one, in this redraft:", i.note] : []),
    "",
    'Return ONLY JSON: {"body":""}',
  ].filter((l) => l !== "").join("\n");
  const { run } = await runAi(env, {
    purpose: "The Learning Club: draft Sequoia's answer to a brand",
    actor,
    inputs: [prompt],
    sensitivity: "PUBLIC" as never,
    // Brand-facing, in her name: important work (owner, 26 Oct 2026) — the Claude seat, then Codex, never a free lane.
    budgetContext: { requiresSearch: false, expectedOutputTokens: 900, judgement: true, important: true },
    routing: { category: "INTELLIGENCE" },
  } as never);
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, body: "", detail: run.failure_reason ?? `run ${run.status}` };
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(run.output_text)?.[0] ?? "") as { body?: string };
    return j.body?.trim() ? { ok: true, body: j.body.trim(), detail: "ok" } : { ok: false, body: "", detail: "the draft came back empty" };
  } catch {
    return { ok: false, body: "", detail: "the draft could not be read" };
  }
};

/** A draft that breaks her voice rules is not used; the plain template stands in. */
export function draftProblems(body: string, intent: BrandReplyIntent, opts: { noMoney?: boolean; noCallAsk?: boolean; weHost?: boolean } = {}): string[] {
  const out: string[] = [];
  if (/\bP\.?\s?S\.?\b/.test(body)) out.push("a P.S.");
  if (/\b\d{2,5}\s+\w+(?:\s\w+)?\s(?:street|st\.?|avenue|ave\.?|road|rd\.?|blvd|suite)\b/i.test(body)) out.push("a postal address");
  // Scooter is named only as who he is to the brand (her WHO_WE_ARE rule): "Scooter Taylor", our founding GP.
  if (/\bscooter\b(?!\s+taylor)/i.test(body)) out.push("a name other than hers");
  if (opts.noMoney && MONEY_WORDS.test(body)) out.push("money before a call (her rule)");
  if (opts.weHost && BRAND_MUST_STAFF.test(body)) out.push("puts the brand's people on a segment (her rule: led by the brand or by our host)");
  if (opts.noCallAsk && intent !== "CALL" && CALL_ASK.test(body)) out.push("asks for a call (her rule: the brand may propose one, Wynn never does)");
  if (intent !== "YES" && /\b(attached|attachment|pdf)\b/i.test(body)) out.push("an attachment before a yes");
  if (/\bexclusiv/i.test(body)) out.push("exclusivity");
  return out;
}

async function draftFor(env: Env, deal: TlcDealRow, ev: TlcEventRow, intent: BrandReplyIntent, theirText: string, deps: BrandReplyDeps, redo: { note: string; previous: string; research?: string | null } | null = null): Promise<string> {
  const { CALL_LINK_SETTING, pitchPublicUrl } = await import("./learningClub");
  const input: ReplyDraftInput = {
    intent, brand: deal.brand, contactName: deal.contact_name, topic: ev.topic ?? "", month: ev.month, why: deal.why_fit, theirText,
    pitchUrl: ev.pitch_token ? pitchPublicUrl(ev.pitch_token) : null, callLink: await setting(env, CALL_LINK_SETTING),
  };
  const rules = await wynnRules(env, deal.firm_scope);
  const noMoney = noMoneyNow(rules, deal.stage);
  const noCallAsk = rules.some((r) => r.code === NO_CALL_ASK);
  const weHost = rules.some((r) => r.code === WE_HOST);
  const out = await (deps.drafter ?? defaultDrafter)(env, wynnActor(deal.firm_scope), { ...input, note: redo?.note ?? null, previous: redo?.previous ?? null, rules, noMoney, research: redo?.research ?? null })
    .catch((err) => ({ ok: false, body: "", detail: String(err) }));
  const words = out.ok && draftProblems(out.body, intent, { noMoney, noCallAsk, weHost }).length === 0
    ? out.body
    : fallbackReplyBody(input, monthWords, { noMoney, noCallAsk, whoWeAre: rules.find((r) => r.code === WHO_WE_ARE)?.rule ?? null });
  return [words.trim(), "", ...TLC_SIGNATURE].join("\n");
}

// ── Research she asked for ─────────────────────────────────────────────────────────────────────

/** Wynn researches the brand on a live-search lane (the seats first; never a lane that cannot search). */
export async function researchBrand(
  env: Env, deal: TlcDealRow, ev: TlcEventRow, theirText: string, note: string, deps: BrandReplyDeps,
): Promise<{ ok: true; report: string } | { ok: false; detail: string }> {
  const rules = await wynnRules(env, deal.firm_scope);
  const who = rules.find((r) => r.code === WHO_WE_ARE)?.rule ?? "West Peek Ventures runs West Peek Rooms, an in-person event series in New York; The Learning Club is its hands-on part.";
  const prompt = [
    `You are Wynn, who runs sales for The Learning Club at West Peek Ventures. Sequoia asked you to research ${brandDisplayName(deal.brand)} before she answers them.`,
    "Search the live web now. Read the brand's own recent pages and news from the last 12 months.",
    `Who we are: ${who}`,
    `The club: The Learning Club, ${ev.topic ?? ""}, in ${monthWords(ev.month)} (tentative), New York: a small, hands-on room.`,
    "",
    "Their message, word for word:",
    theirText,
    "",
    "Her note, word for word:",
    note,
    "",
    "Return ONLY JSON:",
    '{"care":["3 to 5 short points: what they care about now (launches, campaigns, the people they want to reach, priorities)"],',
    ' "value":["3 to 5 short points: the value we can bring them, each tied to one of those points"],',
    ' "sources":[{"title":"","url":"a page you actually read"}]}',
    "No prices, fees or partnership levels. Invent nothing; every point must come from a source you list.",
  ].join("\n");
  const { defaultSearch } = await import("./learningClub");
  const found = await (deps.researcher ?? defaultSearch)(env, wynnActor(deal.firm_scope), prompt).catch((err) => ({ ok: false, text: "", detail: String(err) }));
  if (!found.ok) return { ok: false, detail: found.detail };
  const { jsonIn } = await import("./learningClub");
  const r = readResearch(jsonIn(found.text));
  return r ? { ok: true, report: reportText(brandDisplayName(deal.brand), r) } : { ok: false, detail: "the research came back without points in each part and a source" };
}

/**
 * ONE REDRAFT FOR HER NOTE. Research first when she asked for it; a search that could not run leaves the reply
 * waiting (research_due) and the next pass tries again; after RESEARCH_TRIES the draft goes to her with the report
 * saying plainly that the research could not run, never silently without it.
 */
async function redraftFor(env: Env, r: ReplyRow, note: string, now: Date, deps: BrandReplyDeps): Promise<"DRAFTED" | "RESEARCH_WAITING"> {
  const deal = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>())!;
  const ev = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>())!;
  const previous = wordsOf(r.draft_body);
  let report: string | null = null;
  if (wantsResearch(note)) {
    const found = await researchBrand(env, deal, ev, r.their_text, note, deps);
    if (found.ok) report = found.report;
    else {
      const tries = (r.research_tries ?? 0) + 1;
      if (tries < RESEARCH_TRIES) {
        const due = new Date(now.getTime() + RESEARCH_RETRY_MINUTES * 60_000).toISOString();
        await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, change_note = ?2, research_due = ?3, research_tries = ?4, held_reason = ?5 WHERE id = ?1")
          .bind(r.id, note, due, tries, `research try ${tries} of ${RESEARCH_TRIES} did not run (${found.detail.slice(0, 160)}); tries again at ${due}`).run();
        return "RESEARCH_WAITING";
      }
      report = `WYNN'S REPORT ON ${brandDisplayName(deal.brand).toUpperCase()}: the research you asked for could not run after ${RESEARCH_TRIES} tries (${found.detail.slice(0, 200)}). This draft uses only what we already knew.`;
    }
  }
  const draft = await draftFor(env, deal, ev, r.intent as BrandReplyIntent, r.their_text, deps, { note, previous, research: report });
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, draft_body = ?2, change_note = ?3, report_text = ?4, research_due = NULL, held_reason = NULL WHERE id = ?1")
    .bind(r.id, draft, note, report).run();
  return "DRAFTED";
}

const wordsOf = (body: string): string => {
  const cut = body.lastIndexOf(`\n${TLC_SIGNATURE[0]}`);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
};

// ── Taking a reply ─────────────────────────────────────────────────────────────────────────────

export type TakeOutcome = "SEEN" | "AUTO_REPLY" | "NO" | "DRAFTED";

export async function takeBrandReply(env: Env, deal: TlcDealRow, msg: BrandMessage, deps: BrandReplyDeps = {}): Promise<TakeOutcome> {
  const now = deps.now ?? new Date();
  const mid = normalizeMid(msg.messageId) || `nomid:${msg.receivedAt}`;
  if (await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_brand_reply WHERE deal_id = ?1 AND brand_message_id = ?2").bind(deal.id, mid).first()) return "SEEN";
  const words = theirNewText(textBodyOf(msg.text)) || msg.text.trim();
  const cls = classifyBrandReply({ subject: msg.subject, text: words }, now);
  const close = (intent: string, note: string) => env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, held_reason, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', 'CLOSED', ?8, ?9)",
  ).bind(`tbr_${crypto.randomUUID()}`, deal.id, mid, msg.subject.slice(0, 300), words.slice(0, 8000), msg.receivedAt, intent, note, deal.firm_scope).run();

  if (cls.kind === "AUTO_REPLY") {
    // Back on the drip, never earlier than its own next step; a finished drip stays finished.
    const due = nextDripAt(deal.drip_step, deal.first_sent_at, now, null);
    const resume = deal.drip_step >= TLC_DRIP_DAYS.length || !["PROSPECT", "PITCHED"].includes(deal.stage) ? null
      : new Date(Math.max(Date.parse(cls.resumeAt), due ? Date.parse(due) : 0)).toISOString();
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stop_reason = NULL, replied_at = NULL, next_send_at = ?2, updated_at = ?3 WHERE id = ?1 AND stop_reason IS NULL OR id = ?1 AND stop_reason = 'REPLIED'")
      .bind(deal.id, resume, now.toISOString()).run();
    await close("AUTO_REPLY", resume ? `auto-reply; the drip resumes ${resume}` : "auto-reply; the drip had finished");
    await appendEvent(env, { eventType: "tlc.brand_auto_reply", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { resume_at: resume } });
    return "AUTO_REPLY";
  }
  if (cls.kind === "NO") {
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'DECLINED', decision = 'NO', stop_reason = 'DECLINED', next_send_at = NULL, updated_at = ?2 WHERE id = ?1").bind(deal.id, now.toISOString()).run();
    await close("NO", "they said no");
    await appendEvent(env, { eventType: "tlc.brand_declined", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: {} });
    return "NO";
  }
  const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
  if (!ev) return "SEEN";
  await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stop_reason = 'REPLIED', replied_at = COALESCE(replied_at, ?2), next_send_at = NULL, updated_at = ?2 WHERE id = ?1 AND (stop_reason IS NULL OR stop_reason = 'REPLIED')").bind(deal.id, now.toISOString()).run();
  const body = await draftFor(env, deal, ev, cls.intent, words, deps);
  const subject = `Re: ${msg.subject.replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, "").trim() || `${brandDisplayName(deal.brand)} + a small room in New York`}`;
  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'DRAFTED', ?10)",
  ).bind(`tbr_${crypto.randomUUID()}`, deal.id, mid, msg.subject.slice(0, 300), words.slice(0, 8000), msg.receivedAt, cls.intent, subject.slice(0, 300), body, deal.firm_scope).run();
  await appendEvent(env, { eventType: "tlc.brand_reply_drafted", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { intent: cls.intent } });
  return "DRAFTED";
}

/** The deals a reply could belong to, by the sender's address. */
export async function dealsForSender(env: Env, from: string): Promise<TlcDealRow[]> {
  const address = (addressIn(from) ?? from).trim().toLowerCase();
  return (await env.WP_OS_DB.prepare(
    "SELECT * FROM tlc_deal WHERE lower(contact_email) = ?1 AND stage NOT IN ('DECLINED','STOPPED') AND (stop_reason IS NULL OR stop_reason = 'REPLIED')",
  ).bind(address).all<TlcDealRow>()).results ?? [];
}

const defaultMailbox: MailboxReader = async (env, query) => {
  const token = await serviceAccountToken(env, [GMAIL_READ_SCOPE], TLC_OWNER.email);
  return (await listGmailRaw(token, query)).map(({ raw, internalDate }) => {
    const head = raw.split(/\r?\n\r?\n/)[0] ?? "";
    const h = (name: string) => new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(head)?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() ?? "";
    return { messageId: h("Message-ID"), from: h("From"), subject: h("Subject"), text: raw, receivedAt: new Date(Number(internalDate ?? Date.now())).toISOString() };
  });
};

/**
 * Each drip pass: (a) a reply the door stopped on but never read (no words, or before this existed) is read from
 * the stored message; (b) her inbox is read for anything from a deal contact. Returns a line for the job summary.
 */
export async function processBrandReplies(env: Env, now: Date, firmScope = "west-peek", deps: BrandReplyDeps = {}): Promise<string> {
  const d = { ...deps, now };
  const counts: Record<TakeOutcome, number> = { SEEN: 0, AUTO_REPLY: 0, NO: 0, DRAFTED: 0 };
  const unread = (await env.WP_OS_DB.prepare(
    `SELECT d.* FROM tlc_deal d WHERE d.firm_scope = ?1 AND d.stop_reason = 'REPLIED'
       AND NOT EXISTS (SELECT 1 FROM tlc_brand_reply r WHERE r.deal_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM tlc_pitch_followup f WHERE f.deal_id = d.id AND f.state = 'SENT')`,
  ).bind(firmScope).all<TlcDealRow>()).results ?? [];
  for (const deal of unread) {
    const since = new Date(Date.parse(deal.replied_at ?? now.toISOString()) - 10 * 60_000).toISOString();
    const row = await env.WP_OS_DB.prepare("SELECT message_id, r2_key, subject, received_at FROM inbound_message WHERE lower(from_address) = lower(?1) AND received_at >= ?2 ORDER BY received_at LIMIT 1")
      .bind(deal.contact_email, since).first<{ message_id: string | null; r2_key: string | null; subject: string; received_at: string }>();
    const obj = row?.r2_key && env.WP_OS_DOCUMENTS ? await env.WP_OS_DOCUMENTS.get(row.r2_key) : null;
    if (!row || !obj) continue;
    counts[await takeBrandReply(env, deal, { messageId: row.message_id ?? "", subject: row.subject, text: await obj.text(), receivedAt: row.received_at }, d)] += 1;
  }
  let polled = "inbox not read";
  if (deps.mailbox !== null && (deps.mailbox || env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON)) {
    const live = (await env.WP_OS_DB.prepare(
      "SELECT * FROM tlc_deal WHERE firm_scope = ?1 AND first_sent_at IS NOT NULL AND first_sent_at >= ?2 AND stage NOT IN ('DECLINED','STOPPED') AND (stop_reason IS NULL OR stop_reason = 'REPLIED')",
    ).bind(firmScope, new Date(now.getTime() - 60 * 86_400_000).toISOString()).all<TlcDealRow>()).results ?? [];
    const addresses = [...new Set(live.map((x) => x.contact_email.toLowerCase()))];
    if (addresses.length) {
      const after = Math.floor(Math.min(...live.map((x) => Date.parse(x.first_sent_at!))) / 1000);
      try {
        const found = await (deps.mailbox ?? defaultMailbox)(env, `from:(${addresses.join(" OR ")}) after:${after}`);
        for (const m of found) {
          const from = (addressIn(m.from) ?? m.from).toLowerCase();
          for (const deal of live.filter((x) => x.contact_email.toLowerCase() === from && Date.parse(m.receivedAt) > Date.parse(x.first_sent_at!))) {
            counts[await takeBrandReply(env, deal, m, d)] += 1;
          }
        }
        polled = `inbox read (${found.length} message(s) from ${addresses.length} contact(s))`;
      } catch (err) {
        polled = `inbox not read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      }
    }
  }
  // Research she asked for that could not run yet: tried again once due.
  const due = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply WHERE firm_scope = ?1 AND state = 'DRAFTED' AND research_due IS NOT NULL AND research_due <= ?2")
    .bind(firmScope, now.toISOString()).all<ReplyRow>()).results ?? [];
  for (const r of due) await redraftFor(env, r, r.change_note ?? "", now, d);
  const notice = await sendReplyApprovals(env, now, firmScope);
  return `brand replies: ${counts.DRAFTED} drafted, ${counts.AUTO_REPLY} auto-reply (drip resumed), ${counts.NO} declined; ${polled}; ${notice}`;
}

// ── The one approval email a day ───────────────────────────────────────────────────────────────

function mintRef(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `TLR-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => abc[b % abc.length]).join("")}`;
}

/**
 * To her, in the exec format, through the one TLC door to the owner (emailOwner → the partner-email door). The
 * firm's outside-email boundary keeps every employee email on the two partner addresses, so this goes to her
 * partner inbox; `brand_reply_approver_email` (a D1 setting, never this public repository) names another inbox of
 * hers whose authenticated reply is also accepted. Her reply comes back to Wynn and the intake door reads it.
 */
async function emailHer(env: Env, firmScope: string, objectId: string, email: Omit<ExecEmailInput, "employee">): Promise<boolean> {
  const { emailOwner } = await import("./learningClub");
  const sent = await emailOwner(env, { employee: "Wynn", email, objectType: "tlc_brand_reply_notice", objectId, cardId: null, cardKind: null, firmScope });
  if (sent.length === 0) throw new Error("the owner email was not sent");
  return true;
}

export async function approverAddress(env: Env): Promise<string> {
  return ((await setting(env, APPROVER_SETTING)) ?? TLC_OWNER.email).trim().toLowerCase();
}

/**
 * Sends her the approval email for every drafted reply, AT ONCE (owner, 26 Oct 2026: "Why 4pm?"). A reply is rare
 * and time-sensitive, so it never waits for an hour of the day; the once-a-week batching is for outbound drafts only.
 * Send-once: a row moves DRAFTED → NOTIFIED with the email, so the next pass finds nothing to send again. A reply
 * still waiting for the research she asked for (research_due) is not sent until the research ran.
 */
export async function sendReplyApprovals(env: Env, now: Date, firmScope = "west-peek"): Promise<string> {
  const waiting = (await env.WP_OS_DB.prepare(
    `SELECT r.*, d.brand, d.contact_name, d.contact_email, e.month, e.topic FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id JOIN tlc_event e ON e.id = d.event_id
      WHERE r.firm_scope = ?1 AND r.state = 'DRAFTED' AND r.research_due IS NULL ORDER BY r.received_at`,
  ).bind(firmScope).all<ReplyRow & { brand: string; contact_name: string | null; contact_email: string; month: string; topic: string | null }>()).results ?? [];
  const researching = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_brand_reply WHERE firm_scope = ?1 AND state = 'DRAFTED' AND research_due IS NOT NULL").bind(firmScope).first<{ n: number }>())?.n ?? 0;
  if (waiting.length === 0) return researching ? `${researching} brand repl${researching === 1 ? "y" : "ies"} waiting for Wynn's research` : "no brand reply waiting for her";
  const ct = chicago(now);
  const ref = mintRef();
  const to = TLC_OWNER.email;
  const blocks = waiting.map((r, i) => [
    `── ${i + 1} · ${brandDisplayName(r.brand)} · The Learning Club, ${monthWords(r.month)}${r.topic ? ` (${r.topic})` : ""} ──`,
    `From: ${r.contact_name ? `${r.contact_name} ` : ""}<${r.contact_email}>, ${r.received_at.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "THEIR MESSAGE, WORD FOR WORD",
    `Subject: ${r.their_subject}`,
    "",
    r.their_text,
    "",
    ...(r.change_note ? ["YOUR NOTE, WORD FOR WORD", r.change_note, ""] : []),
    ...(r.report_text ? [r.report_text, ""] : []),
    "WYNN'S DRAFT OF YOUR ANSWER, WORD FOR WORD",
    `Subject: ${r.draft_subject}`,
    "",
    r.draft_body,
  ].join("\n"));
  const many = waiting.length > 1;
  try {
    await emailHer(env, firmScope, ref, {
      what: `${waiting.length} brand repl${many ? "ies" : "y"} to approve · ${ref}`,
      tldr: `${waiting.length} brand${many ? "s" : ""} replied to your Learning Club email${many ? "s" : ""}. ${BRAND_REPLY_ASK}.`,
      tldrBullets: many ? ['Reply "approved" to send all', 'Or "approve 1" · "skip 2" · "change 2: what to change"'] : ['Reply "approved" to send it', "Or reply with your changes"],
      sections: [
        { label: "Who replied", bullets: waiting.map((r, i) => `${i + 1} · ${brandDisplayName(r.brand)} (${monthWords(r.month)}): ${r.intent === "CALL" ? "wants a call" : r.intent === "YES" ? "said yes (the pitch PDF goes with your answer)" : "asked a question"}`).slice(0, 6) },
        { label: "What happens on your word", bullets: ["Your answer goes from your own mailbox, on their thread", "A call they asked for moves the deal to Call", "Nothing goes to a brand until you say so"] },
      ],
      details: [...blocks.flatMap((b) => [b, ""]), `Ref ${ref}`].join("\n"),
    });
  } catch (err) {
    return `the approval email could not be sent (${err instanceof Error ? err.message : String(err)}); the next pass tries again`;
  }
  const messageId: string | null = null;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply_notice (ref, reply_ids_json, day, firm_scope, sent_at, sent_to, forced, gmail_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(ref, JSON.stringify(waiting.map((r) => r.id)), ct.day, firmScope, now.toISOString(), to, 0, messageId).run();
  for (const r of waiting) await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'NOTIFIED', notice_ref = ?2 WHERE id = ?1 AND state = 'DRAFTED'").bind(r.id, ref).run();
  await appendEvent(env, { eventType: "tlc.brand_reply_notice", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { replies: waiting.length } });
  return `approval email ${ref} with ${waiting.length} brand repl${many ? "ies" : "y"} sent`;
}

// ── Her answer ─────────────────────────────────────────────────────────────────────────────────

export interface ApprovalOutcome { handled: boolean; ref: string | null; detail: string }

export async function applyBrandReplyApproval(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; body: string },
  deps: BrandReplyDeps = {},
): Promise<ApprovalOutcome> {
  const body = textBodyOf(message.body);
  const ref = BRAND_REPLY_REF_RE.exec(body)?.[0] ?? BRAND_REPLY_REF_RE.exec(message.subject)?.[0] ?? null;
  if (!ref) return { handled: false, ref: null, detail: "no brand-reply reference" };
  const notice = await env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply_notice WHERE ref = ?1").bind(ref).first<{ ref: string; reply_ids_json: string; firm_scope: string; sent_to: string | null }>();
  if (!notice) return { handled: false, ref, detail: "unknown brand-reply reference" };
  const firmScope = notice.firm_scope;
  const from = (addressIn(message.fromHeader) ?? "").toLowerCase();
  const allowed = new Set([await approverAddress(env), TLC_OWNER.email.toLowerCase(), (notice.sent_to ?? "").toLowerCase()].filter(Boolean));
  const verdict = authenticationVerdict(message.authenticationResults, from || null);
  if (!allowed.has(from) || !verdict.passed) {
    await appendEvent(env, { eventType: "tlc.brand_reply_refused", actorType: "system", actorId: "inbound_email", objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { from, why: allowed.has(from) ? verdict.reason : "not her address" } });
    return { handled: false, ref, detail: `a reply to ${ref} was not accepted as hers` };
  }
  const now = deps.now ?? new Date();
  const ids = JSON.parse(notice.reply_ids_json) as string[];
  // Her words alone: the quoted email and any "Ref TLR-…" line are not part of her instruction.
  // Her WHOLE note: her signature off, never a character cut (herNoteOf; NOTE_MAX is stated if ever reached).
  const said = herNoteOf(newTextOf(body).split(/\r?\n/).filter((l) => !/^\s*Ref\s+TLR-[A-Z0-9]{6}\s*$/.test(l)).join("\n"), TLC_OWNER.name);
  const parsed = parseDraftReply(said);
  // One reply in the email: free text that is not an approve/skip is her change to it.
  if (isEmptyReply(parsed)) {
    if (ids.length === 1 && said && !/^(no|cancel)\b/i.test(said)) parsed.change.push({ n: 1, note: said });
    else return { handled: false, ref, detail: `a reply to ${ref} carried no approve / skip / change instruction` };
  }
  const owner = await actorForFirmUser(env, TLC_OWNER.firmUserId);
  if (!owner) return { handled: false, ref, detail: `${TLC_OWNER.email} is not an active person in the OS` };
  const changed = new Set(parsed.change.map((c) => c.n));
  const skipped = new Set(parsed.skip);
  const approve = new Set(parsed.approveAll ? ids.map((_, i) => i + 1) : parsed.approve);
  for (const n of [...changed, ...skipped]) approve.delete(n);
  const lines: string[] = [];
  const rowOf = (n: number) => (ids[n - 1] ? env.WP_OS_DB.prepare("SELECT r.*, d.brand, d.contact_email, d.stage FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id WHERE r.id = ?1").bind(ids[n - 1]).first<ReplyRow & { brand: string; contact_email: string; stage: string }>() : Promise.resolve(null));

  for (const n of [...approve].sort((a, b) => a - b)) {
    const r = await rowOf(n);
    if (!r) { lines.push(`${n}: not in that email`); continue; }
    // THE CLAIM: only one "approved" can move it from NOTIFIED, so a second one (or a re-delivery) sends nothing.
    const claim = await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SENDING' WHERE id = ?1 AND state = 'NOTIFIED' AND notice_ref = ?2").bind(r.id, ref).run();
    if ((claim.meta?.changes ?? 0) === 0) { lines.push(`${n} · ${brandDisplayName(r.brand)}: already ${r.state === "SENT" ? "sent" : r.state.toLowerCase()}, nothing sent again`); continue; }
    try {
      await sendApproved(env, owner, r, now);
      lines.push(`${n} · ${brandDisplayName(r.brand)}: sent from ${TLC_OWNER.email}, on their thread`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'FAILED', held_reason = ?2 WHERE id = ?1").bind(r.id, why.slice(0, 300)).run();
      lines.push(`${n} · ${brandDisplayName(r.brand)}: NOT sent (${why.slice(0, 160)})`);
    }
  }
  for (const n of [...skipped]) {
    const r = await rowOf(n);
    if (!r) continue;
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SKIPPED', held_reason = ?2 WHERE id = ?1 AND state = 'NOTIFIED'").bind(r.id, `skipped by her (${ref})`).run();
    lines.push(`${n} · ${brandDisplayName(r.brand)}: skipped, nothing sent`);
  }
  let redrafted = 0;
  let learned = 0;
  for (const c of parsed.change) {
    const r = await rowOf(c.n);
    if (!r || r.state !== "NOTIFIED") continue;
    // The standing parts of her note are Wynn's rules from now on, for every later draft — this one included.
    learned += await learnRules(env, c.note, ref, firmScope);
    await redraftFor(env, { ...r, research_tries: 0 }, c.note, now, deps);
    redrafted += 1;
  }
  const again = redrafted ? await sendReplyApprovals(env, now, firmScope) : null;
  if (lines.length) {
    await emailHer(env, firmScope, `${ref}:done`, {
      what: `brand replies, done · ${ref}`,
      tldr: `${lines.filter((l) => /: sent /.test(l)).length} sent, from your mailbox, on their threads.`,
      sections: [{ label: "Done", bullets: lines.slice(0, 6) }, { label: "Next", bullets: [again ? `Redrafted for your note: ${again}` : "Wynn watches for their answer"] }],
    }).catch(() => false);
  }
  await appendEvent(env, { eventType: "tlc.brand_reply_decided", actorType: "firm_user", actorId: TLC_OWNER.firmUserId, objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { lines, redrafted, learned } });
  return { handled: true, ref, detail: [...lines, ...(redrafted ? [`${redrafted} redrafted`] : [])].join("; ") || "nothing to do" };
}

/** Her approved answer, through the brand-sales lane: approval card, executor, her own Gmail, threaded. */
async function sendApproved(env: Env, owner: Actor, r: ReplyRow & { brand: string; contact_email: string; stage: string }, now: Date): Promise<void> {
  const { BRAND_REPLY_TO, approvedFor, clubViewOf, renderPdfFor } = await import("./learningClub");
  const deal = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>())!;
  const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
  // The pitch PDF goes only in answer to a yes.
  const attachments = r.intent === "YES" && ev?.topic ? await renderPdfFor(env, clubViewOf(ev), ev.topic).catch(() => []) : [];
  const requestId = `eer_${crypto.randomUUID()}`;
  const inReplyTo = r.brand_message_id.startsWith("nomid:") ? null : r.brand_message_id;
  await env.WP_OS_DB.prepare(
    "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id, outside_job) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4, ?5)",
  ).bind(requestId, r.contact_email, JSON.stringify({ subject: r.draft_subject, text: r.draft_body, reply_to: BRAND_REPLY_TO, ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), ...(attachments.length ? { attachments } : {}) }), WYNN, TLC_BRAND_SALES_JOB).run();
  const { requestApproval, decideApproval } = await import("./approvals");
  const card = await requestApproval(env, wynnActor(r.firm_scope), {
    action_key: "effect.email.send", object_type: "external_effect_request", object_id: requestId,
    title: `Wynn: TLC answer to ${brandDisplayName(r.brand)}`, summary: `${r.draft_subject}\n\n${r.draft_body}`.slice(0, 1800),
    payload: { deal_id: r.deal_id, brand_reply_id: r.id }, submit: true,
  });
  await decideApproval(env, owner, card.id, "approved", `Approved by email reply (${r.notice_ref}).`);
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET effect_request_id = ?2, approval_card_id = ?3 WHERE id = ?1").bind(r.id, requestId, card.id).run();
  const { executeExternalEffect } = await import("../effects/executor");
  await executeExternalEffect(approvedFor(env, card.id, r.contact_email), wynnActor(r.firm_scope), requestId, card.id);
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SENT', sent_at = ?2 WHERE id = ?1").bind(r.id, now.toISOString()).run();
  const stage = stageAfterReply(r.intent as BrandReplyIntent, deal.stage);
  await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = COALESCE(?2, stage), yes_at = CASE WHEN ?3 = 'YES' THEN COALESCE(yes_at, ?4) ELSE yes_at END, updated_at = ?4 WHERE id = ?1").bind(deal.id, stage, r.intent, now.toISOString()).run();
}
