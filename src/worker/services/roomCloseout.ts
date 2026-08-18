import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import {
  assignmentLabel,
  isAssigned,
  resolveAssignment,
  type ProposedCommitment,
  type RosterEntry,
} from "../../shared/meetings/delegationPolicy";

/**
 * Room close-out (P51, docs/COMMUNITY.md).
 *
 * A Room is a gathering that produces two things worth keeping, and both are lost within a week if
 * nobody writes them down:
 *
 *   1. WHAT WEST PEEK OWES. Follow-ups the firm committed to. These go through the same
 *      delegationPolicy as a meeting close-out, so the operator's rule — AI employees by default,
 *      humans only where the work truly needs one — lives in exactly one place and cannot drift.
 *
 *   2. WHO WAS THERE AND WHAT THEY DID. Attendance, hosting, speaking. This is the cheapest
 *      Council evidence that exists, and it is only capturable in the days after the Room.
 *
 * WHAT IT DOES NOT DO, ON PURPOSE. It does not record commitments members made to each other. A
 * member promising another member an introduction is between those two members (operator,
 * 17 Aug 2026), and an OS that logged it would be watching conversations West Peek is not part of.
 * The extraction prompt says so, and there is nowhere in the schema to put such a row even if a
 * model returned one.
 */

export class CloseoutError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

interface EventRow {
  id: string;
  title: string;
  event_class: string;
  status: string;
  summary: string | null;
  starts_at: string | null;
  firm_scope: string;
}

export interface RoomCloseoutResult {
  closeoutId: string;
  digest: string;
  commitments: Array<{
    text: string;
    assigneeKind: string;
    aiEmployeeId: string | null;
    humanTouchReason: string | null;
    dueDate: string | null;
  }>;
  actsRecorded: number;
  state: string;
  detail: string;
}

const proposalSchema = z.object({
  commitments: z.array(z.object({
    commitment_text: z.string().min(3).max(400),
    due_date: z.string().max(40).nullish(),
    source_quote: z.string().max(400).nullish(),
    suggested_employee_name: z.string().max(60).nullish(),
    human_touch_reason: z.string().max(300).nullish(),
  })).max(30),
});

/** Same fence-tolerant parsing as the meeting close-out; models wrap JSON often enough to matter. */
export function parseRoomProposals(raw: string): ProposedCommitment[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const checked = proposalSchema.safeParse(parsed);
  if (!checked.success) return null;

  // owner_side is fixed to FIRM. The policy layer expects the field, and forcing it here is what
  // makes "we do not record what members owe each other" structurally true rather than a request.
  return checked.data.commitments.map((c) => ({ ...c, owner_side: "FIRM" as const })) as ProposedCommitment[];
}

export function buildCloseoutPrompt(event: EventRow, notes: string, attendees: string): string {
  return [
    "You are Parker, West Peek Ventures' Event Planner. A Room has just finished.",
    "",
    `ROOM: ${event.title}`,
    `WHO WAS THERE: ${attendees || "not recorded"}`,
    "",
    "NOTES:",
    notes,
    "",
    "List ONLY the things WEST PEEK committed to doing. Nothing else.",
    "",
    "RULES:",
    "- Do NOT list commitments members made to each other. If one guest promised another an",
    "  introduction, that is between them and West Peek does not track it.",
    "- Only what was actually said. Do not invent a sensible follow-up nobody agreed to.",
    "- source_quote must be words that appear in the notes. If you cannot quote it, leave it out.",
    "- due_date only if a date was actually stated. Otherwise null.",
    "- An empty list is a correct answer, and a common one.",
    "- suggested_employee_name is a hint only; who does the work is decided elsewhere.",
    "",
    'Return ONLY JSON: {"commitments":[{"commitment_text":"…","due_date":null,"source_quote":"…","suggested_employee_name":null,"human_touch_reason":null}]}',
  ].join("\n");
}

/** The digest a partner reads. Plain, and honest about what has no owner. */
export function buildRoomDigest(
  event: EventRow,
  commitments: RoomCloseoutResult["commitments"],
  actsRecorded: number,
): string {
  const lines = [`# ${event.title} — what came out of it`, ""];

  if (commitments.length === 0) {
    lines.push("No follow-ups were committed to. That is a normal outcome for a Room — the value was the conversation.", "");
  } else {
    lines.push(`## West Peek owes ${commitments.length} thing${commitments.length === 1 ? "" : "s"}`, "");
    for (const c of commitments) {
      const who = c.aiEmployeeId ?? assignmentLabel(c.assigneeKind as never);
      const due = c.dueDate ? ` — due ${c.dueDate}` : "";
      lines.push(`- **${c.text}** → ${who}${due}`);
      if (c.humanTouchReason) lines.push(`  - a person should be involved: ${c.humanTouchReason}`);
    }
    lines.push("");

    const unowned = commitments.filter((c) => !isAssigned(c.assigneeKind as never));
    if (unowned.length > 0) {
      // Surfaced rather than buried: an unassigned commitment is the one that quietly never happens.
      lines.push(`## ${unowned.length} needs an owner`, "");
      for (const c of unowned) lines.push(`- ${c.text}`);
      lines.push("");
    }
  }

  lines.push(`## Who was there`, "", `${actsRecorded} attendance record${actsRecorded === 1 ? "" : "s"} kept.`);
  lines.push("", "_Commitments members made to each other are theirs, and are not recorded here._");
  return lines.join("\n");
}

async function activeRoster(env: Env, firmScope: string): Promise<RosterEntry[]> {
  const res = await env.WP_OS_DB.prepare(
    "SELECT id, name, role, status FROM ai_employee WHERE status = 'ACTIVE' AND firm_scope = ?1 ORDER BY name",
  ).bind(firmScope).all<RosterEntry>();
  return res.results ?? [];
}

export type Synthesise = (prompt: string) => Promise<{ text: string; aiRunId: string | null }>;

/**
 * Run the close-out.
 *
 * Attendance acts are recorded even when extraction fails or there are no notes at all. They do not
 * depend on a model, and losing a Room's attendance because the language model was unavailable
 * would be the worst possible trade — the acts are the part that cannot be reconstructed later.
 */
export async function runRoomCloseout(
  env: Env,
  actor: Actor,
  eventId: string,
  notes: string,
  deps: { synthesise?: Synthesise } = {},
): Promise<RoomCloseoutResult> {
  const event = await env.WP_OS_DB.prepare(
    "SELECT id, title, event_class, status, summary, starts_at, firm_scope FROM evt_event WHERE id = ?1",
  ).bind(eventId).first<EventRow>();
  if (!event) throw new CloseoutError(404, "not_found", "no such event");

  const authz = await authorize(env, actor, "event.manage", {
    objectType: "event", objectId: eventId, firmScope: event.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new CloseoutError(403, "forbidden", authz.reason);

  const existing = await env.WP_OS_DB.prepare("SELECT id FROM evt_closeout WHERE event_id = ?1").bind(eventId).first();
  if (existing) throw new CloseoutError(409, "already_closed", "this Room has already been closed out");

  const attendees = await env.WP_OS_DB.prepare(
    "SELECT person_id, display_name, attendee_role, rsvp FROM evt_attendee WHERE event_id = ?1",
  ).bind(eventId).all<{ person_id: string | null; display_name: string; attendee_role: string; rsvp: string }>();
  const rows = attendees.results ?? [];

  // ── 1 · Attendance, first and unconditionally ──
  const occurredAt = (event.starts_at ?? new Date().toISOString()).slice(0, 10);
  let actsRecorded = 0;
  for (const a of rows) {
    if (!a.person_id || a.rsvp !== "ATTENDED") continue;
    // A host also attended, but HOSTED is the stronger signal and two rows would double-count a
    // single evening in someone's evidence.
    const kind = a.attendee_role === "HOST" ? "HOSTED" : a.attendee_role === "SPEAKER" ? "SPOKE" : "ATTENDED";
    await env.WP_OS_DB.prepare(
      `INSERT INTO com_act (id, person_id, kind, source, occurred_at, event_id, recorded_by, firm_scope)
       VALUES (?1,?2,?3,'EVENT_CLOSEOUT',?4,?5,?6,?7)`,
    ).bind(`cma_${crypto.randomUUID()}`, a.person_id, kind, occurredAt, eventId,
           actor.firmUserId ?? actor.aiEmployeeId ?? "system", event.firm_scope).run();
    actsRecorded += 1;
  }

  // ── 2 · Commitments ──
  let commitments: RoomCloseoutResult["commitments"] = [];
  let state: "COMPLETE" | "NO_NOTES" | "EXTRACTION_FAILED" = "COMPLETE";
  let detail = "";
  let aiRunId: string | null = null;

  if (notes.trim().length < 20) {
    state = "NO_NOTES";
    detail = "No notes, so no follow-ups were extracted. Attendance was still recorded.";
  } else {
    const prompt = buildCloseoutPrompt(
      event,
      notes,
      rows.map((r) => `${r.display_name} (${r.attendee_role.toLowerCase()})`).join(", "),
    );
    const synth = deps.synthesise ?? (async (p: string) => {
      const { run } = await runAi(env, {
        purpose: `Room close-out: ${event.title}`,
        actor,
        inputs: [p],
        // INTERNAL, not PUBLIC: Room notes carry members' names and what they said in a room they
        // understood to be private. Live search runs at PUBLIC; this must not.
        sensitivity: "INTERNAL" as never,
        routing: { category: "INTELLIGENCE" },
        budgetContext: { expectedOutputTokens: 1500, providerKey: "openrouter" },
      });
      if (run.status !== "COMPLETED" || !run.output_text) {
        throw new CloseoutError(502, "synthesis_failed", run.failure_reason ?? `run ${run.status}`);
      }
      return { text: run.output_text, aiRunId: run.id };
    });

    try {
      const out = await synth(prompt);
      aiRunId = out.aiRunId;
      const proposals = parseRoomProposals(out.text);
      if (!proposals) {
        state = "EXTRACTION_FAILED";
        detail = "The extraction did not come back as usable JSON. Attendance was still recorded.";
      } else {
        const roster = await activeRoster(env, event.firm_scope);
        commitments = proposals.map((p) => {
          const decided = resolveAssignment(p, roster, null);
          return {
            text: decided.commitment_text,
            assigneeKind: decided.assignee_kind,
            aiEmployeeId: decided.ai_employee_id ?? null,
            humanTouchReason: decided.human_touch_reason ?? null,
            dueDate: decided.due_date ?? null,
          };
        });
        detail = `${commitments.length} follow-up(s), ${actsRecorded} attendance record(s).`;
      }
    } catch (err) {
      // Extraction failing must not lose the attendance already written above.
      state = "EXTRACTION_FAILED";
      detail = `Extraction failed: ${err instanceof Error ? err.message : String(err)}. Attendance was still recorded.`;
    }
  }

  // ── 3 · Digest and persistence ──
  const digest = buildRoomDigest(event, commitments, actsRecorded);
  const closeoutId = `ecl_${crypto.randomUUID()}`;
  const assigned = commitments.filter((c) => c.assigneeKind === "AI_EMPLOYEE" || c.assigneeKind === "AI_WITH_HUMAN_TOUCH").length;
  const recommended = commitments.filter((c) => c.assigneeKind === "HUMAN_RECOMMENDED").length;

  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_closeout (id, event_id, digest_md, commitment_count, assigned_count,
                               recommended_count, acts_recorded, state, detail, ai_run_id,
                               firm_scope, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  ).bind(closeoutId, eventId, digest, commitments.length, assigned, recommended, actsRecorded,
         state, detail, aiRunId, event.firm_scope,
         actor.firmUserId ?? actor.aiEmployeeId ?? "Parker").run();

  for (const c of commitments) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO evt_commitment (id, event_id, closeout_id, commitment_text, due_date,
                                   assignee_kind, ai_employee_id, human_touch_reason, source_quote, firm_scope)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(`ecm_${crypto.randomUUID()}`, eventId, closeoutId, c.text, c.dueDate, c.assigneeKind,
           c.aiEmployeeId, c.humanTouchReason, null, event.firm_scope).run();
  }

  await env.WP_OS_DB.prepare("UPDATE evt_event SET status = 'COMPLETE' WHERE id = ?1 AND status <> 'CANCELLED'")
    .bind(eventId).run();

  await appendEvent(env, {
    eventType: "event.closed_out",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    objectType: "event", objectId: eventId, firmScope: event.firm_scope,
    payload: { commitments: commitments.length, acts: actsRecorded, state },
  });

  return { closeoutId, digest, commitments, actsRecorded, state, detail };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof CloseoutError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const runSchema = z.object({ notes: z.string().max(20_000).default("") });

export async function handleRunRoomCloseout(ctx: RouteContext): Promise<Response> {
  const parsed = runSchema.safeParse((await ctx.request.json().catch(() => ({}))) ?? {});
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await runRoomCloseout(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data.notes), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleGetRoomCloseout(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  const closeout = await ctx.env.WP_OS_DB.prepare("SELECT * FROM evt_closeout WHERE event_id = ?1")
    .bind(ctx.params.id).first();
  if (!closeout) return json({ closeout: null, commitments: [] });
  const commitments = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM evt_commitment WHERE event_id = ?1 ORDER BY created_at",
  ).bind(ctx.params.id).all();
  return json({ closeout, commitments: commitments.results ?? [] });
}
