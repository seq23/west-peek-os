import { useEffect, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { RoomPanel } from "./RoomPanel";
import { MEET_ADDON } from "@shared/meetings/meetAddon";

/**
 * THE MEET ADD-ON SIDE PANEL (Phase Meet, tier 3; owner-approved 19 Sep 2026).
 *
 * `#/meet-panel` is this app rendered inside Google Meet's side panel: the same During face as
 * `#/room/<id>`, narrow, with nothing else — the room, beside the call. It does three things
 * before it can show the room, and each is a state a partner can read rather than a spinner:
 *
 *   1 · WHICH CALL. Inside Meet, the Add-ons SDK answers `getMeetingInfo()` with the meeting
 *       code; outside Meet (a test, a tab) `?code=abc-defg-hij` on the hash stands in for it.
 *   2 · WHO IS ASKING. `/api/me` — behind Cloudflare Access, which answers an iframe only with the
 *       partner's own session cookie (see below). No identity → a card that opens the OS in a new
 *       tab to sign in, and a Try again.
 *   3 · WHICH MEETING. `GET /api/meet/live/resolve?code=` turns the code into the meeting the
 *       calendar sync created for that space (the nearest occurrence). Not on the record → the
 *       panel says so, with one action: "Record this meeting now" (`POST /api/meet/live/adopt`),
 *       which opens an ordinary meeting carrying the code and shows the room.
 *
 * THE END OF THE CALL is one signal, `meeting.call_ended_at` (migration 0216), written by the
 * live listener or by the ended-call ingest, whichever learns it first. The panel polls the
 * resolve route and, once it is set, offers "Open what came out of it" — the full After face in
 * the main app, in a tab of its own (the side panel is not the place to approve a record).
 *
 * ── AUTH INSIDE THE IFRAME, decided ─────────────────────────────────────────────────────────
 *
 * Cloudflare Access fronts every page of this app. An iframe on meet.google.com is a cross-site
 * context, so the Access cookie (`CF_Authorization`) reaches it only if the Access application
 * sends it with `SameSite=None` — today the attribute is unset (probed 19 Sep 2026, read-only,
 * both Access applications), which browsers treat as Lax, and the panel would load as the login
 * page, which cannot be framed. THE CHOICE: her own session cookie, with SameSite=None on the
 * application, because the alternatives are worse: an Access service token cannot live in a
 * browser page, and an Access application "for the add-on origin" has nothing to verify — Meet
 * gives the iframe no identity a policy could check. The cost of SameSite=None is that a form on
 * another site could POST here with her cookie; the Worker refuses any state-changing request
 * whose `Sec-Fetch-Site` is not `same-origin`/`none` (index.ts, pinned in tests), which the
 * panel's own fetches satisfy. The one console step is the owner's, named in the PR.
 */

declare global {
  interface Window {
    meet?: {
      addon: {
        createAddonSession(opts: { cloudProjectNumber: string }): Promise<{
          createSidePanelClient(): Promise<{ getMeetingInfo(): Promise<{ meetingCode?: string; meetingId?: string }> }>;
        }>;
      };
    };
  }
}

type Resolved = { meeting_id: string; title: string; scheduled_at: string | null; meet_live_state: string | null; call_ended_at: string | null; source: string; candidates: number };

function codeFromHash(): string | null {
  const q = window.location.hash.split("?")[1] ?? "";
  const code = new URLSearchParams(q).get("code")?.trim().toLowerCase() ?? "";
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code) ? code : null;
}

/** Load the Add-ons SDK once and ask Meet which call this panel is beside. */
async function meetingCodeFromMeet(): Promise<{ code: string | null; detail: string }> {
  if (!window.meet) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = MEET_ADDON.sdkUrl;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("the Meet Add-ons SDK did not load"));
      document.head.appendChild(s);
    }).catch((err: Error) => ({ code: null, detail: err.message }));
  }
  if (!window.meet) return { code: null, detail: "Not inside Google Meet: the Add-ons SDK is not available here." };
  try {
    const session = await window.meet.addon.createAddonSession({ cloudProjectNumber: MEET_ADDON.cloudProjectNumber });
    const panel = await session.createSidePanelClient();
    const info = await panel.getMeetingInfo();
    const code = info.meetingCode?.trim().toLowerCase() ?? "";
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code) ? { code, detail: "" } : { code: null, detail: "Meet did not say which call this is." };
  } catch (err) {
    return { code: null, detail: `Meet refused the add-on session: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function MeetPanel(): JSX.Element {
  const me = useApi<MeResponse>("/api/me");
  const [code, setCode] = useState<string | null>(() => codeFromHash());
  const [codeDetail, setCodeDetail] = useState<string>("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolveStatus, setResolveStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const authed = me.status === 200 && Boolean(me.data);

  // 1 · which call
  useEffect(() => {
    if (code) return;
    let cancelled = false;
    void meetingCodeFromMeet().then((r) => {
      if (cancelled) return;
      setCode(r.code);
      setCodeDetail(r.detail);
    });
    return () => { cancelled = true; };
  }, [code]);

  // 3 · which meeting — and the end-of-call signal, polled while the panel is open.
  useEffect(() => {
    if (!authed || !code) return;
    let cancelled = false;
    const read = async () => {
      const r = await api<Resolved>(`/api/meet/live/resolve?code=${encodeURIComponent(code)}`);
      if (cancelled) return;
      setResolveStatus(r.status);
      setResolved(r.status === 200 ? r.data : null);
    };
    void read();
    const t = window.setInterval(() => void read(), 30_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [authed, code]);

  async function adopt() {
    if (!code) return;
    setBusy(true);
    setMessage(null);
    const r = await api<{ meeting_id: string; error?: string; detail?: string }>("/api/meet/live/adopt", { method: "POST", body: { code } });
    setBusy(false);
    if (r.status !== 201 || !r.data) {
      setMessage(r.data?.detail ?? r.data?.error ?? `Not recorded (HTTP ${r.status}).`);
      return;
    }
    const again = await api<Resolved>(`/api/meet/live/resolve?code=${encodeURIComponent(code)}`);
    setResolveStatus(again.status);
    setResolved(again.status === 200 ? again.data : null);
  }

  const origin = window.location.origin;
  const openAfter = () => window.open(`${origin}/#/meetings?open=${encodeURIComponent(resolved!.meeting_id)}&face=after`, "_blank", "noopener");

  return (
    <main className="surface-body room-standalone-shell meet-panel-shell" id="wp-surface" data-testid="meet-panel">
      {me.loading ? (
        <p className="muted small">Signing you in…</p>
      ) : !authed ? (
        <section className="card" data-testid="meet-panel-signin">
          <h3>Sign in to West Peek OS</h3>
          <p className="muted small">This panel uses your own West Peek OS session. Open the OS in a tab, sign in, then come back and try again.</p>
          <div className="actions">
            <button type="button" className="btn-strong" data-testid="meet-panel-open-os" onClick={() => window.open(origin, "_blank", "noopener")}>Open West Peek OS</button>
            <button type="button" className="btn-ghost" data-testid="meet-panel-retry" onClick={() => me.reload()}>Try again</button>
          </div>
        </section>
      ) : !code ? (
        <section className="card" data-testid="meet-panel-no-call">
          <h3>Which call?</h3>
          <p className="muted small" role="status">{codeDetail || "Asking Google Meet which call this panel is beside…"}</p>
        </section>
      ) : resolveStatus === null ? (
        <p className="muted small">Finding this call on the record…</p>
      ) : !resolved ? (
        <section className="card" data-testid="meet-panel-unknown">
          <h3>This call is not on the record</h3>
          <p className="muted small">Meet code <code>{code}</code> is not a meeting the calendar sync created. Record it now and the room opens here; it is filed as a meeting to check.</p>
          <button type="button" className="btn-strong" disabled={busy} data-testid="meet-panel-adopt" onClick={() => void adopt()}>{busy ? "Recording…" : "Record this meeting now"}</button>
          {message && <p className="notice small" role="status" data-testid="meet-panel-message">{message}</p>}
        </section>
      ) : (
        <>
          <header className="meet-panel-head" data-testid="meet-panel-head">
            <h3>{resolved.title}</h3>
            {resolved.call_ended_at ? (
              <p className="notice small" role="status" data-testid="meet-panel-ended">
                The call ended. <button type="button" className="btn-strong" data-testid="meet-panel-open-after" onClick={openAfter}>Open what came out of it</button>
              </p>
            ) : (
              <p className="muted small" data-testid="meet-panel-live-state">{resolved.source === "manual" ? "Recorded from this panel; the room hears through the microphone below." : "Beside the call. The room hears the Meet as the row says."}</p>
            )}
          </header>
          <RoomPanel meetingId={resolved.meeting_id} standalone />
        </>
      )}
    </main>
  );
}
