/**
 * WHETHER TODAY'S BRIEF ACTUALLY ARRIVED — one answer, used by every surface that shows it.
 *
 * WHAT WENT WRONG, 18 Sep 2026, 08:59 CT. Both partners opened Home and found the Executive
 * Intelligence Report card rendering its header, a "Rebuild today's brief" button and the line
 * "2026-09-18 · 300 items → 283 events → 30 considered" — and nothing else. No brief, and no
 * statement that there was no brief. Her words: "i also do not have a breif for today. its some
 * bug i guess from the 'hide the brief' button." It was not the button. She had no way to know
 * that, because the card said nothing at all.
 *
 * Underneath, her report row was GENERATING and her partner's was FAILED with a real, readable
 * reason already written on it — `the brief was rejected twice: executive_summary carries no [n]
 * citation; ...`. Compliance was reporting that reason on the same page. The panel never read it.
 *
 * THE DEFECT, PRECISELY. `DailyBriefPanel` had two states where it needed four. It asked "is there
 * a report row?" — and if there was one it rendered the masthead, the counts and then mapped over
 * the sections, of which there were none. A row that exists and is not READY is not "a brief";
 * a brief that FAILED is not "a brief that is still coming". Four states, and collapsing them into
 * `report ? sections : empty-state` is what left her guessing at a button for a morning.
 *
 * WHY A PURE FUNCTION AND NOT JSX. The rule is "a brief that fails SAYS SO, on her Home" — and a
 * rule stated only inside a component is a rule nothing can check, because this repo has no DOM
 * renderer in its tests. Here it is a pure function of the row, so `tests/briefState.test.ts` can
 * drive every status the database's own CHECK constraint allows through it and require that only
 * one of them is allowed to claim a brief arrived. `validate:brief-arrives` reads that status list
 * OUT OF the migration rather than restating it, so a status added later cannot quietly default to
 * silence.
 *
 * WHY IT WAS SHARED WITH THE COLLAPSED LINE (retired 19 Sep 2026 with the fold). It had the same bug from the other
 * direction: it said "today's brief arrived" for any non-null report, FAILED included. Two
 * components each keeping their own idea of what "arrived" means, with no link between them, is
 * how one gets fixed and the other does not. There is now one answer and both read it.
 */

/** The fields of an `intelligence_report` row that decide whether the partner has a brief. */
export interface BriefReportState {
  status: string;
  report_date: string;
  completed_at: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export type BriefTone = "arrived" | "failed" | "working";

export interface BriefArrival {
  /** True ONLY when there is a brief on screen to read. Nothing else may claim this. */
  arrived: boolean;
  tone: BriefTone;
  /** A sentence for the partner. Always says whether there is a brief, and never a status code. */
  line: string;
  /** What she can do about it, when there is something. */
  remedy: string | null;
}

/**
 * THE TERMINAL SUCCESS, AND THE ONLY ONE. Everything else is either still moving or is a failure,
 * and both of those must say so out loud.
 *
 * `sectionCount` is part of the question and not a detail: a READY report whose every section was
 * held back by the verifier (`verification_flags`) is a card with nothing in it, which is the very
 * shape this function exists to stop being silent. READY is necessary and not sufficient.
 */
export function briefArrival(report: BriefReportState | null, sectionCount: number): BriefArrival {
  if (!report) {
    return { arrived: false, tone: "working", line: "No brief has been built for today yet.", remedy: null };
  }

  if (report.status === "READY") {
    if (sectionCount > 0) {
      const at = report.completed_at
        ? ` at ${new Date(report.completed_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
        : "";
      return { arrived: true, tone: "arrived", line: `${report.report_date} — today's brief arrived${at}.`, remedy: null };
    }
    // READY with nothing to read. The verifier held every section back: each cited something its
    // own sources did not support. That is the system working, and it is still an empty card.
    return {
      arrived: false,
      tone: "failed",
      line: `${report.report_date} — no brief to read. Every section was held back: the checks found claims its own sources did not support.`,
      remedy: "Build it again — a second pass usually writes something the sources do support.",
    };
  }

  if (report.status === "FAILED") {
    // THE REASON THE PIPELINE ALREADY WROTE DOWN, shown rather than kept. It was on the row the
    // whole time on 18 Sep — the panel simply never asked for it.
    const why = (report.error_message ?? "").trim();
    return {
      arrived: false,
      tone: "failed",
      line: why
        ? `${report.report_date} — today's brief did not arrive. ${why}`
        : `${report.report_date} — today's brief did not arrive, and the run did not record why.`,
      remedy: "Build it again. If it fails the same way twice, the lane that wrote it is the thing to look at.",
    };
  }

  /*
   * STILL MOVING. QUEUED, GATHERING, RANKING, GENERATING, VERIFYING — and any status added later,
   * which lands here rather than in silence. Naming the stage is the difference between "this is
   * working" and "this is broken", which is the exact question she could not answer that morning.
   */
  return {
    arrived: false,
    tone: "working",
    line: `${report.report_date} — today's brief is still being built (${briefStageWords(report.status)}). It is not ready to read yet.`,
    remedy: "It advances a stage at a time. Leave it a few minutes, or press the button to push it along.",
  };
}

/** The stages in her words rather than the column's. */
export function briefStageWords(status: string): string {
  switch (status) {
    case "QUEUED": return "queued";
    case "GATHERING": return "reading the last 48 hours";
    case "RANKING": return "ranking what it found";
    case "GENERATING": return "writing it";
    case "VERIFYING": return "checking every claim against its sources";
    default: return status.toLowerCase();
  }
}
