/**
 * Reading a Fireflies export into turns (ADR-019).
 *
 * Operator, 22 Aug 2026: "i sometimes have fireflies meeting notes so the meetings should have
 * fireflies and whisper capabilities to transfer those notes and transcripts."
 *
 * WHAT THIS IS NOT: an integration. There is no credential here, no hostname, and nothing on the
 * egress allowlist — this reads text the operator already has in her hand. The API route is
 * designed and deferred for the reasons in ADR-019.
 *
 * IT NEVER GUESSES WHO SPOKE. Fireflies exports vary: some carry `Name:` labels, some carry
 * timestamps, some carry both, and some carry neither. Where a line cannot be attributed with
 * confidence it is kept and marked as unattributed rather than handed to the nearest name above it.
 * That rule is not fussiness — close-out reads these turns and assigns commitments from them, so an
 * invented attribution becomes a task assigned to somebody who never agreed to it.
 *
 * FIREFLIES' OWN SUMMARY IS KEPT SEPARATE FROM WHAT WAS SAID. Their model writes the overview and
 * the action items; nobody in the room said those words. Folding them into the transcript would put
 * a machine's paraphrase in the record as testimony, so they come back as their own field, labelled,
 * for the caller to file as what they are.
 */

export interface TranscriptTurn {
  /** Who said it, exactly as the export labelled them. Null when the export did not say. */
  speaker: string | null;
  /** The timestamp the export carried, verbatim. Never computed. */
  at: string | null;
  text: string;
}

export interface FirefliesParse {
  turns: TranscriptTurn[];
  /** Fireflies' own overview / action items, verbatim and unparsed. Never a turn. */
  summary: string | null;
  /** How many turns carry no speaker. Reported so the caller can say so on the record. */
  unattributed: number;
}

/** Headings a Fireflies export puts above its model's own writing rather than above speech. */
const SUMMARY_HEADINGS =
  /^\s*#*\s*(meeting\s+summary|summary|overview|action\s+items?|notes?|keywords?|outline|topics?\s+discussed|shorthand\s+bullet)\s*:?\s*$/i;

/** The heading that says the speech starts here. */
const TRANSCRIPT_HEADING = /^\s*#*\s*(transcript|full\s+transcript)\s*:?\s*$/i;

/** A line that is only a timestamp — it belongs to whatever comes next. */
const BARE_TIME = /^\s*\[?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\]?\s*$/;

/** Page furniture worth dropping: the export's own header lines. */
const FURNITURE = /^\s*(fireflies\.ai|transcribed\s+by|recorded\s+by|meeting\s+(id|url|link)\s*:|duration\s*:|date\s*:|participants?\s*:)/i;

/**
 * `[00:12] Deana Oliver:` / `Deana Oliver (00:12):` / `Deana Oliver:`.
 *
 * The speaker group is deliberately narrow — at most four words, no sentence punctuation, capped
 * length. A greedy pattern turns "Note: we should follow up" into a person called Note, and every
 * line beneath it inherits that name.
 */
const TURN = new RegExp(
  "^\\s*" +
    "(?:\\[?\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*\\]?\\s+)?" + // leading timestamp
    "([A-Z][^:\\n]{0,39}?)" + // the label
    "(?:\\s*\\(\\s*(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*\\))?" + // trailing timestamp
    "\\s*:\\s+" +
    "(.+)$",
);

/**
 * Labels that end in a colon and are never a person.
 *
 * THIS LIST IS THE WHOLE DIFFERENCE between a clean import and a poisoned one. "Note: we should
 * follow up" matches every structural test for a speaker line — one capitalised word, a colon, then
 * speech — and once "Note" is accepted as a person, every wrapped line beneath it is attributed to
 * them too. The failure is silent, it looks like a transcript, and a commitment extracted from it
 * gets assigned to a name that was never in the room.
 */
const NOT_A_SPEAKER = new Set([
  "note", "notes", "action", "action item", "action items", "summary", "overview", "outline",
  "topic", "topics", "keyword", "keywords", "next step", "next steps", "agenda", "recap",
  "decision", "decisions", "outcome", "outcomes", "follow up", "follow-up", "follow ups",
  "attendee", "attendees", "participant", "participants", "date", "time", "duration", "title",
  "meeting", "meeting url", "meeting id", "meeting link", "transcript", "warning", "update",
  "tl;dr", "key points", "key takeaways", "takeaways", "questions", "answers",
]);

/** Whether a matched label is plausibly a person rather than the first clause of a sentence. */
function looksLikeSpeaker(label: string): boolean {
  const name = label.trim();
  if (!name || name.length > 40) return false;
  if (/[.!?;,]$/.test(name)) return false;
  if (NOT_A_SPEAKER.has(name.toLowerCase())) return false;
  const words = name.split(/\s+/);
  if (words.length > 4) return false;
  // Every word starts with a capital, an initial, or is a particle in a real name ("van", "de").
  return words.every((w) => /^[A-Z]/.test(w) || /^(van|von|de|di|da|del|la|le|bin|al)$/i.test(w));
}

/**
 * Parse an export into turns plus whatever the model wrote about them.
 *
 * Deliberately forgiving about layout and deliberately strict about attribution. Anything it cannot
 * read as speech at all is dropped rather than kept as a turn with invented structure — but the one
 * thing it will not do is drop words it CAN read, so an unlabelled paragraph becomes an
 * unattributed turn rather than nothing.
 */
export function parseFireflies(raw: string): FirefliesParse {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const turns: TranscriptTurn[] = [];
  const summaryLines: string[] = [];

  let inSummary = false;
  let pendingTime: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (TRANSCRIPT_HEADING.test(trimmed)) {
      inSummary = false;
      continue;
    }
    if (SUMMARY_HEADINGS.test(trimmed)) {
      inSummary = true;
      summaryLines.push(trimmed.replace(/^#*\s*/, ""));
      continue;
    }
    if (inSummary) {
      // A speaker-labelled line ends the summary block even without a Transcript heading — some
      // exports run straight from the action items into the conversation.
      const maybe = TURN.exec(trimmed);
      if (maybe && looksLikeSpeaker(maybe[2]!)) inSummary = false;
      else {
        if (trimmed) summaryLines.push(trimmed);
        continue;
      }
    }

    if (!trimmed) continue;
    if (FURNITURE.test(trimmed)) continue;

    const bare = BARE_TIME.exec(trimmed);
    if (bare) {
      pendingTime = bare[1]!;
      continue;
    }

    const m = TURN.exec(trimmed);
    if (m && looksLikeSpeaker(m[2]!)) {
      turns.push({
        speaker: m[2]!.trim(),
        at: m[1] ?? m[3] ?? pendingTime,
        text: m[4]!.trim(),
      });
      pendingTime = null;
      continue;
    }

    // A continuation of the line above — the same person still talking. This is the ONLY place a
    // line inherits a speaker, and it is safe because the export put it directly underneath.
    const last = turns[turns.length - 1];
    if (last && !pendingTime) {
      last.text = `${last.text} ${trimmed}`.trim();
      continue;
    }

    // Words with nobody's name on them. Kept, and marked.
    turns.push({ speaker: null, at: pendingTime, text: trimmed });
    pendingTime = null;
  }

  return {
    turns,
    summary: summaryLines.length > 0 ? summaryLines.join("\n") : null,
    unattributed: turns.filter((t) => t.speaker === null).length,
  };
}

/**
 * One turn as a line of the record.
 *
 * AN UNATTRIBUTED TURN SAYS SO IN WORDS. The alternative — leaving the line bare — reads as
 * narration by whoever imported it, and the whole point of keeping the gap is that the gap is
 * visible to the next person who quotes the line.
 */
export function turnLine(turn: TranscriptTurn): string {
  const who = turn.speaker ?? "Speaker not named in the export";
  const at = turn.at ? ` [${turn.at}]` : "";
  return `${who}${at}: ${turn.text}`;
}
