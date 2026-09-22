import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { JOB_FACTS, cadenceInWords, delivererLine, delivererNames, isOnRequest } from "@shared/work/scheduledWork";
import { CARD_OPENING_JOB_KEYS, PREVIEW_COST_NOTICE, PREVIEW_RECIPIENT } from "@shared/work/preview";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";
import { isOneOffMachineryCard, oneOffTag, sortOnAClock, sortOneOff } from "@shared/work/machinery";
import { heldBySentence } from "@shared/work/workCards";
import { shortDate } from "../lib/dates";
import type { WorkCardRow } from "./work/types";

/**
 * Governed orchestration (P19; GAP-21, GAP-22) — and, since 22 Sep 2026, the whole of Machinery.
 *
 * MACHINERY IS A LENS, NOT A PLACE (Addendum 4 item 2 / Addendum 5 & 5.1). Work, Machinery and
 * Record all read the same rows; Machinery's question is RHYTHM — recurring, or one-off — never
 * who or what started a card, which is a tag on the row, not a bucket boundary.
 *
 * TWO BUCKETS, NOT THREE, EACH A STACK OF COLLAPSED ROWS (superseding the 15 Sep two-section, full-
 * card design below):
 *
 *   ON A CLOCK — every `scheduled_job`, timed or on-request; a job is machinery whether or not it
 *   has a literal hour, because either way it runs without her pressing anything but a manual
 *   override. Sorted by literal time of day, earliest to latest — the one thing "order of the day"
 *   can mean for a job — with an interval job (no single moment) after the timed ones and an
 *   on-request job (no clock at all) last of all (`sortOnAClock`, `shared/work/machinery.ts`).
 *
 *   ONE-OFF — every single-instance `work_card` that is moving on its own: an authenticated
 *   partner email, which started itself the moment it arrived; a card she created and is holding
 *   for later, sitting on her one flip; or a card a SCHEDULED JOB opened on its own cadence
 *   (`cardKinds.ts`'s `door: "JOB"` — November's Room packet, this month's Productions press, a
 *   sent-back deck's rework) — the card is a single instance even though the job behind it recurs,
 *   which is Record's `isRecurringKind` axis (`shared/work/recurring.ts`), reused rather than
 *   re-decided so the two surfaces cannot disagree. A card she created and started BY HAND through
 *   the ordinary Work flow is deliberately excluded — she pressed something, so it is not
 *   machinery, it is her working (`isOneOffMachineryCard`). Sorted by arrival, earliest to latest.
 *   Each row carries an origin tag ("from Scooter", "from the scheduled sweep", "held by you") and
 *   a not-yet-started row gets an inline flip-on control that calls Wave D's `/release` directly —
 *   no separate page visit.
 *
 * EACH ROW IS ONE LINE, COLLAPSED, NOT A FULL CARD. A job row expands in place (`<details>`) to
 * the facts, the run history and its controls — nothing here duplicates a work card's own page
 * because a job is not one. A one-off row's "expand" is its link into `#/work/<id>`, which already
 * carries Wave A's full shape; a second, inline renderer of the same page would be two places that
 * shape could drift apart.
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
  day_of_week?: number | null;
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
  /**
   * THE SAME UNDERLYING ROWS WORK AND RECORD ALSO SHOW (Addendum 5). A second, independent read of
   * `/api/work-cards/by-owner` rather than a prop threaded down from `WorkCardsPage` — the same
   * "each surface owns its own fetch" shape `WorkRecordView` already uses for Record, and it keeps
   * this page's contract with `App.tsx` (a bare `<JobsPage me={...} />`) unchanged.
   */
  const board = useApi<{ cards: WorkCardRow[] }>("/api/work-cards/by-owner");
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

  /**
   * SEE IT BEFORE IT HAPPENS — the real note, in her inbox, changing nothing.
   *
   * WHY A BUTTON RATHER THAN A COMMAND. Production is behind Cloudflare Access, so the alternative
   * was handing the owner a curl line and an Access token to fetch first. She is already signed in
   * on this page; the browser is the credential.
   *
   * IT SAYS WHAT IT COSTS BEFORE IT RUNS, because it is not a dry run. Real searches, real model
   * calls, real money against the firm's caps — the only things that differ from the scheduled run
   * are that the mail goes to her alone and that nothing is written.
   */
  async function previewIt(j: Job): Promise<void> {
    const ok = window.confirm(
      `Preview "${j.name}"?\n\n${PREVIEW_COST_NOTICE}\n\nThe result is emailed to ${PREVIEW_RECIPIENT} and to nobody else, whoever it would normally go to. Nothing is filed, no card is closed, and the scheduled run still has all its work to do.`,
    );
    if (!ok) return;
    setMessage(`Previewing "${j.name}" — this does the real work, so give it a minute.`);
    const res = await api<{ preview?: { detail: string; sent_to: string; blocked: boolean }; error?: string; detail?: string }>(
      "/api/preview",
      { method: "POST", body: { kind: "JOB", key: j.job_key } },
    );
    const p = res.data?.preview;
    setMessage(
      p
        ? `${j.name}: ${p.blocked ? "stopped before sending" : "preview sent"} to ${p.sent_to} — ${p.detail}`
        : `Preview failed (HTTP ${res.status})${res.data?.detail ? ` — ${res.data.detail}` : ""}.`,
    );
  }

  /**
   * THE FLIP-ON CONTROL (Addendum 5.1), CALLING WAVE D'S OWN DOOR DIRECTLY. A one-off row that has
   * not started yet — held by her, at creation or afterwards — sits here until she presses this.
   * No separate page visit: the same `POST /api/work-cards/:id/release` the card page's own
   * "Release" button calls, re-queuing it fresh from the top and clearing the hold in one write.
   */
  async function releaseCard(c: WorkCardRow): Promise<void> {
    const res = await api<{ error?: string; detail?: string }>(`/api/work-cards/${c.id}/release`, { method: "POST" });
    setMessage(
      res.status === 200
        ? `${c.title}: turned on — it re-queues fresh, from the top, and now shows on Work too.`
        : `Could not turn it on: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
    board.reload();
  }

  const onAClock = sortOnAClock(jobs.data?.jobs ?? []);
  const oneOff = sortOneOff((board.data?.cards ?? []).filter((c) => isOneOffMachineryCard(c, me.id)));

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
        <details className="job-row" data-testid={`job-details-${j.job_key}`}>
          {/*
            THE ONE LINE, ALWAYS VISIBLE — `<summary>` is the part of a closed `<details>` a reader
            (and Playwright's `toBeVisible()`) can still see. State, name, whether it is stuck, and
            the honest cadence sentence live here; everything past that needs a press to see.
          */}
          <summary className="job-row-summary" data-testid={`job-summary-${j.job_key}`}>
            <span className={paused ? "badge badge-gate" : "badge badge-ok"} data-testid={`job-state-${j.job_key}`}>
              {paused ? "Paused" : asked ? "On request" : "Scheduled"}
            </span>
            <span className="job-card-title" style={{ fontWeight: 600 }}>{j.name}</span>
            {j.dead_letters > 0 && <span className="badge badge-bad">{j.dead_letters} stuck</span>}
            <span className="muted small" data-testid={`job-cadence-${j.job_key}`}>
              {names.length === 0 ? delivererLine(names) : <>By {names.map((n) => <Deliverer key={n} name={n} />)}</>}
              {" · "}{cadenceInWords(j)}
              {!paused && !asked ? (j.next_run_at ? ` · next ${new Date(j.next_run_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : " · not scheduled yet") : ""}
            </span>
          </summary>

          <div className="job-row-body">
            <p className="small">{facts?.what ?? "No description has been written for this job."}</p>
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
              {/* Only for the jobs whose work is a deliverable somebody receives. A tick that reads two
                  feeds has nothing to preview, and offering the button there would be a control that
                  answers "not previewable" — which is worse than no button. */}
              {CARD_OPENING_JOB_KEYS.includes(j.job_key) && (
                <button
                  type="button"
                  className="btn-ghost"
                  data-testid={`job-preview-${j.job_key}`}
                  title={`Runs it for real and emails the result to ${PREVIEW_RECIPIENT} only. Nothing is filed and the scheduled run is untouched.`}
                  onClick={() => void previewIt(j)}
                >
                  Preview it to me
                </button>
              )}
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
          </div>
        </details>
      </li>
    );
  };

  const oneOffRow = (c: WorkCardRow) => {
    const tag = oneOffTag(c, me.id);
    const notYetStarted = c.state === "HELD";
    const heldSentence = notYetStarted
      ? heldBySentence({ held_reason: c.held_reason, held_by_name: c.held_by_name }, c.held_at ? shortDate(c.held_at) : "recently")
      : null;
    return (
      <li key={c.id} className="card job-card" data-testid={`oneoff-${c.id}`}>
        <div className="job-card-head">
          <span className="badge" data-testid={`oneoff-tag-${c.id}`}>{tag}</span>
          {/*
            EXPANDING IS THE LINK, NOT A SECOND RENDERER. `#/work/<id>` already carries Wave A's
            full section shape — origin, request, progress, the message trail, decisions,
            artifacts, comments. A one-off row's job is to say what it is and let her go there.
          */}
          <a className="job-card-title" href={`#/work/${c.id}`} data-testid={`oneoff-open-${c.id}`}>
            {c.title}
          </a>
        </div>
        <p className="muted small" data-testid={`oneoff-arrived-${c.id}`}>
          Arrived {shortDate(c.created_at)}
        </p>
        {heldSentence && (
          <p className="notice small" data-testid={`oneoff-held-${c.id}`}>
            {heldSentence}
          </p>
        )}
        {notYetStarted && (
          <div className="job-card-actions">
            <button type="button" className="btn-strong" data-testid={`oneoff-release-${c.id}`} onClick={() => void releaseCard(c)}>
              Turn it on
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <section data-testid="jobs-page">
      <HowThisWorks
        testId="jobs"
        title="Machinery"
        what="Two kinds of work that move without you pressing anything, unless they block: recurring duties on a clock — the Daily Brief, sweeps, monitoring, meeting preparation — and one-off work that started itself, either an assignment that arrived by partner email or something you created and are holding until you flip it on."
        when="When something should happen every day, every week or every month without being asked; when you want to know why a recurring job is not running; and when you want to see, or start, a one-off card nobody has had to touch yet."
        operatorDoes={[
          "Open a row for what it does, how often, and its run history.",
          "Press Run it now on anything on a clock, scheduled or on request.",
          "Pause a job with a reason, and put it back on when the reason has passed.",
          "Turn on a one-off card you are holding, right from its row.",
        ]}
        aiDoes={[
          "Runs each scheduled job on its cadence, and each on-request job when asked.",
          "Opens a one-off card the moment an authenticated partner email asks for it.",
          "Records each run, refusal, failure and retry.",
        ]}
        requiresOperator={[
          "Pausing a job — it needs a stated reason, shown beside the row.",
          "Turning on a card she is holding — it does not start itself.",
          "Anything the job would do that is itself a reserved action.",
        ]}
        next="A scheduled job runs on its cadence and its results appear in its run history. An assignment is already on the Desk the moment it arrives. A held one-off card waits, silently, until she turns it on."
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

      <h3>On a clock</h3>
      <p className="muted small">
        Every scheduled job, on a clock and on request — sorted by time of day, earliest to latest. Open a row for what it does.
      </p>
      <ul className="job-grid" data-testid="job-list">
        {onAClock.map(row)}
        {/* Loading is a state, not a gap — see the note on `room-list` in EmployeesPage.tsx. */}
        {jobs.loading && <li className="state-empty">Reading the clock…</li>}
        {!jobs.loading && onAClock.length === 0 && <li className="state-empty">Nothing is on a clock. A scheduled job names its target employee or machine, its budget, and its data class.</li>}
      </ul>

      <h3>One-off</h3>
      <p className="muted small">
        Every single-instance card moving on its own — an assignment that arrived by partner email, already running, or something you
        created and are holding until you flip it on — sorted by when it arrived, earliest to latest.
      </p>
      <ul className="job-grid" data-testid="oneoff-list">
        {oneOff.map(oneOffRow)}
        {board.loading && <li className="state-empty">Reading one-off work…</li>}
        {!board.loading && oneOff.length === 0 && (
          <li className="state-empty">Nothing one-off is moving on its own right now — an assignment shows here the moment it arrives.</li>
        )}
      </ul>
    </section>
  );
}
