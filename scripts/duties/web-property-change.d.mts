/**
 * Types for the two pure readers `tests/porterNotices.test.ts` holds to the Worker's own
 * (`cleanPreviewUrls` in src/shared/work/porterNotices.ts) — one rule, two runtimes, the same answers.
 */
export function previewUrlsFrom(deploymentStatuses: ReadonlyArray<{ environment_url?: string | null }>, commentBodies: readonly string[], pagesHosts?: readonly string[], branch?: string): string | null;
export function branchAlias(branch: string | null | undefined): string;
/** Did Claude Code stop because its plan's usage is spent? The notice's own words, or null. Only a failed or unreadable run is inspected. */
export function claudeSpentUsage(run: { out: string; err: string }): string | null;
export function codexSpentUsage(run: { out: string; err: string }): string | null;
