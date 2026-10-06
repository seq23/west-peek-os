import type { Env } from "../env";
import { appendEvent } from "../events";
import { json, type RouteContext } from "../router";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { carriesSecretValue, scrubSecretValues, textBodyOf } from "../effects/mimeAttachments";
import { githubReposIn, propertiesIn, type WebProperty } from "../../shared/intake/webPropertyChange";
import { sendOrPreview } from "./previewApproval";

/**
 * SECRETS BY EMAIL, HANDS OFF (0253; owner, 6 Oct 2026: "new repo secrets needs an easier hands off
 * approach — we should be able to email them and u should look them up in the vault when necessary
 * without approval").
 *
 * An authenticated partner — SPF/DKIM aligned, one of the two addresses, the same gate every
 * assignment passes — writes lines of the form
 *
 *     SECRET GIPHY_API_KEY=abc123
 *
 * in an email to os@. This file is the whole of what happens to the value:
 *
 *   1 · the NAME is validated: vendor-prefixed (`VENDOR_THING`), never one of the reserved names a
 *       process reads for itself (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, PATH, LD_PRELOAD, DYLD_*,
 *       NODE_OPTIONS …) — a value the owner's seat or the loader would honour is refused BY NAME;
 *   2 · the value is encrypted (AES-256-GCM under WP_OS_SECRET_HANDOFF_KEY, a Worker secret set once
 *       from the vault and NAMED in the RUNBOOK) and kept in `secret_handoff` with a TTL — never in
 *       `work_card`, `event_record`, `inbound_message`, a card, a log line or an email;
 *   3 · the stored `.eml` in R2 is scrubbed (`scrubSecretValues`), and the text handed on to the
 *       door is the scrubbed text, so nothing downstream can copy the value anywhere;
 *   4 · the partner hears "Stored <NAME> for <repo>; it is never shown again";
 *   5 · the Mac's claimer pulls pending rows on its heartbeat over the Access-authenticated channel,
 *       writes each into the local vault (value process → Keychain-custodied file, never a command
 *       line), and tells the Worker, which deletes the row.
 *
 * FAIL CLOSED: no key configured → nothing is stored, the partner is told the door is not set up
 * (the ONE named stop here, and it is the owner's one-time `vault:set` + `vault:sync:cloudflare`),
 * and the value is still scrubbed from everything the Worker kept.
 *
 * `validate:open-repo-door` and `tests/secretHandoff.test.ts` send a fake value through this door
 * and grep every sink for it.
 */

export const SECRET_HANDOFF_KEY_NAME = "WP_OS_SECRET_HANDOFF_KEY";
export const SECRET_REDACTED = "[secret redacted]";
/** How long an unclaimed value may wait for the Mac. The claimer pulls every 30 s; a week covers a holiday. */
export const SECRET_HANDOFF_TTL_MS = 7 * 24 * 3600_000;

/**
 * Names no email may set. Exact names a process or loader honours for itself, and prefixes that
 * name the owner's seat, a loader or the shell. Vendor keys never start with these.
 */
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "CI",
  "GIT_SSH_COMMAND",
  "SSH_AUTH_SOCK",
  "WP_OS_SECRET_HANDOFF_KEY",
  "WP_OS_MAC_ACCESS_CLIENT_ID",
  "WP_OS_MAC_ACCESS_CLIENT_SECRET",
]);
export const RESERVED_SECRET_PREFIXES: readonly string[] = ["ANTHROPIC_", "CLAUDE_", "DYLD_", "LD_", "NODE_", "NPM_", "GIT_", "SSH_", "BASH_", "ZSH_", "XDG_"];

/** Why a name is refused, or null when it may be stored. */
export function secretNameProblem(name: string): string | null {
  const n = String(name ?? "").trim();
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(n)) return "a secret name is SCREAMING_SNAKE_CASE, 3–64 characters";
  if (RESERVED_SECRET_NAMES.has(n)) return `${n} is reserved — a process reads it for itself; it is never set by email`;
  const prefix = RESERVED_SECRET_PREFIXES.find((p) => n.startsWith(p));
  if (prefix) return `${n} starts with ${prefix}, a reserved prefix (the owner's seat, a loader or the shell); use the vendor's own name`;
  if (!n.includes("_")) return `${n} has no vendor prefix — name it VENDOR_THING (GIPHY_API_KEY, RESEND_API_KEY)`;
  return null;
}

/** `SECRET NAME=value` on its own line. The value runs to the end of the line; surrounding quotes are dropped. */
const SECRET_LINE = /^[ \t>]*SECRET[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.+?)[ \t]*$/gm;

export interface SecretLinesRead {
  found: Array<{ name: string; value: string }>;
  refused: Array<{ name: string; why: string }>;
  /** The text with every SECRET line replaced by `SECRET NAME=[secret redacted]`. */
  scrubbed: string;
  /** Every value seen, accepted or refused — all of them are scrubbed from every sink. */
  values: string[];
}

/** Read the SECRET lines out of a decoded body. Pure. */
export function readSecretLines(text: string): SecretLinesRead {
  const found: SecretLinesRead["found"] = [];
  const refused: SecretLinesRead["refused"] = [];
  const values: string[] = [];
  const scrubbed = (text ?? "").replace(SECRET_LINE, (_m, name: string, rawValue: string) => {
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value.length >= 4) values.push(value);
    const why = secretNameProblem(name);
    if (why) refused.push({ name, why });
    else if (!value || value.length < 4) refused.push({ name, why: "the value is empty or shorter than 4 characters" });
    else if (!found.some((f) => f.name === name)) found.push({ name, value });
    return `SECRET ${name}=${SECRET_REDACTED}`;
  });
  return { found, refused, scrubbed, values: [...new Set(values)] };
}

// ── The cipher ────────────────────────────────────────────────────────────────────────────────

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function cipherKey(env: Env): Promise<CryptoKey | null> {
  const raw = env.WP_OS_SECRET_HANDOFF_KEY;
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = unb64(raw.trim());
  } catch {
    return null;
  }
  if (bytes.byteLength !== 32) return null;
  return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** True when the Worker holds a usable key. Read by the door to fail closed with a reason. */
export async function secretDoorConfigured(env: Env): Promise<boolean> {
  return (await cipherKey(env)) !== null;
}

export async function encryptSecret(env: Env, value: string): Promise<{ ciphertext: string; iv: string } | null> {
  const key = await cipherKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(value));
  return { ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
}

export async function decryptSecret(env: Env, row: { ciphertext: string; iv: string }): Promise<string | null> {
  const key = await cipherKey(env);
  if (!key) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv) as BufferSource }, key, unb64(row.ciphertext) as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ── The door ──────────────────────────────────────────────────────────────────────────────────

export interface SecretDoorOutcome {
  /** The MIME text with every value scrubbed — what every door downstream must read instead of the original. */
  raw: string;
  stored: Array<{ name: string; repo: string | null }>;
  refused: Array<{ name: string; why: string }>;
  /** True when the written part of the email was nothing but SECRET lines (and a greeting): no card is opened. */
  onlySecrets: boolean;
  /** One line for the RECEIVED email, or null when nothing was stored or refused. */
  line: string | null;
}

/** Which repo the email is about, for the row and the reply: a named GitHub repo, else a registered property. */
export function repoNamedIn(text: string, registry: readonly WebProperty[]): string | null {
  const repos = githubReposIn(text, [...new Set(registry.map((p) => p.githubRepo?.split("/")[0] ?? "").filter(Boolean)), "seq23"]);
  if (repos.length) return repos[0]!.name;
  const props = propertiesIn(text, registry);
  return props.length ? props[0]!.repo : null;
}

/** True when nothing but greetings, sign-offs and redacted SECRET lines remain. */
export function nothingButSecrets(scrubbedWritten: string): boolean {
  const rest = scrubbedWritten
    .replace(/^.*SECRET [A-Z0-9_]+=.*$/gm, "")
    .replace(/^\s*(hey|hi|hello|yo|dear|morning|afternoon)?[\s,!]*porter\b[\s,!:—–-]*$/gim, "")
    .replace(/^\s*(thanks|thank you|cheers|best|regards|ty|thx)[\s,!.]*$/gim, "")
    .replace(/^\s*(here (are|is) (the|some|my)? ?(keys?|secrets?|credentials?)|for the vault|secrets? for [\w./-]+|keys? for [\w./-]+)[\s,!.:]*$/gim, "")
    .replace(/^\s*(sequoia|scooter)[\s,!.]*$/gim, "")
    .replace(/^\s*--+\s*$/gm, "")
    .replace(/[^A-Za-z0-9]+/g, "");
  return rest.length === 0;
}

/**
 * RUN THE DOOR on an authenticated partner's message. Reads the decoded written text, stores what it
 * may, scrubs EVERY value (accepted or refused) from the MIME text and from the stored `.eml`, and
 * replies. Returns the scrubbed text; the caller MUST use it in place of the original.
 */
export async function secretDoor(
  env: Env,
  input: {
    raw: string;
    /** The subject, read for the repo's name beside the body. */
    subject?: string | null;
    kept: { key: string | null; rowId: string | null };
    partnerAddress: string;
    firmScope: string;
    registry: readonly WebProperty[];
    employee: string;
    replyOnThread?: string | null;
  },
): Promise<SecretDoorOutcome> {
  const written = textBodyOf(input.raw);
  const read = readSecretLines(written);
  if (!read.found.length && !read.refused.length) return { raw: input.raw, stored: [], refused: [], onlySecrets: false, line: null };

  const scrubbedRaw = scrubSecretValues(input.raw, read.values, SECRET_REDACTED);
  // The .eml in R2 FIRST, so a failure anywhere below still leaves no value in the store.
  if (input.kept.key && env.WP_OS_DOCUMENTS) {
    try {
      const obj = await env.WP_OS_DOCUMENTS.get(input.kept.key);
      if (obj) {
        const text = await obj.text();
        const clean = scrubSecretValues(text, read.values, SECRET_REDACTED);
        if (clean !== text || carriesSecretValue(text, read.values)) {
          await env.WP_OS_DOCUMENTS.put(input.kept.key, clean, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { ...(obj.customMetadata ?? {}), scrubbed: "secret redacted" } });
        }
      }
    } catch {
      /* the scrub is retried below by the guard's own check; the value is still not in any row */
    }
  }

  const repo = repoNamedIn(`${input.subject ?? ""}\n${read.scrubbed}`, input.registry);
  const configured = await secretDoorConfigured(env);
  const stored: SecretDoorOutcome["stored"] = [];
  const refused: SecretDoorOutcome["refused"] = [...read.refused];
  for (const f of read.found) {
    if (!configured) {
      refused.push({ name: f.name, why: `the secret door is not configured on the Worker (${SECRET_HANDOFF_KEY_NAME} is unset) — the owner sets it once from the vault; nothing was kept` });
      continue;
    }
    const enc = await encryptSecret(env, f.value);
    if (!enc) {
      refused.push({ name: f.name, why: "the value could not be encrypted; nothing was kept" });
      continue;
    }
    const id = `sh_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      `INSERT INTO secret_handoff (id, name, repo, ciphertext, iv, requested_by, inbound_message_id, firm_scope, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(id, f.name, repo, enc.ciphertext, enc.iv, input.partnerAddress.toLowerCase(), input.kept.rowId, input.firmScope, new Date(Date.now() + SECRET_HANDOFF_TTL_MS).toISOString())
      .run();
    stored.push({ name: f.name, repo });
    // NAMES ONLY in the event spine. The payload has no field a value could ride in.
    await appendEvent(env, {
      eventType: "secret_handoff.stored",
      actorType: "firm_user",
      actorId: input.partnerAddress.toLowerCase(),
      objectType: "secret_handoff",
      objectId: id,
      firmScope: input.firmScope,
      payload: { name: f.name, repo, expires_in_days: Math.round(SECRET_HANDOFF_TTL_MS / 86_400_000) },
    });
  }
  for (const r of read.refused) {
    await appendEvent(env, {
      eventType: "secret_handoff.refused",
      actorType: "firm_user",
      actorId: input.partnerAddress.toLowerCase(),
      objectType: "inbound_message",
      objectId: input.kept.rowId ?? "unkept",
      firmScope: input.firmScope,
      payload: { name: r.name, why: r.why },
    });
  }

  // THE KEY SHIPS THE FEATURE THAT WAITED FOR IT (owner, 6 Oct 2026): every open card naming it resumes now.
  const resumed: string[] = [];
  if (stored.length) {
    const { resumeForSecret } = await import("./webPropertyChange");
    const { partnerByEmail } = await import("../../shared/registry/partners");
    const by = partnerByEmail(input.partnerAddress)?.firmUserId ?? null;
    for (const s of stored) resumed.push(...(await resumeForSecret(env, { name: s.name, repo: s.repo, byFirmUserId: by })));
  }
  const onlySecrets = nothingButSecrets(read.scrubbed);
  const line = secretDoorLine(stored, refused);
  // The partner hears once, by Porter, on the thread when there is one.
  try {
    await sendOrPreview(env, {
      to: input.partnerAddress,
      email: {
        employee: input.employee,
        what: stored.length ? `stored ${stored.map((s) => s.name).join(", ")}${repo ? ` for ${repo}` : ""}` : `secret not stored`,
        tldr: line,
        sections: [
          { label: "Stored", bullets: stored.length ? stored.map((s) => `${s.name} for ${s.repo ?? "the vault"} — it is never shown again`) : ["nothing"] },
          { label: "Refused", bullets: refused.length ? refused.map((r) => `${r.name}: ${r.why}`) : ["nothing"] },
          { label: "What happens next", bullets: ["The Mac's claimer moves it into the vault on its next heartbeat and the Worker forgets it.", resumed.length ? `${resumed.length} open job${resumed.length === 1 ? "" : "s"} that waited for it ${resumed.length === 1 ? "is" : "are"} rebuilding now; the next email carries the result.` : "A job for that repo injects it by name; the value never reaches the model."] },
        ],
      },
      objectType: "inbound_message",
      objectId: input.kept.rowId ?? `unkept:${input.partnerAddress}`,
      firmScope: input.firmScope,
      actorId: "secret_handoff",
      cardKind: null,
      cardAsked: null,
      tickedByFirmUserId: null,
      requestedByEmail: input.partnerAddress,
      what: stored.length ? `stored ${stored.map((s) => s.name).join(", ")}` : "secret not stored",
      ...(input.replyOnThread ? { replyOnThread: input.replyOnThread } : {}),
    });
  } catch {
    /* the reply is a courtesy; the store and the scrub are the facts */
  }
  return { raw: scrubbedRaw, stored, refused, onlySecrets, line };
}

/** The one line a RECEIVED or reply email carries. Names only. */
export function secretDoorLine(stored: ReadonlyArray<{ name: string; repo: string | null }>, refused: ReadonlyArray<{ name: string; why: string }>): string {
  const parts: string[] = [];
  if (stored.length) parts.push(`Stored ${stored.map((s) => `${s.name} for ${s.repo ?? "the vault"}`).join(", ")}; it is never shown again.`);
  if (refused.length) parts.push(`Not stored: ${refused.map((r) => `${r.name} (${r.why})`).join("; ")}.`);
  return parts.join(" ") || "No secret was read.";
}

// ── The Mac's side ────────────────────────────────────────────────────────────────────────────

function isClaimer(ctx: RouteContext): boolean {
  return ctx.identity?.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL;
}

/** Expired rows are deleted before anything is read; a value nobody collected does not sit forever. */
async function expire(env: Env): Promise<void> {
  await env.WP_OS_DB.prepare("DELETE FROM secret_handoff WHERE expires_at < ?1").bind(new Date().toISOString()).run();
}

/**
 * POST /api/secret-handoffs/pending — the claimer only. Decrypts and returns every pending value
 * ONCE PER CALL; the row stays until `/stored` names it, so a claimer that dies mid-write gets it
 * again. Never logged, never in an event: the response body is the only place the plaintext exists.
 */
export async function handlePendingSecretHandoffs(ctx: RouteContext): Promise<Response> {
  if (!isClaimer(ctx)) return json({ error: "forbidden", detail: "Only the Mac's claimer collects secret hand-offs." }, { status: 403 });
  await expire(ctx.env);
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT id, name, repo, ciphertext, iv, requested_by, created_at FROM secret_handoff ORDER BY created_at ASC LIMIT 20").all<{ id: string; name: string; repo: string | null; ciphertext: string; iv: string; requested_by: string; created_at: string }>();
  const out: Array<{ id: string; name: string; repo: string | null; value: string }> = [];
  const unreadable: string[] = [];
  for (const r of rows.results ?? []) {
    const value = await decryptSecret(ctx.env, r);
    if (value === null) unreadable.push(r.id);
    else out.push({ id: r.id, name: r.name, repo: r.repo, value });
  }
  return json({ handoffs: out, unreadable });
}

/** POST /api/secret-handoffs/stored { id } — the claimer says the vault has it; the Worker forgets it. */
export async function handleSecretHandoffStored(ctx: RouteContext): Promise<Response> {
  if (!isClaimer(ctx)) return json({ error: "forbidden", detail: "Only the Mac's claimer collects secret hand-offs." }, { status: 403 });
  const body = (await ctx.request.json().catch(() => ({}))) as { id?: string };
  const id = String(body.id ?? "").trim();
  if (!id) return json({ error: "invalid_input", detail: "id is required" }, { status: 400 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT id, name, repo, firm_scope FROM secret_handoff WHERE id = ?1").bind(id).first<{ id: string; name: string; repo: string | null; firm_scope: string }>();
  if (!row) return json({ ok: true, detail: "already gone" });
  await ctx.env.WP_OS_DB.prepare("DELETE FROM secret_handoff WHERE id = ?1").bind(id).run();
  await appendEvent(ctx.env, {
    eventType: "secret_handoff.vaulted",
    actorType: "system",
    actorId: SUBSCRIPTION_CLAIMER_EMAIL,
    objectType: "secret_handoff",
    objectId: id,
    firmScope: row.firm_scope,
    payload: { name: row.name, repo: row.repo },
  });
  return json({ ok: true, name: row.name });
}
