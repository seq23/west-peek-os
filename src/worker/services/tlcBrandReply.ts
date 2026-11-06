import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";
import { brandCommunityWords, overstatedCommunityClaims, presentCommunitySize } from "../../shared/community/size";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { textBodyOf } from "../effects/mimeAttachments";
import { withBrandFooter } from "../../shared/tlc/brandFooter";
import type { EmailAttachment } from "../effects/emailTransport";
import { listGmailRaw } from "../effects/googleClient";
import { serviceAccountToken } from "../effects/googleWorkspaceClient";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import { addressIn, authenticationVerdict } from "../../shared/intake/partnerAuthority";
import { newTextOf } from "../../shared/events/packetDecisionToken";
import { isEmptyReply, parseDraftReply } from "../../shared/tlc/draftReply";
import {
  BRAND_MUST_STAFF, BRAND_REPLY_ASK, BRAND_REPLY_REF_RE, CALL_ASK, WE_HOST, MONEY_WORDS, THREE_THINGS_OFFER, WHO_WE_ARE, classifyBrandReply, fallbackReplyBody, herNoteOf, replyAllRecipients, noMoneyNow, readResearch, reportText,
  stageAfterReply, standingRulesIn, theirNewText, tierLines, wantsResearch,
  type BrandReplyIntent, type ReplyDraftInput, type WynnRule,
} from "../../shared/tlc/brandReply";
import { BRAND_EMAIL_ROOM_WORDS, classifyBrandMail, TLC_BRAND_REPLY_NOTICE_CC_IDS, TLC_BRAND_REPLY_NOTICE_OBJECT, TLC_DRIP_DAYS, TLC_OWNER, TLC_SEATS, TLC_SIGNATURE, brandDisplayName, signedBrandEmail, monthWords, nextDripAt } from "../../shared/tlc/learningClub";
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
}
export type CallPlan = { offer: string[] } | { agreed: string };
export type ReplyDrafter = (env: Env, actor: Actor, input: ReplyDraftInput & DraftExtras) => Promise<{ ok: boolean; body: string; detail: string }>;
export type BrandResearcher = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;
export type MailboxReader = (env: Env, query: string, maxPages?: number) => Promise<Array<BrandMessage & { from: string }>>;
export interface BrandReplyDeps {
  now?: Date; drafter?: ReplyDrafter; mailbox?: MailboxReader | null; researcher?: BrandResearcher;
  /** Her calendar's busy times, and the event maker (tests pass fakes; production reads and writes her Google calendar). */
  busy?: BusyReader; makeEvent?: EventMaker;
  samples?: SamplesDeps;
}

interface ReplyRow {
  id: string; deal_id: string; brand_message_id: string; their_subject: string; their_text: string; received_at: string; intent: string;
  draft_subject: string; draft_body: string; state: string; notice_ref: string | null; firm_scope: string;
  send_to?: string | null; send_cc_json?: string | null; approved_by_json?: string | null;
  change_note?: string | null; report_text?: string | null; research_due?: string | null; research_tries?: number;
  samples_id?: string | null; previous_draft?: string | null; round?: string | null; inputs_json?: string | null; offered_slots_json?: string | null; agreed_slot?: string | null; calendar_event_id?: string | null; held_reason?: string | null;
  kind?: string | null; tier?: string | null; attachments_json?: string | null; send_retry_due?: string | null; send_tries?: number;
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
  "The room and the community (owner, 6 Nov 2026): never promise a number of guests above 25 and never guarantee attendance; say rooms of 25+, sized to their goals. Never state the community's size today: say we built a community that grew to nearly 5,000 at its height, and that we curate each room from that network. No guarantees of any kind.",
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
    ...(i.note && i.previous ? ["", "Her previous draft:", i.previous, "", "Her note, word for word. Follow EVERY instruction in it, each one, in this redraft:", i.note] : []),
    "",
    'Return ONLY JSON: {"body":""}',
  ].filter((l) => l !== "").join("\n");
  const out = await tlcRevisionWriter(env, actor, prompt);
  if (!out.ok) return { ok: false, body: "", detail: "the revision model did not complete" };
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(out.text)?.[0] ?? "") as { body?: string };
    return j.body?.trim() ? { ok: true, body: j.body.trim(), detail: "ok" } : { ok: false, body: "", detail: "the draft came back empty" };
  } catch {
    return { ok: false, body: "", detail: "the draft could not be read" };
  }
};

/** A draft that breaks her voice rules is not used; the plain template stands in. */
export function draftProblems(body: string, intent: BrandReplyIntent, opts: { noMoney?: boolean; weHost?: boolean; callPlan?: CallPlan | null } = {}): string[] {
  const out: string[] = [];
  if (/\bP\.?\s?S\.?\b/.test(body)) out.push("a P.S.");
  if (/\b\d{2,5}\s+\w+(?:\s\w+)?\s(?:street|st\.?|avenue|ave\.?|road|rd\.?|blvd|suite)\b/i.test(body)) out.push("a postal address");
  // Scooter is named only as who he is to the brand (her WHO_WE_ARE rule): "Scooter Taylor", our founding GP.
  if (/\bscooter\b(?!\s+taylor)/i.test(body)) out.push("a name other than hers");
  if (opts.noMoney && MONEY_WORDS.test(body)) out.push("money before a call (her rule)");
  for (const c of overstatedCommunityClaims(body)) out.push(`a community size above the true one: "${c}" (say it grew to nearly 5,000 at its height)`);
  // Owner, 6 Nov 2026: no present-tense community size, no head count above 25, no guarantee.
  for (const c of presentCommunitySize(body)) { out.push(`a community size today: "${c}" (say it grew to nearly 5,000 at its height)`); break; }
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

async function draftFor(env: Env, deal: TlcDealRow, ev: TlcEventRow, intent: BrandReplyIntent, theirText: string, deps: BrandReplyDeps, redo: { note: string; previous: string; research?: string | null; samplesAttached?: boolean } | null = null, callPlan: CallPlan | null = null): Promise<string> {
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
  const out = await (deps.drafter ?? defaultDrafter)(env, wynnActor(deal.firm_scope), { ...input, note: redo?.note ?? null, previous: redo?.previous ?? null, rules, noMoney, research: redo?.research ?? null, callPlan, samplesAttached: redo?.samplesAttached, levels })
    .catch((err) => ({ ok: false, body: "", detail: String(err) }));
  const words = out.ok && draftProblems(out.body, intent, { noMoney, weHost, callPlan }).length === 0 && (!redo?.samplesAttached || (/\battach(?:ed|ment)\b/i.test(out.body) && !/\b(?:can|could|happy to) (?:send|share)\b/i.test(out.body)))
    ? out.body
    : redo?.samplesAttached ? samplesCoverEmail({ brand: brandDisplayName(deal.brand), contactName: deal.contact_name, topic: ev.topic ?? "", segmentTitle: (await flowStep(env, deal.id)).segment ?? "The brand segment" })
    : callPlan
      ? callFallback(deal.contact_name, callPlan)
      : fallbackReplyBody(input, monthWords, { noMoney, whoWeAre: rules.find((r) => r.code === WHO_WE_ARE)?.rule ?? null });
  return signedBrandEmail(words);
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
  const draft = await draftFor(env, deal, ev, r.intent as BrandReplyIntent, r.their_text, deps, { note, previous, research: report, samplesAttached: Boolean(r.samples_id) });
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'DRAFTED', notice_ref = NULL, approved_by_json = NULL, draft_body = ?2, change_note = ?3, report_text = ?4, research_due = NULL, held_reason = NULL, previous_draft = ?5 WHERE id = ?1")
    .bind(r.id, draft, note, report, r.draft_body).run();
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
  return fillTemplate("proposal", { hi, brand: brandName, topic: ev.topic ?? "", segment: segment ?? `Where ${brandName} comes in`, levels: proposalLevelLines(brandLevels(sponsor, ev.topic ?? "")) });
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
  return `brand replies: ${refreshed ? `${refreshed}; ` : ""}${counts.DRAFTED} drafted, ${counts.WAITING ? `${counts.WAITING} need no reply (waiting on them), ` : ""}${counts.AUTO_REPLY} auto-reply (drip resumed), ${counts.NO} declined; ${polled};${retried.length ? ` approved and sent on their own: ${retried.length};` : ""} ${notice}`;
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
async function emailHer(env: Env, firmScope: string, objectId: string, email: Omit<ExecEmailInput, "employee">, attachments: readonly EmailAttachment[] = [], cc: readonly string[] = []): Promise<boolean> {
  const { emailOwner } = await import("./learningClub");
  const sent = await emailOwner(env, { employee: "Wynn", email, objectType: TLC_BRAND_REPLY_NOTICE_OBJECT, objectId, cardId: null, cardKind: null, firmScope, ...(attachments.length ? { attachments } : {}), ...(cc.length ? { cc } : {}) });
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
export const carriesPricing = (r: { kind?: string | null }): boolean => r.kind === "PROPOSAL" || r.kind === "CONFIRM";
/** Round 2: a pricing draft she approved, now with her and Scooter (a notice that named both partners counts too). */
export const inPartnerRound = (r: { round?: string | null }): boolean => r.round === "PARTNERS";

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
    `SELECT r.*, d.brand, d.contact_name, d.contact_email, e.month, e.topic FROM tlc_brand_reply r JOIN tlc_deal d ON d.id = r.deal_id JOIN tlc_event e ON e.id = d.event_id
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

type WaitingRow = ReplyRow & { brand: string; contact_name: string | null; contact_email: string; month: string; topic: string | null; round?: string | null; inputs_json?: string | null; page_token?: string | null };

async function sendRound(env: Env, now: Date, firmScope: string, rows: WaitingRow[], partnerRound: boolean): Promise<string> {
  const ct = chicago(now);
  const ref = mintRef();
  const to = TLC_OWNER.email;
  const copies = partnerRound ? await approvalCopies(env) : { cc: [] as string[], missing: [] as string[] };
  const needed = [TLC_OWNER.firmUserId, ...copies.cc.map((a) => partnerByEmail(a)!.firmUserId)];
  const both = needed.length > 1;
  /*
   * Round 1 carries what goes with the answer (the samples page link; any PDF attached, so she sees exactly what the
   * brand would get). Round 2 carries NO PDF: one link to the live draft page, which shows the answer, the sheet and
   * every note so far, and is updated in place by each redraft.
   */
  const attachments: EmailAttachment[] = [];
  const attachedTo = new Map<string, string>();
  const previews = new Map<string, { url: string; latest: string | null }>();
  const pages = new Map<string, string>();
  for (const r of rows) {
    if (r.samples_id) {
      const sample = await samplesForDeal(env, r.deal_id);
      const url = sample?.state === "READY" ? await samplesPreviewLink(env, sample.id) : null;
      if (!sample || !url) return "the samples page is not ready; the next pass tries again";
      const history = await samplesRevisions(env, sample.id);
      previews.set(r.id, { url, latest: history.length > 1 ? history[0]!.line : null });
    }
    if (partnerRound) { pages.set(r.id, await draftPageLink(env, r.id)); continue; }
    const mine: EmailAttachment[] = [];
    for (const f of JSON.parse(r.attachments_json ?? "[]") as StoredFile[]) { const a = await storedAttachment(env, f); if (a) mine.push(a); }
    if (mine.length) { attachments.push(...mine); attachedTo.set(r.id, mine.map((a) => a.filename).join(" and ")); }
  }
  const many = rows.length > 1;
  const name = (r: WaitingRow) => brandDisplayName(r.brand);
  const person = (r: WaitingRow) => (r.contact_name?.trim() ? `${r.contact_name.trim()} at ${name(r)}` : name(r));
  /*
   * ROUND 2 IS A LINK, LIGHT LIKE THE DECK'S BACK AND FORTH (owner, 6 Nov 2026: "it should be a link and it should be
   * more light weight"). The page holds their email, the answer, the sheet and every note; the email says only what
   * changed and where to look.
   */
  const lightBlocks = rows.map((r, i) => {
    const diff = r.change_note && r.previous_draft ? changedLines(r.previous_draft, r.draft_body) : null;
    const changed = diff ? (diff.added.length || diff.removed.length ? `${diff.added.length + diff.removed.length} line${diff.added.length + diff.removed.length === 1 ? "" : "s"} changed from your notes` : "nothing in the wording changed; say what you want different") : "first look";
    return `${many ? `${i + 1}. ` : ""}${name(r)}: ${changed}\nOpen the draft: ${pages.get(r.id)}`;
  });
  const blocks = partnerRound ? lightBlocks : rows.map((r, i) => {
    const { to: answerTo, cc } = answerRecipients(r);
    const inputs = inputsOf(r.inputs_json);
    const notes = Object.entries(inputs).filter(([, v]) => v.note).map(([id, v]) => `${firstNameOf(id)} said: ${v.note}`);
    const diff = r.change_note && r.previous_draft ? changedLines(r.previous_draft, r.draft_body) : null;
    return [
      `${many ? `${i + 1}. ` : ""}${name(r).toUpperCase()}, The Learning Club in ${monthWords(r.month)}`,
      "",
      `What ${person(r)} wrote (${herClock(r.received_at)}):`,
      wordsOf(r.their_text),
      "",
      ...(r.change_note ? [`The notes Wynn worked from:`, r.change_note, ""] : []),
      ...(diff ? [diff.added.length || diff.removed.length ? "What Wynn changed:" : "Wynn changed nothing in the wording. Reply with what you want different.", ...diff.removed.map((l) => `  − ${l}`), ...diff.added.map((l) => `  + ${l}`), ""] : []),
      ...(notes.length ? ["Notes so far on this round:", ...notes, ""] : []),
      ...(r.report_text ? [r.report_text, ""] : []),
      ...(r.samples_id && r.held_reason ? [`Note: ${r.held_reason}`, ""] : []),
      `Your answer, as it would go to ${answerTo}${cc.length ? ` (copying ${cc.join(", ")})` : ""}:`,
      "",
      withBrandFooter(r.draft_body),
      ...(attachedTo.has(r.id) ? ["", `Goes with it: ${attachedTo.get(r.id)}`] : []),
      ...(pages.has(r.id) ? ["", `The answer and the pricing sheet, on one page: ${pages.get(r.id)}`] : []),
      ...(previews.has(r.id) ? ["", `The 3 sample pages: ${previews.get(r.id)!.url}`, ...(previews.get(r.id)!.latest ? [`Last change: ${previews.get(r.id)!.latest}`] : []), "To change them, reply with what to change. The PDF is made from that page when you reply approved, and goes with your answer."] : []),
      ...(r.agreed_slot ? ["", `When it goes, ${slotWords(r.agreed_slot)} goes on your calendar and ${r.contact_email} is invited.`] : []),
    ].join("\n");
  });
  const one = rows[0]!;
  const pricingNow = !partnerRound && rows.some(carriesPricing);
  const what = partnerRound
    ? `${many ? `${rows.length} brands' pricing` : `${name(one)} pricing`}, for you and ${namesOf(needed.slice(1)) || "Scooter"} · ${ref}`
    : `${many ? `${rows.length} brands replied` : `${name(one)} replied`} · ${ref}`;
  const tldr = partnerRound
    ? `Wynn's answer to ${many ? `${rows.length} brands` : name(one)}, with prices, is ready for you both on one page.`
    : `${many ? `${rows.length} brands wrote back` : `${person(one)} wrote back`}. Wynn drafted your answer${many ? "s" : ""}, below.`;
  const asks = partnerRound
    ? [`Open the page, then each reply "approved" or with your notes`, `It goes to ${many ? "the brands" : name(one)} only once you have both said approved`, `Wynn waits for both of you before changing anything`]
    : many
      ? ['Reply "approved" to send them all', 'Or "approve 1", "skip 2", or "change 2: what to change"']
      : pricingNow
        ? ['Reply "approved" if it is right; it then goes to you and Scooter, nothing to the brand yet', "Or reply with what to change"]
        : ['Reply "approved" to send it', "Or reply with what to change"];
  try {
    await emailHer(env, firmScope, ref, {
      what,
      tldr,
      tldrBullets: asks,
      sections: [{ label: many ? "Who wrote" : "What they said", bullets: rows.slice(0, 6).map((r, i) => `${many ? `${i + 1}. ` : ""}${person(r)}: "${theirGist(r.their_text)}"${carriesPricing(r) ? " (your answer has prices in it)" : ""}`) },
        { label: "What happens next", bullets: partnerRound
        ? [`${namesOf(needed)}: both need to reply. One "approved" alone sends nothing`, "Notes from either of you wait until the other has answered too; then Wynn redrafts with both", "The answer goes from your mailbox, on their thread, with the PDF made from the page you approved",
          ...(copies.missing.length ? ["Scooter could not be added: his record in the OS was not found"] : [])]
        : pricingNow
          ? ["This answer has prices in it, so after your approval it goes to you and Scooter for both of you to approve", "Nothing goes to the brand until then"]
          : ["Your answer goes from your mailbox, on their thread", "Nothing goes until you say so"] }],
      details: [...blocks.flatMap((b) => [b, ""]), `Ref ${ref}`].join("\n"),
    }, attachments, copies.cc);
  } catch (err) {
    return `the approval email could not be sent (${err instanceof Error ? err.message : String(err)}); the next pass tries again`;
  }
  const messageId: string | null = null;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_brand_reply_notice (ref, reply_ids_json, day, firm_scope, sent_at, sent_to, forced, gmail_id, approvers_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(ref, JSON.stringify(rows.map((r) => r.id)), ct.day, firmScope, now.toISOString(), to, 0, messageId, JSON.stringify(needed)).run();
  for (const r of rows) await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'NOTIFIED', notice_ref = ?2, approved_by_json = NULL, inputs_json = NULL WHERE id = ?1 AND state = 'DRAFTED'").bind(r.id, ref).run();
  await appendEvent(env, { eventType: "tlc.brand_reply_notice", actorType: "ai_employee", actorId: WYNN, objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { replies: rows.length, round: partnerRound ? 2 : 1 } });
  return `${partnerRound ? "round-2" : "round-1"} approval email ${ref} with ${rows.length} brand repl${many ? "ies" : "y"} sent${copies.cc.length ? `, ${copiedNames(copies.cc)} on it` : ""}${copies.missing.length ? `; NOT on it (no active partner record): ${copies.missing.join(", ")}` : ""}`;
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
    }, [], needed.length > 1 ? copied : []).catch(() => false);
  }
  await appendEvent(env, { eventType: "tlc.brand_reply_decided", actorType: "firm_user", actorId: approverId, objectType: "tlc_brand_reply_notice", objectId: ref, firmScope, payload: { lines, redrafted, learned } });
  return { handled: true, ref, detail: [...lines, ...(redrafted ? [`${redrafted} redrafted`] : [])].join("; ") || "nothing to do" };
}

/** How often, and how many times, an approved send whose PDF could not be made yet is tried again on its own. */
export const SEND_RETRY_MINUTES = 30;
export const SEND_TRIES = 3;

/**
 * An approved send that did not go. Nothing left (the PDF is made before the send), so:
 *   - the renderer was busy: tried again on its own every SEND_RETRY_MINUTES, up to SEND_TRIES; she is not asked again;
 *   - the PDF itself is wrong (not 3 pages): back to her as a draft, saying what to shorten;
 *   - anything else: FAILED, named in her "done" email.
 */
async function sendFailed(env: Env, r: ReplyRow, err: unknown, now: Date): Promise<string> {
  const why = err instanceof Error ? err.message : String(err);
  const tries = (r.send_tries ?? 0) + 1;
  if (err instanceof SamplesPdfError && err.retry && tries < SEND_TRIES) {
    const due = new Date(now.getTime() + SEND_RETRY_MINUTES * 60_000).toISOString();
    await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET state = 'FAILED', send_retry_due = ?2, send_tries = ?3, held_reason = ?4 WHERE id = ?1")
      .bind(r.id, due, tries, `approved; ${why}`.slice(0, 300)).run();
    return `approved, not sent yet (${why.slice(0, 120)}); it goes on its own once the PDF is made, nothing for you to do`;
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
  if (lines.length) {
    await emailHer(env, firmScope, `retry:${due.map((r) => r.id).join(",")}`.slice(0, 120), {
      what: "approved answers, sent on their own",
      tldr: `${lines.filter((l) => /: sent /.test(l)).length} sent, from your mailbox, on their threads.`,
      sections: [{ label: "Done", bullets: lines.slice(0, 6) }],
    }).catch(() => false);
  }
  return lines;
}

/** Her approved answer, through the brand-sales lane: approval card, executor, her own Gmail, threaded. */
async function sendApproved(env: Env, owner: Actor, r: ReplyRow & { brand: string; contact_email: string; stage: string }, now: Date, deps: BrandReplyDeps = {}): Promise<string | null> {
  const { BRAND_REPLY_TO, approvedFor, clubViewOf, renderPdfFor } = await import("./learningClub");
  const deal = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>())!;
  const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
  // The samples PDF goes with a yes to the samples, made NOW from her preview, once; the priced pitch only in answer
  // to a yes after a call (her rule). A PDF that cannot be made stops the send before anything leaves.
  const samples = r.samples_id ? await finalizeSamplesPdf(env, r.samples_id, deps.samples ?? {}) : null;
  const pitchAllowed = r.intent === "YES" && !r.samples_id && ev?.topic && !noMoneyNow(await wynnRules(env, r.firm_scope), deal.stage);
  const stored: EmailAttachment[] = [];
  for (const f of JSON.parse(r.attachments_json ?? "[]") as StoredFile[]) {
    const a = await storedAttachment(env, f);
    if (!a) throw new Error(`the attachment "${f.name}" is missing from the store, so nothing was sent`);
    stored.push(a);
  }
  const attachments = samples ? [samples] : stored.length ? stored : pitchAllowed && ev?.topic ? await renderPdfFor(env, clubViewOf(ev), ev.topic).catch(() => []) : [];
  const requestId = `eer_${crypto.randomUUID()}`;
  const inReplyTo = r.brand_message_id.startsWith("nomid:") ? null : r.brand_message_id;
  const { to, cc } = answerRecipients(r);
  await env.WP_OS_DB.prepare(
    "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id, outside_job) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4, ?5)",
  ).bind(requestId, to, JSON.stringify({ subject: r.draft_subject, text: withBrandFooter(r.draft_body), reply_to: BRAND_REPLY_TO, ...(cc.length ? { cc } : {}), ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), ...(attachments.length ? { attachments } : {}) }), WYNN, TLC_BRAND_SALES_JOB).run();
  const { requestApproval, decideApproval } = await import("./approvals");
  const card = await requestApproval(env, wynnActor(r.firm_scope), {
    action_key: "effect.email.send", object_type: "external_effect_request", object_id: requestId,
    title: `Wynn: TLC answer to ${brandDisplayName(r.brand)}`, summary: `To: ${to}${cc.length ? `\nCc: ${cc.join(", ")}` : ""}\n${r.draft_subject}\n\n${withBrandFooter(r.draft_body)}`.slice(0, 1800),
    payload: { deal_id: r.deal_id, brand_reply_id: r.id }, submit: true,
  });
  await decideApproval(env, owner, card.id, "approved", `Approved by email reply (${r.notice_ref}).`);
  await env.WP_OS_DB.prepare("UPDATE tlc_brand_reply SET effect_request_id = ?2, approval_card_id = ?3 WHERE id = ?1").bind(r.id, requestId, card.id).run();
  const { executeExternalEffect } = await import("../effects/executor");
  await executeExternalEffect(approvedFor(env, card.id, to, cc), wynnActor(r.firm_scope), requestId, card.id);
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

// ── Round 2's live draft page ───────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * THE DRAFT PAGE (owner, 6 Nov 2026: "not send a full pdf back but an artifact that can be pinged back and forth").
 * One private link per pricing draft: their email, the answer as it would go, the pricing sheet as the brand would see
 * it, and every note so far. Each redraft updates the same page in place; she and Scooter answer by replying to the
 * email. Never indexed, never cached; an unknown or malformed token is a plain 404.
 */
export async function handleTlcDraftPage(ctx: RouteContext): Promise<Response> {
  const token = String(ctx.params.token ?? "");
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
  const notFound = () => new Response("Not found", { status: 404, headers });
  if (!/^[0-9a-f]{32}$/.test(token)) return notFound();
  const r = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_brand_reply WHERE page_token = ?1").bind(token).first<ReplyRow & { page_token: string }>();
  const deal = r ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>() : null;
  const ev = deal ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>() : null;
  if (!r || !deal || !ev) return notFound();
  const brand = brandDisplayName(deal.brand);
  let sheet = "";
  if (r.kind === "PROPOSAL") {
    const { clubViewOf } = await import("./learningClub");
    const { renderBrandPitch } = await import("../../shared/tlc/pitch");
    sheet = renderBrandPitch(clubViewOf(ev), await sponsorFor(ctx.env, deal, r.their_text));
  }
  const notice = r.notice_ref ? await ctx.env.WP_OS_DB.prepare("SELECT approvers_json FROM tlc_brand_reply_notice WHERE ref = ?1").bind(r.notice_ref).first<{ approvers_json: string | null }>() : null;
  const needed = idList(notice?.approvers_json).length ? idList(notice?.approvers_json) : [TLC_OWNER.firmUserId];
  const inputs = inputsOf(r.inputs_json);
  const status = r.state === "SENT" ? `Sent to ${brand}.`
    : r.state === "NOTIFIED" ? needed.map((id) => `${firstNameOf(id)}: ${inputs[id] ? (inputs[id]!.approved ? "approved" : "sent notes") : "not answered yet"}`).join(" · ")
    : r.state === "DRAFTED" || r.state === "SENDING" ? "Wynn is updating this draft." : r.state === "SKIPPED" ? "Skipped; nothing was sent." : "Closed.";
  const diff = r.previous_draft ? changedLines(r.previous_draft, r.draft_body) : null;
  const para = (t: string) => esc(t).replace(/\n/g, "<br>");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(brand)}: draft answer</title><style>
:root{--ink:#1f1d1a;--muted:#6b665e;--ground:#faf7f2;--card:#fff;--line:#e6e0d6;--gold:#9a6b12;--add:#e8f3ea;--del:#f8e9e7}
@media (prefers-color-scheme:dark){:root{--ink:#f1ece3;--muted:#b3ab9e;--ground:#1b1916;--card:#25221e;--line:#3a352e;--gold:#e0b45c;--add:#1f3324;--del:#3a2421}}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px}h1{font-size:21px;margin:8px 0 4px}h2{font-size:18px;margin:24px 0 8px}
.sub{color:var(--muted);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-wrap:anywhere}
.add{background:var(--add)}.del{background:var(--del);text-decoration:line-through}.d{display:block;padding:2px 6px;border-radius:4px;margin:2px 0}
iframe{width:100%;height:900px;border:1px solid var(--line);border-radius:10px;background:#fff}
</style></head><body><main>
<h1>${esc(brand)}: your answer, draft</h1>
<p class="sub">${esc(status)}</p>
<p class="sub">To approve or change it, reply to the email this link came in: "approved", or your notes. Wynn waits for everyone's answer before changing anything, then updates this page.</p>
<h2>What they wrote</h2><div class="card">${para(wordsOf(r.their_text))}</div>
${diff && (diff.added.length || diff.removed.length) ? `<h2>What changed in the last draft</h2><div class="card">${diff.removed.map((l) => `<span class="d del">${esc(l)}</span>`).join("")}${diff.added.map((l) => `<span class="d add">${esc(l)}</span>`).join("")}</div>` : diff ? `<h2>What changed in the last draft</h2><div class="card">Nothing in the wording changed.</div>` : ""}
${r.change_note ? `<h2>The notes Wynn worked from</h2><div class="card">${para(r.change_note)}</div>` : ""}
${Object.keys(inputs).length ? `<h2>Answers on this round</h2><div class="card">${needed.filter((id) => inputs[id]).map((id) => `<p><b>${esc(firstNameOf(id))}</b>: ${inputs[id]!.approved ? "approved" : para(inputs[id]!.note ?? "")}</p>`).join("")}</div>` : ""}
<h2>Your answer, as it would go</h2><div class="card">${para(withBrandFooter(r.draft_body))}</div>
${sheet ? `<h2>The pricing sheet ${esc(brand)} would get</h2><iframe title="Pricing sheet" srcdoc="${esc(sheet)}"></iframe>` : ""}
</main></body></html>`;
  return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}
