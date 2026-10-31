import type { Env } from "../env";
import { appendEvent } from "../events";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import type { EmailAttachment } from "../effects/emailTransport";
import { pdfPageCount, renderHtmlPdf, type PdfRenderer } from "../effects/htmlPdf";
import { BRAND_MUST_STAFF, MONEY_WORDS } from "../../shared/tlc/brandReply";
import { brandDisplayName } from "../../shared/tlc/learningClub";
import {
  approvedSamplePrices, samplesOverridesSchema, samplesWordsSchema, COMMUNITY_MIX_SETTING, NEVER_TEXT, clubTitle, completeWords, fallbackWords, isAgentTopic, readMix, renderSamplesPdf, renderSamplesPreview, samplesPdfName, samplesProblems, whatChangedLine,
  type LegacySamplesWords, type SamplesInput, type SamplesWords,
} from "../../shared/tlc/samples";
import { uploadDocument } from "./documents";
import type { Actor } from "./authorize";
import type { TlcDealRow, TlcEventRow } from "./learningClub";

/**
 * PARKER BUILDS THE THREE SAMPLES (owner, 26 Oct 2026), AS A LIVE PAGE (owner, 30 Oct 2026: "consistently creating a
 * new pdf each time seems wasteful"). One document per deal from the approved template (shared/tlc/samples.ts), with
 * per-deal overrides for her edits. While she shapes it, it is a private preview page (`samplesPreviewUrl`, a 128-bit
 * token, noindex); each change note updates that page and adds one "what changed" line; NO PDF is rendered on a
 * change. On her "approved", `finalizeSamplesPdf` renders the PDF ONCE from the very HTML the page shows, files it
 * (pdf_r2_key) under a name taken from the CURRENT title, and it goes with her answer. Rows already SENT are never
 * changed. Nothing here sends anything.
 */
export interface SamplesRow {
  overrides_json: string | null; approved_prices_json: string | null; document_id: string | null; preview_token: string | null;
  id: string; deal_id: string; input_json: string; state: string; pdf_r2_key: string | null; pdf_name: string | null; problem: string | null; firm_scope: string;
  sent_at?: string | null;
}
export type { SamplesWords } from "../../shared/tlc/samples";
/** What a row's input_json holds: the brand's full words, or (rows from before 30 Oct 2026) three phrases. */
type StoredWords = SamplesWords | LegacySamplesWords;
export type SamplesWriter = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string }>;
export interface SamplesDeps { renderPdf?: PdfRenderer; writer?: SamplesWriter }

/** The private preview page. Under /api/tlc-pitch, the one path Cloudflare Access lets through without a login. */
export const samplesPreviewUrl = (token: string): string => `https://os.joinwestpeek.com/api/tlc-pitch/samples/${token}`;
const newToken = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Shared with the email reviser: the governed Claude-first important-work route, always private. */
export const tlcRevisionWriter: SamplesWriter = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "The Learning Club: revise the brand email or samples",
    actor, inputs: [prompt], sensitivity: "INTERNAL",
    budgetContext: { requiresSearch: false, expectedOutputTokens: 4000, judgement: true, important: true, confidential: true },
    routing: { category: "INTELLIGENCE" },
  });
  return { ok: run.status === "COMPLETED" && Boolean(run.output_text), text: run.output_text ?? "" };
};

/** The input the page and the PDF are both made from: one function, so the two can never differ. */
async function samplesInputOf(env: Env, deal: TlcDealRow, ev: TlcEventRow, words: StoredWords, overridesJson: string | null): Promise<SamplesInput> {
  const mixRaw = (await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(COMMUNITY_MIX_SETTING).first<{ value: string | null }>())?.value ?? null;
  const brand = brandDisplayName(deal.brand);
  return {
    // The date line is the year, "dates flexible", whatever the club's status (owner, 30 Oct 2026).
    brand, topic: ev.topic ?? "", month: ev.month,
    words: completeWords(words, brand, ev.topic ?? ""), mix: readMix(mixRaw),
    ...(overridesJson ? { overrides: samplesOverridesSchema.parse(JSON.parse(overridesJson)) } : {}),
  };
}
const inputOfRow = (env: Env, deal: TlcDealRow, ev: TlcEventRow, row: SamplesRow) => samplesInputOf(env, deal, ev, JSON.parse(row.input_json) as StoredWords, row.overrides_json);

/** The document's HTML as it stands: what the preview page shows and what the PDF is made from. */
export async function samplesHtml(env: Env, deal: TlcDealRow, ev: TlcEventRow, row: SamplesRow): Promise<string> {
  return renderSamplesPdf(await inputOfRow(env, deal, ev, row));
}

async function noteRevision(env: Env, samplesId: string, line: string): Promise<void> {
  await env.WP_OS_DB.prepare("INSERT INTO tlc_samples_revision (id, samples_id, what_changed) VALUES (?1, ?2, ?3)").bind(`tsr_${crypto.randomUUID()}`, samplesId, line.slice(0, 400)).run();
}

/** Newest first. */
export async function samplesRevisions(env: Env, samplesId: string): Promise<Array<{ at: string; line: string }>> {
  return (await env.WP_OS_DB.prepare("SELECT created_at AS at, what_changed AS line FROM tlc_samples_revision WHERE samples_id = ?1 ORDER BY created_at DESC, rowid DESC").bind(samplesId).all<{ at: string; line: string }>()).results ?? [];
}

/** The deal's preview link, minted on first use. A row already SENT gets none (it is left exactly as it is). */
export async function samplesPreviewLink(env: Env, samplesId: string): Promise<string | null> {
  await env.WP_OS_DB.prepare("UPDATE tlc_samples SET preview_token = ?2 WHERE id = ?1 AND preview_token IS NULL AND state != 'SENT'").bind(samplesId, newToken()).run();
  const row = await env.WP_OS_DB.prepare("SELECT preview_token FROM tlc_samples WHERE id = ?1").bind(samplesId).first<{ preview_token: string | null }>();
  return row?.preview_token ? samplesPreviewUrl(row.preview_token) : null;
}

/**
 * HER CHANGE NOTE, APPLIED TO THE PREVIEW. Nothing is rendered to PDF. The new copy is checked against the same
 * rules before it is kept; a change that breaks one is not kept (the page keeps the last good version and says her
 * change is still being made), and the reply holds and retries rather than present the old version as her edit.
 */
export async function reviseSamples(env: Env, deal: TlcDealRow, ev: TlcEventRow, note: string, deps: SamplesDeps = {}): Promise<{ ok: boolean; detail: string }> {
  const row = await samplesForDeal(env, deal.id);
  if (!row) return { ok: false, detail: "the samples record is missing" };
  if (row.state === "SENT") return { ok: false, detail: "these samples were already sent; nothing was changed" };
  try {
    const out = await (deps.writer ?? tlcRevisionWriter)(env, parkerActor(deal.firm_scope), [
      "Revise this deal's Learning Club samples document using every instruction in the owner's note. The template is a baseline, and major edits are allowed.",
      "Return ONLY a JSON object of copy overrides. Omitted keys retain the current copy. Arrays replace a whole section; return the complete revised array.",
      "Keys: title: string (the words after \"The Learning Club: \" on page 1 and in the document's title); page1Rows and series: [{label,title,line,highlight?:boolean}]; seriesHeading, seriesSub, footer2, bring, leaveWith: strings; whyItWorks, partnerGets: string arrays (partnerGets are the brand's own points; the standard \"A room your size\" point always follows them).",
      "The standard text is fixed and is not yours to change: the date line, the guest range, the hours, the community size, the wheel and its note, the team, the legal block and the Confidential · Preliminary footers. Change only what the owner's note asks for.",
      "All values are plain text, no HTML. Do not invent facts, people or numbers. Keep the community mix approximate and the brand's staffing optional.",
      "No prices or money unless the owner explicitly instructs putting a specific price in the PDF. A price mentioned for context is not permission.",
      "Current document (HTML, for context only):", await samplesHtml(env, deal, ev, row),
      "Current overrides:", row.overrides_json ?? "{}",
      "Owner's change note, word for word:", note,
    ].join("\n"));
    if (!out.ok) throw new Error("the samples revision model did not complete");
    const patch = samplesOverridesSchema.parse(JSON.parse(out.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()));
    const overrides = samplesOverridesSchema.parse({ ...JSON.parse(row.overrides_json ?? "{}"), ...patch });
    // Permission is derived here from authenticated owner words, never from the model response.
    const approved = approvedSamplePrices(note);
    const previousPrices = JSON.parse(row.approved_prices_json ?? "[]") as string[];
    const prices = /\b(?:no|remove|omit|exclude|without|don't|do not)\b[^.!?\n]*\b(?:price|prices|pricing|money|fee|fees)\b/i.test(note) ? [] : [...new Set([...previousPrices, ...approved])];
    const input = await samplesInputOf(env, deal, ev, JSON.parse(row.input_json) as StoredWords, JSON.stringify(overrides));
    const problems = samplesProblems(renderSamplesPdf(input), input.mix, prices);
    if (problems.length) throw new Error(`the change broke a rule: ${problems.join("; ")}`);
    const kept = await env.WP_OS_DB.prepare(
      "UPDATE tlc_samples SET overrides_json = ?2, approved_prices_json = ?3, state = 'READY', problem = NULL, pdf_r2_key = NULL, pdf_name = NULL, document_id = NULL, built_at = ?4 WHERE id = ?1 AND state != 'SENT'",
    ).bind(row.id, JSON.stringify(overrides), JSON.stringify(prices), new Date().toISOString()).run();
    if ((kept.meta?.changes ?? 0) === 0) return { ok: false, detail: "these samples were sent meanwhile; nothing was changed" };
    await samplesPreviewLink(env, row.id);
    await noteRevision(env, row.id, whatChangedLine(patch, note));
    await appendEvent(env, { eventType: "tlc.samples_revised", actorType: "ai_employee", actorId: PARKER, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { samples_id: row.id, parts: Object.keys(patch) } });
    return { ok: true, detail: "samples page updated" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await env.WP_OS_DB.prepare("UPDATE tlc_samples SET state = 'FAILED', problem = ?2 WHERE id = ?1 AND state != 'SENT'").bind(row.id, detail.slice(0, 300)).run();
    return { ok: false, detail };
  }
}

const PARKER = "aie_parker";
const parkerActor = (firmScope: string): Actor => ({ type: "AI", aiEmployeeId: PARKER, roles: [], firmScopes: [firmScope] } as unknown as Actor);

export async function samplesForDeal(env: Env, dealId: string): Promise<SamplesRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM tlc_samples WHERE deal_id = ?1").bind(dealId).first<SamplesRow>();
}

/**
 * The brand's words, read strictly: the full set (`samplesWordsSchema`), no money anywhere, no number in the title or
 * the segment's name, no brand put on the hook to staff it, and none of the template's retired text. A row from
 * before 30 Oct 2026 (three phrases) is read by its old rule. Anything else is not used.
 */
export function wordsProblems(w: StoredWords): string[] {
  if (!("months" in w) && !("title" in w)) {
    const out: string[] = [];
    const legacy = w as LegacySamplesWords;
    for (const [k, max] of [["segmentTitle", 60], ["seriesTitle", 40], ["reach", 120]] as const) {
      const v = String(legacy[k] ?? "").trim();
      if (!v) out.push(`${k} is empty`);
      else if (v.length > max) out.push(`${k} is longer than ${max}`);
      else if (/\d/.test(v) || MONEY_WORDS.test(v)) out.push(`${k} carries a number or money`);
    }
    return out;
  }
  const parsed = samplesWordsSchema.safeParse(w);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "words"}: ${i.message}`);
  const out: string[] = [];
  const v = parsed.data;
  const all = [v.title, v.leaveFact, v.openingTheme, v.panelAngle, v.dinnerPick, v.segmentTitle, v.segmentDoes, v.leaveWith, v.seriesTitle, v.seriesTail,
    ...v.months.flatMap((m) => [m.title, m.line]), v.whyLead, v.whyLine, ...v.perks.flatMap((p) => [p.lead, p.line])].join("\n");
  if (MONEY_WORDS.test(all)) out.push("the words carry money");
  if (BRAND_MUST_STAFF.test(all)) out.push("the words put the brand's people on a segment");
  for (const t of NEVER_TEXT) if (all.includes(t)) out.push(`the words say "${t}"`);
  for (const [k, t] of [["title", v.title], ["segmentTitle", v.segmentTitle]] as const) if (/\d/.test(t)) out.push(`${k} carries a number`);
  return out;
}

/**
 * Wynn writes ONLY the per-brand words of the standard template (owner, 30 Oct 2026). The standard text is never in
 * his hands: the prompt asks for these fields, the schema accepts nothing else, and the page is assembled in code.
 */
export function samplesWordsPrompt(brand: string, topic: string, whyFit: string | null, research: string | null, theirText: string): string {
  return [
    `You are Wynn, who looks after brand partners for The Learning Club at West Peek Ventures. ${brand} said yes to seeing three sample pages for the club "${clubTitle(topic)}".`,
    "The pages are a fixed template. Everything else on them is standard and written already (the date, the guest range, the hours, the evening's shape, the community, the team, the legal text). Write ONLY these fields, for this brand:",
    `title: the evening's title, shown after "The Learning Club: " (at most 7 words, title case, like "Your AI Chief of Staff" or "Build Your First AI Agent").`,
    `leaveFact: a short promise after "Hands-on · " (like "everyone leaves with a working assistant").`,
    `openingTheme: the opening talk's theme, shown in quotes (like "What an AI chief of staff can take off your plate").`,
    `panelAngle: completes "three builders on …" (like "what changed when they handed off their busywork").`,
    `dinnerPick: completes "facilitators help each table …" (like "pick the assistant they'll build").`,
    `segmentTitle: the name of ${brand}'s 30-minute hands-on segment, tied to what ${brand} makes (at most 6 words${isAgentTopic(topic) ? ', like "Giving your agent a memory"' : ""}).`,
    `segmentDoes: what every table does in that segment, completing "30 minutes, hands-on: …" (like "every table connects ${brand} to its assistant"). Never say ${brand}'s people must run it.`,
    `leaveWith: what each guest leaves with, completing "… , the step-by-step guide, and introductions to the people at their table." (like "A working AI chief of staff of their own").`,
    `seriesTitle: the sample series' name, after "A sample series: " (like "six months of AI at work").`,
    `seriesTail: ends the sentence "one build that grows every month, …" (like "with ${brand} built in from month 3 on.").`,
    `months: exactly six {title, line, brand}: a monthly build that grows; title follows "The Learning Club: "; line is one sentence; brand is true for the month(s) where ${brand} is at the centre.`,
    `whyLead and whyLine: one reason six months works for ${brand} (like "Real habits, not a demo:" and "members keep using the workflows they built after the series ends.").`,
    `perks: two to four {lead, line}: what partnering gets ${brand}, specific to its product (like {"lead":"Built in from day one:","line":"${brand} is set up in every workflow guests build."}).`,
    "No prices, money or fees. No names of people. Invent nothing about the brand. No guest numbers or community size (those are standard).",
    "",
    `Why the brand fits: ${whyFit ?? "(not recorded)"}`,
    ...(research ? ["What we found researching them:", research] : []),
    "Their message:",
    theirText,
    "",
    'Return ONLY JSON: {"title":"","leaveFact":"","openingTheme":"","panelAngle":"","dinnerPick":"","segmentTitle":"","segmentDoes":"","leaveWith":"","seriesTitle":"","seriesTail":"","months":[{"title":"","line":"","brand":false}],"whyLead":"","whyLine":"","perks":[{"lead":"","line":""}]}',
  ].join("\n");
}

/** Wynn writes the brand's words from what we know of it; the plain fallback stands in when he cannot. */
async function writeWords(env: Env, deal: TlcDealRow, ev: TlcEventRow, theirText: string, research: string | null, deps: SamplesDeps): Promise<SamplesWords> {
  const brand = brandDisplayName(deal.brand);
  const prompt = samplesWordsPrompt(brand, ev.topic ?? "", deal.why_fit ?? null, research, theirText);
  const writer: SamplesWriter = deps.writer ?? (async (e, actor, p) => {
    const { run } = await runAi(e, {
      purpose: "The Learning Club: the brand's words on the three samples",
      actor,
      inputs: [p],
      sensitivity: "PUBLIC" as never,
      // Brand-facing: important work (Claude seat, then Codex, never a free lane).
      budgetContext: { requiresSearch: false, expectedOutputTokens: 1200, judgement: true, important: true },
      routing: { category: "INTELLIGENCE" },
    } as never);
    return { ok: run.status === "COMPLETED" && Boolean(run.output_text), text: run.output_text ?? "" };
  });
  const out = await writer(env, parkerActor(deal.firm_scope), prompt).catch(() => ({ ok: false, text: "" }));
  if (out.ok) {
    try {
      const j = JSON.parse(/\{[\s\S]*\}/.exec(out.text)?.[0] ?? "") as unknown;
      const w = samplesWordsSchema.safeParse(j);
      if (w.success && wordsProblems(w.data).length === 0) return w.data;
    } catch { /* the fallback stands in */ }
  }
  return fallbackWords(brand, ev.topic ?? "");
}

/** Plan a deal's samples ahead of time with the words given (her own, for a brand we expect to say yes). Sends nothing. */
export async function planSamples(env: Env, deal: TlcDealRow, words: StoredWords): Promise<string> {
  const problems = wordsProblems(words);
  if (problems.length) throw new Error(`the samples' words are not usable: ${problems.join("; ")}`);
  const existing = await samplesForDeal(env, deal.id);
  if (existing && existing.state === "SENT") return existing.id;
  const id = existing?.id ?? `tls_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO tlc_samples (id, deal_id, input_json, state, firm_scope) VALUES (?1, ?2, ?3, 'PLANNED', ?4)
     ON CONFLICT (deal_id) DO UPDATE SET input_json = excluded.input_json, state = 'PLANNED', pdf_r2_key = NULL, problem = NULL`,
  ).bind(id, deal.id, JSON.stringify(words), deal.firm_scope).run();
  return id;
}

/**
 * The samples for a deal, made ready as a preview page: the words written (or the planned ones), the document checked
 * against its rules, the preview link minted, and the first line of its history. No PDF (that waits for her
 * "approved"). Never throws: the row says why when it could not. A row already SENT is returned untouched.
 */
export async function buildSamples(
  env: Env, deal: TlcDealRow, ev: TlcEventRow, ctx: { theirText?: string; research?: string | null } = {}, deps: SamplesDeps = {},
): Promise<{ ok: true; row: SamplesRow } | { ok: false; id: string; detail: string }> {
  let row = await samplesForDeal(env, deal.id);
  if (row?.state === "SENT") return { ok: true, row };
  if (row?.state === "READY") {
    await samplesPreviewLink(env, row.id);
    return { ok: true, row: (await samplesForDeal(env, deal.id))! };
  }
  const words: StoredWords = row ? (JSON.parse(row.input_json) as StoredWords) : await writeWords(env, deal, ev, ctx.theirText ?? "", ctx.research ?? null, deps);
  const id = row?.id ?? `tls_${crypto.randomUUID()}`;
  if (!row) {
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_samples (id, deal_id, input_json, state, firm_scope) VALUES (?1, ?2, ?3, 'PLANNED', ?4)").bind(id, deal.id, JSON.stringify(words), deal.firm_scope).run();
  }
  const input = await samplesInputOf(env, deal, ev, words, row?.overrides_json ?? null);
  const problems = samplesProblems(renderSamplesPdf(input), input.mix, JSON.parse(row?.approved_prices_json ?? "[]") as string[]);
  if (problems.length) {
    const detail = `the samples broke a rule: ${problems.join("; ")}`;
    await env.WP_OS_DB.prepare("UPDATE tlc_samples SET state = 'FAILED', problem = ?2 WHERE id = ?1 AND state != 'SENT'").bind(id, detail.slice(0, 300)).run();
    return { ok: false, id, detail };
  }
  await env.WP_OS_DB.prepare("UPDATE tlc_samples SET state = 'READY', problem = NULL, built_at = ?2 WHERE id = ?1 AND state != 'SENT'").bind(id, new Date().toISOString()).run();
  await samplesPreviewLink(env, id);
  if ((await samplesRevisions(env, id)).length === 0) await noteRevision(env, id, "First draft, from the approved template");
  await appendEvent(env, { eventType: "tlc.samples_built", actorType: "ai_employee", actorId: PARKER, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { samples_id: id, preview: true } });
  row = (await samplesForDeal(env, deal.id))!;
  return { ok: true, row };
}

/** Why the PDF could not be made at her "approved". `retry`: a passing fault (the renderer was busy), tried again on its own. */
export class SamplesPdfError extends Error {
  constructor(message: string, readonly retry: boolean) { super(message); }
}

const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * HER "APPROVED": THE PDF, MADE ONCE. Rendered from the current preview's HTML (the same function the page uses),
 * held to three pages, filed in R2 at the samples' pdf_r2_key under a name from the CURRENT title, and returned as
 * the attachment. A PDF already made for this version (a re-delivered "approved") is reused, never made again.
 */
export async function finalizeSamplesPdf(env: Env, samplesId: string, deps: SamplesDeps = {}): Promise<EmailAttachment> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM tlc_samples WHERE id = ?1").bind(samplesId).first<SamplesRow>();
  if (!row) throw new SamplesPdfError("the samples record is missing", false);
  if (row.pdf_r2_key && ["READY", "SENT"].includes(row.state)) {
    const kept = await samplesAttachment(env, samplesId);
    if (kept) return kept;
  }
  if (row.state !== "READY") throw new SamplesPdfError(`the samples are not ready (${row.problem ?? row.state.toLowerCase()})`, false);
  const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(row.deal_id).first<TlcDealRow>();
  const ev = deal ? await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>() : null;
  if (!deal || !ev) throw new SamplesPdfError("the deal or its club is missing", false);
  const input = await inputOfRow(env, deal, ev, row);
  const html = renderSamplesPdf(input);
  const problems = samplesProblems(html, input.mix, JSON.parse(row.approved_prices_json ?? "[]") as string[]);
  if (problems.length) throw new SamplesPdfError(`the samples broke a rule: ${problems.join("; ")}`, false);
  const pdf = await (deps.renderPdf ?? ((h: string) => renderHtmlPdf(env, h)))(html);
  if (pdf.pdfBase64 === null) throw new SamplesPdfError(`the PDF could not be made yet: ${pdf.reason}`, true);
  const bytes = Uint8Array.from(atob(pdf.pdfBase64), (c) => c.charCodeAt(0));
  const pages = pdf.pageCount || pdfPageCount(bytes);
  if (pages !== 3) throw new SamplesPdfError(`the PDF came to ${pages} pages, not 3`, false);
  if (!env.WP_OS_DOCUMENTS) throw new SamplesPdfError("no document store to keep the PDF in", false);
  const name = samplesPdfName(input);
  const filed = await uploadDocument(env, parkerActor(deal.firm_scope), { title: name, doc_type: "OTHER", privacy_label: "INTERNAL", content_base64: pdf.pdfBase64, content_type: "application/pdf" });
  await env.WP_OS_DB.prepare("UPDATE tlc_samples SET pdf_r2_key = ?2, pdf_name = ?3, document_id = ?4 WHERE id = ?1 AND state = 'READY'").bind(row.id, filed.version.r2_key, name, filed.document.id).run();
  await appendEvent(env, { eventType: "tlc.samples_pdf_made", actorType: "ai_employee", actorId: PARKER, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { samples_id: row.id, pages } });
  return { filename: name, content: toBase64(bytes), contentType: "application/pdf" };
}

/** The PDF as an email attachment, or null when none has been made (a draft has a page, not a PDF). */
export async function samplesAttachment(env: Env, samplesId: string): Promise<EmailAttachment | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM tlc_samples WHERE id = ?1").bind(samplesId).first<SamplesRow>();
  if (!row?.pdf_r2_key || !["READY", "SENT"].includes(row.state) || !env.WP_OS_DOCUMENTS) return null;
  const obj = await env.WP_OS_DOCUMENTS.get(row.pdf_r2_key);
  if (!obj) return null;
  return { filename: row.pdf_name ?? "The Learning Club.pdf", content: toBase64(new Uint8Array(await obj.arrayBuffer())), contentType: "application/pdf" };
}

/** Each pass: samples planned ahead of time are made ready as pages, so they are there the moment the brand says yes. */
export async function renderPlannedSamples(env: Env, firmScope = "west-peek", deps: SamplesDeps = {}): Promise<string[]> {
  const rows = (await env.WP_OS_DB.prepare("SELECT s.deal_id FROM tlc_samples s WHERE s.firm_scope = ?1 AND s.state = 'PLANNED'").bind(firmScope).all<{ deal_id: string }>()).results ?? [];
  const done: string[] = [];
  for (const r of rows) {
    const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(r.deal_id).first<TlcDealRow>();
    const ev = deal ? await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>() : null;
    if (!deal || !ev) continue;
    const out = await buildSamples(env, deal, ev, {}, deps);
    done.push(`${brandDisplayName(deal.brand)}: ${out.ok ? "ready" : out.detail}`);
  }
  return done;
}

/**
 * GET /api/tlc-pitch/samples/:token — HER PRIVATE PREVIEW (owner, 30 Oct 2026). No login: the 128-bit token is the
 * credential (the path sits under the one Access bypass, /api/tlc-pitch), the page is read-only and noindex, and an
 * unknown token is a bare 404. The document part is the exact HTML the PDF is made from.
 */
export async function handleTlcSamplesPreview(ctx: RouteContext): Promise<Response> {
  const token = String(ctx.params.token ?? "");
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
  const notFound = () => new Response("Not found", { status: 404, headers });
  if (!/^[0-9a-f]{32}$/.test(token)) return notFound();
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_samples WHERE preview_token = ?1").bind(token).first<SamplesRow>();
  const deal = row ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(row.deal_id).first<TlcDealRow>() : null;
  const ev = deal ? await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>() : null;
  if (!row || !deal || !ev) return notFound();
  // A SENT row is what the brand received: its stored PDF, byte for byte, never the template re-rendered (a template
  // change must not change what she sees as "sent"). Only a sent row with no stored PDF falls back to the page.
  if (row.state === "SENT" && row.pdf_r2_key && ctx.env.WP_OS_DOCUMENTS) {
    const obj = await ctx.env.WP_OS_DOCUMENTS.get(row.pdf_r2_key);
    if (obj) return new Response(await obj.arrayBuffer(), { headers: { ...headers, "content-type": "application/pdf", "content-disposition": `inline; filename="${(row.pdf_name ?? "The Learning Club.pdf").replace(/["\\\r\n]/g, "")}"` } });
  }
  const html = renderSamplesPreview(await samplesHtml(ctx.env, deal, ev, row), {
    brand: brandDisplayName(deal.brand),
    status: row.state === "SENT" ? "SENT" : row.state === "READY" ? "DRAFT" : "WORKING",
    sentAt: row.sent_at ?? null,
    history: await samplesRevisions(ctx.env, row.id),
  });
  return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

// ── Steps 4 and 5: the one-pager, the agreement and the invoice, as stored PDFs ─────────────────

export interface StoredFile { key: string; name: string }

/** Render one HTML page to a PDF and keep it in R2 for her approval email and the brand's. */
export async function storePdf(env: Env, key: string, name: string, html: string, deps: SamplesDeps = {}, onePage = true): Promise<StoredFile | string> {
  const pdf = await (deps.renderPdf ?? ((h: string) => renderHtmlPdf(env, h, { onePage })))(html);
  if (pdf.pdfBase64 === null) return `the PDF "${name}" could not be rendered: ${pdf.reason}`;
  if (!env.WP_OS_DOCUMENTS) return "no document store to keep the PDF in";
  await env.WP_OS_DOCUMENTS.put(key, Uint8Array.from(atob(pdf.pdfBase64), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: "application/pdf" } });
  return { key, name };
}

export async function storedAttachment(env: Env, f: StoredFile): Promise<EmailAttachment | null> {
  const obj = env.WP_OS_DOCUMENTS ? await env.WP_OS_DOCUMENTS.get(f.key) : null;
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { filename: f.name, content: btoa(bin), contentType: "application/pdf" };
}

const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain text (the agreement, the invoice) on one printed page, in the samples' navy-and-gold look. */
export function textPage(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>
@page{size:letter;margin:.6in}body{margin:0;font:12.5px/1.5 "Helvetica Neue",Arial,sans-serif;color:#1d2230;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.band{background:#14233a;color:#f4efe4;padding:18px 22px;border-bottom:4px solid #c9a24a;font:600 20px Georgia,serif}.kick{font:10px Arial;letter-spacing:.18em;color:#c9a24a;margin-bottom:6px}
pre{white-space:pre-wrap;font:inherit;margin:18px 0 0}</style></head><body><div class="band"><div class="kick">WEST PEEK ROOMS · THE LEARNING CLUB</div>${escHtml(title)}</div><pre>${escHtml(text)}</pre></body></html>`;
}
