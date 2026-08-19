/**
 * "What needs my attention, and what is blocked?" (P26 §8)
 *
 * Home already answers most of the operator's questions through its server-driven modules —
 * approvals, what changed, open work, LP signals, meetings. Four of the questions in the brief had
 * no answer anywhere: what is BLOCKED, whether scheduled work is HEALTHY, whether AI is FAILING or
 * REFUSING, and whether setup is INCOMPLETE.
 *
 * This computes exactly those four, and only from state the caller already holds. It invents no
 * metric, estimates nothing, and has no data source of its own — if an input is absent the item is
 * omitted rather than guessed, because a fabricated number on a command surface is worse than a
 * missing one.
 *
 * Ordering is by consequence, not by category: a dead-lettered job that silently stopped running
 * outranks a cosmetic gap. Every item carries the surface that resolves it.
 */

export type AttentionSeverity = "BLOCKING" | "DEGRADED" | "INFO";

export interface AttentionItem {
  key: string;
  severity: AttentionSeverity;
  /** What is wrong, in the operator's language. */
  headline: string;
  /** The single next action. */
  action: string;
  /** Nav key of the surface that resolves it. */
  link: string;
}

export interface JobHealth {
  job_key: string;
  name: string;
  status: string;
  pause_reason?: string | null;
  dead_letters?: number;
  recent_runs?: Array<{ status: string }>;
}

export interface AttentionInputs {
  jobs?: JobHealth[];
  /** Roster names the operator was recommended but has not activated. */
  unactivatedRecommendations?: string[];
  /** True when at least one provider is enabled and usable. */
  aiProviderConfigured?: boolean;
  /** Employees whose work is blocked despite being active (e.g. every machine paused). */
  blockedActiveEmployees?: Array<{ name: string; reason: string }>;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  BLOCKING: 0,
  DEGRADED: 1,
  INFO: 2,
};

export function operatorAttention(inputs: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1 · No provider — nothing AI-driven can run at all.
  if (inputs.aiProviderConfigured === false) {
    items.push({
      key: "no-provider",
      severity: "BLOCKING",
      headline: "No AI provider is enabled, so no AI work can run.",
      action: "Configure a provider under More / System → Integrations.",
      link: "integrations",
    });
  }

  // 2 · Scheduled-work health. A dead letter means work stopped and nobody was told.
  const jobs = inputs.jobs ?? [];
  const deadLettered = jobs.filter((j) => (j.dead_letters ?? 0) > 0);
  if (deadLettered.length > 0) {
    items.push({
      key: "jobs-dead-letter",
      severity: "BLOCKING",
      headline: `${deadLettered.length} scheduled job(s) have work in the dead-letter state: ${deadLettered
        .map((j) => j.name)
        .join(", ")}. That work stopped and will not retry.`,
      action: "Review and clear them on Work → Scheduled Work.",
      link: "work-cards",
    });
  }

  const refused = jobs.filter((j) =>
    (j.recent_runs ?? []).some((r) => r.status === "REFUSED" || r.status === "FAILED"),
  );
  if (refused.length > 0) {
    items.push({
      key: "jobs-refused",
      severity: "DEGRADED",
      headline: `${refused.length} scheduled job(s) recently failed or were refused: ${refused
        .map((j) => j.name)
        .join(", ")}.`,
      action: "Open the job to see the refusal reason on Work → Scheduled Work.",
      link: "work-cards",
    });
  }

  const pausedWithReason = jobs.filter((j) => j.status === "PAUSED" && j.pause_reason);
  if (pausedWithReason.length > 0) {
    items.push({
      key: "jobs-paused",
      severity: "INFO",
      headline: `${pausedWithReason.length} scheduled job(s) are paused.`,
      action: "Switch on the ones that should be running, on Work → Scheduled Work.",
      link: "work-cards",
    });
  }

  // 3 · Active but unable to work. The most confusing state, so it is called out explicitly.
  for (const e of inputs.blockedActiveEmployees ?? []) {
    items.push({
      key: `employee-blocked-${e.name}`,
      severity: "DEGRADED",
      headline: `${e.name} is active but cannot work: ${e.reason}`,
      action: "Resolve the dependency, or pause the employee so the state is honest.",
      link: "employees",
    });
  }

  // 4 · Setup gaps. Lowest severity — a gap is not a fault.
  const unactivated = inputs.unactivatedRecommendations ?? [];
  if (unactivated.length > 0) {
    items.push({
      key: "setup-incomplete",
      severity: "INFO",
      headline: `${unactivated.length} recommended AI employee(s) are not activated: ${unactivated.join(", ")}.`,
      action: "Review the recommendation on Home → Set up.",
      link: "setup",
    });
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
