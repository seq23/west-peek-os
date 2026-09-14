import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { notifyPartners } from "./notifications";
import { uploadDocument } from "./documents";
import { renderDeckHtml, type DeckFigures } from "../../shared/deck/render";
import { createWorkCardInternal } from "./workCards";
import type { FirmUserIdentity } from "../auth";
import {
  initialCapitalUsd, investableBase, reserveUsd, sleeveTargetUsd, usd,
  type ReserveDoc, type SleeveDoc,
} from "../../shared/fund/sleeveMath";

/**
 * The LP deck, inside the OS, with every version carrying the numbers it was built from.
 *
 * Operator, 9 Sep 2026: "we should have our deck displayed prominently in the OS and when we want to
 * make updates to it we can assign the same employee to do so and changes are tracked and the latest
 * edits and date and timestamps in the OS".
 *
 * WHAT WAS ACTUALLY MISSING. The deck existed in Canva and in a Downloads folder; the fund records
 * existed in D1; nothing joined them. That gap produced every discrepancy found on 9 Sep — the deck
 * says early stage is $21M, the OS held $17.0M against a $24.0M base, and nobody could say which was
 * derived from which because NO VERSION EVER RECORDED ITS OWN INPUTS. `records_snapshot_json` is the
 * whole point of this file; the viewer and the version list are what make it visible.
 *
 * THE DECK IS NEVER EMAILED, AND THE RULE GENERALISES — put here because this is where the next
 * person will look for it.
 *
 *   A DOCUMENT WITH A CURRENT VERSION LIVES IN THE OS AND IS LINKED.
 *   A SUMMARY THAT IS TRUE AT THE MOMENT IT IS WRITTEN CAN BE EMAILED.
 *
 * Operator, 9 Sep 2026: "i dont need the deck in an email at all just inside the OS". That is not a
 * preference about inboxes. An emailed PDF is a SECOND COPY THAT CAN DRIFT — somebody forwards the
 * attachment, the OS later renders v3, and two versions of an LP document exist with no way to tell
 * which is current. The entire value of this table is that there is one current deck and the system
 * knows which one; an email undoes it. So a new version raises a NOTICE that links here, and the
 * bytes never leave.
 *
 * The distinction, not a ban on email: a weekly relationship note or a monthly list is true when it
 * is written and has no later version to disagree with, so pushing it is right. A deck, a policy, a
 * report that gets superseded — those are linked, never attached.
 *
 * PROVENANCE IS A FIRST-CLASS FIELD. `UPLOADED` is a partner exporting from Canva; `BUILT` is an
 * employee rendering from records. They are different kinds of document and a reader should never
 * have to guess: only a BUILT version can promise its figures match the OS.
 */

/** Preston owns fund construction on the roster, so the deck's numbers are his. No new seat. */
export const DECK_OWNER = "Preston";

export class DeckError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

/**
 * Every fund figure a deck depends on, frozen.
 *
 * DERIVED FIGURES ARE STORED ALONGSIDE THE INPUTS, and that is not a contradiction of the rule that
 * one figure is stored and the other computed. That rule governs POLICY, which must never hold two
 * numbers that can drift. This is a SNAPSHOT — a photograph of what the arithmetic produced at a
 * moment — and its whole value is that it does not change when the policy does. Recomputing it later
 * would answer a different question from the one it exists to answer.
 */
export interface RecordsSnapshot {
  taken_at: string;
  fund_size_usd: number | null;
  estimated_fees_usd: number;
  estimated_expenses_usd: number;
  investable_base_usd: number;
  sleeves: Array<{ key: string; target_pct: number | null; derived_usd: number }>;
  reserve_pct: number | null;
  reserve_usd: number;
  initial_capital_usd: number;
  sectors: string[];
  target_positions: number | null;
  check_size_usd: { min: number | null; max: number | null };
  /** Which policy rows this was read from, so a snapshot can be traced to its sources. */
  policy_versions: { mandate: number | null; sleeve: number | null; reserve: number | null };
}

interface PolicyRow { version_no: number; doc: string }

async function latestPolicy(env: Env, table: string, column: string, fundId: string): Promise<PolicyRow | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT version_no, ${column} AS doc FROM ${table} WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1`,
  )
    .bind(fundId)
    .first<PolicyRow>();
  return row ?? null;
}

/** Parse, or treat the version as absent. An unreadable policy must not be read as an empty one. */
function readDoc<T>(row: PolicyRow | null): { doc: T; version: number | null } {
  if (!row) return { doc: {} as T, version: null };
  try {
    return { doc: JSON.parse(row.doc) as T, version: row.version_no };
  } catch {
    return { doc: {} as T, version: null };
  }
}

/**
 * Read the fund records as they stand right now.
 *
 * THROWS WHEN THERE IS NOTHING TO PHOTOGRAPH. A snapshot of a fund with no mandate and no sleeve
 * policy is an empty object wearing a timestamp, and storing one would let a deck version claim
 * provenance it does not have. The `NOT NULL` column and this throw are the same guard from two
 * directions.
 */
export async function takeRecordsSnapshot(env: Env, fundId: string): Promise<RecordsSnapshot> {
  const mandateRow = await latestPolicy(env, "investment_mandate_version", "mandate_json", fundId);
  const sleeveRow = await latestPolicy(env, "sleeve_policy_version", "sleeve_json", fundId);
  const reserveRow = await latestPolicy(env, "reserve_policy_version", "reserve_json", fundId);

  const mandate = readDoc<{
    target_size_usd?: number;
    sectors?: string[];
    target_positions?: number;
    check_size_usd?: { min?: number; max?: number };
  }>(mandateRow);
  const sleeve = readDoc<SleeveDoc>(sleeveRow);
  const reserve = readDoc<ReserveDoc>(reserveRow);

  if (mandate.version === null && sleeve.version === null) {
    throw new DeckError(
      409,
      "no_records",
      "this fund carries no readable mandate or sleeve policy, so a deck built from it would have nothing behind its figures",
    );
  }

  const base = investableBase(sleeve.doc);
  return {
    taken_at: new Date().toISOString(),
    fund_size_usd: mandate.doc.target_size_usd ?? null,
    estimated_fees_usd: sleeve.doc.estimated_fees_usd ?? 0,
    estimated_expenses_usd: sleeve.doc.estimated_expenses_usd ?? 0,
    investable_base_usd: base,
    sleeves: (sleeve.doc.sleeves ?? []).map((s) => ({
      key: s.key,
      target_pct: s.target_pct ?? null,
      derived_usd: sleeveTargetUsd(sleeve.doc, s),
    })),
    reserve_pct: reserve.doc.reserve_pct ?? null,
    reserve_usd: reserveUsd(sleeve.doc, reserve.doc),
    initial_capital_usd: initialCapitalUsd(sleeve.doc, reserve.doc),
    sectors: mandate.doc.sectors ?? [],
    target_positions: mandate.doc.target_positions ?? null,
    check_size_usd: { min: mandate.doc.check_size_usd?.min ?? null, max: mandate.doc.check_size_usd?.max ?? null },
    policy_versions: { mandate: mandate.version, sleeve: sleeve.version, reserve: reserve.version },
  };
}

export interface FigureDrift {
  field: string;
  was: string;
  now: string;
}

/**
 * What has moved in the records since a deck was built.
 *
 * THE LINE THE OPERATOR ASKED FOR — "this deck is N days old and M fund figures have changed since"
 * — is this function. It is cheap only because versions store their inputs; without the snapshot the
 * same question needs an archaeologist, which is precisely what 9 Sep required.
 *
 * Compares the FIGURES a reader would see on a slide, not the whole document, so a reworded note on
 * a policy does not report as a changed number.
 */
export function driftSince(snapshot: RecordsSnapshot, now: RecordsSnapshot): FigureDrift[] {
  const drift: FigureDrift[] = [];
  const money = (field: string, was: number | null, next: number | null) => {
    if (was === next) return;
    if (was === null || next === null) {
      drift.push({ field, was: was === null ? "not set" : usd(was), now: next === null ? "not set" : usd(next) });
      return;
    }
    if (Math.abs(was - next) >= 1) drift.push({ field, was: usd(was), now: usd(next) });
  };

  money("Fund size", snapshot.fund_size_usd, now.fund_size_usd);
  money("Investable base", snapshot.investable_base_usd, now.investable_base_usd);
  money("Reserves", snapshot.reserve_usd, now.reserve_usd);
  money("Capital for initial cheques", snapshot.initial_capital_usd, now.initial_capital_usd);

  const byKey = new Map(now.sleeves.map((s) => [s.key, s]));
  for (const was of snapshot.sleeves) {
    const next = byKey.get(was.key);
    if (!next) {
      drift.push({ field: `Sleeve ${was.key}`, was: usd(was.derived_usd), now: "removed" });
      continue;
    }
    money(`Sleeve ${was.key}`, was.derived_usd, next.derived_usd);
    if (was.target_pct !== next.target_pct) {
      drift.push({ field: `Sleeve ${was.key} share`, was: `${was.target_pct}%`, now: `${next.target_pct}%` });
    }
  }
  for (const next of now.sleeves) {
    if (!snapshot.sleeves.some((s) => s.key === next.key)) {
      drift.push({ field: `Sleeve ${next.key}`, was: "absent", now: usd(next.derived_usd) });
    }
  }

  if (snapshot.sectors.join("|") !== now.sectors.join("|")) {
    drift.push({ field: "Sector focus", was: snapshot.sectors.join(", ") || "none", now: now.sectors.join(", ") || "none" });
  }
  if (snapshot.target_positions !== now.target_positions) {
    drift.push({
      field: "Target positions",
      was: String(snapshot.target_positions ?? "not set"),
      now: String(now.target_positions ?? "not set"),
    });
  }
  const range = (c: RecordsSnapshot["check_size_usd"]) =>
    c.min === null && c.max === null ? "not set" : `${c.min === null ? "?" : usd(c.min)}–${c.max === null ? "?" : usd(c.max)}`;
  if (range(snapshot.check_size_usd) !== range(now.check_size_usd)) {
    drift.push({ field: "Cheque range", was: range(snapshot.check_size_usd), now: range(now.check_size_usd) });
  }
  if (snapshot.reserve_pct !== now.reserve_pct) {
    drift.push({ field: "Reserve share", was: `${snapshot.reserve_pct}%`, now: `${now.reserve_pct}%` });
  }
  return drift;
}

export interface DeckVersionRow {
  id: string;
  fund_id: string;
  version_no: number;
  title: string;
  origin: string;
  created_by: string;
  created_by_type: string;
  document_id: string | null;
  page_count: number | null;
  records_snapshot_json: string;
  change_summary: string | null;
  changed_fields_json: string;
  state: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  created_at: string;
}

export interface RecordDeckInput {
  fundId: string;
  title: string;
  origin: "BUILT" | "UPLOADED";
  createdBy: string;
  createdByType: "HUMAN" | "AI";
  pageCount?: number | null;
  /** The PDF. Optional only so a definition can be versioned before it renders. */
  pdfBase64?: string | null;
  changeSummary?: string | null;
}

/**
 * Record a new deck version. Never replaces one.
 *
 * The snapshot is taken HERE rather than accepted from the caller, so a version cannot be written
 * claiming inputs it did not have. The diff against the previous version is computed from the two
 * snapshots, which is the only way it can be trustworthy: prose about what changed is an assertion,
 * two snapshots subtracted is a measurement.
 */
export async function recordDeckVersion(env: Env, actor: Actor, input: RecordDeckInput): Promise<DeckVersionRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const snapshot = await takeRecordsSnapshot(env, input.fundId);

  const previous = await env.WP_OS_DB.prepare(
    "SELECT * FROM deck_version WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1",
  )
    .bind(input.fundId)
    .first<DeckVersionRow>();

  let changed: FigureDrift[] = [];
  if (previous) {
    try {
      changed = driftSince(JSON.parse(previous.records_snapshot_json) as RecordsSnapshot, snapshot);
    } catch {
      changed = [];
    }
  }

  let documentId: string | null = null;
  let pageCount = input.pageCount ?? null;
  if (input.pdfBase64) {
    const { document } = await uploadDocument(env, actor, {
      title: input.title,
      doc_type: "DECK",
      privacy_label: "INTERNAL",
      content_type: "application/pdf",
      content_base64: input.pdfBase64,
    });
    documentId = document.id;
  }

  const versionNo = (previous?.version_no ?? 0) + 1;
  const id = `dck_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO deck_version
       (id, fund_id, version_no, title, origin, created_by, created_by_type, document_id, page_count,
        records_snapshot_json, change_summary, changed_fields_json, state, firm_scope)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  )
    .bind(
      id, input.fundId, versionNo, input.title, input.origin, input.createdBy, input.createdByType,
      documentId, pageCount, JSON.stringify(snapshot),
      input.changeSummary ?? (previous ? summariseDrift(changed) : null),
      JSON.stringify(changed),
      /*
       * RECORDING A VERSION AND DECIDING IT IS THE ONE THAT GOES OUT ARE DIFFERENT ACTS, and every
       * version arrives PROPOSED whatever its provenance.
       *
       * THE DEFECT THIS REPLACES, 9 Sep 2026. An UPLOADED version used to insert as CURRENT and
       * supersede whatever was current before it, on the reasoning that an upload is "what the firm
       * actually sent". That reasoning is wrong in the one direction that matters: it makes the act
       * of RECORDING a file indistinguishable from the act of CHOOSING it, on the table holding the
       * document this firm shows limited partners.
       *
       * It cost exactly what you would expect. Preston's rebuild records a version and cannot attach
       * the PDF — the build script renders on the operator's Mac, not here — so the render was
       * uploaded to supply the file, and that upload silently displaced the operator's Canva deck as
       * the document the firm sends. A second upload, meant to push it back, made a third copy of a
       * PDF already on the record. Two junk rows and a wrong current deck, from a caller who was
       * only trying to attach a file. See migration 0155.
       *
       * The system already knew this for a BUILT version: Preston may write one and may not decide
       * it goes out. Uploads skipped the gate; now nothing skips it. A stray upload is a stray row.
       */
      "PROPOSED",
      firmScope,
    )
    .run();

  await appendEvent(env, {
    eventType: "deck_version.recorded",
    actorType: input.createdByType === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? input.createdBy,
    objectType: "deck_version",
    objectId: id,
    firmScope,
    payload: { version_no: versionNo, origin: input.origin, changed_fields: changed.length, page_count: pageCount },
  });

  return (await env.WP_OS_DB.prepare("SELECT * FROM deck_version WHERE id = ?1").bind(id).first<DeckVersionRow>())!;
}

/** Words for a list of moved figures, so a version list reads without opening anything. */
export function summariseDrift(drift: FigureDrift[]): string {
  if (drift.length === 0) return "No fund figure changed since the previous version.";
  const named = drift.slice(0, 3).map((d) => `${d.field} ${d.was} → ${d.now}`);
  const rest = drift.length - named.length;
  return `${drift.length} figure${drift.length === 1 ? "" : "s"} changed: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`;
}

/**
 * Preston's duty: rebuild the deck from the records and hand it to the partners.
 *
 * THIS IS WHAT MAKES IT ASSIGNABLE. Operator, 9 Sep 2026: "when we want to make updates to it we can
 * assign the same employee to do so". A command she has to run herself is not a duty, it is a
 * chore with a nicer name — and the whole point of the employee model is that she asks for the
 * outcome, not the steps.
 *
 * PRESTON, AND NOT A NEW SEAT. He owns `fund_construction_allocation` on the roster and he wrote the
 * discrepancy register that found the deck's construction table summing to $27M of a $30M fund.
 * Producing the deck is the obvious extension of auditing it, not a stretch of his charter.
 *
 * WHAT IT DOES NOT DO IS DECIDE. The render arrives PROPOSED and a human moves it to CURRENT: this
 * is the document the firm shows limited partners, and an employee may write one without being
 * allowed to choose that it goes out.
 *
 * THE PDF IS RENDERED ON HER MAC, not here. `scripts/deck/build.mjs` drives the Playwright Chromium
 * the e2e suite already installs, which costs nothing and works offline; the Browser Rendering
 * binding would bill a session for a document a human asked for once. So this duty records the
 * version and raises the notices, and the bytes are attached by the build script or by the upload
 * control on the Fund strategy page. A version with no PDF still carries its snapshot, which is the
 * part that makes the history worth having.
 */
/**
 * THE FIGURES A SLIDE PRINTS, from the records — the same derivation scripts/deck/build.mjs does
 * on the Mac, so a deck built here and one built there cannot disagree.
 */
export async function figuresFromRecords(env: Env, fundId: string): Promise<DeckFigures> {
  const snap = await takeRecordsSnapshot(env, fundId);
  const mandate = readDoc<{ management_fee_pct?: number; carried_interest_pct?: number }>(
    await latestPolicy(env, "investment_mandate_version", "mandate_json", fundId),
  );
  const early = snap.sleeves.find((x) => x.key === "EARLY_STAGE_PRIMARY") ?? null;
  const secondary = snap.sleeves.find((x) => x.key === "SECONDARY_PURCHASE") ?? null;
  const origins = (
    await env.WP_OS_DB.prepare(
      "SELECT relationship_origin AS o, COUNT(*) AS n FROM investment_opportunity GROUP BY relationship_origin",
    ).all<{ o: string | null; n: number }>()
  ).results ?? [];
  const totalOpps = origins.reduce((sum, r) => sum + Number(r.n), 0);
  const community = origins.filter((r) => r.o === "COMMUNITY_INTRO").reduce((sum, r) => sum + Number(r.n), 0);
  const positions = Number(
    (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM position").first<{ n: number }>())?.n ?? 0,
  );
  return {
    fund_size: snap.fund_size_usd,
    fees: snap.estimated_fees_usd || null,
    expenses: snap.estimated_expenses_usd || null,
    investable_base: snap.investable_base_usd || null,
    early_sleeve_usd: early?.derived_usd ?? null,
    early_sleeve_pct: early?.target_pct ?? null,
    secondary_sleeve_usd: secondary?.derived_usd ?? null,
    secondary_sleeve_pct: secondary?.target_pct ?? null,
    reserve_pct: snap.reserve_pct,
    mgmt_fee_pct: mandate.doc.management_fee_pct ?? null,
    carry_pct: mandate.doc.carried_interest_pct ?? null,
    reserve_usd: snap.reserve_usd || null,
    initial_capital_usd: snap.initial_capital_usd || null,
    target_positions: snap.target_positions,
    check_min: snap.check_size_usd.min,
    check_max: snap.check_size_usd.max,
    sectors: snap.sectors,
    community_sourced: totalOpps > 0 ? { through_community: community, total: totalOpps } : null,
    positions_held: positions,
    as_of_date: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
  };
}

/**
 * RENDER THE PDF HERE, IN THE WORKER. scripts/deck/build.mjs's own header says the Worker has a
 * Browser Rendering binding and could do this; it chose the Mac because a human was pressing the
 * button. Once the rebuild is Preston's card rather than a chore on her laptop, the render has to
 * happen where Preston works. Same HTML, same page size, same "fonts ready" wait as the script.
 *
 * Returns null, with the reason, where no browser is available (local dev, a test) — the version
 * is then recorded without a document and the summary says so in words, which is what the daily
 * job had been doing silently for five days.
 */
export async function buildDeckPdf(
  env: Env,
  fundId: string,
  launch?: (binding: unknown) => Promise<{ newPage(): Promise<any>; close(): Promise<void> }>,
): Promise<{ pdfBase64: string; pageCount: number } | { pdfBase64: null; reason: string }> {
  const binding = (env as unknown as { BROWSER?: unknown }).BROWSER;
  if (!launch && !binding) {
    return { pdfBase64: null, reason: "no browser is available here — the BROWSER binding is not configured" };
  }
  const figures = await figuresFromRecords(env, fundId);
  const html = renderDeckHtml(figures);
  let browser: { newPage(): Promise<any>; close(): Promise<void> } | null = null;
  try {
    const doLaunch =
      launch ??
      (async (b: unknown) => {
        const puppeteer = await import("@cloudflare/puppeteer");
        return (await puppeteer.launch(b as never)) as unknown as { newPage(): Promise<any>; close(): Promise<void> };
      });
    browser = await doLaunch(binding);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const bytes: Uint8Array = new Uint8Array(
      await page.pdf({
        width: "13.333in",
        height: "7.5in",
        printBackground: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      }),
    );
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const pageCount = (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return { pdfBase64: btoa(binary), pageCount };
  } catch (err) {
    return { pdfBase64: null, reason: `the browser could not render the deck: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export async function runDeckRebuild(
  env: Env,
  actor: Actor,
  input: { title?: string; pdfBase64?: string | null; brief?: string | null; launch?: Parameters<typeof buildDeckPdf>[2] } = {},
): Promise<{ version: DeckVersionRow; changed: number; rendered: boolean; renderNote: string | null }> {
  const fund = await theFund(env);
  // The PDF is built HERE unless the caller brought one (the Mac script does). A rebuild that
  // records a version with nothing behind it is the empty daily this replaces.
  let pdfBase64 = input.pdfBase64 ?? null;
  let pageCount: number | null = null;
  let renderNote: string | null = null;
  if (!pdfBase64) {
    const built = await buildDeckPdf(env, fund.id, input.launch);
    if (built.pdfBase64) {
      pdfBase64 = built.pdfBase64;
      pageCount = built.pageCount;
    } else {
      renderNote = "reason" in built ? built.reason : null;
    }
  }
  const version = await recordDeckVersion(env, actor, {
    fundId: fund.id,
    title: input.title ?? `${fund.name} — rebuilt from the records`,
    origin: "BUILT",
    createdBy: DECK_OWNER,
    createdByType: "AI",
    pdfBase64,
    pageCount,
    changeSummary: input.brief ? `Rebuilt on request: ${input.brief.slice(0, 400)}` : null,
  });
  // ONE PROPOSAL AT A TIME. Every older version still waiting on a decision is superseded by this
  // one, the way the operator did by hand for v6–v9 on 14 Sep — five identical proposals waiting
  // on five decisions about nothing is what a queue looks like when nobody closes it.
  await env.WP_OS_DB.prepare(
    "UPDATE deck_version SET state = 'REJECTED', rejected_reason = 'SUPERSEDED', approved_at = ?3 WHERE fund_id = ?1 AND id <> ?2 AND state = 'PROPOSED'",
  )
    .bind(fund.id, version.id, new Date().toISOString())
    .run();

  let changed: FigureDrift[] = [];
  try {
    changed = JSON.parse(version.changed_fields_json) as FigureDrift[];
  } catch {
    changed = [];
  }

  /*
   * EVERY EMPLOYEE REPORTS COMPLETION, and to BOTH partners — the deck is the firm's document and
   * Scooter's name is on it. `notifyPartners` addresses one notice per person from the role join, so
   * each gets their own row and quiet hours apply to both; a firm-wide notice would skip the
   * preference block entirely, which is the defect found in every all-clear this system had sent.
   *
   * INSIDE THE OS, NEVER EMAILED. See the rule at the top of this file: a document with a current
   * version is linked, not attached, or a forwarded copy drifts from the version the OS calls
   * current.
   */
  await notifyPartners(env, {
    kind: "MEETING",
    severity: "INFO",
    title: `${DECK_OWNER} has rebuilt the deck — v${version.version_no} is waiting on a decision`,
    body:
      changed.length === 0
        ? "No fund figure changed since the last version. Open it on Fund strategy to approve or send it back."
        : `${changed.length} figure${changed.length === 1 ? "" : "s"} changed: ` +
          `${changed.slice(0, 4).map((c) => `${c.field} ${c.was} → ${c.now}`).join("; ")}. ` +
          "Open it on Fund strategy to approve or send it back.",
    objectType: "deck_version",
    objectId: version.id,
    dedupeKey: `deck_rebuilt:${version.id}`,
    firmScope: actor.firmScopes[0] ?? "west-peek",
  });

  return { version, changed: changed.length, rendered: pdfBase64 !== null, renderNote };
}

// ── A rejection becomes Preston's card, and the card becomes the next version ────────────────

const DECK_OWNER_ID = "aie_preston";

function deckSystemIdentity(firmScope: string): FirmUserIdentity {
  return {
    id: "system:deck_review",
    email: "deck-review@joinwestpeek.com",
    fullName: "Deck review",
    status: "ACTIVE",
    roles: ["MANAGING_PARTNER"],
    authorityScopes: [{ scopeKey: "firm_scope", scopeValue: firmScope }],
  };
}

/**
 * SENDING A DECK BACK OPENS THE REWORK. Until 14 Sep 2026 a rejection wrote a row and an event and
 * stopped — "i rejected it but i need to know where to go to see he is working on it again", and
 * there was nowhere, because he was not. Now the reason she typed becomes the brief on a card
 * owned by Preston, kind DECK_REWORK, which the work sweep picks up within minutes and works by
 * building the next version. She sees it on Work (the card, then its completion note) and on Fund
 * strategy (the new version waiting on her decision). Sending THAT back opens another.
 *
 * Only a BUILT version opens a card: rejecting a version she uploaded herself is a correction of
 * her own record, not an instruction to Preston.
 */
export async function requestDeckRework(
  env: Env,
  rejected: DeckVersionRow,
  reason: string,
  rejectedBy: string,
): Promise<{ id: string } | null> {
  if (rejected.origin !== "BUILT") return null;
  const firmScope = (rejected as unknown as { firm_scope?: string }).firm_scope ?? "west-peek";
  const nextNo = rejected.version_no + 1;
  const card = await createWorkCardInternal(env, deckSystemIdentity(firmScope), {
    title: `Rebuild the LP deck as v${nextNo}`,
    description: [
      `v${rejected.version_no} was sent back by ${rejectedBy} with this reason:`,
      "",
      reason,
      "",
      "Pull from the current deck and the fund records, fix every discrepancy between them, and make it",
      "full and ready for limited partners. Every figure comes from the records; where the current deck",
      "disagrees with the records, the records win and the change is listed.",
    ].join("\n"),
    next_action: `Build v${nextNo} from the records and propose it on Fund strategy.`,
    owner_type: "AI",
    owner_id: DECK_OWNER_ID,
    priority: "HIGH",
    firm_scope: firmScope,
    prompt: reason,
  });
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'DECK_REWORK' WHERE id = ?1").bind(card.id).run();
  await appendEvent(env, {
    eventType: "deck_version.rework_requested",
    actorType: "system",
    actorId: "deck_review",
    objectType: "work_card",
    objectId: card.id,
    firmScope,
    payload: { rejected_version_id: rejected.id, version_no: rejected.version_no, next_version_no: nextNo },
  });
  return { id: card.id };
}

/**
 * The sweep's runner for a DECK_REWORK card: build the next version from the records, with the
 * card's brief as the change summary, close the card with a note that says where to look. If the
 * browser cannot render, the version is still recorded and the card says so — a partner then knows
 * exactly what is missing rather than finding an empty proposal.
 */
export async function runDeckRework(
  env: Env,
  card: { id: string; title: string; firm_scope: string },
  launch?: Parameters<typeof buildDeckPdf>[2],
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const row = await env.WP_OS_DB.prepare("SELECT description, prompt FROM work_card WHERE id = ?1")
    .bind(card.id)
    .first<{ description: string | null; prompt: string | null }>();
  const brief = row?.prompt ?? row?.description ?? null;
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] };
  const out = await runDeckRebuild(env, actor, { brief, launch });
  const drift = (() => {
    try {
      return JSON.parse(out.version.changed_fields_json) as FigureDrift[];
    } catch {
      return [] as FigureDrift[];
    }
  })();
  const detail = out.rendered
    ? `v${out.version.version_no} is proposed on Fund strategy, ${out.version.page_count ?? "?"} pages, built from the records. ` +
      (drift.length > 0
        ? `${drift.length} figure(s) differ from the last version: ${drift.slice(0, 5).map((d) => `${d.field} ${d.was} → ${d.now}`).join("; ")}.`
        : "No fund figure moved since the last version; the discrepancies were in the slides, not the records.") +
      " Approve it there, or send it back with what is still wrong and this card reopens as the next version."
    : `v${out.version.version_no} was recorded but NO PDF could be rendered: ${out.renderNote}. The version is on Fund strategy without a document.`;
  // Written onto the card the way every employee finding is (employeeWork.appendFinding): a note
  // row is a partner's steer and its author must be a firm user, which Preston is not.
  const existing = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(card.id).first<{ description: string | null }>();
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = ?2 WHERE id = ?1")
    .bind(card.id, `${existing?.description ? `${existing.description}\n` : ""}• ${DECK_OWNER}: ${detail}`.slice(0, 8000))
    .run();
  if (out.rendered) {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE', next_action = NULL WHERE id = ?1").bind(card.id).run();
    return { finished: true, blocked: false, detail };
  }
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1")
    .bind(card.id, `The deck could not be rendered: ${out.renderNote}`)
    .run();
  return { finished: false, blocked: true, detail };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

async function theFund(env: Env): Promise<{ id: string; name: string }> {
  const fund = await env.WP_OS_DB.prepare("SELECT id, name FROM fund LIMIT 1").first<{ id: string; name: string }>();
  if (!fund) throw new DeckError(404, "no_fund", "there is no fund to hold a deck");
  return fund;
}

/**
 * GET /api/deck — the current deck, its history, and whether the records have moved under it.
 *
 * The drift line is computed against the records AS THEY ARE NOW, on every read, so the page cannot
 * show a stale "up to date" badge. That is the whole lesson of the unread badge: a status derived
 * once at write time is wrong by the time somebody reads it.
 */
export async function handleGetDeck(ctx: RouteContext): Promise<Response> {
  try {
    const fund = await theFund(ctx.env);
    const rows = (
      await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM deck_version WHERE fund_id = ?1 ORDER BY version_no DESC",
      ).bind(fund.id).all<DeckVersionRow>()
    ).results ?? [];

    const current = rows.find((r) => r.state === "CURRENT") ?? null;
    let drift: FigureDrift[] = [];
    let ageDays: number | null = null;
    if (current) {
      const nowSnapshot = await takeRecordsSnapshot(ctx.env, fund.id);
      try {
        drift = driftSince(JSON.parse(current.records_snapshot_json) as RecordsSnapshot, nowSnapshot);
      } catch {
        drift = [];
      }
      ageDays = Math.floor((Date.now() - new Date(current.created_at).getTime()) / 86_400_000);
    }

    return json({
      fund: { id: fund.id, name: fund.name },
      current,
      versions: rows,
      /** "This deck is 11 days old and 3 fund figures have changed since." */
      staleness: current
        ? {
            age_days: ageDays,
            changed_since: drift,
            headline:
              drift.length === 0
                ? `The current deck is ${ageDays} day${ageDays === 1 ? "" : "s"} old and every figure in it still matches the records.`
                : `The current deck is ${ageDays} day${ageDays === 1 ? "" : "s"} old and ${drift.length} fund figure${drift.length === 1 ? " has" : "s have"} changed since it was built.`,
          }
        : null,
      note: current
        ? undefined
        : "No deck version has been recorded yet. Upload the current PDF to start the history — v1 is what LPs actually received, discrepancies and all — then approve it to make it the deck the firm sends.",
    });
  } catch (err) {
    if (err instanceof DeckError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

const uploadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content_base64: z.string().min(1),
  page_count: z.number().int().positive().optional(),
  change_summary: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/deck/versions — put a PDF on the record. It does NOT become the deck.
 *
 * The version lands PROPOSED and waits for a human on Fund strategy, the same gate a render from
 * Preston passes through. Uploading used to publish, and migration 0155 is what that cost.
 */
export async function handleUploadDeck(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "document.upload", { objectType: "deck_version", objectId: "new" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const parsed = uploadSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  try {
    const fund = await theFund(ctx.env);
    const row = await recordDeckVersion(ctx.env, actor, {
      fundId: fund.id,
      title: parsed.data.title,
      origin: "UPLOADED",
      createdBy: ctx.identity!.fullName,
      createdByType: "HUMAN",
      pageCount: parsed.data.page_count ?? null,
      pdfBase64: parsed.data.content_base64,
      changeSummary: parsed.data.change_summary ?? null,
    });
    return json({ version: row }, { status: 201 });
  } catch (err) {
    if (err instanceof DeckError) return json({ error: err.code, detail: err.message }, { status: err.status });
    throw err;
  }
}

const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().max(2000).optional(),
});

/**
 * POST /api/deck/versions/:id/decide — Approve, or Try Again.
 *
 * A HUMAN ACT, AND THE ONLY WAY A VERSION BECOMES CURRENT. This is the document the firm shows
 * limited partners; an employee may write one and may not decide it is the one that goes out, and
 * since 9 Sep 2026 neither may an upload. Every other path records a PROPOSED row and stops.
 *
 * APPROVE ALSO REINSTATES. A SUPERSEDED version can be made current again, and that is a narrow
 * mechanism built for a real hole rather than a convenience: before this, a version that was
 * superseded WRONGLY could not be restored by any code path at all — `handleDecideDeck` answered 409
 * to anything not PROPOSED, and the immutability trigger correctly refused everything else. On
 * 9 Sep the operator's own Canva deck was superseded by a stray upload and putting it back took a
 * migration. A firm should not need a schema change to say "that one, the one we already had".
 *
 * WHAT REINSTATEMENT IS NOT. It is not an edit — nothing about the version changes but the approval
 * decision, which is the one thing the trigger has always permitted to move. It is not available to
 * an employee: the human check above governs it identically. And it is refused for a REJECTED
 * version, because a row struck off as wrong is not quietly promoted back into the firm's history;
 * if a rejection was itself a mistake, record the document again and decide on that.
 */
export async function handleDecideDeck(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json({ error: "forbidden", detail: "approving what goes to an LP is a human act" }, { status: 403 });
  }
  const parsed = decisionSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM deck_version WHERE id = ?1")
    .bind(ctx.params.id!)
    .first<DeckVersionRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });

  const reinstating = parsed.data.decision === "APPROVE" && row.state === "SUPERSEDED";
  const allowed = row.state === "PROPOSED" || reinstating;
  if (!allowed) {
    return json(
      {
        error: "conflict",
        detail:
          row.state === "CURRENT"
            ? "this version is already the current deck"
            : row.state === "REJECTED"
              ? "this version was struck off as wrong and is not promoted back; record the document again and decide on that"
              : `this version is ${row.state}, not awaiting a decision`,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  if (parsed.data.decision === "APPROVE") {
    await ctx.env.WP_OS_DB.prepare(
      "UPDATE deck_version SET state = 'SUPERSEDED' WHERE fund_id = ?1 AND id <> ?2 AND state = 'CURRENT'",
    ).bind(row.fund_id, row.id).run();
    await ctx.env.WP_OS_DB.prepare(
      "UPDATE deck_version SET state = 'CURRENT', approved_by = ?2, approved_at = ?3 WHERE id = ?1",
    ).bind(row.id, ctx.identity!.id, now).run();
  } else {
    await ctx.env.WP_OS_DB.prepare(
      "UPDATE deck_version SET state = 'REJECTED', rejected_reason = ?2, approved_by = ?3, approved_at = ?4 WHERE id = ?1",
    ).bind(row.id, parsed.data.reason ?? "No reason given.", ctx.identity!.id, now).run();
    // The rejection is an assignment. See requestDeckRework.
    await requestDeckRework(ctx.env, row, parsed.data.reason ?? "No reason given.", ctx.identity!.fullName);
  }

  await appendEvent(ctx.env, {
    eventType:
      parsed.data.decision === "REJECT"
        ? "deck_version.rejected"
        : reinstating
          ? "deck_version.reinstated"
          : "deck_version.approved",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "deck_version",
    objectId: row.id,
    payload: { version_no: row.version_no, reason: parsed.data.reason ?? null, from_state: row.state },
  });

  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM deck_version WHERE id = ?1").bind(row.id).first());
}
