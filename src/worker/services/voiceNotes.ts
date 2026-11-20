import type { Env } from "../env";
import { appendEvent } from "../events";
import { audioAttachments } from "../effects/mimeAttachments";
import { DiarisationUnavailable, transcribeDiarised } from "../ai/providers/workersAiNova3";
import { transcribeChunk } from "../ai/providers/workersAiWhisper";
import { recordNeurons, requireBudget, whisperNeurons } from "../ai/transcriptionBudget";
import { notifyQuietly } from "./notifications";
import { PREVIEW_PARTNER } from "../../shared/registry/partners";

/**
 * A VOICE NOTE IS THE PARTNER'S WORDS (15 Nov 2026, wc_c548d043). Scooter answered Porter's preview with "Recording
 * attached." and a 19 MB "New Recording 4.m4a"; the card was steered by those two words, because nothing read email
 * audio. A partner's recording on a reply is now transcribed and its words are his steer, word for word.
 *
 * THE ROUTE IS THE PLATFORM'S OWN, and it is the only one. Workers AI on the Worker's `AI` binding (Nova-3, the
 * Whisper fallback when Nova-3 is missing): the audio never leaves Cloudflare, has no vendor key or egress, and is
 * sent with `mip_opt_out`, so it is never anybody's training data. That is the same route the meeting transcriber
 * uses for confidential meetings, which is why partner mail may use it. No other route is tried: when it cannot
 * transcribe (no binding, the model refused, a file too big), that is a NAMED STOP on Sequoia's desk and on the card,
 * never a silent "Recording attached.".
 */

export const VOICE_NOTE_STOP = "voice_note_not_transcribed";

export interface VoiceNotes {
  /** Each recording's words, verbatim. */
  heard: Array<{ filename: string; text: string }>;
  /** Each recording that could not be read, and why, in plain words. */
  failed: Array<{ filename: string; reason: string }>;
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", caf: "audio/x-caf", amr: "audio/amr", webm: "audio/webm",
};

/** The content type to hand the model: the part's own when it is audio, else the one its file name says. Pure. */
export function voiceNoteType(filename: string, mediaType: string): string {
  if (mediaType.startsWith("audio/")) return mediaType;
  const ext = (/\.([a-z0-9]+)$/i.exec(filename)?.[1] ?? "").toLowerCase();
  return TYPE_BY_EXTENSION[ext] ?? "audio/mp4";
}

/** Read every recording attached to a message. Never throws: a failure is in `failed`. */
export async function hearVoiceNotes(env: Env, raw: string): Promise<VoiceNotes> {
  const { attachments, unread } = audioAttachments(raw);
  const out: VoiceNotes = { heard: [], failed: unread.map((u) => ({ filename: u.replace(/\s*\(.*$/, ""), reason: u })) };
  for (const a of attachments) {
    try {
      let text: string;
      await requireBudget(env);
      try {
        const d = await transcribeDiarised(env.AI, a.dataBase64, voiceNoteType(a.filename, a.mediaType), { stream: true });
        await recordNeurons(env, d.neurons ?? 0);
        text = d.text.trim();
      } catch (err) {
        if (!(err instanceof DiarisationUnavailable)) throw err;
        const w = await transcribeChunk(env.AI, a.dataBase64);
        await recordNeurons(env, whisperNeurons(w.seconds));
        text = w.text.trim();
      }
      if (text) out.heard.push({ filename: a.filename, text });
      else out.failed.push({ filename: a.filename, reason: "the transcriber heard no words in it" });
    } catch (err) {
      out.failed.push({ filename: a.filename, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return out;
}

/** The words a steer carries: what he typed, then each recording's words, labelled. Pure. */
export function withVoiceNotes(written: string, heard: VoiceNotes["heard"]): string {
  if (heard.length === 0) return written;
  const typed = written.trim();
  const notes = heard.map((h) => `Voice note (${h.filename}), his words transcribed:\n${h.text}`);
  return [typed, ...notes].filter(Boolean).join("\n\n");
}

/** A recording that could not be read: on the card, on Sequoia's desk, and on the record, by name. */
export async function stopOnUnheardVoiceNotes(env: Env, input: { cardId: string; firmScope: string; partner: string; failed: VoiceNotes["failed"] }): Promise<void> {
  if (input.failed.length === 0) return;
  const lines = input.failed.map((f) => `${f.filename}: ${f.reason}`);
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000) WHERE id = ?1")
    .bind(input.cardId, lines.map((l) => `• A voice note from ${input.partner} could NOT be transcribed, so its words are not in the work yet — ${l}`).join("\n"))
    .run();
  await appendEvent(env, {
    eventType: `work_card.${VOICE_NOTE_STOP}`,
    actorType: "system",
    actorId: "voice_notes",
    objectType: "work_card",
    objectId: input.cardId,
    firmScope: input.firmScope,
    payload: { partner: input.partner, failed: input.failed },
  });
  await notifyQuietly(env, {
    firmUserId: PREVIEW_PARTNER.firmUserId,
    kind: "MEETING",
    severity: "WARNING",
    title: `A voice note from ${input.partner} could not be transcribed`,
    body: `${VOICE_NOTE_STOP}: ${lines.join("; ").slice(0, 500)}. The card has only what was typed.`,
    objectType: "work_card",
    objectId: input.cardId,
    dedupeKey: `${VOICE_NOTE_STOP}:${input.cardId}:${input.failed.map((f) => f.filename).join(",")}`,
    firmScope: input.firmScope,
  });
}

/** The event the "Got it" reads to name every file of a message that could not be opened (15 Nov 2026). */
export const FILES_NOT_OPENED = "work_card.files_not_opened";

/** Every file of one message that could not be opened, on the card's record; the "Got it" names each one. */
export async function recordFilesNotOpened(env: Env, input: { cardId: string; firmScope: string; failed: ReadonlyArray<{ filename: string; reason: string }> }): Promise<void> {
  if (input.failed.length === 0) return;
  await appendEvent(env, {
    eventType: FILES_NOT_OPENED,
    actorType: "system",
    actorId: "inbound_email",
    objectType: "work_card",
    objectId: input.cardId,
    firmScope: input.firmScope,
    payload: { files: input.failed.slice(0, 20).map((f) => ({ filename: f.filename.slice(0, 200), reason: f.reason.slice(0, 300) })) },
  });
}
