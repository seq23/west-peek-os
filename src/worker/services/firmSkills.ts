import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { actorFromIdentity, authorize } from "./authorize";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { MACHINE_REGISTRY } from "../../shared/registry/machines";
import { skillsForMachines } from "../../shared/skills/library";

/**
 * The firm writing down its own methods.
 *
 * `src/shared/skills/library.ts` holds the methods that were reviewed in a pull request. This module
 * holds the ones the firm writes afterwards: a partner says in plain English how they want something
 * done, an employee drafts it into the same shape the library uses, and the partner adopts the
 * drafted version. Only adopted methods reach a prompt.
 *
 * THE TWO SOURCES ARE NEVER MERGED SILENTLY. Every response marks which is which. A method that went
 * through review and a method typed into a box on Tuesday are both legitimate, and a reader must not
 * have to guess which they are looking at.
 *
 * WHY THE DRAFT STEP IS NOT CEREMONY. A method is read by every employee on that machine on every
 * run. Letting a sentence become a live instruction that nobody read in its final form is how you
 * end up with a firm following an instruction it never wrote. The partner reads the drafted method
 * and adopts it, and the exact words they originally typed are kept for ever — when a method turns
 * out to say something they did not mean, `source_text` is the only way to tell whether the
 * translation was wrong or the instruction was.
 *
 * ADOPTION IS GATED BY ROLE, NOT BY A RECEIPT. The budget-policy path was deliberately reformed away
 * from cards that a Managing Partner raises and then approves themselves; this is the same shape of
 * act and takes the same treatment.
 */

export interface FirmSkillRow {
  id: string;
  machine_key: string;
  title: string;
  when_to_use: string;
  guidance_json: string;
  source_text: string;
  drafted_by_run_id: string | null;
  status: "DRAFT" | "ADOPTED" | "RETIRED";
  adopted_by: string | null;
  adopted_at: string | null;
  created_by: string;
  created_at: string;
}

const draftSchema = z.object({
  machine_key: z.string().trim().min(1),
  /** What the partner actually wants, in their own words. */
  plain_english: z.string().trim().min(12),
});

function machineExists(key: string): boolean {
  return MACHINE_REGISTRY.some((m) => m.key === key);
}

function parseGuidance(row: FirmSkillRow): string[] {
  try {
    const parsed = JSON.parse(row.guidance_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The prompt that turns a partner's sentence into a method.
 *
 * It is deliberately unglamorous. The model is not being asked to have opinions about how a venture
 * firm should work — the partner already said that. It is being asked to render what they said in
 * the shape the library uses, and to refuse to add anything they did not say. An invented line here
 * becomes an instruction every employee on that machine follows.
 */
export function buildTranslationPrompt(machineName: string, plainEnglish: string): string {
  return [
    `A Managing Partner of West Peek Ventures has written down how they want work done on the`,
    `"${machineName}" machine. Render it as a method their AI employees will read before working.`,
    "",
    "WHAT THEY WROTE:",
    plainEnglish,
    "",
    "RULES:",
    "- Say only what they said. Do not add advice, caveats or best practice they did not write.",
    "- If what they wrote is vague, keep it vague. Do not resolve their ambiguity for them —",
    "  a partner reading the draft can see their own vagueness and fix it. You inventing a",
    "  specific rule they never chose is worse than a loose one they did.",
    "- Write the guidance as short imperative lines, the way an instruction is followed.",
    "- `when` says the situation this applies in, so an employee can tell whether to use it.",
    "",
    "Answer with JSON only, no prose and no code fence:",
    '{"title": "...", "when": "...", "guidance": ["...", "..."]}',
  ].join("\n");
}

/** Everything the firm knows about how to work a machine, both sources, marked. */
export async function handleListFirmSkills(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const rows =
    (
      await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM firm_skill WHERE firm_scope = ?1 AND status != 'RETIRED' ORDER BY machine_key, created_at DESC",
      )
        .bind(firmScope)
        .all<FirmSkillRow>()
    ).results ?? [];

  const machines = MACHINE_REGISTRY.map((m) => {
    const written = rows.filter((r) => r.machine_key === m.key);
    return {
      machine_key: m.key,
      machine_name: m.name,
      // From the repository, reviewed in a pull request. Read-only here.
      reviewed: skillsForMachines([m.key]).map((s) => ({
        key: s.key,
        title: s.title,
        when: s.when,
        guidance: s.guidance,
        origin: "REVIEWED" as const,
      })),
      // Written by the firm, in this database.
      written: written.map((r) => ({
        id: r.id,
        title: r.title,
        when: r.when_to_use,
        guidance: parseGuidance(r),
        origin: "WRITTEN" as const,
        status: r.status,
        source_text: r.source_text,
        created_by: r.created_by,
        created_at: r.created_at,
      })),
    };
  }).filter((m) => m.reviewed.length > 0 || m.written.length > 0);

  return json({
    machines,
    notes: {
      origins:
        "REVIEWED methods live in the repository and changed through a pull request. WRITTEN methods " +
        "were written here by a partner. Both are followed; only the second can be changed from this page.",
      draft:
        "A written method is DRAFT until a Managing Partner adopts it. Only adopted methods are read " +
        "by employees.",
      source: "src/shared/skills/library.ts",
    },
  });
}

/** Turn plain English into a drafted method. Nothing is in use until it is adopted. */
export async function handleDraftFirmSkill(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const parsed = draftSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "Say which machine, and write at least a sentence." }, { status: 400 });

  const authz = await authorize(ctx.env, actor, "firm_skill.draft", { objectType: "firm_skill", objectId: parsed.data.machine_key });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const machine = MACHINE_REGISTRY.find((m) => m.key === parsed.data.machine_key);
  if (!machine) return json({ error: "unknown_machine", detail: `No machine has the key ${parsed.data.machine_key}.` }, { status: 400 });

  const { run } = await runAi(ctx.env, {
    purpose: `drafting a method for ${machine.key}`,
    actor,
    inputs: [buildTranslationPrompt(machine.name, parsed.data.plain_english)],
    sensitivity: "INTERNAL" as never,
    budgetContext: { expectedOutputTokens: 600 },
    // Pinned: this becomes an instruction every employee on the machine follows, which is not work
    // for the cheapest adequate model.
    routing: { category: "OPERATIONS", taskClass: "employee-work" },
  });

  if (run.status !== "COMPLETED" || !run.output_text) {
    return json(
      { error: "draft_failed", detail: run.failure_reason ?? `The run ended ${run.status} and wrote nothing.` },
      { status: 502 },
    );
  }

  const fenced = run.output_text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let drafted: { title?: unknown; when?: unknown; guidance?: unknown };
  try {
    drafted = JSON.parse((fenced?.[1] ?? run.output_text).trim()) as typeof drafted;
  } catch {
    return json({ error: "draft_unreadable", detail: "The drafted method did not come back as readable JSON. Try rewording it." }, { status: 502 });
  }

  const title = typeof drafted.title === "string" ? drafted.title.trim() : "";
  const when = typeof drafted.when === "string" ? drafted.when.trim() : "";
  const guidance = Array.isArray(drafted.guidance) ? drafted.guidance.filter((g): g is string => typeof g === "string") : [];
  if (!title || !when || guidance.length === 0) {
    return json({ error: "draft_incomplete", detail: "The draft came back missing a title, a when, or any guidance." }, { status: 502 });
  }

  const id = `fsk_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO firm_skill (id, machine_key, title, when_to_use, guidance_json, source_text, drafted_by_run_id, status, created_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'DRAFT', ?8, ?9)`,
  )
    .bind(id, machine.key, title, when, JSON.stringify(guidance), parsed.data.plain_english, run.id, actor.firmUserId ?? "system", actor.firmScopes[0] ?? "west-peek")
    .run();

  await appendEvent(ctx.env, {
    eventType: "firm_skill.drafted",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "firm_skill",
    objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { machine_key: machine.key, title, ai_run_id: run.id },
  });

  return json(
    {
      skill: { id, machine_key: machine.key, title, when, guidance, status: "DRAFT" },
      note: "Nothing follows this yet. Read it, and adopt it if it says what you meant.",
    },
    { status: 201 },
  );
}

/** Put a drafted method into use. Managing Partners only. */
export async function handleAdoptFirmSkill(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "firm_skill.adopt", { objectType: "firm_skill", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  if (!actor.roles.includes("MANAGING_PARTNER")) {
    return json(
      { error: "forbidden", detail: "Adopting a method changes how every employee on that machine works. A Managing Partner decides that." },
      { status: 403 },
    );
  }

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM firm_skill WHERE id = ?1").bind(ctx.params.id!).first<FirmSkillRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  if (row.status === "ADOPTED") return json({ error: "already_adopted", detail: "This method is already in use." }, { status: 409 });

  await ctx.env.WP_OS_DB.prepare(
    "UPDATE firm_skill SET status = 'ADOPTED', adopted_by = ?2, adopted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(row.id, actor.firmUserId ?? "system")
    .run();

  await appendEvent(ctx.env, {
    eventType: "firm_skill.adopted",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "firm_skill",
    objectId: row.id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { machine_key: row.machine_key, title: row.title },
  });

  return json({ id: row.id, status: "ADOPTED", note: `Every employee on ${row.machine_key} reads this before working now.` });
}

/** Stop a method being read. */
export async function handleRetireFirmSkill(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "firm_skill.retire", { objectType: "firm_skill", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  if (!actor.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "forbidden", detail: "A Managing Partner decides which methods the firm follows." }, { status: 403 });
  }

  const res = await ctx.env.WP_OS_DB.prepare("UPDATE firm_skill SET status = 'RETIRED' WHERE id = ?1 AND status != 'RETIRED'")
    .bind(ctx.params.id!)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return json({ error: "not_found" }, { status: 404 });

  await appendEvent(ctx.env, {
    eventType: "firm_skill.retired",
    actorType: "firm_user",
    actorId: actor.firmUserId ?? "system",
    objectType: "firm_skill",
    objectId: ctx.params.id!,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: {},
  });

  return json({ id: ctx.params.id, status: "RETIRED" });
}

/**
 * The adopted, firm-written methods for a set of machines, as prompt lines.
 *
 * THIS IS THE POINT OF THE WHOLE FEATURE. A method that is displayed and never reaches a prompt is
 * decoration. `guidanceBlock` in the shared library cannot do this — it is pure and has no database
 * — so the worker composes the two and the caller passes the result where it used to pass one.
 */
export async function writtenGuidance(env: Env, machineKeys: readonly string[], firmScope = "west-peek"): Promise<string> {
  if (machineKeys.length === 0) return "";
  const placeholders = machineKeys.map((_, i) => `?${i + 2}`).join(", ");
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT * FROM firm_skill WHERE firm_scope = ?1 AND status = 'ADOPTED' AND machine_key IN (${placeholders}) ORDER BY created_at`,
      )
        .bind(firmScope, ...machineKeys)
        .all<FirmSkillRow>()
    ).results ?? [];
  if (rows.length === 0) return "";

  return [
    "METHODS THE PARTNERS WROTE FOR THIS WORK.",
    "These were written by a Managing Partner and adopted deliberately. Where one of them conflicts",
    "with the general methods above, this is the firm's more recent decision and it wins.",
    "",
    ...rows.flatMap((r) => [`${r.title} — ${r.when_to_use}`, ...parseGuidance(r).map((g) => `  ${g}`), ""]),
  ].join("\n");
}
