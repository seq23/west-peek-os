import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

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

            <ul className="card-list small" data-testid={`job-runs-${j.job_key}`}>
              {j.recent_runs.map((r) => (
                <li key={r.id}>
                  <span className={runBadge(r.status)}>{r.status}</span> attempt {r.attempt} · {r.trigger_kind} · {r.started_at}
                  {r.outcome_summary ? ` — ${r.outcome_summary}` : ""}
                </li>
              ))}
              {j.recent_runs.length === 0 && <li className="muted">Never run.</li>}
            </ul>
          </li>
        ))}
        {!jobs.loading && (jobs.data?.jobs ?? []).length === 0 && <li className="state-empty">No jobs defined. A scheduled job names its target employee or machine, its budget, and its data class — and always starts PAUSED.</li>}
      </ul>
    </section>
  );
}
