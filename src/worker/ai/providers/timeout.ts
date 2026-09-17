/**
 * How long any single provider attempt may take before it becomes a failure.
 *
 * A request that never answers is worse than one that fails: the run sits RUNNING, the failover
 * never engages, and the work silently does not happen. Before this constant existed there was no
 * deadline on any adapter's fetch, so "timeout" was a failure mode the system could describe and
 * could not actually produce.
 *
 * 60s is comfortably above a long frontier completion and far below anything a person would wait
 * for. Adapters take it as a default and allow an override so a test can prove the path in
 * milliseconds rather than a minute.
 */
export const PROVIDER_TIMEOUT_MS = 60_000;
