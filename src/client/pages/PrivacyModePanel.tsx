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
 * IT IS ONE SWITCH, AND THAT IS NOT A WEAKENING. The action is reserved to MANAGING_PARTNER and
 * nothing anywhere required a DIFFERENT partner to approve it — so the receipt flow had the same
 * person raising a card, approving their own card, and applying it. Three steps, one decision, no
 * second pair of eyes. The role check was doing all the real work; the ceremony was friction that
 * looked like control.
 *
 * What was worth keeping is the RECORD, and that already existed: budget_policy is versioned and
 * immutable by trigger, so every change carries who set it and when. The panel surfaces it instead
 * of leaving a setting this consequential looking like it came from nowhere. Anyone without the MP
 * role still cannot change it without an approved receipt.
 *
 * The panel also states each mode's consequence: three enum values with no stated outcome are a
 * decision nobody can make well.
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
  const budget = useApi<{
    policy: { cost_mode: string; privacy_mode: string; daily_cap_usd: number; per_run_cap_usd: number };
    history: Array<{ id: string; privacy_mode: string; created_at: string; set_by: string; set_by_name: string | null }>;
  }>("/api/ai/budget");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const isMp = me.roles.includes("MANAGING_PARTNER");
  const policy = budget.data?.policy;
  const current = policy?.privacy_mode ?? "…";

  // The last time this actually CHANGED, not simply the last row: several rows can carry the same
  // mode when a cap moved, and "last changed" is the question being asked.
  const history = budget.data?.history ?? [];
  const lastChange = history.find((h, i) => i + 1 < history.length && history[i + 1]!.privacy_mode !== h.privacy_mode)
    ?? (history.length === 1 ? history[0] : undefined);

  /** One switch. A Managing Partner is the approval authority here; the record is the control. */
  async function switchTo(mode: string) {
    if (!policy || mode === current) return;
    setBusy(mode);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>("/api/ai/budget", {
      method: "POST",
      body: {
        cost_mode: policy.cost_mode,
        privacy_mode: mode,
        daily_cap_usd: policy.daily_cap_usd,
        per_run_cap_usd: policy.per_run_cap_usd,
      },
    });
    setBusy(null);
    if (res.status === 200 || res.status === 201) {
      setMessage(
        mode === "FRONTIER"
          ? "The workforce can reach a real model now. Rebuild the morning brief to see it write."
          : `Switched to ${MODES.find((m) => m.key === mode)?.label}.`,
      );
      budget.reload();
    } else {
      setMessage(`Not switched: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    }
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
          <ul className="card-list small privacy-switch" data-testid="privacy-modes">
            {MODES.map((m) => (
              <li key={m.key} className={m.key === current ? "privacy-mode-current" : undefined}>
                <div>
                  <strong>{m.label}</strong>
                  {m.key === current && <span className="badge">on</span>}
                  <div className="muted small">{m.what}</div>
                  {m.key !== current && <div className="muted small">{m.consequence}</div>}
                </div>
                <button
                  type="button"
                  className={m.key === "FRONTIER" ? "btn-strong" : ""}
                  disabled={m.key === current || busy !== null}
                  data-testid={`privacy-${m.key}`}
                  onClick={() => void switchTo(m.key)}
                >
                  {m.key === current ? "Current" : busy === m.key ? "…" : "Switch to this"}
                </button>
              </li>
            ))}
          </ul>

          <p className="muted small" data-testid="privacy-last-change">
            {lastChange ? (
              <>
                Last changed to <strong>{MODES.find((x) => x.key === lastChange.privacy_mode)?.label ?? lastChange.privacy_mode}</strong>{" "}
                by {lastChange.set_by_name ?? lastChange.set_by} on{" "}
                {new Date(lastChange.created_at).toLocaleString()}.
              </>
            ) : (
              <>Never changed — this is the fail-closed default, which is why the workforce has been on the offline stub.</>
            )}
          </p>

          <p className="muted small">
            A Managing Partner can switch this directly; every change is recorded with who and when,
            and nothing is ever overwritten. Sensitivity still applies per call either way —
            confidential work is refused, never quietly downgraded.
          </p>
        </>
      )}

      {message && <p className="notice" data-testid="privacy-message">{message}</p>}
    </section>
  );
}
