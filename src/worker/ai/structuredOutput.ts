/**
 * THE SHAPE OF AN ANSWER, KEPT AT THE ONE AI BOUNDARY (22 Nov 2026, engineering sweep row 6).
 *
 * A caller that needs fields from a model (an intent, a yes/no, his asks) hands `runAi` a schema instead of asking for
 * "exactly this format" in prose and reading `INTENT:` lines back with regexes. The boundary then:
 *   1. tells every lane the JSON schema (the seats and free lanes read it in the prompt);
 *   2. hands it to the lanes whose API constrains decoding to a schema (Anthropic `output_config`, Gemini
 *      `responseJsonSchema`), so those cannot answer in any other shape;
 *   3. checks every answer against the schema before it counts. An answer that is not that JSON is
 *      `verifier_rejected:structured_output:…` and the chain walks to its next rung, exactly as a caller's own
 *      verifier rejection does; the run's `output_text` is the canonical JSON of the checked value.
 * The caller reads fields with `readStructured`, never prose.
 */
import { z } from "zod/v4";

export interface StructuredOutput<T = unknown> {
  /** A short name for the shape (letters, digits, underscores), sent to the lanes that take one. */
  name: string;
  schema: z.ZodType<T>;
}

export function structuredOutput<T>(name: string, schema: z.ZodType<T>): StructuredOutput<T> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error(`structured output name "${name}" must be letters, digits or underscores`);
  return { name, schema };
}

/*
 * Bounds a lane's constrained decoder refuses (Anthropic's structured outputs take no numeric or length limits, and
 * zod writes the safe-integer range on every `.int()`). They are dropped from what the lanes are sent only: the
 * boundary still checks every answer against the full zod schema.
 */
const LANE_UNSUPPORTED = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern", "format"]);
function forLanes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forLanes);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (!LANE_UNSUPPORTED.has(k)) out[k] = k === "properties" || k === "$defs" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, forLanes(s)])) : forLanes(v);
  return out;
}

/** The JSON Schema for the lanes (no `$schema` key: Anthropic and Gemini both refuse unknown top-level keywords). */
export function jsonSchemaOf(output: StructuredOutput): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(output.schema) as Record<string, unknown>;
  return forLanes(schema) as Record<string, unknown>;
}

/** Appended to the last input, so a lane with no schema parameter (a seat, a free model) is told the shape too. */
export function structuredInstruction(output: StructuredOutput): string {
  return [
    "",
    "ANSWER FORMAT: reply with ONE JSON object and nothing else (no prose before or after it, no code fence). It must match this JSON Schema:",
    JSON.stringify(jsonSchemaOf(output)),
  ].join("\n");
}

/** The JSON object inside a reply: a reasoning model's <think> block and a code fence around it are not the answer. */
function jsonTextOf(text: string): string | null {
  const bare = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(bare);
  const body = (fenced ? fenced[1]! : bare).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : null;
}

/** The verifier tag a reply in the wrong shape is rejected with (`verifier_rejected:structured_output:…`). */
export const SHAPE_REJECTED = "structured_output";

/** A run that failed only because every lane answered in the wrong shape: a model answered, nothing in it was readable. */
export function failedOnShape(failureReason: string | null | undefined): boolean {
  return (failureReason ?? "").includes(`verifier_rejected:${SHAPE_REJECTED}:`);
}

export type StructuredRead<T> = { ok: true; value: T; json: string } | { ok: false; why: string };

/** Checks one reply against the shape. Never throws. */
export function readStructuredText<T>(output: StructuredOutput<T>, text: string | null | undefined): StructuredRead<T> {
  const raw = jsonTextOf(text ?? "");
  if (!raw) return { ok: false, why: `the reply is not a JSON object (${(text ?? "").trim().slice(0, 80) || "empty"})` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, why: `the reply is not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : "parse error"})` };
  }
  const checked = output.schema.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues[0];
    return { ok: false, why: `the reply does not match the ${output.name} shape (${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid"})` };
  }
  return { ok: true, value: checked.data, json: JSON.stringify(checked.data) };
}

/** The checked value of a completed run's `output_text`, or null when there is none (no run, or a stand-in reply). */
export function readStructured<T>(output: StructuredOutput<T>, text: string | null | undefined): T | null {
  const r = readStructuredText(output, text);
  return r.ok ? r.value : null;
}
