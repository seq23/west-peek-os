import type { FundPriority } from "./recommendedTeam";

/**
 * Recommended recurring work (P26 §6).
 *
 * This does NOT schedule anything and is NOT a second scheduler. It produces *proposals* shaped to
 * the existing `scheduled_job` contract, so the operator can see what would be created before
 * anything is. Creation stays on the existing governed path, and every proposal is `PAUSED`:
 *
 *   > "Every job starts PAUSED. Switching one on is a deliberate act, and the page says so."
 *   > — src/client/pages/JobsPage.tsx
 *
 * The enums below are not invented. They mirror the CHECK constraints in
 * `migrations/0018_orchestration.sql`, and `tests/recommended-jobs.test.ts` asserts every proposal
 * satisfies them — so a proposal that the database would reject fails in CI rather than at the
 * operator's hands.
 */

/** Mirrors CHECK (kind IN (...)) on scheduled_job. */
export const JOB_KINDS = ["INTELLIGENCE", "PORTFOLIO_EVALUATION", "EMPLOYEE_TASK"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Mirrors CHECK (schedule_kind IN (...)). */
export const SCHEDULE_KINDS = ["INTERVAL", "DAILY_AT"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** Mirrors CHECK (target_kind IN (...)). */
export const TARGET_KINDS = ["SYSTEM", "MACHINE", "EMPLOYEE"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export interface JobProposal {
  job_key: string;
  name: string;
  kind: JobKind;
  schedule_kind: ScheduleKind;
  /** Set iff schedule_kind === "INTERVAL". */
  interval_minutes?: number;
  /** Set iff schedule_kind === "DAILY_AT". UTC "HH:MM". */
  daily_at_utc?: string;
  target_kind: TargetKind;
  /** Required unless target_kind === "SYSTEM". For EMPLOYEE targets this is the roster NAME. */
  target_name?: string;
  /**
   * Data class the job would run under. Deliberately never above INTERNAL: the enabled provider
   * lane (OpenRouter) is permitted PUBLIC and INTERNAL only, so proposing a CONFIDENTIAL job would
   * be proposing something the egress policy will refuse.
   */
  data_class: "PUBLIC" | "INTERNAL";
  /** Why this job exists, in the operator's language. */
  purpose: string;
  /** Plain-language cadence, for humans. The machine-readable truth is the fields above. */
  cadence: string;
  /** Which stated firm priority this serves. */
  priority: FundPriority;
  /** Roster names that must be ACTIVE for this job to run. Empty = system-level. */
  requiresEmployees: string[];
}

/**
 * The proposals.
 *
 * Every one maps to a real `kind`. The brief lists ten desirable jobs; only those the existing
 * product can honestly support are proposed here — the schema has three job kinds, not ten, so
 * inventing a "LP_PIPELINE" kind to look complete would produce a row the database rejects.
 */
const PROPOSALS: readonly JobProposal[] = [
  {
    job_key: "daily_intelligence_briefing",
    name: "Daily intelligence briefing",
    kind: "INTELLIGENCE",
    schedule_kind: "DAILY_AT",
    daily_at_utc: "11:00",
    target_kind: "SYSTEM",
    data_class: "INTERNAL",
    purpose:
      "One briefing each morning covering what moved overnight, so the day starts from a summary " +
      "rather than from twelve open tabs.",
    cadence: "Every day at 11:00 UTC",
    priority: "DEAL_SOURCING",
    requiresEmployees: [],
  },
  {
    job_key: "wednesday_mp_meeting_prep",
    name: "Wednesday MP meeting preparation",
    kind: "EMPLOYEE_TASK",
    schedule_kind: "DAILY_AT",
    daily_at_utc: "12:00",
    target_kind: "EMPLOYEE",
    target_name: "Wren",
    data_class: "INTERNAL",
    purpose:
      "Assembles the agenda, the changes since last Wednesday and the open decisions before the " +
      "meeting rather than during it. The firm's cadence is Wednesday to Wednesday.",
    cadence: "Daily at 12:00 UTC, so the pack is ready ahead of Wednesday",
    priority: "WEDNESDAY_MP_MEETING",
    requiresEmployees: ["Wren"],
  },
  {
    job_key: "deal_watchlist_monitor",
    name: "Deal-flow and watchlist monitoring",
    kind: "INTELLIGENCE",
    schedule_kind: "INTERVAL",
    interval_minutes: 360,
    target_kind: "EMPLOYEE",
    target_name: "Wyatt",
    data_class: "INTERNAL",
    purpose:
      "Watches the companies and signals already on the list so movement surfaces on its own. " +
      "Pre-seed sourcing is continuous monitoring, not a weekly search.",
    cadence: "Every 6 hours",
    priority: "DEAL_SOURCING",
    requiresEmployees: ["Wyatt"],
  },
  {
    job_key: "lp_pipeline_monitor",
    name: "LP pipeline movement monitoring",
    kind: "EMPLOYEE_TASK",
    schedule_kind: "DAILY_AT",
    daily_at_utc: "13:00",
    target_kind: "EMPLOYEE",
    target_name: "Wesley",
    data_class: "INTERNAL",
    purpose:
      "Tracks movement and follow-ups across the Fund I pipeline so the raise does not depend on " +
      "whichever partner last had time.",
    cadence: "Every day at 13:00 UTC",
    priority: "FUNDRAISING_LP",
    requiresEmployees: ["Wesley"],
  },
  {
    job_key: "diligence_ic_preparation",
    name: "Diligence and IC preparation",
    kind: "EMPLOYEE_TASK",
    schedule_kind: "DAILY_AT",
    daily_at_utc: "14:00",
    target_kind: "EMPLOYEE",
    // Poppy, not "Paige" — who is not, and has never been, on the roster. `requiresEmployees` looks
    // her up, never finds her, and reports her missing, so this job could never once be proposed:
    // the firm's only automated route from active diligence to an IC brief was dead on arrival and
    // silent about it. Poppy is the IC Facilitator and assembling the packet is literally her stated
    // job, so this is a correction rather than a reassignment.
    target_name: "Poppy",
    data_class: "INTERNAL",
    purpose:
      "Assembles evidence for companies under active diligence so an IC discussion starts from a " +
      "brief instead of a blank page.",
    cadence: "Every day at 14:00 UTC",
    priority: "DILIGENCE_IC",
    requiresEmployees: ["Poppy"],
  },
  {
    job_key: "portfolio_support_monitor",
    name: "Portfolio support monitoring",
    kind: "PORTFOLIO_EVALUATION",
    schedule_kind: "INTERVAL",
    interval_minutes: 1440,
    target_kind: "EMPLOYEE",
    target_name: "Winter",
    data_class: "INTERNAL",
    purpose:
      "Surfaces portfolio companies that need attention before the need becomes urgent.",
    cadence: "Once a day",
    priority: "PORTFOLIO_COMMUNITY",
    requiresEmployees: ["Winter"],
  },
  {
    job_key: "integration_health_monitor",
    name: "Integration and provider health monitoring",
    kind: "INTELLIGENCE",
    schedule_kind: "INTERVAL",
    interval_minutes: 720,
    target_kind: "SYSTEM",
    data_class: "PUBLIC",
    purpose:
      "Checks that configured integrations still answer, so a silent provider failure is noticed " +
      "by the system rather than by a partner wondering why nothing ran.",
    cadence: "Every 12 hours",
    priority: "COMPLIANCE_SAFEGUARDS",
    requiresEmployees: [],
  },
];

export interface JobRecommendation extends JobProposal {
  /** True when every required employee is ACTIVE. */
  canRunNow: boolean;
  /** Why it cannot run, if it cannot. Always actionable. */
  blockers: string[];
  /** True when a job with this key already exists. */
  alreadyExists: boolean;
  existingStatus?: string;
}

export function recommendJobs(
  activeEmployeeNames: ReadonlySet<string>,
  existingJobs: ReadonlyMap<string, string> = new Map(),
  aiProviderConfigured = true,
): JobRecommendation[] {
  return PROPOSALS.map((p) => {
    const missing = p.requiresEmployees.filter((n) => !activeEmployeeNames.has(n));
    const blockers: string[] = [];
    if (missing.length > 0) {
      blockers.push(
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not active. ` +
          "Request activation on Team → Employees — it needs a Managing Partner approval receipt.",
      );
    }
    if (!aiProviderConfigured) {
      blockers.push(
        "No AI provider is enabled, so no scheduled work can run. Configure one under More / System → Integrations.",
      );
    }
    const existingStatus = existingJobs.get(p.job_key);
    return {
      ...p,
      blockers,
      canRunNow: blockers.length === 0,
      alreadyExists: existingStatus !== undefined,
      ...(existingStatus !== undefined ? { existingStatus } : {}),
    };
  });
}

/** The status any newly created job must carry. Exported so no caller can quietly differ. */
export const PROPOSED_JOB_STATUS = "PAUSED" as const;
