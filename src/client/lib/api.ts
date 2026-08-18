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

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  const devUser = getDevUser();
  if (devUser) headers["x-wpos-dev-user"] = devUser;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = (await res.json().catch(() => null)) as T | null;
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
    api<T>(path)
      .then(({ status, data }) => {
        if (!cancelled) setState({ data, status, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, status: 0, loading: false });
      });
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
 */
export function stateMessage(loading: boolean, status: number | null, emptyText: string, isEmpty: boolean): string | null {
  if (loading) return "Loading…";
  if (status !== null && status >= 400) return `Could not load (HTTP ${status}).`;
  if (isEmpty) return emptyText;
  return null;
}
