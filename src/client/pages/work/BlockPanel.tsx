import { isTechnicalBlock } from "@shared/work/blocks";
import type { BlockActionKey } from "@shared/work/blocks";
import type { Assignable, WorkCardRow } from "./types";

/**
 * THE BLOCK, OUTSIDE THE FOLD — the eight doors a stopped card offers, moved out of
 * `WorkCardsPage.tsx` verbatim (22 Sep 2026) so the four pieces of Work that follow can each
 * change their own surface without four agents editing one 1,588-line function.
 *
 * Nothing about what it renders changed: same testids, same doors, same order.
 */
export function BlockPanel({
  card: c,
  employees,
  busy,
  clearing,
  setClearing,
  clearText,
  setClearText,
  onClear,
}: {
  card: WorkCardRow;
  employees: Assignable["employees"];
  busy: boolean;
  clearing: { card: string; action: BlockActionKey } | null;
  setClearing: (next: { card: string; action: BlockActionKey } | null) => void;
  clearText: string;
  setClearText: (next: string) => void;
  onClear: (id: string, action: BlockActionKey, choice?: string) => void;
}): JSX.Element | null {
  if (!c.block) return null;
  const technical = isTechnicalBlock(c.block.reason);
  return (
    <div className={technical ? "card-block card-block-fault" : "card-block"} data-testid={`work-card-block-${c.id}`}>
      {/*
        A FAULT IS NOT A QUESTION, and the heading says which it is. "Blocked —
        waiting on you" over a lane that has run out of credit reads as though she
        has been slow to answer something; what actually happened is that the work
        hit a wall and nothing is being tried until she moves it.
      */}
      <p className="lbl">
        {technical
          ? `Stopped${c.block.laneName ? ` — ${c.block.laneName} refused it` : ""} · nothing is being tried`
          : `Blocked — waiting on ${c.block.who === "ENGINEER" ? "an engineer" : c.block.who === "SCOOTER" ? "Scooter" : "you"}`}
      </p>
      <p data-testid={`work-card-block-stopped-${c.id}`}><strong>{c.block.stopped}</strong></p>
      <p className="small">What was asked for: {c.block.trying}</p>
      <p className="small" data-testid={`work-card-block-needed-${c.id}`}>What would clear it: {c.block.needed}</p>
      {/*
        WHAT THE VENDOR ACTUALLY SAID — on demand, never by default.

        "provider_failure:provider_http_400" was the ONLY account of the 17 Sep
        failure that existed anywhere, and it lived in a database. It is genuinely
        useful to whoever ends up fixing the lane, and it is not an explanation, so
        it lives behind a disclosure with the sentence above it doing the work.
      */}
      {c.block.raw && (
        <details className="block-raw" data-testid={`work-card-block-raw-${c.id}`}>
          <summary className="muted small">Show me exactly what it said</summary>
          <pre className="block-raw-text">{c.block.raw}</pre>
        </details>
      )}
      {c.block.who === "ENGINEER" && (
        <p className="notice small">
          This one is not yours to answer. Sending it on tells whoever maintains the system
          what happened and what they will need; the card stays here until they have fixed it.
        </p>
      )}

      <div className="notification-actions">
        {c.block.actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className={a.key === "ANSWER" ? "btn-strong" : undefined}
            data-testid={`work-card-block-${a.key.toLowerCase()}-${c.id}`}
            title={a.hint}
            onClick={() => {
              setClearText("");
              setClearing(clearing?.card === c.id && clearing.action === a.key ? null : { card: c.id, action: a.key });
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      {clearing?.card === c.id && (
        <div className="card-block-form" data-testid={`work-card-block-form-${c.id}`}>
          <p className="muted small">
            {c.block.actions.find((a) => a.key === clearing.action)?.hint}
          </p>
          {/* A YES-OR-NO ANSWER IS TWO BUTTONS, not a box to type "yes" into. The
              choice also DOES the thing — saying yes to a page grants it. */}
          {/*
            A FAULT DOOR NEEDS NO PROSE. "Try it again" and "stand that one down"
            are not questions she is answering — asking her to type something into
            a box first would be a form standing between her and the fix, which is
            the shape of the problem this whole change exists to remove.
          */}
          {clearing.action === "RETRY" || clearing.action === "ANOTHER_LANE" || clearing.action === "PAUSE_LANE" ? (
            <div className="notification-actions">
              <button
                type="button"
                className="btn-strong"
                disabled={busy}
                data-testid={`work-card-block-do-${clearing.action.toLowerCase()}-${c.id}`}
                onClick={() => onClear(c.id, clearing.action)}
              >
                {clearing.action === "RETRY"
                  ? "Try it again now"
                  : clearing.action === "ANOTHER_LANE"
                    ? `Send it elsewhere${c.block?.laneName ? ` and stand ${c.block.laneName} down for six hours` : ""}`
                    : `Stop using ${c.block?.laneName ?? "it"} for a week`}
              </button>
            </div>
          ) : clearing.action === "HAND_ON" ? (
            <div className="notification-actions">
              {/* The roster, not a guess: the server refuses anybody who is not employed. */}
              <select
                aria-label={`Who should take ${c.title}`}
                data-testid={`work-card-block-handon-who-${c.id}`}
                value={clearText}
                onChange={(e) => setClearText(e.target.value)}
              >
                <option value="">Who should take it?</option>
                {employees
                  .filter((emp) => emp.id !== c.owner_id)
                  .map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} — {emp.role}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn-strong"
                disabled={busy || !clearText}
                data-testid={`work-card-block-handon-${c.id}`}
                onClick={() => onClear(c.id, "HAND_ON", clearText)}
              >
                Give it to them
              </button>
            </div>
          ) : clearing.action === "ANSWER" && (c.block.actions.find((a) => a.key === "ANSWER")?.choices ?? []).length > 0 ? (
            <div className="notification-actions">
              {c.block.actions.find((a) => a.key === "ANSWER")!.choices!.map((ch) => (
                <button
                  key={ch.key}
                  type="button"
                  className="btn-strong"
                  disabled={busy}
                  data-testid={`work-card-block-choice-${ch.key}-${c.id}`}
                  onClick={() => onClear(c.id, "ANSWER", ch.key)}
                >
                  {ch.label}
                </button>
              ))}
            </div>
          ) : (
            <>
              <textarea
                rows={3}
                value={clearing.card === c.id ? clearText : ""}
                data-testid={`work-card-block-text-${c.id}`}
                aria-label={`Your answer for ${c.title}`}
                placeholder={
                  clearing.action === "DROP"
                    ? "Why you are dropping it — kept on the record"
                    : clearing.action === "ESCALATE"
                      ? "Anything an engineer should know (optional)"
                      : clearing.action === "CHANGE"
                        ? "The job, rewritten in your own words"
                        : "Your answer, in your own words"
                }
                onChange={(e) => setClearText(e.target.value)}
              />
              <button
                type="button"
                className="btn-strong"
                disabled={busy}
                data-testid={`work-card-block-send-${c.id}`}
                onClick={() => onClear(c.id, clearing.action)}
              >
                {clearing.action === "DROP" ? "Drop it" : clearing.action === "ESCALATE" ? "Send it on" : "Send it"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
