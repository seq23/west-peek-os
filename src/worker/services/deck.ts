import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { notifyPartners } from "./notifications";
import { uploadDocument } from "./documents";
import { renderDeckHtml, type DeckFigures } from "../../shared/deck/render";
import { PARTNERS } from "../../shared/registry/partners";
import { figuresFromDocs, type MandateDoc } from "../../shared/deck/figures";
import { runAi } from "../ai/runAi";
import { getDocument, getDocumentVersion } from "./documents";
import { createWorkCardInternal } from "./workCards";
import { blockCard } from "./blocks";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
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
  const mandateRow = await latestPolicy(env, "investment_mandate_version", "mandate_json", fundId);
  const sleeveRow = await latestPolicy(env, "sleeve_policy_version", "sleeve_json", fundId);
  const reserveRow = await latestPolicy(env, "reserve_policy_version", "reserve_json", fundId);
  const mandate = readDoc<MandateDoc>(mandateRow);
  const sleeve = readDoc<SleeveDoc>(sleeveRow);
  if (mandate.version === null && sleeve.version === null) {
    throw new DeckError(409, "no_records", "this fund carries no readable mandate or sleeve policy, so a deck built from it would have nothing behind its figures");
  }
  const origins = (
    await env.WP_OS_DB.prepare(
      "SELECT relationship_origin AS o, COUNT(*) AS n FROM investment_opportunity GROUP BY relationship_origin",
    ).all<{ o: string | null; n: number }>()
  ).results ?? [];
  const positions = Number(
    (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM position").first<{ n: number }>())?.n ?? 0,
  );
  // Every figure from the records, through the one builder the Mac render uses too.
  return figuresFromDocs({
    mandate: mandate.doc,
    sleeve: sleeve.doc,
    reserve: readDoc<ReserveDoc>(reserveRow).doc,
    origins,
    positionsHeld: positions,
    asOf: new Date(),
  });
}

/*
 * THE PDF-PER-CHANGE CHAIN IS GONE (26 Oct 2026). Until today a records move or a partner's
 * request rendered a whole PDF version (copy the current deck and repaint its figures, or render
 * the definition) and asked for a decision on it; v3–v18 were built that way and almost all were
 * sent back. The owner's design replaces it: a DECK PREVIEW the partners review and change by
 * replying, and ONE PDF on "approved". See services/deckPreview.ts. The functions that copied,
 * transcribed and re-rendered PDFs (carryCurrentDeck, copyDeckWithTweaks, buildDeckPdf,
 * runDeckRebuild, rebuildIfRecordsMoved) were removed rather than left uncalled.
 */
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
  // THE PREVIEW TAKES IT (26 Oct 2026). A version sent back is a change request on the deck
  // preview, not an order for another PDF; the PDF comes only from "approved".
  const card = await createWorkCardInternal(env, deckSystemIdentity(firmScope), {
    title: "Take this change to the LP deck preview",
    description: [
      `v${rejected.version_no} was sent back by ${rejectedBy} with this reason:`,
      "",
      reason,
      "",
      "Apply it to the deck preview and answer on the preview email. No PDF until a partner replies \"approved\".",
    ].join("\n"),
    next_action: "Apply it to the deck preview and reply on the preview email.",
    owner_type: "AI",
    owner_id: DECK_OWNER_ID,
    priority: "HIGH",
    firm_scope: firmScope,
    prompt: reason,
  });
  const asker = PARTNERS.find((p) => p.fullName === rejectedBy) ?? null;
  if (asker) await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2 WHERE id = ?1").bind(card.id, asker.email).run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = 'DECK_REWORK' WHERE id = ?1").bind(card.id).run();
  await appendEvent(env, {
    eventType: "deck_version.rework_requested",
    actorType: "system",
    actorId: "deck_review",
    objectType: "work_card",
    objectId: card.id,
    firmScope,
    payload: { rejected_version_id: rejected.id, version_no: rejected.version_no },
  });
  return { id: card.id };
}

/**
 * The sweep's runner for a DECK_REWORK card (a version sent back on Fund strategy): the reason she
 * typed becomes a change request on the DECK PREVIEW, exactly as if she had replied to the preview
 * email, and the card closes saying where to look. The preview's sweep applies it and answers on the
 * preview thread. No PDF is made here; only "approved" makes one.
 */
export const DECK_REWORK_STEPS: readonly string[] = [
  "Fold the partner's reason into the open deck preview as a change request (a new round if none is open).",
  "The preview's sweep applies it to the same preview and answers on the preview thread.",
  "No PDF is made until a partner replies \"approved\"; nothing is sent to a limited partner.",
];

export async function runDeckRework(
  env: Env,
  card: { id: string; title: string; firm_scope: string },
  interpret?: Interpreter,
): Promise<{ finished: boolean; blocked: boolean; detail: string }> {
  const row = await env.WP_OS_DB.prepare("SELECT description, prompt, requested_by_email FROM work_card WHERE id = ?1")
    .bind(card.id)
    .first<{ description: string | null; prompt: string | null; requested_by_email: string | null }>();
  const brief = (row?.prompt ?? row?.description ?? "").trim();
  const actor: Actor = { type: "SYSTEM", roles: [], firmScopes: [card.firm_scope] };
  /*
   * HER WORDS REACH A MODEL TWICE, ON PURPOSE. Here, to decide whether this chain can honour them
   * at all (a request for something no deck can do blocks the card and says which part); and on the
   * preview, where the editor applies them to the slides. The interpreted steer travels with her
   * words so the editor reads what the interpretation understood.
   */
  const steer = await steerFor(env, actor, {
    cardId: card.id,
    cardKind: "DECK_REWORK",
    title: card.title,
    employee: DECK_OWNER,
    chain: "applying a partner's change to the limited-partner deck preview",
    steps: [...DECK_REWORK_STEPS],
    firmScope: card.firm_scope,
    extra: brief ? [{ source: "BLOCK_ANSWER", text: brief, who: null }] : [],
  }, interpret);
  if (steer.cannot.length > 0) {
    const why = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee: DECK_OWNER,
      detail: steer.failure ? undefined : cannotDetail(DECK_OWNER, steer.cannot),
    });
    return { finished: false, blocked: true, detail: why };
  }
  const { startOrUpdatePreview, recordReply } = await import("./deckPreview");
  const { preview } = await startOrUpdatePreview(env, { reason: "A partner sent a deck version back", changes: [] });
  const partner = (row?.requested_by_email ?? "").trim() || PARTNERS[0]!.email;
  const said = [brief, steer.text ? `(Read as: ${steer.text.slice(0, 600)})` : ""].filter(Boolean).join("\n\n");
  if (said) await recordReply(env, preview.id, said, partner);
  const detail = `Folded into deck preview round ${preview.round_no} as a change request; Preston applies it there and replies on the preview email. Preview: https://os.joinwestpeek.com/api/deck/preview`;
  const existing = await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(card.id).first<{ description: string | null }>();
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = ?2, state = 'DONE', next_action = NULL WHERE id = ?1")
    .bind(card.id, `${existing?.description ? `${existing.description}\n` : ""}• ${DECK_OWNER}: ${detail}`.slice(0, 8000))
    .run();
  return { finished: true, blocked: false, detail };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

/** "The current deck is 0 days old" read as a bug on 15 Sep 2026; a deck added today is said so. */
function ageInWords(ageDays: number | null): string {
  if (ageDays === null) return "The current deck is on the record";
  if (ageDays <= 0) return "The current deck was added today";
  if (ageDays === 1) return "The current deck is a day old";
  return `The current deck is ${ageDays} days old`;
}

export async function theFund(env: Env): Promise<{ id: string; name: string }> {
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
                ? `${ageInWords(ageDays)} and every figure in it still matches the records.`
                : `${ageInWords(ageDays)} and ${drift.length} fund figure${drift.length === 1 ? " has" : "s have"} changed since it was built.`,
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
