import type { Env } from "./env";

/**
 * Event spine helper (D15): the ONLY way application code appends to event_record.
 * One append-only typed spine feeds Activity, Audit, and Diagnostics — do not create
 * a second event system. event_record itself rejects UPDATE/DELETE at the DB layer (P1).
 */
export interface AppendEventInput {
  eventType: string;
  actorType: "firm_user" | "ai_employee" | "system";
  actorId: string;
  objectType: string;
  objectId: string;
  firmScope?: string;
  payload?: unknown;
}

export async function appendEvent(env: Env, input: AppendEventInput): Promise<string> {
  const id = `evt_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO event_record (id, event_type, actor_type, actor_id, object_type, object_id, firm_scope, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      input.eventType,
      input.actorType,
      input.actorId,
      input.objectType,
      input.objectId,
      input.firmScope ?? "west-peek",
      JSON.stringify(input.payload ?? {}),
    )
    .run();
  return id;
}
