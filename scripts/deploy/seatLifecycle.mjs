/**
 * THE SEAT-FILES EXPIRY RULE, APPLIED BY THE DEPLOY (22 Nov 2026, Open Loops olp_m81kzkvq02y98ger).
 *
 * Files handed to a subscription seat live under `seat-attachments/<run id>/` and are deleted when the run ends. The
 * bucket's lifecycle rule is the backstop for a delete that never happened. The rule is defined ONCE, in
 * seat-attachments-lifecycle.json beside this file; the Worker reads its days from the same file
 * (SEAT_ATTACHMENT_EXPIRE_DAYS), and docs/OPERATIONS.md is checked against it by test.
 *
 * ONLY THAT RULE IS TOUCHED. The bucket holds every document the firm keeps; its other rules (if any) are read and put
 * back exactly as they were, and the rule's prefix is checked to be the seat folder before anything is sent.
 *
 * A REFUSED OR UNREADABLE CALL IS "UNVERIFIED", never "ok": the step says so in the deploy summary and the next deploy
 * tries again. It does not fail the deploy: the Worker's own delete and minute sweep still clear the files.
 */
import { readFileSync } from "node:fs";

export const SEAT_LIFECYCLE = JSON.parse(readFileSync(new URL("./seat-attachments-lifecycle.json", import.meta.url), "utf8"));
const SEAT_PREFIX = "seat-attachments/";

/** The bucket's rules with ours put in by id; every other rule exactly as it was. Throws if ours is not seat-scoped. */
export function withSeatRule(existing, rule = SEAT_LIFECYCLE.rule) {
  if (rule?.conditions?.prefix !== SEAT_PREFIX) throw new Error(`refusing a lifecycle rule not scoped to ${SEAT_PREFIX}: ${JSON.stringify(rule?.conditions)}`);
  const others = (existing ?? []).filter((r) => r?.id !== rule.id);
  return [...others, rule];
}

const same = (a, b) => JSON.stringify(a?.conditions) === JSON.stringify(b?.conditions) && a?.enabled === b?.enabled && a?.deleteObjectsTransition?.condition?.maxAge === b?.deleteObjectsTransition?.condition?.maxAge;

/**
 * Read the rules, put ours in, write, read again and compare. Returns { state: "ok" | "unverified", line }.
 * `fetchImpl` is injected so the test drives refusals without the network.
 */
export async function applySeatLifecycle({ account, token, fetchImpl = fetch, rule = SEAT_LIFECYCLE.rule, bucket = SEAT_LIFECYCLE.bucket }) {
  if (!token) return { state: "unverified", line: "no CLOUDFLARE_API_TOKEN in this shell: the seat-files expiry rule was not checked" };
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/lifecycle`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const read = async () => {
    const res = await fetchImpl(url, { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success || !Array.isArray(body?.result?.rules)) throw new Error(`read refused (HTTP ${res.status}${body?.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""})`);
    return body.result.rules;
  };
  try {
    const before = await read();
    const ours = before.find((r) => r?.id === rule.id);
    if (!(ours && same(ours, rule))) {
      const res = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify({ rules: withSeatRule(before, rule) }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(`write refused (HTTP ${res.status}${body?.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""})`);
    }
    const after = await read();
    if (!same(after.find((r) => r?.id === rule.id), rule)) throw new Error("the rule read back does not match what was written");
    const lost = before.filter((r) => r?.id !== rule.id && !after.some((a) => a?.id === r?.id));
    if (lost.length) throw new Error(`other rules went missing: ${lost.map((r) => r.id).join(", ")}`);
    const days = rule.deleteObjectsTransition.condition.maxAge / 86400;
    return { state: "ok", line: `${rule.id}: ${rule.conditions.prefix} expires after ${days} day${days === 1 ? "" : "s"}${ours && same(ours, rule) ? " (already in place)" : " (written)"}` };
  } catch (err) {
    return { state: "unverified", line: `UNVERIFIED: the seat-files expiry rule could not be confirmed (${err instanceof Error ? err.message : String(err)}); the next deploy retries` };
  }
}
