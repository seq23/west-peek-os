import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { authorize, canAccessPrivacyLabel, type Actor } from "./authorize";
import { getEvidenceSummary } from "./evidence";
import { notify } from "./notifications";
import { meetingType, MEETING_TYPES } from "../../shared/meetings/meetingTypes";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { CLOSING_SIX, sectionsFor, type Sector } from "../../shared/ic/diligenceFramework";

/**
 * The BEFORE face of a meeting: the brief (Phase B, owner-approved 18 Sep 2026).
 *
 * For EVERY meeting type, assembled the night before by the type's lead employee
 * (meetingTypes.ts `suggests[0]`), and readable on the record the moment it exists:
 *
 *   WHY        one line on why this meeting exists. Written by the lead employee through run_ai;
 *              if the line cannot be written, the brief SAYS SO in that slot rather than leaving it
 *              blank or inventing one.
 *   FIND OUT   open questions carried forward — every OPEN meeting_open_question raised in an
 *              earlier meeting with the same company or LP.
 *   LAST TIME  what both sides said they would do in earlier meetings with the same company or LP,
 *              and whether it was delivered on.
 *   THE RECORD the company or LP: what it is, where the deal stands, the last three things that
 *              happened to it on the event spine.
 *   DILIGENCE  for FOUNDER and DILIGENCE meetings with a company: the framework's sections marked
 *              answered / not applicable / open against the deal's IC packet, plus the Closing Six.
 *
 * GENERALISED FROM P7's `prep`, NOT DUPLICATED. `meeting_prep_packet` was the IC-shaped prep —
 * evidence summary, contradictions, open questions. The same row now carries the whole brief, and
 * `POST /api/meetings/:id/prep` builds it; the old columns are still filled so a reader of them
 * sees what they always saw.
 *
 * THE COVERAGE BLOCK IS THE POINT, and it is meetingPrep.ts's rule applied here: an EMPTY brief is
 * a legitimate output ("nothing is owed either way — 0 prior meetings examined") and a brief that
 * could not build is a FAILURE that says so. On a screen they look identical unless the brief
 * carries what it examined, so every brief does, and a build that could read NOTHING throws rather
 * than handing over a confident blank.
 */

export class MeetingBriefError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

interface MeetingRow {
  id: string;
  title: string;
  meeting_type: string;
  status: string;
  scheduled_at: string | null;
  occurred_at: string | null;
  company_id: string | null;
  lp_record_id: string | null;
  privacy_label: string;
  firm_scope: string;
  created_by: string;
  archived_at: string | null;
}

export interface BriefLine {
  text: string;
  sourceType: string;
  sourceId: string;
}

export interface BriefCommitmentLine extends BriefLine {
  owner_side: "FIRM" | "COUNTERPARTY";
  owed_by: string | null;
  due_date: string | null;
  /** OPEN, OVERDUE, DELIVERED, or CONVERTED (a work card carries it). */
  standing: "OPEN" | "OVERDUE" | "DELIVERED" | "CONVERTED" | "DROPPED";
  meeting_title: string;
}

export interface DiligenceCoverage {
  sector: string | null;
  packet_id: string | null;
  sections: Array<{ id: string; title: string; mandatory: boolean; state: "ANSWERED" | "NOT_APPLICABLE" | "OPEN"; killer: string | null }>;
  closing_six: Array<{ n: number; question: string; state: "ANSWERED" | "NOT_APPLICABLE" | "OPEN" }>;
  answered: number;
  unanswered: number;
}

export interface MeetingBrief {
  meeting_id: string;
  meeting_type: string;
  prepared_by: string;
  /** The one line, or null with `why_unavailable` saying why the slot is empty. */
  why: string | null;
  why_unavailable: string | null;
  find_out: BriefLine[];
  last_time: { firm: BriefCommitmentLine[]; counterparty: BriefCommitmentLine[] };
  record: {
    about: "COMPANY" | "LP" | "NOBODY";
    name: string | null;
    summary: string | null;
    stage: string | null;
    touches: BriefLine[];
  };
  diligence: DiligenceCoverage | null;
  coverage: Array<{ source: string; rowsRead: number }>;
  unreadable: string[];
  body: string;
}

/**
 * Read a list, and say how much of it there was — meetingPrep.ts's `readSource`, the same rule:
 * a throw is not a zero. A source that cannot be read reaches the brief as unreadable, never as
 * "nothing there".
 */
async function readSource<T>(
  env: Env,
  name: string,
  sql: string,
  binds: unknown[],
  coverage: Array<{ source: string; rowsRead: number }>,
  unreadable: string[],
): Promise<T[]> {
  try {
    const res = await env.WP_OS_DB.prepare(sql).bind(...binds).all<T>();
    const rows = res.results ?? [];
    coverage.push({ source: name, rowsRead: rows.length });
    return rows;
  } catch {
    unreadable.push(name);
    return [];
  }
}

async function requireMeeting(env: Env, meetingId: string): Promise<MeetingRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT id, title, meeting_type, status, scheduled_at, occurred_at, company_id, lp_record_id, privacy_label, firm_scope, created_by, archived_at FROM meeting WHERE id = ?1",
  )
    .bind(meetingId)
    .first<MeetingRow>();
  if (!row) throw new MeetingBriefError(404, "not_found", "meeting not found");
  return row;
}

/** The type's lead employee, by name. Every type names at least one; the test pins it. */
export function leadNameFor(meetingTypeKey: string): string {
  return meetingType(meetingTypeKey)?.suggests[0] ?? MEETING_TYPES[0]!.suggests[0]!;
}

/**
 * Build the brief. Deterministic — reads the records and never calls a model — and exported so
 * the tests can build one against a known database. `why` is left null here; `writeWhyLine` fills
 * it, because the one thing a model writes is kept apart from the many things the records say.
 *
 * Throws when NOTHING could be read (coverage empty), which is the one case where handing over a
 * document would be worse than handing over none.
 */
export async function buildMeetingBrief(env: Env, meetingId: string, now: Date = new Date()): Promise<MeetingBrief> {
  const meeting = await requireMeeting(env, meetingId);
  const coverage: Array<{ source: string; rowsRead: number }> = [];
  const unreadable: string[] = [];
  const today = now.toISOString().slice(0, 10);

  // The "same company or LP" clause — the join every carried-forward item follows.
  const sameParty = meeting.company_id
    ? { clause: "m.company_id = ?2", bind: meeting.company_id }
    : meeting.lp_record_id
      ? { clause: "m.lp_record_id = ?2", bind: meeting.lp_record_id }
      : null;

  // ── FIND OUT: open questions carried forward ──
  const carried = sameParty
    ? await readSource<{ id: string; question: string; owed_by_kind: string; owed_by: string | null; meeting_title: string }>(
        env,
        "open questions from earlier meetings with the same company or LP",
        `SELECT q.id, q.question, q.owed_by_kind, q.owed_by, m.title AS meeting_title
           FROM meeting_open_question q JOIN meeting m ON m.id = q.meeting_id
          WHERE q.state = 'OPEN' AND q.meeting_id <> ?1 AND m.archived_at IS NULL AND ${sameParty.clause}
          ORDER BY q.created_at`,
        [meetingId, sameParty.bind],
        coverage,
        unreadable,
      )
    : (coverage.push({ source: "open questions from earlier meetings (no company or LP on this meeting)", rowsRead: 0 }), []);

  const find_out: BriefLine[] = carried.map((q) => ({
    text: `${q.question}${q.owed_by ? ` — ${q.owed_by}` : q.owed_by_kind !== "UNASSIGNED" ? ` — ${q.owed_by_kind.toLowerCase().replace("_", " ")}` : ""} (from "${q.meeting_title}")`,
    sourceType: "meeting_open_question",
    sourceId: q.id,
  }));

  // ── LAST TIME: both sides' commitments from earlier meetings with the same company or LP ──
  interface CommitmentRow {
    id: string; commitment_text: string; owner_side: "FIRM" | "COUNTERPARTY"; owed_by: string | null; due_date: string | null;
    status: string; honoured_at: string | null; work_card_id: string | null; meeting_title: string;
  }
  const prior = sameParty
    ? await readSource<CommitmentRow>(
        env,
        "commitments from earlier meetings with the same company or LP",
        `SELECT c.id, c.commitment_text, c.owner_side, c.owed_by, c.due_date, c.status, c.honoured_at, c.work_card_id, m.title AS meeting_title
           FROM meeting_commitment c JOIN meeting m ON m.id = c.meeting_id
          WHERE c.meeting_id <> ?1 AND m.archived_at IS NULL AND ${sameParty.clause}
          ORDER BY c.created_at`,
        [meetingId, sameParty.bind],
        coverage,
        unreadable,
      )
    : (coverage.push({ source: "commitments from earlier meetings (no company or LP on this meeting)", rowsRead: 0 }), []);

  const standingOf = (c: CommitmentRow): BriefCommitmentLine["standing"] => {
    if (c.honoured_at) return "DELIVERED";
    if (c.status === "DROPPED") return "DROPPED";
    if (c.status === "CONVERTED") return "CONVERTED";
    if (c.due_date && c.due_date.slice(0, 10) < today) return "OVERDUE";
    return "OPEN";
  };
  const asLine = (c: CommitmentRow): BriefCommitmentLine => ({
    text: c.commitment_text,
    sourceType: "meeting_commitment",
    sourceId: c.id,
    owner_side: c.owner_side,
    owed_by: c.owed_by,
    due_date: c.due_date,
    standing: standingOf(c),
    meeting_title: c.meeting_title,
  });
  const last_time = {
    firm: prior.filter((c) => c.owner_side === "FIRM").map(asLine),
    counterparty: prior.filter((c) => c.owner_side === "COUNTERPARTY").map(asLine),
  };

  // ── THE RECORD ──
  const record: MeetingBrief["record"] = { about: "NOBODY", name: null, summary: null, stage: null, touches: [] };
  if (meeting.company_id) {
    const companies = await readSource<{ id: string; canonical_name: string; description: string | null; sector: string | null }>(
      env, "the company record",
      "SELECT id, canonical_name, description, sector FROM canonical_company WHERE id = ?1",
      [meeting.company_id], coverage, unreadable,
    );
    const company = companies[0] ?? null;
    const opps = await readSource<{ id: string; title: string; status: string }>(
      env, "the company's deals",
      "SELECT id, title, status FROM investment_opportunity WHERE company_id = ?1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 3",
      [meeting.company_id], coverage, unreadable,
    );
    const positions = await readSource<{ n: number }>(
      env, "the fund's position in it",
      "SELECT COUNT(*) AS n FROM position WHERE company_id = ?1",
      [meeting.company_id], coverage, unreadable,
    );
    const held = Number(positions[0]?.n ?? 0) > 0;
    record.about = "COMPANY";
    record.name = company?.canonical_name ?? meeting.company_id;
    record.summary = company?.description ?? null;
    record.stage =
      opps.length > 0
        ? `${opps[0]!.title}: ${opps[0]!.status}${opps.length > 1 ? ` (+${opps.length - 1} other deal${opps.length > 2 ? "s" : ""})` : ""}${held ? " · in the portfolio" : ""}`
        : held
          ? "in the portfolio, no live deal"
          : "no deal on the board";
  } else if (meeting.lp_record_id) {
    const lps = await readSource<{ id: string; legal_name: string; lp_type: string; status: string; state: string | null; next_step: string | null }>(
      env, "the LP record",
      `SELECT r.id, r.legal_name, r.lp_type, r.status, e.state, e.next_step
         FROM lp_record r LEFT JOIN lp_engagement e ON e.lp_record_id = r.id WHERE r.id = ?1`,
      [meeting.lp_record_id], coverage, unreadable,
    );
    const lp = lps[0] ?? null;
    record.about = "LP";
    record.name = lp?.legal_name ?? meeting.lp_record_id;
    record.summary = lp ? `${lp.lp_type.toLowerCase().replace(/_/g, " ")} · ${lp.status.toLowerCase()}` : null;
    record.stage = lp?.state ? `${lp.state.toLowerCase().replace(/_/g, " ")}${lp.next_step ? ` — next: ${lp.next_step}` : ""}` : null;
  } else {
    coverage.push({ source: "the record (this meeting is about neither a company nor an LP)", rowsRead: 0 });
  }

  const touchObject = meeting.company_id
    ? { type: "canonical_company", id: meeting.company_id }
    : meeting.lp_record_id
      ? { type: "lp_record", id: meeting.lp_record_id }
      : null;
  if (touchObject) {
    const touches = await readSource<{ id: string; event_type: string; created_at: string; actor_id: string }>(
      env, "the last three things that happened to it",
      "SELECT id, event_type, created_at, actor_id FROM event_record WHERE object_type = ?1 AND object_id = ?2 ORDER BY created_at DESC LIMIT 3",
      [touchObject.type, touchObject.id], coverage, unreadable,
    );
    record.touches = touches.map((t) => ({
      text: `${t.created_at.slice(0, 10)} · ${t.event_type.replace(/[._]/g, " ")} (${t.actor_id})`,
      sourceType: "event_record",
      sourceId: t.id,
    }));
  }

  // ── DILIGENCE: FOUNDER and DILIGENCE meetings with a company ──
  let diligence: DiligenceCoverage | null = null;
  if ((meeting.meeting_type === "FOUNDER" || meeting.meeting_type === "DILIGENCE") && meeting.company_id) {
    const sectorRow = await env.WP_OS_DB.prepare("SELECT sector FROM canonical_company WHERE id = ?1").bind(meeting.company_id).first<{ sector: string | null }>().catch(() => null);
    const sector = (sectorRow?.sector ?? null) as Sector | null;
    const { core, sector: module } = sectionsFor(sector ?? "OTHER");
    const packets = await readSource<{ id: string }>(
      env, "the deal's IC packet",
      `SELECT p.id FROM ic_packet p JOIN investment_opportunity o ON o.id = p.opportunity_id
        WHERE o.company_id = ?1 ORDER BY p.created_at DESC LIMIT 1`,
      [meeting.company_id], coverage, unreadable,
    );
    const packetId = packets[0]?.id ?? null;
    const answers = packetId
      ? await readSource<{ section_id: string; state: "OPEN" | "ANSWERED" | "NOT_APPLICABLE" }>(
          env, "diligence answers on that packet",
          "SELECT section_id, state FROM ic_diligence_answer WHERE ic_packet_id = ?1",
          [packetId], coverage, unreadable,
        )
      : (coverage.push({ source: "diligence answers (no IC packet exists yet)", rowsRead: 0 }), []);
    const stateOf = new Map(answers.map((a) => [a.section_id, a.state]));
    const sections = core.map((s) => ({
      id: s.id as string,
      title: s.title,
      mandatory: s.mandatory,
      state: stateOf.get(s.id) ?? "OPEN",
      killer: s.killer ?? null,
    }));
    // The sector module is one section on top of the core, keyed exactly as icPortal.ts keys its
    // answer row (`sector_<lowercase>`), so answered here means answered there.
    if (module) {
      sections.push({
        id: `sector_${module.sector.toLowerCase()}`,
        title: module.title,
        mandatory: false,
        state: stateOf.get(`sector_${module.sector.toLowerCase()}`) ?? "OPEN",
        killer: module.killer ?? null,
      });
    }
    const closing_six = CLOSING_SIX.map((c) => ({ n: c.n, question: c.question, state: stateOf.get(`closing_${c.n}`) ?? "OPEN" }));
    const all = [...sections.map((s) => s.state), ...closing_six.map((c) => c.state)];
    diligence = {
      sector,
      packet_id: packetId,
      sections,
      closing_six,
      answered: all.filter((s) => s !== "OPEN").length,
      unanswered: all.filter((s) => s === "OPEN").length,
    };
  }

  if (coverage.length === 0) {
    throw new Error(`could not read any source for meeting ${meetingId}: ${unreadable.join(", ")}`);
  }

  const prepared_by = leadNameFor(meeting.meeting_type);
  const brief: MeetingBrief = {
    meeting_id: meetingId,
    meeting_type: meeting.meeting_type,
    prepared_by,
    why: null,
    why_unavailable: "not yet written",
    find_out,
    last_time,
    record,
    diligence,
    coverage,
    unreadable,
    body: "",
  };
  brief.body = renderBrief(meeting, brief);
  return brief;
}

/**
 * The one line a model writes. Everything else in the brief is read off the records; this is the
 * one thing that needs judgement, so it is the one thing that goes through run_ai — in the voice of
 * the type's lead employee, on the meeting's own label, and (for an LP conversation) declared
 * confidential so the router keeps it off any training-permitting lane.
 *
 * Returns the line, or the reason there is none. Never a made-up line: on any failure the brief's
 * `why` slot says plainly that it could not be written.
 */
export async function writeWhyLine(env: Env, actor: Actor, meeting: MeetingRow, brief: MeetingBrief): Promise<{ why: string | null; unavailable: string | null; ai_run_id: string | null }> {
  const lead = brief.prepared_by;
  const roster = await env.WP_OS_DB.prepare("SELECT id, role FROM ai_employee WHERE name = ?1").bind(lead).first<{ id: string; role: string }>();
  const facts = [
    `MEETING: ${meeting.title} (${meeting.meeting_type})${meeting.scheduled_at ? `, ${meeting.scheduled_at.slice(0, 16).replace("T", " ")}Z` : ""}`,
    `ABOUT: ${brief.record.about === "NOBODY" ? "nobody in particular (internal)" : `${brief.record.name}${brief.record.stage ? ` — ${brief.record.stage}` : ""}`}`,
    `OPEN QUESTIONS CARRIED FORWARD: ${brief.find_out.length}`,
    `WE STILL OWE THEM: ${brief.last_time.firm.filter((c) => c.standing === "OPEN" || c.standing === "OVERDUE").length}`,
    `THEY STILL OWE US: ${brief.last_time.counterparty.filter((c) => c.standing === "OPEN" || c.standing === "OVERDUE").length}`,
    brief.diligence ? `DILIGENCE: ${brief.diligence.answered} answered, ${brief.diligence.unanswered} open` : null,
  ].filter((l): l is string => l !== null);
  try {
    const { run } = await runAi(env, {
      purpose: `meeting brief: why this meeting exists (${meeting.id})`,
      actor,
      aiEmployeeId: roster?.id ?? undefined,
      inputs: [
        personaPrompt(lead, roster?.role ?? "Meeting Buddy"),
        "",
        "Write ONE sentence, under 30 words, saying why this meeting exists — what the firm should get out of it. Use only the facts below. If the facts do not say, answer exactly: UNKNOWN",
        "",
        ...facts,
      ],
      sensitivity: meeting.privacy_label as never,
      budgetContext: {
        judgement: true,
        expectedOutputTokens: 80,
        confidential: meeting.meeting_type === "LP" || meeting.lp_record_id !== null,
      },
      routing: { category: "INTELLIGENCE" },
    });
    const text = (run.output_text ?? "").trim().split("\n")[0]?.trim() ?? "";
    if (run.status !== "COMPLETED" || !text) return { why: null, unavailable: `${lead} could not write the line (run ${run.status}).`, ai_run_id: run.id };
    if (/^unknown\b/i.test(text)) return { why: null, unavailable: `${lead} could not say from the records why this meeting exists.`, ai_run_id: run.id };
    if (text.length > 240 || /^\[mock-local/.test(text)) return { why: null, unavailable: `${lead} did not return a usable one-line reason.`, ai_run_id: run.id };
    return { why: text, unavailable: null, ai_run_id: run.id };
  } catch (err) {
    return { why: null, unavailable: `The line could not be written: ${err instanceof Error ? err.message : String(err)}`, ai_run_id: null };
  }
}

function standingWord(s: BriefCommitmentLine["standing"]): string {
  switch (s) {
    case "OPEN": return "still open";
    case "OVERDUE": return "OVERDUE";
    case "DELIVERED": return "delivered";
    case "CONVERTED": return "on a work card";
    case "DROPPED": return "dropped";
  }
}

/**
 * The brief as somebody reads it. The empty state of every section is WRITTEN OUT, and the
 * coverage block at the foot is what makes an empty section a fact rather than a blank.
 */
export function renderBrief(meeting: Pick<MeetingRow, "title" | "meeting_type" | "scheduled_at">, b: MeetingBrief): string {
  const type = meetingType(meeting.meeting_type);
  const lines: string[] = [];
  lines.push(`# Before: ${meeting.title}`);
  lines.push("");
  lines.push(`${type?.label ?? meeting.meeting_type}${meeting.scheduled_at ? ` · ${meeting.scheduled_at.slice(0, 16).replace("T", " ")}Z` : ""} · prepared by ${b.prepared_by}`);
  lines.push("");
  lines.push("## Why this meeting exists");
  lines.push("");
  lines.push(b.why ?? `**No line could be written.** ${b.why_unavailable ?? ""}`.trim());
  lines.push("");
  lines.push("## What we need to find out");
  lines.push("");
  if (b.find_out.length === 0) lines.push("**No open questions are carried forward.** See *What was examined* below.");
  else for (const q of b.find_out) lines.push(`- ${q.text}`);
  lines.push("");
  lines.push("## What we said last time");
  lines.push("");
  lines.push("**We said we would:**");
  if (b.last_time.firm.length === 0) lines.push("- nothing is on record from an earlier meeting");
  else for (const c of b.last_time.firm) lines.push(`- ${c.text} — ${standingWord(c.standing)}${c.due_date ? `, due ${c.due_date.slice(0, 10)}` : ""} (from "${c.meeting_title}")`);
  lines.push("");
  lines.push("**They said they would:**");
  if (b.last_time.counterparty.length === 0) lines.push("- nothing is on record from an earlier meeting");
  else for (const c of b.last_time.counterparty) lines.push(`- ${c.text}${c.owed_by ? ` (${c.owed_by})` : ""} — ${standingWord(c.standing)}${c.due_date ? `, due ${c.due_date.slice(0, 10)}` : ""} (from "${c.meeting_title}")`);
  lines.push("");
  lines.push("## The record");
  lines.push("");
  if (b.record.about === "NOBODY") lines.push("This meeting is about neither a company nor an LP, so there is no record to bring.");
  else {
    lines.push(`**${b.record.name}**${b.record.summary ? ` — ${b.record.summary}` : ""}`);
    if (b.record.stage) lines.push(`Stage: ${b.record.stage}`);
    lines.push("");
    if (b.record.touches.length === 0) lines.push("Nothing has happened to this record on the event spine.");
    else for (const t of b.record.touches) lines.push(`- ${t.text}`);
  }
  lines.push("");
  if (b.diligence) {
    lines.push("## Diligence framework");
    lines.push("");
    lines.push(`${b.diligence.answered} answered · ${b.diligence.unanswered} open${b.diligence.packet_id ? "" : " · no IC packet exists yet, so every section is open"}`);
    for (const s of b.diligence.sections) lines.push(`- [${s.state === "OPEN" ? " " : "x"}] ${s.title}${s.mandatory ? " (mandatory)" : ""}${s.state === "OPEN" && s.killer ? ` — ${s.killer}` : ""}`);
    for (const c of b.diligence.closing_six) lines.push(`- [${c.state === "OPEN" ? " " : "x"}] Closing ${c.n}: ${c.question}`);
    lines.push("");
  }
  lines.push("## What was examined");
  lines.push("");
  for (const c of b.coverage) lines.push(`- ${c.source}: ${c.rowsRead} row${c.rowsRead === 1 ? "" : "s"}`);
  if (b.unreadable.length > 0) {
    lines.push("");
    lines.push(`**${b.unreadable.length} source${b.unreadable.length === 1 ? "" : "s"} could not be read: ${b.unreadable.join(", ")}.** Treat those areas as unknown rather than as empty.`);
  }
  return lines.join("\n");
}

export interface StoredBrief {
  id: string;
  meeting_id: string;
  brief: MeetingBrief;
  body_md: string;
  prepared_by: string;
  drafted_by_type: string;
  drafted_by_id: string;
  ai_run_id: string | null;
  created_at: string;
}

/**
 * Assemble and store the brief on `meeting_prep_packet` — the P7 row, generalised.
 *
 * The P7 columns (evidence summary, unresolved contradictions, open questions) are still filled
 * so the committee-shaped reader and its test see what they always saw; the brief travels beside
 * them. `open_questions` from the caller are folded into the brief's find-out list.
 */
export async function assembleMeetingBrief(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: { open_questions?: string[]; ai_run_id?: string; skip_why?: boolean } = {},
  visibleClause = "1=1",
  now: Date = new Date(),
): Promise<StoredBrief> {
  const meeting = await requireMeeting(env, meetingId);
  const authz = await authorize(env, actor, "meeting.brief.assemble", { objectType: "meeting_prep_packet", objectId: meetingId, firmScope: meeting.firm_scope });
  if (authz.decision === "DENY") throw new MeetingBriefError(403, "forbidden", authz.reason);
  if (authz.decision === "REQUIRE_APPROVAL") throw new MeetingBriefError(409, "approval_required", authz.reason);
  if (actor.type === "AI" && !input.ai_run_id) {
    throw new MeetingBriefError(400, "invalid_input", "an AI-drafted brief must record its ai_run_id (run_ai trace)");
  }

  const brief = await buildMeetingBrief(env, meetingId, now);
  for (const q of input.open_questions ?? []) {
    if (q.trim()) brief.find_out.push({ text: q.trim(), sourceType: "caller", sourceId: meetingId });
  }
  let aiRunId: string | null = input.ai_run_id ?? null;
  if (!input.skip_why) {
    const why = await writeWhyLine(env, actor, meeting, brief);
    brief.why = why.why;
    brief.why_unavailable = why.unavailable;
    aiRunId = aiRunId ?? why.ai_run_id;
  } else {
    brief.why_unavailable = "not requested";
  }
  brief.body = renderBrief(meeting, brief);

  const summary = meeting.company_id ? await getEvidenceSummary(env, visibleClause, meeting.company_id) : null;
  const id = `mpp_${crypto.randomUUID()}`;
  const actorType = actor.type === "HUMAN" ? "firm_user" : actor.type === "AI" ? "ai_employee" : "system";
  const actorId = actor.firmUserId ?? actor.aiEmployeeId ?? "system";
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting_prep_packet
       (id, meeting_id, company_id, evidence_summary_json, unresolved_contradictions_json, open_questions_json,
        drafted_by_type, drafted_by_id, ai_run_id, firm_scope, brief_json, body_md, coverage_json, prepared_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      id, meetingId, meeting.company_id,
      JSON.stringify(summary ?? {}),
      JSON.stringify(summary?.unresolved_material_contradictions ?? []),
      JSON.stringify(brief.find_out.map((q) => q.text)),
      actor.type === "AI" ? "AI" : "HUMAN",
      actorId, aiRunId, meeting.firm_scope,
      JSON.stringify(brief), brief.body, JSON.stringify({ coverage: brief.coverage, unreadable: brief.unreadable }), brief.prepared_by,
    )
    .run();
  await appendEvent(env, {
    eventType: "meeting.prep_assembled",
    actorType,
    actorId,
    objectType: "meeting_prep_packet",
    objectId: id,
    firmScope: meeting.firm_scope,
    payload: {
      meeting_id: meetingId,
      company_id: meeting.company_id,
      unresolved_material_contradictions: (summary?.unresolved_material_contradictions ?? []).length,
      prepared_by: brief.prepared_by,
      why_written: brief.why !== null,
      find_out: brief.find_out.length,
      we_owe: brief.last_time.firm.length,
      they_owe: brief.last_time.counterparty.length,
      sources_read: brief.coverage.length,
    },
  });
  return (await latestBrief(env, meetingId))!;
}

/** The newest brief on a meeting, or null when none has been built. */
export async function latestBrief(env: Env, meetingId: string): Promise<StoredBrief | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT id, meeting_id, brief_json, body_md, prepared_by, drafted_by_type, drafted_by_id, ai_run_id, created_at
       FROM meeting_prep_packet WHERE meeting_id = ?1 AND brief_json IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(meetingId)
    .first<{ id: string; meeting_id: string; brief_json: string; body_md: string; prepared_by: string; drafted_by_type: string; drafted_by_id: string; ai_run_id: string | null; created_at: string }>();
  if (!row) return null;
  let brief: MeetingBrief;
  try {
    brief = JSON.parse(row.brief_json) as MeetingBrief;
  } catch {
    return null;
  }
  return { id: row.id, meeting_id: row.meeting_id, brief, body_md: row.body_md, prepared_by: row.prepared_by, drafted_by_type: row.drafted_by_type, drafted_by_id: row.drafted_by_id, ai_run_id: row.ai_run_id, created_at: row.created_at };
}

// ── The job: every meeting in the next 36 hours gets a brief ──────────────────────────────────

/** The window the job looks ahead. 36 hours, not 24: see migration 0200 for why. */
export const BRIEF_LOOKAHEAD_HOURS = 36;

export interface BriefRunResult {
  /** SCHEDULED meetings inside the window, briefed or not. The number that makes "0 built" believable. */
  examined: number;
  built: Array<{ meetingId: string; title: string; preparedBy: string; whyWritten: boolean }>;
  alreadyBriefed: number;
  failures: Array<{ meetingId: string; title: string; detail: string }>;
}

/**
 * Brief every SCHEDULED, on-the-record meeting in the next 36 hours that has no brief yet.
 *
 * A FAILURE IS LOUD: a meeting whose brief could not be built gets a CRITICAL notification to the
 * person who put it on the calendar, and the run reports FAILED. A run that finds no meeting in the
 * window is a SUCCEEDED run that says how many it examined — the named legitimate stop, not the
 * inert one.
 */
export async function runMeetingBriefs(env: Env, actor: Actor, now: Date): Promise<BriefRunResult> {
  const until = new Date(now.getTime() + BRIEF_LOOKAHEAD_HOURS * 3_600_000);
  const due = (
    await env.WP_OS_DB.prepare(
      `SELECT m.id, m.title, m.created_by,
              (SELECT COUNT(*) FROM meeting_prep_packet p WHERE p.meeting_id = m.id AND p.brief_json IS NOT NULL) AS briefs
         FROM meeting m
        WHERE m.status = 'SCHEDULED' AND m.archived_at IS NULL
          AND m.scheduled_at IS NOT NULL AND m.scheduled_at >= ?1 AND m.scheduled_at < ?2
        ORDER BY m.scheduled_at`,
    )
      .bind(now.toISOString(), until.toISOString())
      .all<{ id: string; title: string; created_by: string; briefs: number }>()
  ).results ?? [];

  const result: BriefRunResult = { examined: due.length, built: [], alreadyBriefed: 0, failures: [] };
  for (const m of due) {
    if (Number(m.briefs) > 0) {
      result.alreadyBriefed += 1;
      continue;
    }
    try {
      const stored = await assembleMeetingBrief(env, actor, m.id, {}, "1=1", now);
      result.built.push({ meetingId: m.id, title: m.title, preparedBy: stored.prepared_by, whyWritten: stored.brief.why !== null });
      const creator = await env.WP_OS_DB.prepare("SELECT id FROM firm_user WHERE id = ?1").bind(m.created_by).first<{ id: string }>();
      await notify(env, {
        kind: "MEETING",
        severity: "INFO",
        title: `${stored.prepared_by} has your brief for "${m.title}"`,
        body:
          `${stored.brief.find_out.length} to find out · ${stored.brief.last_time.firm.filter((c) => c.standing === "OPEN" || c.standing === "OVERDUE").length} we owe them · ` +
          `${stored.brief.last_time.counterparty.filter((c) => c.standing === "OPEN" || c.standing === "OVERDUE").length} they owe us` +
          (stored.brief.why === null ? ". The why-line could not be written; the brief says so." : "."),
        objectType: "meeting",
        objectId: m.id,
        firmUserId: creator?.id ?? null,
        dedupeKey: `meeting_brief:${m.id}:${stored.id}`,
        now,
      }).catch(() => undefined);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      result.failures.push({ meetingId: m.id, title: m.title, detail });
      await notify(env, {
        kind: "MEETING",
        severity: "CRITICAL",
        title: `The brief for "${m.title}" could NOT be built`,
        body: `${detail}. This is not an empty brief — it failed to build, and nothing should be read into its absence.`,
        objectType: "meeting",
        objectId: m.id,
        firmUserId: null,
        dedupeKey: `meeting_brief_failed:${m.id}:${now.toISOString().slice(0, 10)}`,
        now,
      }).catch(() => undefined);
    }
  }
  await appendEvent(env, {
    eventType: "meeting_brief.run",
    actorType: "system",
    actorId: "meeting_brief",
    objectType: "scheduled_job",
    objectId: "sjb_meeting_brief",
    payload: { examined: result.examined, built: result.built.length, already_briefed: result.alreadyBriefed, failed: result.failures.length, until: until.toISOString() },
  });
  return result;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────────

/** GET /api/meetings/:id/brief — the newest brief, or a named absence. */
export async function handleGetMeetingBrief(ctx: RouteContext): Promise<Response> {
  const meeting = await ctx.env.WP_OS_DB.prepare("SELECT id, privacy_label FROM meeting WHERE id = ?1").bind(ctx.params.id!).first<{ id: string; privacy_label: string }>();
  if (!meeting || !canAccessPrivacyLabel(ctx.identity!, meeting.privacy_label)) return json({ error: "not_found" }, { status: 404 });
  const brief = await latestBrief(ctx.env, meeting.id);
  return json({ brief, ready: brief !== null, note: brief ? null : "No brief has been built for this meeting yet. One is built the night before automatically; press Prepare for it to build one now." });
}
