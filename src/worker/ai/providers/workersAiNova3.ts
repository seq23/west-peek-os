import { TranscriptionUnavailable, transcriptionAvailable, type WhisperBinding } from "./workersAiWhisper";

/**
 * Speech to text WITH SPEAKER TURNS on the binding the Worker already has (Phase C, 18 Sep 2026).
 *
 * WHY A SECOND SPEECH ADAPTER. `workersAiWhisper.ts` returns the words; it cannot say who said
 * them. Close-out and the After draft assign work out of transcript lines, and the repo's rule
 * (Fireflies import, `firefliesTranscript.ts`) is that an invented attribution becomes a task
 * assigned to somebody who never agreed to it — so an unattributed turn STAYS unattributed. That
 * rule is only useful if something can attribute at all. Deepgram Nova-3 on Workers AI diarises:
 * every word carries a `speaker` index, and this adapter folds the words into turns.
 *
 * PROBED, NOT ASSUMED. CONFIRMED 18 Sep 2026 against the owner's account through the Workers AI
 * REST surface with a spoken fixture: `@cf/deepgram/nova-3` answered 200 with `speaker` on every
 * word; `@cf/openai/whisper-large-v3-turbo` answered 200 with none. Cost from the same probe:
 * 137 neurons for 17.4s of speech on Nova-3 (~7.9/s, ~470 a minute) against 13.5 on Whisper
 * (~0.8/s). At 10,000 free neurons a day that is ~21 minutes of Nova-3 before it costs anything,
 * and about $0.31 an hour after that — inside the $2.50/day posture for a meeting, and stated here
 * rather than discovered on the bill. Whisper stays as the fallback: an account or a region without
 * the model gets the words without the names, and says so.
 *
 * SAME PLACE AS WHISPER, SAME ARGUMENT. This sits outside `runAi` for the reason ADR-019 gives: it
 * is not reasoning, there is no vendor hostname, no bearer token and no egress entry, and the audio
 * never leaves Cloudflare. `mip_opt_out` is set on every call so the audio is not used to improve
 * the vendor's model — the confidential-content rule, applied at the one place the audio is sent.
 */

/** The model. Named once. */
export const NOVA3_MODEL = "@cf/deepgram/nova-3";

/** One speaker's run of words. `speaker` is the diariser's index, never a name. */
export interface DiarisedTurn {
  /** 0-based speaker index from the model, or null when it did not attribute the words. */
  speaker: number | null;
  text: string;
  /** Seconds from the start of the chunk. */
  start: number | null;
}

export interface DiarisedTranscription {
  /** The whole chunk's words, in order. Empty is a legitimate answer. */
  text: string;
  turns: DiarisedTurn[];
  /** Distinct speaker indices seen in this chunk. */
  speakers: number[];
  /** Neurons the platform reported for this call, when it did. Never fabricated. */
  neurons: number | null;
}

/**
 * Thrown when the MODEL is not there — refused, not deployed on the account, not in the region —
 * as opposed to the binding being absent. The caller falls back to Whisper on this and only this;
 * a chunk that failed for any other reason is reported as that chunk failing.
 */
export class DiarisationUnavailable extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

interface NovaWord {
  word?: unknown;
  punctuated_word?: unknown;
  speaker?: unknown;
  start?: unknown;
}

/** Whether the words carry a speaker index — the shape the probe recorded. */
function readNova(result: unknown): DiarisedTranscription {
  const r = result as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: unknown; words?: unknown }> }> };
    usage?: { neurons?: unknown };
  } | null;
  const alt = r?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt || typeof alt.transcript !== "string") {
    throw new TranscriptionUnavailable("the diarising transcription service answered in a shape this build does not understand");
  }
  const words = Array.isArray(alt.words) ? (alt.words as NovaWord[]) : [];
  return {
    text: alt.transcript,
    turns: foldTurns(words),
    speakers: [...new Set(words.map((w) => (typeof w.speaker === "number" ? w.speaker : null)).filter((s): s is number => s !== null))].sort((a, b) => a - b),
    neurons: typeof r?.usage?.neurons === "number" ? r.usage.neurons : null,
  };
}

/**
 * Words → turns: consecutive words by the same speaker are one turn. A word the model did not
 * attribute starts an unattributed turn rather than joining its neighbour's — that is the whole
 * point of having a diariser and a rule about invented attribution in the same repo.
 */
export function foldTurns(words: NovaWord[]): DiarisedTurn[] {
  const turns: DiarisedTurn[] = [];
  for (const w of words) {
    const text = typeof w.punctuated_word === "string" ? w.punctuated_word : typeof w.word === "string" ? w.word : "";
    if (!text) continue;
    const speaker = typeof w.speaker === "number" ? w.speaker : null;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.text += ` ${text}`;
    } else {
      turns.push({ speaker, text, start: typeof w.start === "number" ? w.start : null });
    }
  }
  return turns;
}

/** The line a turn becomes on the record. Same shape as the Fireflies import so one reader serves both. */
export function diarisedLine(turn: DiarisedTurn): string {
  const who = turn.speaker === null ? "Speaker not identified" : `Speaker ${turn.speaker + 1}`;
  return `${who}: ${turn.text}`;
}

function bytesFromBase64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, ""));
  } catch {
    throw new TranscriptionUnavailable("the audio was not base64, so nothing could be read");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether the error text says the MODEL is missing, as distinct from the audio being bad. */
export function looksLikeModelMissing(message: string): boolean {
  return /no such model|model not found|not found|not available|unsupported model|does not exist|5007|3001|not enabled|forbidden|403/i.test(message);
}

/**
 * Transcribe one chunk with speaker turns.
 *
 * Throws `DiarisationUnavailable` when the model itself cannot be reached (so the caller may try
 * Whisper), `TranscriptionUnavailable` when the binding is absent or the answer is unreadable.
 */
export async function transcribeDiarised(
  binding: WhisperBinding | undefined,
  audioBase64: string,
  contentType = "audio/webm",
): Promise<DiarisedTranscription> {
  if (!transcriptionAvailable(binding)) {
    throw new TranscriptionUnavailable("this build has no connection to the transcription service, so nothing would be written down");
  }
  if (!audioBase64) throw new TranscriptionUnavailable("no audio arrived");
  // Decoded before the call, so a malformed body is "not base64" and never mistaken for the model
  // being missing (which would send it to Whisper to fail again).
  const body = bytesFromBase64(audioBase64);
  let result: unknown;
  try {
    result = await binding!.run(NOVA3_MODEL, {
      audio: { body, contentType },
      diarize: true,
      punctuate: true,
      // The audio is a conversation the firm was given permission to record. It is not a
      // contribution to anybody's model.
      mip_opt_out: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeModelMissing(message)) throw new DiarisationUnavailable(message);
    throw new TranscriptionUnavailable(message);
  }
  return readNova(result);
}
