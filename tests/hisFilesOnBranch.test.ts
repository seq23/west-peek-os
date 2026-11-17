import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hisFilesBlock, hisFilesOnBranch } from "../scripts/duties/web-property-change.mjs";

/*
 * wc_76e6d7ff (17 Nov 2026): Scooter sent a replacement Blitz & Bubbles logo. The rebuild said it used it; the branch
 * still carried his OLD file byte for byte. The reviewer now gets where each file he sent is, measured, not claimed.
 */
describe("his files, checked by their bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "his-files-"));
  const wt = path.join(root, "wt");
  const att = path.join(root, "pkg", "attachments");
  mkdirSync(path.join(wt, "design", "partner-logos"), { recursive: true });
  mkdirSync(path.join(wt, "node_modules", "x"), { recursive: true });
  mkdirSync(att, { recursive: true });
  writeFileSync(path.join(att, "image-old.png"), "OLD-LOGO-BYTES");
  writeFileSync(path.join(att, "image-new.png"), "NEW-LOGO-BYTES");
  writeFileSync(path.join(att, "image-same-size.png"), "XXXXXXXXXXXXXX");
  writeFileSync(path.join(wt, "design", "partner-logos", "blitz.png"), "OLD-LOGO-BYTES");
  writeFileSync(path.join(wt, "node_modules", "x", "copy.png"), "NEW-LOGO-BYTES");

  it("names where each file is, and a replacement the branch never took as NOT FOUND", () => {
    const lines = hisFilesOnBranch(wt, att);
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.includes("image-old.png"))).toContain("design/partner-logos/blitz.png");
    // A copy under node_modules is not the build using his file, and same-size bytes are not a match.
    expect(lines.find((l) => l.includes("image-new.png"))).toContain("NOT FOUND");
    expect(lines.find((l) => l.includes("image-same-size.png"))).toContain("NOT FOUND");
  });

  it("the reviewer's block carries the list and makes an unproven file blocking; no files, no block", () => {
    const block = hisFilesBlock(hisFilesOnBranch(wt, att));
    expect(block).toContain("image-new.png: NOT FOUND");
    expect(block).toMatch(/blocking/);
    expect(hisFilesBlock(hisFilesOnBranch(wt, path.join(root, "none")))).toBe("");
  });
});
