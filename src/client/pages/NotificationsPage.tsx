import { useEffect, useMemo, useState } from "react";
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
            title="Takes it off your list. Nothing is recorded beyond your having seen it."
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
        {/*
          ACKNOWLEDGE IS OFFERED WHERE IT MEANS SOMETHING, and the page now says what that is.
          Operator, 22 Aug 2026: "what is the purpose of acknowledge?" and then "it needs to be there
          when to acknowledge and why at least."

          Dismiss and Acknowledge are different acts and were sitting an inch apart with nothing
          saying so. DISMISS is "seen, take it off my list" — read state, nothing more. ACKNOWLEDGE
          is a partner putting her name and the time against having seen it, on the audit trail, so
          the firm can later show somebody did. That is only worth anything where being able to show
          it matters, which is why it appears on CRITICAL and WARNING and nowhere else: offering it
          on a routine notice trains a partner to click it without reading, which destroys the only
          value it has.
        */}
        {n.acked_at === null && (n.severity === "CRITICAL" || n.severity === "WARNING") && (
          <button
            type="button"
            className="btn-strong"
            title="Puts your name and the time against this on the audit trail."
            data-testid={`notification-ack-${n.id}`}
            onClick={async () => {
              const res = await api<{ error?: string }>(`/api/notifications/${n.id}/acknowledge`, { method: "POST" });
              onMessage(
                res.status === 200
                  ? "Acknowledged. Your name and the time are on the record against it."
                  : "That did not go through. Nothing was recorded — try again.",
              );
              onChanged();
            }}
          >
            Take responsibility
          </button>
        )}
        {n.acked_at !== null && (
          <span className="help-tag help-tag-good" data-testid={`notification-acked-${n.id}`}>
            you took this on
          </span>
        )}
      </div>
    </li>
  );
}

/** 0–23, in the zone the reader picked. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** "9:00 PM", not "21". Nobody says "quiet from twenty-one". */
function hourLabel(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${suffix}`;
}

/**
 * The zones on offer, plus wherever this browser currently is.
 *
 * NAMED ZONES, NOT OFFSETS, AND STORED RATHER THAN INFERRED. Quiet hours used to be computed from
 * the browser's offset at the moment of saving, which broke two ways: it drifted by an hour twice a
 * year at daylight saving, and it moved by five hours the moment the app was opened somewhere else.
 * Operator: "i could be traveling on diff time zone so let me select time zone for quiet hours."
 *
 * The browser's own zone is offered first as a convenience and is never assumed — travelling is
 * exactly the case where the browser is wrong about where you live.
 */
const COMMON_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Singapore",
  "Asia/Tokyo",
  "UTC",
];

function zoneChoices(): string[] {
  let here = "UTC";
  try {
    here = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    here = "UTC";
  }
  // CONFIRMED 3 Sep 2026: `here` is already one of the nine COMMON_ZONES entries for anyone in
  // New York, Chicago, Denver, LA, London, Paris, Singapore, Tokyo, or UTC — which is most of
  // this firm — and the old `includes` check then returned COMMON_ZONES UNCHANGED, silently
  // defaulting a fresh picker to whatever sits first in that fixed list ("America/New_York")
  // instead of the reader's own zone. A partner in Chicago got New York's hour, one hour off;
  // a browser reporting UTC (any headless CI runner) got New York's hour, four hours off — which
  // is exactly why "quiet hours actually hold something back" failed the browser-computed
  // current-hour check on a UTC runner while happening to half-overlap and pass locally in
  // Chicago. Always put `here` first, deduped, so the comment above ("offered first") is true.
  return [here, ...COMMON_ZONES.filter((zone) => zone !== here)];
}

/** "America/New_York" reads badly in a sentence; "New York" does. */
function zoneLabel(tz: string): string {
  return tz === "UTC" ? "UTC" : tz.split("/").slice(-1)[0]!.split("_").join(" ");
}

/** How long the window actually is, wrapping over midnight. */
function quietWindowHours(start: number, end: number): number {
  return end > start ? end - start : 24 - start + end;
}

export function NotificationsPage({ me }: { me: MeResponse }) {
  const notifications = useApi<{ notifications: Notification[]; unread_count: number; critical_unread: number; note: string }>(
    "/api/notifications",
  );
  const prefs = useApi<{ preference: { quiet_hours_json: string; push_enabled: number } | null; kinds: string[]; rules: Record<string, string> }>(
    "/api/notifications/preferences",
  );
  const [message, setMessage] = useState<string | null>(null);
  /*
   * QUIET HOURS ARE HELD AND SHOWN IN THE READER'S OWN TIME.
   *
   * They were two bare number boxes asking for a UTC hour, so a partner in New York had to do the
   * arithmetic herself to say "hold things overnight" — and get it wrong twice a year. Storage stays
   * UTC because the server compares against UTC; only the presentation changes. Whole hours
   * throughout, so a half-hour timezone shifts by its whole-hour part; nobody at this firm is in one,
   * and pretending to more precision than the stored integer holds would be a different lie.
   */
  const [quietStartLocal, setQuietStartLocal] = useState(21);
  const [quietEndLocal, setQuietEndLocal] = useState(7);
  const [quietZone, setQuietZone] = useState(() => zoneChoices()[0]!);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  // Closed by default. What you have already dealt with is history, and history does not open first.
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
   * SEEDED FROM WHAT IS STORED. The pickers defaulted to 9 PM–7 AM no matter what the firm had
   * actually saved, so the page showed a setting that was not the setting — and pressing Save
   * silently overwrote the real one with the default.
   */
  const savedQuiet = prefs.data?.preference?.quiet_hours_json;
  useEffect(() => {
    if (!savedQuiet) return;
    try {
      const parsed = JSON.parse(savedQuiet) as { start?: number; end?: number; timezone?: string };
      if (typeof parsed.start === "number") setQuietStartLocal(parsed.start);
      if (typeof parsed.end === "number") setQuietEndLocal(parsed.end);
      if (typeof parsed.timezone === "string" && parsed.timezone) setQuietZone(parsed.timezone);
    } catch {
      // A malformed stored value leaves the pickers alone rather than throwing the page away.
    }
  }, [savedQuiet]);

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
          {/*
            Said once, where the two buttons actually appear, rather than left to be inferred from
            two words an inch apart. The operator asked what acknowledge is for; the honest answer is
            short enough to print.
          */}
          {needsYou.some((n) => n.acked_at === null && (n.severity === "CRITICAL" || n.severity === "WARNING")) && (
            <p className="muted small" data-testid="notifications-ack-explainer">
              <strong>Dismiss</strong> takes something off your list. <strong>Take responsibility</strong> puts
              your name and the time against it on the record — worth doing on anything the firm might
              later need to show a partner saw, and offered nowhere else for exactly that reason.
            </p>
          )}
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

        {/*
          SAYS WHAT IT ACTUALLY DOES. The old sentence — "quiet hours hold everything back" — was
          more than this can currently deliver, in two ways. Nothing is removed from this page: a
          held notice is still here to be read, because holding is about not INTERRUPTING you, not
          about hiding what happened. And there is no push service, VAPID key or subscription in this
          environment, so the only channel that could interrupt you is recorded UNAVAILABLE on every
          notification. Quiet hours are real and applied; what they govern today is smaller than the
          old sentence implied, and a setting that overstates itself is one you stop trusting.
        */}
        <p className="muted small">
          Quiet hours mark everything except CRITICAL as held until they end, so nothing chases you
          overnight. Held notices still appear on this page — holding means not interrupting you, not
          hiding it. Nothing is sent to a phone yet by any route, at any hour.
        </p>

        <form
          className="quiet-hours"
          data-testid="quiet-hours-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaveState("saving");
            const res = await api<{ push_note?: string }>("/api/notifications/preferences", {
              method: "POST",
              body: {
                // Sent exactly as chosen. The zone travels with them, so the server never has to
                // guess and nothing drifts at daylight saving.
                quiet_hours: { start: quietStartLocal, end: quietEndLocal, timezone: quietZone },
                push_enabled: false,
              },
            });
            if (res.status === 201) {
              setSaveState("saved");
              setMessage(null);
              prefs.reload();
              // Back to "Save" after a moment. A button that says "Saved" for ever is a button that
              // stops meaning anything the next time you press it.
              setTimeout(() => setSaveState("idle"), 2500);
            } else {
              setSaveState("idle");
              // Was `Refused (HTTP 500)`. A partner cannot act on a status code.
              setMessage("That did not save. Nothing changed — try once more, and if it keeps failing say so.");
            }
          }}
        >
          {/* Reads as a sentence, because that is what it is. Two dropdowns inside one line beat two
              boxes and a unit nobody thinks in. */}
          <p className="quiet-hours-line">
            Hold everything from{" "}
            <select
              data-testid="quiet-start"
              aria-label="Quiet hours start"
              value={quietStartLocal}
              onChange={(e) => { setQuietStartLocal(Number(e.target.value)); setSaveState("idle"); }}
            >
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>{" "}
            until{" "}
            <select
              data-testid="quiet-end"
              aria-label="Quiet hours end"
              value={quietEndLocal}
              onChange={(e) => { setQuietEndLocal(Number(e.target.value)); setSaveState("idle"); }}
            >
              {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>{" "}
            in{" "}
            <select
              data-testid="quiet-zone"
              aria-label="Which timezone these hours are in"
              value={quietZone}
              onChange={(e) => { setQuietZone(e.target.value); setSaveState("idle"); }}
            >
              {zoneChoices().map((tz) => <option key={tz} value={tz}>{zoneLabel(tz)}</option>)}
            </select>
          </p>

          <p className="muted small" data-testid="quiet-hours-plain">
            {quietStartLocal === quietEndLocal
              ? "Start and end are the same, so nothing is held back."
              : `That is ${quietWindowHours(quietStartLocal, quietEndLocal)} hours a night in ${zoneLabel(quietZone)}, wherever you happen to be. Anything critical still comes through.`}
          </p>

          <div className="quiet-hours-actions">
            <button type="submit" className="btn-strong" disabled={saveState === "saving"} data-testid="quiet-submit">
              {saveState === "saving" ? "Saving…" : "Save"}
            </button>
            {/* The change of state the operator asked for: the button itself moves, and a word
                appears beside it. Previously pressing Save did nothing visible at all. */}
            {saveState === "saved" && (
              <span className="help-tag help-tag-good" data-testid="quiet-saved">Saved</span>
            )}
          </div>
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
