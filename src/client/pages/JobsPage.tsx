import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { JOB_FACTS, cadenceInWords, delivererLine, delivererNames } from "@shared/work/scheduledWork";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";

/**
 * Governed orchestration (P19; GAP-21, GAP-22).
 *
 * Recurring work as an operator surface: what runs, when it next runs, what happened last time,
 * what was refused and why, and what is stuck in the dead-letter state waiting for a human.
 *
 * Every job starts PAUSED. Switching one on is a deliberate act, and the page says so.
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
  const [reason, setReason] = useState("");

  return (
    <section data-testid="jobs-page">
      <HowThisWorks
        testId="jobs"
        title="Scheduled Work"
        what="Recurring work that runs on a cadence instead of waiting for someone to remember it — the Daily Brief, sweeps, monitoring, meeting preparation."
        when="When something should happen every day or every week without being asked, and when you want to know why a recurring job is not running."
        operatorDoes={[
          "Review what each job does and how often it runs.",
          "Enable a job that should be running, or pause one that should not.",
          "Read the reason a job is blocked and clear it.",
        ]}
        aiDoes={[
          "Runs the job on its cadence once it is enabled.",
          "Records each run, refusal, failure and retry.",
        ]}
        requiresOperator={[
          "Enabling a job. New jobs are created paused; nothing starts running on its own.",
          "Anything the job would do that is itself a reserved action.",
        ]}
        next="An enabled job runs on its cadence and its results appear in its run history. A paused job does nothing until you enable it."
        blocked={[
          "No active AI employee for the work, or the activation cap is reached.",
          "A required capability, integration or provider is not configured.",
          "A credential is missing, or two credentials conflict.",
          "The job's action is reserved and has no approval.",
        ]}
      />
      {/* THE BUTTON, WITHOUT A DRAWER AROUND IT.
          This sat inside a disclosure called "Run everything that is due, and how this works
          underneath", which put a control somebody occasionally needs behind a lid, and stapled a
          paragraph of architecture to it — D1, cron triggers, no Queues. That belongs in the "how
          this works" panel above if it belongs anywhere, and it does not: nobody switching a job
          on needs to know which primitives it is built from. The control is the control. */}
      <div className="form-row jobs-run-now">
        <input
          data-testid="job-reason"
          aria-label="Why — recorded against switching a job on or off"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (optional — recorded against switching a job on or off)"
          style={{ flex: 1, minWidth: "16rem" }}
        />
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

      {/*
        REAL CARDS. This was a bullet list where every job printed its database row — target kind,
        data class, attempt count, an ISO timestamp — and none of what somebody actually wants to
        know: what it is, who hands it over, and whether it is running.

        Sorted by what needs attention: anything broken first, then anything switched off, then the
        jobs quietly working. A page where the healthy and the broken are interleaved by job_key
        makes you read all of it to find the one that matters.
      */}
      {/*
        ONE ROW PER JOB. Eight tall cards, each with its own buttons and a folded run trail, read as
        eight separate things to worry about; the operator's verdict (14 Sep 2026) was that the page
        did not make sense. A job is one line: is it on, what it does, who does it, how often, and
        how its last run went — with the reason inline when it failed, because a red word with no
        sentence beside it is a question, not information. Actions stay on the row.
      */}
      <ul className="job-grid" data-testid="job-list">
        {[...(jobs.data?.jobs ?? [])]
          .sort((a, b) => {
            const trouble = (j: Job) =>
              j.dead_letters > 0 || (j.status === "ACTIVE" && j.target_employee_status && j.target_employee_status !== "ACTIVE")
                ? 0
                : j.status === "ACTIVE"
                  ? 1
                  : 2;
            return trouble(a) - trouble(b) || a.name.localeCompare(b.name);
          })
          .map((j) => {
          const facts = JOB_FACTS[j.job_key];
          const names = delivererNames(j);
          const on = j.status === "ACTIVE";
          const stalled = on && j.target_employee_status !== null && j.target_employee_status !== "ACTIVE";
          const last = j.recent_runs[0] ?? null;
          const lastFailed = last ? last.status !== "SUCCEEDED" : false;
          return (
          <li key={j.id} className={on ? "card job-card is-on" : "card job-card"} data-testid={`job-${j.job_key}`}>
            <div className="job-card-head">
              <span className={on ? "badge badge-ok" : "badge badge-gate"}>{on ? "On" : j.job_key === "deck_rebuild" ? "On request" : "Off"}</span>
              <h3 className="job-card-title" style={{ display: "inline", marginLeft: 8 }}>{j.name}</h3>
              {j.dead_letters > 0 && <span className="badge badge-bad">{j.dead_letters} stuck</span>}
            </div>
            <p className="small">{facts?.what ?? "No description has been written for this job."}</p>
            <p className="muted small">
              {names.length === 0 ? delivererLine(names) : <>By {names.map((n) => <Deliverer key={n} name={n} />)}</>}
              {" · "}{cadenceInWords(j)}
              {on ? (j.next_run_at ? ` · next ${new Date(j.next_run_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : " · not scheduled yet") : ""}
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
            {!on && j.pause_reason && <p className="muted small">{j.pause_reason}</p>}
            <div className="form-row job-card-actions">
              <button
                type="button"
                className="link-button"
                data-testid={`job-toggle-${j.job_key}`}
                onClick={async () => {
                  const res = await api<{ error?: string }>(`/api/jobs/${j.job_key}/status`, {
                    method: "POST",
                    body: { status: on ? "PAUSED" : "ACTIVE", reason: reason || `operator action by ${me.fullName}` },
                  });
                  setMessage(res.status === 200 ? `${j.name} is now ${on ? "switched off" : "running"}.` : `Refused (HTTP ${res.status}).`);
                  jobs.reload();
                }}
              >
                {on ? "Switch off" : "Switch on"}
              </button>
              <button
                type="button"
                className="link-button"
                data-testid={`job-run-${j.job_key}`}
                onClick={async () => {
                  const res = await api<{ run?: { status: string; outcome_summary: string }; error?: string }>(`/api/jobs/${j.job_key}/run`, { method: "POST" });
                  setMessage(
                    res.data?.run ? `${j.name}: ${res.data.run.status} — ${res.data.run.outcome_summary}` : `Run failed (HTTP ${res.status}).`,
                  );
                  jobs.reload();
                }}
              >
                Run it now
              </button>
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
        })}
        {!jobs.loading && (jobs.data?.jobs ?? []).length === 0 && <li className="state-empty">No jobs defined. A scheduled job names its target employee or machine, its budget, and its data class — and always starts switched off.</li>}
      </ul>

    </section>
  );
}
