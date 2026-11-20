/** Types for check-changed.mjs (the parts the test imports). See that file. */
export const TEST_CAP: number;
export function capTests(changedTests: readonly string[], direct: ReadonlyMap<string, number>, transitive: readonly string[], cap?: number): { run: string[]; left: number };
