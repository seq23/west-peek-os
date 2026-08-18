import { AI_EMPLOYEE_ROSTER, type AIEmployeeRosterEntry } from "../registry/aiEmployees";

/**
 * Can this employee actually do work right now? (P26 §5)
 *
 * The dependency chain is real, not decorative:
 *
 *     employee status  →  the machines they are assigned to  →  a configured AI provider
 *
 * An employee who is ACTIVE but whose only machine is PAUSED cannot work — the pause is enforced
 * server-side when work is routed (`p17-machines.spec.ts` proves the API refuses it), so a UI that
 * showed them as ready would be lying about something the server will reject.
 *
 * Pure and injectable: every input is passed in. This module reaches nothing, so it cannot activate
 * an employee, resume a machine, or grant authority — it can only describe.
 *
 * BLOCKERS ARE ORDERED BY WHAT THE OPERATOR SHOULD FIX FIRST, and every one carries the action that
 * clears it. "Blocked" with no next step is the failure mode this replaces.
 */

export type ReadinessState = "READY" | "BLOCKED" | "NOT_ACTIVATED";

export type BlockerKind =
  | "EMPLOYEE_NOT_ACTIVE"
  | "EMPLOYEE_PAUSED"
  | "EMPLOYEE_RESTRICTED"
  | "EMPLOYEE_RETIRED"
  | "NO_AI_PROVIDER"
  | "ALL_MACHINES_PAUSED"
  | "SOME_MACHINES_PAUSED"
  | "MACHINE_MISSING";

export interface Blocker {
  kind: BlockerKind;
  /** What is wrong, in the operator's language. */
  detail: string;
  /** The single next action that clears it. */
  action: string;
  /** A blocker that stops work entirely, vs one that only narrows it. */
  fatal: boolean;
}

export interface MachineStatus {
  /** Registry key, e.g. "lp_fundraising". */
  key: string;
  name: string;
  /** "ACTIVE" | "PAUSED" | anything the server reports. */
  status: string;
}

export interface EmployeeReadiness {
  name: string;
  role: string;
  employeeStatus: string;
  state: ReadinessState;
  /** Machines this employee is assigned to, with live status. */
  machines: Array<MachineStatus & { known: boolean }>;
  blockers: Blocker[];
  /** One-line summary safe to render as the headline. */
  summary: string;
}

export interface ReadinessInputs {
  /** Live status by employee name. Absent means not present on the firm's roster. */
  employeeStatusByName: ReadonlyMap<string, string>;
  /** Live machine status by registry key. Absent means the machine is unknown to the server. */
  machineStatusByKey: ReadonlyMap<string, MachineStatus>;
  /** Whether at least one AI provider is enabled AND has its credential bound. */
  aiProviderConfigured: boolean;
}

function machineBlockers(
  machines: Array<MachineStatus & { known: boolean }>,
): Blocker[] {
  if (machines.length === 0) return [];
  const missing = machines.filter((m) => !m.known);
  const paused = machines.filter((m) => m.known && m.status === "PAUSED");
  const usable = machines.filter((m) => m.known && m.status !== "PAUSED");
  const out: Blocker[] = [];

  if (missing.length > 0) {
    out.push({
      kind: "MACHINE_MISSING",
      detail: `${missing.length} assigned machine(s) are not present on the server: ${missing
        .map((m) => m.key)
        .join(", ")}.`,
      action: "Check Machines under More / System — the registry and the server disagree.",
      fatal: usable.length === 0,
    });
  }
  if (paused.length > 0 && usable.length === 0) {
    out.push({
      kind: "ALL_MACHINES_PAUSED",
      detail: `Every machine this role works through is paused (${paused
        .map((m) => m.name || m.key)
        .join(", ")}). Work routed here will be refused.`,
      action: "Resume one of those machines under More / System → Machines.",
      fatal: true,
    });
  } else if (paused.length > 0) {
    out.push({
      kind: "SOME_MACHINES_PAUSED",
      detail: `${paused.length} of ${machines.length} machines are paused (${paused
        .map((m) => m.name || m.key)
        .join(", ")}). This role can still work, but not on everything.`,
      action: "Resume them under More / System → Machines if that work is needed.",
      fatal: false,
    });
  }
  return out;
}

function statusBlocker(status: string | undefined): Blocker | null {
  switch (status) {
    case "ACTIVE":
      return null;
    case "PAUSED":
      return {
        kind: "EMPLOYEE_PAUSED",
        detail: "This employee is paused and will not pick up work.",
        action: "Resume them on Team → Employees.",
        fatal: true,
      };
    case "RESTRICTED":
      return {
        kind: "EMPLOYEE_RESTRICTED",
        detail: "This employee is restricted; their permitted work is narrowed.",
        action: "Review the restriction on Team → Employees.",
        fatal: true,
      };
    case "RETIRED":
      return {
        kind: "EMPLOYEE_RETIRED",
        detail: "This employee is retired and cannot be assigned work.",
        action: "Choose a different role, or un-retire on Team → Employees.",
        fatal: true,
      };
    default:
      // INACTIVE, CANDIDATE, or absent from the firm's roster.
      return {
        kind: "EMPLOYEE_NOT_ACTIVE",
        detail:
          status === "CANDIDATE"
            ? "Activation has been requested and is waiting for a Managing Partner approval receipt."
            : "This employee is not activated, so they cannot do any work yet.",
        action:
          status === "CANDIDATE"
            ? "Approve the pending activation on Work → Approvals."
            : "Request activation on Team → Employees. It needs a Managing Partner receipt.",
        fatal: true,
      };
  }
}

export function readinessFor(
  employeeName: string,
  inputs: ReadinessInputs,
  roster: readonly AIEmployeeRosterEntry[] = AI_EMPLOYEE_ROSTER,
): EmployeeReadiness | null {
  const entry = roster.find((e) => e.name === employeeName);
  if (!entry) return null;

  const employeeStatus = inputs.employeeStatusByName.get(employeeName) ?? "INACTIVE";
  const machines = entry.primaryMachineKeys.map((key) => {
    const live = inputs.machineStatusByKey.get(key);
    return { key, name: live?.name ?? key, status: live?.status ?? "UNKNOWN", known: Boolean(live) };
  });

  const blockers: Blocker[] = [];
  const sb = statusBlocker(employeeStatus);
  if (sb) blockers.push(sb);

  if (!inputs.aiProviderConfigured) {
    blockers.push({
      kind: "NO_AI_PROVIDER",
      detail:
        "No AI provider is enabled with a bound credential, so no employee can run work of any kind.",
      action: "Configure a provider under More / System → Integrations.",
      fatal: true,
    });
  }

  blockers.push(...machineBlockers(machines));

  const fatal = blockers.filter((b) => b.fatal);
  const state: ReadinessState =
    employeeStatus !== "ACTIVE" ? "NOT_ACTIVATED" : fatal.length > 0 ? "BLOCKED" : "READY";

  const summary =
    state === "READY"
      ? blockers.length === 0
        ? "Ready to work now."
        : "Ready, with some work unavailable."
      : (fatal[0]?.detail ?? "Blocked.");

  return { name: entry.name, role: entry.role, employeeStatus, state, machines, blockers, summary };
}
