/**
 * THE PARTNER PRACTICES EVERY EMPLOYEE KEEPS, ON EVERY KIND OF CARD (6 Oct 2026).
 *
 * The owner: "we should form a full list of things porter needed and make sure all ai agents who do
 * work on work cards couldn't benefit from some of them (even if they do no repo work)."
 *
 * PR #227 wrote the list (`docs/PARTNER_SERVICE_RULES.md`) and left eleven ALL-KINDS rules living
 * only in Porter's Mac prompt. This file is where they live now — ONE fragment, and every duty
 * includes it:
 *
 *   · every chain that calls `steerFor` (Parker, Walker, Percy, Wyatt, the deck, blog help, partner
 *     messages) — `steerFor` appends `partnerPracticesBlock` to the text every stage prompt starts with;
 *   · the general employee loop (`buildStepPrompt`, any plain card) — `LoopContext.practices`;
 *   · Porter's Mac duty — the Worker puts the same block on the job as `practices`, and
 *     `renderContext` prints it (the duty script imports nothing from src/, so it is carried, not imported).
 *
 * `validate:partner-service-rules` reads all three inclusions and every rule number below, and fails
 * the build when a rule the document tags ALL-KINDS is enforced only for Porter.
 *
 * The partner's standing constraints (R19) ride in the same block: `partnerPracticesBlock(constraints)`
 * — read per partner from `partner_constraint` (services/partnerConstraints.ts).
 */

export interface PartnerPractice {
  /** The rule in docs/PARTNER_SERVICE_RULES.md this line enforces. */
  rule: string;
  line: string;
}

export const PARTNER_PRACTICES_HEADING = "STANDING PARTNER PRACTICES — every employee, every kind of work (how to report back; never a change to what was asked):";

export const PARTNER_PRACTICES: readonly PartnerPractice[] = [
  { rule: "R7", line: "Anything you wait on from a partner is said in three parts: what is waiting, why, and the exact reply or email that clears it." },
  { rule: "R8", line: "Every way to clear a wait is an email reply or a new email to os@joinwestpeek.com — never a link into the OS, never \"on the card\" or \"on the Work page\", never \"ask Sequoia\"." },
  { rule: "R13", line: "\"Let me know what's realistic\" (or any ask for an estimate) gets the estimate FIRST — per item: today / next week / not possible as worded, with the nearest version — then the work." },
  { rule: "R14", line: "Work the partner dates for later (\"for next week …\") is not dropped: write one line per item, exactly `Deferred to YYYY-MM-DD: <the ask>` — it becomes its own card that runs on that date." },
  { rule: "R15", line: "Several asks in one message → one done-line per ask, in order: `<ask> — done | partial | not done (what is missing)`; partial completion is said per item, never averaged into \"done\"." },
  { rule: "R16", line: "A question nobody answered is settled by its recommended default, said ONCE (\"I went with X; reply with Y and it changes\"); never re-list open questions in later replies — raise one again only when something changed." },
  { rule: "R17", line: "Honest limits: when the ask cannot be done as worded, do the nearest version and state the limit in that item's done-line — never silently narrower, never a question instead of the work." },
  { rule: "R19", line: "The partner's standing constraints below are law for this work: obey every one silently, never ask about them, never list them back." },
  { rule: "R21", line: "Files that arrive later in a Drive folder the partner named are loaded for you automatically; if the folder is still empty, it has already been said once — do not ask for the files again." },
  { rule: "R22", line: "When the firm's own (or a shared) key or account stands in for the partner's, say so in the reply: the cap it carries, what happens when the cap is hit, the upgrade price if known — and that their own key can be emailed as `SECRET NAME=value` to replace it." },
  { rule: "R23", line: "A promised later migration (\"under our account for now, move it after the vote\") is a stated deviation in the reply plus a `Deferred to YYYY-MM-DD: <the move>` line." },
];

/** The one block every duty prompt carries. Constraints are the partner's register (R19); none → the line says so. */
export function partnerPracticesBlock(constraints: readonly string[] = []): string {
  const kept = [...new Set(constraints.map((c) => String(c).replace(/\s+/g, " ").trim()).filter((c) => c.length >= 4))].slice(0, 40);
  return [
    PARTNER_PRACTICES_HEADING,
    ...PARTNER_PRACTICES.map((p) => `  • ${p.line}`),
    kept.length ? `PARTNER_CONSTRAINTS (standing; obey without restating): ${kept.map((c) => `· ${c}`).join(" ")}` : "PARTNER_CONSTRAINTS: none on record for this partner.",
  ].join("\n");
}

// ── R15 / R17: one done-line per ask, the limit stated ─────────────────────────────────────────

export type DoneState = "done" | "partial" | "not_done";
export interface DoneItem {
  item: string;
  state: DoneState;
  note?: string | null;
}

/**
 * ONE LINE PER ASK, in the order asked. A partial or not-done item without a note is given one that
 * says so — an honest limit is never left blank (R17), and nothing is averaged into "done" (R15).
 */
export function doneLines(items: readonly DoneItem[]): string[] {
  return items
    .filter((i) => String(i?.item ?? "").trim())
    .map((i) => {
      const state = i.state === "partial" ? "partial" : i.state === "not_done" ? "not done" : "done";
      const note = String(i.note ?? "").trim() || (state === "done" ? "" : "the limit was not stated — ask for it by replying \"what was missing?\"");
      return `${i.item.trim()} — ${state}${note ? ` (${note})` : ""}`;
    });
}

// ── R14 / R23: dated deferred work, out of any employee's result ───────────────────────────────

export interface DeferredItem {
  ask: string;
  due_at: string;
}

const DEFERRED_LINE = /^\s*(?:[-•*]\s*)?Deferred to (\d{4}-\d{2}-\d{2}):\s*(.{4,400}?)\s*$/gim;

/** Every `Deferred to YYYY-MM-DD: <ask>` line in an employee's result, deduplicated. A bad date is skipped. */
export function deferredItemsIn(text: string | null | undefined): DeferredItem[] {
  const out: DeferredItem[] = [];
  const seen = new Set<string>();
  for (const m of String(text ?? "").matchAll(DEFERRED_LINE)) {
    const due = Date.parse(`${m[1]}T09:00:00-05:00`);
    if (!Number.isFinite(due)) continue;
    const ask = (m[2] ?? "").trim();
    const key = `${m[1]}|${ask.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ask, due_at: new Date(due).toISOString() });
  }
  return out.slice(0, 5);
}

// ── R21: the Drive folders an ask names ─────────────────────────────────────────────────────────

export interface NamedDriveFolder {
  id: string;
  url: string;
}

/** Every Drive FOLDER link in a partner's words (folders only; a single file is an attachment, not a watch). */
export function driveFoldersIn(text: string | null | undefined): NamedDriveFolder[] {
  const out: NamedDriveFolder[] = [];
  const seen = new Set<string>();
  for (const m of String(text ?? "").matchAll(/https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})[^\s<>"')\]]*/g)) {
    const id = m[1] ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: m[0] });
  }
  return out.slice(0, 5);
}
