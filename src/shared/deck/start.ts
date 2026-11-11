/**
 * "I'M READY TO WORK ON THE DECK" — the partner's email that starts a deck round (owner, 11 Nov 2026).
 *
 * Her workflow, step 1: either partner emails the OS, or their chief of staff, that they are ready
 * to work on the deck; Preston then emails both partners the preview link. Before this the same
 * email went Porter → chief of staff → maybe Preston, which is a model's judgement. A start must be
 * a guarantee, so it is decided here, by reading the words, with no model.
 *
 * ONLY THE FUND'S OWN DECK. This mailbox mostly receives FOUNDERS' decks, and those keep their
 * routes: a `#wp…` tag, an attachment, a forward, a reply, or any deck that is not plainly "the /
 * our (fund, LP, pitch, investor, West Peek) deck" is not a start. WHEN UNSURE THE ANSWER IS NO, and
 * the message goes to Porter exactly as before — a missed start costs a few minutes; a founder's
 * deck swallowed as "start ours" loses a deal.
 *
 * Pure: the caller (effects/inboundEmail.ts) has already proved the sender is a Managing Partner.
 */

/** The fund's deck, and nothing else: "the deck", "our deck", "the LP deck", "our Fund I deck"… */
const DECK = "(?:the|our)\\s+(?:(?:west peek ventures|west peek|fund i|fund 1|fund one|fund|lp|pitch|investor|fundraising|ventures)\\s+)?deck";
/** What a partner does to it when starting. */
const WORK = "(?:work on|start on|start|get going on|get started on|get back to|go back to|pick up|reopen|open|update|revise|finish)";
/** "the deck for Vynlo" is somebody else's deck; "the deck for LPs" is ours. */
const NOT_SOMEONE_ELSES = "(?!\\s+(?:for|from|of|by)\\s+(?!(?:the\\s+|our\\s+)?(?:fund|lps?|investors?|west peek|first close)\\b))";
/** "Wren, please …" — who it is addressed to changes nothing. */
const ADDRESSED = "(?:(?:hi|hey|hello|ok|okay)[\\s,]+)?(?:(?:preston|wren|walker|porter|team|all)[\\s,:-]+)?(?:(?:please|pls|can you|could you|would you)[\\s,]+)*";

/** The accepted phrasings. Each is tested against ONE sentence, lower-cased, straight apostrophes. */
export const START_PHRASINGS: readonly RegExp[] = [
  // "ready to work on the deck", "I'm ready to start our LP deck", "we are ready to finish the deck"
  new RegExp(`\\bready to ${WORK} ${DECK}\\b${NOT_SOMEONE_ELSES}`),
  // "let's work on our deck", "lets start the deck"
  new RegExp(`\\blet'?s ${WORK} ${DECK}\\b${NOT_SOMEONE_ELSES}`),
  // "time to work on the deck", "I want to update the pitch deck", "we need to reopen the deck"
  new RegExp(`\\b(?:time to|want to|would like to|i'd like to|we'd like to|need to) ${WORK} ${DECK}\\b${NOT_SOMEONE_ELSES}`),
  // The instruction itself, at the start of the sentence: "start the deck", "Preston, open the fund deck", "work on the deck"
  new RegExp(`^${ADDRESSED}${WORK} ${DECK}\\b${NOT_SOMEONE_ELSES}`),
];

/** A sentence that says no, not yet, or only maybe. */
const HEDGED = /\b(?:not|never|no|don't|dont|doesn't|isn't|aren't|won't|can't|cannot|hold off|wait|until|unless|before|after|once|when|if|whether|should we|tomorrow|next week|next month|later|soon|almost|nearly)\b|n't\b/;
/** A question is not an instruction — except the polite one ("can you start the deck?"). */
const POLITE_ASK = new RegExp(`^${ADDRESSED}${WORK} `);

const GREETING = /^(?:(?:hi|hey|hello|dear|ok|okay)\b[\s,]*)?(?:(?:preston|wren|walker|porter|team|all|both)\b)?[\s,:!.-]*$/i;
const SIGN_OFF = /^(?:thanks(?: so much| a lot)?|thank you|thx|ty|best|cheers|regards|warmly|talk soon|sequoia|scooter|st|sent from my .*|get outlook for .*)[\s,.!-]*$/i;

function plain(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\r\n/g, "\n");
}

/** Sentences, each with whether it ended in a question mark. */
function sentences(text: string): Array<{ text: string; raw: string; question: boolean }> {
  const out: Array<{ text: string; raw: string; question: boolean }> = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const raw = m[0];
    const t = raw.replace(/[.!?]+$/, "").trim().toLowerCase().replace(/\s+/g, " ");
    if (t) out.push({ text: t, raw, question: /\?\s*$/.test(raw) });
  }
  return out;
}

function startSentence(text: string): string | null {
  for (const s of sentences(text)) {
    if (!START_PHRASINGS.some((re) => re.test(s.text))) continue;
    if (HEDGED.test(s.text)) return null;
    if (s.question && !POLITE_ASK.test(s.text)) return null;
    return s.raw;
  }
  return null;
}

export interface DeckStart {
  /** Whatever else the partner wrote, to carry in as their first change request. Empty when nothing. */
  words: string;
}

/**
 * Is this email a partner saying they are ready to work on the fund's deck?
 *
 * Read from the subject, or from the first three lines the partner wrote. Returns the rest of what
 * they wrote (greeting, the start sentence and the sign-off removed) so it is not lost.
 */
export function fundDeckStart(input: { subject: string; body: string; hasAttachment: boolean }): DeckStart | null {
  const subject = plain(input.subject).trim();
  const body = plain(input.body);
  if (input.hasAttachment) return null;
  if (/#wp\w*/i.test(`${subject}\n${body}`)) return null;
  if (/^\s*(?:re|fwd?|fw)\s*:/i.test(subject)) return null;

  // What they typed: nothing below a signature dash, no greeting or sign-off lines.
  const typed: string[] = [];
  for (const line of body.split("\n")) {
    if (/^--\s*$/.test(line) || /^\s*>/.test(line) || /^\s*on .+ wrote:\s*$/i.test(line)) break;
    typed.push(line);
  }
  const lines = typed.map((l) => l.trim()).filter((l) => l && !GREETING.test(l) && !SIGN_OFF.test(l));

  const inSubject = startSentence(subject);
  const head = lines.slice(0, 3).join("\n");
  const inBody = startSentence(head);
  if (!inSubject && !inBody) return null;
  // A subject that hedges ("not ready for the deck yet") vetoes a body that seems to start, and the reverse.
  if (sentences(`${subject}\n${head}`).some((s) => /\bdeck\b/.test(s.text) && HEDGED.test(s.text))) return null;

  let rest = lines.join("\n");
  if (inBody) rest = rest.replace(inBody, "").replace(/^[\s,.!-]+/, "");
  rest = rest.split("\n").map((l) => l.trim()).filter((l) => l && !GREETING.test(l)).join("\n").trim();
  return { words: rest.split(/\s+/).filter(Boolean).length >= 2 ? rest : "" };
}
