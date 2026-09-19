import { z } from "zod";
import type { Env } from "../env";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity } from "./authorize";
import { CONSENT_TYPES, currentConsent, recordConsent, type ConsentType } from "./meetings";
import { ingestTranscript } from "./captureAdapter";
import { transcribeChunk, transcriptionAvailable, TranscriptionUnavailable } from "../ai/providers/workersAiWhisper";
import { DiarisationUnavailable, diarisedLine, transcribeDiarised } from "../ai/providers/workersAiNova3";

/**
 * Recording a meeting from the browser it is being held in (ADR-019).
 *
 * WHAT WAS ALREADY HERE AND IS NOT REBUILT. `meetings.ts` holds the two gates that matter — an
 * activated recording policy and a currently GRANTED consent — and RECORDS the refusal when either
 * fails, so "we did not record" is auditable. `captureAdapter.ts` turns transcript text into
 * TRANSCRIPT_DERIVED notes so a close-out commitment can quote the line it came from. Both are
 * good and this module routes through them rather than reimplementing them: a second ingestion path
 * that skipped consent would be the most damaging thing in this codebase.
 *
 * WHAT WAS MISSING WAS THE PROMPT. Every piece of consent machinery existed and none of it was ever
 * asked for. California is a two-party state; New York and Georgia are not. A firm whose partners
 * sit in one and whose founders sit in the others cannot run on "usually fine", and the consent
 * record was reachable only by an API call nobody was going to make mid-conversation.
 *
 * THE PROMPT IS SHOWN EVERY TIME AND IS NEVER REMEMBERED. Consent is given by a person, in a room,
 * on a day. A checkbox that carries it forward to the next session is a record of something that
 * did not happen — so nothing here stores "already asked", and starting capture again asks again.
 *
 * CHUNKS, NOT ONE UPLOAD. The browser records in short slices and posts each as it finishes, so a
 * long conversation never becomes a single upload that can fail near the end and take the whole
 * meeting with it. Each chunk is its own governed import, which means each is also its own audit
 * row — verbose on purpose: a transcript assembled out of a hundred separately-authorised pieces can
 * be checked piece by piece, and one that failed can be named.
 */

export class CaptureRefused extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** The two consent types capture depends on. NOTE_SHARING governs a different act and is not asked here. */
export const CAPTURE_CONSENT_TYPES: readonly ConsentType[] = ["RECORDING", "TRANSCRIPTION"];

export interface CaptureReadiness {
  meeting_id: string;
  /** Whether a transcription service is reachable from this build at all. */
  transcription_available: boolean;
  /** Whether the MP-approved recording policy has been activated for this meeting. */
  recording_policy_active: boolean;
  consent: Record<string, string>;
  /** True only when a chunk posted right now would actually be written down. */
  can_capture: boolean;
  /** What is stopping it, in words a person would say. Empty when nothing is. */
  blockers: string[];
  /** Turns written down so far. */
  turns: number;
}

/**
 * What is true right now, and what is stopping capture.
 *
 * EVERY BLOCKER IS A SENTENCE, not a code. The operator's report on this page was that it is not
 * self-explanatory; a capture button that refuses with `recording_policy_not_activated` is exactly
 * that complaint in miniature.
 */
export async function captureReadiness(env: Env, meetingId: string): Promise<CaptureReadiness> {
  const meeting = await env.WP_OS_DB.prepare(
    "SELECT id, recording_enabled FROM meeting WHERE id = ?1",
  )
    .bind(meetingId)
    .first<{ id: string; recording_enabled: number }>();
  if (!meeting) throw new CaptureRefused(404, "not_found", "meeting not found");

  const consent: Record<string, string> = {};
  for (const type of CONSENT_TYPES) {
    const row = await currentConsent(env, meetingId, type);
    consent[type] = row?.state ?? "NOT_RECORDED";
  }

  const available = transcriptionAvailable(env.AI);
  const policyActive = meeting.recording_enabled === 1;
  const granted = CAPTURE_CONSENT_TYPES.every((t) => consent[t] === "GRANTED");

  const blockers: string[] = [];
  if (!available) {
    blockers.push(
      "This build has no connection to the transcription service, so nothing said here would be written down.",
    );
  }
  if (!policyActive) {
    blockers.push(
      "A Managing Partner has not switched recording on for this meeting yet. That approval is separate from consent and cannot be given by whoever is running the call.",
    );
  }
  if (!granted) {
    blockers.push(
      "Nobody in the room has said yes yet. Ask out loud, then record what they said before anything starts.",
    );
  }

  const turns = Number(
    (
      await env.WP_OS_DB.prepare(
        "SELECT COUNT(*) AS n FROM meeting_note WHERE meeting_id = ?1 AND note_type = 'TRANSCRIPT_DERIVED'",
      )
        .bind(meetingId)
        .first<{ n: number }>()
    )?.n ?? 0,
  );

  return {
    meeting_id: meetingId,
    transcription_available: available,
    recording_policy_active: policyActive,
    consent,
    can_capture: available && policyActive && granted,
    blockers,
    turns,
  };
}

const consentAnswerSchema = z.object({
  /** What the person in the room actually said. */
  answer: z.enum(["GRANTED", "DENIED"]),
  /** Who said it. A GRANTED consent that names nobody is not a consent record. */
  granted_by: z.string().trim().max(200).optional(),
  /** How it was obtained — read aloud on the call, written in the invitation, and so on. */
  basis: z.string().trim().min(4).max(500),
});

/**
 * Record the answer to the prompt.
 *
 * BOTH TYPES IN ONE ACT, TWO ROWS. Being recorded and being transcribed are one question when you
 * ask it out loud and two facts in the ledger, because either can be revoked on its own afterwards.
 * A single row covering both would make a partial revocation impossible to express.
 */
export async function answerConsentPrompt(
  env: Env,
  ctx: RouteContext,
  meetingId: string,
  input: z.infer<typeof consentAnswerSchema>,
): Promise<CaptureReadiness> {
  const actor = actorFromIdentity(ctx.identity!);
  if (input.answer === "GRANTED" && !input.granted_by?.trim()) {
    throw new CaptureRefused(400, "who_said_yes", "Say who gave permission. A consent record that names nobody is not one.");
  }
  for (const type of CAPTURE_CONSENT_TYPES) {
    await recordConsent(env, actor, meetingId, {
      consent_type: type,
      state: input.answer,
      basis: input.basis,
      granted_by: input.answer === "GRANTED" ? input.granted_by!.trim() : undefined,
    });
  }
  return captureReadiness(env, meetingId);
}

const chunkSchema = z.object({
  /** One slice of the recording, base64. The browser never keeps the audio. */
  audio_base64: z.string().min(1).max(9_000_000),
  /** Which slice this is, so a gap in the transcript can be seen rather than guessed at. */
  sequence: z.number().int().min(0).max(10_000),
  /** The recorder's MIME type. Nova-3 reads the container from it; Whisper ignores it. Audio only. */
  content_type: z.string().trim().max(80).regex(/^audio\/[a-z0-9.+-]{1,40}(;\s*codecs=[a-z0-9.,+ -]{1,60})?$/i, "content_type must be an audio type").optional(),
});

export interface ChunkResult {
  sequence: number;
  /** The words. Empty is legitimate — a slice in which nobody spoke. */
  text: string;
  turns_written: number;
  /**
   * Which engine wrote the words down. NOVA3 carries speaker turns; WHISPER is the fallback when
   * the account has no Nova-3, and says so here rather than pretending the names were never there.
   */
  engine: "NOVA3" | "WHISPER";
  /** Distinct speakers the diariser heard in this slice. Empty under Whisper. */
  speakers: number[];
  /** Why Whisper was used, when it was. */
  fallback_reason: string | null;
}

/**
 * The words, with speaker turns when the platform can give them (Phase C).
 *
 * NOVA-3 FIRST, WHISPER WHEN THE MODEL IS NOT THERE. The fallback is on `DiarisationUnavailable`
 * only — the model missing, refused, not deployed. A slice Nova-3 could read but failed on for any
 * other reason is reported as that slice failing, because retrying it through a second model would
 * make "which engine wrote this line" unanswerable on the record.
 *
 * AN UNATTRIBUTED TURN STAYS UNATTRIBUTED. `diarisedLine` writes "Speaker not identified" for a
 * turn the model did not attribute; nothing here guesses from the neighbouring turn.
 */
export async function transcribeWithSpeakers(
  env: Env,
  audioBase64: string,
  contentType: string | undefined,
): Promise<Pick<ChunkResult, "text" | "engine" | "speakers" | "fallback_reason">> {
  try {
    const d = await transcribeDiarised(env.AI, audioBase64, contentType);
    const text = d.turns.length > 0 ? d.turns.map(diarisedLine).join("\n") : d.text.trim();
    return { text: text.trim(), engine: "NOVA3", speakers: d.speakers, fallback_reason: null };
  } catch (err) {
    if (!(err instanceof DiarisationUnavailable)) throw err;
    const w = await transcribeChunk(env.AI, audioBase64);
    return { text: w.text.trim(), engine: "WHISPER", speakers: [], fallback_reason: err.reason.slice(0, 300) };
  }
}

/**
 * Transcribe one slice and file it as meeting notes.
 *
 * ORDER MATTERS AND IS DELIBERATE: transcribe first, then hand the words to the governed import. If
 * the import refuses — consent revoked mid-meeting, policy never activated — the words are dropped
 * and the refusal is recorded by `importTranscript`, exactly as an uploaded transcript would be.
 * Nothing gets written down because the model already did the work.
 */
export async function captureChunk(
  env: Env,
  ctx: RouteContext,
  meetingId: string,
  input: z.infer<typeof chunkSchema>,
): Promise<ChunkResult> {
  const actor = actorFromIdentity(ctx.identity!);
  let heard: Awaited<ReturnType<typeof transcribeWithSpeakers>>;
  try {
    heard = await transcribeWithSpeakers(env, input.audio_base64, input.content_type);
  } catch (err) {
    if (err instanceof TranscriptionUnavailable) throw new CaptureRefused(503, "transcription_unavailable", err.reason);
    throw err;
  }
  const text = heard.text;

  // A silent slice is a correct answer and not a failure. Writing an empty note for it would put a
  // blank line in the record of a conversation, which reads as something lost.
  if (!text) return { sequence: input.sequence, text: "", turns_written: 0, engine: heard.engine, speakers: [], fallback_reason: heard.fallback_reason };

  const { importTranscript } = await import("./meetings");
  const out = await ingestTranscript(
    env,
    actor,
    meetingId,
    // NATIVE: §33's word for capture this system performed itself, as opposed to a provider export
    // or a file somebody uploaded. The distinction survives into the audit row.
    { source: "NATIVE", text },
    importTranscript as never,
  );
  return { sequence: input.sequence, text, turns_written: out.notes_created, engine: heard.engine, speakers: heard.speakers, fallback_reason: heard.fallback_reason };
}

// ── A transcript somebody else recorded: RETIRED ─────────────────────────────

/**
 * THE FIREFLIES IMPORT IS RETIRED. Owner, 19 Sep 2026: "we will use Whisper in lieu of Fireflies —
 * it's better."
 *
 * Two capture paths remain, and they are the only two: the room's recording switch (this laptop's
 * microphone → Nova-3, Whisper as the fallback; a yes asked for every session; live, a minute at a
 * time — `captureChunk` above) and Google Meet's own transcription, read into the record after the
 * call ends (`meetIngest.ts`). A transcript somebody else recorded under conditions nobody here
 * witnessed was always the weakest evidence on the record; it is no longer a door.
 *
 * WHAT STAYS. `shared/meetings/firefliesTranscript.ts` is NOT removed: `meetTranscript.ts` renders
 * Meet's turns through its `turnLine` and `TranscriptTurn` shape, and Nova-3's `diarisedLine` keeps
 * the same line so one reader serves every turn on the record. The parser is a shape now, not a door.
 *
 * THE ROUTE ANSWERS, IT DOES NOT VANISH (the 0198 precedent). A client built against the old door
 * gets a 410 with the reason in the owner's words and the two real paths named — never a 404 that
 * reads as a typo.
 */
export const FIREFLIES_RETIRED = {
  error: "fireflies_import_retired",
  detail:
    "The Fireflies import was retired on 19 Sep 2026 — \"we will use Whisper in lieu of Fireflies — it's better.\" " +
    "Two paths capture a meeting now: the room's recording switch (this laptop's microphone, with a yes asked every session, transcribed live) " +
    "and Google Meet's own transcription, read into the record after the call ends. Nothing was imported.",
  paths: ["POST /api/meetings/:id/capture/chunk", "meet_ingest (scheduled_job) → GET /api/meetings/:id/hearing"],
} as const;

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof CaptureRefused) return json({ error: err.code, detail: err.message }, { status: err.status });
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e.status === "number") return json({ error: e.code ?? "refused", detail: e.message }, { status: e.status });
  throw err;
}

/** GET /api/meetings/:id/capture — can this meeting be recorded right now, and if not why not. */
export async function handleCaptureReadiness(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  if (!id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await captureReadiness(ctx.env, id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/meetings/:id/capture/consent — the answer to the prompt, logged before anything starts. */
export async function handleCaptureConsent(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  const parsed = consentAnswerSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!id || !parsed.success) {
    return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  }
  try {
    return json(await answerConsentPrompt(ctx.env, ctx, id, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/meetings/:id/transcript/fireflies — retired; answers 410 with the reason and the two real paths. */
export async function handleFirefliesRetired(): Promise<Response> {
  return json(FIREFLIES_RETIRED, { status: 410 });
}

/** POST /api/meetings/:id/capture/chunk — one slice of audio becomes transcript turns. */
export async function handleCaptureChunk(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  const parsed = chunkSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!id || !parsed.success) {
    return json({ error: "invalid_input", issues: parsed.success ? undefined : parsed.error.issues }, { status: 400 });
  }
  try {
    return json(await captureChunk(ctx.env, ctx, id, parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
