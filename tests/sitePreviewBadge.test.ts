import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";
import { createWorkCardInternal, handleWorkByOwner } from "../src/worker/services/workCards";
import { openWebPropertyChange } from "../src/worker/services/webPropertyChange";
import { parseWebPropertyAsk } from "../src/shared/intake/webPropertyChange";
import { WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { sitePreviewBadge } from "../src/client/pages/work/sitePreviewBadge";

/**
 * ONE TRUTH FOR THE SITE'S PREVIEW GATE ON THE DESK (owner, 23 Sep 2026).
 *
 * The defect: card wc_c9e36e8b… (community site) had `web_property_change.preview_only = 1` — the
 * real gate — while the desk's only preview control read `work_card.preview_first`, which was NULL,
 * so she saw "off" on work that was in fact stopping at a preview. Two components, two flags.
 *
 * Pinned here, end to end: `openWebPropertyChange` opens every site change preview-first with no
 * phrase in the request; the board payload serves THAT column as `site_preview_only`; the desk's
 * badge reads it and nothing else, only on WEB_PROPERTY_CHANGE; and "Show me first"
 * (`preview_first`, hold the result for her) is left alone — a different hold on every kind.
 */

let t: TestDb;
let env: Env;

const SEQUOIA: FirmUserIdentity = {
  id: "fu_sequoia_taylor",
  email: "sequoia@westpeek.ventures",
  fullName: "Sequoia Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

async function board(): Promise<Array<Record<string, unknown>>> {
  const res = await handleWorkByOwner({ env, identity: SEQUOIA as never, params: {}, request: new Request("https://os.joinwestpeek.com/x") } as never);
  return ((await res.json()) as { cards: Array<Record<string, unknown>> }).cards;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("sitePreviewBadge reads the site gate, and only the site gate", () => {
  it("a web property change with preview_only = 1 shows ON, whatever preview_first says", () => {
    for (const preview_first of [null, 0, 1]) {
      const b = sitePreviewBadge({ kind: WEB_PROPERTY_CHANGE_KIND, site_preview_only: 1, preview_first } as never);
      expect(b).toEqual({ on: true, text: "Preview before it goes live: always on", title: expect.stringMatching(/approved to production/) });
    }
  });

  it("a web property change with preview_only = 0 shows OFF, even when preview_first is 1 — never borrowed from the other flag", () => {
    expect(sitePreviewBadge({ kind: WEB_PROPERTY_CHANGE_KIND, site_preview_only: 0, preview_first: 1 } as never)).toMatchObject({ on: false, text: "Preview before it goes live: off" });
    expect(sitePreviewBadge({ kind: WEB_PROPERTY_CHANGE_KIND, site_preview_only: null } as never)?.on).toBe(false);
  });

  it("every other kind gets no badge, even with a stray site_preview_only", () => {
    for (const kind of [null, "BLOG_HELP", "ARTIFACT", "DECK_REWORK"]) expect(sitePreviewBadge({ kind, site_preview_only: 1 })).toBeNull();
  });
});

describe("the board serves the site gate beside preview_first", () => {
  it("a site change opened with no \"preview first\" in the request is ON on the desk, and its Show-me-first stays NULL", async () => {
    const c = await createWorkCardInternal(env, SEQUOIA, { title: "community site footer", machine_id: undefined });
    const ask = parseWebPropertyAsk("community site footer", "community site: https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvfoot.")!;
    expect(ask.preview_first ?? null, "the request did not ask for a preview").toBeNull();
    await openWebPropertyChange(env, { cardId: c.id, ask, firmScope: "west-peek" });
    const row = await env.WP_OS_DB.prepare("SELECT preview_only FROM web_property_change WHERE work_card_id = ?1").bind(c.id).first<{ preview_only: number }>();
    expect(row?.preview_only).toBe(1);

    const found = (await board()).find((x) => x.id === c.id)!;
    expect(found.kind).toBe(WEB_PROPERTY_CHANGE_KIND);
    expect(found.site_preview_only).toBe(1);
    expect(found.preview_first ?? null, "Show me first is a different hold and is not set by the site gate").toBeNull();
    expect(sitePreviewBadge(found as never)).toMatchObject({ on: true, text: "Preview before it goes live: always on" });
  });

  it("an ordinary card carries site_preview_only NULL and no badge", async () => {
    const c = await createWorkCardInternal(env, SEQUOIA, { title: "an ordinary card", machine_id: undefined });
    const found = (await board()).find((x) => x.id === c.id)!;
    expect(found.site_preview_only ?? null).toBeNull();
    expect(sitePreviewBadge(found as never)).toBeNull();
  });

  it("re-opening the same card never lowers the gate", async () => {
    const c = await createWorkCardInternal(env, SEQUOIA, { title: "community site banner", machine_id: undefined });
    const ask = parseWebPropertyAsk("community site banner", "community site: https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvbann.")!;
    await openWebPropertyChange(env, { cardId: c.id, ask, firmScope: "west-peek" });
    await openWebPropertyChange(env, { cardId: c.id, ask: { ...ask, preview_first: null }, firmScope: "west-peek" });
    expect((await board()).find((x) => x.id === c.id)!.site_preview_only).toBe(1);
  });
});
