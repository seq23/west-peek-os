import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { CONNECTION_FACTS, FIRM_SENDING_FACTS, SEND_AS_FACTS } from "@shared/help/connectionFacts";

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
 * IT IS ONE LINE UNTIL YOU OPEN IT. Setup is a thing you do once and then never think about, and
 * this sat at the top of the busiest page in the product taking a full screen — pushing the morning
 * briefing, which is the entire point of Home, below the fold every single day. The operator's word
 * for it was intrusive, and a settings block that outranks the product it configures has earned
 * that. What remains is a status strip: what is on, what is not, and a chevron.
 *
 * COLLAPSED STATE IS REMEMBERED, because "collapse this for later" means later, not until the next
 * page load. Kept in localStorage rather than on the server: it is a per-device display preference
 * with no consequence, and round-tripping it would be more machinery than the fact deserves.
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


/**
 * What connecting actually does, next to the button that does it.
 *
 * FOLDED, because a partner who has read it once should not have to scroll past it every morning —
 * and open on demand, because the one moment somebody wants this is the moment before they grant a
 * system access to their diary.
 *
 * CANNOT COMES FIRST inside each block. The reassurance that matters is not a privacy statement, it
 * is a specific list of things that are impossible and the reason they are impossible.
 */
function WhatConnectingDoes(): JSX.Element {
  return (
    <details className="card connect-help" data-testid="connect-help">
      <summary>What happens if I connect?</summary>

      <p className="muted small">
        Two different things get called “email” here, which is most of the confusion. Sending is
        something the firm does; a mailbox and a calendar belong to a person.
      </p>

      <section className="connect-fact" data-testid="connect-help-sending">
        <h4>{FIRM_SENDING_FACTS.title} <span className="badge badge-ok">already on</span></h4>
        <p className="small">{FIRM_SENDING_FACTS.summary}</p>
        <p className="muted small"><strong>It can</strong></p>
        <ul className="small">{FIRM_SENDING_FACTS.can.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="muted small"><strong>It cannot</strong></p>
        <ul className="small">{FIRM_SENDING_FACTS.cannot.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>

      <section className="connect-fact" data-testid="connect-help-send-as">
        <h4>{SEND_AS_FACTS.title}</h4>
        <p className="small">{SEND_AS_FACTS.summary}</p>
        <p className="muted small"><strong>It cannot</strong></p>
        <ul className="small">{SEND_AS_FACTS.cannot.map((x) => <li key={x}>{x}</li>)}</ul>
        <p className="muted small"><strong>It can</strong></p>
        <ul className="small">{SEND_AS_FACTS.can.map((x) => <li key={x}>{x}</li>)}</ul>
      </section>

      {CONNECTION_FACTS.map((f) => (
        <section key={f.key} className="connect-fact" data-testid={`connect-help-${f.key}`}>
          <h4>{f.title}</h4>
          <p className="small">{f.availability}</p>

          <p className="muted small"><strong>It cannot</strong></p>
          <ul className="small">{f.cannot.map((x) => <li key={x}>{x}</li>)}</ul>

          <p className="muted small"><strong>It can</strong></p>
          <ul className="small">{f.can.map((x) => <li key={x}>{x}</li>)}</ul>

          <p className="muted small">
            <strong>Why that is true:</strong> {f.enforcedBy}
          </p>
          <p className="muted small"><strong>When you press Connect</strong></p>
          <ol className="small">{f.whenYouConnect.map((x) => <li key={x}>{x}</li>)}</ol>
          <p className="muted small"><strong>To undo it:</strong> {f.toUndo}</p>
        </section>
      ))}

      <p className="muted small">
        The same thing at more length, alongside everything else the system does, is under{" "}
        <strong>Help → Connecting your email and calendar</strong>.
      </p>
    </details>
  );
}


interface SendAsState {
  enabled: boolean;
  via_gmail: boolean;
  from_address: string;
  eligible: boolean;
  firm_address: string | null;
  detail: string;
  note: string;
}

/**
 * Whose name approved email goes out under.
 *
 * A BUTTON, NOT A CHECKBOX. A checkbox reads as a setting you tick on a form and submit later; this
 * takes effect the moment it is pressed, and it changes what an LP sees at the top of a message.
 * A control should look like what it does.
 *
 * IT LIVES IN THE EMAIL SECTION, under the greyed-out Connect, because that is where somebody
 * asking "what can this thing do with my email" is already looking. Floating it above the section
 * made it read as a third, separate capability rather than the one extra thing email can do.
 *
 * YOUR OWN AND NOBODY ELSE'S. There is no control here for the other partner, and the absence is
 * the feature — arranging for mail to be sent in a colleague's name is not something a role should
 * carry, however senior.
 */
function SendAsButton(): JSX.Element | null {
  const state = useApi<SendAsState>("/api/me/send-as");
  const [busy, setBusy] = useState(false);
  const d = state.data;
  if (!d) return null;

  async function flip(next: boolean) {
    setBusy(true);
    await api("/api/me/send-as", { method: "POST", body: { enabled: next } });
    setBusy(false);
    state.reload();
  }

  return (
    <div className="send-as" data-testid="send-as">
      <div>
        <strong>Sending under your own name</strong>{" "}
        {d.enabled && <span className="badge badge-ok">on</span>}
        <div className="muted small">{d.detail}</div>
      </div>
      <div className="form-row">
        <button
          type="button"
          className={d.enabled ? undefined : "btn-strong"}
          disabled={busy || !d.eligible}
          data-testid="send-as-toggle"
          onClick={() => void flip(!d.enabled)}
        >
          {busy ? "…" : d.enabled ? "Stop sending as me" : "Send as me instead"}
        </button>
        {/* The Sent-folder fix, offered only once sending as yourself is actually on — before that
            it is an answer to a question nobody has asked yet. A SECOND consent: it adds permission
            to send through Gmail and nothing else, and cannot read a single message. */}
        {d.enabled && !d.via_gmail && (
          <button
            type="button"
            className="btn-strong"
            data-testid="connect-gmail-send"
            onClick={() => {
              window.location.href = "/api/connect/gmail-send/start";
            }}
          >
            Put it in my Sent folder
          </button>
        )}
        {d.via_gmail && <span className="badge badge-ok">through your Gmail</span>}
      </div>
    </div>
  );
}

const FOLD_KEY = "wp.connect-panel.open";

/** Closed unless this device says otherwise. "Collapse for later" has to mean later. */
function readFold(): boolean {
  try {
    return window.localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    // Private browsing or a blocked store. Defaulting to closed keeps the promise of the fold.
    return false;
  }
}

export function ConnectPanel({ me }: { me: MeResponse }) {
  const [open, setOpen] = useState(readFold);
  const state = useApi<{
    sending: Sending;
    connections: Connection[];
    google_ready: boolean;
    setup: { what: string; then: string; note: string } | null;
  }>("/api/me/connections");

  const d = state.data;
  /*
   * THE SHIFT THIS PLACEHOLDER EXISTS TO STOP. `/api/me/connections` answers at roughly 2.5s, and
   * this panel is the FIRST child of Home — so returning null until then meant the whole page was
   * painted, read, and then pushed down by one strip's height the moment the call landed. That was
   * Home's one measurable layout shift, and it arrived at the exact moment a partner had started
   * reading. The fix is to reserve the space: a matching `min-height` on this placeholder and on
   * `.connect-strip` itself (styles.css), so the strip drops into ground that was already its own.
   *
   * aria-hidden and empty: it reserves height and says nothing, because announcing "loading" for a
   * status strip nobody asked for is noise in a screen reader.
   */
  if (!d) {
    /* The placeholder MIRRORS the real strip rather than guessing at its height: same box, same
       badge, same one line of muted text. A hand-written `min-height: 38px` got within 3px at
       1280 and would have drifted again the first time the strip wrapped to two lines on a phone.
       `visibility: hidden` keeps the box and paints nothing. */
    return (
      <div className="card connect-strip connect-strip-reserve" data-testid="connect-panel-loading" aria-hidden="true">
        <span className="badge badge-gate">setup</span>
        <span className="muted small">checking what is connected</span>
      </div>
    );
  }

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

  // The one-line version: what is on, what is not. Everything the strip claims is a live fact, so a
  // partner can decide whether to open it without opening it.
  const calendarOn = d.connections.some((c) => c.connector_key === "calendar" && c.status === "CONNECTED");
  const bits: string[] = [];
  if (d.sending?.live) bits.push(`sending as ${d.sending.from}`);
  bits.push(calendarOn ? "calendar connected" : "calendar not connected");
  if (broken.length > 0) bits.push(`${broken.length} needs reconnecting`);

  return (
    <details
      className="card connect-strip"
      open={open}
      data-testid="connect-panel"
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        try {
          window.localStorage.setItem(FOLD_KEY, next ? "1" : "0");
        } catch {
          /* a blocked store just means the fold is not remembered; nothing here depends on it */
        }
      }}
    >
      <summary data-testid="connect-strip-summary">
        <span className={d.sending?.live ? "badge badge-ok" : "badge badge-gate"}>
          {d.sending?.live ? "set up" : "setup"}
        </span>
        <span className="muted small">{bits.join(" · ")}</span>
      </summary>

      {sendingLine}

      <h3>Connect your own mailbox and calendar</h3>
      <p className="muted small">
        Separate from the firm sending above — this is about <em>your</em> diary and{" "}
        <em>your</em> inbox. Yours alone, {me.email}; your partner connects theirs separately.
      </p>

      <WhatConnectingDoes />

      <ul className="card-list small connect-list">
        {d.connections.map((c) => (
          <li key={c.connector_key} data-testid={`connect-${c.connector_key}`}>
            <div>
              <strong>{c.name}</strong>
              {c.status === "CONNECTED" && <span className="badge badge-ok">connected</span>}
              {/* The firm half of "email" is already on, and saying so here is what stops the
                  greyed-out Connect beside it reading as a failure. */}
              {c.connector_key === "email" && d.sending?.live && (
                <span className="badge badge-ok">firm sending on</span>
              )}
              {(c.status === "EXPIRED" || c.status === "REVOKED") && <span className="badge badge-gate">needs reconnecting</span>}
              {c.status === "FAILED" && <span className="badge badge-bad">failed</span>}
              <div className="muted small">{c.what_it_unlocks}</div>
              {c.account_label && <div className="muted small">{c.account_label}</div>}
              {c.last_error && <div className="muted small">{c.last_error}</div>}
            </div>
            <div className="form-row">
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
              {/* Disconnect revokes at Google as well as forgetting locally. Forgetting without
                  revoking leaves a live grant in your Google account that the OS can no longer
                  withdraw — the opposite of what pressing this is asking for. */}
              {c.status === "CONNECTED" && (
                <button
                  type="button"
                  data-testid={`disconnect-${c.connector_key}`}
                  onClick={async () => {
                    await api("/api/connections/google/disconnect", { method: "POST", body: {} });
                    state.reload();
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>

            {/* After the greyed Connect, because it is the thing you CAN do with email here. */}
            {c.connector_key === "email" && <SendAsButton />}
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
    </details>
  );
}
