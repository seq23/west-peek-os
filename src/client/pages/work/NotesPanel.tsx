import type { InstructionReceipt, WorkCardNote, WorkCardRow } from "./types";

/**
 * SAY SOMETHING TO WHOEVER IS CARRYING IT — moved out of `WorkCardsPage.tsx` on 22 Sep 2026, and on
 * 23 Sep made inline in the expanded card: the box and the thread, with no button in between.
 */

/**
 * Offered only while the work is actually in flight, because the loop re-reads notes only on a
 * card it is still working — a note on finished work would be written into a void, and the server
 * refuses it for the same reason.
 */
export function canSteer(c: Pick<WorkCardRow, "owner_type" | "state">): boolean {
  return c.owner_type === "AI" && ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(c.state);
}

/**
 * "TELL PORTER SOMETHING", INLINE (23 Sep 2026, the work-card redesign). It used to be a button that
 * opened a box — a second click inside a card that had already been opened, which is the one thing
 * her approval ruled out: "i shouldnt have to click again to see everything". The box is simply
 * there, named for who is listening, with the send button saying who it goes to.
 */
export function SteerBox({
  card: c,
  noteText,
  setNoteText,
  onSend,
  busy,
}: {
  card: WorkCardRow;
  noteText: string;
  setNoteText: (next: string) => void;
  onSend: (id: string) => void;
  busy?: boolean;
}): JSX.Element {
  const who = c.owner_name ?? "them";
  return (
    <form
      className="wc-pair-col"
      data-testid={`work-card-steer-form-${c.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSend(c.id);
      }}
    >
      <label className="wc-label" htmlFor={`work-card-steer-input-${c.id}`} data-testid={`work-card-steer-${c.id}`}>
        Tell {who} something
      </label>
      <textarea
        id={`work-card-steer-input-${c.id}`}
        rows={3}
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        placeholder="e.g. keep the current logo"
        data-testid={`work-card-steer-input-${c.id}`}
      />
      <div className="wc-pair-actions">
        <button type="submit" className="btn-strong" data-testid={`work-card-steer-send-${c.id}`} disabled={busy || noteText.trim().length < 2}>
          Send to {who}
        </button>
        {/* Said plainly, because the natural fear is that saying something stops the work or
            starts it again from the top. It does neither. */}
        <span className="wc-quiet">{c.owner_name ?? "They"} keeps working and reads it at the next step.</span>
      </div>
    </form>
  );
}

/** The conversation on one card: her words, and what a model made of them. The box is `SteerBox`. */
export function NoteThread({
  card: c,
  notes,
  receipts,
}: {
  card: WorkCardRow;
  notes: WorkCardNote[];
  receipts: InstructionReceipt[];
}): JSX.Element | null {
  if (receipts.length === 0 && notes.length === 0 && c.kind !== "WEB_PROPERTY_CHANGE") return null;
  return (
    <div className="wc-thread" data-testid={`work-card-thread-${c.id}`}>
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
      {/*
        NAME THE STEERING VOCABULARY (Wave C, 22 Sep 2026) — her real words, typed here as the
        requester, already change what happens: `webPropertyChange.ts`'s `heldByRequester` and
        `readApprovalReply` read this exact box (`work_card_note.body`) for a WEB_PROPERTY_CHANGE
        card, today, with nothing on the page saying so. Scoped to the one kind that actually reads
        it — naming a word that does nothing on every other kind would be its own kind of lie.
      */}
      {c.kind === "WEB_PROPERTY_CHANGE" && (
        <p className="field-help" data-testid={`work-card-steer-vocab-${c.id}`}>
          If you are the one who asked for this: <strong>"stop"</strong> holds it, <strong>"preview"</strong>{" "}
          asks to see it on a link before it lands, <strong>"approved"</strong> or{" "}
          <strong>"approved to production"</strong> carries it forward, and <strong>"changes: …"</strong> sends it
          back to re-plan with what you typed. Anything else is read as your answer to whatever it last asked.
        </p>
      )}
    </div>
  );
}
