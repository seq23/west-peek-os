import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Accessibility properties that were absent and are easy to lose again.
 *
 * These are structural checks on the source, not a substitute for using the product with a keyboard
 * and a screen reader. What they catch is the specific way each of these regressed the first time:
 * somebody adds a control in a hurry, and nothing anywhere notices it has no name.
 *
 * The sweep that produced them found 57 form controls with no accessible name at all — placeholders
 * throughout, which vanish the moment you type and are not a label — the app's most-used
 * interactive element sized at roughly half the minimum touch target, and a heading level skipped
 * on Home. Focus, skip link, image alts and keyboard reachability were already sound.
 */

const CLIENT = new URL("../src/client/", import.meta.url).pathname;

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(CLIENT);
  return out;
}

/**
 * Element boundaries, honouring braces and every kind of quote.
 *
 * Three things break a naive scan of JSX, and this file has now been bitten by all three:
 *   `[^>]*>`        stops at the `>` in an arrow function;
 *   ignoring braces stops at a `>` inside an expression;
 *   ignoring BACKTICKS treats the apostrophe in `${name}'s title` as an opening quote that never
 *                   closes, so the tag runs on into the next element and reports a duplicate
 *                   attribute that does not exist.
 *
 * The third one produced a false failure on a perfectly good control. Template literals are quotes
 * too, and an apostrophe inside one is just a letter.
 */
function tagsIn(src: string, names: string[]): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(${names.join("|")})\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let j = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    while (j < src.length) {
      const c = src[j]!;
      if (quote) {
        if (c === quote && src[j - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      j++;
    }
    out.push(src.slice(m.index, j + 1));
  }
  return out;
}

describe("every control can be announced", () => {
  it("gives every form control a name a screen reader can read", () => {
    const nameless: string[] = [];
    for (const f of clientFiles()) {
      const src = readFileSync(f, "utf8");
      for (const tag of tagsIn(src, ["input", "select", "textarea"])) {
        if (/type="(checkbox|radio|hidden)"/.test(tag)) continue; // named by their wrapping label
        if (tag.includes("aria-label")) continue;
        const idx = src.indexOf(tag);
        const before = src.slice(Math.max(0, idx - 500), idx);
        const open = before.lastIndexOf("<label");
        const close = before.lastIndexOf("</label>");
        if (open > close) continue; // inside a <label>
        /*
         * A SEPARATE <label htmlFor> IS A NAME TOO, and the scanner used to say otherwise.
         * It flagged the Capture box, which carries a visible label above it wired by id —
         * better for everybody than an aria-label a sighted user never sees. A check that
         * pushes an author away from the visible label toward the invisible one is wrong.
         */
        const id = tag.match(/\bid="([^"]+)"/)?.[1];
        if (id && src.includes(`htmlFor="${id}"`)) continue;
        /*
         * An id built from an expression is still an id. A list that renders one form per row
         * needs `id={`fb-note-${d.id}`}`, and the label beside it carries the identical expression
         * in htmlFor. Matching only double-quoted literals reported both as nameless and would have
         * pushed the fix toward an aria-label nobody can see, over a visible label already there.
         */
        const exprId = tag.match(/\bid=\{([^}]*\}?[^}]*)\}/)?.[1];
        if (exprId && src.includes(`htmlFor={${exprId}}`)) continue;
        nameless.push(`${f.split("/client/")[1]}: ${tag.replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
    expect(nameless).toEqual([]);
  });

  it("does not name a control twice", () => {
    // Two aria-labels on one element is a React error and was produced by exactly the naive
    // tag-matching this file's own helper exists to avoid.
    const dupes: string[] = [];
    for (const f of clientFiles()) {
      for (const tag of tagsIn(readFileSync(f, "utf8"), ["input", "select", "textarea", "button"])) {
        if ((tag.match(/aria-label=/g) ?? []).length > 1) dupes.push(f.split("/client/")[1]!);
      }
    }
    expect(dupes).toEqual([]);
  });
});

describe("structure and reach", () => {
  it("never skips a heading level", () => {
    // A screen-reader user navigating by heading hears a jump as a missing section.
    const bad: string[] = [];
    for (const f of clientFiles()) {
      const levels = [...readFileSync(f, "utf8").matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
      for (let i = 1; i < levels.length; i++) {
        if (levels[i]! - levels[i - 1]! > 1) {
          bad.push(`${f.split("/client/")[1]}: h${levels[i - 1]} then h${levels[i]}`);
          break;
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps a real touch target on the app's most-used control", () => {
    // `.link-button` is the primary affordance in sixty-odd places and carried min-height: auto
    // with 4px of padding — roughly half the 44px minimum, on the device most people would use.
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url).pathname, "utf8");
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
    expect(coarse).toContain(".link-button");
    expect(coarse).toContain("min-height: 44px");
  });

  it("still honours a reduced-motion preference globally", () => {
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url).pathname, "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\*,/);
  });

  it("keeps the skip link, so the keyboard can get past the rail", () => {
    // Forty nav items before the content is a long way to tab.
    const css = readFileSync(new URL("../src/client/styles.css", import.meta.url).pathname, "utf8");
    expect(css).toContain(".skip-link");
    expect(readFileSync(new URL("../src/client/App.tsx", import.meta.url).pathname, "utf8")).toContain("skip-link");
  });
});

/*
 * NO INVISIBLE CHARACTERS IN SOURCE.
 *
 * A NUL byte reached a template literal used as a map key on the server while the client built the
 * same key with a space. Nothing matched, dismissing an alert silently did nothing, and the two
 * lines looked identical in every diff, editor and code review — because the difference was a
 * character with no glyph. It took a debugger and twenty minutes.
 *
 * Tab, newline and carriage return are the only control characters a source file has any business
 * containing. This is cheap, runs on every file, and would have caught it instantly.
 */
describe("source files contain no invisible characters", () => {
  it("has no control characters other than tab, newline and carriage return", () => {
    const offenders: string[] = [];
    const roots = [new URL("../src/", import.meta.url).pathname, new URL("../tests/", import.meta.url).pathname];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx|css|sql)$/.test(e.name)) {
          const text = readFileSync(full, "utf8");
          // eslint-disable-next-line no-control-regex
          const found = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
          if (found) {
            const at = text.indexOf(found[0]);
            offenders.push(`${full.split("/west-peek-os/")[1] ?? full}: U+${found[0].charCodeAt(0).toString(16).padStart(4, "0")} near "${text.slice(Math.max(0, at - 30), at + 10).replace(/\s+/g, " ")}"`);
          }
        }
      }
    };
    for (const r of roots) walk(r);
    expect(offenders).toEqual([]);
  });
});
