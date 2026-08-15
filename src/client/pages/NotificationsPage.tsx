import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Notification centre (P20, GAP-19).
 *
 * Severity-ordered, deduped, with read and acknowledge as distinct acts. Notifications held by
 * quiet hours or a preference are STILL HERE, labelled with why they were held — the record is
 * never suppressed, only the delivery.
 */

interface Notification {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  object_type: string | null;
  object_id: string | null;
  delivery_status: string;
  read_at: string | null;
  acked_at: string | null;
  created_at: string;
}

function severityBadge(s: string): string {
  if (s === "CRITICAL") return "badge badge-bad";
  if (s === "WARNING") return "badge badge-gate";
  return "badge";
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
  const [showRead, setShowRead] = useState(true);

  const items = (notifications.data?.notifications ?? []).filter((n) => showRead || n.read_at === null);

  return (
    <section data-testid="notifications-page">
      <p data-testid="notifications-summary">
        {notifications.data?.unread_count ?? 0} unread · {notifications.data?.critical_unread ?? 0} critical unread ({me.fullName})
      </p>
      <p className="muted small" data-testid="notifications-note">
        {notifications.data?.note}
      </p>

      <div className="form-row">
        <label>
          <input type="checkbox" checked={showRead} onChange={(e) => setShowRead(e.target.checked)} data-testid="notifications-show-read" /> show
          read
        </label>
      </div>

      <ul className="card-list" data-testid="notification-list">
        {items.map((n) => (
          <li key={n.id} className="card" data-testid={`notification-${n.id}`}>
            <p>
              <span className={severityBadge(n.severity)}>{n.severity}</span> <span className="badge">{n.kind}</span>{" "}
              <strong>{n.title}</strong>
              {n.read_at === null && <span className="badge badge-gate">unread</span>}
              {n.acked_at !== null && <span className="badge badge-ok">acknowledged</span>}
            </p>
            {n.body && <p className="small">{n.body}</p>}
            <p className="muted small">
              {n.created_at} · delivery {n.delivery_status}
              {n.object_type ? ` · ${n.object_type}/${n.object_id}` : ""}
            </p>
            <div className="form-row">
              {n.read_at === null && (
                <button
                  type="button"
                  data-testid={`notification-read-${n.id}`}
                  onClick={async () => {
                    await api(`/api/notifications/${n.id}/read`, { method: "POST" });
                    notifications.reload();
                  }}
                >
                  Mark read
                </button>
              )}
              {n.acked_at === null && (
                <button
                  type="button"
                  data-testid={`notification-ack-${n.id}`}
                  onClick={async () => {
                    const res = await api<{ error?: string }>(`/api/notifications/${n.id}/acknowledge`, { method: "POST" });
                    setMessage(res.status === 200 ? "Acknowledged — recorded on the audit spine." : `Refused: ${res.data?.error ?? res.status}`);
                    notifications.reload();
                  }}
                >
                  Acknowledge
                </button>
              )}
            </div>
          </li>
        ))}
        {!notifications.loading && items.length === 0 && (
          <li className="state-empty" data-testid="notifications-empty">
            Nothing to show. Notifications appear here when an approval waits, a portfolio alert opens, a budget is
            crossed, a scheduled job dies, or a brief is ready.
          </li>
        )}
      </ul>
      {message && <p className="notice" data-testid="notifications-message">{message}</p>}

      <h3>Preferences</h3>
      <ul className="small muted" data-testid="notification-rules">
        {Object.entries(prefs.data?.rules ?? {}).map(([k, v]) => (
          <li key={k}>
            <code>{k}</code> — {v}
          </li>
        ))}
      </ul>
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
              ? `Quiet hours saved (${quietStart}:00–${quietEnd}:00 UTC). Critical notifications are still delivered.`
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
          Save quiet hours
        </button>
      </form>
    </section>
  );
}
