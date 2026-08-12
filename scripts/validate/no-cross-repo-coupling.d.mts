/** Types for the P9 boundary scanner, so tests can exercise the real check function. */
export declare function stripComments(source: string): string;
export declare function checkSources(files: Record<string, string>): string[];
