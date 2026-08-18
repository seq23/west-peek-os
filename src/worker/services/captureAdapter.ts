import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";

/**
 * Meeting Capture Adapter (P39, V1 #28).
 *
 * §33: "meeting capture can ingest transcripts or notes from provider, native, manual, or upload
 * sources." Those four kinds are the whole surface area.
 *
 * WHAT ALREADY EXISTED AND IS NOT DUPLICATED HERE. `importTranscript` in meetings.ts already
 * enforces the two gates that matter and records a REFUSED row when either fails: the recording
 * policy must be activated, and TRANSCRIPTION consent must be GRANTED. That governance is good and
 * this module deliberately routes through it rather than reimplementing it — a second ingestion
 * path that skipped consent would be the most damaging thing in this codebase.
 *
 * WHAT WAS MISSING: a way to actually get the words in. The import recorded that a transcript
 * arrived; nothing turned it into notes anyone could read, so capture was a receipt for a document
 * that went nowhere.
 *
 * SEGMENTS BECOME NOTES, NOT A BLOB. A transcript stored as one field cannot be quoted, and the
 * close-out extractor works from notes. So the text is split into segments and each becomes a
 * TRANSCRIPT_DERIVED note carrying its import id — which is what makes a close-out commitment able
 * to quote the line it came from.
 */

export class CaptureError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** The four sources §33 names. Anything else is refused rather than silently accepted. */
export const CAPTURE_SOURCES = ["PROVIDER", "NATIVE", "MANUAL", "UPLOAD"] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/**
 * Split raw transcript text into segments.
 *
 * Blank-line separated, falling back to line-per-segment. Deliberately dumb: a clever speaker-turn
 * parser would guess at formats we have not seen, and guessing wrong silently merges two people's
 * words into one attributed line — which is exactly the kind of error that later gets quoted back
 * as evidence.
 */
export function splitSegments(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  const byBlank = text.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

const ingestSchema = z.object({
  source: z.enum(CAPTURE_SOURCES),
  text: z.string().min(1).max(500_000),
  /** Present when the transcript came from a stored document (UPLOAD). */
  document_id: z.string().max(80).nullish(),
});

export interface IngestResult {
  transcript_import_id: string;
  segments: number;
  notes_created: number;
}

/**
 * Ingest a transcript into a meeting as notes.
 *
 * Routes the governance decision through the existing importTranscript path, then materialises the
 * text. If the import is refused (no policy, no consent) nothing is written — the refusal row that
 * importTranscript records is the whole outcome.
 */
export async function ingestTranscript(
  env: Env,
  actor: Actor,
  meetingId: string,
  input: z.infer<typeof ingestSchema>,
  importTranscript: (env: Env, actor: Actor, meetingId: string, i: { source: string; document_id?: string }) => Promise<{ id: string }>,
): Promise<IngestResult> {
  const meeting = await env.WP_OS_DB.prepare(
    "SELECT id, firm_scope, privacy_label FROM meeting WHERE id = ?1",
  )
    .bind(meetingId)
    .first<{ id: string; firm_scope: string; privacy_label: string }>();
  if (!meeting) throw new CaptureError(404, "not_found", "meeting not found");

  const authz = await authorize(env, actor, "meeting.transcript.import", {
    objectType: "meeting", objectId: meetingId, firmScope: meeting.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new CaptureError(403, "forbidden", authz.reason);

  // Consent and recording policy are decided here. A throw means refused, and importTranscript has
  // already written the REFUSED row explaining why.
  const imported = await importTranscript(env, actor, meetingId, {
    source: input.source,
    document_id: input.document_id ?? undefined,
  });

  const segments = splitSegments(input.text);
  let created = 0;
  for (const body of segments) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO meeting_note (id, meeting_id, note_type, body, author_type, author_id, transcript_import_id, privacy_label, firm_scope)
       VALUES (?1, ?2, 'TRANSCRIPT_DERIVED', ?3, 'HUMAN', ?4, ?5, ?6, ?7)`,
    )
      .bind(
        `mn_${crypto.randomUUID()}`, meetingId, body.slice(0, 4000),
        actor.firmUserId ?? "system", imported.id,
        // The meeting's own label travels with every derived note. A transcript is never less
        // sensitive than the meeting it came from.
        meeting.privacy_label, meeting.firm_scope,
      )
      .run();
    created += 1;
  }

  await appendEvent(env, {
    eventType: "meeting.transcript_ingested",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "transcript_import",
    objectId: imported.id,
    firmScope: meeting.firm_scope,
    payload: { meeting_id: meetingId, source: input.source, segments: created },
  });

  return { transcript_import_id: imported.id, segments: segments.length, notes_created: created };
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function handleIngestTranscript(ctx: RouteContext): Promise<Response> {
  const meetingId = ctx.params.id;
  const parsed = ingestSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!meetingId || !parsed.success) {
    return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  }
  const { importTranscript } = await import("./meetings");
  try {
    const out = await ingestTranscript(
      ctx.env, actorFromIdentity(ctx.identity!), meetingId, parsed.data,
      importTranscript as never,
    );
    return json(out, { status: 201 });
  } catch (err) {
    if (err instanceof CaptureError) return json({ error: err.code, detail: err.message }, { status: err.status });
    // A refusal from importTranscript (no consent, no policy) arrives as a MeetingError with its
    // own status; surface it unchanged rather than flattening it to a 500.
    const e = err as { status?: number; code?: string; message?: string };
    if (typeof e.status === "number") return json({ error: e.code ?? "refused", detail: e.message }, { status: e.status });
    throw err;
  }
}
