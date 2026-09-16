import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { JOB_FACTS, cadenceInWords, delivererLine, delivererNames, isOnRequest } from "@shared/work/scheduledWork";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * Governed orchestration (P19; GAP-21, GAP-22).
 *
 * Recurring work as an operator surface: what runs, when it next runs, what happened last time,
 * what was refused and why, and what is stuck in the dead-letter state waiting for a human.
 *
 * TWO SECTIONS (15 Sep 2026): work on a clock, and work that runs only when asked. A job is ON
 * unless there is a stated reason it is not — so the primary control is "Run it now", and pausing
 * is a small link under the row that requires a reason, shown beside the paused row.
 */

interface JobRun {
  id: string;
  job_id: string;
  status: string;
  attempt: number;
  trigger_kind: string;
  outcome_summary: string;
  error: string | null;
  started_at: string;
}

interface Job {
  id: string;
  job_key: string;
  name: string;
  kind: string;
  schedule_kind: string;
  interval_minutes: number | null;
  daily_at_utc: string | null;
  day_of_month?: number | null;
  target_kind: string;
  target_id: string | null;
  data_class: string;
  max_attempts: number;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  pause_reason: string | null;
  recent_runs: JobRun[];
  dead_letters: number;
  /** Null unless this job targets a named employee. See handleListJobs for why it is here. */
  target_employee_status: string | null;
}

function runBadge(status: string): string {
  if (status === "SUCCEEDED") return "badge badge-ok";
  if (status === "REFUSED") return "badge badge-gate";
  if (status === "FAILED" || status === "DEAD_LETTER") return "badge badge-bad";
  return "badge";
}

/**
 * A face on the byline, same as everywhere else the firm hands something over. Falls back to
 * initials when there is no committed portrait, which is what `portraitFor` returns null for.
 */
function Deliverer({ name }: { name: string }): JSX.Element {
  const src = portraitFor(name);
  return (
    <span className="job-deliverer">
      {src ? (
        <img className="job-face" src={src} alt={portraitAlt(name, "delivers this")} loading="lazy" />
      ) : (
        <span className="job-face job-face-initial" aria-hidden="true">{name.slice(0, 1)}</span>
      )}
      {name}
    </span>
  );
}

export function JobsPage({ me }: { me: MeResponse }) {
  const jobs = useApi<{ jobs: Job[]; runs: JobRun[]; architecture: string }>("/api/jobs");
  const [message, setMessage] = useState<string | null>(null);

  async function setStatus(j: Job, status: "ACTIVE" | "PAUSED", reason: string): Promise<void> {
    const res = await api<{ error?: string }>(`/api/jobs/${j.job_key}/status`, { method: "POST", body: { status, reason } });
    setMessage(res.status === 200 ? `${j.name} is now ${status === "PAUSED" ? "paused" : "back on"}.` : `Refused (HTTP ${res.status}).`);
    jobs.reload();
  }

  async function runNow(j: Job): Promise<void> {
    const res = await api<{ run?: { status: string; outcome_summary: string }; error?: string }>(`/api/jobs/${j.job_key}/run`, { method: "POST" });
    setMessage(res.data?.run ? `${j.name}: ${res.data.run.status} — ${res.data.run.outcome_summary}` : `Run failed (HTTP ${res.status}).`);
    jobs.reload();
  }

  /*
   * Sorted by what needs attention: anything broken first, then anything paused, then the jobs
   * quietly working. A page where the healthy and the broken are interleaved by job_key makes you
   * read all of it to find the one that matters.
   */
  const all = [...(jobs.data?.jobs ?? [])].sort((a, b) => {
    const trouble = (j: Job) =>
      j.dead_letters > 0 || (j.status === "ACTIVE" && j.target_employee_status && j.target_employee_status !== "ACTIVE")
        ? 0
        : j.status === "ACTIVE"
          ? 2
          : 1;
    return trouble(a) - trouble(b) || a.name.localeCompare(b.name);
  });
  const scheduled = all.filter((j) => !isOnRequest(j));
  const onRequest = all.filter((j) => isOnRequest(j));

  const row = (j: Job) => {
    const facts = JOB_FACTS[j.job_key];
    const names = delivererNames(j);
    const paused = j.status === "PAUSED";
    const asked = isOnRequest(j);
    const stalled = !paused && j.target_employee_status !== null && j.target_employee_status !== "ACTIVE";
    const last = j.recent_runs[0] ?? null;
    const lastFailed = last ? last.status !== "SUCCEEDED" : false;
    return (
      <li key={j.id} className={paused ? "card job-card" : "card job-card is-on"} data-testid={`job-${j.job_key}`}>
        <div className="job-card-head">
          {/* ONE HONEST WORD. On a clock: "Scheduled". Only when asked: "On request". Paused:
              "Paused", with the reason under the row. Nothing on this page is hard-coded by key. */}
          <span className={paused ? "badge badge-gate" : "badge badge-ok"} data-testid={`job-state-${j.job_key}`}>
            {paused ? "Paused" : asked ? "On request" : "Scheduled"}
          </span>
          <h3 className="job-card-title" style={{ display: "inline", marginLeft: 8 }}>{j.name}</h3>
          {j.dead_letters > 0 && <span className="badge badge-bad">{j.dead_letters} stuck</span>}
        </div>
        <p className="small">{facts?.what ?? "No description has been written for this job."}</p>
        <p className="muted small" data-testid={`job-cadence-${j.job_key}`}>
          {names.length === 0 ? delivererLine(names) : <>By {names.map((n) => <Deliverer key={n} name={n} />)}</>}
          {" · "}{cadenceInWords(j)}
          {!paused && !asked ? (j.next_run_at ? ` · next ${new Date(j.next_run_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : " · not scheduled yet") : ""}
        </p>
        {last ? (
          <p className={lastFailed ? "notice small" : "muted small"} data-testid={`job-runs-${j.job_key}`}>
            <span className={runBadge(last.status)}>{last.status}</span>{" "}
            {new Date(last.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            {last.outcome_summary ? ` — ${last.outcome_summary.slice(0, 220)}` : ""}
            {lastFailed && last.error ? ` — ${last.error.slice(0, 220)}` : ""}
          </p>
        ) : (
          <p className="muted small" data-testid={`job-runs-${j.job_key}`}>Never run.</p>
        )}
        {stalled && (
          <p className="notice small" data-testid={`job-stalled-${j.job_key}`}>
            This is switched on, but {j.target_id} is {String(j.target_employee_status).toLowerCase()} — so it
            cannot actually run. Activate them on Team → Employees.
          </p>
        )}
        {paused && (
          <p className="notice small" data-testid={`job-paused-${j.job_key}`}>
            <strong>Paused:</strong> {j.pause_reason ?? "no reason was recorded"}
          </p>
        )}
        <div className="form-row job-card-actions">
          <button type="button" className="btn-strong" data-testid={`job-run-${j.job_key}`} onClick={() => void runNow(j)}>
            Run it now
          </button>
          {paused ? (
            <button
              type="button"
              className="link-button"
              data-testid={`job-resume-${j.job_key}`}
              onClick={() => void setStatus(j, "ACTIVE", `resumed by ${me.fullName}`)}
            >
              Put it back on
            </button>
          ) : (
            /* A JOB IS ON UNLESS THERE IS A REASON. Pausing asks for the reason first and refuses
               without one, because a paused row with no sentence beside it is a question, and the
               person who paused it is the only one who knows the answer. */
            <button
              type="button"
              className="link-button"
              data-testid={`job-pause-${j.job_key}`}
              onClick={() => {
                const why = window.prompt(`Why pause "${j.name}"? The reason is shown beside it until it is put back on.`);
                if (why === null || why.trim().length < 3) {
                  setMessage("Not paused — a reason is required.");
                  return;
                }
                void setStatus(j, "PAUSED", why.trim());
              }}
            >
              Pause… (why?)
            </button>
          )}
          {j.recent_runs.length > 1 && (
            <details className="job-runs" style={{ display: "inline-block" }}>
              <summary className="muted small">{j.recent_runs.length} recent runs</summary>
              <ul className="card-list small">
                {j.recent_runs.map((r) => (
                  <li key={r.id}>
                    <span className={runBadge(r.status)}>{r.status}</span> {new Date(r.started_at).toLocaleString()}
                    {r.outcome_summary ? ` — ${r.outcome_summary}` : ""}{r.error ? ` — ${r.error}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </li>
    );
  };

  return (
    <section data-testid="jobs-page">
      <HowThisWorks
        testId="jobs"
        title="Scheduled Work"
        what="Recurring work that runs on a cadence instead of waiting for someone to remember it — the Daily Brief, sweeps, monitoring, meeting preparation — and the work that runs only when you ask for it."
        when="When something should happen every day, every week or every month without being asked, when you want something done now, and when you want to know why a recurring job is not running."
        operatorDoes={[
          "Read what each job does and how often it runs.",
          "Press Run it now on anything, scheduled or on request.",
          "Pause a job with a reason, and put it back on when the reason has passed.",
          "Read the reason a job is blocked and clear it.",
        ]}
        aiDoes={[
          "Runs each scheduled job on its cadence, and each on-request job when asked.",
          "Records each run, refusal, failure and retry.",
        ]}
        requiresOperator={[
          "Pausing a job — it needs a stated reason, shown beside the row.",
          "Anything the job would do that is itself a reserved action.",
        ]}
        next="A scheduled job runs on its cadence and its results appear in its run history. An on-request job waits until somebody asks."
        blocked={[
          "No active AI employee for the work, or the activation cap is reached.",
          "A required capability, integration or provider is not configured.",
          "A credential is missing, or two credentials conflict.",
          "The job's action is reserved and has no approval.",
        ]}
      />
      <div className="form-row jobs-run-now">
        <button
          type="button"
          data-testid="jobs-tick"
          onClick={async () => {
            const res = await api<{ ran: Array<{ job_key: string; status: string; summary: string }> }>("/api/jobs/tick", { method: "POST" });
            const ran = res.data?.ran ?? [];
            setMessage(
              ran.length === 0
                ? "Nothing was due. No job ran."
                : ran.map((r) => `${r.job_key}: ${r.status} — ${r.summary}`).join(" · "),
            );
            jobs.reload();
          }}
        >
          Run everything due now
        </button>
      </div>

      {message && <p className="notice" data-testid="jobs-message">{message}</p>}

      <h3>Scheduled work</h3>
      <p className="muted small">On a clock. Each row says how often, honestly — a monthly duty says monthly.</p>
      <ul className="job-grid" data-testid="job-list">
        {scheduled.map(row)}
        {!jobs.loading && scheduled.length === 0 && <li className="state-empty">Nothing is on a clock. A scheduled job names its target employee or machine, its budget, and its data class.</li>}
      </ul>

      <h3>On request</h3>
      <p className="muted small">No timer. These run only when you press Run it now, or when a card asks for them.</p>
      <ul className="job-grid" data-testid="job-list-on-request">
        {onRequest.map(row)}
        {!jobs.loading && onRequest.length === 0 && <li className="state-empty">Nothing runs only on request.</li>}
      </ul>
    </section>
  );
}
