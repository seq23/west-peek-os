import { describe, expect, it } from "vitest";
import { keysReallyMissing } from "../scripts/duties/lib/runbook.mjs";
import { visiblePlaceholders } from "../scripts/duties/lib/runbook.mjs";
import {
  DATA_OP_PREFIXES,
  admittedScripts,
  dataOpsIn,
  generateRunbook,
  isDataOp,
  isProductionRun,
  porterMayRun,
  porterMayRunFrom,
  productionAsked,
  withPorterMayRun,
} from "../scripts/duties/lib/runbook.mjs";
import { runRefusal } from "../scripts/duties/web-property-change.mjs";

/**
 * AN ABSENT `## Porter may run` IS DERIVED, NEVER A REFUSAL (owner, 6 Oct 2026: "shouldnt these agents
 * be able to create scripts and do what is needed and be flexible?"). The topbarz-voting case: a
 * hand-written RUNBOOK with "Load tracks"/"Load photos" sections and no Porter section, and scripts
 * sync-drive, load-tracks, load-photos, export, booth-log, promote-booth — Porter would have stopped at
 * the load step.
 */
const TOPBARZ_PKG = {
  scripts: {
    "sync-drive": "node scripts/sync-drive.mjs",
    "load-tracks": "node scripts/load-tracks.mjs",
    "load-photos": "node scripts/load-photos.mjs",
    export: "node scripts/export.mjs",
    "booth-log": "node scripts/booth-log.mjs",
    "promote-booth": "node scripts/promote-booth.mjs",
    "deploy:production": "wrangler pages deploy public",
    dev: "wrangler pages dev public",
    test: "vitest run",
  },
};
const HAND_WRITTEN = "# RUNBOOK — topbarz-voting\n\n## Load tracks\n\nRun the loader.\n\n## Load photos\n\nSame.\n\n## Secrets\n\n- `GIPHY_API_KEY`\n";

describe("the derivation", () => {
  it("admits every data-op in the topbarz package.json when the RUNBOOK has no section — never []", () => {
    expect(porterMayRun(HAND_WRITTEN)).toEqual([]);
    const a = admittedScripts(HAND_WRITTEN, TOPBARZ_PKG);
    expect(a.derived).toBe(true);
    expect(a.names).toEqual(["booth-log", "export", "load-photos", "load-tracks", "promote-booth", "sync-drive", "test"]);
    expect(a.section).toMatch(/^## Porter may run\n/);
    for (const n of a.names) expect(a.section).toContain(`- \`${n}\``);
    expect(a.section).not.toContain("deploy:production");
  });

  it("writes the section back before ## Secrets, keeps every hand-written section, and the next read is the repo's own list", () => {
    const a = admittedScripts(HAND_WRITTEN, TOPBARZ_PKG);
    const written = withPorterMayRun(HAND_WRITTEN, a.section!);
    expect(written).toMatch(/## Load tracks[\s\S]*## Load photos[\s\S]*## Porter may run[\s\S]*## Secrets[\s\S]*GIPHY_API_KEY/);
    const again = admittedScripts(written, { scripts: {} });
    expect(again.derived).toBe(false);
    expect(again.names).toEqual(a.names);
    expect(withPorterMayRun("# R\n\nNo sections.", "## Porter may run\n\n- `load-x`")).toMatch(/No sections\.\n\n## Porter may run\n\n- `load-x`\n$/);
  });

  it("a human's list wins over the derivation", () => {
    const a = admittedScripts("# R\n\n## Porter may run\n\n- `load-tracks`\n", TOPBARZ_PKG);
    expect(a).toEqual({ names: ["load-tracks"], derived: false, section: null });
  });

  it("the generator and the fallback share one rule and one section text", () => {
    const g = generateRunbook({ repo: "topbarz-voting", githubRepo: "seq23/topbarz-voting", pkg: TOPBARZ_PKG, wrangler: null, sourceNames: [], today: "2026-10-06" });
    expect(g.text).toContain(porterMayRunFrom(TOPBARZ_PKG).text);
    expect(g.mayRun).toEqual(admittedScripts(HAND_WRITTEN, TOPBARZ_PKG).names);
    expect(g.text).not.toMatch(/Nothing else is run for the model/);
  });
});

describe("the widened prefixes", () => {
  it.each(["sync-drive", "pull-sheet", "import-csv", "seed-preview", "publish-results", "backfill-votes", "booth-log", "moderate-queue", "load-x", "export", "promote-booth", "migrate:local", "smoke"])("admits %s", (name) => {
    expect(isDataOp(name)).toBe(true);
  });

  it.each(["deploy", "deploy:production", "pages:deploy", "dev", "start", "serve", "preview", "watch", "release", "publish", "publish:production", "postinstall", "loader"])("never admits %s", (name) => {
    expect(isDataOp(name)).toBe(false);
  });

  it("names every prefix the owner asked for", () => {
    for (const p of ["sync", "pull", "import", "seed", "publish", "backfill", "booth", "moderate", "load", "export", "promote", "migrate", "smoke"]) expect(DATA_OP_PREFIXES).toContain(p);
    expect(dataOpsIn({ scripts: { "sync-y": "a", "load-x": "b", deploy: "c" } })).toEqual(["load-x", "sync-y"]);
  });
});

describe("the production-words gate", () => {
  it("is production by env or by args", () => {
    expect(isProductionRun({ env: "production" })).toBe(true);
    expect(isProductionRun({ env: "preview", args: ["--env", "production"] })).toBe(true);
    expect(isProductionRun({ env: "preview", args: ["--env=prod"] })).toBe(true);
    expect(isProductionRun({ env: "preview", args: ["--env", "preview"] })).toBe(false);
  });

  it("opens production only on the partner's words or their yes on the thread", () => {
    expect(productionAsked({ request: "add the new photos to the gallery" }).ok).toBe(false);
    expect(productionAsked({ request: "load the photos to production tonight" }).ok).toBe(true);
    expect(productionAsked({ request: "x", rebuild: { changes: "looks good, go live" } }).ok).toBe(true);
    expect(productionAsked({ request: "x", plan: { answers: ["put it on the live site"] } }).ok).toBe(true);
    expect(productionAsked({ request: "x", pr: { land_approved_at: "2026-10-06T12:00:00Z" } }).ok).toBe(true);
    expect(productionAsked({ request: "x", pre_approved: "your call" }).ok).toBe(true);
  });

  it("refuses a production run without the words, frees preview, and holds a script written this job to preview until landed", () => {
    const gate = { admittedNow: ["load-tracks", "load-photos"], base: ["load-tracks"], phase: "BUILD" };
    const quiet = { request: "add the new photos" };
    const asked = { request: "load the photos to production" };
    expect(runRefusal({ script: "load-tracks", env: "preview" }, { ...gate, job: quiet })).toBeNull();
    expect(runRefusal({ script: "load-tracks", env: "production" }, { ...gate, job: quiet })).toMatch(/refused on production: production runs only when the partner/);
    expect(runRefusal({ script: "load-tracks", env: "preview", args: ["--env", "production"] }, { ...gate, job: quiet })).toMatch(/refused on production/);
    expect(runRefusal({ script: "load-tracks", env: "production" }, { ...gate, job: asked })).toBeNull();
    expect(runRefusal({ script: "load-photos", env: "preview" }, { ...gate, job: quiet })).toBeNull();
    expect(runRefusal({ script: "load-photos", env: "production" }, { ...gate, job: asked })).toMatch(/written in this job/);
    expect(runRefusal({ script: "load-photos", env: "production" }, { ...gate, job: asked, phase: "LAND" })).toBeNull();
    expect(runRefusal({ script: "load-logos", env: "preview" }, { ...gate, job: asked })).toMatch(/write the script in this PR/);
  });
});

describe("a key is missing only when the site really lacks it (15 Nov 2026, wc_c548d043)", () => {
  const twelve = ["EMAIL_FROM", "FORMS_ALARM_TO", "FORMS_MAILER", "FORMS_MAILER_SECRET", "FORMS_PROBE_CF_TO", "FORMS_PROBE_SECRET", "PRODUCTIONS_DB", "PRODUCTIONS_TOKEN_KEY", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY", "CRON_SECRET", "DASHBOARD_PRIVATE_NAMES_FILE"];
  // The site's runtime code (functions/), in the shapes the Productions site reads them.
  const runtimeTexts = [
    "const from = clean(env.EMAIL_FROM);\nconst to = env.FORMS_ALARM_TO;\nconst s = env.FORMS_MAILER_SECRET;\nconst probe = env.FORMS_PROBE_SECRET;\nconst cf = env.FORMS_PROBE_CF_TO;",
    "const db = env.PRODUCTIONS_DB;\nconst key = env.PRODUCTIONS_TOKEN_KEY;",
    "return Boolean(clean(env.TURNSTILE_SECRET_KEY) && clean(env.TURNSTILE_SITE_KEY));\nconst body = new URLSearchParams({ secret: clean(env.TURNSTILE_SECRET_KEY) });",
  ];
  // What the Pages project has (names only), production and preview together.
  const configured = ["EMAIL_FROM", "PRODUCTIONS_TOKEN_KEY", "PRODUCTIONS_DB", "FORMS_ALARM_TO", "FORMS_MAILER_SECRET", "FORMS_PROBE_CF_TO", "FORMS_PROBE_SECRET"];

  it("this card's twelve names: none missing (set on the project, skip-guarded, script-only, or never read)", () => {
    expect(keysReallyMissing(twelve, { runtimeTexts, configured })).toEqual({ missing: [], unchecked: null });
  });
  it("a key the runtime reads unguarded and the project lacks is still missing", () => {
    expect(keysReallyMissing([...twelve, "STRIPE_SECRET_KEY"], { runtimeTexts: [...runtimeTexts, "const stripe = new Stripe(env.STRIPE_SECRET_KEY);"], configured }).missing).toEqual(["STRIPE_SECRET_KEY"]);
  });
  it("a target that cannot be read calls nothing missing and says it was not checked", () => {
    const out = keysReallyMissing(["STRIPE_SECRET_KEY"], { runtimeTexts: ["new Stripe(env.STRIPE_SECRET_KEY)"], configured: null, why: "no CLOUDFLARE_API_TOKEN" });
    expect(out.missing).toEqual([]);
    expect(out.unchecked).toMatch(/^not checked \(no CLOUDFLARE_API_TOKEN\): STRIPE_SECRET_KEY$/);
  });
});

describe("placeholders are counted from what a visitor sees, never a class name (15 Nov 2026, wc_c548d043)", () => {
  it("renaming --todo to --pending hides nothing; a class name alone counts nothing", () => {
    const page = `<div class="tile tile--pending"><img alt=""><p>Photo to come</p><p>Name to confirm</p></div>
<div class="tile tile--pending"><p>Photo to come</p><p>Name to confirm</p></div>
<span className="badge--pending">Placeholder · TNTP's numbers to come</span>`;
    expect(visiblePlaceholders([page]).length).toBeGreaterThanOrEqual(5);
    expect(visiblePlaceholders(['<div class="tile--todo photo-to-come"></div><p>Our team</p>'])).toEqual([]);
  });
  it("a sentence that goes on past 'need to come' is copy, never a stand-in (19 Nov 2026, wc_76e6d7ff)", () => {
    const prize = "<p>Travel is not included, so winners outside New York need to come to New York.</p><p>We need you to confirm your email.</p>";
    expect(visiblePlaceholders([prize])).toEqual([]);
    expect(visiblePlaceholders(["<p>Partner logo to come</p><p>Date to confirm.</p><p>Prize to come soon</p>"])).toEqual(["Partner logo to come", "Date to confirm", "Prize to come"]);
  });
});
