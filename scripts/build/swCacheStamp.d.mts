/** Types for the sw.js build-id stamping logic, so tests can exercise the real functions. */
export declare function computeBuildId(assetNames: string[]): string;
export declare function stampServiceWorker(source: string, buildId: string): string;
