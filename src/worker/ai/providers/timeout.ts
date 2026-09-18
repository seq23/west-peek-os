/**
 * How long any single provider attempt may take before it becomes a failure.
 *
 * A request that never answers is worse than one that fails: the run sits RUNNING, the failover
 * never engages, and the work silently does not happen. Before this constant existed there was no
 * deadline on any adapter's fetch, so "timeout" was a failure mode the system could describe and
 * could not actually produce.
 *
 * WHY IT IS NO LONGER 60s (18 Sep 2026). 60s was chosen as "comfortably above a long frontier
 * completion". It was not. The daily brief asks for 8000 output tokens, and this repo says so in
 * its own words a few files away — `dailyIntelligence.ts`: "A stage that writes the brief is one
 * model call, ~3 min." A deadline of 60s on a call the system states takes three minutes is not a
 * safety net, it is a guarantee of failure, and the prose and the number had no link between them.
 *
 * What it cost: on 18 Sep every frontier attempt at both partners' briefs aborted on this deadline
 * — four free lanes and claude-sonnet-5, every one `TIMEOUT_OR_NETWORK` — and the router did
 * exactly what it should, failing over to the cheapest lane still answering. That lane truncated
 * at 256 tokens (see `outputCeiling.ts`) and both partners spent the morning with an empty card.
 * The brief had worked on this same pinned lane the two mornings before.
 *
 * 180s is the repo's own stated figure for its longest call, so the two now agree, and
 * `validate:brief-arrives` reads that figure OUT OF `dailyIntelligence.ts` and fails if this
 * constant drops below it. It is still far below the stage lease that contains it
 * (`STAGE_LEASE_MINUTES`, 10 minutes), so a hung provider is still a failure the router acts on
 * rather than a run that sits RUNNING for ever — which is the whole reason the deadline exists.
 *
 * Adapters take it as a default and allow an override so a test can prove the path in
 * milliseconds rather than minutes.
 */
export const PROVIDER_TIMEOUT_MS = 180_000;
