export declare const PROOF_MAX_AGE_MS: number;
export declare function proofPath(home?: string): string;
export interface AttachmentProof {
  at: string;
  seats: Record<string, { image?: boolean; pdf?: boolean }>;
}
export declare function readProof(home?: string): AttachmentProof | null;
export declare function mergeProof(previous: AttachmentProof | null | undefined, rows: Array<{ seat: string; kind: "image" | "pdf"; status: string }>, nowMs?: number): AttachmentProof;
export declare function writeProof(proof: AttachmentProof, home?: string): void;
export declare function capabilitiesFromProof(proof: AttachmentProof | null | undefined, nowMs?: number): string[];
export declare function safeFileName(label: string, n: number): string;
export declare function requiredCapabilities(seat: string, attachments: Array<{ kind: string }> | undefined): string[];
export declare function missingCapability(seat: string, attachments: Array<{ kind: string }> | undefined, held: readonly string[]): string | null;
export interface AttachFile { kind: "image" | "document"; path: string; name: string }
export declare function codexAttachArgs(files: AttachFile[], prompt: string): string[];
export declare function claudeAttachArgs(prompt: string): string[];
export declare function attachmentNote(seat: string, files: AttachFile[]): string;
