import type { Env } from "../env";
import { appendEvent } from "../events";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import type { EmailAttachment } from "../effects/emailTransport";
import { pdfPageCount, renderHtmlPdf, type PdfRenderer } from "../effects/htmlPdf";
import { MONEY_WORDS } from "../../shared/tlc/brandReply";
import { brandDisplayName } from "../../shared/tlc/learningClub";
import {
  approvedSamplePrices, samplesOverridesSchema, COMMUNITY_MIX_SETTING, isAgentTopic, readMix, renderSamplesPdf, renderSamplesPreview, samplesPdfName, samplesProblems, whatChangedLine,
  type SamplesInput,
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
export type SamplesWords = Pick<SamplesInput, "segmentTitle" | "seriesTitle" | "reach">;
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
async function samplesInputOf(env: Env, deal: TlcDealRow, ev: TlcEventRow, words: SamplesWords, overridesJson: string | null): Promise<SamplesInput> {
  const mixRaw = (await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(COMMUNITY_MIX_SETTING).first<{ value: string | null }>())?.value ?? null;
  return {
    brand: brandDisplayName(deal.brand), topic: ev.topic ?? "", month: ev.month,
    // A club not yet at its go-check is tentative ("could move, or repeat"), and the document says so.
    tentative: !["GO", "DONE"].includes(String((ev as { status?: string }).status ?? "")),
    ...words, mix: readMix(mixRaw),
    ...(overridesJson ? { overrides: samplesOverridesSchema.parse(JSON.parse(overridesJson)) } : {}),
  };
}
const inputOfRow = (env: Env, deal: TlcDealRow, ev: TlcEventRow, row: SamplesRow) => samplesInputOf(env, deal, ev, JSON.parse(row.input_json) as SamplesWords, row.overrides_json);

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
      "Keys: title: string (the page 1 heading and the document's title); page1Rows and series: [{label,title,line,highlight?:boolean}]; seriesHeading, seriesSub, footer2, bring, leaveWith, reach: strings; whyItWorks, partnerGets: string arrays.",
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
    const input = await samplesInputOf(env, deal, ev, JSON.parse(row.input_json) as SamplesWords, JSON.stringify(overrides));
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

/** The brand's words, read strictly: short, no digits, no money. Anything else is not used. */
export function wordsProblems(w: Partial<SamplesWords>): string[] {
  const out: string[] = [];
  for (const [k, max] of [["segmentTitle", 60], ["seriesTitle", 40], ["reach", 120]] as const) {
    const v = String(w[k] ?? "").trim();
    if (!v) out.push(`${k} is empty`);
    else if (v.length > max) out.push(`${k} is longer than ${max}`);
    else if (/\d/.test(v) || MONEY_WORDS.test(v)) out.push(`${k} carries a number or money`);
  }
  return out;
}

const fallbackWords = (brand: string): SamplesWords => ({
  segmentTitle: `Where ${brand} comes in`,
  seriesTitle: `The ${brand} evening`,
  reach: `the people ${brand} most wants to reach`,
});

/** Parker writes the brand's words from what we know of it; the plain fallback stands in when he cannot. */
async function writeWords(env: Env, deal: TlcDealRow, ev: TlcEventRow, theirText: string, research: string | null, deps: SamplesDeps): Promise<SamplesWords> {
  const brand = brandDisplayName(deal.brand);
  const prompt = [
    `You are Parker, who plans The Learning Club at West Peek Ventures. ${brand} said yes to seeing three samples for the club "${ev.topic ?? ""}".`,
    "Write ONLY the three phrases that change per brand on the approved template. Everything else is fixed.",
    `segment_title: the name of ${brand}'s 15-minute segment in the evening, tied to what ${brand} makes (at most 6 words${isAgentTopic(ev.topic ?? "") ? ', like "Giving your agent a memory"' : ""}).`,
    `series_title: the name of ${brand}'s own evening in a series of six (at most 5 words${isAgentTopic(ev.topic ?? "") ? ', like "Give it a memory"' : ""}).`,
    `reach: who the room is weighted toward for ${brand}, as types of people, never names (at most 14 words, like "founders and operators deciding what their teams build on").`,
    "No numbers, no prices, no names of people. Invent nothing about the brand.",
    "",
    `Why the brand fits: ${deal.why_fit ?? "(not recorded)"}`,
    ...(research ? ["What we found researching them:", research] : []),
    "Their message:",
    theirText,
    "",
    'Return ONLY JSON: {"segment_title":"","series_title":"","reach":""}',
  ].join("\n");
  const writer: SamplesWriter = deps.writer ?? (async (e, actor, p) => {
    const { run } = await runAi(e, {
      purpose: "The Learning Club: the brand's words on the three samples",
      actor,
      inputs: [p],
      sensitivity: "PUBLIC" as never,
      // Brand-facing: important work (Claude seat, then Codex, never a free lane).
      budgetContext: { requiresSearch: false, expectedOutputTokens: 300, judgement: true, important: true },
      routing: { category: "INTELLIGENCE" },
    } as never);
    return { ok: run.status === "COMPLETED" && Boolean(run.output_text), text: run.output_text ?? "" };
  });
  const out = await writer(env, parkerActor(deal.firm_scope), prompt).catch(() => ({ ok: false, text: "" }));
  if (out.ok) {
    try {
      const j = JSON.parse(/\{[\s\S]*\}/.exec(out.text)?.[0] ?? "") as Record<string, unknown>;
      const w = { segmentTitle: String(j.segment_title ?? "").trim(), seriesTitle: String(j.series_title ?? "").trim(), reach: String(j.reach ?? "").trim() };
      if (wordsProblems(w).length === 0) return w;
    } catch { /* the fallback stands in */ }
  }
  return fallbackWords(brand);
}

/** Plan a deal's samples ahead of time with the words given (her own, for a brand we expect to say yes). Sends nothing. */
export async function planSamples(env: Env, deal: TlcDealRow, words: SamplesWords): Promise<string> {
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
  const words: SamplesWords = row ? (JSON.parse(row.input_json) as SamplesWords) : await writeWords(env, deal, ev, ctx.theirText ?? "", ctx.research ?? null, deps);
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
