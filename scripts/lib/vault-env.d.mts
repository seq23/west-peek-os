/** Types for scripts/lib/vault-env.mjs (the Mac scripts are plain ESM; tests import them). */
export declare const VAULT_INJECTED_VAR: "WP_OS_VAULT_INJECTED";
export declare function vaultRunEnv(base: Record<string, string | undefined>, injected: Record<string, string>): Record<string, string | undefined>;
export declare function vaultNames(manifestPath?: string, mappingPath?: string): Set<string>;
export declare function claudeChildEnv(base: Record<string, string | undefined>, onStripped?: (names: string[]) => void, known?: Set<string>): Record<string, string>;
export declare function strippedNote(names: readonly string[]): string;
