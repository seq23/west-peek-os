import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * OUTSIDE EMAIL: WHAT MAY SEND (owner, 23 Oct 2026): "We need a universal narrow switch and i can
 * easily go in the ui and tell it which jobs or work cards to allow".
 *
 * Make it calm: phone first, plain words, ← Back, red only when the break-glass is pulled. Allowing
 * asks "are you sure?" first; stopping is always one tap. Every line says who changed it and when.
 * Allowing a job sends nothing by itself: each email still waits for her approval.
 */

interface JobRow {
  id: string;
  name: string;
  employee: string;
  sends: string;
  to: string;
  stillNeeds: string;
  allowed: boolean;
  sending_now: boolean;
  changed_by: string | null;
  changed_at: string | null;
}
interface CardRow {
  id: string;
  title: string;
  allowed: boolean;
  changed_by: string;
  changed_at: string;
}
export interface OutsideEmailScreen {
  break_glass: boolean;
  mode: "OFF" | "ONLY_ALLOWED";
  mode_changed_by: string | null;
  mode_changed_at: string | null;
  jobs: JobRow[];
  cards: CardRow[];
  audit: Array<{ item_type: string; item_id: string; action: string; changed_by: string; changed_at: string }>;
}

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const ACTION_WORDS: Record<string, string> = { ALLOW: "allowed", STOP: "stopped", MODE_OFF: "turned outside email off", MODE_ONLY_ALLOWED: "set outside email to only what is allowed" };

function summary(s: OutsideEmailScreen): string {
  if (s.break_glass) return "Nothing can email outside the firm: the break-glass switch is pulled.";
  if (s.mode === "OFF") return "Outside email is off. Nothing goes outside the firm.";
  const n = s.jobs.filter((j) => j.allowed).length + s.cards.filter((c) => c.allowed).length;
  if (n === 0) return "Nothing is allowed to email outside the firm yet.";
  const names = [...s.jobs.filter((j) => j.allowed).map((j) => j.name), ...s.cards.filter((c) => c.allowed).map((c) => `the card “${c.title}”`)];
  return `Only these may email outside the firm: ${names.join(", ")}. Each email still waits for your approval.`;
}

export function OutsideEmailPage({ me, onBack }: { me: MeResponse; onBack: () => void }): JSX.Element {
  const isMp = me.roles.includes("MANAGING_PARTNER");
  const screen = useApi<OutsideEmailScreen>(isMp ? "/api/outside-email" : null);
  const [data, setData] = useState<OutsideEmailScreen | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const s = data ?? screen.data;

  const post = async (path: string, body: unknown, done: string): Promise<void> => {
    const res = await api<OutsideEmailScreen & { detail?: string }>(path, { method: "POST", body });
    setConfirming(null);
    if (res.status === 200 && res.data) {
      setData(res.data);
      setMessage(done);
    } else setMessage(res.data?.detail ?? "That did not save. Try again.");
  };
  const allowItem = (type: "JOB" | "CARD", id: string, allowed: boolean, name: string) =>
    post("/api/outside-email/allow", { item_type: type, item_id: id, allowed }, allowed ? `${name} may now email outside the firm. Each email still waits for your approval.` : `${name} is stopped. It cannot email outside the firm.`);

  return (
    <section data-testid="outside-email-page" className="work-surface">
      <p>
        <button type="button" onClick={onBack} data-testid="outside-email-back">← Back</button>
      </p>
      <p className="work-eyebrow">Settings</p>
      <h2>Outside email: what may send</h2>
      {!isMp && <p className="notice">Only a Managing Partner can see and change this list.</p>}
      {isMp && !s && <p className="muted">Loading the list…</p>}
      {isMp && s && (
        <>
          {s.break_glass && (
            <p className="notice danger-switch-on" role="alert" data-testid="outside-email-break-glass">
              Stopped: the break-glass switch is pulled, so nothing emails outside the firm, whatever this list says.
            </p>
          )}
          <p data-testid="outside-email-summary"><strong>{summary(s)}</strong></p>
          {message && <p className="notice" role="status" data-testid="outside-email-message">{message}</p>}

          <section className="card" data-testid="outside-email-mode">
            <h3>The master switch</h3>
            {s.mode === "ONLY_ALLOWED" ? (
              <>
                <p><span className="badge badge-ok">Only what I allow</span> Only the jobs and cards marked Allowed below may email outside the firm.</p>
                <button type="button" data-testid="outside-email-mode-off" onClick={() => void post("/api/outside-email/mode", { mode: "OFF" }, "Outside email is off. Nothing goes outside the firm.")}>
                  Turn outside email off (nothing goes out)
                </button>
              </>
            ) : (
              <>
                <p><span className="badge badge-quiet">Off</span> Nothing goes outside the firm, even what is marked Allowed.</p>
                {confirming !== "mode" ? (
                  <button type="button" data-testid="outside-email-mode-on" onClick={() => setConfirming("mode")}>Turn on: only what I allow</button>
                ) : (
                  <div className="notice" role="alert">
                    <p>Only the jobs and cards marked Allowed will be able to email outside the firm, each email still waiting for your approval.</p>
                    <button type="button" data-testid="outside-email-mode-yes" onClick={() => void post("/api/outside-email/mode", { mode: "ONLY_ALLOWED" }, "Outside email is on for only what you allow.")}>Yes, only what I allow</button>{" "}
                    <button type="button" className="link-button" onClick={() => setConfirming(null)}>Cancel, change nothing</button>
                  </div>
                )}
              </>
            )}
            {s.mode_changed_by && <p className="muted small">Last changed by {s.mode_changed_by}, {when(s.mode_changed_at)}.</p>}
          </section>

          <h3>Jobs that can email outside the firm</h3>
          <ul className="card-list" data-testid="outside-email-jobs">
            {s.jobs.map((j) => (
              <li key={j.id} className="card" data-testid={`outside-email-job-${j.id}`}>
                <p>
                  <strong>{j.name}</strong> ({j.employee}){" "}
                  <span className={j.allowed ? "badge badge-ok" : "badge badge-quiet"} data-testid={`outside-email-job-state-${j.id}`}>{j.allowed ? "Allowed" : "Not allowed"}</span>
                </p>
                <p className="small"><strong>What it sends:</strong> {j.sends}</p>
                <p className="small"><strong>To whom:</strong> {j.to}</p>
                <p className="small muted">{j.stillNeeds}</p>
                {j.changed_by && <p className="muted small">{j.allowed ? "Allowed" : "Stopped"} by {j.changed_by}, {when(j.changed_at)}.</p>}
                {j.allowed ? (
                  <button type="button" data-testid={`outside-email-stop-${j.id}`} onClick={() => void allowItem("JOB", j.id, false, j.name)}>Stop {j.name}</button>
                ) : confirming !== `job:${j.id}` ? (
                  <button type="button" data-testid={`outside-email-allow-${j.id}`} onClick={() => setConfirming(`job:${j.id}`)}>Allow {j.name}</button>
                ) : (
                  <div className="notice" role="alert">
                    <p>Are you sure? {j.name} will be allowed to email outside the firm. Nothing goes until you approve each email.</p>
                    <button type="button" data-testid={`outside-email-allow-yes-${j.id}`} onClick={() => void allowItem("JOB", j.id, true, j.name)}>Yes, allow {j.name}</button>{" "}
                    <button type="button" className="link-button" onClick={() => setConfirming(null)}>Cancel, change nothing</button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h3>Work cards</h3>
          {s.cards.length === 0 ? (
            <p className="muted small" data-testid="outside-email-no-cards">No work cards are on your list. To add one, open the card and tap “Let this card email outside the firm”.</p>
          ) : (
            <ul className="card-list" data-testid="outside-email-cards">
              {s.cards.map((c) => (
                <li key={c.id} className="card" data-testid={`outside-email-card-${c.id}`}>
                  <p>
                    <a href={`#/work/${c.id}`}>{c.title} (tap to open)</a>{" "}
                    <span className={c.allowed ? "badge badge-ok" : "badge badge-quiet"}>{c.allowed ? "Allowed" : "Not allowed"}</span>
                  </p>
                  <p className="muted small">{c.allowed ? "Allowed" : "Stopped"} by {c.changed_by}, {when(c.changed_at)}.</p>
                  {c.allowed ? (
                    <button type="button" onClick={() => void allowItem("CARD", c.id, false, "This card")}>Stop this card</button>
                  ) : confirming !== `card:${c.id}` ? (
                    <button type="button" onClick={() => setConfirming(`card:${c.id}`)}>Allow this card</button>
                  ) : (
                    <div className="notice" role="alert">
                      <p>Are you sure? This card will be allowed to email outside the firm. Nothing goes until you approve each email.</p>
                      <button type="button" onClick={() => void allowItem("CARD", c.id, true, "This card")}>Yes, allow this card</button>{" "}
                      <button type="button" className="link-button" onClick={() => setConfirming(null)}>Cancel, change nothing</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="wc-quiet">An email you release yourself from a preview, with “Send it”, is your own send and is not on this list.</p>

          {s.audit.length > 0 && (
            <details className="card" data-testid="outside-email-audit">
              <summary>Who changed what (tap to show)</summary>
              <ul>
                {s.audit.map((a, i) => (
                  <li key={i} className="small">
                    {when(a.changed_at)}: {a.changed_by} {ACTION_WORDS[a.action] ?? a.action}
                    {a.item_type === "MODE" ? "" : ` ${a.item_type === "JOB" ? (s.jobs.find((j) => j.id === a.item_id)?.name ?? a.item_id) : "a work card"}`}.
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/**
 * ON THE CARD ITSELF: "Let this card email outside the firm". Owner-only; it appears on the same
 * Outside email list. Allowing asks first; stopping is one tap.
 */
export function CardOutsideEmail({ cardId, me }: { cardId: string; me: MeResponse }): JSX.Element | null {
  const isMp = me.roles.includes("MANAGING_PARTNER");
  const state = useApi<{ allowed: boolean; changed_by: string | null; changed_at: string | null; sending_now: boolean; reason: string }>(isMp ? `/api/outside-email/cards/${cardId}` : null, [cardId]);
  const [confirming, setConfirming] = useState(false);
  if (!isMp || !state.data) return null;
  const set = async (allowed: boolean): Promise<void> => {
    await api("/api/outside-email/allow", { method: "POST", body: { item_type: "CARD", item_id: cardId, allowed } });
    setConfirming(false);
    state.reload();
  };
  const d = state.data;
  return (
    <p className="wc-quiet" data-testid="card-outside-email">
      {d.allowed ? (
        <>
          <span className="badge badge-ok">This card may email outside the firm</span>{" "}
          <button type="button" data-testid="card-outside-email-stop" onClick={() => void set(false)}>Stop this card emailing outside</button>
        </>
      ) : confirming ? (
        <>
          Are you sure? This card will be allowed to email outside the firm; each email still waits for your approval.{" "}
          <button type="button" data-testid="card-outside-email-yes" onClick={() => void set(true)}>Yes, let it</button>{" "}
          <button type="button" className="link-button" onClick={() => setConfirming(false)}>Cancel, change nothing</button>
        </>
      ) : (
        <button type="button" data-testid="card-outside-email-allow" onClick={() => setConfirming(true)}>Let this card email outside the firm</button>
      )}
      {d.changed_by && <span className="muted small"> {d.allowed ? "Allowed" : "Stopped"} by {d.changed_by}.</span>}{" "}
      <a href="#/outside-email">See your Outside email list →</a>
    </p>
  );
}
