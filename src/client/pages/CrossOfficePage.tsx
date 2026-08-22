import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Cross-office reconciliation (P38, V1 #8, canon §7.5).
 *
 * Two personal offices with full firm access will occasionally do the same work twice without
 * either being able to see it. This page shows those collisions.
 *
 * RESOLVED and ACCEPTED are offered as separate outcomes on purpose. "We fixed it" and "yes, both
 * of us are on this deliberately" are different facts, and collapsing them into one button would
 * lose the distinction the next person needs.
 */

interface Conflict {
  id: string; conflict_type: string; object_type: string; object_id: string;
  summary: string; status: string; first_seen_at: string; last_seen_at: string;
}

const TYPE_LABEL: Record<string, string> = {
  DUPLICATE_REQUEST: "Duplicate work",
  CONTRADICTORY_INSTRUCTION: "Conflicting instructions",
  RESOURCE_CONFLICT: "Employee double-booked",
  OVERLAPPING_OUTBOUND: "Overlapping drafts",
};

export function CrossOfficePage(): JSX.Element {
  const state = useApi<{ conflicts: Conflict[]; counts: Record<string, number> }>("/api/cross-office");
  const [busy, setBusy] = useState(false);
  const conflicts = state.data?.conflicts ?? [];

  async function detect() {
    setBusy(true);
    await api("/api/cross-office/detect", { method: "POST", body: {} });
    setBusy(false);
    state.reload();
  }

  async function settle(id: string, status: "RESOLVED" | "ACCEPTED") {
    await api(`/api/cross-office/${id}/resolve`, { method: "POST", body: { status } });
    state.reload();
  }

  return (
    <div className="page" data-testid="cross-office-page">
      <p className="muted">
        Where the two offices are colliding — the same work twice, the same employee twice, or two
        drafts to one recipient.
      </p>

      <div className="form-row">
        <button type="button" className="btn-strong" disabled={busy} data-testid="cross-office-detect" onClick={detect}>
          {busy ? "Checking…" : "Check for collisions"}
        </button>
      </div>

      {conflicts.length === 0 ? (
        <p className="state-empty" data-testid="cross-office-empty">
          No open collisions. Either the offices are in step, or nothing has been checked yet.
        </p>
      ) : (
        <ul className="card-list" data-testid="cross-office-list">
          {conflicts.map((c) => (
            <li key={c.id} data-testid={`conflict-${c.id}`}>
              <span className="help-tag help-tag-warn">{TYPE_LABEL[c.conflict_type] ?? c.conflict_type}</span>{" "}
              <strong>{c.summary}</strong>
              <div className="muted small">
                first seen {new Date(c.first_seen_at).toLocaleDateString()} · {c.object_type}
              </div>
              <div className="form-row">
                <button type="button" data-testid={`conflict-resolve-${c.id}`} onClick={() => settle(c.id, "RESOLVED")}>
                  Resolved
                </button>
                <button type="button" data-testid={`conflict-accept-${c.id}`} onClick={() => settle(c.id, "ACCEPTED")}>
                  Both intended
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <HowThisWorks
        title="Cross-office"
        testId="cross-office"
        what="Collisions between the two Managing Partners' offices: duplicate work, conflicting instructions, an employee holding work from both, and unsent drafts aimed at the same recipient."
        when="Before the weekly review, and any time both partners have been directing work independently."
        operatorDoes={["Run the check.", "Mark each collision resolved, or accepted if both offices are on it deliberately."]}
        aiDoes={["Detection only. It reads shared firm records and never partner-private notes."]}
        requiresOperator={["Every resolution. The system will not decide which office is right."]}
        next="Re-checking never reopens something you settled, so the list stays short enough to be worth reading."
        blocked={["Only shared records are scanned. A collision that exists solely in two partners' private notes is invisible here by design."]}
      />
    </div>
  );
}
