import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";

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
}

function runBadge(status: string): string {
  if (status === "SUCCEEDED") return "badge badge-ok";
  if (status === "REFUSED") return "badge badge-gate";
  if (status === "FAILED" || status === "DEAD_LETTER") return "badge badge-bad";
  return "badge";
}

function schedule(job: Job): string {
  return job.schedule_kind === "INTERVAL" ? `every ${job.interval_minutes} min` : `daily at ${job.daily_at_utc} UTC`;
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
      <p className="muted small" data-testid="jobs-architecture">
        {jobs.data?.architecture}
      </p>
      <p className="muted small">
        A cron trigger cannot fire in local development. The tick below runs the same code path the
        trigger calls, which proves the path — not that Cloudflare fired it.
      </p>

      <div className="form-row">
        <input data-testid="job-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (for start/stop)" />
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
          Run due jobs now
        </button>
      </div>
      {message && <p className="notice" data-testid="jobs-message">{message}</p>}

      <ul className="card-list" data-testid="job-list">
        {(jobs.data?.jobs ?? []).map((j) => (
          <li key={j.id} className="card" data-testid={`job-${j.job_key}`}>
            <p>
              <strong>{j.name}</strong>{" "}
              <span className={j.status === "ACTIVE" ? "badge badge-ok" : "badge badge-gate"}>{j.status}</span>{" "}
              <span className="badge">{j.kind}</span>
              {j.dead_letters > 0 && <span className="badge badge-bad">{j.dead_letters} dead-letter</span>}
            </p>
            <p className="muted small">
              {schedule(j)} · target {j.target_kind}
              {j.target_id ? ` ${j.target_id}` : ""} · data class {j.data_class} · up to {j.max_attempts} attempt(s)
              {j.next_run_at ? ` · next ${j.next_run_at}` : " · not scheduled"}
            </p>
            {j.pause_reason && <p className="muted small">Paused because: {j.pause_reason}</p>}

            <div className="form-row">
              <button
                type="button"
                data-testid={`job-toggle-${j.job_key}`}
                onClick={async () => {
                  const res = await api<{ error?: string }>(`/api/jobs/${j.job_key}/status`, {
                    method: "POST",
                    body: { status: j.status === "ACTIVE" ? "PAUSED" : "ACTIVE", reason: reason || `operator action by ${me.fullName}` },
                  });
                  setMessage(res.status === 200 ? `${j.job_key} is now ${j.status === "ACTIVE" ? "PAUSED" : "ACTIVE"}.` : `Refused (HTTP ${res.status}).`);
                  jobs.reload();
                }}
              >
                {j.status === "ACTIVE" ? "Pause" : "Switch on"}
              </button>
              <button
                type="button"
                data-testid={`job-run-${j.job_key}`}
                onClick={async () => {
                  const res = await api<{ run?: { status: string; outcome_summary: string } }>(`/api/jobs/${j.job_key}/run`, { method: "POST" });
                  setMessage(
                    res.data?.run ? `${j.job_key}: ${res.data.run.status} — ${res.data.run.outcome_summary}` : `Run failed (HTTP ${res.status}).`,
                  );
                  jobs.reload();
                }}
              >
                Run now
              </button>
            </div>

            {/* The run trail is folded away. It is the right thing to KEEP — a job that says it
                succeeded while keeping zero items is only visible in its history — and the wrong
                thing to lead with: four identical SUCCEEDED lines per job pushed the next job off
                the screen, so the page read as a log rather than as a list of what runs. The
                summary line carries whether the last run was healthy; the detail is one click away. */}
            {j.recent_runs.length === 0 ? (
              <p className="muted small" data-testid={`job-runs-${j.job_key}`}>Never run.</p>
            ) : (
              <details data-testid={`job-runs-${j.job_key}`}>
                <summary>
                  <span className={runBadge(j.recent_runs[0]!.status)}>{j.recent_runs[0]!.status}</span>{" "}
                  last run {new Date(j.recent_runs[0]!.started_at).toLocaleString()}
                  {j.recent_runs.length > 1 ? ` · ${j.recent_runs.length} runs recorded` : ""}
                </summary>
                <ul className="card-list small">
                  {j.recent_runs.map((r) => (
                    <li key={r.id}>
                      <span className={runBadge(r.status)}>{r.status}</span> attempt {r.attempt} · {r.trigger_kind} ·{" "}
                      {new Date(r.started_at).toLocaleString()}
                      {r.outcome_summary ? ` — ${r.outcome_summary}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
        {!jobs.loading && (jobs.data?.jobs ?? []).length === 0 && <li className="state-empty">No jobs defined. A scheduled job names its target employee or machine, its budget, and its data class — and always starts PAUSED.</li>}
      </ul>
    </section>
  );
}
