import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * The firm's privacy mode — the setting that decides whether the workforce can think at all.
 *
 * WHY THIS PANEL EXISTS. Privacy mode was DISPLAY-ONLY: the AI page printed it and there was no way
 * to change it from the product. Production sat in LOCKDOWN — not because anyone chose it, but
 * because LOCKDOWN is the fail-closed default when no policy row exists — and in LOCKDOWN every
 * model call falls back to the offline stub. The morning brief had never once been written by a
 * real model; it failed on every run because the stub returns prose where the pipeline needs JSON,
 * and the operator saw only "rebuild failed".
 *
 * A setting that consequential being unreachable is the bug. Fail-closed is right; fail-closed
 * with no visible door is how a firm runs for weeks on a stub without knowing.
 *
 * IT IS STILL GOVERNED, and this panel does not weaken that. Changing the mode needs an approved
 * `governance.policy_change` receipt, so the flow here is request → a Managing Partner approves →
 * apply. What the panel adds is the explanation: three enum values with no stated consequence are
 * a decision nobody can make well.
 *
 * SENSITIVITY STILL APPLIES PER CALL. FRONTIER does not mean everything leaves — a CONFIDENTIAL
 * meeting is still refused rather than quietly downgraded, and that rule lives in runAi where it
 * cannot be turned off from a screen.
 */

interface Mode {
  key: string;
  label: string;
  what: string;
  consequence: string;
}

const MODES: readonly Mode[] = [
  {
    key: "LOCKDOWN",
    label: "Locked down",
    what: "Nothing reaches an outside model. Every call falls back to the offline adapter.",
    consequence:
      "The workforce cannot write, research or search. The offline adapter returns placeholder prose, " +
      "so anything expecting real output — the morning brief above all — fails rather than degrades.",
  },
  {
    key: "LOCAL",
    label: "Local only",
    what: "Same as locked down for outside models; reserved for a local model if one is ever hosted.",
    consequence: "Identical to locked down today, because no local model is configured.",
  },
  {
    key: "FRONTIER",
    label: "Frontier",
    what: "Outside models may be used, for the sensitivity labels that permit it.",
    consequence:
      "The workforce can write, research and search. PUBLIC and INTERNAL work leaves for a model; " +
      "CONFIDENTIAL, RESTRICTED and MNPI-labelled work is still refused rather than downgraded, and " +
      "that refusal is enforced per call, not by this setting.",
  },
] as const;

export function PrivacyModePanel({ me }: { me: MeResponse }) {
  const budget = useApi<{ policy: { cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number } }>(
    "/api/ai/budget",
  );
  const approvals = useApi<{ approvals: Array<{ id: string; action_key: string; object_type: string; state: string }> }>(
    "/api/approvals?state=approved",
  );
  const [target, setTarget] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isMp = me.roles.includes("MANAGING_PARTNER");
  const policy = budget.data?.policy;
  const current = policy?.privacy_mode ?? "…";
  const chosen = MODES.find((m) => m.key === (target ?? current));

  const receipt = (approvals.data?.approvals ?? []).find(
    (a) => a.action_key === "governance.policy_change" && a.object_type === "budget_policy" && a.state === "approved",
  );

  async function request() {
    setBusy(true);
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/approvals", {
      method: "POST",
      body: {
        action_key: "governance.policy_change",
        object_type: "budget_policy",
        object_id: "west-peek",
        title: `Privacy mode → ${MODES.find((m) => m.key === target)?.label ?? target}`,
        submit: true,
      },
    });
    setBusy(false);
    setMessage(
      res.status === 201
        ? "Requested. Approve it on Approvals, then come back and apply."
        : `Could not request it: ${res.data?.detail ?? res.data?.error ?? res.status}`,
    );
    approvals.reload();
  }

  async function apply() {
    if (!receipt || !policy || !target) return;
    setBusy(true);
    const res = await api<{ error?: string; detail?: string }>("/api/ai/budget", {
      method: "POST",
      body: {
        cost_mode: policy.cost_mode,
        privacy_mode: target,
        daily_cap_usd: policy.daily_cap_usd,
        per_run_cap_usd: policy.per_run_cap_usd,
        approval_receipt_id: receipt.id,
      },
    });
    setBusy(false);
    if (res.status === 200 || res.status === 201) {
      setMessage(`Privacy mode is now ${MODES.find((m) => m.key === target)?.label}. Rebuild the brief to see it write.`);
      setTarget(null);
      budget.reload();
    } else {
      setMessage(`Not applied: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    }
    approvals.reload();
  }

  return (
    <section className="card" data-testid="privacy-mode">
      <h3>What may leave the firm</h3>

      <p data-testid="privacy-current">
        Currently <strong>{MODES.find((m) => m.key === current)?.label ?? current}</strong>.{" "}
        <span className="muted small">{MODES.find((m) => m.key === current)?.what}</span>
      </p>

      {current !== "FRONTIER" && (
        <p className="notice" data-testid="privacy-stub-warning">
          Every model call is currently answered by the offline adapter, which returns placeholder
          text. The morning brief fails rather than degrades, because it needs real output to parse.
        </p>
      )}

      {!isMp ? (
        <p className="muted small">Changing this is reserved for a Managing Partner.</p>
      ) : (
        <>
          <ul className="card-list small" data-testid="privacy-modes">
            {MODES.map((m) => (
              <li key={m.key} className={m.key === current ? "privacy-mode-current" : undefined}>
                <label>
                  <input
                    type="radio"
                    name="privacy-mode"
                    data-testid={`privacy-${m.key}`}
                    checked={(target ?? current) === m.key}
                    onChange={() => {
                      setMessage(null);
                      setTarget(m.key);
                    }}
                  />{" "}
                  <strong>{m.label}</strong>
                  {m.key === current && <span className="badge">current</span>}
                </label>
                <div className="muted small">{m.what}</div>
              </li>
            ))}
          </ul>

          {chosen && target && target !== current && (
            <div className="notice" data-testid="privacy-consequence">
              <strong>What changes:</strong> {chosen.consequence}
            </div>
          )}

          <div className="form-row">
            {target && target !== current && !receipt && (
              <button type="button" className="btn-strong" disabled={busy} data-testid="privacy-request" onClick={() => void request()}>
                {busy ? "…" : "Request this change"}
              </button>
            )}
            {target && target !== current && receipt && (
              <button type="button" className="btn-strong" disabled={busy} data-testid="privacy-apply" onClick={() => void apply()}>
                {busy ? "…" : "Apply — approved"}
              </button>
            )}
            {target && target !== current && (
              <button type="button" className="link-button" onClick={() => { setTarget(null); setMessage(null); }}>
                Cancel
              </button>
            )}
          </div>

          <p className="muted small">
            A change needs an approved receipt, because this is the setting that decides whether firm
            data may reach an outside model at all. Sensitivity still applies per call either way:
            confidential work is refused, never quietly downgraded.
          </p>
        </>
      )}

      {message && <p className="notice" data-testid="privacy-message">{message}</p>}
    </section>
  );
}
