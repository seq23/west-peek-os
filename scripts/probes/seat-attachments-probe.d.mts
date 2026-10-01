export const PDF_CODE_WORD: string;
export function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array;
export function textPdf(text: string): Uint8Array;
export function verdictFor(kind: "image" | "pdf", answer: string): boolean;
export function judge(kind: "image" | "pdf", result: { started: boolean; timedOut?: boolean; code?: number | null; out: string; err: string }): { status: "PROVEN" | "FAILED" | "UNTESTED"; why: string };
export function codexArgs(kind: "image" | "pdf", filePath: string, prompt: string): string[];
export function claudeArgs(prompt: string): string[];
export function promptFor(kind: "image" | "pdf", fileName: string, seat?: string): string;
