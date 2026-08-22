import { useMemo, useState } from "react";
import { api, mutationError, useApi, type MeResponse } from "../lib/api";

/**
 * Notifications — what needs you, then what happened, then what you have already dealt with.
 *
 * WHAT WAS WRONG. The page opened with "show read" ticked, so the first thing a partner saw was a
 * flat list of two hundred things they had already handled, severity-ordered but otherwise
 * undifferentiated, with the four unread items somewhere inside it. That default was not an
 * oversight either — there was no bulk mark-read, so hiding read items would have left the page
 * looking permanently empty. The two defects held each other up.
 *
 * THE ORDERING PRINCIPLE. An inbox answers one question — is there anything I have to do — and
 * everything else is history. So the page opens on what is unread, leads with what is serious, and
 * puts what you have already read behind a fold rather than in front of you.
 *
 * READ AND ACKNOWLEDGED STAY DIFFERENT, which the original design got right and is worth keeping.
 * Reading is dismissal; acknowledging records that a human saw an exception and accepted
 * responsibility for it, and it lands on the audit spine. So bulk applies to reading and never to
 * acknowledging — nobody accepts responsibility for eighteen things with one click.
 *
 * AN EMPTY INBOX IS AN ACHIEVEMENT, not an error state, and reads like one.
 */

interface Notification {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  read_at: string | null;
  acked_at: string | null;
  created_at: string;
  delivery_status: string;
  object_type: string | null;
  object_id: string | null;
}

function severityBadge(s: string): string {
  if (s === "CRITICAL") return "badge badge-bad";
  if (s === "WARNING") return "badge badge-gate";
  return "badge";
}

/** "3 minutes ago" beats a timestamp for the question this page answers: is this still live? */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function NotificationRow({
  n,
  onChanged,
  onMessage,
}: {
  n: Notification;
  onChanged: () => void;
  onMessage: (s: string) => void;
}) {
  return (
    <li className="card notification-row" data-testid={`notification-${n.id}`}>
      <div className="notification-body">
        <div className="notification-head">
          <span className={severityBadge(n.severity)}>{n.severity.toLowerCase()}</span>
          <strong>{n.title}</strong>
          {n.acked_at !== null && <span className="badge badge-ok">acknowledged</span>}
        </div>
        {n.body && <p className="small">{n.body}</p>}
        <p className="muted small">
          {ago(n.created_at)} · {n.kind.toLowerCase().replace(/_/g, " ")}
        </p>
      </div>

      <div className="notification-actions">
        {n.read_at === null && (
          <button
            type="button"
            data-testid={`notification-read-${n.id}`}
            onClick={async () => {
              // Dismiss used to swallow its result while Acknowledge, on the same row, checked it.
              // Two buttons an inch apart behaving differently is worse than either behaviour.
              const failed = mutationError(await api(`/api/notifications/${n.id}/read`, { method: "POST" }));
              if (failed) { onMessage(failed); return; }
              onChanged();
            }}
          >
            Dismiss
          </button>
        )}
        {/* Acknowledgement is offered where it means something. Asking a partner to take
            responsibility for a routine info notice trains them to click it without reading. */}
        {n.acked_at === null && (n.severity === "CRITICAL" || n.severity === "WARNING") && (
          <button
            type="button"
            className="btn-strong"
            data-testid={`notification-ack-${n.id}`}
            onClick={async () => {
              const res = await api<{ error?: string }>(`/api/notifications/${n.id}/acknowledge`, { method: "POST" });
              onMessage(res.status === 200 ? "Acknowledged — recorded on the audit trail." : `Refused: ${res.data?.error ?? res.status}`);
              onChanged();
            }}
          >
            Acknowledge
          </button>
        )}
      </div>
    </li>
  );
}

export function NotificationsPage({ me }: { me: MeResponse }) {
  const notifications = useApi<{ notifications: Notification[]; unread_count: number; critical_unread: number; note: string }>(
    "/api/notifications",
  );
  const prefs = useApi<{ preference: { quiet_hours_json: string; push_enabled: number } | null; kinds: string[]; rules: Record<string, string> }>(
    "/api/notifications/preferences",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [quietStart, setQuietStart] = useState("21");
  const [quietEnd, setQuietEnd] = useState("7");
  // Closed by default. What you have already dealt with is history, and history does not open first.
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = notifications.data?.notifications ?? [];

  const { needsYou, worthKnowing, handled } = useMemo(() => {
    const unread = all.filter((n) => n.read_at === null);
    return {
      needsYou: unread.filter((n) => n.severity === "CRITICAL" || n.severity === "WARNING"),
      worthKnowing: unread.filter((n) => n.severity !== "CRITICAL" && n.severity !== "WARNING"),
      handled: all.filter((n) => n.read_at !== null),
    };
  }, [all]);

  async function readAll() {
    setBusy(true);
    const res = await api<{ marked?: number; note?: string }>("/api/notifications/read-all", { method: "POST" });
    setBusy(false);
    setMessage(
      res.status === 200
        ? `${res.data?.marked ?? 0} dismissed. ${res.data?.note ?? ""}`
        : `Could not dismiss them (HTTP ${res.status}).`,
    );
    notifications.reload();
  }

  const clear = needsYou.length === 0 && worthKnowing.length === 0;

  return (
    <section data-testid="notifications-page">
      <div className="home-section-head">
        <h3>
          {clear ? "You are caught up" : `${needsYou.length + worthKnowing.length} waiting`}
        </h3>
        {!clear && (
          <button type="button" className="link-button" disabled={busy} data-testid="notifications-read-all" onClick={() => void readAll()}>
            {busy ? "…" : "Dismiss all"}
          </button>
        )}
      </div>

      {message && <p className="notice" data-testid="notifications-message">{message}</p>}

      {clear && (
        <p className="state-empty" data-testid="notifications-clear">
          Nothing is waiting on you, {me.fullName.split(" ")[0]}. Anything new appears here — an
          approval, a portfolio alert, a budget crossed, a scheduled job that died, a brief ready to
          read.
        </p>
      )}

      {needsYou.length > 0 && (
        <>
          <div className="home-section-head">
            <h4>Needs you</h4>
            <span className="count-pill">{needsYou.length}</span>
          </div>
          <ul className="card-list" data-testid="notifications-needs-you">
            {needsYou.map((n) => (
              <NotificationRow key={n.id} n={n} onChanged={notifications.reload} onMessage={setMessage} />
            ))}
          </ul>
        </>
      )}

      {worthKnowing.length > 0 && (
        <>
          <div className="home-section-head">
            <h4>Worth knowing</h4>
            <span className="muted small">nothing here is blocked on you</span>
          </div>
          <ul className="card-list" data-testid="notifications-worth-knowing">
            {worthKnowing.map((n) => (
              <NotificationRow key={n.id} n={n} onChanged={notifications.reload} onMessage={setMessage} />
            ))}
          </ul>
        </>
      )}

      {handled.length > 0 && (
        <details
          className="card"
          open={showHandled}
          onToggle={(e) => setShowHandled((e.currentTarget as HTMLDetailsElement).open)}
          data-testid="notifications-handled"
        >
          <summary>{handled.length} already dealt with</summary>
          <ul className="card-list">
            {handled.slice(0, 50).map((n) => (
              <NotificationRow key={n.id} n={n} onChanged={notifications.reload} onMessage={setMessage} />
            ))}
          </ul>
          {handled.length > 50 && (
            <p className="muted small">Showing the 50 most recent of {handled.length}.</p>
          )}
        </details>
      )}

      <details className="card" data-testid="notifications-settings">
        <summary>When you hear from us</summary>

        <p className="muted small">
          Quiet hours hold everything back except CRITICAL, which is always delivered — the point of
          the label is that it wakes you.
        </p>

        <form
          className="form-row"
          data-testid="quiet-hours-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await api<{ push_note?: string }>("/api/notifications/preferences", {
              method: "POST",
              body: { quiet_hours: { start: Number(quietStart), end: Number(quietEnd) }, push_enabled: false },
            });
            setMessage(
              res.status === 201
                ? `Quiet hours saved (${quietStart}:00–${quietEnd}:00 UTC). Critical still comes through.`
                : `Refused (HTTP ${res.status}).`,
            );
            prefs.reload();
          }}
        >
          <label>
            Quiet from <input data-testid="quiet-start" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} size={2} />
          </label>
          <label>
            until <input data-testid="quiet-end" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} size={2} /> (UTC)
          </label>
          <button type="submit" className="btn-strong" data-testid="quiet-submit">
            Save
          </button>
        </form>

        <h4>What gets sent, and when</h4>
        <ul className="small muted" data-testid="notification-rules">
          {Object.entries(prefs.data?.rules ?? {}).map(([k, v]) => (
            <li key={k}>
              <strong>{k.replace(/_/g, " ")}</strong> — {v}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
