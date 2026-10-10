import type { Env } from "../env";
import { currentPreviewLine } from "../../shared/work/porterNotices";
import { plainTitle } from "../../shared/work/siteChange";
import { pagesHostsOf } from "../../shared/intake/webPropertyChange";
import { loadRegistry } from "./webPropertyRegistry";

/**
 * WHAT EVERY PORTER EMAIL NEEDS TO SAY WHERE THINGS STAND (23 Sep 2026): the plain title and the
 * latest preview line. Read here, once, by both doors that email a partner about a web property
 * change — `requestReply.ts` (the sweep's DONE / QUESTION / PREVIEW / PLAN) and
 * `webPropertyChange.ts` (RECEIVED, STUCK, the unchanged-materials reply) — so no notice can be
 * missing the link another one carries. A module of its own because `webPropertyChange.ts` imports
 * `requestReply.ts`; the other direction would be a cycle.
 */
export async function porterContext(env: Env, cardId: string): Promise<{ title: string; previewLine: string | null; sites: string[] } | null> {
  const row = await env.WP_OS_DB.prepare(
    `SELECT w.plan_text, w.property_host, w.branch, w.preview_url, w.request_text, c.title AS card_title, w.pr_url, w.check_state, w.check_green_at, w.placeholders_json, w.changed_pages_json,
            p.title AS request_subject
       FROM web_property_change w
       JOIN work_card c ON c.id = w.work_card_id
       LEFT JOIN work_card p ON p.id = c.assigned_from_card_id
      WHERE w.work_card_id = ?1`,
  )
    .bind(cardId)
    .first<{ plan_text: string | null; property_host: string | null; branch: string | null; request_text: string | null; card_title: string; preview_url: string | null; pr_url: string | null; check_state: string | null; check_green_at: string | null; placeholders_json: string | null; changed_pages_json: string | null; request_subject: string | null }>();
  if (!row) return null;
  const registry = await loadRegistry(env);
  const parts = (
    await env.WP_OS_DB.prepare("SELECT repo, property_host, branch, preview_url, pr_url, changed_pages_json FROM web_property_change_part WHERE work_card_id = ?1 ORDER BY position").bind(cardId).all<{ repo: string; property_host: string | null; branch: string | null; preview_url: string | null; pr_url: string | null; changed_pages_json: string | null }>()
  ).results ?? [];
  return {
    // THE DESK'S OWN READER (shared/work/siteChange.ts), so the email and the card name the job the
    // same way — without the " · host" suffix, which the subject has no room for.
    title: plainTitle({ title: row.card_title, kind: "WEB_PROPERTY_CHANGE", host: null, subject: row.request_subject, ask: row.request_text }),
    previewLine: currentPreviewLine(row, parts.map((p) => ({ ...p, pagesHosts: pagesHostsOf(p.property_host, registry), branch: p.branch })), { pagesHosts: pagesHostsOf(row.property_host, registry), branch: row.branch }),
    sites: parts.length ? parts.map((p) => p.property_host ?? p.repo) : [],
  };
}
