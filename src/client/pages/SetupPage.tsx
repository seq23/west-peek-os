import { useApi, type MeResponse } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import {
  PRIORITY_LABEL,
  recommendTeam,
  type Recommendation,
} from "@shared/setup/recommendedTeam";
import {
  readinessFor,
  type EmployeeReadiness,
  type MachineStatus,
} from "@shared/setup/employeeReadiness";
import { PROPOSED_JOB_STATUS, recommendJobs } from "@shared/setup/recommendedJobs";

/**
 * Set Up West Peek OS (P26 §4) — the revisitable guided-readiness surface.
 *
 * Two rules shape this page.
 *
 *   COMPLETION IS DERIVED, NEVER DECLARED. Slot usage and every employee's status come from the
 *   live workforce API. Nothing here keeps its own idea of "done", so revisiting the page after a
 *   change shows the change rather than a stale checklist.
 *
 *   IT RECOMMENDS; IT DOES NOT ACT. Activation needs an approved `ai_employee.activate` receipt and
 *   is capped server-side. This page explains and prepares — the governed step stays on Employees,
 *   where the receipt path lives. A setup wizard that could activate would be a way around the
 *   cap, so this one cannot.
 */

interface LoungeEmployee {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface MachineRow {
  id: number;
  /*
   * `key`, and the name matters. `/api/machines/control-center` serves the registry column as
   * `key`; this interface declared `machine_key`, so `m.machine_key` was `undefined` at runtime on
   * every row while TypeScript stayed happy — a shape mismatch a type cannot catch because the type
   * was the thing that was wrong.
   *
   * The consequence was not subtle: `machineStatusByKey` came out keyed `undefined`, so
   * `employeeReadiness` found NO assigned machine present and reported every recommended role as
   * "3 assigned machine(s) are not present on the server … the registry and the server disagree."
   * The guided-setup page — the first surface a new operator reads — told them the system was
   * broken when all 46 machines were there. Caught by `e2e/p27-guided-setup.spec.ts`.
   */
  key: string;
  name: string;
  status: string;
}

interface LoungeResponse {
  employees: LoungeEmployee[];
  active_count: number;
  max_active: number;
  activation_law: string;
}

function statusTag(status: string | undefined): { label: string; tone: string } {
  switch (status) {
    case "ACTIVE":
      return { label: "Active", tone: "good" };
    case "CANDIDATE":
      return { label: "Requested — pending approval", tone: "warn" };
    case "PAUSED":
      return { label: "Paused", tone: "warn" };
    case "RESTRICTED":
      return { label: "Restricted", tone: "warn" };
    case "RETIRED":
      return { label: "Retired", tone: "muted" };
    case "INACTIVE":
      return { label: "Not activated", tone: "muted" };
    case undefined:
      return { label: "Not on this firm's roster", tone: "muted" };
    default:
      return { label: status, tone: "muted" };
  }
}

function RecommendationRow({
  rec,
  live,
  slotsFree,
  readiness,
  dependenciesLoaded,
}: {
  rec: Recommendation;
  live: LoungeEmployee | undefined;
  slotsFree: boolean;
  readiness: EmployeeReadiness | null;
  dependenciesLoaded: boolean;
}): JSX.Element {
  const tag = statusTag(live?.status);
  const isActive = live?.status === "ACTIVE";
  const blocked = !isActive && !slotsFree;

  return (
    <li className="card" data-testid={`setup-rec-${rec.name.toLowerCase()}`}>
      <p>
        <strong>
          {rec.rank}. {rec.name}
        </strong>{" "}
        — {rec.role} <span className={`help-tag help-tag-${tag.tone}`}>{tag.label}</span>
      </p>
      <p className="muted small">
        Answers: <strong>{PRIORITY_LABEL[rec.priority]}</strong>
      </p>
      <p>{rec.because}</p>
      {isActive && (
        <p className="muted small" data-testid={`setup-rec-done-${rec.name.toLowerCase()}`}>
          Already active — nothing to do.
        </p>
      )}
      {blocked && (
        <p className="notice" data-testid={`setup-rec-blocked-${rec.name.toLowerCase()}`}>
          Blocked: every activation slot is in use. Pause or retire an active employee on Employees
          before requesting this one.
        </p>
      )}
      {!isActive && !blocked && (
        <p className="muted small">
          To activate: open <strong>Team → Employees</strong>, find {rec.name}, and request
          activation there. It needs a Managing Partner approval receipt — this page cannot grant one.
        </p>
      )}

      {/* §5 — what this role works through, and whether it can actually work. */}
      {!dependenciesLoaded && (
        <p className="muted small" data-testid={`setup-deps-unknown-${rec.name.toLowerCase()}`}>
          Dependency status unavailable — the machine or provider service did not answer, so this
          page will not claim the role can work.
        </p>
      )}
      {dependenciesLoaded && readiness && (
        <div data-testid={`setup-readiness-${rec.name.toLowerCase()}`}>
          <p className="muted small">
            Works through:{" "}
            {readiness.machines.length === 0
              ? "no machine assigned"
              : readiness.machines
                  .map((m) => `${m.name}${m.status === "PAUSED" ? " (paused)" : ""}`)
                  .join(", ")}
          </p>
          <p>
            <span
              className={
                readiness.state === "READY"
                  ? "help-tag help-tag-good"
                  : readiness.state === "BLOCKED"
                    ? "help-tag help-tag-warn"
                    : "help-tag help-tag-muted"
              }
              data-testid={`setup-readiness-state-${rec.name.toLowerCase()}`}
            >
              {readiness.state === "READY"
                ? "Can work now"
                : readiness.state === "BLOCKED"
                  ? "Blocked"
                  : "Not activated"}
            </span>{" "}
            {readiness.summary}
          </p>
          {readiness.blockers.length > 0 && (
            <ul className="card-list small" data-testid={`setup-blockers-${rec.name.toLowerCase()}`}>
              {readiness.blockers.map((b) => (
                <li key={b.kind}>
                  <strong>{b.detail}</strong> {b.action}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function SetupPage({ me }: { me: MeResponse }): JSX.Element {
  const lounge = useApi<LoungeResponse>("/api/workforce/lounge");
  const fleet = useApi<{ machines: MachineRow[] }>("/api/machines/control-center");
  const providers = useApi<{ providers: Array<{ provider_key: string; enabled: number; kill_switched: number }> }>(
    "/api/ai/providers",
  );

  // The cap is authoritative from the server. Until it loads we recommend nothing rather than
  // guessing a number and rendering a list the server might refuse.
  const cap = lounge.data?.max_active ?? 0;
  const plan = recommendTeam(cap);
  const byName = new Map((lounge.data?.employees ?? []).map((e) => [e.name, e]));

  // §5 — the dependency chain, from live state only. A provider counts as usable when it is
  // enabled and not kill-switched; whether its credential is bound is a Worker-side fact the
  // client cannot see, so this is deliberately the weaker of the two claims.
  const aiProviderConfigured = (providers.data?.providers ?? []).some(
    (p) => p.enabled === 1 && p.kill_switched === 0,
  );
  const machineStatusByKey = new Map<string, MachineStatus>(
    (fleet.data?.machines ?? []).map((m) => [
      m.key,
      { key: m.key, name: m.name, status: m.status },
    ]),
  );
  const employeeStatusByName = new Map(
    (lounge.data?.employees ?? []).map((e) => [e.name, e.status]),
  );
  const readinessInputs = { employeeStatusByName, machineStatusByKey, aiProviderConfigured };
  const dependenciesLoaded = Boolean(fleet.data && providers.data);

  // §6 — recurring work proposals. Existing jobs are read so an already-created job is reported
  // rather than proposed a second time.
  const jobs = useApi<{ jobs: Array<{ job_key: string; status: string }> }>("/api/jobs");
  const activeNames = new Set(
    (lounge.data?.employees ?? []).filter((e) => e.status === "ACTIVE").map((e) => e.name),
  );
  const existingJobs = new Map((jobs.data?.jobs ?? []).map((j) => [j.job_key, j.status]));
  const jobPlan = recommendJobs(activeNames, existingJobs, aiProviderConfigured);
  // A blocker is a claim about live state. Until the roster, the providers and the existing jobs
  // have all arrived, "No AI provider" would be a claim about data the page has not read — it
  // flashed as Blocked and then vanished, and p27 caught the flash. Nothing is proposed before
  // every input is in.
  const jobPlanLoaded = Boolean(lounge.data && providers.data && jobs.data);
  const activeCount = lounge.data?.active_count ?? 0;
  const slotsFree = cap > 0 && activeCount < cap;

  return (
    <section data-testid="setup-page">
      <HowThisWorks
        testId="setup"
        title="Set Up West Peek OS"
        what="A revisitable readiness check: what the firm has configured, which AI employees are recommended, and what is still waiting on a decision."
        when="On first use, and any time you want to know what is left to set up. It is safe to open at any point — it changes nothing on its own."
        operatorDoes={[
          "Read the recommended starting team and why each role is proposed.",
          "Adjust the recommendation if the firm's priorities differ.",
          "Request activation on Employees for the ones you want.",
        ]}
        aiDoes={[
          "Reads the live roster and your current activation slots.",
          "Ranks a starting team against the firm's stated priorities and explains each choice.",
        ]}
        requiresOperator={[
          "Every activation. This page never activates anyone — the cap and the approval receipt are enforced by the server.",
        ]}
        next="Once an employee is active, connect them to recurring work under Work → Scheduled Work."
        blocked={[
          "All activation slots are in use — pause or retire someone first.",
          "An activation request is waiting for a Managing Partner approval receipt.",
        ]}
      />

      <p className="surface-lede">
        {me.fullName}, this is what West Peek OS recommends next. Nothing on this page takes effect
        by itself.
      </p>

      {lounge.loading && <p className="muted small" data-testid="setup-loading">Reading the live roster…</p>}

      {!lounge.loading && !lounge.data && (
        <p className="notice" data-testid="setup-unavailable">
          The workforce service did not answer, so no recommendation can be made. This page will not
          guess a roster or a slot count.
        </p>
      )}

      {lounge.data && (
        <>
          <p data-testid="setup-slots" className="muted small">
            <strong>
              {activeCount} of {cap} activation slots in use.
            </strong>{" "}
            {lounge.data.activation_law}
          </p>

          <h3>Recommended starting team</h3>
          <ul className="card-list" data-testid="setup-recommended">
            {plan.recommended.map((rec) => (
              <RecommendationRow
                key={rec.name}
                rec={rec}
                live={byName.get(rec.name)}
                slotsFree={slotsFree}
                readiness={readinessFor(rec.name, readinessInputs)}
                dependenciesLoaded={dependenciesLoaded}
              />
            ))}
          </ul>

          {plan.uncoveredPriorities.length > 0 && (
            <p className="notice" data-testid="setup-uncovered">
              The cap of {cap} means{" "}
              {plan.uncoveredPriorities.map((p) => PRIORITY_LABEL[p]).join(", ")}{" "}
              {plan.uncoveredPriorities.length === 1 ? "is" : "are"} not covered by the recommended
              team. That is a trade-off, not an oversight — the roles below would cover it.
            </p>
          )}

          {plan.alsoConsidered.length > 0 && (
            <>
              <h3>Also considered</h3>
              <ul className="card-list" data-testid="setup-also-considered">
                {plan.alsoConsidered.map((rec) => (
                  <li key={rec.name} className="card">
                    <p>
                      <strong>{rec.name}</strong> — {rec.role}
                    </p>
                    <p className="muted small">Would answer: {PRIORITY_LABEL[rec.priority]}</p>
                    <p>{rec.because}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Recommended recurring work</h3>
          <p className="muted small" data-testid="setup-jobs-law">
            Every proposal below would be created <strong>{PROPOSED_JOB_STATUS}</strong>. Nothing
            starts running on its own — switching a job on is a separate, deliberate act on{" "}
            <strong>Work → Scheduled Work</strong>.
          </p>
          {/*
            * THE LOADING ROW LIVES IN THE LIST'S OWN SLOT (20 Sep 2026). It used to be a paragraph
            * beside an empty <ul>, so while the three fetches were in flight a reader saw a blank
            * list — and the design-state sweep said so on main, where the journeys run twice on
            * one runner and the second pass outlasted its settle budget. Loading and empty share
            * one slot, told apart by tone, never a blank: the same shape the Employees lists took
            * on 18 Sep for the same reason.
            */}
          <ul className="card-list" data-testid="setup-jobs" data-loaded={jobPlanLoaded ? "true" : "false"}>
            {!jobPlanLoaded && (
              <li className="state-message" data-testid="setup-jobs-loading">
                Reading the roster, the AI providers and the existing jobs…
              </li>
            )}
            {jobPlanLoaded && jobPlan.map((j) => (
              <li key={j.job_key} className="card" data-testid={`setup-job-${j.job_key}`}>
                <p>
                  <strong>{j.name}</strong>{" "}
                  {j.alreadyExists ? (
                    <span className="help-tag help-tag-good">
                      Already created — {j.existingStatus}
                    </span>
                  ) : j.canRunNow ? (
                    <span className="help-tag help-tag-good">Ready to create</span>
                  ) : (
                    <span className="help-tag help-tag-warn">Blocked</span>
                  )}
                </p>
                <p className="muted small">
                  {j.cadence} · {j.kind} · data class {j.data_class}
                  {j.target_name ? ` · ${j.target_name}` : " · system"}
                </p>
                <p>{j.purpose}</p>
                {j.blockers.length > 0 && (
                  <ul className="card-list small" data-testid={`setup-job-blockers-${j.job_key}`}>
                    {j.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          {plan.unknownNames.length > 0 && (
            <p className="notice" data-testid="setup-roster-drift">
              {plan.unknownNames.join(", ")} {plan.unknownNames.length === 1 ? "is" : "are"} no
              longer on the roster and {plan.unknownNames.length === 1 ? "was" : "were"} dropped from
              the recommendation rather than substituted.
            </p>
          )}
        </>
      )}
    </section>
  );
}
