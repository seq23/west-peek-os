import { z } from "zod";

/**
 * A READ-ONLY QUESTION OF THE FIRM'S RECORD, asked from a live meeting (Phase C, 18 Sep 2026).
 *
 * "Build a report or chart on the spot." The model does NOT write SQL. It produces a PLAN — a
 * table from the allowlist below, columns from that table's list, filters from a closed set of
 * operators, one optional aggregate, one optional grouping — and this file turns the plan into one
 * parameterised SELECT. Every identifier in the SQL comes from a constant in this file; every
 * value is a bound parameter; every query carries the firm scope, the privacy clause the page
 * queries use, and a row cap.
 *
 * WHY A PLAN AND NOT VALIDATED SQL. The alternative — let the model write SQL and reject anything
 * but SELECT on allowlisted tables — needs a parser that understands CTEs, subqueries, ATTACH,
 * `load_extension`, comments, string-escaping and D1's dialect, and is correct about all of them
 * on the first day. A plan has no surface to widen: a table not in ALLOWLIST is refused by name
 * before a byte of SQL exists, and there is no string the model can emit that reaches the database
 * unparsed. It is the safer of the two because its safety is a property of the vocabulary, not of
 * a filter.
 *
 * THE MODEL NEVER SEES THE ROWS. It sees the question and this vocabulary; the rows go from D1 to
 * the saved block in code. An LP's name in a result therefore reaches no model at all, whatever
 * lane answered the question — which is the confidential-content rule with nothing to enforce.
 *
 * NO RELATIVE IMPORTS, ON PURPOSE. `validate:room-answers` loads this file directly under Node's
 * native TypeScript loader, replays the migrations into `node:sqlite`, and runs the fixtures
 * against the real compiler. Erasable syntax only; zod is the one dependency.
 */

export type ColumnKind = "text" | "number" | "date";

export interface AllowedTable {
  /** What a partner would call it. Shown to the model; never used in SQL. */
  label: string;
  columns: Readonly<Record<string, ColumnKind>>;
  /** Whether the table carries privacy_label and so takes the visibility clause. */
  privacy: boolean;
  /** Whether the table carries archived_at and so hides archived rows unless asked. */
  archivable: boolean;
  /** Set on the tables whose rows name limited partners or fund figures. */
  confidential: boolean;
}

/**
 * The allowlist. Names are the real table names from the migrations; columns are a chosen subset
 * — never the free-text notes, never anybody's email, never a JSON blob the model would have to
 * interpret. Adding a table here is a review, not a config change.
 */
export const ALLOWLIST: Readonly<Record<string, AllowedTable>> = {
  investment_opportunity: {
    label: "deals in the pipeline",
    columns: { id: "text", company_id: "text", title: "text", status: "text", opportunity_type: "text", source_channel: "text", price_per_share: "number", quantity: "number", fees: "number", carry: "number", recommendation: "text", created_at: "date" },
    privacy: true, archivable: true, confidential: true,
  },
  canonical_company: {
    label: "companies the firm knows",
    columns: { id: "text", canonical_name: "text", sector: "text", status: "text", website: "text", one_liner: "text", created_at: "date" },
    privacy: true, archivable: false, confidential: false,
  },
  portfolio_update: {
    label: "portfolio company updates received",
    columns: { id: "text", company_id: "text", period_label: "text", received_at: "date", source: "text", created_at: "date" },
    privacy: true, archivable: false, confidential: true,
  },
  portfolio_metric_snapshot: {
    label: "portfolio metrics by company and date",
    columns: { id: "text", company_id: "text", metric_key: "text", as_of_date: "date", period_label: "text", value: "number", source: "text" },
    privacy: true, archivable: false, confidential: true,
  },
  portfolio_alert: {
    label: "portfolio alerts",
    columns: { id: "text", company_id: "text", alert_type: "text", metric_key: "text", severity: "text", status: "text", occurrence_count: "number", first_seen_at: "date", last_seen_at: "date" },
    privacy: false, archivable: false, confidential: true,
  },
  fund: {
    label: "the funds",
    columns: { id: "text", name: "text", status: "text", target_size_minor: "number", currency: "text", vintage_year: "number" },
    privacy: false, archivable: false, confidential: true,
  },
  fund_construction_scenario: {
    label: "fund construction scenarios (allocation)",
    columns: { id: "text", fund_id: "text", name: "text", status: "text", fund_size: "number", investable: "number", fund_deployed: "number", reserve_committed: "number", reserve_modeled_need: "number", created_at: "date" },
    privacy: true, archivable: false, confidential: true,
  },
  reserve_allocation: {
    label: "reserves committed to companies",
    columns: { id: "text", fund_id: "text", company_id: "text", amount: "number", status: "text", created_at: "date" },
    privacy: false, archivable: false, confidential: true,
  },
  lp_record: {
    label: "limited partners",
    columns: { id: "text", legal_name: "text", lp_type: "text", status: "text", relationship_owner: "text", created_at: "date" },
    privacy: true, archivable: false, confidential: true,
  },
  lp_commitment: {
    label: "LP commitments to funds",
    columns: { id: "text", lp_record_id: "text", fund_id: "text", amount_minor: "number", currency: "text", state: "text", committed_on: "date" },
    privacy: true, archivable: false, confidential: true,
  },
  capital_call: {
    label: "capital calls",
    columns: { id: "text", fund_id: "text", lp_record_id: "text", amount_minor: "number", currency: "text", called_on: "date", received_on: "date" },
    privacy: true, archivable: false, confidential: true,
  },
  meeting: {
    label: "meetings on the record",
    columns: { id: "text", title: "text", meeting_type: "text", status: "text", company_id: "text", lp_record_id: "text", scheduled_at: "date", occurred_at: "date" },
    privacy: true, archivable: true, confidential: false,
  },
  meeting_decision: {
    label: "decisions recorded from meetings",
    columns: { id: "text", meeting_id: "text", decision_text: "text", decided_by: "text", recorded_at: "date" },
    privacy: false, archivable: false, confidential: true,
  },
  meeting_commitment: {
    label: "commitments made in meetings, both sides (the ledger)",
    columns: { id: "text", meeting_id: "text", commitment_text: "text", owner_side: "text", owed_by: "text", due_date: "date", status: "text", honoured_at: "date", created_at: "date" },
    privacy: false, archivable: false, confidential: true,
  },
  meeting_open_question: {
    label: "questions meetings left open",
    columns: { id: "text", meeting_id: "text", question: "text", owed_by_kind: "text", owed_by: "text", state: "text", created_at: "date" },
    privacy: false, archivable: false, confidential: true,
  },
};

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "is_null", "not_null"] as const;
export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export const CHART_TYPES = ["bar", "line", "pie"] as const;
export const ROW_CAP = 50;

const ident = z.string().regex(/^[a-z_][a-z0-9_]*$/);

export const recordQueryPlanSchema = z.object({
  table: ident,
  select: z.array(ident).max(12).default([]),
  where: z
    .array(
      z.object({
        column: ident,
        op: z.enum(OPERATORS),
        value: z.union([z.string().max(200), z.number(), z.array(z.union([z.string().max(200), z.number()])).max(20)]).optional(),
      }),
    )
    .max(8)
    .default([]),
  group_by: ident.optional(),
  metric: z.object({ fn: z.enum(AGGREGATES), column: ident.optional() }).optional(),
  order_by: z.object({ column: ident, dir: z.enum(["asc", "desc"]).default("desc") }).optional(),
  limit: z.number().int().min(1).max(ROW_CAP).default(25),
  chart: z.enum(CHART_TYPES).optional(),
  /** Ask for archived rows too. Off unless the question says so. */
  include_archived: z.boolean().default(false),
});

export type RecordQueryPlan = z.infer<typeof recordQueryPlanSchema>;

export class RecordQueryRefused extends Error {
  code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

export interface CompiledQuery {
  sql: string;
  params: Array<string | number>;
  columns: string[];
  table: string;
  /** Whether the rows will name LPs, deal terms or fund figures. */
  confidential: boolean;
}

/**
 * Plan → one SELECT. Refuses, by name, anything outside the vocabulary.
 *
 * `visibility` is the privacy clause the page queries use (`privacyVisibilityClause`), passed in
 * so this file stays free of worker imports. It is interpolated as-is because it is built by the
 * firm's own code from a fixed label list, never from the plan.
 */
export function compileRecordQuery(raw: unknown, ctx: { firmScope: string; visibility: string }): CompiledQuery {
  const parsed = recordQueryPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RecordQueryRefused("plan_unreadable", `The plan is not in the shape the room accepts: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 300)}`);
  }
  const plan = parsed.data;
  const table = ALLOWLIST[plan.table];
  if (!table) {
    throw new RecordQueryRefused("table_not_allowed", `"${plan.table}" is not a table the room may read. It can read: ${Object.keys(ALLOWLIST).join(", ")}.`);
  }
  const has = (c: string) => Object.prototype.hasOwnProperty.call(table.columns, c);
  for (const c of plan.select) if (!has(c)) throw new RecordQueryRefused("column_not_allowed", `"${plan.table}.${c}" is not a column the room may read.`);
  for (const w of plan.where) if (!has(w.column)) throw new RecordQueryRefused("column_not_allowed", `"${plan.table}.${w.column}" is not a column the room may filter on.`);
  if (plan.group_by && !has(plan.group_by)) throw new RecordQueryRefused("column_not_allowed", `"${plan.table}.${plan.group_by}" is not a column the room may group by.`);
  if (plan.metric?.column && !has(plan.metric.column)) throw new RecordQueryRefused("column_not_allowed", `"${plan.table}.${plan.metric.column}" is not a column the room may aggregate.`);
  if (plan.order_by && !has(plan.order_by.column) && !(plan.order_by.column === "metric" && (plan.metric || plan.group_by))) {
    throw new RecordQueryRefused("column_not_allowed", `"${plan.table}.${plan.order_by.column}" is not a column the room may order by.`);
  }
  if (plan.metric && plan.metric.fn !== "count" && !plan.metric.column) {
    throw new RecordQueryRefused("plan_unreadable", `${plan.metric.fn} needs a column.`);
  }
  if (plan.metric?.column && plan.metric.fn !== "count" && table.columns[plan.metric.column] !== "number") {
    throw new RecordQueryRefused("plan_unreadable", `${plan.metric.fn}(${plan.metric.column}) — that column is not a number.`);
  }

  const params: Array<string | number> = [];
  const conds: string[] = [`firm_scope = ?${params.push(ctx.firmScope)}`];
  if (table.privacy) conds.push(`(${ctx.visibility})`);
  if (table.archivable && !plan.include_archived) conds.push("archived_at IS NULL");
  for (const w of plan.where) {
    const col = w.column;
    switch (w.op) {
      case "is_null": conds.push(`${col} IS NULL`); break;
      case "not_null": conds.push(`${col} IS NOT NULL`); break;
      case "in": {
        const vals = Array.isArray(w.value) ? w.value : w.value === undefined ? [] : [w.value];
        if (vals.length === 0) throw new RecordQueryRefused("plan_unreadable", `"in" on ${col} needs values.`);
        conds.push(`${col} IN (${vals.map((v) => `?${params.push(v)}`).join(", ")})`);
        break;
      }
      case "like": {
        if (typeof w.value !== "string") throw new RecordQueryRefused("plan_unreadable", `"like" on ${col} needs text.`);
        conds.push(`${col} LIKE ?${params.push(`%${w.value.replace(/[%_]/g, "")}%`)}`);
        break;
      }
      default: {
        if (w.value === undefined || Array.isArray(w.value)) throw new RecordQueryRefused("plan_unreadable", `"${w.op}" on ${col} needs one value.`);
        const sym = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[w.op];
        conds.push(`${col} ${sym} ?${params.push(w.value)}`);
      }
    }
  }

  let columns: string[];
  let selectSql: string;
  if (plan.group_by) {
    const fn = plan.metric?.fn ?? "count";
    const agg = fn === "count" ? "COUNT(*)" : `${fn.toUpperCase()}(${plan.metric!.column})`;
    columns = [plan.group_by, "metric"];
    selectSql = `${plan.group_by}, ${agg} AS metric`;
  } else if (plan.metric) {
    const fn = plan.metric.fn;
    columns = ["metric"];
    selectSql = fn === "count" ? "COUNT(*) AS metric" : `${fn.toUpperCase()}(${plan.metric.column}) AS metric`;
  } else {
    // `id` always rides along so the block can cite the rows it was built from.
    columns = plan.select.length > 0 ? [...new Set(["id", ...plan.select])] : Object.keys(table.columns);
    selectSql = columns.join(", ");
  }

  const order = plan.order_by
    ? `ORDER BY ${plan.order_by.column} ${plan.order_by.dir.toUpperCase()}`
    : plan.group_by
      ? "ORDER BY metric DESC"
      : "";
  const group = plan.group_by ? `GROUP BY ${plan.group_by}` : "";
  const limit = Math.min(plan.limit, ROW_CAP);
  const sql = ["SELECT", selectSql, "FROM", plan.table, "WHERE", conds.join(" AND "), group, order, `LIMIT ${limit}`].filter(Boolean).join(" ");
  return { sql, params, columns, table: plan.table, confidential: table.confidential };
}

/** The vocabulary, as the model is shown it. Names and columns only — no data. */
export function describeAllowlist(): string {
  return Object.entries(ALLOWLIST)
    .map(([name, t]) => `- ${name} (${t.label}): ${Object.entries(t.columns).map(([c, k]) => `${c}:${k}`).join(", ")}`)
    .join("\n");
}

/** What a saved table/chart block cites: the rows (by id) or, for an aggregate, the groups. */
export function citationsFor(compiled: CompiledQuery, rows: Array<Record<string, unknown>>): string[] {
  if (compiled.columns.includes("id")) return rows.map((r) => `${compiled.table}:${String(r.id)}`);
  const key = compiled.columns[0]!;
  return rows.map((r) => `${compiled.table}:${key}=${String(r[key] ?? "null")}`);
}
