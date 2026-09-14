import { useCallback, useEffect, useState } from "react";

/**
 * Shared client plumbing. Extracted at P14 so the continuation's new surfaces can live in
 * their own files instead of growing one page module without limit. Behaviour is
 * unchanged from the P3 implementation: identity comes from /api/me, and in local mode
 * the dev identity header is sent from localStorage.
 */

const DEV_USER_KEY = "wpos.devUser";

export function getDevUser(): string | null {
  try {
    return window.localStorage.getItem(DEV_USER_KEY);
  } catch {
    return null;
  }
}

export function setDevUser(email: string | null): void {
  try {
    if (email) window.localStorage.setItem(DEV_USER_KEY, email);
    else window.localStorage.removeItem(DEV_USER_KEY);
  } catch {
    // localStorage unavailable — identity simply won't persist.
  }
}

/**
 * End the session properly (P42).
 *
 * THE DEFECT THIS FIXES: sign-out was rendered only when a dev identity was present, so in
 * production — behind Cloudflare Access, which is the only real deployment — there was no way to
 * sign out at all. Clearing local state there would also have been theatre: identity comes from an
 * Access cookie this app does not own, so a "signed out" screen with a live Access session is a
 * lie the next page load exposes.
 *
 * So there are two genuinely different exits:
 *   · local — drop the dev identity; that IS the whole session.
 *   · production — drop local state, then hand off to Access's own logout endpoint, which is the
 *     only thing that can actually invalidate the session.
 *
 * Returns where the caller should send the browser, or null when the sign-out is complete locally.
 */
export function signOut(): string | null {
  const wasDev = Boolean(getDevUser());
  setDevUser(null);
  try {
    // Anything cached about the previous identity goes too. A stale nav position or home layout
    // belonging to someone else is a small leak, but it is still a leak.
    window.sessionStorage.clear();
  } catch {
    // Storage unavailable; nothing was cached, so nothing to clear.
  }
  if (wasDev) return null;
  // Cloudflare Access owns the production session. This is its documented logout path.
  return "/cdn-cgi/access/logout";
}

/**
 * Anything that changes a notification tells everything that counts notifications.
 *
 * THE BUG THIS EXISTS FOR. Operator, 9 Sep 2026: "the west peek os home screen still says 12 unread
 * even tho i read it all and dismissed or took responsibility."
 *
 * She was right and the number was frozen. `StatusBar` fetched `/api/notifications?unread=1` into
 * its OWN `useApi` instance, refreshed only when App's `refreshNonce` changed — and `refreshNonce`
 * was passed to exactly two components, `CapturePage` and `WorkSurface`. The Notifications page was
 * not one of them: dismissing called `notifications.reload()`, which bumps that page's local nonce
 * and cannot reach the status bar's. So the page correctly said "You are caught up" while the badge
 * above it kept displaying the number it had fetched when the tab was opened. On 9 Sep her true
 * unread count was ZERO — all twenty-six unread rows in production are addressed to Scooter — and
 * the badge was still showing a count from earlier in the session. Two components, each keeping its
 * own copy of the same number, with nothing linking them.
 *
 * WHY A CHANNEL RATHER THAN ONE MORE PROP. Wiring `refreshNonce` into the Notifications page would
 * fix today's symptom and leave the trap: the next surface that marks something read has to
 * remember to call a prop it was never given, and forgetting is silent. Publishing from `api()`
 * itself means the invalidation happens because the WRITE happened, so no caller can forget it.
 *
 * Deliberately narrow: only a mutating request under `/api/notifications`, and only one that the
 * server accepted. A failed dismiss must not clear a badge that is still correct.
 */
const notificationListeners = new Set<() => void>();

/** Subscribe to "a notification changed". Returns the unsubscribe. */
export function onNotificationsChanged(listener: () => void): () => void {
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}

/** Announce it. Exported for tests and for any caller that mutates outside `api()`. */
export function notificationsChanged(): void {
  for (const listener of [...notificationListeners]) {
    try {
      listener();
    } catch {
      // One bad subscriber must not stop the others being told.
    }
  }
}

/** Did this call change a notification, and did the server accept it? */
function mutatedNotifications(path: string, method: string, status: number): boolean {
  if (method === "GET") return false;
  if (!path.startsWith("/api/notifications")) return false;
  // A preference save changes when she is interrupted, never what is outstanding.
  if (path.startsWith("/api/notifications/preferences")) return false;
  return status >= 200 && status < 300;
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  const devUser = getDevUser();
  if (devUser) headers["x-wpos-dev-user"] = devUser;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  /*
   * A NETWORK FAILURE IS A RESULT, NOT AN EXCEPTION.
   *
   * `fetch` rejects when the request never reaches the origin — offline, DNS, a dropped
   * connection. This used to propagate, and almost no caller wrapped it, so a click made on a
   * train produced an unhandled rejection and a page that simply did nothing.
   *
   * Status 0 matches what `useApi` already records for the same condition, so every reader —
   * `stateMessage`, `isFailure`, `mutationError` — treats a dead connection the same way whether
   * it happened on a load or on a save. Callers that already wrap this in try/catch keep working;
   * their catch simply stops firing.
   */
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    return { status: 0, data: null };
  }
  const data = (await res.json().catch(() => null)) as T | null;
  if (mutatedNotifications(path, options.method ?? "GET", res.status)) notificationsChanged();
  return { status: res.status, data };
}

export function useApi<T>(
  path: string | null,
  deps: unknown[] = [],
): { data: T | null; status: number | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; status: number | null; loading: boolean }>({
    data: null,
    status: null,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!path) {
      setState({ data: null, status: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    // A DROPPED CONNECTION IS RETRIED BEFORE IT IS REPORTED. Status 0 is "the request never got an
    // answer" — a blip, a proxy that dropped the socket (wrangler dev does this under load; the
    // CI sweep read six lists as blank on 14 Sep for exactly that), a laptop waking up. One or two
    // quick retries turn most of those into the page the reader was going to see anyway; only a
    // connection that stays down is shown as one.
    const attempt = (n: number): void => {
      api<T>(path)
        .then(({ status, data }) => {
          if (cancelled) return;
          if (status === 0 && n < 2) {
            setTimeout(() => attempt(n + 1), 300 * (n + 1));
            return;
          }
          setState({ data, status, loading: false });
        })
        .catch(() => {
          if (!cancelled) setState({ data: null, status: 0, loading: false });
        });
    };
    attempt(0);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);
  return { ...state, reload };
}

export interface MeResponse {
  id: string;
  email: string;
  fullName: string;
  status: string;
  roles: string[];
  authorityScopes: Array<{ scopeKey: string; scopeValue: string }>;
}

/**
 * Small shared presentation primitives (task §11): every surface must show empty,
 * loading, and error states rather than an ambiguous blank.
 *
 * WHY THIS MATTERS MORE HERE THAN IN MOST PRODUCTS. `authorize()` fails CLOSED: an action key that
 * is not in the action_type table returns 403. That is the failure this system produces most often,
 * and a surface that renders `data?.items ?? []` answers it with "Nothing in the pipeline yet."
 * The operator is then told the firm has no deals when the truth is that the request was refused.
 *
 * STATUS 0 IS A FAILURE, NOT AN EMPTY LIST. `useApi` sets status 0 when fetch itself rejects —
 * offline, DNS, a dropped connection. The previous test here was `status >= 400`, so 0 fell through
 * to the empty text: the helper written to stop failure looking like emptiness had that very bug
 * inside it, which is a fair part of why nobody adopted it.
 */
export function stateMessage(loading: boolean, status: number | null, emptyText: string, isEmpty: boolean): string | null {
  if (loading) return "Loading…";
  if (status === 0) return "Could not reach the server. Check your connection and try again.";
  if (status !== null && status >= 400) return failureText(status);
  if (isEmpty) return emptyText;
  return null;
}

/** True when the surface should present a FAILURE rather than an absence. */
export function isFailure(loading: boolean, status: number | null): boolean {
  return !loading && status !== null && (status === 0 || status >= 400);
}

/**
 * What a failed call should say to a partner, in their language rather than the protocol's.
 *
 * 403 is spelled out because it is the one this system produces by design, and "Forbidden" tells
 * the reader nothing they can act on. The number is kept on the end of every message: it is the
 * one thing that makes a report to whoever maintains this useful.
 */
export function failureText(status: number): string {
  if (status === 0) return "Could not reach the server. Check your connection and try again.";
  if (status === 401) return "You are not signed in any more. Reload the page to sign in again.";
  if (status === 403) return "You are not allowed to do that. If you expected to be, it needs an approval or a role you do not hold (HTTP 403).";
  if (status === 404) return "That is no longer there. It may have been removed or renamed (HTTP 404).";
  if (status === 409) return "Something else changed this first. Reload and look before trying again (HTTP 409).";
  if (status >= 500) return `The server failed on this one. Nothing was changed (HTTP ${status}).`;
  return `That did not work (HTTP ${status}).`;
}

/**
 * The message a MUTATION should show, or null when it succeeded.
 *
 * WHY A HELPER AND NOT A CONVENTION. The overwhelming majority of mutating handlers in this client
 * were written as `await api(...)` followed by a reload, with the status discarded — so a refusal,
 * an expired card and a success were indistinguishable, and the operator's only signal was that
 * nothing changed. A convention did not hold; a one-line helper might.
 *
 *   const failed = mutationError(await api(path, { method: "POST", body }), 201);
 *   if (failed) { setMessage(failed); return; }
 *
 * `expected` accepts one status or several, because this API answers 200 and 201 in different
 * places for the same kind of act.
 */
export function mutationError(
  result: { status: number; data: unknown },
  expected: number | number[] = [200, 201],
): string | null {
  const ok = Array.isArray(expected) ? expected : [expected];
  if (ok.includes(result.status)) return null;

  // The server's own reason is better than ours whenever it gave one — it knows which rule refused.
  const detail = result.data as { error?: unknown; detail?: unknown } | null;
  const server = typeof detail?.detail === "string" ? detail.detail : null;
  if (server) return `${server} (HTTP ${result.status})`;
  return failureText(result.status);
}
