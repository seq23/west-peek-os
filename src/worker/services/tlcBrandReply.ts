import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";
import { atItsHeight, brandCommunityWords, overstatedCommunityClaims } from "../../shared/community/size";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { textBodyOf } from "../effects/mimeAttachments";
import { withBrandFooter } from "../../shared/tlc/brandFooter";
import type { EmailAttachment } from "../effects/emailTransport";
import { listGmailRaw } from "../effects/googleClient";
import { serviceAccountToken } from "../effects/googleWorkspaceClient";
import { BrandThreadError, replyThread, type ThreadFinder } from "./tlcBrandThread";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import { addressIn, authenticationVerdict } from "../../shared/intake/partnerAuthority";
import { newTextOf } from "../../shared/events/packetDecisionToken";
import { isEmptyReply, parseDraftReply } from "../../shared/tlc/draftReply";
import {
  BRAND_MUST_STAFF, BRAND_REPLY_ASK, BRAND_REPLY_REF_RE, CALL_ASK, WE_HOST, MONEY_WORDS, THREE_THINGS_OFFER, WHO_WE_ARE, classifyBrandReply, fallbackReplyBody, herNoteOf, replyAllRecipients, noMoneyNow, readResearch, reportText,
  stageAfterReply, standingRulesIn, theirNewText, tierLines, wantsResearch,
  type BrandReplyIntent, type ReplyDraftInput, type WynnRule,
} from "../../shared/tlc/brandReply";
import { renderWynnDraftEmail, draftEmailProblems, unansweredNotes, type ChangeLine } from "../../shared/tlc/wynnDraftEmail";
import { seriesPriceWords } from "../../shared/tlc/series";
import { docNameFor, peopleOf, replyPageUrl, sheetMini, splitContactName } from "../../shared/tlc/replyDoc";
import { BRAND_EMAIL_ROOM_WORDS, classifyBrandMail, TLC_BRAND_REPLY_NOTICE_CC_IDS, TLC_BRAND_REPLY_NOTICE_OBJECT, TLC_PRICING_NOTICE_OBJECT, TLC_DRIP_DAYS, TLC_OWNER, TLC_SEATS, TLC_SIGNATURE, brandDisplayName, signedBrandEmail, monthWords, nextDripAt } from "../../shared/tlc/learningClub";
import { partnerByEmail, partnerByFirmUserId } from "../../shared/registry/partners";
import { TLC_BRAND_SALES_JOB } from "../../shared/policy/outsideEmail";
import { actorForFirmUser, type Actor } from "./authorize";
import type { TlcDealRow, TlcEventRow } from "./learningClub";
import { freeSlots, isFree, pickedSlot, proposedTime, slotWords } from "../../shared/tlc/callSlots";
import { isYesToSamples, requestsSamples, samplesCoverEmail } from "../../shared/tlc/samples";
import { fillTemplate, greetingFor, hiLine, levelPicked, proposalLevelLines } from "../../shared/tlc/brandFlow";
import { brandLevels, sponsorOf, type TlcSponsorView } from "../../shared/tlc/pitch";
import { herBusy, makeEvent as defaultMakeEvent, callEvent, type BusyReader, type EventMaker } from "./tlcCalls";
import { SamplesPdfError, buildSamples, finalizeSamplesPdf, reviseSamples, samplesForDeal, samplesPreviewLink, samplesRevisions, tlcRevisionWriter, storePdf, storedAttachment, textPage, type SamplesDeps, type StoredFile } from "./tlcSamples";

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
 * own inbox, polled each drip pass for messages on sent threads or from brand domains (a brand she wrote to by hand replies to her
 * alone).
 */

export const APPROVER_SETTING = "brand_reply_approver_email";
/** A redraft that left a partner's note without a change line: held, never sent to them looking finished. */
export const NOTE_UNANSWERED = "WYNN_NOTE_UNANSWERED";
/** refreshStaleSheets' note on a draft whose sheet was made again: said as the email's "what changed" line. */
const STALE_SHEET_PREFIX = "WHAT CHANGED SINCE THE LAST EMAIL:";
const PARTNER_FIRST_NAMES: readonly string[] = [TLC_OWNER.firmUserId, ...TLC_BRAND_REPLY_NOTICE_CC_IDS].map((id) => partnerByFirmUserId(id)?.firstName ?? id);
/** How long a reply waits before Wynn tries its research again, and how many tries before the draft goes without it. */
export const RESEARCH_RETRY_MINUTES = 30;
export const RESEARCH_TRIES = 3;
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const WYNN = "aie_wynn";
const wynnActor = (firmScope: string): Actor => ({ type: "AI", aiEmployeeId: WYNN, roles: [], firmScopes: [firmScope] } as unknown as Actor);

export interface BrandMessage { messageId: string; subject: string; text: string; receivedAt: string; threadId?: string; from?: string }
export interface DraftExtras {
  note: string | null;
  previous: string | null;
  /** Wynn's standing rules from her, every active row of `tlc_wynn_rule`. */
  rules: WynnRule[];
  /** True before a call has happened while her no-money rule stands: no price, tier or budget in the draft. */
  noMoney: boolean;
  /** What Wynn found when she asked for research, for the draft to use. */
  research: string | null;
  /** A call they asked for (her SCHEDULE_THEIR_CALL rule): the times to offer from her calendar, or the time agreed. */
  callPlan?: CallPlan | null;
  samplesAttached?: boolean;
  /** This brand's own levels (its sheet's), so a draft never offers Title or in-kind where the sheet does not. */
  levels?: ReturnType<typeof brandLevels>;
  /** Each partner's note on a redraft, by name; Wynn returns at least one change line for each. */
  notes?: ReadonlyArray<{ who: string; note: string }>;
}
export type CallPlan = { offer: string[] } | { agreed: string };
export type ReplyDrafter = (env: Env, actor: Actor, input: ReplyDraftInput & DraftExtras) => Promise<{ ok: boolean; body: string; detail: string; changes?: ChangeLine[] }>;
export type BrandResearcher = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;
export type MailboxReader = (env: Env, query: string, maxPages?: number) => Promise<Array<BrandMessage & { from: string }>>;
export interface BrandReplyDeps {
  now?: Date; drafter?: ReplyDrafter; mailbox?: MailboxReader | null; researcher?: BrandResearcher;
  /** Her calendar's busy times, and the event maker (tests pass fakes; production reads and writes her Google calendar). */
  busy?: BusyReader; makeEvent?: EventMaker;
  samples?: SamplesDeps;
  /** Where a conversation sits in her mailbox (services/tlcBrandThread.ts); tests pass a fake. */
  thread?: ThreadFinder;
}

interface ReplyRow {
  id: string; deal_id: string; brand_message_id: string; their_subject: string; their_text: string; received_at: string; intent: string;
  draft_subject: string; draft_body: string; state: string; notice_ref: string | null; firm_scope: string;
  send_to?: string | null; send_cc_json?: string | null; approved_by_json?: string | null;
  change_note?: string | null; report_text?: string | null; research_due?: string | null; research_tries?: number;
  samples_id?: string | null; previous_draft?: string | null; round?: string | null; inputs_json?: string | null; offered_slots_json?: string | null; agreed_slot?: string | null; calendar_event_id?: string | null; held_reason?: string | null;
  kind?: string | null; tier?: string | null; attachments_json?: string | null; send_retry_due?: string | null; send_tries?: number;
  version?: number | null; changes_json?: string | null; thread_ref?: string | null; sent_at?: string | null; effect_request_id?: string | null;
}

export const normalizeMid = (id: string | null | undefined): string => (id ?? "").trim().replace(/^<|>$/g, "");

/** Wynn's standing rules from her, oldest first. Never throws: an unreadable table reads as no rules. */
export async function wynnRules(env: Env, firmScope = "west-peek"): Promise<WynnRule[]> {
  try {
    // A rule's words are read through the community-size source of truth, so a stored "more than 5,000" never reaches a draft.
    const rows = (await env.WP_OS_DB.prepare("SELECT code, rule FROM tlc_wynn_rule WHERE active = 1 AND firm_scope = ?1 ORDER BY added_at, id").bind(firmScope).all<WynnRule>()).results ?? [];
    return rows.map((r) => ({ ...r, rule: brandCommunityWords(r.rule) }));
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

const TLC_TIER_LABEL = (k: string): string => ({ TITLE: "Title partner", PARTNER: "Partner", LEAD: "Lead partner", PRESENTING: "Presenting partner", PRODUCT: "Product partner" } as Record<string, string>)[k] ?? k;

// ── Drafting ───────────────────────────────────────────────────────────────────────────────────

const PROMPT_RULES = [
  "You are Wynn, who runs sales for The Learning Club at West Peek Ventures. Draft Sequoia Taylor's answer to a brand that replied to her partnership email.",
  "Write as Sequoia, first person, warm, plain and short (under 220 words). Answer exactly what they asked.",
  "Use ONLY the facts given here: who we are, the club, its topic and month, and anything listed below. Invent nothing: no numbers, dates, names or claims that are not below.",
  "No postal address, no P.S. and no signature: the signature and our mailing-address footer are added after. Never name anyone at West Peek other than Sequoia, except Scooter Taylor as our founding GP where the rules below say so.",
  "Do not attach or mention a PDF or deck unless they asked for one or said yes.",
  "End with one clear next step, as Wynn's standing rules below say.",
  "The room and the community (owner, 6 Nov 2026): never promise a number of guests above 25 and never guarantee attendance; say rooms of 25+, sized to their goals. Say we built a community of about 5,000 and that we curate each room from that network; never 'more than 5,000' and never 'nearly 5,000 at its height' (owner, 7 Nov 2026). No guarantees of any kind.",
  "When the partners' notes conflict, Scooter's note wins (owner, 7 Nov 2026).",
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
      ? ["No money yet: do NOT mention any price, fee, budget, amount or partnership level; that waits until the samples have gone. Never suggest a call to get there."]
      : ["Partnership levels for this brand, every price per event, lowest first (no category exclusivity; never promise any; never offer a level not listed here):", ...tierLines(i.levels).map((l) => `- ${l}`)]),
    ...(i.research ? ["", "What Wynn found researching them (use it; invent nothing beyond it):", i.research] : []),
    i.intent === "YES" && i.pitchUrl && !i.noMoney ? `They said yes: say the one-page pitch PDF is attached and also at ${i.pitchUrl}.` : "",
    ...(i.samplesAttached ? ["The brand already requested the materials. The current samples PDF is attached. Say it is attached; never offer to send it later."] : []),
    ...(i.callPlan
      ? "offer" in i.callPlan
        ? ["They asked for a call. Offer exactly these times, word for word, and ask which suits them (or another time that works for them):", ...i.callPlan.offer.map((x) => `- ${slotWords(x)}`)]
        : [`They asked for a call and she is free then: say yes to ${slotWords(i.callPlan.agreed)}, and that a calendar invitation is on its way.`]
      // NEVER A CALL WE ASK FOR (owner, 1 Nov 2026, a standing rule, no longer only her NO_CALL_ASK row): deals close
      // by email end to end. A call THEY propose is always a yes, scheduled from her calendar (shared/tlc/callSlots.ts).
      : i.samplesAttached ? []
      : i.intent === "CALL"
        ? [`They proposed a call: say yes to it.${i.callLink ? ` Her booking link: ${i.callLink}` : " Ask which times suit them."}`]
        : [`Never suggest or ask for a call. Next step: ${THREE_THINGS_OFFER}`]),
    "",
    "Their message, word for word:",
    i.theirText,
    ...(i.note && i.previous ? ["", "The previous draft:", i.previous, "", "The partners' notes, word for word, each under the name of who wrote it. Follow EVERY instruction in them, each one, in this redraft. When two notes conflict, Scooter's note wins:", i.note] : []),
    "",
    i.note && i.previous
      ? `Return ONLY JSON: {"body":"","changes":[{"who":"${(i.notes ?? []).map((n) => n.who).join('" or "') || "Sequoia"}","note":"their words, short","done":"what you changed for it, in a few words"}]}. At least one line in changes for each person's note; a note you could not follow still gets a line saying why.`
      : 'Return ONLY JSON: {"body":""}',
  ].filter((l) => l !== "").join("\n");
  const out = await tlcRevisionWriter(env, actor, prompt);
  if (!out.ok) return { ok: false, body: "", detail: "the revision model did not complete" };
  // jsonIn reads a body the model wrote with real line breaks inside the string (Scooter, 6 Nov 2026, TLR-XALAD7):
  // strict JSON.parse threw the answer away and a plain template went back as the "redraft".
  const { jsonIn } = await import("./learningClub");
  const j = jsonIn(out.text);
  if (!j) return { ok: false, body: "", detail: "the draft could not be read" };
  const body = typeof j.body === "string" ? j.body.trim() : "";
  return body ? { ok: true, body, detail: "ok", changes: changeLinesOf(j.changes) } : { ok: false, body: "", detail: "the draft came back empty" };
};

/** A draft that breaks her voice rules is not used; the plain template stands in. */
export function draftProblems(body: string, intent: BrandReplyIntent, opts: { noMoney?: boolean; weHost?: boolean; callPlan?: CallPlan | null } = {}): string[] {
  const out: string[] = [];
  if (/\bP\.?\s?S\.?\b/.test(body)) out.push("a P.S.");
  if (/\b\d{2,5}\s+\w+(?:\s\w+)?\s(?:street|st\.?|avenue|ave\.?|road|rd\.?|blvd|suite)\b/i.test(body)) out.push("a postal address");
  // Scooter is named only as who he is to the brand (her WHO_WE_ARE rule): "Scooter Taylor", our founding GP.
  if (/\bscooter\b(?!\s+taylor)/i.test(body)) out.push("a name other than hers");
  if (opts.noMoney && MONEY_WORDS.test(body)) out.push("money before a call (her rule)");
  for (const c of overstatedCommunityClaims(body)) out.push(`a community size above the true one: "${c}" (say about 5,000)`);
  // Owner, 7 Nov 2026: "about 5,000", never the retired "nearly 5,000 at its height"; no head count above 25, no guarantee.
  for (const c of atItsHeight(body)) { out.push(`the retired community wording: "${c}" (say about 5,000)`); break; }
  for (const m of body.matchAll(/(?<!(?:to|–|-)\s*)\b(?:up to |as many as |around |about )?(\d{2,4})\s+(?:people|guests|attendees|New Yorkers|founders|builders)\b/gi)) {
    if (Number(m[1]) > 25 && !out.some((o) => o.startsWith("a room of"))) { out.push(`promises ${m[0].trim()} (her rule: never more than 25; say rooms of ${BRAND_EMAIL_ROOM_WORDS}, sized to their goals)`); break; }
  }
  if (/\bguarantee/i.test(body)) out.push("a guarantee (her rule: no guarantees)");
  // Every brand email says rooms of 25+ guests, sized to their goals (her GUESTS_25_40 rule, revised 1 Nov 2026): never a
  // range ("25 to 100+", "25–40", "60–150") and never another number with a plus. The PDFs keep "25 to 100+".
  for (const m of body.matchAll(/\b(\d+)\s*(?:to|–|-)\s*(\d+)(\+?)\s+(?:people|guests|New Yorkers)\b/gi)) {
    out.push(`a room of ${m[1]} to ${m[2]}${m[3]} (her rule: rooms of ${BRAND_EMAIL_ROOM_WORDS} guests, sized to their goals)`); break;
  }
  for (const m of body.matchAll(/(?<!(?:to|–|-)\s*)\b(\d+)\+\s+(?:people|guests|New Yorkers)\b/gi)) {
    if (`${m[1]}+` !== BRAND_EMAIL_ROOM_WORDS) { out.push(`a room of ${m[1]}+ (her rule: rooms of ${BRAND_EMAIL_ROOM_WORDS} guests, sized to their goals)`); break; }
  }
  if (opts.weHost && BRAND_MUST_STAFF.test(body)) out.push("puts the brand's people on a segment (her rule: led by the brand or by our host)");
  if (opts.callPlan) {
    const want = "offer" in opts.callPlan ? opts.callPlan.offer : [opts.callPlan.agreed];
    for (const x of want) if (!body.includes(slotWords(x))) out.push(`the time ${slotWords(x)} is not in it word for word`);
  }
  if (intent !== "CALL" && !opts.callPlan && CALL_ASK.test(body)) out.push("asks for a call (her rule: the brand may propose one, Wynn never does)");
  if (intent !== "YES" && /\b(attached|attachment|pdf)\b/i.test(body)) out.push("an attachment before a yes");
  if (/\bexclusiv/i.test(body)) out.push("exclusivity");
  return out;
}

/** The answer for a call they asked for, when the model is away: the times, or the yes, in her voice. */
export function callFallback(contactName: string | null, plan: CallPlan): string {
  if ("agreed" in plan) return fillTemplate("callYes", { hi: hiLine(contactName), time: slotWords(plan.agreed) });
  return fillTemplate("callTimes", { hi: hiLine(contactName), times: plan.offer.map((x) => `• ${slotWords(x)}`).join("\n") });
}

/** Change lines as the model returned them, read strictly: each needs what was done. */
export function changeLinesOf(v: unknown): ChangeLine[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    const done = String(o.done ?? "").trim();
    return done ? [{ who: String(o.who ?? "").trim() || null, note: String(o.note ?? "").trim().slice(0, 200) || null, done: done.slice(0, 300) }] : [];
  });
}

/**
 * The partners' notes on a draft, by name. A round-2 note is stored "Sequoia: …\n\nScooter: …" (notesOf); a round-1
 * note is hers alone.
 */
export function notesByName(changeNote: string | null | undefined): Array<{ who: string; note: string }> {
  const t = (changeNote ?? "").trim();
  if (!t) return [];
  const names = PARTNER_FIRST_NAMES.join("|");
  const parts = t.split(new RegExp(`\\n\\s*\\n(?=(?:${names}): )`));
  const named = parts.map((p) => new RegExp(`^(${names}): ([\\s\\S]*)$`).exec(p.trim()));
  if (named.every((m) => m)) return named.map((m) => ({ who: m![1]!, note: m![2]!.trim() }));
  return [{ who: firstNameOf(TLC_OWNER.firmUserId), note: t }];
}

async function draftFor(env: Env, deal: TlcDealRow, ev: TlcEventRow, intent: BrandReplyIntent, theirText: string, deps: BrandReplyDeps, redo: { note: string; previous: string; research?: string | null; samplesAttached?: boolean } | null = null, callPlan: CallPlan | null = null): Promise<string> {
  return (await draftWithChanges(env, deal, ev, intent, theirText, deps, redo, callPlan)).body;
}

async function draftWithChanges(env: Env, deal: TlcDealRow, ev: TlcEventRow, intent: BrandReplyIntent, theirText: string, deps: BrandReplyDeps, redo: { note: string; previous: string; research?: string | null; samplesAttached?: boolean } | null = null, callPlan: CallPlan | null = null): Promise<{ body: string; changes: ChangeLine[] }> {
  const { CALL_LINK_SETTING, pitchPublicUrl } = await import("./learningClub");
  const input: ReplyDraftInput = {
    intent, brand: deal.brand, contactName: deal.contact_name, topic: ev.topic ?? "", month: ev.month, why: deal.why_fit, theirText,
    pitchUrl: ev.pitch_token ? pitchPublicUrl(ev.pitch_token) : null, callLink: await setting(env, CALL_LINK_SETTING),
  };
  const rules = await wynnRules(env, deal.firm_scope);
  // Money first appears at step 4 of her flow: once the samples went, prices may be discussed.
  const noMoney = noMoneyNow(rules, deal.stage) && !(await flowStep(env, deal.id)).samplesSent;
  const weHost = rules.some((r) => r.code === WE_HOST);
  const levels = brandLevels(await sponsorFor(env, deal, theirText), ev.topic ?? "");
  const notes = redo ? notesByName(redo.note) : [];
  const out: { ok: boolean; body: string; detail: string; changes?: ChangeLine[] } = await (deps.drafter ?? defaultDrafter)(env, wynnActor(deal.firm_scope), { ...input, note: redo?.note ?? null, previous: redo?.previous ?? null, rules, noMoney, research: redo?.research ?? null, callPlan, samplesAttached: redo?.samplesAttached, levels, notes })
    .catch((err) => ({ ok: false, body: "", detail: String(err) }));
  const used = out.ok && draftProblems(out.body, intent, { noMoney, weHost, callPlan }).length === 0 && (!redo?.samplesAttached || (/\battach(?:ed|ment)\b/i.test(out.body) && !/\b(?:can|could|happy to) (?:send|share)\b/i.test(out.body)));
  const words = used && draftProblems(out.body, intent, { noMoney, weHost, callPlan }).length === 0 && (!redo?.samplesAttached || (/\battach(?:ed|ment)\b/i.test(out.body) && !/\b(?:can|could|happy to) (?:send|share)\b/i.test(out.body)))
    ? out.body
    : redo?.samplesAttached ? samplesCoverEmail({ brand: brandDisplayName(deal.brand), contactName: deal.contact_name, topic: ev.topic ?? "", segmentTitle: (await flowStep(env, deal.id)).segment ?? "The brand segment" })
    : callPlan
      ? callFallback(deal.contact_name, callPlan)
      : fallbackReplyBody(input, monthWords, { noMoney, whoWeAre: rules.find((r) => r.code === WHO_WE_ARE)?.rule ?? null });
  // A stand-in template answered no note: it carries no change lines, so the email to her is held (unansweredNotes).
  return { body: signedBrandEmail(words), changes: used ? out.changes ?? [] : [] };
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
  if (r.samples_id) {
    const revised = await reviseSamples(env, deal, ev, note, deps.samples ?? {});
    if (!revised.ok) {
      const due = new Date(now.getTime() + RESEARCH_RETRY_MINUTES * 60_000).toISOString();
      await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, change_note = ?2, research_due = ?3, held_reason = ?4 WHERE id = ?1").bind(r.id, note, due, `samples revision waiting: ${revised.detail.slice(0, 200)}`).run();
      return "RESEARCH_WAITING";
    }
  }
  const { body: draft, changes } = await draftWithChanges(env, deal, ev, r.intent as BrandReplyIntent, r.their_text, deps, { note, previous, research: report, samplesAttached: Boolean(r.samples_id) });
  /*
   * vN COUNTS UP PER REDRAFT (owner, 7 Nov 2026): one more than the last version the partners saw (a redraft that was
   * held and redone before anyone saw it keeps its number). A note with no change line holds the email: Wynn tries
   * again on the next passes, and after RESEARCH_TRIES the pass names the stop (sendReplyApprovals).
   */
  const shown = await env.WP_OS_DB.prepare("SELECT MAX(version) AS v FROM tlc_brand_reply_version WHERE reply_id = ?1").bind(r.id).first<{ v: number | null }>().catch(() => null);
  const version = (shown?.v ?? r.version ?? 1) + 1;
  const missing = r.samples_id ? [] : unansweredNotes(notesByName(note), changes);
  const tries = (r.research_tries ?? 0) + 1;
  const retry = missing.length > 0 && tries < RESEARCH_TRIES ? new Date(now.getTime() + RESEARCH_RETRY_MINUTES * 60_000).toISOString() : null;
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, approved_by_json = NULL, draft_body = ?2, change_note = ?3, report_text = ?4, research_due = ?6, research_tries = ?7, held_reason = ?8, previous_draft = ?5, version = ?9, changes_json = ?10 WHERE id = ?1")
    .bind(r.id, draft, note, report, r.draft_body, retry, missing.length ? tries : 0, missing.length ? `${NOTE_UNANSWERED}: no change line for ${missing.join(" and ")}'s note (try ${tries} of ${RESEARCH_TRIES})` : null, version, JSON.stringify(changes)).run();
  return "DRAFTED";
}

/** A yes to the samples whose PDF was not ready: built again; the reply goes to her once it is. */
async function retrySamples(env: Env, r: ReplyRow, now: Date, deps: BrandReplyDeps): Promise<void> {
  const deal = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>())!;
  const ev = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>())!;
  const built = await buildSamples(env, deal, ev, { theirText: r.their_text }, deps.samples ?? {});
  if (built.ok) {
    const segment = (JSON.parse(built.row.input_json) as { segmentTitle: string }).segmentTitle;
    const body = signedBrandEmail(samplesCoverEmail({ brand: brandDisplayName(deal.brand), contactName: deal.contact_name, topic: ev.topic ?? "", segmentTitle: segment }));
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET draft_body = ?2, samples_id = ?3, research_due = NULL, held_reason = NULL WHERE id = ?1 AND state = 'DRAFTED'").bind(r.id, body, built.row.id).run();
    return;
  }
  const due = new Date(now.getTime() + RESEARCH_RETRY_MINUTES * 60_000).toISOString();
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET research_due = ?2, held_reason = ?3 WHERE id = ?1").bind(r.id, due, `the samples PDF is not ready yet (${built.detail.slice(0, 200)}); tried again each pass`).run();
}

const wordsOf = (body: string): string => {
  const cut = body.lastIndexOf(`\n${TLC_SIGNATURE[0]}`);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
};

// ── Taking a reply ─────────────────────────────────────────────────────────────────────────────

/** Our own mail domains: never copied on an answer to a brand. */
const OUR_MAIL_DOMAINS: readonly string[] = [...new Set([TLC_OWNER.email, INTAKE_MAILBOX].map((a) => a.split("@")[1]!.toLowerCase()))];
/** Who an answer goes to: the brand's latest message, reply-all; an older row without it goes to the deal's contact. */
export function answerRecipients(r: { send_to?: string | null; send_cc_json?: string | null; contact_email: string }): { to: string; cc: string[] } {
  return { to: (r.send_to ?? r.contact_email).trim().toLowerCase(), cc: r.send_cc_json ? (JSON.parse(r.send_cc_json) as string[]) : [] };
}

export type TakeOutcome = "SEEN" | "AUTO_REPLY" | "NO" | "WAITING" | "DRAFTED";

export async function takeBrandReply(env: Env, deal: TlcDealRow, msg: BrandMessage, deps: BrandReplyDeps = {}): Promise<TakeOutcome> {
  const now = deps.now ?? new Date();
  const mid = normalizeMid(msg.messageId) || `nomid:${msg.receivedAt}`;
  if (await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_brand_reply WHERE deal_id = ?1 AND brand_message_id = ?2").bind(deal.id, mid).first()) return "SEEN";
  const words = theirNewText(textBodyOf(msg.text)) || msg.text.trim();
  const cls = classifyBrandReply({ subject: msg.subject, text: words, raw: msg.text }, now);
  const close = (intent: string, note: string) => env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, held_reason, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', 'CLOSED', ?8, ?9)",
  ).bind(`tbr_${crypto.randomUUID()}`, deal.id, mid, msg.subject.slice(0, 300), words.slice(0, 8000), msg.receivedAt, intent, note, deal.firm_scope).run();

  /*
   * A MAIL SERVER'S DELIVERY NOTICE IS NEVER A BRAND'S REPLY (6 Nov 2026 live read: Talkspace's Google
   * Group bounced on the thread, and Wynn drafted the proposal "Hi Mail," to mailer-daemon@googlemail.com
   * and asked both partners to approve it). It is closed with no draft; the door's bounce handling owns
   * the address. Stored as AUTO_REPLY (the table's machine-sent intent), without the drip resume.
   */
  if (classifyBrandMail({ from: msg.from ?? "", subject: msg.subject }) === "BOUNCED") {
    await close("AUTO_REPLY", "a mail server's delivery notice, not the brand: no answer drafted");
    return "SEEN";
  }
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
  /*
   * NO REPLY NEEDED (owner, 2 Nov 2026). The first decision, before any draft: a reply that passes the note on, loops
   * someone in, says they are reviewing or will get back, or asks nothing, gets no draft at all. The drip is already
   * stopped (above); the deal waits on them until they write again. Their answer to something WE asked (a time from
   * the slots we offered, a yes to the samples we offered) is never read as "nothing asked".
   */
  const pendingSlots = await env.WP_OS_DB.prepare(
    "SELECT offered_slots_json FROM tlc_brand_reply WHERE deal_id = ?1 AND state = 'SENT' AND offered_slots_json IS NOT NULL AND agreed_slot IS NULL ORDER BY sent_at DESC LIMIT 1",
  ).bind(deal.id).first<{ offered_slots_json: string }>();
  const picked = pendingSlots ? pickedSlot(words, JSON.parse(pendingSlots.offered_slots_json) as string[], now) : null;
  if (cls.kind === "NO_REPLY_NEEDED" && !picked && !((await offeredSamples(env, deal.id)) && isYesToSamples(words))) {
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET waiting_since = ?2, updated_at = ?2 WHERE id = ?1").bind(deal.id, now.toISOString()).run();
    await close("QUESTION", `no reply needed (${cls.why === "PASSED_ON" ? "they passed it on" : cls.why === "REVIEWING" ? "they are reviewing it" : "they asked for nothing"}): waiting on them, nothing drafted`);
    await appendEvent(env, { eventType: "tlc.brand_reply_waiting", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { why: cls.why } });
    return "WAITING";
  }
  await env.WP_OS_DB.prepare("UPDATE tlc_deal SET waiting_since = NULL WHERE id = ?1").bind(deal.id).run();
  // Reply-all: everyone on their latest message stays on our answer (a person they looped in included).
  const recipients = replyAllRecipients(msg.text, deal.contact_email, OUR_MAIL_DOMAINS);
  const subject = `Re: ${msg.subject.replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, "").trim() || `${brandDisplayName(deal.brand)} + a small room in New York`}`;
  const rules = await wynnRules(env, deal.firm_scope);
  let intent: BrandReplyIntent = cls.kind === "REPLY" ? cls.intent : "QUESTION";
  let body: string;
  let samplesId: string | null = null;
  let hold: { due: string; why: string } | null = null;
  let offered: string[] | null = null;
  let agreed: string | null = null;
  let kind: string | null = null;
  let tier: string | null = null;
  let attachments: StoredFile[] = [];
  let step: Awaited<ReturnType<typeof flowStep>> | null = null;

  /*
   * A YES TO THE THREE SAMPLES (owner, 26 Oct 2026). On a deal whose email from us offered them, "sure, send it" gets
   * the 3-page PDF Parker builds for the brand, and the cover email, in her approval email. A PDF that cannot be
   * built yet holds the reply (retried each pass) rather than go without it.
   */
  if (!picked && (requestsSamples(words) || ((await offeredSamples(env, deal.id)) && isYesToSamples(words)))) {
    intent = "YES";
    const built = await buildSamples(env, deal, ev, { theirText: words }, deps.samples ?? {});
    samplesId = built.ok ? built.row.id : built.id;
    if (!built.ok) hold = { due: new Date(now.getTime() + RESEARCH_RETRY_MINUTES * 60_000).toISOString(), why: `the samples PDF is not ready yet (${built.detail.slice(0, 200)}); tried again each pass` };
    const segment = built.ok ? (JSON.parse(built.row.input_json) as { segmentTitle: string }).segmentTitle : "";
    body = signedBrandEmail(samplesCoverEmail({ brand: brandDisplayName(deal.brand), contactName: deal.contact_name, topic: ev.topic ?? "", segmentTitle: segment }));
  } else if (picked || (intent === "CALL" && rules.some((r) => r.code === "SCHEDULE_THEIR_CALL"))) {
    /*
     * A CALL THEY ASKED FOR IS SCHEDULED (owner, 26 Oct 2026). The time they picked from the ones offered, or the time
     * they proposed when she is free, is agreed; otherwise two or three open times from her calendar are offered.
     */
    intent = "CALL";
    const { busy } = await (deps.busy ?? herBusy)(env, now, new Date(now.getTime() + 21 * 86_400_000)).catch(() => ({ busy: [], note: null }));
    const proposed = picked ? null : proposedTime(words, now);
    agreed = picked ?? (proposed && isFree(proposed, busy, now) ? proposed : null);
    if (!agreed) offered = freeSlots(busy, now, 3);
    const plan: CallPlan | null = agreed ? { agreed } : offered && offered.length ? { offer: offered } : null;
    body = await draftFor(env, deal, ev, intent, words, deps, null, plan);
  } else if ((step = await flowStep(env, deal.id)) && (step.proposalSent ? levelPicked(words) !== null : step.samplesSent || asksPrice(words))) {
    /*
     * STEPS 4 AND 5 OF HER FLOW (shared/tlc/brandFlow.ts). After the samples, their interest or questions get the
     * proposal: the partner options in words, the prices on the attached one-pager (the first time money appears).
     * After the proposal, the level they pick gets the confirmation, with a one-page agreement and the invoice
     * (West Peek's own payment link; the OS never takes or processes a payment). Both are drafts for her approval.
     * A BRAND THAT ASKS THE PRICE GOES STRAIGHT TO STEP 4 (owner, 4 Nov 2026), samples sent or not: the proposal and
     * the partner-levels sheet made for that brand (its own levels, every price per event). Still a draft for her.
     */
    const files: StoredFile[] = [];
    const brandName = brandDisplayName(deal.brand);
    const safe = (x: string) => x.replace(/[^\w &-]+/g, "").trim();
    const fail: string[] = [];
    const keep = (out: StoredFile | string) => (typeof out === "string" ? fail.push(out) : files.push(out));
    if (!step.proposalSent) {
      kind = "PROPOSAL";
      const sponsor = await sponsorFor(env, deal, words);
      keep(await sheetPdf(env, deal, ev, sponsor, deps));
      body = proposalBody(deal, ev, sponsor, step.segment, greetingFor({ name: deal.contact_name, email: deal.contact_email }, recipients, msg.text));
    } else {
      kind = "CONFIRM";
      tier = levelPicked(words);
      const { TLC_TIERS, sponsorshipAgreement, invoiceNote } = await import("../../shared/tlc/learningClub");
      const t = TLC_TIERS[tier as keyof typeof TLC_TIERS];
      const cash = t.priceUsd ?? 0;
      const due = new Date(now.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
      const picked = brandLevelsFor(await sponsorFor(env, deal, words), ev.topic ?? "").find((l) => l.key === tier);
      keep(await storePdf(env, `tlc-flow/${deal.id}/agreement-${crypto.randomUUID()}.pdf`, `The Learning Club - ${safe(brandName)} - agreement.pdf`,
        textPage("Partnership agreement", sponsorshipAgreement({ brand: brandName, topic: ev.topic ?? "", eventDate: `${ev.event_date} (tentative)`, cashUsd: cash, inKind: tier === "PRODUCT" ? "product for the night, as agreed" : null, deliverables: `${t.label}, per event: ${picked ? `${picked.head ? `${picked.head} ` : ""}${picked.adds.join("; ")}` : t.gets.replace(/<Brand>/g, brandName).replace(/<topic>/g, ev.topic ?? "")}`, dueDate: due })), deps.samples ?? {}));
      if (cash > 0) {
        keep(await storePdf(env, `tlc-flow/${deal.id}/invoice-${crypto.randomUUID()}.pdf`, `The Learning Club - ${safe(brandName)} - invoice.pdf`,
          textPage("Invoice", invoiceNote({ brand: brandName, topic: ev.topic ?? "", month: ev.month, cashUsd: cash, dueDate: due, paymentUrl: (ev as { sponsor_payment_url?: string | null }).sponsor_payment_url ?? null })), deps.samples ?? {}));
      }
      body = fillTemplate("confirm", { hi: greetingFor({ name: deal.contact_name, email: deal.contact_email }, recipients, msg.text), brand: brandName, level: t.label.replace(/ \(in kind\)$/, "") });
    }
    body = signedBrandEmail(body);
    attachments = files;
    if (fail.length) hold = { due: new Date(now.getTime() + RESEARCH_RETRY_MINUTES * 60_000).toISOString(), why: `${fail.join("; ").slice(0, 240)}; she is not asked until the attachments are ready` };
  } else {
    body = await draftFor(env, deal, ev, intent, words, deps);
  }
  await env.WP_OS_DB.prepare(
    `INSERT OR IGNORE INTO tlc_brand_reply (id, deal_id, brand_message_id, their_subject, their_text, received_at, intent, draft_subject, draft_body, state, firm_scope,
       samples_id, offered_slots_json, agreed_slot, research_due, held_reason, kind, tier, attachments_json, send_to, send_cc_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'DRAFTED', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
  ).bind(`tbr_${crypto.randomUUID()}`, deal.id, mid, msg.subject.slice(0, 300), words.slice(0, 8000), msg.receivedAt, intent, subject.slice(0, 300), body, deal.firm_scope,
    samplesId, offered && offered.length ? JSON.stringify(offered) : null, agreed, hold?.due ?? null, hold?.why ?? null,
    kind ?? (samplesId ? "SAMPLES" : agreed || offered ? "CALL" : "ANSWER"), tier, attachments.length ? JSON.stringify(attachments) : null,
    recipients.to, recipients.cc.length ? JSON.stringify(recipients.cc) : null).run();
  await appendEvent(env, { eventType: "tlc.brand_reply_drafted", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { intent, samples: samplesId !== null, offered: offered?.length ?? 0, agreed } });
  return "DRAFTED";
}

/** Step 4's email (unsigned): the proposal template, the brand's own levels, the greeting for whoever asked. */
function proposalBody(deal: TlcDealRow, ev: TlcEventRow, sponsor: Awaited<ReturnType<typeof sponsorFor>>, segment: string | null, hi: string): string {
  const brandName = brandDisplayName(deal.brand);
  // No "most brands like <Brand>" line (Scooter's note on the Pinecone draft wins, 7 Nov 2026). A brand with series
  // prices reads them per event for four and six evenings; any other the series of six at the same per-event price.
  const sp = sponsor.seriesPricing ?? null;
  const series = sp
    ? ["For more than one evening, each series costs less per event:", ...(sp.quarterly ? [`• ${sp.quarterly.name}, ${sp.quarterly.evenings.length} evenings in ${sp.year}: ${sp.quarterly.style} Lead ${seriesPriceWords(sp, "LEAD", 4).replace(/ \(.*\)$/, "")}, Presenting ${seriesPriceWords(sp, "PRESENTING", 4).replace(/ \(.*\)$/, "")}.`] : []),
      ...(sp.monthly ? [`• ${sp.monthly.name}: ${sp.monthly.style} Lead ${seriesPriceWords(sp, "LEAD", 6).replace(/ \(.*\)$/, "")}, Presenting ${seriesPriceWords(sp, "PRESENTING", 6).replace(/ \(.*\)$/, "")}.`] : [])].join("\n") + "\n\n"
    : "A series of six: the same per-event price for each club, as a founding partner. ";
  return fillTemplate("proposal", { hi, brand: brandName, topic: ev.topic ?? "", segment: segment ?? `Where ${brandName} comes in`, levels: proposalLevelLines(brandLevels(sponsor, ev.topic ?? "")), series, howMany: sp ? " and whether it's one evening, four or six" : "" });
}

/**
 * WHO WROTE THE MESSAGE SHE IS ANSWERING (6 Nov 2026: the Pinecone reply came from a colleague, while the email said
 * "From: Mike"). The address we answer is theirs; our contact by name only when it is them.
 */
function whoWrote(r: { send_to?: string | null; send_cc_json?: string | null; contact_name: string | null; contact_email: string }): string {
  const { to, cc } = answerRecipients(r);
  const contact = `${r.contact_name ? `${r.contact_name} ` : ""}<${r.contact_email}>`;
  if (to === r.contact_email.trim().toLowerCase()) return contact;
  const first = r.contact_name?.trim().split(/\s+/)[0] ?? r.contact_email;
  return `${to}, a colleague of ${first}${cc.includes(r.contact_email.trim().toLowerCase()) ? ` (${first} is on Cc)` : ""}`;
}
/** "Wed 4 Nov, 10:32 am CT": her clock, never UTC. */
function herClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }).format(d).toLowerCase();
  return `${day}, ${time} CT`;
}

/** The partner-levels sheet made for this brand, stamped with the sheet design it was made with. */
async function sheetPdf(env: Env, deal: TlcDealRow, ev: TlcEventRow, sponsor: Awaited<ReturnType<typeof sponsorFor>>, deps: BrandReplyDeps): Promise<StoredFile | string> {
  const { clubViewOf } = await import("./learningClub");
  const { renderBrandPitch, SHEET_VERSION } = await import("../../shared/tlc/pitch");
  const safe = (x: string) => x.replace(/[^\w &-]+/g, "").trim();
  const out = await storePdf(env, `tlc-flow/${deal.id}/proposal-${crypto.randomUUID()}.pdf`, `The Learning Club - ${safe(ev.topic ?? "")} - partner levels - ${safe(brandDisplayName(deal.brand))}.pdf`, renderBrandPitch(clubViewOf(ev), sponsor), deps.samples ?? {});
  return typeof out === "string" ? out : { ...out, sheet: SHEET_VERSION };
}
const isSheet = (f: StoredFile): boolean => / - partner levels - /.test(f.name);

/**
 * A PROPOSAL WAITING FOR APPROVAL CARRIES THE CURRENT SHEET (owner, 6 Nov 2026: the Pinecone sheet "needs better
 * branding"; the next draft to her carries the new one, with Scooter copied). A proposal still with the partners
 * (drafted or in an approval email) whose sheet was made on an older design is made again, and goes back to them as
 * a new approval email saying what changed; approvals given to the old email no longer count. A PDF that cannot be
 * made now leaves the draft as it was and is tried on the next pass, never sent without its sheet.
 */
export async function refreshStaleSheets(env: Env, now: Date, firmScope: string, deps: BrandReplyDeps = {}): Promise<string> {
  const { SHEET_VERSION, SHEET_CHANGE_WORDS } = await import("../../shared/tlc/pitch");
  const rows = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply WHERE firm_scope = ?1 AND kind = 'PROPOSAL' AND state IN ('DRAFTED','NOTIFIED') AND attachments_json IS NOT NULL")
    .bind(firmScope).all<ReplyRow>()).results ?? [];
  const done: string[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    const files = JSON.parse(r.attachments_json ?? "[]") as StoredFile[];
    if (!files.some((f) => isSheet(f) && f.sheet !== SHEET_VERSION)) continue;
    const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>();
    const ev = deal ? await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>() : null;
    if (!deal || !ev) continue;
    const made = await sheetPdf(env, deal, ev, await sponsorFor(env, deal, r.their_text), deps);
    if (typeof made === "string") { failed.push(`${brandDisplayName(deal.brand)}: ${made.slice(0, 120)}`); continue; }
    const next = files.map((f) => (isSheet(f) ? made : f));
    /*
     * The proposal's email is made again from the same template too, so a fix to it (the greeting, 6 Nov 2026)
     * reaches a draft still waiting. Never when a partner's change note shaped the draft: her words are kept.
     */
    const sponsor = await sponsorFor(env, deal, r.their_text);
    const step = await flowStep(env, deal.id);
    const body = r.change_note ? r.draft_body : signedBrandEmail(proposalBody(deal, ev, sponsor, step.segment, greetingFor({ name: deal.contact_name, email: deal.contact_email }, answerRecipients({ ...r, contact_email: deal.contact_email }))));
    const what = body === r.draft_body ? `${SHEET_CHANGE_WORDS} Wynn's email is unchanged.` : `${SHEET_CHANGE_WORDS} Wynn's email is made again from the same template; it now greets the person who asked.`;
    const upd = await env.WP_OS_DB.prepare(
      "UPDATE tlc_brand_reply SET attachments_json = ?2, draft_body = ?6, state = 'DRAFTED', notice_ref = NULL, approved_by_json = NULL, report_text = ?3 WHERE id = ?1 AND state = ?4 AND COALESCE(notice_ref, '') = ?5",
    ).bind(r.id, JSON.stringify(next), `WHAT CHANGED SINCE THE LAST EMAIL: ${what}`, r.state, r.notice_ref ?? "", body).run();
    if ((upd.meta?.changes ?? 0) === 0) continue;
    await appendEvent(env, { eventType: "tlc.brand_reply_sheet_refreshed", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope, payload: { reply: r.id, was: r.notice_ref, sheet: SHEET_VERSION, at: now.toISOString() } });
    done.push(brandDisplayName(deal.brand));
  }
  return [done.length ? `sheet made again for ${done.join(", ")}` : "", failed.length ? `sheet not made yet (tried next pass): ${failed.join("; ")}` : ""].filter(Boolean).join("; ");
}

/** A brand asking what it costs ("How much is this to do?", pricing, cost, rates, budget): straight to step 4. */
export const PRICE_ASK = /\bhow much\b|\bpricing\b|\bprices?\b|\bcosts?\b|\brates\b|\bbudget\b/i;
export const asksPrice = (words: string): boolean => PRICE_ASK.test(words);
/** A brand asking to own the whole room: the one case Title is offered without the large-brand flag (rule H). */
export const OWN_THE_ROOM = /\btitle (?:partner|sponsor)\b|\bown(?:ing)? the (?:whole )?room\b|\bthe whole room\b|\bonly sponsor\b|\bexclusive sponsor\b/i;

/** The sponsor view of a deal: its own row, Wynn's rules, and whether this message asks to own the room. */
export async function sponsorFor(env: Env, deal: TlcDealRow, theirWords = ""): Promise<TlcSponsorView> {
  const base = sponsorOf(deal, await wynnRules(env, deal.firm_scope));
  return OWN_THE_ROOM.test(theirWords) ? { ...base, askedToOwnRoom: true } : base;
}
const brandLevelsFor = (s: TlcSponsorView, topic: string) => brandLevels(s, topic);

/** Where a deal is in her flow: the samples sent (step 3 done), the proposal sent (step 4 done), the segment name. */
export async function flowStep(env: Env, dealId: string): Promise<{ samplesSent: boolean; proposalSent: boolean; segment: string | null }> {
  const s = await env.WP_OS_DB.prepare("SELECT input_json FROM tlc_samples WHERE deal_id = ?1 AND state = 'SENT'").bind(dealId).first<{ input_json: string }>();
  const p = await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_brand_reply WHERE deal_id = ?1 AND kind = 'PROPOSAL' AND state = 'SENT'").bind(dealId).first();
  let segment: string | null = null;
  try { segment = s ? (JSON.parse(s.input_json) as { segmentTitle?: string }).segmentTitle ?? null : null; } catch { segment = null; }
  return { samplesSent: s !== null, proposalSent: p !== null, segment };
}

/** Did an email we sent this deal offer the three samples (the drip's email 2, or an answer of hers)? */
export async function offeredSamples(env: Env, dealId: string): Promise<boolean> {
  const offer = "%run of show%";
  const six = "%series of six%";
  const hit = await env.WP_OS_DB.prepare(
    `SELECT 1 FROM tlc_drip_message WHERE deal_id = ?1 AND state = 'SENT' AND body LIKE ?2 AND body LIKE ?3
     UNION SELECT 1 FROM tlc_brand_reply WHERE deal_id = ?1 AND state = 'SENT' AND draft_body LIKE ?2 AND draft_body LIKE ?3 LIMIT 1`,
  ).bind(dealId, offer, six).first();
  return hit !== null;
}

/**
 * FREE-MAIL DOMAINS NEVER MAKE SOMEONE PART OF A BRAND (owner, 4 Nov 2026): a sender at one of these belongs to a deal
 * only as its own contact address or on a thread we sent. The one list.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "proton.me"]);
export const emailDomain = (email: string): string => email.trim().toLowerCase().split("@")[1] ?? "";

/** The Message-IDs a raw message answers: its In-Reply-To and References headers (folded lines unfolded). */
export function referencedIds(raw: string | undefined): string[] {
  const head = (raw ?? "").split(/\r?\n\r?\n/)[0] ?? "";
  return [...head.replace(/\r?\n[ \t]+/g, " ").matchAll(/^(?:In-Reply-To|References):(.+)$/gim)]
    .flatMap((m) => [...m[1]!.matchAll(/<([^>]+)>/g)].map((x) => normalizeMid(x[1])));
}

/**
 * THE DEALS A MESSAGE BELONGS TO (owner, 4 Nov 2026; the Pinecone VP's "How much is this to do?" was never read). A
 * live deal owns a message when it is from the deal's contact address; or it is on a thread we sent that deal (the
 * Gmail thread, or In-Reply-To / References naming a Message-ID we sent), whoever sent it; or, once we have written
 * to the deal, its sender is at the contact's own domain, never a free-mail one. Intake and inbox both ask this.
 */
export async function dealsForSender(env: Env, from: string, message: { text?: string; threadId?: string } = {}): Promise<TlcDealRow[]> {
  const address = (addressIn(from) ?? from).trim().toLowerCase();
  if ([TLC_OWNER.email.toLowerCase(), INTAKE_MAILBOX.toLowerCase()].includes(address)) return [];
  const domain = emailDomain(address);
  const refs = referencedIds(message.text);
  return (await env.WP_OS_DB.prepare(
    `SELECT d.* FROM tlc_deal d WHERE d.stage NOT IN ('DECLINED','STOPPED')
      AND (d.stop_reason IS NULL OR d.stop_reason = 'REPLIED')
      AND (lower(d.contact_email) = ?1
        OR (?2 != '' AND d.first_sent_at IS NOT NULL AND lower(substr(d.contact_email, instr(d.contact_email, '@') + 1)) = ?2)
        OR EXISTS (SELECT 1 FROM external_effect_request e
          WHERE e.id IN (SELECT effect_request_id FROM tlc_drip_message WHERE deal_id = d.id AND state = 'SENT'
            UNION SELECT effect_request_id FROM tlc_brand_reply WHERE deal_id = d.id AND state = 'SENT'
            UNION SELECT effect_request_id FROM tlc_pitch_followup WHERE deal_id = d.id AND state = 'SENT')
          AND (e.gmail_thread_id = ?3 OR trim(e.rfc_message_id, '<>') IN (SELECT value FROM json_each(?4)))))`,
  ).bind(address, FREE_MAIL_DOMAINS.has(domain) ? "" : domain, message.threadId ?? null, JSON.stringify(refs)).all<TlcDealRow>()).results ?? [];
}

/** How many inbox messages one pass reads per search (25 a page): bounded, so a busy inbox never runs the pass out. */
export const INBOX_PAGES = { brands: 4, threads: 2 } as const;
/** Mail on our threads from people outside the brand's domain is looked for in this recent window, each pass. */
export const THREAD_WINDOW_DAYS = 3;

const defaultMailbox: MailboxReader = async (env, query, maxPages = 1) => {
  const token = await serviceAccountToken(env, [GMAIL_READ_SCOPE], TLC_OWNER.email);
  return (await listGmailRaw(token, query, 25, fetch, maxPages)).map(({ raw, internalDate, threadId }) => {
    const head = raw.split(/\r?\n\r?\n/)[0] ?? "";
    const h = (name: string) => new RegExp(`^${name}:\\s*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(head)?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim() ?? "";
    return { threadId: threadId ?? undefined, messageId: h("Message-ID"), from: h("From"), subject: h("Subject"), text: raw, receivedAt: new Date(Number(internalDate ?? Date.now())).toISOString() };
  });
};

/**
 * Each drip pass: (a) a reply the door stopped on but never read (no words, or before this existed) is read from
 * the stored message; (b) her inbox is read for replies on sent threads or from brand domains. Returns a line for the job summary.
 */
export async function processBrandReplies(env: Env, now: Date, firmScope = "west-peek", deps: BrandReplyDeps = {}): Promise<string> {
  const d = { ...deps, now };
  const counts: Record<TakeOutcome, number> = { SEEN: 0, AUTO_REPLY: 0, NO: 0, WAITING: 0, DRAFTED: 0 };
  const unread = (await env.WP_OS_DB.prepare(
    `SELECT d.* FROM tlc_deal d WHERE d.firm_scope = ?1 AND d.stop_reason = 'REPLIED'
       AND NOT EXISTS (SELECT 1 FROM tlc_brand_reply r WHERE r.deal_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM tlc_pitch_followup f WHERE f.deal_id = d.id AND f.state = 'SENT')`,
  ).bind(firmScope).all<TlcDealRow>()).results ?? [];
  for (const deal of unread) {
    const since = new Date(Date.parse(deal.replied_at ?? now.toISOString()) - 10 * 60_000).toISOString();
    // Bounded: the first 50 messages the door kept after their reply; each is matched the same way as the inbox.
    const rows = (await env.WP_OS_DB.prepare("SELECT message_id, from_address, r2_key, subject, received_at FROM inbound_message WHERE received_at >= ?1 ORDER BY received_at LIMIT 50")
      .bind(since).all<{ message_id: string | null; from_address: string; r2_key: string | null; subject: string; received_at: string }>()).results ?? [];
    for (const row of rows) {
      const obj = row.r2_key && env.WP_OS_DOCUMENTS ? await env.WP_OS_DOCUMENTS.get(row.r2_key) : null;
      if (!obj) continue;
      const text = await obj.text();
      if (!(await dealsForSender(env, row.from_address, { text })).some((x) => x.id === deal.id)) continue;
      counts[await takeBrandReply(env, deal, { messageId: row.message_id ?? "", subject: row.subject, text, receivedAt: row.received_at, from: row.from_address }, d)] += 1;
    }
  }
  let polled = "inbox not read";
  let inboxRead = false;
  if (deps.mailbox !== null && (deps.mailbox || env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON)) {
    const live = (await env.WP_OS_DB.prepare(
      "SELECT * FROM tlc_deal WHERE firm_scope = ?1 AND first_sent_at IS NOT NULL AND stage NOT IN ('DECLINED','STOPPED') AND (stop_reason IS NULL OR stop_reason = 'REPLIED')",
    ).bind(firmScope).all<TlcDealRow>()).results ?? [];
    const addresses = [...new Set(live.map((x) => x.contact_email.toLowerCase()))];
    // Anyone at a live brand's own domain, plus each contact's own address (a free-mail contact stays an address).
    const domains = [...new Set(live.map((x) => emailDomain(x.contact_email)).filter((x) => x && !FREE_MAIL_DOMAINS.has(x)))];
    if (addresses.length) {
      const after = Math.floor(Math.min(...live.map((x) => Date.parse(x.first_sent_at!))) / 1000);
      const ours = [...new Set([TLC_OWNER.email, INTAKE_MAILBOX].map((a) => emailDomain(a)))];
      const recent = Math.max(after, Math.floor((now.getTime() - THREAD_WINDOW_DAYS * 86_400_000) / 1000));
      try {
        const reader = deps.mailbox ?? defaultMailbox;
        // Two bounded searches: the brands' own people since our first email, and, in a recent window, anyone else
        // (an agency, a free-mail colleague) who answered on a thread we sent. dealsForSender decides each one.
        const byBrand = await reader(env, `from:(${[...addresses, ...domains].join(" OR ")}) after:${after}`, INBOX_PAGES.brands);
        const onThread = await reader(env, `in:inbox after:${recent} -from:(${ours.join(" OR ")})`, INBOX_PAGES.threads);
        const seen = new Set<string>();
        const found = [...byBrand, ...onThread].filter((m) => { const k = normalizeMid(m.messageId) || `${m.from}|${m.receivedAt}`; if (seen.has(k)) return false; seen.add(k); return true; });
        for (const m of found) {
          const from = (addressIn(m.from) ?? m.from).toLowerCase();
          const matches = new Set((await dealsForSender(env, from, m)).map((x) => x.id));
          for (const deal of live.filter((x) => matches.has(x.id) && Date.parse(m.receivedAt) > Date.parse(x.first_sent_at!))) {
            counts[await takeBrandReply(env, deal, m, d)] += 1;
          }
        }
        polled = `inbox read (${found.length} message(s), ${addresses.length} live contact(s), ${domains.length} brand domain(s))`;
        inboxRead = true;
      } catch (err) {
        polled = `inbox not read: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
      }
    }
  }
  // Research she asked for that could not run yet: tried again once due.
  const due = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply WHERE firm_scope = ?1 AND state = 'DRAFTED' AND research_due IS NOT NULL AND research_due <= ?2")
    .bind(firmScope, now.toISOString()).all<ReplyRow>()).results ?? [];
  for (const r of due) {
    if (r.samples_id && !r.change_note) await retrySamples(env, r, now, d);
    else await redraftFor(env, r, r.change_note ?? "", now, d);
  }
  const retried = await retryApprovedSends(env, now, firmScope, d);
  const refreshed = await refreshStaleSheets(env, now, firmScope, d);
  const notice = await sendReplyApprovals(env, now, firmScope);
  // After the inbox was read, so a reply that arrived cancels the follow-up before it could go.
  const resends = await resendUnanswered(env, now, firmScope, inboxRead, d).catch((err) => `pricing follow-ups: NAMED STOP [RESEND_FAILED] ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  return `brand replies: ${refreshed ? `${refreshed}; ` : ""}${counts.DRAFTED} drafted, ${counts.WAITING ? `${counts.WAITING} need no reply (waiting on them), ` : ""}${counts.AUTO_REPLY} auto-reply (drip resumed), ${counts.NO} declined; ${polled};${retried.length ? ` approved and sent on their own: ${retried.length};` : ""} ${notice}; ${resends}`;
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
async function emailHer(env: Env, firmScope: string, objectId: string, email: Omit<ExecEmailInput, "employee">, attachments: readonly EmailAttachment[] = [], cc: readonly string[] = [], pricing = false): Promise<boolean> {
  const { emailOwner } = await import("./learningClub");
  // Scooter's copy survives the door only on a pricing email (services/execEmail.ts tlcCcKept, owner 7 Nov 2026).
  const sent = await emailOwner(env, { employee: "Wynn", email, objectType: pricing ? TLC_PRICING_NOTICE_OBJECT : TLC_BRAND_REPLY_NOTICE_OBJECT, objectId, cardId: null, cardKind: null, firmScope, ...(attachments.length ? { attachments } : {}), ...(cc.length ? { cc } : {}) });
  if (sent.length === 0) throw new Error("the owner email was not sent");
  return true;
}

/**
 * WHO IS COPIED ON HER APPROVAL EMAIL, AND MUST APPROVE TOO (owner, 6 Nov 2026: Scooter is cc'd, and nothing is
 * approved until Sequoia and Scooter have each replied "approved"). Read from each named partner's own firm_user row
 * (active, and a partner by the registry), so no address is typed in this public repository.
 */
export async function approvalCopies(env: Env): Promise<{ cc: string[]; missing: string[] }> {
  const cc: string[] = [];
  const missing: string[] = [];
  for (const id of TLC_BRAND_REPLY_NOTICE_CC_IDS) {
    const row = await env.WP_OS_DB.prepare("SELECT email, full_name FROM firm_user WHERE id = ?1 AND status = 'ACTIVE'").bind(id).first<{ email: string | null; full_name: string | null }>();
    const email = (row?.email ?? "").trim().toLowerCase();
    if (email && partnerByEmail(email)?.firmUserId === id) cc.push(email);
    else missing.push(id);
  }
  return { cc, missing };
}
const copiedNames = (cc: readonly string[]): string => cc.map((a) => partnerByEmail(a)?.firstName ?? a).join(" and ");
const firstNameOf = (id: string): string => partnerByFirmUserId(id)?.firstName ?? id;
const namesOf = (ids: readonly string[]): string => ids.map(firstNameOf).join(" and ");
/** "Sequoia approved · waiting on Scooter": who has said yes and who is still needed, in plain words. */
export function approvalWords(needed: readonly string[], approved: readonly string[]): string {
  const have = needed.filter((id) => approved.includes(id));
  const want = needed.filter((id) => !approved.includes(id));
  return [have.length ? `${namesOf(have)} approved` : "nobody has approved yet", ...(want.length ? [`waiting on ${namesOf(want)}`] : [])].join(" · ");
}
const idList = (json: string | null | undefined): string[] => { try { const v = JSON.parse(json ?? "null"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

export async function approverAddress(env: Env): Promise<string> {
  return ((await setting(env, APPROVER_SETTING)) ?? TLC_OWNER.email).trim().toLowerCase();
}

/** A draft that carries prices: the proposal (step 4) or the confirmation (step 5). These get round 2. */
/**
 * A draft that carries prices: the proposal (step 4), the confirmation (step 5), or ANY draft whose words name a dollar
 * amount (7 Nov 2026: an answer Wynn drafted with the levels in it was a pricing email too, and must not go to the brand
 * on her approval alone). These get round 2.
 */
export const carriesPricing = (r: { kind?: string | null; draft_body?: string | null }): boolean =>
  r.kind === "PROPOSAL" || r.kind === "CONFIRM" || /\$\s?\d/.test(r.draft_body ?? "");
/** Round 2: a pricing draft she approved, now with her and Scooter (a notice that named both partners counts too). */
export const inPartnerRound = (r: { round?: string | null }): boolean => r.round === "PARTNERS";

/** The old link in emails already sent: it now redirects to the brand's readable reply page. */
export const draftPageUrl = (token: string): string => `https://os.joinwestpeek.com/api/tlc-pitch/draft/${token}`;
async function draftPageLink(env: Env, replyId: string): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET page_token = ?2 WHERE id = ?1 AND page_token IS NULL").bind(replyId, token).run();
  const row = await env.WP_OS_DB.prepare("SELECT page_token FROM tlc_brand_reply WHERE id = ?1").bind(replyId).first<{ page_token: string }>();
  return draftPageUrl(row!.page_token);
}

/** Round 2's answers so far: {firm_user_id: {approved, note, at}}. */
export type PartnerInputs = Record<string, { approved: boolean; note: string | null; at: string }>;
export const inputsOf = (json: string | null | undefined): PartnerInputs => { try { const v = JSON.parse(json ?? "null"); return v && typeof v === "object" && !Array.isArray(v) ? v as PartnerInputs : {}; } catch { return {}; } };

/** Their words, short enough for a first line: the first sentence or 140 characters. */
export function theirGist(text: string): string {
  const flat = wordsOf(text).replace(/\s+/g, " ").trim();
  const first = flat.match(/^.{1,140}?[.?!](?=\s|$)/)?.[0] ?? (flat.length > 140 ? `${flat.slice(0, 137).trimEnd()}…` : flat);
  return first;
}

/**
 * WHAT CHANGED BETWEEN TWO DRAFTS, LINE BY LINE (owner, 6 Nov 2026: the Pinecone redraft "didnt change much"). Shown
 * at the top of every redraft, so a redraft that ignored a note is visible at a glance. Pure.
 */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = wordsOf(before).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const b = wordsOf(after).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return { removed: a.filter((l) => !b.includes(l)), added: b.filter((l) => !a.includes(l)) };
}

/**
 * Sends the approval email for every drafted reply, AT ONCE (owner, 26 Oct 2026: "Why 4pm?"). TWO ROUNDS (owner,
 * 6 Nov 2026): round 1 goes to her ALONE, every draft; a draft with prices that she approves comes back as round 2,
 * to her and Scooter, as a link to its live draft page (never a PDF going back and forth), and nothing reaches the
 * brand until both have replied approved. Send-once: a row moves DRAFTED → NOTIFIED with the email. A reply still
 * waiting for the research she asked for (research_due) is not sent until the research ran.
 */
export async function sendReplyApprovals(env: Env, now: Date, firmScope = "west-peek"): Promise<string> {
  const waiting = (await env.WP_OS_DB.prepare(
    `SELECT r.*, d.brand, d.contact_name, d.contact_email, d.people_json, e.month, e.topic FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id JOIN tlc_event e ON e.id = d.event_id
      WHERE r.firm_scope = ?1 AND r.state = 'DRAFTED' AND r.research_due IS NULL ORDER BY r.received_at`,
  ).bind(firmScope).all<WaitingRow>()).results ?? [];
  const researching = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_brand_reply WHERE firm_scope = ?1 AND state = 'DRAFTED' AND research_due IS NOT NULL").bind(firmScope).first<{ n: number }>())?.n ?? 0;
  if (waiting.length === 0) return researching ? `${researching} brand repl${researching === 1 ? "y" : "ies"} waiting for Wynn's research` : "no brand reply waiting for her";
  const out: string[] = [];
  const hers = waiting.filter((r) => !inPartnerRound(r));
  const partners = waiting.filter((r) => inPartnerRound(r));
  if (hers.length) out.push(await sendRound(env, now, firmScope, hers, false));
  if (partners.length) out.push(await sendRound(env, now, firmScope, partners, true));
  return out.join("; ");
}

type WaitingRow = ReplyRow & { brand: string; contact_name: string | null; contact_email: string; month: string; topic: string | null; round?: string | null; inputs_json?: string | null; page_token?: string | null; series_json?: string | null; people_json?: string | null; offer_json?: string | null; event_id?: string };

/** "Aaron Kao (VP Marketing)": a person on the thread, by the deal's own names, else the contact's, else the address. */
function personWords(address: string, r: { contact_email: string; contact_name: string | null; people_json?: string | null }): { name: string; role: string | null; full: string } {
  const a = address.trim().toLowerCase();
  const known = peopleOf(r.people_json)[a] ?? (a === r.contact_email.trim().toLowerCase() ? splitContactName(r.contact_name) : null);
  return known ? { name: known.name, role: known.role, full: `${known.name} <${a}>` } : { name: a, role: null, full: a };
}

/** Each partner's answer on the current round, in words: "Sequoia: not answered yet · Scooter: approved". */
export function answeredWords(needed: readonly string[], inputs: PartnerInputs): string {
  return needed.map((id) => `${firstNameOf(id)}: ${inputs[id] ? (inputs[id]!.approved ? "approved" : "sent notes") : "not answered yet"}`).join(" · ");
}

/**
 * ONE EMAIL PER DRAFT, IN THE SHAPE SHE APPROVED (owner, 7 Nov 2026, the Pinecone Pricing Reply v2: "all emails from wynn
 * should be like this"; shared/tlc/wynnDraftEmail.ts). Round 1 goes to her alone; round 2 (a pricing draft she
 * approved) to her and Scooter, and is the only Wynn email he is copied on. A redraft whose change lines leave a
 * partner's note unanswered is held and named, never sent looking finished.
 */
async function sendRound(env: Env, now: Date, firmScope: string, rows: WaitingRow[], partnerRound: boolean): Promise<string> {
  const ct = chicago(now);
  const out: string[] = [];
  const copies = partnerRound ? await approvalCopies(env) : { cc: [] as string[], missing: [] as string[] };
  const needed = [TLC_OWNER.firmUserId, ...copies.cc.map((a) => partnerByEmail(a)!.firmUserId)];
  for (const r of rows) {
    const brand = brandDisplayName(r.brand);
    const pricing = carriesPricing(r);
    const version = r.version ?? 1;
    const changes = (() => { try { return changeLinesOf(JSON.parse(r.changes_json ?? "null")); } catch { return []; } })();
    const notes = notesByName(r.change_note);
    const lastShown = await env.WP_OS_DB.prepare("SELECT version, round FROM tlc_brand_reply_version WHERE reply_id = ?1 ORDER BY sent_at DESC LIMIT 1").bind(r.id).first<{ version: number; round: string | null }>();
    const unchanged = lastShown !== null && lastShown.version === version;
    // A redraft must show what it did with every note (her rule, 7 Nov 2026). Held, and named on every pass.
    // (A note on the samples changes the samples PAGE, whose own history says what changed; the email links it.)
    const missing = !unchanged && version > 1 && !r.samples_id ? unansweredNotes(notes, changes) : [];
    if (missing.length) { out.push(`NAMED STOP [${NOTE_UNANSWERED}] ${brand} v${version}: no change line for ${missing.join(" and ")}'s note; not sent to the partners`); continue; }

    const extras: Array<{ label: string; text: string; url?: string | null; top?: boolean }> = [];
    const attachments: EmailAttachment[] = [];
    if (r.samples_id) {
      const sample = await samplesForDeal(env, r.deal_id);
      const url = sample?.state === "READY" ? await samplesPreviewLink(env, sample.id) : null;
      if (!sample || !url) { out.push(`${brand}: the samples page is not ready; the next pass tries again`); continue; }
      const history = await samplesRevisions(env, sample.id);
      extras.push({ label: "The 3 sample pages", text: `${history.length > 1 ? `Last change: ${history[0]!.line} ` : ""}To change them, reply with what to change. The PDF is made from that page when you reply approved, and goes with your answer.`, url });
    }
    if (!partnerRound && r.kind !== "PROPOSAL") {
      for (const f of JSON.parse(r.attachments_json ?? "[]") as StoredFile[]) { const a = await storedAttachment(env, f); if (a) attachments.push(a); }
      if (attachments.length) extras.push({ label: "Goes with it", text: attachments.map((a) => a.filename).join(" and ") });
    }
    if (r.report_text && !r.report_text.startsWith(STALE_SHEET_PREFIX)) extras.push({ label: "Wynn's research", text: r.report_text, top: true });
    if (r.samples_id && r.held_reason) extras.push({ label: "Note", text: r.held_reason });
    if (r.agreed_slot) extras.push({ label: "The call", text: `When it goes, ${slotWords(r.agreed_slot)} goes on your calendar and ${r.contact_email} is invited.` });

    const { to: answerTo, cc } = answerRecipients(r);
    const asker = personWords(answerTo, r);
    const copied = cc.map((a) => personWords(a, r).name);
    const about = [asker.role, copied.length ? `${copied.join(" and ")} copied` : ""].filter(Boolean).join("; ");
    const doc = docNameFor(r.kind, pricing);
    const what = `Our ${doc.toLowerCase()} to ${asker.name} at ${brand}${about ? ` (${about})` : ""}.`;
    const lead = partnerRound
      ? `${what} You both need to reply "approved": nothing goes to ${brand} until both of you do. Or reply with your notes.`
      : pricing
        ? `${what} Reply "approved" and it goes to you and Scooter for both of you to approve; nothing goes to ${brand} yet. Or reply with your notes.`
        : `${what} Reply "approved" to send it from your mailbox, on their thread, or reply with your notes.`;

    let sheet = null as ReturnType<typeof sheetMini> | null;
    if (r.kind === "PROPOSAL") {
      const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>();
      if (deal) {
        const sponsor = await sponsorFor(env, deal, r.their_text);
        sheet = sheetMini({ brand, topic: r.topic ?? "", year: r.month.slice(0, 4), roomWords: BRAND_EMAIL_ROOM_WORDS, levels: brandLevels(sponsor, r.topic ?? ""), series: sponsor.seriesPricing ?? null });
      }
    }
    /*
     * ONE REF FOR THE CONVERSATION'S WHOLE LIFE (owner, 7 Nov 2026: "both codes need to work for this job going forward
     * but a permanent fix so it doesnt happen again is required"). Every version, redraft and step-2 email of this reply
     * reuses its thread's ref; a ref is minted only for a reply that never had an email. Older codes stay valid as
     * aliases (currentRef). Legacy rows: the earliest email that carried this reply.
     */
    const legacy = r.thread_ref ? null : await env.WP_OS_DB.prepare("SELECT ref FROM tlc_brand_reply_notice WHERE reply_ids_json LIKE ?1 ORDER BY sent_at LIMIT 1").bind(`%"${r.id}"%`).first<{ ref: string }>();
    const threadRef = r.thread_ref ?? legacy?.ref ?? mintRef();
    const ref = threadRef;
    const unchangedNote = unchanged
      ? partnerRound && lastShown!.round !== "PARTNERS"
        ? `${firstNameOf(TLC_OWNER.firmUserId)} approved v${version} as it is; nothing in the words changed since. ${namesOf(needed.slice(1)) || "Scooter"}, this is your first look.`
        : r.report_text?.startsWith(STALE_SHEET_PREFIX) ? r.report_text.slice(STALE_SHEET_PREFIX.length).trim() : "Nothing in the words changed since you last saw it."
      : null;
    const laidOut = renderWynnDraftEmail({
      brand, docName: doc, version, lead,
      quote: partnerRound ? null : { label: `What ${asker.name} wrote (${herClock(r.received_at)})`, text: wordsOf(r.their_text) },
      changes: unchanged || version === 1 ? null : changes,
      unchangedNote,
      reply: { to: asker.full, cc: cc.map((a) => personWords(a, r).full), subject: r.draft_subject, body: withBrandFooter(r.draft_body) },
      sheet, attachmentsWord: sheet ? "attached as a PDF when it goes" : null,
      extras, link: { label: `See the whole ${brand} story`, url: replyPageUrl(r.brand) }, ref, threadRef,
      replyHint: 'Reply to this email with "approved" or your notes.',
      bothMustApprove: partnerRound && needed.length > 1,
    });
    const problems = draftEmailProblems(laidOut, ref, threadRef);
    if (problems.length) { out.push(`NAMED STOP [WYNN_EMAIL_REFUSED] ${brand} v${version}: ${problems.join("; ")}`); continue; }
    try {
      await emailHer(env, firmScope, ref, { what: laidOut.subject, tldr: lead, sections: [], laidOut }, attachments, copies.cc, partnerRound);
    } catch (err) {
      out.push(`${brand}: the approval email could not be sent (${err instanceof Error ? err.message : String(err)}); the next pass tries again`);
      continue;
    }
    // The same ref's email again: its row now names who must answer THIS email (round 2 adds Scooter).
    await env.WP_OS_DB.prepare(
      `INSERT INTO tlc_brand_reply_notice (ref, reply_ids_json, day, firm_scope, sent_at, sent_to, forced, gmail_id, approvers_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(ref) DO UPDATE SET reply_ids_json = excluded.reply_ids_json, day = excluded.day, sent_at = excluded.sent_at, sent_to = excluded.sent_to, approvers_json = excluded.approvers_json`,
    ).bind(ref, JSON.stringify([r.id]), ct.day, firmScope, now.toISOString(), TLC_OWNER.email, 0, null, JSON.stringify(needed)).run();
    // One history row per email: the ref is the conversation's, so the row is keyed by ref, version and round.
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_brand_reply_version (reply_id, notice_ref, version, round, draft_body, changes_json, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(r.id, `${ref}/v${version}/${partnerRound ? "PARTNERS" : "HER"}/${now.toISOString()}`, version, partnerRound ? "PARTNERS" : "HER", r.draft_body, r.changes_json ?? null, now.toISOString()).run();
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'NOTIFIED', notice_ref = ?2, approved_by_json = NULL, inputs_json = NULL, thread_ref = COALESCE(thread_ref, ?3) WHERE id = ?1 AND state = 'DRAFTED'").bind(r.id, ref, threadRef).run();
    await appendEvent(env, { eventType: "tlc.brand_reply_notice", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { replies: 1, round: partnerRound ? 2 : 1, version } });
    out.push(`${partnerRound ? "round-2" : "round-1"} approval email ${ref} (${brand} v${version}) sent${copies.cc.length ? `, ${copiedNames(copies.cc)} on it` : ""}${copies.missing.length ? `; NOT on it (no active partner record): ${copies.missing.join(", ")}` : ""}`);
  }
  return out.join("; ");
}

// ── Her answer ─────────────────────────────────────────────────────────────────────────────────

export interface ApprovalOutcome { handled: boolean; ref: string | null; detail: string }

/**
 * WHICH EMAIL A REPLY ANSWERS, BY EITHER CODE (owner, 7 Nov 2026: the thread's ref "is still important"). A ref that is
 * a reply's current email wins; a ref that is a reply's THREAD ref (its first email's, carried in every later subject)
 * reaches that reply's current email. Otherwise the first ref found, as before (an old email's ref stays a no-op).
 */
export async function currentRef(env: Env, found: readonly string[]): Promise<string | null> {
  const refs = [...new Set(found)];
  for (const ref of refs) {
    if (await env.WP_OS_DB.prepare("SELECT 1 FROM tlc_brand_reply WHERE notice_ref = ?1").bind(ref).first()) return ref;
  }
  for (const ref of refs) {
    const row = await env.WP_OS_DB.prepare("SELECT notice_ref FROM tlc_brand_reply WHERE thread_ref = ?1 AND notice_ref IS NOT NULL ORDER BY received_at DESC LIMIT 1").bind(ref).first<{ notice_ref: string }>();
    if (row) return row.notice_ref;
  }
  // AN OLDER CODE OF THE SAME CONVERSATION IS AN ALIAS: an email that carried exactly one reply routes to that reply's
  // current email (a batch email that carried several stays as it was: its "approve 2" means that batch).
  for (const ref of refs) {
    const old = await env.WP_OS_DB.prepare("SELECT reply_ids_json FROM tlc_brand_reply_notice WHERE ref = ?1").bind(ref).first<{ reply_ids_json: string }>();
    const ids = old ? idList(old.reply_ids_json) : [];
    if (ids.length !== 1) continue;
    const row = await env.WP_OS_DB.prepare("SELECT notice_ref FROM tlc_brand_reply WHERE id = ?1 AND notice_ref IS NOT NULL").bind(ids[0]).first<{ notice_ref: string }>();
    if (row) return row.notice_ref;
  }
  return refs[0] ?? null;
}

export async function applyBrandReplyApproval(
  env: Env,
  message: { fromHeader: string | null; authenticationResults: string | null; subject: string; body: string },
  deps: BrandReplyDeps = {},
): Promise<ApprovalOutcome> {
  const body = textBodyOf(message.body);
  const ref = await currentRef(env, [...`${body}\n${message.subject}`.matchAll(new RegExp(BRAND_REPLY_REF_RE.source, "g"))].map((m) => m[0]));
  if (!ref) return { handled: false, ref: null, detail: "no brand-reply reference" };
  const notice = await env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply_notice WHERE ref = ?1").bind(ref).first<{ ref: string; reply_ids_json: string; firm_scope: string; sent_to: string | null; approvers_json: string | null }>();
  if (!notice) return { handled: false, ref, detail: "unknown brand-reply reference" };
  const firmScope = notice.firm_scope;
  const from = (addressIn(message.fromHeader) ?? "").toLowerCase();
  /*
   * WHO MAY ANSWER THIS EMAIL (owner, 6 Nov 2026). Her addresses, as always; and each partner the email was sent to
   * for approval (approvers_json, fixed when it went: Scooter), read from his own firm_user row now. Anyone else, or
   * a sender whose authentication did not pass, changes nothing.
   */
  const needed = idList(notice.approvers_json).length ? idList(notice.approvers_json) : [TLC_OWNER.firmUserId];
  const herAddresses = new Set([await approverAddress(env), TLC_OWNER.email.toLowerCase(), (notice.sent_to ?? "").toLowerCase()].filter(Boolean));
  const copied = (await approvalCopies(env)).cc.filter((a) => needed.includes(partnerByEmail(a)!.firmUserId));
  const approverId = herAddresses.has(from) ? TLC_OWNER.firmUserId : copied.includes(from) ? partnerByEmail(from)!.firmUserId : null;
  const verdict = authenticationVerdict(message.authenticationResults, from || null);
  if (!approverId || !verdict.passed) {
    await appendEvent(env, { eventType: "tlc.brand_reply_refused", actorType: "system", actorId: "inbound_email", objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { from, why: approverId ? verdict.reason : "not an approver of this email" } });
    return { handled: false, ref, detail: `a reply to ${ref} was not accepted as an approver's` };
  }
  const who = firstNameOf(approverId);
  const now = deps.now ?? new Date();
  const ids = JSON.parse(notice.reply_ids_json) as string[];
  // Her words alone: the quoted email and any "Ref TLR-…" line are not part of her instruction.
  // Her WHOLE note: her signature off, never a character cut (herNoteOf; NOTE_MAX is stated if ever reached).
  const said = herNoteOf(newTextOf(body).split(/\r?\n/).filter((l) => !/^\s*Ref\s+TLR-[A-Z0-9]{6}\s*$/.test(l)).join("\n"), partnerByFirmUserId(approverId)?.fullName ?? TLC_OWNER.name);
  const parsed = parseDraftReply(said);
  // One reply in the email: free text that is not an approve/skip is her change to it.
  // A bare "skip" on a one-draft email (the reminder offers it, 9 Nov 2026) skips that draft; it is never a change note.
  if (isEmptyReply(parsed) && ids.length === 1 && /^\s*(?:skip|skip it|don't send|do not send)[.!]?\s*$/i.test(said)) parsed.skip.push(1);
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
  let backToHer = false;
  const rowOf = (n: number) => (ids[n - 1] ? env.WP_OS_DB.prepare("SELECT r.*, d.brand, d.contact_email, d.stage FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id WHERE r.id = ?1").bind(ids[n - 1]).first<ReplyRow & { brand: string; contact_email: string; stage: string }>() : Promise.resolve(null));

  /*
   * TWO ROUNDS (owner, 6 Nov 2026). On a round-1 email (to her alone), her "approved" on a draft with prices does not
   * send it: it goes to round 2, to her and Scooter. On a round-2 email every partner's answer is recorded, and only
   * when all of them have answered does anything happen: all approved → it sends; any notes → Wynn redrafts once,
   * with everyone's notes together ("he should wait for both our inputs").
   */
  const partnerRound = needed.length > 1;
  let toPartners = false;
  const recordInput = async (r: ReplyRow, input: { approved: boolean; note: string | null }): Promise<PartnerInputs | null> => {
    const before = r.inputs_json ?? null;
    const next: PartnerInputs = { ...inputsOf(before), [approverId]: { ...input, at: now.toISOString() } };
    const rec = await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET inputs_json = ?2 WHERE id = ?1 AND state = 'NOTIFIED' AND notice_ref = ?3 AND COALESCE(inputs_json, '') = ?4")
      .bind(r.id, JSON.stringify(next), ref, before ?? "").run();
    return (rec.meta?.changes ?? 0) === 0 ? null : next;
  };
  const allAnswered = (inputs: PartnerInputs) => needed.every((id) => inputs[id]);
  const waitingOn = (inputs: PartnerInputs) => namesOf(needed.filter((id) => !inputs[id]));
  const notesOf = (inputs: PartnerInputs) => needed.filter((id) => inputs[id]?.note).map((id) => `${firstNameOf(id)}: ${inputs[id]!.note}`).join("\n\n");
  let redrafted = 0;
  let learned = 0;
  const redraftWithAll = async (r: ReplyRow, inputs: PartnerInputs, n: number) => {
    await redraftFor(env, { ...r, research_tries: 0 }, notesOf(inputs), now, deps);
    redrafted += 1;
    lines.push(`${n} · ${brandDisplayName((r as ReplyRow & { brand: string }).brand)}: both of you have answered; Wynn redrafted it with both sets of notes`);
  };

  for (const n of [...approve].sort((a, b) => a - b)) {
    const r = await rowOf(n);
    if (!r) { lines.push(`${n}: not in that email`); continue; }
    if (!partnerRound && carriesPricing(r) && r.state === "NOTIFIED" && r.notice_ref === ref) {
      const moved = await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', round = 'PARTNERS', notice_ref = NULL, approved_by_json = NULL, inputs_json = NULL WHERE id = ?1 AND state = 'NOTIFIED' AND notice_ref = ?2").bind(r.id, ref).run();
      if ((moved.meta?.changes ?? 0) > 0) { toPartners = true; lines.push(`${n} · ${brandDisplayName(r.brand)}: you approved it; it now goes to you and Scooter, and nothing goes to ${brandDisplayName(r.brand)} until you have both approved`); }
      continue;
    }
    if (partnerRound && r.state === "NOTIFIED" && r.notice_ref === ref) {
      const inputs = await recordInput(r, { approved: true, note: null });
      if (!inputs) { lines.push(`${n} · ${brandDisplayName(r.brand)}: changed while your reply was read; nothing sent, reply again`); continue; }
      if (!allAnswered(inputs)) { lines.push(`${n} · ${brandDisplayName(r.brand)}: ${who} approved; waiting on ${waitingOn(inputs)}, nothing sent yet`); continue; }
      if (needed.some((id) => !inputs[id]!.approved)) { await redraftWithAll(r, inputs, n); continue; }
    }
    // THE CLAIM: only one "approved" can move it from NOTIFIED, so a second one (or a re-delivery) sends nothing.
    const claim = await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SENDING' WHERE id = ?1 AND state = 'NOTIFIED' AND notice_ref = ?2").bind(r.id, ref).run();
    if ((claim.meta?.changes ?? 0) === 0) { lines.push(`${n} · ${brandDisplayName(r.brand)}: already ${r.state === "SENT" ? "sent" : r.state.toLowerCase()}, nothing sent again`); continue; }
    try {
      const calendar = await sendApproved(env, owner, r, now, deps);
      lines.push(`${n} · ${brandDisplayName(r.brand)}: ${needed.length > 1 ? `${approvalWords(needed, needed)}; ` : ""}sent from ${TLC_OWNER.email}, on their thread${calendar ? `; ${calendar}` : ""}`);
    } catch (err) {
      lines.push(`${n} · ${brandDisplayName(r.brand)}: ${await sendFailed(env, r, err, now)}`);
      if (err instanceof SamplesPdfError && !err.retry) backToHer = true;
    }
  }
  for (const n of [...skipped]) {
    const r = await rowOf(n);
    if (!r) continue;
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SKIPPED', held_reason = ?2 WHERE id = ?1 AND state = 'NOTIFIED'").bind(r.id, `skipped by ${who} (${ref})`).run();
    lines.push(`${n} · ${brandDisplayName(r.brand)}: skipped by ${who}, nothing sent`);
  }
  for (const c of parsed.change) {
    const r = await rowOf(c.n);
    if (!r || r.state !== "NOTIFIED") continue;
    // The standing parts of HER note are Wynn's rules from now on, for every later draft — this one included. A note
    // from Scooter changes this one draft; it does not become a standing rule.
    if (approverId === TLC_OWNER.firmUserId) learned += await learnRules(env, c.note, ref, firmScope);
    if (partnerRound && r.notice_ref === ref) {
      const inputs = await recordInput(r, { approved: false, note: c.note });
      if (!inputs) { lines.push(`${c.n} · ${brandDisplayName(r.brand)}: changed while your reply was read; reply again`); continue; }
      if (!allAnswered(inputs)) { lines.push(`${c.n} · ${brandDisplayName(r.brand)}: ${who}'s notes are saved; Wynn waits for ${waitingOn(inputs)} before changing anything`); continue; }
      await redraftWithAll(r, inputs, c.n);
      continue;
    }
    await redraftFor(env, { ...r, research_tries: 0 }, c.note, now, deps);
    redrafted += 1;
  }
  const again = redrafted || backToHer || toPartners ? await sendReplyApprovals(env, now, firmScope) : null;
  if (lines.length) {
    const sentN = lines.filter((l) => /sent from /.test(l)).length;
    const halfN = lines.filter((l) => /waiting on /.test(l)).length;
    await emailHer(env, firmScope, `${ref}:done`, {
      what: `brand replies, ${sentN ? "done" : halfN ? "half approved" : "done"} · ${ref}`,
      tldr: [sentN ? `${sentN} sent, from your mailbox, on their threads.` : "", halfN ? `${halfN} approved by ${who}, not sent yet: waiting on ${namesOf(needed.filter((id) => id !== approverId))}.` : "", !sentN && !halfN ? `${who} answered ${ref}.` : ""].filter(Boolean).join(" "),
      sections: [{ label: "Done", bullets: lines.slice(0, 6) }, { label: "Next", bullets: [again ? `Redrafted for the note: ${again}` : halfN ? `It goes once ${namesOf(needed)} have each replied "approved" to ${ref}` : "Wynn watches for their answer"] }],
    }, [], needed.length > 1 ? copied : [], needed.length > 1).catch(() => false);
  }
  await appendEvent(env, { eventType: "tlc.brand_reply_decided", actorType: "firm_user", actorId: approverId, objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { lines, redrafted, learned } });
  return { handled: true, ref, detail: [...lines, ...(redrafted ? [`${redrafted} redrafted`] : [])].join("; ") || "nothing to do" };
}

/**
 * AN APPROVED SEND NEVER NEEDS A PERSON TO PUSH IT (10 Nov 2026: three tries 30 minutes apart gave up after an hour
 * and left Pinecone's approved answer FAILED). A PDF that cannot be made yet is tried again on its own for 24 hours:
 * twice at SEND_RETRY_MINUTES, then hourly (30 + 30 + 23 x 60 minutes = 24 hours: the approval, then 25 tries).
 */
export const SEND_RETRY_MINUTES = 30;
export const SEND_TRIES = 26;
export const sendRetryMinutes = (triesSoFar: number): number => (triesSoFar < 3 ? SEND_RETRY_MINUTES : 60);

/**
 * An approved send that did not go. Nothing left (the PDF is made before the send), so:
 *   - the renderer was busy: tried again on its own (sendRetryMinutes) up to SEND_TRIES; she is not asked again;
 *     past that (24 hours), ONE email to her: the draft comes back to her approval email, saying what failed, that
 *     nothing went to the brand, and the one thing to do (approve it again);
 *   - the PDF itself is wrong (not 3 pages): back to her as a draft, saying what to shorten;
 *   - anything else: FAILED, named in her "done" email.
 */
async function sendFailed(env: Env, r: ReplyRow & { brand?: string }, err: unknown, now: Date): Promise<string> {
  const why = err instanceof Error ? err.message : String(err);
  const tries = (r.send_tries ?? 0) + 1;
  // Her mailbox could not be read to find the conversation (services/tlcBrandThread.ts): tried again the same way.
  const mailboxBusy = err instanceof BrandThreadError && err.retry;
  if (((err instanceof SamplesPdfError && err.retry) || mailboxBusy) && tries < SEND_TRIES) {
    const due = new Date(now.getTime() + sendRetryMinutes(tries) * 60_000).toISOString();
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'FAILED', send_retry_due = ?2, send_tries = ?3, held_reason = ?4 WHERE id = ?1")
      .bind(r.id, due, tries, `approved; ${why}`.slice(0, 300)).run();
    return mailboxBusy
      ? `approved, not sent yet (${why.slice(0, 160)}); it is tried again on its own, nothing for you to do`
      : `approved, not sent yet (${why.slice(0, 120)}); it goes on its own once the PDF is made, nothing for you to do`;
  }
  if (err instanceof SamplesPdfError && err.retry) {
    const brand = r.brand ? brandDisplayName(r.brand) : "the brand";
    const what = `${STALE_SHEET_PREFIX} You approved this, but for 24 hours the PDF that goes with it could not be made, so nothing went to ${brand}. The one thing to do: approve it again here and it goes, with the PDF made then.`;
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, approved_by_json = NULL, inputs_json = NULL, send_retry_due = NULL, send_tries = 0, report_text = ?3, held_reason = ?2 WHERE id = ?1")
      .bind(r.id, null, what).run();
    return `NOT sent (the PDF could not be made for 24 hours); it comes back to you to approve again`;
  }
  if (err instanceof SamplesPdfError && !err.retry && r.samples_id) {
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, send_retry_due = NULL, send_tries = 0, held_reason = ?2 WHERE id = ?1")
      .bind(r.id, `Not sent yet: ${why}. Open the samples page and reply with what to shorten or change.`.slice(0, 300)).run();
    return `NOT sent (${why.slice(0, 160)}); a new email asks what to change`;
  }
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'FAILED', send_retry_due = NULL, send_tries = ?3, held_reason = ?2 WHERE id = ?1").bind(r.id, why.slice(0, 300), tries).run();
  return `NOT sent (${why.slice(0, 160)})`;
}

/** Each pass: answers she approved whose PDF could not be made yet are sent now, once (a claim), on her approval. */
export async function retryApprovedSends(env: Env, now: Date, firmScope = "west-peek", deps: BrandReplyDeps = {}): Promise<string[]> {
  const due = (await env.WP_OS_DB.prepare(
    `SELECT r.*, d.brand, d.contact_email, d.stage FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id
      WHERE r.firm_scope = ?1 AND r.state = 'FAILED' AND r.send_retry_due IS NOT NULL AND r.send_retry_due <= ?2`,
  ).bind(firmScope, now.toISOString()).all<ReplyRow & { brand: string; contact_email: string; stage: string }>()).results ?? [];
  if (due.length === 0) return [];
  const owner = await actorForFirmUser(env, TLC_OWNER.firmUserId);
  if (!owner) return [];
  const lines: string[] = [];
  for (const r of due) {
    const claim = await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SENDING', send_retry_due = NULL WHERE id = ?1 AND state = 'FAILED' AND send_retry_due IS NOT NULL").bind(r.id).run();
    if ((claim.meta?.changes ?? 0) === 0) continue;
    try {
      await sendApproved(env, owner, r, now, deps);
      await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET held_reason = NULL WHERE id = ?1").bind(r.id).run();
      lines.push(`${brandDisplayName(r.brand)}: sent (you approved it; the PDF is made now)`);
    } catch (err) {
      lines.push(`${brandDisplayName(r.brand)}: ${await sendFailed(env, r, err, now)}`);
    }
  }
  // Only a send is news: a try that failed again is not an email (she would get one an hour), and the one that gives
  // up after 24 hours reaches her as the draft back in her approval email (sendFailed).
  // A send that stopped for good because its conversation cannot be found is news too: she is the one who can act.
  const sent = lines.filter((l) => /: sent /.test(l));
  const stopped = lines.filter((l) => /: NOT sent \(NAMED STOP/.test(l));
  if (sent.length || stopped.length) {
    await emailHer(env, firmScope, `retry:${due.map((r) => r.id).join(",")}`.slice(0, 120), {
      what: sent.length ? "approved answers, sent on their own" : "approved answers, NOT sent",
      tldr: [sent.length ? `${sent.length} sent, from your mailbox, on their threads.` : "", stopped.length ? `${stopped.length} NOT sent: nothing went to the brand.` : ""].filter(Boolean).join(" "),
      // Two labelled sections: the owner-email door refuses an email with one (it never arrived before 13 Nov 2026).
      sections: [{ label: sent.length ? "Done" : "Not sent", bullets: [...sent, ...stopped].slice(0, 6) }, { label: "Next", bullets: [stopped.length ? "A stopped answer needs you: reply to that brand yourself from their thread." : "Wynn watches for their answer"] }],
    }).catch(() => false);
  }
  return lines;
}

/**
 * ONE EMAIL TO A BRAND, ON ITS CONVERSATION, ON HER APPROVAL: the `email.send` request from Wynn, its approval card
 * decided by her (the words of her approval are the decision note), then the executor and her own Gmail. The payload
 * always carries the thread (the executor refuses a brand email after the first without one).
 */
async function sendOnThread(
  env: Env, owner: Actor, r: { id: string; deal_id: string; firm_scope: string }, to: string, cc: readonly string[],
  payload: { subject: string; text: string; gmail_thread_id: string; in_reply_to: string } & Record<string, unknown>,
  title: string, approval: string, onFiled: (requestId: string, cardId: string) => Promise<unknown> = async () => undefined,
): Promise<string> {
  const { approvedFor } = await import("./learningClub");
  const requestId = `eer_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id, outside_job) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4, ?5)",
  ).bind(requestId, to, JSON.stringify(payload), WYNN, TLC_BRAND_SALES_JOB).run();
  const { requestApproval, decideApproval } = await import("./approvals");
  const card = await requestApproval(env, wynnActor(r.firm_scope), {
    action_key: "effect.email.send", object_type: "external_effect_request", object_id: requestId,
    title, summary: `To: ${to}${cc.length ? `\nCc: ${cc.join(", ")}` : ""}\n${payload.subject}\n\n${payload.text}`.slice(0, 1800),
    payload: { deal_id: r.deal_id, brand_reply_id: r.id }, submit: true,
  });
  await decideApproval(env, owner, card.id, "approved", approval.slice(0, 1000));
  await onFiled(requestId, card.id);
  const { executeExternalEffect } = await import("../effects/executor");
  await executeExternalEffect(approvedFor(env, card.id, to, cc), wynnActor(r.firm_scope), requestId, card.id);
  return requestId;
}

/*
 * THE SAME EMAIL AGAIN, ONCE, WHEN A BRAND SAYS NOTHING (owner, 13 Nov 2026: "we need to follow up on the actual
 * thread with the exact same pricing email if we do not get a response in 7 days … never drop the thread").
 *
 * Armed one answer at a time, on HER word: one `tlc_setting` row, key `brand_reply_resend:<tlc_brand_reply id>`,
 * value {"state":"ARMED","due":"<ISO time>","note":"<her words>"}. No brand email goes without her approval of it
 * (4 Nov 2026), so nothing arms this by itself. Each drip pass, for an armed answer:
 *   - any message from the brand after our email (an auto-reply is not one), or a deal that ended: CANCELLED, for good;
 *   - before RESEND_QUIET_DAYS full days since our email went (and never before `due`): nothing;
 *   - then, once: the email that went, byte for byte (the sent request's own subject, words, copies and PDF), as a
 *     reply on the conversation of the brand's message it answered. SENT, and she is told.
 * It never sends on a guess: her inbox must have been read on this pass, and a message from the brand that Wynn has
 * not taken in stops it. A stop that needs a person (no conversation, the sent email gone, a refused send) is
 * STOPPED and emailed to her; her mailbox being unreadable just now is tried again on the next pass. The row keeps
 * what happened (state, reason, at, effect_request_id).
 */
export const RESEND_QUIET_DAYS = 7;
export const RESEND_SETTING_PREFIX = "brand_reply_resend:";
export interface ResendOrder { state: "ARMED" | "SENDING" | "SENT" | "CANCELLED" | "STOPPED"; due?: string; note?: string; reason?: string; at?: string; effect_request_id?: string }
export const resendDueAt = (sentAt: string, armedFor: string | null | undefined): number =>
  Math.max(Date.parse(sentAt) + RESEND_QUIET_DAYS * 86_400_000, Date.parse(armedFor ?? "") || 0);

export async function resendUnanswered(env: Env, now: Date, firmScope: string, inboxRead: boolean, deps: BrandReplyDeps = {}): Promise<string> {
  const orders = (await env.WP_OS_DB.prepare("SELECT key, value FROM tlc_setting WHERE key LIKE ?1 ORDER BY key").bind(`${RESEND_SETTING_PREFIX}%`).all<{ key: string; value: string | null }>()).results ?? [];
  const n = { sent: 0, waiting: 0, cancelled: 0 };
  const stops: string[] = [];
  for (const o of orders) {
    const order = (() => { try { const v = JSON.parse(o.value ?? "null") as ResendOrder | null; return v && typeof v === "object" && typeof v.state === "string" ? v : null; } catch { return null; } })();
    if (!order) { stops.push(`NAMED STOP [RESEND_ORDER_UNREADABLE] ${o.key}: its value is not a follow-up order, so nothing is sent for it`); continue; }
    if (order.state !== "ARMED") continue;
    const r = await env.WP_OS_DB.prepare(
      "SELECT r.*, d.brand, d.contact_email, d.stage FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id WHERE r.id = ?1",
    ).bind(o.key.slice(RESEND_SETTING_PREFIX.length)).first<ReplyRow & { brand: string; contact_email: string; stage: string }>();
    if (r && r.firm_scope !== firmScope) continue;
    // The order's own row is the record: each change is made only if the row still says what this pass read (once).
    let stored = o.value!;
    const settle = async (state: ResendOrder["state"], why: string, requestId?: string): Promise<boolean> => {
      const next = JSON.stringify({ ...order, state, reason: why.slice(0, 300), at: now.toISOString(), ...(requestId ? { effect_request_id: requestId } : {}) });
      const done = await env.WP_OS_DB.prepare("UPDATE tlc_setting SET value = ?2, set_at = ?4 WHERE key = ?1 AND value = ?3").bind(o.key, next, stored, now.toISOString()).run();
      if ((done.meta?.changes ?? 0) === 0) return false;
      stored = next;
      return true;
    };
    const brand = r ? brandDisplayName(r.brand) : o.key;
    /** A stop only a person can clear: recorded, and she is told once (nothing went to the brand). */
    const stop = async (code: string, why: string): Promise<void> => {
      await settle("STOPPED", `NAMED STOP [${code}] ${why}`);
      stops.push(`NAMED STOP [${code}] ${brand}: ${why}`);
      await appendEvent(env, { eventType: "tlc.brand_reply_resend_stopped", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_brand_reply", objectId: r?.id ?? o.key, firmScope, payload: { code, why: why.slice(0, 300) } });
      await emailHer(env, firmScope, `resend:${r?.id ?? o.key}:stopped`, {
        what: `${brand} follow-up NOT sent · ${r?.thread_ref ?? r?.notice_ref ?? ""}`.trim(),
        tldr: `Nothing went to ${brand}. The follow-up you asked for (the same email again after ${RESEND_QUIET_DAYS} quiet days) stopped.`,
        sections: [
          { label: "What stopped it", bullets: [`${why[0]!.toUpperCase()}${why.slice(1).replace(/\bher (mailbox|approval)\b/g, "your $1")}.`] },
          { label: "The one thing to do", bullets: [`Reply to ${brand} yourself from their thread in your mailbox. Wynn will not try this follow-up again.`] },
        ],
      }).catch(() => false);
    };
    if (!r) { await stop("RESEND_NOTHING_SENT", "the answer it repeats is not on record"); continue; }
    if (r.state !== "SENT" || !r.sent_at || !r.effect_request_id) { await stop("RESEND_NOTHING_SENT", "the answer it repeats was never sent"); continue; }
    if (!order.note?.trim()) { await stop("RESEND_NOT_APPROVED", "her approval of this follow-up is not on record"); continue; }
    const answered = await env.WP_OS_DB.prepare(
      "SELECT 1 FROM tlc_brand_reply WHERE deal_id = ?1 AND id != ?2 AND received_at > ?3 AND intent != 'AUTO_REPLY' LIMIT 1",
    ).bind(r.deal_id, r.id, r.sent_at).first();
    if (answered || ["DECLINED", "STOPPED"].includes(r.stage)) {
      await settle("CANCELLED", answered ? "the brand wrote back, so the follow-up is not needed" : "the deal ended");
      n.cancelled += 1;
      continue;
    }
    if (now.getTime() < resendDueAt(r.sent_at, order.due)) { n.waiting += 1; continue; }
    // Never on a guess: this pass must have read her inbox, and her mailbox must hold nothing newer from the brand.
    if (!inboxRead) { stops.push(`NAMED STOP [RESEND_INBOX_NOT_READ] ${brand}: her inbox was not read on this pass, so the follow-up waits for the next one`); continue; }
    const owner = await actorForFirmUser(env, TLC_OWNER.firmUserId);
    if (!owner) { stops.push(`NAMED STOP [RESEND_NO_OWNER] ${brand}: her firm user is not active; tried again on the next pass`); continue; }
    const sentRequest = await env.WP_OS_DB.prepare("SELECT destination, payload_json FROM external_effect_request WHERE id = ?1 AND executed_at IS NOT NULL")
      .bind(r.effect_request_id).first<{ destination: string; payload_json: string }>();
    const original = (() => { try { return JSON.parse(sentRequest?.payload_json ?? "null") as ({ subject?: string; text?: string; cc?: unknown } & Record<string, unknown>) | null; } catch { return null; } })();
    if (!sentRequest || !original?.subject || !original.text) { await stop("RESEND_ORIGINAL_MISSING", "the email that went is no longer on record, so it cannot be sent again word for word"); continue; }
    const to = sentRequest.destination;
    const cc = (Array.isArray(original.cc) ? original.cc : []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
    let thread: Awaited<ReturnType<typeof replyThread>>;
    try {
      const finder = deps.thread ?? (await import("./tlcBrandThread")).defaultThreadFinder;
      const people = [...new Set([to, ...cc, r.contact_email].map((a) => a.trim().toLowerCase()))];
      const domain = emailDomain(r.contact_email);
      const newest = await finder(env, { query: `from:(${[...people, ...(domain && !FREE_MAIL_DOMAINS.has(domain) ? [domain] : [])].join(" OR ")}) after:${Math.floor(Date.parse(r.sent_at) / 1000)}` });
      if (newest) {
        const known = await env.WP_OS_DB.prepare("SELECT intent FROM tlc_brand_reply WHERE deal_id = ?1 AND brand_message_id = ?2").bind(r.deal_id, normalizeMid(newest.messageId)).first<{ intent: string }>();
        if (known?.intent !== "AUTO_REPLY") { await stop("RESEND_BRAND_WROTE", "a newer message from the brand is in her mailbox, so the same email is not sent over it"); continue; }
      }
      thread = await replyThread(env, r.brand_message_id, to, finder);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (err instanceof BrandThreadError && !err.retry) { await stop("TLC_BRAND_THREAD_NOT_FOUND", "the brand's conversation cannot be found in her mailbox"); continue; }
      stops.push(`NAMED STOP [RESEND_MAILBOX_NOT_READ] ${brand}: ${why.slice(0, 160)}; tried again on the next pass`);
      continue;
    }
    if (!(await settle("SENDING", "claimed by this pass"))) continue;
    try {
      const requestId = await sendOnThread(env, owner, r, to, cc, { ...original, subject: original.subject, text: original.text, ...thread },
        `Wynn: TLC follow-up to ${brand} (the same email again)`, `Her approval of this one follow-up: ${order.note}`);
      await settle("SENT", `no reply in ${RESEND_QUIET_DAYS} days: the same email went again on their thread`, requestId);
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET last_sent_at = ?2, updated_at = ?2 WHERE id = ?1").bind(r.deal_id, now.toISOString()).run();
      await appendEvent(env, { eventType: "tlc.brand_reply_resent", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_brand_reply", objectId: r.id, firmScope, payload: { effect_request_id: requestId, gmail_thread_id: thread.gmail_thread_id } });
      n.sent += 1;
      await emailHer(env, firmScope, `resend:${r.id}:sent`, {
        what: `${brand} follow-up, sent · ${r.thread_ref ?? r.notice_ref ?? ""}`.trim(),
        tldr: `${brand} had not answered in ${RESEND_QUIET_DAYS} days, so the same email went again, from your mailbox, as a reply on their thread, as you asked.`,
        sections: [
          { label: "Done", bullets: [`The email of ${herClock(r.sent_at)} went to ${to}${cc.length ? ` (copy to ${cc.join(", ")})` : ""} again, word for word, with the same PDF.`] },
          { label: "Next", bullets: ["Nothing needed from you. Wynn watches for their answer and will not send it a third time."] },
        ],
      }).catch(() => false);
    } catch (err) {
      await stop("RESEND_SEND_FAILED", `the send was refused (${(err instanceof Error ? err.message : String(err)).slice(0, 160)})`);
    }
  }
  return `pricing follow-ups: OUTPUT ${n.sent} resend_sent (${n.waiting} armed and waiting, ${n.cancelled} cancelled by a reply)${stops.length ? `; ${stops.join("; ")}` : ""}`;
}

/** Her approved answer, through the brand-sales lane: approval card, executor, her own Gmail, threaded. */
async function sendApproved(env: Env, owner: Actor, r: ReplyRow & { brand: string; contact_email: string; stage: string }, now: Date, deps: BrandReplyDeps = {}): Promise<string | null> {
  const { BRAND_REPLY_TO, approvedFor, clubViewOf, renderPdfFor } = await import("./learningClub");
  const deal = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>())!;
  const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
  const { to, cc } = answerRecipients(r);
  // WYNN NEVER DROPS THE THREAD (owner, 13 Nov 2026): the conversation is found in her mailbox before anything is
  // made; when it cannot be found this throws a NAMED STOP and nothing goes out (services/tlcBrandThread.ts).
  const thread = await replyThread(env, r.brand_message_id, to, deps.thread);
  // The samples PDF goes with a yes to the samples, made NOW from her preview, once; the priced pitch only in answer
  // to a yes after a call (her rule). A PDF that cannot be made stops the send before anything leaves.
  const samples = r.samples_id ? await finalizeSamplesPdf(env, r.samples_id, deps.samples ?? {}) : null;
  const pitchAllowed = r.intent === "YES" && !r.samples_id && ev?.topic && !noMoneyNow(await wynnRules(env, r.firm_scope), deal.stage);
  const stored: EmailAttachment[] = [];
  /*
   * THE PDF IS MADE FROM THE APPROVED VERSION (owner, 7 Nov 2026): a proposal's partner-levels sheet is made now, from
   * the brand's current sheet (its levels and series prices), never the copy made when the first draft was written.
   */
  let files = JSON.parse(r.attachments_json ?? "[]") as StoredFile[];
  if (r.kind === "PROPOSAL" && ev) {
    const made = await sheetPdf(env, deal, ev, await sponsorFor(env, deal, r.their_text), deps);
    if (typeof made === "string") throw new SamplesPdfError(`the partner-levels sheet could not be made (${made.slice(0, 240)})`, true);
    files = [...files.filter((f) => !isSheet(f)), made];
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET attachments_json = ?2 WHERE id = ?1").bind(r.id, JSON.stringify(files)).run();
  }
  for (const f of files) {
    const a = await storedAttachment(env, f);
    if (!a) throw new Error(`the attachment "${f.name}" is missing from the store, so nothing was sent`);
    stored.push(a);
  }
  const attachments = samples ? [samples] : stored.length ? stored : pitchAllowed && ev?.topic ? await renderPdfFor(env, clubViewOf(ev), ev.topic).catch(() => []) : [];
  await sendOnThread(env, owner, r, to, cc,
    { subject: r.draft_subject, text: withBrandFooter(r.draft_body), reply_to: BRAND_REPLY_TO, ...(cc.length ? { cc } : {}), ...thread, ...(attachments.length ? { attachments } : {}) },
    `Wynn: TLC answer to ${brandDisplayName(r.brand)}`, `Approved by email reply (${r.notice_ref}).`,
    (requestId, cardId) => env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET effect_request_id = ?2, approval_card_id = ?3 WHERE id = ?1").bind(r.id, requestId, cardId).run());
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'SENT', sent_at = ?2 WHERE id = ?1").bind(r.id, now.toISOString()).run();
  if (r.samples_id) await env.WP_OS_DB.prepare("UPDATE tlc_samples SET state = 'SENT', sent_at = ?2 WHERE id = ?1").bind(r.samples_id, now.toISOString()).run();
  // Step 5 approved: the deal is agreed at the level they picked (payment arrives against the invoice, never taken here).
  if (r.kind === "CONFIRM" && r.tier) {
    const { TLC_TIERS } = await import("../../shared/tlc/learningClub");
    const t = TLC_TIERS[r.tier as keyof typeof TLC_TIERS];
    await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'AGREED', tier = ?2, cash_offer_usd = ?3, decision = 'YES', updated_at = ?4 WHERE id = ?1").bind(deal.id, r.tier, t?.priceUsd ?? 0, now.toISOString()).run();
  }
  const stage = stageAfterReply(r.intent as BrandReplyIntent, deal.stage);
  await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = COALESCE(?2, stage), yes_at = CASE WHEN ?3 = 'YES' THEN COALESCE(yes_at, ?4) ELSE yes_at END, updated_at = ?4 WHERE id = ?1").bind(deal.id, stage, r.intent, now.toISOString()).run();
  if (!r.agreed_slot) return null;
  /*
   * THE CALL GOES ON HER CALENDAR, THE BRAND INVITED (owner, 26 Oct 2026), once she approved the confirmation. The
   * meeting sync picks the event up, so the prep email covers it the evening before. A calendar that would not take
   * it is named in her "done" email, never skipped quietly.
   */
  if (r.calendar_event_id) return `already on your calendar`;
  try {
    const made = await (deps.makeEvent ?? defaultMakeEvent)(env, callEvent(r.brand, r.contact_email, r.agreed_slot, ev?.topic ?? null));
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET calendar_event_id = ?2 WHERE id = ?1").bind(r.id, made.id).run();
    await appendEvent(env, { eventType: "tlc.brand_call_scheduled", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_deal", objectId: deal.id, firmScope: r.firm_scope, payload: { at: r.agreed_slot, event: made.id } });
    return `${slotWords(r.agreed_slot)} is on your calendar, ${r.contact_email} invited`;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET held_reason = ?2 WHERE id = ?1").bind(r.id, `calendar event not made: ${why}`.slice(0, 300)).run();
    return `the call (${slotWords(r.agreed_slot)}) could NOT be put on your calendar (${why.slice(0, 120)}); add it by hand`;
  }
}

// ── The brand's reply page ──────────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The sheet's own stylesheet, scoped under one class so the full sheet sits IN the page (no iframe; owner, 7 Nov 2026)
 * without its styles reaching the page around it. The sheet's CSS is ours (shared/tlc/pitch.ts): plain rules, @media
 * and @font-face; @page is dropped.
 */
export function scopeCss(css: string, scope: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth) { if (css[j] === "{") depth += 1; else if (css[j] === "}") depth -= 1; j += 1; }
    const inner = css.slice(open + 1, j - 1);
    if (head.startsWith("@media")) out += `${head}{${scopeCss(inner, scope)}}`;
    else if (head.startsWith("@font-face")) out += `${head}{${inner}}`;
    else if (!head.startsWith("@")) {
      out += `${head.split(",").map((sel) => {
        const t = sel.trim();
        if (/^:root\[data-theme="dark"\]/.test(t)) return `${scope}[data-theme="dark"]${t.replace(/^:root\[data-theme="dark"\]/, "")}`;
        if (/^:root/.test(t)) return `${scope}${t.replace(/^:root(?::not\(\[data-theme="light"\]\))?/, "")}`;
        if (/^(?:body|main)\b/.test(t)) return `${scope}${t.replace(/^(?:body|main)/, "")}`;
        return `${scope} ${t}`;
      }).join(",")}{${inner}}`;
    }
    i = j;
  }
  return out;
}
/** A full sheet page as a block of this page: its scoped style and its body. */
export function embeddedSheet(html: string, scope = ".wp-sheet"): string {
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  const body = /<main>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
  return `<style>${scopeCss(css, scope)}</style><div class="${scope.slice(1)}">${body}</div>`;
}

export interface ThreadItem { at: string; ours: boolean; from: string; to: string[]; cc: string[]; subject: string; body: string; files: string[]; what: string }

/**
 * THE THREAD, START TO FINISH, from the OS's own mail records for the deal (the same ones the brand's thread is read
 * from): every email we sent it (the drip, the follow-up, each approved answer, with its attachments) and every message
 * of theirs we read (the stored message for its From, To and Cc). Oldest first.
 */
export async function dealThread(env: Env, deal: TlcDealRow & { people_json?: string | null }): Promise<ThreadItem[]> {
  const ours = new Set([TLC_OWNER.email.toLowerCase(), INTAKE_MAILBOX.toLowerCase()]);
  const nameOf = (address: string): string => {
    const a = address.trim().toLowerCase();
    if (ours.has(a) || OUR_MAIL_DOMAINS.some((d) => a.endsWith(`@${d}`))) return firstNameOf(TLC_OWNER.firmUserId);
    return personWords(a, deal).name.split(/\s+/)[0] ?? a;
  };
  const sent = async (effectId: string | null): Promise<{ to: string[]; cc: string[]; files: string[] }> => {
    const e = effectId ? await env.WP_OS_DB.prepare("SELECT destination, payload_json FROM external_effect_request WHERE id = ?1").bind(effectId).first<{ destination: string; payload_json: string }>() : null;
    let p: { cc?: string[]; attachments?: Array<{ filename?: string }> } = {};
    try { p = JSON.parse(e?.payload_json ?? "{}"); } catch { p = {}; }
    return { to: e ? [e.destination] : [deal.contact_email], cc: p.cc ?? [], files: (p.attachments ?? []).map((a) => a.filename ?? "").filter(Boolean) };
  };
  const items: ThreadItem[] = [];
  const drips = (await env.WP_OS_DB.prepare("SELECT step, subject, body, sent_at, effect_request_id FROM tlc_drip_message WHERE deal_id = ?1 AND state = 'SENT' AND sent_at IS NOT NULL").bind(deal.id).all<{ step: number; subject: string; body: string; sent_at: string; effect_request_id: string | null }>()).results ?? [];
  for (const d of drips) {
    const s = await sent(d.effect_request_id);
    items.push({ at: d.sent_at, ours: true, from: nameOf(TLC_OWNER.email), to: s.to.map(nameOf), cc: s.cc.map(nameOf), subject: d.subject, body: withoutFooter(d.body), files: s.files, what: d.step === 0 ? "First email" : `Follow-up ${d.step}` });
  }
  const follow = await env.WP_OS_DB.prepare("SELECT subject, body, sent_at, effect_request_id FROM tlc_pitch_followup WHERE deal_id = ?1 AND state = 'SENT' AND sent_at IS NOT NULL").bind(deal.id).first<{ subject: string; body: string; sent_at: string; effect_request_id: string | null }>();
  if (follow) { const s = await sent(follow.effect_request_id); items.push({ at: follow.sent_at, ours: true, from: nameOf(TLC_OWNER.email), to: s.to.map(nameOf), cc: s.cc.map(nameOf), subject: follow.subject, body: withoutFooter(follow.body), files: s.files, what: "Follow-up" }); }
  const replies = (await env.WP_OS_DB.prepare(
    `SELECT r.*, i.from_address, i.r2_key FROM tlc_brand_reply r LEFT JOIN inbound_message i ON trim(i.message_id, '<>') = r.brand_message_id
      WHERE r.deal_id = ?1 ORDER BY r.received_at`,
  ).bind(deal.id).all<ReplyRow & { from_address: string | null; r2_key: string | null; sent_at?: string | null; effect_request_id?: string | null }>()).results ?? [];
  for (const r of replies) {
    let head = "";
    if (r.r2_key && env.WP_OS_DOCUMENTS) { const obj = await env.WP_OS_DOCUMENTS.get(r.r2_key).catch(() => null); if (obj) head = (await obj.text()).split(/\r?\n\r?\n/)[0] ?? ""; }
    const header = (name: string) => [...head.matchAll(new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "gim"))].map((m) => m[1]!.replace(/\r?\n[ \t]+/g, " ")).join(", ");
    const addrs = (v: string) => (v.match(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+\.[a-z]{2,}/gi) ?? []).map((a) => a.toLowerCase());
    const from = addrs(header("From"))[0] ?? (r.from_address ?? r.send_to ?? deal.contact_email);
    const to = addrs(header("To")).filter((a) => a !== INTAKE_MAILBOX.toLowerCase());
    items.push({ at: r.received_at, ours: false, from: nameOf(from), to: (to.length ? to : [TLC_OWNER.email]).map(nameOf), cc: addrs(header("Cc")).filter((a) => a !== INTAKE_MAILBOX.toLowerCase()).map(nameOf), subject: r.their_subject, body: theirWordsOnly(r.their_text), files: [], what: `"${threadGist(theirWordsOnly(r.their_text))}"` });
    if (r.state === "SENT" && r.sent_at) {
      const s = await sent(r.effect_request_id ?? null);
      items.push({ at: r.sent_at, ours: true, from: nameOf(TLC_OWNER.email), to: s.to.map(nameOf), cc: s.cc.map(nameOf), subject: r.draft_subject, body: withoutFooter(r.draft_body), files: s.files, what: s.files.length ? `Our answer, with ${s.files.join(" and ")}` : `Our answer: "${threadGist(withoutFooter(r.draft_body))}"` });
    }
  }
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
/** The one line the thread table shows: the first sentence of four or more words, after any "Hi …," greeting. */
function threadGist(text: string): string {
  const flat = text.replace(/^\s*(?:hi|hello|hey|dear)\b[^\n,]*,?\s*\n/i, "").replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.?!]+[.?!]?/g)?.map((x) => x.trim()).filter(Boolean) ?? [flat];
  const pick = sentences.find((x) => x.split(/\s+/).length >= 4) ?? sentences[0] ?? flat;
  return pick.length > 140 ? `${pick.slice(0, 137).trimEnd()}…` : pick;
}
/** Their words without the signature block under a "--" line. */
const theirWordsOnly = (t: string): string => t.replace(/\r\n/g, "\n").split(/\n--\s*\n/)[0]!.trim();
const withoutFooter = (t: string): string => withBrandFooter(t).replace(/\n+[^\n]*\d{4,5}[^\n]*$/, "").trim();

/** The newest brand reply (any round) for a brand, by its slug: the one the page and the email are about. */
async function replyForSlug(env: Env, slug: string): Promise<{ r: ReplyRow & { page_token?: string | null }; deal: TlcDealRow & { people_json?: string | null; series_json?: string | null }; ev: TlcEventRow } | null> {
  const { brandSlug } = await import("../../shared/tlc/replyDoc");
  const deals = ((await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal").all<TlcDealRow & { people_json?: string | null }>()).results ?? []).filter((d) => brandSlug(d.brand) === slug);
  if (!deals.length) return null;
  const r = await env.WP_OS_DB.prepare(
    `SELECT * FROM tlc_brand_reply WHERE deal_id IN (SELECT value FROM json_each(?1)) AND draft_body != '' AND state IN ('DRAFTED','NOTIFIED','SENDING','SENT','FAILED')
      ORDER BY CASE WHEN state = 'SENT' THEN 1 ELSE 0 END, received_at DESC LIMIT 1`,
  ).bind(JSON.stringify(deals.map((d) => d.id))).first<ReplyRow & { page_token?: string | null }>();
  if (!r) return null;
  const deal = deals.find((d) => d.id === r.deal_id)!;
  const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
  return ev ? { r, deal, ev } : null;
}

const PAGE_HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };

/**
 * THE OLD DRAFT LINK (6 Nov 2026) STILL WORKS: it redirects to the brand's readable reply page. An unknown or malformed
 * token is a plain 404, as before.
 */
export async function handleTlcDraftPage(ctx: RouteContext): Promise<Response> {
  const token = String(ctx.params.token ?? "");
  const notFound = () => new Response("Not found", { status: 404, headers: PAGE_HEADERS });
  if (!/^[0-9a-f]{32}$/.test(token)) return notFound();
  const row = await ctx.env.WP_OS_DB.prepare("SELECT d.brand FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id WHERE r.page_token = ?1").bind(token).first<{ brand: string }>();
  if (!row) return notFound();
  const { replyPagePath } = await import("../../shared/tlc/replyDoc");
  return new Response(null, { status: 302, headers: { ...PAGE_HEADERS, location: replyPagePath(row.brand) } });
}

/**
 * THE WHOLE <BRAND> STORY (owner, 7 Nov 2026, the page behind "See the whole Pinecone story ›", built on the thread
 * rundown made for Scooter): the document and its version, who has answered; where it stands; the thread start to
 * finish, every email in full in a fold; the reply as it would go; the full sheet, in the page; every version; how to
 * approve. Behind the firm's sign-in (a partner's identity, as every non-public page); never indexed or cached.
 * One column, 390 px first, dark mode.
 */
export async function handleTlcReplyPage(ctx: RouteContext): Promise<Response> {
  const slug = String(ctx.params.brand ?? "").toLowerCase();
  const notFound = () => new Response("Not found", { status: 404, headers: PAGE_HEADERS });
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return notFound();
  const found = await replyForSlug(ctx.env, slug);
  if (!found) return notFound();
  const { r, deal, ev } = found;
  const env = ctx.env;
  const brand = brandDisplayName(deal.brand);
  const pricing = carriesPricing(r);
  const doc = docNameFor(r.kind, pricing);
  const version = r.version ?? 1;
  const notice = r.notice_ref ? await env.WP_OS_DB.prepare("SELECT approvers_json, sent_at FROM tlc_brand_reply_notice WHERE ref = ?1").bind(r.notice_ref).first<{ approvers_json: string | null; sent_at: string }>() : null;
  const needed = idList(notice?.approvers_json).length ? idList(notice?.approvers_json)
    : inPartnerRound(r) ? [TLC_OWNER.firmUserId, ...TLC_BRAND_REPLY_NOTICE_CC_IDS] : [TLC_OWNER.firmUserId];
  const inputs = inputsOf(r.inputs_json);
  const status = r.state === "SENT" ? `Sent to ${brand}.`
    : r.state === "NOTIFIED" ? answeredWords(needed, inputs)
    : r.state === "FAILED" ? `Approved; not sent yet: ${r.held_reason ?? "the send is tried again"}.`
    : r.held_reason ? `Held: ${r.held_reason}` : "Wynn is updating this draft.";
  const { to, cc } = answerRecipients({ ...r, contact_email: deal.contact_email });
  const asker = personWords(to, deal);
  const thread = await dealThread(env, deal);
  const lastOurs = [...thread].reverse().find((t) => t.ours);
  const where = `${asker.name}${asker.role ? ` (${asker.role})` : ""} asked "${theirGist(theirWordsOnly(r.their_text))}" on ${herClock(r.received_at)}. ${r.state === "SENT" ? `Our answer went on ${r.sent_at ? herClock(r.sent_at) : "its day"}.` : `This is our v${version} answer, not sent yet.`}${lastOurs && r.state !== "SENT" ? ` The last thing we sent ${brand} was on ${herClock(lastOurs.at)}${lastOurs.files.length ? ` (${lastOurs.files.join(", ")})` : ""}.` : ""}`;
  const sheet = r.kind === "PROPOSAL" ? await sheetHtmlFor(ev, await sponsorFor(env, deal, r.their_text)) : null;
  const versions = (await env.WP_OS_DB.prepare("SELECT version, round, draft_body, changes_json, sent_at FROM tlc_brand_reply_version WHERE reply_id = ?1 ORDER BY sent_at").bind(r.id).all<{ version: number; round: string | null; draft_body: string; changes_json: string | null; sent_at: string }>()).results ?? [];
  const changes = (() => { try { return changeLinesOf(JSON.parse(r.changes_json ?? "null")); } catch { return []; } })();
  const para = (t: string) => esc(t).replace(/\n/g, "<br>");
  const who = (t: ThreadItem) => `${esc(t.from)} → ${esc(t.to.join(", "))}${t.cc.length ? `, ${esc(t.cc.join(" and "))} copied` : ""}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(brand)} ${esc(doc)} · v${version}</title><style>
:root{--bg:#FBF7F0;--ink:#2A2622;--muted:#6E665C;--line:#E2D9CB;--card:#FFFFFF;--gold:#A87A1E;--green:#2F7A4E;--accent:#F05A1A}
@media (prefers-color-scheme:dark){:root{--bg:#1A1714;--ink:#F3ECE0;--muted:#B5AA9A;--line:#3A332C;--card:#24201C;--gold:#E0B54E;--green:#6CC08E;--accent:#FF7A3D}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 Karla,-apple-system,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:0 0 60px}
.top{background:#111;color:#fff;padding:18px 16px}.top .k{color:var(--accent);font:600 12px ui-monospace,Menlo,monospace;letter-spacing:.12em}
.top h1{font:600 22px/1.25 Georgia,serif;margin:6px 0 4px}.top .sub{font-size:13px;opacity:.85;margin:0}
section{padding:14px 16px;border-top:1px solid var(--line)}h2{font:600 18px/1.3 Georgia,serif;margin:0 0 8px}
.sub{color:var(--muted);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:8px 6px;border-bottom:1px solid var(--line)}
th{font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
@media (max-width:560px){table.pc thead{display:none}table.pc tr{display:block;border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:6px 10px;background:var(--card)}table.pc td{display:block;border:0;padding:3px 0}table.pc td::before{content:attr(data-label);display:block;font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}}
details summary{cursor:pointer;color:var(--gold);font-weight:600;min-height:44px;display:flex;align-items:center}
.mail{border-left:3px solid var(--gold)}.mail.us{border-left-color:var(--green)}.mail .hd{font-size:13px;color:var(--muted);margin-bottom:6px}.mail .hd b{color:var(--ink)}
.quote{border-left:3px solid var(--accent);white-space:normal}.att{display:inline-block;margin-top:6px;font:500 12px ui-monospace,Menlo,monospace;padding:3px 8px;border-radius:6px;border:1px solid var(--line)}
ul{padding-left:20px;margin:6px 0}li{margin:4px 0}.wp-sheet{border:1px solid var(--line);border-radius:12px;overflow:hidden;padding:0 16px 16px}
</style></head><body><main>
<header class="top"><div class="k">WEST PEEK · THE LEARNING CLUB</div><h1>${esc(brand)} ${esc(doc)} · v${version}</h1><p class="sub">${esc(status)}</p></header>
<section><h2>Where it stands</h2><p style="margin:0">${esc(where)}</p></section>
<section><h2>The thread, start to finish</h2>
<table class="pc"><thead><tr><th>When (CT)</th><th>Who</th><th>What</th></tr></thead><tbody>
${thread.map((t) => `<tr><td data-label="When (CT)">${esc(herClock(t.at).replace(/ CT$/, ""))}</td><td data-label="Who">${who(t)}</td><td data-label="What">${esc(t.what)}</td></tr>`).join("\n")}
${r.state !== "SENT" ? `<tr><td data-label="When (CT)">Not sent</td><td data-label="Who">${esc(firstNameOf(TLC_OWNER.firmUserId))} → ${esc(asker.name.split(/\s+/)[0] ?? asker.name)}</td><td data-label="What">Our v${version} answer, below</td></tr>` : ""}
</tbody></table>
<details><summary>Show every email in full ▾</summary><p class="sub">Each email as it went or came in. Quoted earlier messages and signature blocks are trimmed; nothing else is changed.</p>
${thread.map((t) => `<div class="card mail${t.ours ? " us" : ""}"><div class="hd"><b>${esc(t.from)}</b> · ${esc(herClock(t.at))}<br>To: ${esc(t.to.join(", "))}${t.cc.length ? ` · Cc: ${esc(t.cc.join(", "))}` : ""}<br>${esc(t.subject)}</div>${para(t.body)}${t.files.map((f) => `<br><span class="att">📎 ${esc(f)}</span>`).join("")}</div>`).join("\n")}
</details></section>
${version > 1 && changes.length ? `<section><h2>What changed since v${version - 1}</h2><ul>${changes.map((c) => `<li>${c.who ? `<b>${esc(c.who)}:</b> ` : ""}${c.note ? `"${esc(c.note)}" → ` : ""}${esc(c.done)}</li>`).join("")}</ul></section>` : ""}
<section><h2>The reply (v${version})</h2><p class="sub">Word for word, as it would go.</p>
<div class="card quote"><div class="sub">To: ${esc(asker.full)}${cc.length ? ` · Cc: ${esc(cc.map((a) => personWords(a, deal).full).join(", "))}` : ""}<br>${esc(r.draft_subject)}</div><br>${para(withBrandFooter(r.draft_body))}</div></section>
${sheet ? `<section><h2>The pricing sheet (v${version})</h2><p class="sub">The full sheet ${esc(brand)} gets. The PDF is made from this, once you have both approved.</p>${embeddedSheet(sheet)}</section>` : ""}
<section><h2>Version history</h2>${versions.length ? versions.map((v) => `<p style="margin:6px 0 0"><b>v${v.version}</b> · ${esc(herClock(v.sent_at))} · ${v.round === "PARTNERS" ? "to Sequoia and Scooter" : "to Sequoia"}${(() => { try { const c = changeLinesOf(JSON.parse(v.changes_json ?? "null")); return c.length ? `: ${esc(c.map((x) => `${x.who ? `${x.who}: ` : ""}${x.done}`).join("; "))}` : ""; } catch { return ""; } })()}</p>${v.version !== version ? `<details><summary>Show v${v.version} in full ▾</summary><div class="card">${para(withBrandFooter(v.draft_body))}</div></details>` : ""}`).join("") : `<p class="sub" style="margin:0">v${version} is the first version.</p>`}</section>
<section><h2>To approve</h2><p style="margin:0">Reply to the email "approved", or with your notes. ${needed.length > 1 ? `Nothing goes to ${esc(brand)} until ${esc(namesOf(needed))} have both replied "approved". Wynn waits for both of you, applies every note (Scooter's wins when they conflict), and the next version comes back here.` : "Wynn applies every note and the next version comes back here."}</p></section>
</main></body></html>`;
  return new Response(html, { headers: { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" } });
}
async function sheetHtmlFor(ev: TlcEventRow, sponsor: TlcSponsorView): Promise<string> {
  const { clubViewOf } = await import("./learningClub");
  const { renderBrandPitch } = await import("../../shared/tlc/pitch");
  return renderBrandPitch(clubViewOf(ev), sponsor);
}
