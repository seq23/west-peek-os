/**
 * THE PRACTICE WORKER (15 Nov 2026). Runs on this machine only (`wrangler dev` on 127.0.0.1, started by
 * scripts/practice/practice.mjs) with the BRANCH's code and production's D1 / R2 / KV / AI / Boss OS brain over
 * remote bindings. It has one route and it is the dry run: `dryReadMessage` reads a stored message and returns what the
 * door would do, writing nothing but its own model-run bookkeeping (removed again by `forgetDryRun`) and sending nothing.
 * No cron, no queue, no email binding, no secret: none of the real Worker's routes exist here.
 */
import type { Env } from "../../src/worker/env";
import { dryReadMessage } from "../../src/worker/effects/inboundEmail";

type PracticeEnv = Env & { PRACTICE_NONCE: string };

export default {
  async fetch(request: Request, env: PracticeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/practice") return new Response("not found", { status: 404 });
    if (!env.PRACTICE_NONCE || request.headers.get("x-practice-nonce") !== env.PRACTICE_NONCE) return new Response("forbidden", { status: 403 });
    const body = (await request.json().catch(() => null)) as { inbound_message_id?: unknown } | null;
    const id = typeof body?.inbound_message_id === "string" ? body.inbound_message_id : "";
    const row = await env.WP_OS_DB.prepare("SELECT r2_key FROM inbound_message WHERE id = ?1").bind(id).first<{ r2_key: string }>();
    if (!row?.r2_key) return Response.json({ error: "not_found", detail: `no inbound_message ${id}` }, { status: 404 });
    const stored = await env.WP_OS_DOCUMENTS?.get(row.r2_key);
    if (!stored) return Response.json({ error: "not_found", detail: `${row.r2_key} is not in R2` }, { status: 404 });
    return Response.json({ ok: true, dry_run: true, object_key: row.r2_key, would: await dryReadMessage(env, await stored.text()) });
  },
};
