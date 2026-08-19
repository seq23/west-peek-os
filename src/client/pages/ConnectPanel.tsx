import { useApi, type MeResponse } from "../lib/api";

/**
 * Connect your mailbox and your calendar.
 *
 * WHY ON HOME. These are the two things that decide whether the morning delivery above it is real.
 * Wren currently says "nothing scheduled" not because the day is empty but because she genuinely
 * cannot see it, and Wesley hands you drafts instead of sending them for the same reason. Putting
 * the fix anywhere else makes the operator hunt for the cause of a gap they meet every morning.
 *
 * PER PARTNER, NOT PER FIRM. A mailbox belongs to a person. Scooter connecting his calendar says
 * nothing about Sequoia's, and one firm-level toggle would claim otherwise.
 *
 * IT DISAPPEARS ONCE BOTH ARE CONNECTED. A permanent settings block on the busiest page in the
 * product is clutter the day after it is used; what stays is a quiet line, and only if something
 * has broken.
 *
 * WHEN IT CANNOT WORK, IT SAYS WHY. A Connect button that shrugs is worse than no button — the
 * blocker here is a credential only the operator can create, so the panel names it rather than
 * failing on click.
 */

interface Connection {
  connector_key: string;
  name: string;
  status: string;
  account_label: string | null;
  connected_at: string | null;
  last_error: string | null;
  connectable: boolean;
  blocked_by: string | null;
  what_it_unlocks: string;
}

interface Sending {
  live: boolean;
  from: string | null;
  provider: string | null;
  detail: string;
}

export function ConnectPanel({ me }: { me: MeResponse }) {
  const state = useApi<{
    sending: Sending;
    connections: Connection[];
    google_ready: boolean;
    setup: { what: string; then: string; note: string } | null;
  }>("/api/me/connections");

  const d = state.data;
  if (!d) return null;

  const connected = d.connections.filter((c) => c.status === "CONNECTED");
  const broken = d.connections.filter((c) => c.status === "EXPIRED" || c.status === "FAILED" || c.status === "REVOKED");

  // FIRM SENDING IS SHOWN EVEN WHEN NOTHING ELSE NEEDS DOING. It is the half of "email" that is
  // actually live, and reporting only the mailbox made a working system look broken.
  const sendingLine = d.sending?.live ? (
    <p className="muted small" data-testid="connect-sending-live">
      <span className="badge badge-ok">sending live</span> The firm sends approved email as{" "}
      <strong>{d.sending.from}</strong>. Every message still needs a human decision first.
    </p>
  ) : null;

  // Everything working: one quiet line rather than a settings block on the busiest page.
  if (connected.length === d.connections.length && broken.length === 0) {
    return (
      <>
        {sendingLine}
        <p className="muted small" data-testid="connect-all-good">
          Your mail and calendar are connected.
        </p>
      </>
    );
  }

  return (
    <section className="card" data-testid="connect-panel">
      {sendingLine}
      <h3>Connect your own mailbox and calendar</h3>
      <p className="muted small">
        Separate from the firm sending above. This is about <em>your</em> inbox and{" "}
        <em>your</em> diary — reading what is in them, and sending as you rather than as the firm.
      </p>
      <p className="muted small">
        {me.fullName.split(" ")[0]}, these are yours alone — {me.email}. Your partner connects
        theirs separately.
      </p>

      <ul className="card-list small connect-list">
        {d.connections.map((c) => (
          <li key={c.connector_key} data-testid={`connect-${c.connector_key}`}>
            <div>
              <strong>{c.name}</strong>
              {c.status === "CONNECTED" && <span className="badge badge-ok">connected</span>}
              {(c.status === "EXPIRED" || c.status === "REVOKED") && <span className="badge badge-gate">needs reconnecting</span>}
              {c.status === "FAILED" && <span className="badge badge-bad">failed</span>}
              <div className="muted small">{c.what_it_unlocks}</div>
              {c.account_label && <div className="muted small">{c.account_label}</div>}
              {c.last_error && <div className="muted small">{c.last_error}</div>}
            </div>
            <button
              type="button"
              className={c.connectable ? "btn-strong" : undefined}
              disabled={!c.connectable}
              data-testid={`connect-${c.connector_key}-button`}
              onClick={() => {
                // The OAuth round trip leaves and comes back; the worker owns the redirect so the
                // client never handles a token.
                window.location.href = `/api/connect/${c.connector_key}/start`;
              }}
            >
              {c.status === "CONNECTED" ? "Reconnect" : "Connect"}
            </button>
          </li>
        ))}
      </ul>

      {d.setup && (
        <div className="notice" data-testid="connect-setup">
          <strong>Not yet possible.</strong> {d.connections[0]?.blocked_by}
          <div className="muted small">
            {d.setup.what} {d.setup.then} {d.setup.note}
          </div>
        </div>
      )}
    </section>
  );
}
