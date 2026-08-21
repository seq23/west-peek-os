import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { LEARNING_MODES, PROFESSOR } from "@shared/university/professor";
import { personaFor } from "@shared/registry/aiEmployeePersonas";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * West Peek University (P45).
 *
 * A topic box, six modes, and a conversation. Deliberately no course catalogue — the whole point is
 * that any venture topic works, and a browsable lesson list would quietly cap it at whatever
 * somebody seeded.
 *
 * Past sessions are listed so returning is one click: the brief asks that a learner can leave and
 * come back, and a session you cannot find again is one you have to restart.
 */

interface Turn { id: string; turn_no: number; role: string; body: string; state: string; detail: string | null }
interface Session { id: string; topic: string; mode: string; status: string; updated_at: string }

export function UniversityPage(): JSX.Element {
  const sessions = useApi<{ sessions: Session[] }>("/api/university");
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useApi<{ session: Session; turns: Turn[] }>(activeId ? `/api/university/${activeId}` : "/api/university", [activeId]);

  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<string>("LEARN");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turns = activeId ? active.data?.turns ?? [] : [];
  const current = activeId ? active.data?.session ?? null : null;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim() || busy) return;
    setBusy(true); setError(null);
    const res = await api<{ session?: Session; detail?: string; error?: string }>("/api/university", {
      method: "POST", body: { topic: topic.trim(), mode },
    });
    if (res.status === 201 && res.data?.session) {
      setActiveId(res.data.session.id);
      setTopic("");
      sessions.reload();
    } else setError(res.data?.detail ?? res.data?.error ?? `Could not start (HTTP ${res.status}).`);
    setBusy(false);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || !activeId || busy) return;
    setBusy(true); setError(null);
    const res = await api(`/api/university/${activeId}/reply`, { method: "POST", body: { message: message.trim() } });
    if (res.status !== 201) setError(`Could not send (HTTP ${res.status}).`);
    setMessage("");
    setBusy(false);
    active.reload();
  }

  async function keepIt(body: string) {
    if (!current) return;
    await api("/api/university/diary", { method: "POST", body: { topic: current.topic, text: body.slice(0, 3000), session_id: current.id } });
    setError(null);
  }

  return (
    <div className="page" data-testid="university-page">
      <h2>West Peek University</h2>

      {/*
        THE PROFESSOR WELCOMES YOU, because a page that teaches ought to have somebody teaching on
        it. This was a heading, a grey line of copy and a text box — the lesson then arrived from
        "Professor", an unnamed role label. Everything else the firm produces is signed.

        Whitney is a real seat on the roster, not decoration: she was the Market Intelligence Coach,
        retired when that product was deferred, and brought back to teach. Her portrait has not been
        generated yet, so this falls back to initials the same way any missing portrait does.
      */}
      {/* The host card is rendered once by the shell for every Deals / Firm / Learn page.
          A second, hand-written one here printed the same name, portrait and voice line
          directly under it — the page introduced its host twice. The sentence that was
          worth keeping now lives in PAGE_HOSTS, so there is one card and one source. */}
      {!activeId && (
        <form className="card" onSubmit={start} data-testid="university-start-form">
          <h3>What do you want to learn?</h3>
          <div className="form-row">
            <input
              data-testid="university-topic" aria-label="What you want to learn"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Pro rata rights, AI diligence, liquidation preferences, portfolio construction…"
              style={{ flex: 1, minWidth: "18rem" }}
            />
          </div>

          <fieldset className="university-modes">
            <legend className="muted small">How should {PROFESSOR.name} teach it?</legend>
            {LEARNING_MODES.map((m) => (
              <label key={m.key} className={mode === m.key ? "mode-chip mode-chip-on" : "mode-chip"}>
                <input
                  type="radio"
                  name="mode"
                  value={m.key}
                  checked={mode === m.key}
                  data-testid={`university-mode-${m.key}`}
                  onChange={() => setMode(m.key)}
                />
                <span>{m.label}</span>
                <span className="muted small">{m.hint}</span>
              </label>
            ))}
          </fieldset>

          <button type="submit" className="btn-strong" disabled={busy} data-testid="university-start">
            {busy ? "Opening…" : "Start session"}
          </button>
          {error && <p className="notice" data-testid="university-error">{error}</p>}
        </form>
      )}

      {activeId && (
        <section className="card" data-testid="university-session">
          <h3>
            {current?.topic}{" "}
            <span className="muted small">{LEARNING_MODES.find((m) => m.key === current?.mode)?.label}</span>
          </h3>

          <ul className="university-thread" data-testid="university-thread">
            {turns.map((t) => (
              <li
                key={t.id}
                className={t.role === "LEARNER" ? "turn turn-mp" : t.state === "OK" ? "turn turn-ai" : "turn turn-blocked"}
                data-testid={`university-turn-${t.turn_no}`}
              >
                <span className="turn-who">{t.role === "LEARNER" ? "You" : t.role === "SYSTEM" ? "" : PROFESSOR.name}</span>
                <span className="turn-body">{t.body}</span>
                {t.role === "INSTRUCTOR" && t.state === "OK" && (
                  <button type="button" className="link-button" data-testid={`university-keep-${t.turn_no}`} onClick={() => keepIt(t.body)}>
                    Keep this
                  </button>
                )}
              </li>
            ))}
          </ul>

          <form className="form-row" onSubmit={send} data-testid="university-reply-form">
            <input
              data-testid="university-message" aria-label="Your message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Answer, or ask for it another way…"
              disabled={busy}
              style={{ flex: 1, minWidth: "16rem" }}
            />
            <button type="submit" className="btn-strong" disabled={busy} data-testid="university-send">
              {busy ? "Thinking…" : "Send"}
            </button>
            <button type="button" data-testid="university-back" onClick={() => setActiveId(null)}>
              New topic
            </button>
          </form>
          {error && <p className="notice" data-testid="university-error">{error}</p>}
        </section>
      )}

      {(sessions.data?.sessions ?? []).length > 0 && (
        <details className="card intel-panel" data-testid="university-history">
          <summary>Past sessions <span className="muted small">{sessions.data!.sessions.length}</span></summary>
          <ul className="card-list small">
            {sessions.data!.sessions.map((s) => (
              <li key={s.id}>
                <button type="button" className="link-button" data-testid={`university-resume-${s.id}`} onClick={() => setActiveId(s.id)}>
                  {s.topic}
                </button>{" "}
                <span className="muted small">
                  {LEARNING_MODES.find((m) => m.key === s.mode)?.label} · {new Date(s.updated_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <HowThisWorks
        title="West Peek University"
        testId="university"
        what={`${PROFESSOR.name} is the firm’s venture professor. Name any topic and she teaches it — explaining, testing, running scenarios, or listening to you teach it back.`}
        when="When you want to actually understand something rather than look up a definition."
        operatorDoes={["Name a topic.", "Pick how you want it taught.", "Answer the questions honestly — wrong answers are where the teaching happens.", "Keep anything worth remembering."]}
        aiDoes={[`${PROFESSOR.name} teaches from principles, marks you honestly, and re-explains what you missed rather than repeating herself.`]}
        requiresOperator={["Nothing here is a firm record. It is a lesson, not evidence."]}
        next="Sessions are saved to you alone and resume where you left them. Anything you keep goes to your diary."
        blocked={[`${PROFESSOR.name} teaches from principles and will not invent facts about real companies, funds or deals — for anything current, use Research, which works from sources the firm has gathered.`]}
      />
    </div>
  );
}
