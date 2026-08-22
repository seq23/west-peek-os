/**
 * Speech to text on the binding the Worker already has (ADR-019).
 *
 * WHY IT LIVES HERE AND NOT BEHIND `runAi`. Everything that REASONS goes through the governed AI
 * boundary, so that every such call passes the privacy label, the credential scrubber, the egress
 * decision and the cost ledger. Transcription is not reasoning: it receives audio the browser just
 * recorded and returns the words that were said. Modelling it as a text completion would mean
 * inventing prompt tokens, an `output_text` and a completion shape that do not exist — corrupting
 * the one clean abstraction this codebase has to satisfy a rule about a risk that is not present.
 * The same argument the image generator was granted, and it is granted here for the same reason.
 *
 * THE COST OF SITTING OUTSIDE `runAi` IS SMALL AND IS NOT HIDDEN. There is no vendor, no hostname,
 * no bearer token and no egress-allowlist entry: `env.AI` is granted to the Worker by the platform,
 * so nothing that has not been given the binding can reach it, and the audio never leaves
 * Cloudflare. What it does mean is that transcription minutes do not appear in the AI model ledger.
 * That is stated rather than papered over — see ADR-019 and IMPLEMENTATION_LEDGER.md.
 *
 * WHY A BOT WAS REFUSED. The obvious alternative is a recording bot that dials into the call. It was
 * refused for a product reason: an employee seated in a meeting has to be conferrable-with WHILE the
 * meeting is happening, and a bot can only hand back a transcript afterwards.
 */

/** The slice of the Workers AI binding this needs. Narrow on purpose — it is also the test seam. */
export interface WhisperBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * The model. `whisper-large-v3-turbo` is the accurate one and takes base64 audio; the older
 * `@cf/openai/whisper` takes a byte array. Only one is named here — an adapter that guessed between
 * two input shapes at runtime would fail in whichever way it guessed wrong, silently.
 */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export interface TranscriptionResult {
  /** The words. Empty string is a legitimate answer — a chunk of silence. */
  text: string;
  /** Reported by the model when it has it. Never fabricated. */
  wordCount: number | null;
}

export class TranscriptionUnavailable extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

/**
 * Whether transcription can be attempted at all in this environment.
 *
 * Local `wrangler dev` and miniflare have no `AI` binding, so the honest answer there is no. This is
 * the value the page uses to decide whether the capture button is live or disabled-with-a-reason;
 * rendering a button that looks live and is not is the one outcome this whole path refuses.
 *
 * IT IS NOT A PROOF THAT WHISPER WORKS. It proves the binding is present. The first real
 * transcription is the proof, and until one has run remotely the path is UNPROVEN.
 */
export function transcriptionAvailable(binding: WhisperBinding | undefined): boolean {
  return typeof binding?.run === "function";
}

/**
 * Read whatever shape the model answered in.
 *
 * Workers AI's whisper models answer `{ text, word_count, words }`. A missing `text` is reported as
 * a failure rather than coerced to "", because "the field was not there" and "nobody spoke" have
 * different causes and different fixes, and collapsing them is how a transcript quietly loses a
 * minute of a meeting.
 */
function readTranscription(result: unknown): TranscriptionResult {
  const r = result as { text?: unknown; word_count?: unknown } | null;
  if (typeof r?.text !== "string") {
    throw new TranscriptionUnavailable("the transcription service answered in a shape this build does not understand");
  }
  return {
    text: r.text,
    wordCount: typeof r.word_count === "number" ? r.word_count : null,
  };
}

/**
 * Transcribe one chunk of audio.
 *
 * CHUNKS, NOT A WHOLE MEETING. The browser records in short slices and posts each one as it is
 * finished, so a two-hour conversation never becomes a single upload that can fail at minute 119 and
 * take everything with it. Each chunk stands alone: one that fails is reported as that chunk failing
 * and the ones around it survive.
 */
export async function transcribeChunk(
  binding: WhisperBinding | undefined,
  audioBase64: string,
): Promise<TranscriptionResult> {
  if (!transcriptionAvailable(binding)) {
    throw new TranscriptionUnavailable(
      "this build has no connection to the transcription service, so nothing would be written down",
    );
  }
  if (!audioBase64) throw new TranscriptionUnavailable("no audio arrived");
  let result: unknown;
  try {
    result = await binding!.run(WHISPER_MODEL, { audio: audioBase64 });
  } catch (err) {
    // The model's own error text, unchanged. A wrapped message here would hide the licence,
    // quota and model-name failures that are the ones actually worth reading.
    throw new TranscriptionUnavailable(err instanceof Error ? err.message : String(err));
  }
  return readTranscription(result);
}
