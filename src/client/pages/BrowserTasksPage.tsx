import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Browser tasks — asking an employee to go and look at something.
 *
 * WHY THIS PAGE EXISTS. The whole lifecycle was built, tested and governed months ago: request,
 * human approval, a real headless browser run, results stored already fenced as untrusted. And it
 * had no button anywhere, so in production the count of browser tasks ever run is zero. A
 * capability with no door is a capability the firm does not have.
 *
 * THE SHAPE IS REQUEST → APPROVE → RUN, and the approval is deliberately not automatic. This is the
 * one thing in the system that reaches out and touches the live web on the firm's behalf, so a
 * human says yes to each one. That is cheap when the tasks are the sort they actually are —
 * checking whether a page still says what it said last month — and it is the difference between a
 * tool and an agent nobody is watching.
 *
 * RESULTS ARE UNTRUSTED, and the page says so where they are shown. Whatever a web page contains is
 * data about the world, never an instruction: a page saying "ignore your previous instructions" is
 * exactly the input this fencing exists for, and a reader should know the text they are looking at
 * came from outside.
 */

interface Task {
  id: string;
  objective: string;
  start_url: string;
  status: string;
  requested_by_type: string;
  result_text: string | null;
  failure_reason: string | null;
  created_at: string;
}

const EXAMPLES = [
  "Check whether this company's careers page still lists a VP of Sales",
  "Read the pricing page and tell me what the tiers are now",
  "Find the founders named on the about page",
];

export function BrowserTasksPage({ me }: { me: MeResponse }) {
  const tasks = useApi<{ tasks: Task[] }>("/api/browser-tasks");
  const [objective, setObjective] = useState("");
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = tasks.data?.tasks ?? [];

  async function request(e: React.FormEvent) {
    e.preventDefault();
    if (objective.trim().length < 8 || url.trim().length < 8) return;
    setBusy("request");
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/browser-tasks", {
      method: "POST",
      body: { objective: objective.trim(), start_url: url.trim(), payment_mode: "NONE", max_price_usd: 0 },
    });
    setBusy(null);
    if (res.status !== 201) {
      setMessage(`Not requested: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    setMessage("Requested. Approve it below and it will go and look.");
    setObjective("");
    setUrl("");
    tasks.reload();
  }

  async function act(id: string, what: "approve" | "run") {
    setBusy(id + what);
    const res = await api<{ error?: string; detail?: string; status?: string }>(`/api/browser-tasks/${id}/${what}`, {
      method: "POST",
      body: {},
    });
    setBusy(null);
    if (res.status >= 400) {
      setMessage(`${what === "approve" ? "Not approved" : "Did not run"}: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    } else {
      setMessage(what === "approve" ? "Approved. Run it when you are ready." : `Finished — ${res.data?.status ?? "see the result"}.`);
    }
    tasks.reload();
  }

  return (
    <section data-testid="browser-tasks-page">
      <p className="muted small">
        Ask an employee to go and look at a page, {me.fullName.split(" ")[0]}. Every task is approved
        by a human before it runs — this is the one thing here that reaches out and touches the live
        web on the firm&apos;s behalf.
      </p>

      <form className="card" data-testid="browser-task-form" onSubmit={request}>
        <div className="form-row">
          <label style={{ flexGrow: 1 }}>
            What should they find out?{" "}
            <input
              data-testid="browser-task-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder={EXAMPLES[0]}
            />
          </label>
        </div>
        <div className="form-row">
          <label style={{ flexGrow: 1 }}>
            Starting at{" "}
            <input
              data-testid="browser-task-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/careers"
            />
          </label>
          <button type="submit" className="btn-strong" disabled={busy === "request"} data-testid="browser-task-submit">
            {busy === "request" ? "…" : "Request"}
          </button>
        </div>
        <p className="muted small">
          Good ones are small and checkable: {EXAMPLES.slice(1).join(" · ")}. A task that needs
          judgement rather than looking belongs with a person.
        </p>
      </form>

      {message && <p className="notice" data-testid="browser-task-message">{message}</p>}

      <div className="home-section-head">
        <h2>Tasks</h2>
      </div>

      <ul className="card-list" data-testid="browser-task-list">
        {rows.map((t) => (
          <li key={t.id} className="card" data-testid={`browser-task-${t.id}`}>
            <div className="notification-head">
              <span className="badge">{t.status.toLowerCase().replace(/_/g, " ")}</span>
              <strong>{t.objective}</strong>
            </div>
            <p className="muted small">
              {t.start_url} · requested by {t.requested_by_type === "AI" ? "an employee" : "a person"}
            </p>

            {t.failure_reason && (
              <p className="notice small" data-testid={`browser-task-failure-${t.id}`}>
                {t.failure_reason}
              </p>
            )}

            {t.result_text && (
              <details data-testid={`browser-task-result-${t.id}`}>
                <summary>What it found</summary>
                {/* Rendered as plain text, never as markup. A page saying "ignore your previous
                    instructions" is exactly the input this fencing exists for. */}
                <pre className="browser-result">{t.result_text}</pre>
                <p className="muted small">
                  Read off a live web page. Treat it as information about the world, not as
                  instructions — and check anything you would act on.
                </p>
              </details>
            )}

            <div className="form-row">
              {t.status === "REQUESTED" && (
                <button
                  type="button"
                  className="btn-strong"
                  disabled={busy !== null}
                  data-testid={`browser-task-approve-${t.id}`}
                  onClick={() => void act(t.id, "approve")}
                >
                  {busy === t.id + "approve" ? "…" : "Approve"}
                </button>
              )}
              {t.status === "APPROVED" && (
                <button
                  type="button"
                  className="btn-strong"
                  disabled={busy !== null}
                  data-testid={`browser-task-run-${t.id}`}
                  onClick={() => void act(t.id, "run")}
                >
                  {busy === t.id + "run" ? "Looking…" : "Go and look"}
                </button>
              )}
            </div>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="state-empty" data-testid="browser-tasks-empty">
            Nothing yet. Ask for something small and checkable and it will appear here.
          </li>
        )}
      </ul>
    </section>
  );
}
