// Copied from: seq23/boss-os src/worker/boss/lib/operatingStop.ts @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
// Copied from: seq23/boss-os src/worker/boss/agents/simoneSickDay.ts @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
import { z } from "zod";
import { PARTNERS } from "../../shared/registry/partners";
import type { MailAuthority } from "../../shared/intake/partnerAuthority";
import type { Env } from "../env";
import { eventStatement } from "../events";
import { json, type RouteContext } from "../router";

const OWNER = PARTNERS.find((partner) => partner.firstName === "Sequoia")!;
const DAY = 86_400_000;
export const OPERATIONS_ENABLED = "(SELECT stopped FROM owner_operating_control WHERE id = 1) = 0";

export async function operatingStopped(env: Env): Promise<boolean> {
  const row = await env.WP_OS_DB.prepare(`SELECT ${OPERATIONS_ENABLED} AS enabled`).first<{ enabled: number }>();
  return row?.enabled !== 1;
}

async function setOperatingStop(env: Env, stopped: boolean, source: "email" | "page") {
  const db = env.WP_OS_DB;
  const event = eventStatement(env, {
    eventType: stopped ? "operations.stopped" : "operations.resumed",
    actorType: "firm_user", actorId: OWNER.firmUserId,
    objectType: "owner_operating_control", objectId: "1",
    payload: { source },
  });
  const statements = [
    db.prepare("UPDATE owner_operating_control SET stopped = ?1 WHERE id = 1").bind(stopped ? 1 : 0),
    event.statement,
  ];
  if (stopped) {
    // Invalidate a running Mac's lease even if the owner resumes between two of its pings.
    statements.push(db.prepare(`UPDATE subscription_seat_run
      SET status = 'ABANDONED', resolution = 'Paused by the owner', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status = 'CLAIMED'`));
  }
  await db.batch(statements);
}

const emailCover = z.object({
  operation: z.literal("cover_mailbox"),
  mailbox: z.literal(OWNER.email),
  until: z.string().datetime({ offset: true }).optional(),
}).strict();

/** Controls come from a fresh, directly delivered owner email or a confirmed owner page action. */
export async function applyChiefControlEmail(
  env: Env,
  input: { authority: MailAuthority; words: string; direct: boolean },
  now = Date.now(),
): Promise<boolean> {
  if (!input.direct || !input.authority.isAssignment || input.authority.partnerAddress !== OWNER.email) return false;
  const words = input.words.trim();
  // Explicit command syntax, never a scan for a phrase in a larger message or quoted thread.
  if (words.toLowerCase() === "stop everything" || words.toLowerCase() === "resume") {
    await setOperatingStop(env, words.toLowerCase() === "stop everything", "email");
    return true;
  }
  if (!words.startsWith("{") || words.length > 512) return false;
  let value: unknown;
  try { value = JSON.parse(words); } catch { return false; }
  const parsed = emailCover.safeParse(value);
  if (!parsed.success) return false;
  const until = parsed.data.until === undefined ? now + 3 * DAY : Date.parse(parsed.data.until);
  if (!Number.isFinite(until) || until <= now || until > now + 7 * DAY) return false;
  const event = eventStatement(env, {
    eventType: "chief.mail_cover_opened",
    actorType: "firm_user", actorId: OWNER.firmUserId,
    objectType: "owner_operating_control", objectId: "1",
    payload: { until_ms: until },
  });
  await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare("UPDATE owner_operating_control SET wren_mail_until_ms = ?1 WHERE id = 1").bind(until),
    event.statement,
  ]);
  return true;
}

/** The extra switch only applies to Wren's access to the owner's mailbox. */
export async function chiefCoverageAllows(
  env: Env, chiefId: string, service: string, account: string, now = Date.now(),
): Promise<boolean> {
  if (chiefId !== "aie_wren" || service !== "mail" || account.trim().toLowerCase() !== OWNER.email) return true;
  const row = await env.WP_OS_DB.prepare("SELECT wren_mail_until_ms FROM owner_operating_control WHERE id = 1")
    .first<{ wren_mail_until_ms: number | null }>();
  return typeof row?.wren_mail_until_ms === "number" && row.wren_mail_until_ms > now;
}

export async function handleOperatingControl({ identity, request, env }: RouteContext): Promise<Response> {
  if (identity?.id !== OWNER.firmUserId || !identity.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "not_found" }, { status: 404 });
  }
  const reply = (stopped: boolean) => json({ stopped }, { headers: { "Cache-Control": "no-store" } });
  if (request.method === "GET") return reply(await operatingStopped(env));
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body) {
    return json({ error: "unsupported_media_type" }, { status: 415 });
  }
  const bytes = new Uint8Array(64);
  const reader = request.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > bytes.length) {
      await reader.cancel();
      return json({ error: "body_too_large" }, { status: 413 });
    }
    bytes.set(value, size);
    size += value.length;
  }
  let command: unknown;
  try { command = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); } catch { /* invalid command */ }
  if (command !== "pause-confirmed" && command !== "resume") {
    return json({ error: "confirmation_required" }, { status: 400 });
  }
  const stopped = command === "pause-confirmed";
  await setOperatingStop(env, stopped, "page");
  return reply(stopped);
}
