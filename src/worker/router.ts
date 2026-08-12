import type { Env } from "./env";
import type { FirmUserIdentity } from "./auth";

/** Minimal hand-rolled router for /api/* (P1). Intentionally small; grow with phases. */

export interface RouteContext {
  request: Request;
  env: Env;
  /** Authenticated identity — present only on routes with `auth: true`. */
  identity: FirmUserIdentity | null;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  auth: boolean;
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler, opts: { auth?: boolean } = {}): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      segments: pattern.split("/").filter((s) => s.length > 0),
      auth: opts.auth ?? true,
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler, opts: { auth?: boolean } = {}): this {
    return this.add("GET", pattern, handler, opts);
  }

  post(pattern: string, handler: RouteHandler, opts: { auth?: boolean } = {}): this {
    return this.add("POST", pattern, handler, opts);
  }

  patch(pattern: string, handler: RouteHandler, opts: { auth?: boolean } = {}): this {
    return this.add("PATCH", pattern, handler, opts);
  }

  /** Match a request; returns the route plus extracted `:param` values. */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter((s) => s.length > 0);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}
