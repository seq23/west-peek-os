import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * Google Meet — the firm default, with its door on the page (owner's addition, 19 Sep 2026).
 *
 * The firm-default recording policy (`meet_recording_policy`, Phase Meet) is what lets a firm-hosted
 * Meet be read at all: every ended call is REFUSED until it is on. It is a reserved act — an approved
 * `meet.recording_policy.firm_default` card, consumed on activation — and until tonight the only
 * door was two curls around a partner's approval: raise the card by hand, approve it, post the
 * receipt by hand. Nothing in the app said the gate existed, let alone that it was shut.
 *
 * ONE SWITCH, EIGHT STATES. Off, it raises the card through the ordinary approvals path and the
 * line says a partner is being waited on, with the way to Approvals beside it. Approved, the same
 * switch turns it on with that receipt — the reserved act is still the receipt's, the switch only
 * carries it. On, it turns off (a Managing Partner's act, no receipt: closing a gate is the safe
 * direction). Loading, disabled-with-reason, error and success are on the switch and in the words.
 *
 * The rest of the line is what a partner needs to know the door is open: whether the service
 * account is configured, when the calendar last synced, and what the Meet inbox holds.
 */

interface CalendarRow {
  calendar_key: string;
  last_synced_at: string | null;
  last_status: string | null;
  last_detail: string | null;
  events_seen: number;
  meetings_created: number;
}

interface MeetStatus {
  configured: boolean;
  recording_policy: { firm_scope: string; active: number; activated_at?: string | null; activated_by?: string | null; deactivated_at?: string | null };
  calendars: CalendarRow[];
  inbox: Record<string, number>;
  approval: { approved_card_id: string | null; pending_card_id: string | null };
}

export const FIRM_DEFAULT_ACTION = "meet.recording_policy.firm_default";

function whenInWords(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function MeetBand({ onNavigate }: { onNavigate: (key: string) => void }): JSX.Element {
  const status = useApi<MeetStatus>("/api/meet/status");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const s = status.data;
  const on = s?.recording_policy.active === 1;
  const approved = s?.approval.approved_card_id ?? null;
  const pending = s?.approval.pending_card_id ?? null;

  /** Off → a card. The reserved act is the receipt's; this only asks for one. */
  async function raise() {
    if (!s) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/approvals", {
      method: "POST",
      body: {
        action_key: FIRM_DEFAULT_ACTION,
        object_type: "meet_recording_policy",
        object_id: s.recording_policy.firm_scope,
        title: "Turn on the firm default: transcribe every firm-hosted Google Meet",
        summary: "Every ended call on a firm calendar is read into its meeting record, with the platform's announcement as consent. Off until a partner approves this.",
        submit: true,
      },
    });
    setBusy(false);
    if (res.status !== 201) setError(res.data?.detail ?? res.data?.error ?? `The card could not be raised (HTTP ${res.status}).`);
    else setNote("Raised. A partner approves it on Approvals; then this switch turns it on.");
    status.reload();
  }

  /** Approved → on, with that receipt. */
  async function activate() {
    if (!approved) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await api<{ active?: number; error?: string; detail?: string }>("/api/meet/recording-policy", {
      method: "POST",
      body: { action: "activate", approval_receipt_id: approved, note: "turned on from the Meetings page" },
    });
    setBusy(false);
    if (res.status !== 200) setError(res.data?.detail ?? res.data?.error ?? `Not turned on (HTTP ${res.status}).`);
    else setNote("On. Every firm-hosted Meet that ends from now is read into its record.");
    status.reload();
  }

  /** On → off. A Managing Partner's act, no receipt. */
  async function deactivate() {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await api<{ error?: string; detail?: string }>("/api/meet/recording-policy", {
      method: "POST",
      body: { action: "deactivate", note: "turned off from the Meetings page" },
    });
    setBusy(false);
    if (res.status !== 200) setError(res.data?.detail ?? res.data?.error ?? `Not turned off (HTTP ${res.status}).`);
    else setNote("Off. Calls that end from now are refused, and the refusal is written down.");
    status.reload();
  }

  // The switch's one click, by state.
  const act = on ? deactivate : approved ? activate : raise;
  const disabled = busy || !s || (!on && pending !== null);
  const reason = !s
    ? "Reading the Meet connection…"
    : on
      ? `Firm default is on · every firm-hosted Meet is transcribed, with the platform's announcement as consent · since ${whenInWords(s.recording_policy.activated_at)}`
      : approved
        ? "Approved — turn it on. The receipt is on file and is used once."
        : pending
          ? "Off · waiting for a partner to approve the card"
          : "Firm default is off · every ended call is refused until a partner approves turning it on";

  const calendars = s?.calendars ?? [];
  const lastSync = calendars.map((c) => c.last_synced_at).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const eventsSeen = calendars.reduce((n, c) => n + (c.events_seen ?? 0), 0);
  const inbox = s?.inbox ?? {};
  const inboxTotal = Object.values(inbox).reduce((n, k) => n + k, 0);

  return (
    <section className="band" data-testid="band-meet">
      <div className="band-head">
        <h3>Google Meet</h3>
        <span className="band-when">the firm's calendar and its calls</span>
      </div>
      <div className="rec-line">
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label="Firm default: transcribe every firm-hosted Google Meet"
          data-testid="meet-default-switch"
          title={reason}
          aria-busy={busy || !s}
          data-state={error ? "error" : on ? "success" : undefined}
          disabled={disabled}
          onClick={() => void act()}
        >
          <i aria-hidden="true" />
        </button>
        <span className="live-dot" aria-hidden="true" hidden={!on} />
        <div className="rec-text" data-testid="meet-default-status" role="status" aria-live="polite">
          <strong>{reason}</strong>
          <span>
            {!s
              ? "Reading…"
              : s.configured
                ? `Connected to Google · calendar synced ${whenInWords(lastSync)} · ${eventsSeen} event${eventsSeen === 1 ? "" : "s"} seen`
                : "Not connected to Google — no service account is configured, so nothing syncs and nothing is heard"}
            {s && ` · inbox: ${inboxTotal === 0 ? "nothing heard yet" : Object.entries(inbox).map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, " ")}`).join(", ")}`}
          </span>
        </div>
        {s && !on && pending ? (
          <button type="button" data-testid="meet-default-open-approvals" onClick={() => onNavigate("approvals")}>Open Approvals</button>
        ) : s && !on && approved ? (
          <button type="button" className="btn-strong" disabled={busy} data-testid="meet-default-activate" onClick={() => void activate()}>Turn it on</button>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
      {error && <p className="field-help err" data-testid="meet-default-error">{error}</p>}
      {note && <p className="notice small" data-testid="meet-default-note" role="status">{note}</p>}
    </section>
  );
}
