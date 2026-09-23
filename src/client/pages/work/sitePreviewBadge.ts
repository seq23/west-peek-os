import { WEB_PROPERTY_CHANGE_KIND } from "../../../shared/work/localJobs";

/**
 * "PREVIEW BEFORE IT GOES LIVE" — THE SITE GATE, SHOWN BESIDE "SHOW ME FIRST", NEVER AS IT
 * (owner, 23 Sep 2026: "we should default to preview first for all repo work").
 *
 * Two different holds, two different columns, and the desk had drawn only one of them:
 *
 *   · "Show me first" (`work_card.preview_first`) — hold the finished RESULT for her before it goes
 *     to the recipient. Every kind, a switch, unchanged.
 *   · "Preview before it goes live" (`web_property_change.preview_only`) — the site change stops at a
 *     preview link and needs a second approval before LAND (`needsPreview` in
 *     services/webPropertyChange.ts). Web property changes only; always on since 0238; the one way
 *     past it is the named force in the request ("approved to production"). Read-only here, because
 *     a desk control that turned it off would be a land bypass nobody named.
 *
 * On 23 Sep a community-site card had the site gate ON and the desk showed only the switch, OFF —
 * so the gate she had was invisible. This reads the gate's own column, served on the board payload
 * as `site_preview_only`, and nothing else. `validate:no-land-without-approval` pins that.
 */
export interface SitePreviewBadge {
  text: string;
  title: string;
  on: boolean;
}

export function sitePreviewBadge(card: { kind?: string | null; site_preview_only?: number | null }): SitePreviewBadge | null {
  if (card.kind !== WEB_PROPERTY_CHANGE_KIND) return null;
  const on = card.site_preview_only === 1;
  return on
    ? { on, text: "Preview before it goes live: always on", title: "Site work always stops at a preview link and asks you before it lands. The only way to skip it is to say \"approved to production\" in the request." }
    : { on, text: "Preview before it goes live: off", title: "This change is not held at a preview — it lands on green once its plan is approved." };
}
