/**
 * HER REPLY TO A BATCHED DRAFTS NOTICE (owner, 24 Oct 2026). One email lists every brand draft waiting for her,
 * numbered 1..N, under a reference like "TLC-7K2Q9D". Her reply decides them:
 *   "approved" / "approve all" / "yes"   → every draft in that notice (except any skipped or changed in the same reply)
 *   "approve 1, 3" / "approve 1 and 3"  → those
 *   "skip 2"                              → that one is not sent
 *   "change 2: <what to change>"          → Wynn redrafts it and sends it back for approval
 * Pure: the worker binds the numbers to the drafts of THAT notice only.
 */
export const NOTICE_REF_RE = /\bTLC-[A-Z0-9]{6}\b/;

export interface DraftReply {
  approveAll: boolean;
  approve: number[];
  skip: number[];
  change: Array<{ n: number; note: string }>;
}

/** A line that is a command of its own, so it ends the change note above it. */
const COMMAND_START = /^(?:change|edit|redraft|skip|drop|don't send|do not send|no to|approve|approved|send|yes to|ok)\b/i;

const numbers = (s: string): number[] => [...s.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => Number.isInteger(n) && n > 0);

export function parseDraftReply(text: string): DraftReply {
  const out: DraftReply = { approveAll: false, approve: [], skip: [], change: [] };
  // The change a line opened: the lines after it that are not commands of their own are more of the same note.
  let open: { n: number; note: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const change = /^(?:change|edit|redraft)\s+#?(\d+)\s*[:\-–—]\s*(.+)$/i.exec(line);
    // HER WHOLE NOTE (owner, 26 Oct 2026): never a character cut, and a note that runs onto more lines is all hers.
    if (change) { open = { n: Number(change[1]), note: change[2]!.trim() }; out.change.push(open); continue; }
    if (open && !COMMAND_START.test(line)) { open.note = `${open.note}\n${line}`; continue; }
    open = null;
    // Several commands on one line ("approve 1, 3; skip 2") are read one clause at a time.
    for (const clause of line.split(/[;.]\s*/)) {
      const c = clause.trim().toLowerCase();
      if (!c) continue;
      const skip = /^(?:skip|drop|don't send|do not send|no to)\s+#?([\d,\s&and#]+)$/.exec(c);
      if (skip) { out.skip.push(...numbers(skip[1]!)); continue; }
      const some = /^(?:approve|approved|send|yes to|ok)\s+#?([\d,\s&and#]+)$/.exec(c);
      if (some) { out.approve.push(...numbers(some[1]!)); continue; }
      if (/^(?:approve all|approved all|approve them all|approve|approved|yes|yes,? approve(?:d)?(?: all)?|send all|send them|all approved|looks good,? approve(?:d)?(?: all)?)!?$/.test(c)) out.approveAll = true;
    }
  }
  return out;
}

export function isEmptyReply(r: DraftReply): boolean {
  return !r.approveAll && r.approve.length === 0 && r.skip.length === 0 && r.change.length === 0;
}
