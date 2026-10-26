import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import type { EmailAttachment } from "../effects/emailTransport";
import { pdfPageCount, renderHtmlPdf, type PdfRenderer } from "../effects/htmlPdf";
import { MONEY_WORDS } from "../../shared/tlc/brandReply";
import { brandDisplayName } from "../../shared/tlc/learningClub";
import { COMMUNITY_MIX_SETTING, isAgentTopic, readMix, renderSamplesPdf, samplesProblems, type SamplesInput } from "../../shared/tlc/samples";
import type { Actor } from "./authorize";
import type { TlcDealRow, TlcEventRow } from "./learningClub";

/**
 * PARKER BUILDS THE THREE SAMPLES (owner, 26 Oct 2026): one 3-page PDF per deal from the approved template
 * (shared/tlc/samples.ts). Only the brand's words change: its name, the month, its 15-minute segment, its evening in
 * the series of six and who the room is weighted toward. Those words are either stored ahead of time (a PLANNED
 * row, pre-built for a brand we expect to say yes) or written by Parker when the yes arrives, from what we know of
 * the brand; they carry no number and no price. The PDF lives in R2 and is attached to her approval email and, on
 * her "approved", to the email that goes to the brand. Nothing here sends anything.
 */
export interface SamplesRow {
  id: string; deal_id: string; input_json: string; state: string; pdf_r2_key: string | null; pdf_name: string | null; problem: string | null; firm_scope: string;
}
export type SamplesWords = Pick<SamplesInput, "segmentTitle" | "seriesTitle" | "reach">;
export type SamplesWriter = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string }>;
export interface SamplesDeps { renderPdf?: PdfRenderer; writer?: SamplesWriter }

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

/** The samples for a deal, built now if they are not ready. Never throws: the row says why when it could not. */
export async function buildSamples(
  env: Env, deal: TlcDealRow, ev: TlcEventRow, ctx: { theirText?: string; research?: string | null } = {}, deps: SamplesDeps = {},
): Promise<{ ok: true; row: SamplesRow } | { ok: false; id: string; detail: string }> {
  let row = await samplesForDeal(env, deal.id);
  if (row && (row.state === "READY" || row.state === "SENT") && row.pdf_r2_key) return { ok: true, row };
  const words: SamplesWords = row ? (JSON.parse(row.input_json) as SamplesWords) : await writeWords(env, deal, ev, ctx.theirText ?? "", ctx.research ?? null, deps);
  const id = row?.id ?? `tls_${crypto.randomUUID()}`;
  if (!row) {
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_samples (id, deal_id, input_json, state, firm_scope) VALUES (?1, ?2, ?3, 'PLANNED', ?4)").bind(id, deal.id, JSON.stringify(words), deal.firm_scope).run();
  }
  const mixRaw = (await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(COMMUNITY_MIX_SETTING).first<{ value: string | null }>())?.value ?? null;
  const input: SamplesInput = {
    brand: brandDisplayName(deal.brand), topic: ev.topic ?? "", month: ev.month,
    // A club not yet at its go-check is tentative ("could move, or repeat"), and the PDF says so.
    tentative: !["GO", "DONE"].includes(String((ev as { status?: string }).status ?? "")),
    ...words, mix: readMix(mixRaw),
  };
  const html = renderSamplesPdf(input);
  const fail = async (detail: string) => {
    await env.WP_OS_DB.prepare("UPDATE tlc_samples SET state = 'FAILED', problem = ?2 WHERE id = ?1 AND state != 'SENT'").bind(id, detail.slice(0, 300)).run();
    return { ok: false as const, id, detail };
  };
  const problems = samplesProblems(html, input.mix);
  if (problems.length) return fail(`the samples broke a rule: ${problems.join("; ")}`);
  const pdf = await (deps.renderPdf ?? ((h: string) => renderHtmlPdf(env, h)))(html);
  if (pdf.pdfBase64 === null) return fail(`the PDF could not be rendered: ${pdf.reason}`);
  const bytes = Uint8Array.from(atob(pdf.pdfBase64), (c) => c.charCodeAt(0));
  const pages = pdf.pageCount || pdfPageCount(bytes);
  if (pages !== 3) return fail(`the PDF ran to ${pages} pages, not 3`);
  if (!env.WP_OS_DOCUMENTS) return fail("no document store to keep the PDF in");
  const key = `tlc-samples/${deal.id}/${id}.pdf`;
  await env.WP_OS_DOCUMENTS.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const name = `The Learning Club - ${input.topic.replace(/[^\w &-]+/g, "").trim()} - ${input.brand.replace(/[^\w &-]+/g, "").trim()}.pdf`;
  await env.WP_OS_DB.prepare("UPDATE tlc_samples SET state = 'READY', pdf_r2_key = ?2, pdf_name = ?3, problem = NULL, built_at = ?4 WHERE id = ?1").bind(id, key, name, new Date().toISOString()).run();
  await appendEvent(env, { eventType: "tlc.samples_built", actorType: "ai_employee", actorId: PARKER, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { samples_id: id, pages } });
  row = (await samplesForDeal(env, deal.id))!;
  return { ok: true, row };
}

/** The PDF as an email attachment, or null when it is not in the store. */
export async function samplesAttachment(env: Env, samplesId: string): Promise<EmailAttachment | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM tlc_samples WHERE id = ?1").bind(samplesId).first<SamplesRow>();
  if (!row?.pdf_r2_key || !env.WP_OS_DOCUMENTS) return null;
  const obj = await env.WP_OS_DOCUMENTS.get(row.pdf_r2_key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { filename: row.pdf_name ?? "The Learning Club.pdf", content: btoa(bin), contentType: "application/pdf" };
}

/** Each pass: samples planned ahead of time are rendered, so they are ready the moment the brand says yes. */
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
