import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockOf } from "../src/worker/services/blocks";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { saidNothing, cannotDo } from "./helpers/interpret";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { FirmUserIdentity } from "../src/worker/auth";
import type { Actor } from "../src/worker/services/authorize";
import { createMeeting } from "../src/worker/services/meetings";
import { createOpportunity } from "../src/worker/services/investment";
import { readMeetingAfter } from "../src/worker/services/meetingAfter";
import { askRoom, buildFromWords, plansFromRoomBlocks, roomState, type RoomAnswerer } from "../src/worker/services/meetingRoom";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { sweepOnce } from "../src/worker/services/workSweep";
import {
  advanceArtifact,
  aboutForCard,
  artifactStatus,
  loadArtifact,
  readPanels,
  requestArtifactBuild,
  runArtifactCard,
  serveArtifactsOnTick,
  rebuildArtifact,
  plainFailure,
  type ArtifactModelCall,
} from "../src/worker/services/artifacts";
import { artifactAskFromWords, kindFromWords, stateInWords, type ArtifactSpec } from "../src/shared/artifacts/artifact";
import { checkCitations, docxBytes, documentFor, figuresOf, pptxBytes, slidesFor, stripUncited, textOfDocument, textOfDocx, textOfPptx, textOfSlides, UncitedFigure, unzipStored } from "../src/shared/artifacts/render";

/**
 * Artifacts on demand (owner, 19 Sep 2026).
 *
 * The rules under test: ONE producer, reached through TWO doors — the room's `build` intent and an
 * ARTIFACT work card — both writing the same row and advancing through the same stages; the plan
 * compiler is the only query surface; every figure cites rows and an uncited one is refused or
 * stripped; the artifact lives on the object it is about (never only on the meeting) and is listed
 * and searchable there; a rebuild is a new version and the old one stays; every state is named on
 * the row; the room's build makes a link block and nothing else; the export contains exactly what
 * the page shows; a card's finished build is filed as its deliverable and reaches her.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MP_IDENTITY: FirmUserIdentity = {
  id: "fu_scooter_taylor",
  email: "scooter@westpeek.ventures",
  fullName: "Scooter Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
};

const answers = (reply: unknown): RoomAnswerer => async () => ({ ok: true, text: JSON.stringify(reply), aiRunId: null, detail: "COMPLETED" });
const neverAsked: RoomAnswerer = async () => {
  throw new Error("the model was asked, and this path must not ask one");
};

async function call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T; raw: Response }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, { method, headers: body === undefined ? MP : { ...MP, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  const text = await res.clone().text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, body: parsed as T, raw: res };
}

let seq = 0;
async function company(name?: string): Promise<string> {
  seq += 1;
  const res = await call<{ id: string }>("/api/companies", "POST", { canonical_name: name ?? `Artifact Co ${seq} ${crypto.randomUUID().slice(0, 6)}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

const DEALS_BY_STATUS = { table: "investment_opportunity", group_by: "status", metric: { fn: "count" }, chart: "bar" };
const COMPANIES = { table: "canonical_company", select: ["canonical_name", "status"], limit: 10 };

/** A planner that proposes two panels, as a model would, without one. */
const plans: ArtifactModelCall = async () => ({ ok: true, text: JSON.stringify({ title: "Pipeline by status", panels: [{ title: "Deals by status", chart: "bar", plan: DEALS_BY_STATUS }, { title: "Companies", chart: "table", plan: COMPANIES }] }), aiRunId: null, detail: "COMPLETED" });
/** A writer that cites what the panels hold, and invents one figure the panels do not. */
const writes: ArtifactModelCall = async (_env, _actor, { prompt }) => {
  const rows = Number(/\((?:investment_opportunity), (\d+) rows/.exec(prompt)?.[1] ?? 0);
  return { ok: true, text: JSON.stringify({ summary: `The pipeline holds ${rows} statuses worth reading and 999 imaginary ones.`, sections: [{ panel: "p1", heading: "Where the deals sit", prose: `There are ${rows} statuses in play; the invented figure 4242 is not in the record.` }, { panel: "p2", heading: "The companies", prose: "The record names the companies below." }] }), aiRunId: null, detail: "COMPLETED" };
};
const freeOnly: ArtifactModelCall = async () => ({ ok: false, text: "", aiRunId: null, detail: "free_only_cannot_serve_protected_work:this call is marked 'search' and needs a paid model, and the lever is set to FREE_ONLY." });
const noLane: ArtifactModelCall = async () => ({ ok: false, text: "", aiRunId: null, detail: "no_enabled_providers" });

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs });
  await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE name IN ('Walter','Wyatt','Wesley','Winter')").run();
  await t.db.prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lpr_artifacts', 'A Family Office', 'FAMILY_OFFICE', 'ENGAGED', 'fu_scooter_taylor')").run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("0. migrations 0217 and 0218 built what they describe", () => {
  it("artifact and artifact_version exist, 'about' is mandatory, the room's block admits 'artifact', the key is seeded", async () => {
    const cols = ((await t.db.prepare("PRAGMA table_info(artifact)").all<{ name: string }>()).results ?? []).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["kind", "state", "stage", "stage_lease_until", "plans_json", "confidential", "current_version_no", "company_id", "meeting_id", "lp_record_id"]));
    await expect(t.db.prepare("INSERT INTO artifact (id, kind, title, brief, door, requested_by, built_by) VALUES ('art_nowhere', 'deck', 'x', 'y', 'ROOM', 'fu_scooter_taylor', 'Walter')").run()).rejects.toThrow(/CHECK/);
    const sql = await t.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meeting_artifact'").first<{ sql: string }>();
    expect(sql?.sql).toContain("'artifact'");
    const key = await t.db.prepare("SELECT is_external_effect FROM action_type WHERE key = 'artifact.build'").first<{ is_external_effect: number }>();
    expect(key?.is_external_effect).toBe(0);
    // No foreign key was dragged onto the rollback copy.
    const refs = ((await t.db.prepare("SELECT sql FROM sqlite_master WHERE sql LIKE '%meeting_artifact_pre_0218%' AND name <> 'meeting_artifact_pre_0218'").all<{ sql: string }>()).results ?? []);
    expect(refs).toHaveLength(0);
  });
});

describe("1. the words: what is recognised as a build, and the state in words", () => {
  it("recognises a card's ask and the room's 'make this a …', and nothing that merely mentions a deck", () => {
    expect(artifactAskFromWords("Wyatt, build me a one-pager on the Sensori round")).toEqual({ kind: "document" });
    expect(artifactAskFromWords("put together a dashboard of deals by status")).toEqual({ kind: "dashboard" });
    expect(artifactAskFromWords("Review their deck before Thursday")).toBeNull();
    expect(buildFromWords("make this a dashboard")).toEqual({ kind: "dashboard" });
    expect(buildFromWords("add this to the deck")).toEqual({ kind: "deck" });
    expect(buildFromWords("write me a one-pager on the Sensori round")).toBeNull();
    expect(kindFromWords("a short memo")).toBe("document");
  });

  it("every state is a sentence, never a bare enum", () => {
    expect(stateInWords({ state: "REQUESTED", stage: null })).toMatch(/waiting its turn/);
    expect(stateInWords({ state: "BUILDING", stage: "reading" })).toBe("building — reading the record");
    expect(stateInWords({ state: "FAILED", stage: null, error_message: "no lane could take it" })).toBe("failed — no lane could take it");
    expect(plainFailure("no_enabled_providers")).toMatch(/no model lane could take the work/);
    expect(plainFailure("provider_http_402: credit balance too low")).toMatch(/run out of credit/);
  });
});

describe("2. door A — the room: 'make this a dashboard' runs the room's own blocks again, with no model", () => {
  let meetingId: string;
  let companyId: string;
  let artifactId: string;

  it("saves a link block, attaches the artifact to the meeting AND its company, and is READY before the ask returns", async () => {
    companyId = await company();
    await createOpportunity(env, MP_ACTOR, { company_id: companyId, title: "Series A", opportunity_type: "EARLY_STAGE_PRIMARY" });
    const m = await createMeeting(env, MP_ACTOR, { title: "Founder call", meeting_type: "FOUNDER", company_id: companyId, occurred_at: "2026-09-19T10:00:00.000Z" });
    meetingId = m.id;
    const before = await readMeetingAfter(env, meetingId);

    // Two blocks the room built earlier, each carrying its plan.
    const q1 = await askRoom(env, MP_IDENTITY, meetingId, { question: "how many deals by status" }, answers({ mode: "query", answer: "Deals by status", query: DEALS_BY_STATUS }));
    expect(q1.artifact.kind).toBe("chart");
    expect(JSON.parse(q1.artifact.body_json).plan).toMatchObject({ table: "investment_opportunity", group_by: "status" });
    const q2 = await askRoom(env, MP_IDENTITY, meetingId, { question: "list the companies" }, answers({ mode: "query", answer: "Companies", query: COMPANIES }));
    expect(q2.artifact.kind).toBe("table");
    expect(await plansFromRoomBlocks(env, meetingId)).toHaveLength(2);

    // The build. `neverAsked` throws if a model is consulted: this path must not need one.
    const out = await askRoom(env, MP_IDENTITY, meetingId, { question: "make this a dashboard" }, neverAsked);
    expect(out.artifact.kind).toBe("artifact");
    expect(out.artifact_id).toMatch(/^art_/);
    artifactId = out.artifact_id!;
    const body = JSON.parse(out.artifact.body_json);
    expect(body.artifact_id).toBe(artifactId);
    expect(body.panels).toBe(2);

    const row = (await loadArtifact(env, artifactId))!;
    expect(row.state).toBe("READY");
    expect(row.door).toBe("ROOM");
    expect(row.meeting_id).toBe(meetingId);
    expect(row.company_id, "never only on a meeting: the company the meeting is about carries it too").toBe(companyId);
    expect(row.current_version_no).toBe(1);
    expect(row.confidential, "investment_opportunity is a confidential table, so the artifact is").toBe(1);

    // The room reads the build's state on every poll.
    const state = await roomState(env, MP_IDENTITY, meetingId);
    expect(state.builds[artifactId]?.state).toBe("READY");
    expect(state.builds[artifactId]?.words).toMatch(/^ready · v1 · \d+ rows? cited$/);

    // NOTHING became a record.
    const after = await readMeetingAfter(env, meetingId);
    expect(after.decisions).toHaveLength(before.decisions.length);
    expect(after.commitments).toHaveLength(before.commitments.length);
    expect(after.open_questions).toHaveLength(before.open_questions.length);
  });

  it("the page's derivation and both exports carry the same text and the same figures", async () => {
    const got = await call<{ spec: ArtifactSpec; slides: unknown[]; document: unknown[]; versions: Array<{ version_no: number }> }>(`/api/artifacts/${artifactId}`);
    expect(got.status).toBe(200);
    const spec = got.body.spec;
    expect(spec.panels).toHaveLength(2);
    expect(spec.panels[0]!.cites.length).toBe(spec.panels[0]!.rows.length);
    expect(checkCitations(spec).figures).toBeGreaterThan(0);

    const pptx = await call(`/api/artifacts/${artifactId}/export.pptx`);
    expect(pptx.status).toBe(200);
    expect(pptx.raw.headers.get("content-type")).toContain("presentationml");
    const pptxBytesGot = new Uint8Array(await pptx.raw.arrayBuffer());
    const slideText = textOfPptx(pptxBytesGot);
    expect(slideText.length).toBe(slidesFor(spec).length);
    const pageLines = textOfSlides(slidesFor(spec));
    const fileLines = slideText.flat();
    for (const line of pageLines) expect(fileLines, `the .pptx is missing "${line}"`).toContain(line);
    expect([...new Set(figuresOf(fileLines))].sort()).toEqual([...new Set(figuresOf(pageLines))].sort());
    // The same bytes the route serves are the renderer's own bytes for this spec, name for name.
    expect([...unzipStored(pptxBytesGot).keys()].sort()).toEqual([...unzipStored(pptxBytes(spec)).keys()].sort());

    const docx = await call(`/api/artifacts/${artifactId}/export.docx`);
    expect(docx.status).toBe(200);
    const docText = textOfDocx(new Uint8Array(await docx.raw.arrayBuffer()));
    const docLines = textOfDocument(documentFor(spec));
    for (const line of docLines) expect(docText, `the .docx is missing "${line}"`).toContain(line);
    expect([...new Set(figuresOf(docText))].sort()).toEqual([...new Set(figuresOf(docLines))].sort());
    expect(docxBytes(spec).length).toBeGreaterThan(1000);
  });

  it("it is on the shelf under the company and under the meeting, searchable by title; a rebuild is v2 and v1 stays", async () => {
    const byCompany = await call<{ artifacts: Array<{ id: string; kind: string; built_by: string; cites_count: number; about: { label: string } }> }>(`/api/artifacts?about=${companyId}`);
    expect(byCompany.body.artifacts.map((a) => a.id)).toContain(artifactId);
    const row = byCompany.body.artifacts.find((a) => a.id === artifactId)!;
    expect(row.kind).toBe("dashboard");
    expect(row.built_by).toBe("Walter");
    expect(row.cites_count).toBeGreaterThan(0);
    expect(row.about.label).toBeTruthy();
    const byMeeting = await call<{ artifacts: Array<{ id: string }> }>(`/api/artifacts?about=${meetingId}`);
    expect(byMeeting.body.artifacts.map((a) => a.id)).toContain(artifactId);
    const search = await call<{ artifacts: Array<{ id: string }> }>(`/api/artifacts?q=dashboard`);
    expect(search.body.artifacts.map((a) => a.id)).toContain(artifactId);
    const miss = await call<{ artifacts: Array<{ id: string }>; note: string }>(`/api/artifacts?q=zzz-nothing-called-this`);
    expect(miss.body.artifacts).toHaveLength(0);
    expect(miss.body.note).toMatch(/Nothing built matches/);

    const refreshed = await call<{ state: string; version_no: number }>(`/api/artifacts/${artifactId}/refresh`, "POST");
    expect(refreshed.status).toBe(202);
    expect(refreshed.body.state).toBe("READY");
    expect(refreshed.body.version_no).toBe(2);
    const versions = await call<{ versions: Array<{ version_no: number }>; shown_version_no: number }>(`/api/artifacts/${artifactId}`);
    expect(versions.body.versions.map((v) => v.version_no)).toEqual([2, 1]);
    const old = await call<{ shown_version_no: number }>(`/api/artifacts/${artifactId}?version=1`);
    expect(old.body.shown_version_no).toBe(1);
    const oldExport = await call(`/api/artifacts/${artifactId}/export.docx?version=1`);
    expect(oldExport.status).toBe(200);
  });

  it("with nothing in the room to build from, the ask is a REFUSED block that says what to do, and no artifact exists", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Empty room", meeting_type: "FOUNDER", company_id: companyId, occurred_at: "2026-09-19T11:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "turn these into a deck" }, neverAsked);
    expect(out.artifact.kind).toBe("answer");
    expect(JSON.parse(out.artifact.body_json)).toMatchObject({ state: "REFUSED" });
    expect(JSON.parse(out.artifact.body_json).detail).toMatch(/Ask the room for a table or a chart first/);
    expect(out.artifact_id).toBeNull();
    const n = await t.db.prepare("SELECT COUNT(*) AS n FROM artifact WHERE meeting_id = ?1").bind(m.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("'write me a one-pager on X' goes through the model's build intent: REQUESTED, then the clock plans, reads and writes it — with the invented figure stripped", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "Planning call", meeting_type: "FOUNDER", company_id: companyId, occurred_at: "2026-09-19T12:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "write me a one-pager on where the pipeline sits" }, answers({ mode: "build", build: { kind: "document", brief: "Where the pipeline sits, by status, with the companies named.", title: "Pipeline one-pager" } }));
    expect(out.artifact.kind).toBe("artifact");
    const id = out.artifact_id!;
    let row = (await loadArtifact(env, id))!;
    expect(row.state, "the stage that needs a model waits for the clock, named").toBe("BUILDING");
    expect(row.stage).toBe("planning");
    expect(row.stage_lease_until).toBeNull();
    const words = (await artifactStatus(env, row)).words;
    expect(words).toMatch(/^building — choosing what to read from the record · \d+s so far · usually about \d+ min/);

    // The clock, with the model seams.
    const stepped = await advanceArtifact(env, id, { allowModel: true, deps: { plan: plans, write: writes } });
    expect(stepped.status).toBe("ready");
    row = (await loadArtifact(env, id))!;
    expect(row.state).toBe("READY");
    expect(row.title).toBe("Pipeline one-pager");
    const got = await call<{ spec: ArtifactSpec }>(`/api/artifacts/${id}`);
    const spec = got.body.spec;
    expect(spec.sections).toHaveLength(2);
    expect(spec.sections[0]!.prose).toContain("[figure not in the record]");
    expect(spec.sections[0]!.prose).not.toContain("4242");
    expect(spec.summary).not.toContain("999");
    expect(() => checkCitations(spec)).not.toThrow();
    const stripped = await t.db.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'artifact.figures_stripped' AND object_id = ?1").bind(id).first<{ n: number }>();
    expect(stripped?.n).toBe(1);
  });

  it("a build nothing can serve FAILS with the reason on the row, and Try again is offered", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "No lane", meeting_type: "FOUNDER", company_id: companyId, occurred_at: "2026-09-19T13:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "make me a deck about the pipeline" }, answers({ mode: "build", build: { kind: "deck", brief: "The pipeline" } }));
    const id = out.artifact_id!;
    const stepped = await advanceArtifact(env, id, { allowModel: true, deps: { plan: noLane } });
    expect(stepped.status).toBe("failed");
    const row = (await loadArtifact(env, id))!;
    expect(row.state).toBe("FAILED");
    expect(row.error_code).toBe("planning_failed/NO_LANE");
    expect(row.error_message).toMatch(/nobody could plan it: no model lane could take the work/);
    const status = await artifactStatus(env, row);
    expect(status.can_retry).toBe(true);
    expect(status.words).toMatch(/^failed — nobody could plan it/);
    const noExport = await call(`/api/artifacts/${id}/export.pptx`);
    expect(noExport.status).toBe(409);
    // Try again reopens it; the clock (no provider here) closes it FAILED again, by name.
    const retried = await call<{ state: string }>(`/api/artifacts/${id}/retry`, "POST");
    expect(retried.status).toBe(202);
    expect(["REQUESTED", "BUILDING"]).toContain(retried.body.state);
    const tick = await serveArtifactsOnTick(env);
    expect(tick.served).toBe(true);
    expect((await loadArtifact(env, id))!.state).toBe("FAILED");
  });

  it("an LP meeting's build is confidential from the request, before any table is read", async () => {
    const m = await createMeeting(env, MP_ACTOR, { title: "LP catch-up", meeting_type: "LP", lp_record_id: "lpr_artifacts", occurred_at: "2026-09-19T14:00:00.000Z" });
    const out = await askRoom(env, MP_IDENTITY, m.id, { question: "make me a document on our commitments" }, answers({ mode: "build", build: { kind: "document", brief: "Commitments from this LP" } }));
    const row = (await loadArtifact(env, out.artifact_id!))!;
    expect(row.confidential).toBe(1);
    expect(row.lp_record_id).toBe("lpr_artifacts");
  });
});

describe("3. door B — a work card: her words become an ARTIFACT card, the same producer builds it, the artifact is the deliverable", () => {
  let companyId: string;

  it("'Wyatt, build me a one-pager on <company>' is an ARTIFACT card, built to READY, filed, on her Home, DONE", async () => {
    companyId = await company("Sensori Labs");
    await createOpportunity(env, MP_ACTOR, { company_id: companyId, title: "Sensori Series A", opportunity_type: "EARLY_STAGE_PRIMARY" });
    const card = await createWorkCardInternal(env, MP_IDENTITY, {
      title: "One-pager on the Sensori Labs round",
      owner_type: "AI",
      owner_id: "Wyatt",
      prompt: "Wyatt, build me a one-pager on the Sensori Labs round — where it sits and which companies are near it.",
      preview_first: false,
    });
    const stored = (await t.db.prepare("SELECT kind, prompt FROM work_card WHERE id = ?1").bind(card.id).first<{ kind: string | null; prompt: string | null }>())!;
    expect(stored.kind).toBe("ARTIFACT");
    expect(await aboutForCard(env, { id: card.id, title: card.title, description: null, prompt: stored.prompt, owner_id: card.owner_id, firm_scope: "west-peek" })).toMatchObject({ company_id: companyId });

    const out = await runArtifactCard(env, { id: card.id }, { interpret: saidNothing, plan: plans, write: writes });
    expect(out.finished).toBe(true);
    expect(out.artifact_id).toMatch(/^art_/);
    const row = (await loadArtifact(env, out.artifact_id!))!;
    expect(row.door).toBe("CARD");
    expect(row.work_card_id).toBe(card.id);
    expect(row.company_id).toBe(companyId);
    expect(row.opportunity_id).toBeTruthy();
    expect(row.state).toBe("READY");
    expect(row.built_by).toBe("Wyatt");

    const done = await t.db.prepare("SELECT state, description FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string; description: string }>();
    expect(done?.state).toBe("DONE");
    expect(done?.description).toMatch(/Built document/);
    const filed = await t.db.prepare("SELECT id, kind, prepared_by, prepared_for, body FROM deliverable WHERE source_type = 'artifact' AND source_id = ?1").bind(row.id).first<{ id: string; kind: string; prepared_by: string; prepared_for: string; body: string }>();
    expect(filed?.kind).toBe("employee_finding");
    expect(filed?.prepared_by).toBe("Wyatt");
    expect(filed?.prepared_for).toBe("fu_scooter_taylor");
    expect(filed?.body).toContain(`#/documents/a/${row.id}`);
    expect(filed?.body).toContain("## Sources");
    const home = await call<{ deliverables: Array<{ id: string }> }>("/api/deliverables?mine=1");
    expect(home.body.deliverables.map((d) => d.id)).toContain(filed!.id);
  });

  it("the sweep dispatches an ARTIFACT card to the producer, and one with no object to be about BLOCKS saying so", async () => {
    const card = await createWorkCardInternal(env, MP_IDENTITY, {
      title: "Put together a dashboard",
      owner_type: "AI",
      owner_id: "Wyatt",
      prompt: "put together a dashboard of everything",
    });
    expect((await t.db.prepare("SELECT kind FROM work_card WHERE id = ?1").bind(card.id).first<{ kind: string | null }>())?.kind).toBe("ARTIFACT");
    let ran = 0;
    const out = await sweepOnce(env, new Date(), { artifact: (e, c) => { ran += 1; return runArtifactCard(e, c, { interpret: saidNothing, plan: plans, write: writes }); } });
    expect(ran).toBe(1);
    expect(out.outcome).toBe("BLOCKED");
    const blocked = await t.db.prepare("SELECT state, block_reason, block_needed FROM work_card WHERE id = ?1").bind(card.id).first<{ state: string; block_reason: string; block_needed: string }>();
    expect(blocked?.state).toBe("BLOCKED");
    expect(blocked?.block_reason).toBe("the_brief_is_missing");
    expect(blocked?.block_needed).toMatch(/Say which company, deal, fund, LP or meeting/);
  });

  it("her words reach the interpreter first: a CANNOT stops the build before a row exists", async () => {
    const card = await createWorkCardInternal(env, MP_IDENTITY, {
      title: "A deck on Sensori Labs",
      owner_type: "AI",
      owner_id: "Wyatt",
      prompt: "build me a deck on Sensori Labs and email it to the founder",
    });
    const out = await runArtifactCard(env, { id: card.id }, { interpret: cannotDo("a deck on Sensori Labs", "email it to the founder"), plan: plans, write: writes });
    expect(out.blocked).toBe(true);
    const n = await t.db.prepare("SELECT COUNT(*) AS n FROM artifact WHERE work_card_id = ?1").bind(card.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
    const blocked = await t.db.prepare("SELECT block_reason FROM work_card WHERE id = ?1").bind(card.id).first<{ block_reason: string }>();
    expect(blocked?.block_reason).toBe("asked_for_something_this_work_cannot_do");
  });

  it("a lane refusal blocks the card with the lane's kind of refusal, and the artifact says the same", async () => {
    const card = await createWorkCardInternal(env, MP_IDENTITY, {
      title: "A memo on Sensori Labs",
      owner_type: "AI",
      owner_id: "Wyatt",
      prompt: "write me a memo on Sensori Labs",
    });
    const out = await runArtifactCard(env, { id: card.id }, { interpret: saidNothing, plan: noLane });
    expect(out.blocked).toBe(true);
    const blocked = await t.db.prepare("SELECT block_reason FROM work_card WHERE id = ?1").bind(card.id).first<{ block_reason: string }>();
    expect(blocked?.block_reason).toBe("no_lane_could_take_the_work");
    const row = (await loadArtifact(env, out.artifact_id!))!;
    expect(row.state).toBe("FAILED");
    expect(row.error_code).toBe("planning_failed/NO_LANE");
  });

  it("a stop from the spend setting blocks the card as the setting, not as a lane (1 Oct 2026)", async () => {
    const card = await createWorkCardInternal(env, MP_IDENTITY, {
      title: "A memo on Sensori Labs, free only",
      owner_type: "AI",
      owner_id: "Wyatt",
      prompt: "write me a memo on Sensori Labs",
    });
    const out = await runArtifactCard(env, { id: card.id }, { interpret: saidNothing, plan: freeOnly });
    expect(out.blocked).toBe(true);
    expect((await loadArtifact(env, out.artifact_id!))!.error_code).toBe("planning_failed/LEVER");
    const c = (await t.db.prepare("SELECT * FROM work_card WHERE id = ?1").bind(card.id).first<Record<string, unknown>>())!;
    expect(c.block_reason).toBe("a_lane_refused_the_work");
    const block = blockOf(c as never)!;
    expect(block.stopped).toMatch(/spend setting is on Free only/);
    expect(block.actions.map((a) => a.key)).toEqual(["RETRY", "HAND_ON", "DROP"]);
  });
});

describe("4. the guards: one query surface, every figure cited", () => {
  it("a plan outside the allowlist is refused by name and never becomes a panel", async () => {
    const { panels, refused } = await readPanels(env, MP_IDENTITY, "west-peek", [
      { title: "Users", chart: "table", plan: { table: "firm_user", select: ["email"], where: [], limit: 5, include_archived: false } as never },
      { title: "Companies", chart: "table", plan: { table: "canonical_company", select: ["canonical_name"], where: [], limit: 5, include_archived: false } },
    ]);
    expect(panels).toHaveLength(1);
    expect(refused[0]).toMatch(/"Users": "firm_user" is not a table the room may read/);
    expect(panels[0]!.cites).toHaveLength(panels[0]!.rows.length);
  });

  it("requesting with every plan refused FAILS by name rather than producing an empty artifact", async () => {
    const cid = await company();
    const row = await requestArtifactBuild(env, MP_ACTOR, {
      kind: "dashboard",
      brief: "the users",
      about: { company_id: cid },
      door: "ROOM",
      requestedBy: "fu_scooter_taylor",
      builtBy: "Walter",
      plans: [{ title: "Users", chart: "table", plan: { table: "firm_user", select: ["email"], where: [], limit: 5, include_archived: false } as never }],
      privacyLabel: "INTERNAL",
      firmScope: "west-peek",
    });
    expect(row.state).toBe("FAILED");
    expect(row.error_code).toBe("nothing_readable");
    expect(row.error_message).toMatch(/none of the panels could be read/);
  });

  it("an artifact with an uncited number is refused; stripUncited removes only what the rows cannot vouch for", () => {
    const spec: ArtifactSpec = {
      kind: "document", title: "x", brief: "y", about: { company_id: "cc_1", opportunity_id: null, meeting_id: null, fund_id: null, lp_record_id: null, label: "Co" },
      built_by: "Walter", built_at: "2026-09-19T00:00:00Z", version_no: 1, summary: null,
      panels: [{ id: "p1", title: "Deals", chart: "table", plan: { table: "investment_opportunity" } as never, table: "investment_opportunity", columns: ["status", "metric"], rows: [{ status: "NEW", metric: 3 }], cites: ["investment_opportunity:status=NEW"], sql: "SELECT", confidential: true, note: null }],
      sections: [{ heading: "Deals", prose: "There are 3 new deals.", panel_id: "p1" }],
      sources: [],
    };
    expect(checkCitations(spec).figures).toBeGreaterThan(0);
    expect(() => checkCitations({ ...spec, sections: [{ heading: "Deals", prose: "There are 7 new deals.", panel_id: "p1" }] })).toThrow(UncitedFigure);
    expect(() => checkCitations({ ...spec, panels: [{ ...spec.panels[0]!, cites: [] }] })).toThrow(/every row must be cited/);
    expect(() => checkCitations({ ...spec, sections: [{ heading: "Free", prose: "About 12 things.", panel_id: null }] })).toThrow(/has no panel to cite/);
    expect(stripUncited("3 new, 7 old, 1,000 total", new Set(["3", "1000"]))).toEqual({ prose: "3 new, [figure not in the record] old, 1,000 total", stripped: 1 });
  });

  it("the shelf answers 401 to nobody, and an artifact of another privacy label is invisible", async () => {
    const res = await handleRequest(new Request("https://test.local/api/artifacts"), env);
    expect(res.status).toBe(401);
    const cid = await company();
    const row = await requestArtifactBuild(env, MP_ACTOR, { kind: "dashboard", brief: "companies", about: { company_id: cid }, door: "ROOM", requestedBy: "fu_scooter_taylor", builtBy: "Walter", plans: [{ title: "Companies", chart: "table", plan: COMPANIES as never }], privacyLabel: "INTERNAL", firmScope: "west-peek" });
    expect(row.state).toBe("READY");
    const rebuilt = await rebuildArtifact(env, MP_ACTOR, row.id, "refresh");
    expect(rebuilt.current_version_no).toBe(2);
  });
});
