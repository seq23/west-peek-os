import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { DNS_RECHECK_MINUTES, DNS_WAIT_DAYS, DRIVE_RECHECK_MINUTES, porterWait } from "../src/shared/work/porterWaits";
import { dnsLiveStatus, recordDnsWaits, sweepDnsWaits } from "../src/worker/services/dnsWaits";
import { sweepDriveWatches } from "../src/worker/services/driveWatches";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { runDueJobs } from "../src/worker/services/jobs";
import { MAC_DAY, macDayOpen, macDayOpenedAt, macDayWords } from "../src/shared/work/localJobs";

/*
 * THE WAITS KEEP THEIR WORD (22 Nov 2026). Since #572 the Mac takes work only 10:00-21:59 Central. The DNS re-check
 * and the Drive watch used to ride the Mac's claimer, so "I check every 15 minutes for 7 days" stopped at 22:00. They
 * now run on the Worker's minute cron. These tests hold the promise to the code: the minutes the partner reads are the
 * minutes the sweep waits, a wait set in the evening is answered at 03:00, and nothing false is ever emailed.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const PARTNER = "scooter@westpeek.ventures";
const MS_MIN = 60_000;

/** Public DNS and the host as the world sees them: `records` maps host → what DNS answers; `serving` hosts answer https. */
function world(records: Record<string, string[]>, serving: string[] = []) {
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: (records[u.searchParams.get("name") ?? ""] ?? []).map((data) => ({ data: `${data}.` })) });
    if (serving.includes(u.hostname)) return new Response("<html>", { status: 200 });
    return new Response("", { status: 522 });
  }) as typeof fetch;
}

async function waitFor(host: string, target: string) {
  await recordDnsWaits(env, {
    cardId: null,
    repo: host.split(".")[0]!,
    requestedBy: PARTNER,
    firmScope: "west-peek",
    records: [{ host, project: host.split(".")[0]!, record_type: "CNAME", record_name: host.split(".")[0]!, record_target: target, status: "pending", on_zone: false }],
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM web_property_dns WHERE host = ?1").bind(host).first<{ id: string; active_at: string | null }>())!;
}
const checkedAgo = (id: string, now: Date, minutes: number) =>
  env.WP_OS_DB.prepare("UPDATE web_property_dns SET last_checked_at = ?2 WHERE id = ?1").bind(id, new Date(now.getTime() - minutes * MS_MIN).toISOString()).run();
const liveMail = (host: string) => sent.filter((m) => m.to === PARTNER && m.text.includes(`${host} is live`));

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    return world({ "night.topbarz.xyz": ["night.pages.dev"] }, ["night.topbarz.xyz"])(url);
  });
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("the interval the partner is promised is the interval the code keeps", () => {
  it("DNS: the email's minutes and days are the sweep's, and a row is re-checked exactly when they say", async () => {
    const said = porterWait("DNS_RECORD", { record: { host: "a.example.com", type: "CNAME", name: "a", target: "a.pages.dev", liveAt: "https://a.pages.dev" } }).clear;
    expect(Number(/every (\d+) minutes/.exec(said)![1])).toBe(DNS_RECHECK_MINUTES);
    expect(Number(/for (\d+) days/.exec(said)![1])).toBe(DNS_WAIT_DAYS);
    expect(said).toMatch(/day and night/);

    const row = await waitFor("interval.topbarz.xyz", "interval.pages.dev");
    const now = new Date();
    const nobody = world({});
    await checkedAgo(row.id, now, DNS_RECHECK_MINUTES - 1);
    expect((await sweepDnsWaits(env, now, nobody)).map((r) => r.host), "inside the interval: left alone").not.toContain("interval.topbarz.xyz");
    await checkedAgo(row.id, now, DNS_RECHECK_MINUTES + 1);
    expect((await sweepDnsWaits(env, now, nobody)).map((r) => r.host), "past it: re-checked").toContain("interval.topbarz.xyz");
  });

  it("Drive: the email's minutes are the sweep's", async () => {
    const said = porterWait("DRIVE_EMPTY").clear + porterWait("DRIVE_EMPTY").why;
    expect(Number(/within (\d+) minutes/.exec(said)![1])).toBe(DRIVE_RECHECK_MINUTES);
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
    await openAssignmentCard(env, { subject: "Bios", partnerAddress: PARTNER, chiefOfStaff: "Wren", raw: "Walker, write the bios from https://drive.google.com/drive/folders/1InTeRvAlFoLdEr000001", limits: EMAILED_TASK_LIMITS, emlKey: null });
    expect(await env.WP_OS_DB.prepare("SELECT 1 FROM drive_watch WHERE folder_id = '1InTeRvAlFoLdEr000001'").first(), "the door recorded the watch").not.toBeNull();
    const now = new Date();
    const stamp = (minutes: number) => env.WP_OS_DB.prepare("UPDATE drive_watch SET last_checked_at = ?1 WHERE folder_id = '1InTeRvAlFoLdEr000001'").bind(new Date(now.getTime() - minutes * MS_MIN).toISOString()).run();
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    await stamp(DRIVE_RECHECK_MINUTES - 1);
    expect((await sweepDriveWatches(env, now, down)).map((r) => r.folder)).not.toContain("1InTeRvAlFoLdEr000001");
    await stamp(DRIVE_RECHECK_MINUTES + 1);
    expect((await sweepDriveWatches(env, now, down)).map((r) => r.folder)).toContain("1InTeRvAlFoLdEr000001");
  });
});

describe("a queued wait survives the night", () => {
  it("a record added at 21:45 Central is found by the Worker's own cron at 03:00 and the partner is emailed then", async () => {
    const row = await waitFor("night.topbarz.xyz", "night.pages.dev");
    const threeAm = new Date("2030-01-15T09:00:00.000Z"); // 03:00 CST
    expect(macDayOpen(threeAm), "the Mac is closed for the night").toBe(false);
    await env.WP_OS_DB.prepare("UPDATE web_property_dns SET last_checked_at = ?2, created_at = ?3 WHERE id = ?1").bind(row.id, "2030-01-15T03:45:00.000Z", "2030-01-15T03:45:00.000Z").run();
    // The real minute-cron entry point, with nothing scheduled due and with a scheduled job due alike.
    const results = await runDueJobs(env, threeAm, { limit: 0 });
    expect(results.find((r) => r.job_key === "_dns_waits")?.summary).toMatch(/night\.topbarz\.xyz: active \(live\)/);
    expect(liveMail("night.topbarz.xyz"), "one email, at night, from the Worker").toHaveLength(1);
    expect((await env.WP_OS_DB.prepare("SELECT active_at FROM web_property_dns WHERE id = ?1").bind(row.id).first<{ active_at: string | null }>())!.active_at).not.toBeNull();
  });

  it("the Mac's day the copy names is the day the claimer keeps", () => {
    expect(macDayWords()).toBe("between 10am and 10pm Central");
    expect(MAC_DAY).toMatchObject({ opensHour: 10, closesHour: 22, zone: "America/Chicago" });
    expect(macDayOpen(new Date("2030-01-15T15:59:00.000Z")), "09:59 CST").toBe(false);
    expect(macDayOpen(new Date("2030-01-15T16:00:00.000Z")), "10:00 CST").toBe(true);
    expect(macDayOpen(new Date("2030-01-16T03:59:00.000Z")), "21:59 CST").toBe(true);
    expect(macDayOpen(new Date("2030-01-16T04:00:00.000Z")), "22:00 CST").toBe(false);
    expect(macDayOpenedAt(new Date("2030-07-15T16:30:00.000Z"))!.toISOString(), "11:30 CDT opened at 10:00 CDT").toBe("2030-07-15T15:00:00.000Z");
    expect(macDayOpenedAt(new Date("2030-07-15T12:00:00.000Z")), "07:00 CDT").toBeNull();
    expect(porterWait("MAC_ASLEEP").clear).toContain(macDayWords());
  });
});

describe("how it breaks", () => {
  it("abuse: a host pointed somewhere else that answers https is never called live", async () => {
    const row = await waitFor("hijack.topbarz.xyz", "hijack.pages.dev");
    const elsewhere = world({ "hijack.topbarz.xyz": ["evil.example.net"] }, ["hijack.topbarz.xyz"]);
    expect(await dnsLiveStatus({ host: "hijack.topbarz.xyz", record_type: "CNAME", record_target: "hijack.pages.dev" }, elsewhere)).toBe("pending");
    await checkedAgo(row.id, new Date(), 60);
    const out = await sweepDnsWaits(env, new Date(), elsewhere);
    expect(out.find((r) => r.host === "hijack.topbarz.xyz")?.did).toBe("checked");
    expect(liveMail("hijack.topbarz.xyz")).toHaveLength(0);
  });

  it("outage: DNS unreachable is 'unknown' and emails nobody; the record seen but https failing is not live", async () => {
    const row = await waitFor("outage.topbarz.xyz", "outage.pages.dev");
    const dohDown = (async () => new Response("", { status: 502 })) as typeof fetch;
    expect(await dnsLiveStatus({ host: "outage.topbarz.xyz", record_type: "CNAME", record_target: "outage.pages.dev" }, dohDown)).toBe("unknown");
    expect(await dnsLiveStatus({ host: "outage.topbarz.xyz", record_type: "CNAME", record_target: "outage.pages.dev" }, world({ "outage.topbarz.xyz": ["outage.pages.dev"] }))).toBe("record_seen");
    const before = sent.length;
    await checkedAgo(row.id, new Date(), 60);
    await sweepDnsWaits(env, new Date(), dohDown);
    expect(sent.length - before).toBe(0);
    const after = await env.WP_OS_DB.prepare("SELECT status, active_at, last_checked_at FROM web_property_dns WHERE id = ?1").bind(row.id).first<{ status: string; active_at: string | null; last_checked_at: string }>();
    expect(after!.active_at).toBeNull();
    expect(Date.parse(after!.last_checked_at), "stamped, so it is retried next interval rather than every minute").toBeGreaterThan(Date.now() - MS_MIN);
  });

  it("data: two sweeps racing on a live host email the partner once", async () => {
    const row = await waitFor("race.topbarz.xyz", "race.pages.dev");
    await checkedAgo(row.id, new Date(), 60);
    const live = world({ "race.topbarz.xyz": ["race.pages.dev"] }, ["race.topbarz.xyz"]);
    await Promise.all([sweepDnsWaits(env, new Date(), live), sweepDnsWaits(env, new Date(), live)]);
    await checkedAgo(row.id, new Date(), 60);
    await sweepDnsWaits(env, new Date(), live);
    expect(liveMail("race.topbarz.xyz")).toHaveLength(1);
  });

  it("the wait ends: after its days the partner is reminded once, and never again", async () => {
    const row = await waitFor("late.topbarz.xyz", "late.pages.dev");
    const later = new Date(Date.now() + (DNS_WAIT_DAYS + 1) * 86_400_000);
    await checkedAgo(row.id, later, 60);
    const before = sent.length;
    const first = await sweepDnsWaits(env, later, world({}));
    expect(first.find((r) => r.host === "late.topbarz.xyz")?.did).toBe("reminded");
    await checkedAgo(row.id, later, 60);
    await sweepDnsWaits(env, later, world({}));
    expect(sent.slice(before).filter((m) => m.to === PARTNER && m.text.includes("late.topbarz.xyz"))).toHaveLength(1);
  });
});
