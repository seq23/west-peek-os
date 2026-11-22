/**
 * What a model answers in each structured shape (`runAi`'s `output`), for tests that stand in for a lane or a reader.
 * Each builder fills the fields a test does not care about with the empty answer, so a fixture says only what matters.
 */
type Decision = {
  kind: "approve" | "change" | "question" | "stop" | "nothing";
  property?: string | null;
  handOffTo?: string | null;
  planApproved?: boolean | null;
  holds?: string[];
  takeBack?: boolean | null;
  cc?: string[];
  backBy?: string | null;
};

export function firstRead(o: {
  none?: boolean;
  asks?: string[];
  holds?: string[];
  questions?: string[];
  unclear?: Array<{ words: string; missing: string }>;
  files?: Array<{ filename: string; purpose: string }>;
  next?: string | null;
  decision?: Decision | null;
} = {}): string {
  const d = o.decision;
  return JSON.stringify({
    none: o.none ?? false,
    asks: o.asks ?? [],
    holds: o.holds ?? [],
    questions: o.questions ?? [],
    unclear: o.unclear ?? [],
    files: o.files ?? [],
    next: o.next ?? null,
    decision: d ? { property: null, handOffTo: null, planApproved: null, holds: [], takeBack: null, cc: [], backBy: null, ...d } : null,
  });
}

export function replyIntent(o: {
  intent?: "CONTINUE" | "FIX" | "QUESTION" | "STOP" | "NOTHING";
  door?: "ANSWER" | "BUILD" | "ROUTE";
  seat?: string | null;
  buildIn?: "OS" | "EXISTING" | "NEW" | null;
  changes?: string | null;
  question?: string | null;
  reason?: string;
} = {}): string {
  return JSON.stringify({ intent: "CONTINUE", door: "ANSWER", seat: null, buildIn: null, changes: null, question: null, reason: "test", ...o });
}

export function questionAnswer(o: { confident: boolean; answer?: string | null; reason?: string }): string {
  return JSON.stringify({ answer: null, reason: "test", ...o });
}

export function banterReply(o: { reply: boolean; line?: string | null }): string {
  return JSON.stringify({ line: null, ...o });
}

export function askMarks(marks: Array<{ number: number; status: "DONE" | "IN_PROGRESS" | "NOT_DONE"; why: string }>): string {
  return JSON.stringify({ marks });
}
