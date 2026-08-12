import { z } from "zod";

/**
 * Privacy label vocabulary (canon §11.3). Labels gate provider/egress handling in later
 * phases (D8/D9); in P2 they are recorded on identity rows so sensitivity is never lost.
 */
export const PRIVACY_LABELS = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
  "LP_PRIVATE",
  "MNPI_SENSITIVE",
  "BANKING_RESTRICTED",
] as const;

export type PrivacyLabel = (typeof PRIVACY_LABELS)[number];

export const privacyLabelSchema = z.enum(PRIVACY_LABELS);

export const DEFAULT_PRIVACY_LABEL: PrivacyLabel = "INTERNAL";
