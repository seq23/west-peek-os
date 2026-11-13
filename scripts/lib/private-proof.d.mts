/** Types for the pure private-document proof (#357), held by tests/privateMaterial.test.ts. */
export const PRIVATE_MARK: string;
export const PASSAGE_WORDS: number;
export function privateSentenceIn(constraints: readonly unknown[] | null | undefined): string | null;
export function privateDocsIn(paths: readonly string[], sentence: string | null): string[];
export function plainText(raw: string): string;
export function addedText(diff: string): string;
export function namedAsSource(docPath: string, publicTexts: readonly string[]): boolean;
export function passagesIn(docText: string, diff: string, publicTexts?: readonly string[]): Array<{ file: string; line: number; words: number; sensitive: boolean; why: string | null }>;
export function privateProof(input: { constraints: readonly unknown[]; paths: readonly string[]; docs: ReadonlyArray<{ path: string; text: string | null }>; diff: string | null; publicTexts?: readonly string[] }): {
  ok: boolean;
  checked: number;
  line?: string | null;
  reason?: string;
  files?: string[];
  used?: Array<{ file: string; line: number; words: number }>;
};
