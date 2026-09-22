import type { InstructionReceipt, WorkCardNote, WorkCardRow } from "./types";

/**
 * SAY SOMETHING TO WHOEVER IS CARRYING IT — the button and the thread it opens, moved out of
 * `WorkCardsPage.tsx` verbatim (22 Sep 2026). Same testids, same conditions, same copy.
 */

/**
 * Offered only while the work is actually in flight, because the loop re-reads notes only on a
 * card it is still working — a note on finished work would be written into a void, and the server
 * refuses it for the same reason.
 */
export function SteerButton({
  card: c,
  steering,
  onOpen,
}: {
  card: WorkCardRow;
  steering: string | null;
  onOpen: (id: string) => void;
}): JSX.Element | null {
  if (!(c.owner_type === "AI" && ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(c.state))) return null;
  return (
    <button
      type="button"
      data-testid={`work-card-steer-${c.id}`}
      title="They pick this up on their next step, without stopping the work"
      onClick={() => onOpen(c.id)}
    >
      {steering === c.id ? "Never mind" : `Tell ${c.owner_name ?? "them"} something`}
    </button>
  );
}

/** The conversation on one card: her words, what a model made of them, and the box to add more. */
export function NotesPanel({
  card: c,
  notes,
  receipts,
  noteText,
  setNoteText,
  onSend,
}: {
  card: WorkCardRow;
  notes: WorkCardNote[];
  receipts: InstructionReceipt[];
  noteText: string;
  setNoteText: (next: string) => void;
  onSend: (id: string) => void;
}): JSX.Element {
  return (
    <div className="work-card-look" data-testid={`work-card-steer-form-${c.id}`}>
      {/* WHAT HAS ALREADY BEEN SAID, and what came back. An acknowledgement here is
          never a bare tick: the table's CHECK makes seen-and-answered one event, so
          an employee cannot dismiss a partner's instruction without saying what it
          changed about the work. Showing the answer is what makes that visible. */}
      {/*
        THE RECEIPT. Her words on the left, exactly as she typed them; what the
        model understood on the right, with the model named.

        WHY THE MODEL'S NAME IS ON IT. The instruction was "make sure everything I
        say reaches a thinking model" — a claim she has no way to check unless the
        page says which model read her words. A receipt that asserts it was read
        without saying by what is the same assurance the old system gave.
      */}
      {receipts.length > 0 && (
        <div className="work-card-receipt" data-testid={`work-card-receipt-${c.id}`}>
          <p className="lbl">What you asked for, and what it turned into</p>
          {receipts.slice(0, 3).map((r) => (
            <div key={r.at} className="work-card-receipt-row">
              <div>
                <p className="muted small">You said</p>
                {r.said.map((said, i) => (
                  <p key={i} className="work-card-longtext">“{said.text}”</p>
                ))}
              </div>
              <div>
                <p className="muted small">
                  {c.owner_name ?? "They"} understood
                  {r.model ? ` — read by ${r.model}` : ""}
                </p>
                {r.interpretation ? (
                  <>
                    <p><strong>{r.interpretation.understood}</strong></p>
                    {r.interpretation.steer.length > 0 && (
                      <ul className="work-legend">
                        {r.interpretation.steer.map((line, i) => <li key={i}>{line}</li>)}
                      </ul>
                    )}
                    {/* NOT A DETAIL. This is the part she is owed: the bit of what
                        she asked for that this work has no step for, said out loud
                        rather than quietly dropped. */}
                    {r.interpretation.cannot.length > 0 && (
                      <p className="notice small" data-testid={`work-card-receipt-cannot-${c.id}`}>
                        Could not do: {r.interpretation.cannot.join("; ")}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="notice small">
                    Nothing read this yet: {r.failure ?? "the reading did not happen"}. It is tried again on the next run.
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="card-list small" data-testid={`work-card-notes-${c.id}`}>
          {notes.map((n) => (
            <li key={n.id}>
              <strong>{n.author ?? "A partner"}:</strong> {n.body}
              <div className="muted small">
                {n.acknowledged_at
                  ? `${c.owner_name ?? "They"} answered: ${n.response}`
                  : "Not picked up yet — they will read it on their next step."}
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => { e.preventDefault(); onSend(c.id); }}>
        <input
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="What should they do differently?"
          aria-label={`Tell whoever is carrying ${c.title} something`}
          data-testid={`work-card-steer-input-${c.id}`}
        />
        <div className="form-row">
          <button type="submit" className="btn-strong" data-testid={`work-card-steer-send-${c.id}`} disabled={noteText.trim().length < 2}>
            Send it over
          </button>
          {/* Said plainly, because the natural fear is that saying something stops
              the work or starts it again from the top. It does neither. */}
          <span className="muted small">They keep working. This lands on their next step.</span>
        </div>
      </form>
    </div>
  );
}
