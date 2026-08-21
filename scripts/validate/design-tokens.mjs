#!/usr/bin/env node
/**
 * Design-token boundary scan — type, space, radius, line-height.
 *
 * WHY THIS EXISTS, and it is not a hypothetical. The operator reported, from the running product:
 * "why is the font not the fucking same size". The purpose block at the top of every one of the 38
 * pages set its sentence at `--text-sm` (13px) and the line directly beneath it at `--text-xs`
 * (12px). One pixel apart — too small to read as a deliberate hierarchy, large enough to read as a
 * mistake. It shipped because nothing was checking, exactly as the blue-and-purple drift did before
 * `west-peek-brand-system.mjs` existed.
 *
 * The hostile review of 21 August covered whether things WORK. It did not cover whether they LOOK
 * consistent, which is a different question and needs a different check. This is that check.
 *
 * IT STARTED AS A TYPE SCAN AND THE TYPE WAS THE SMALL HALF. Extending the same technique to the
 * other three scales the stylesheet declares found 190 off-token spacing values across 32 distinct
 * sizes (0.35rem, 0.4rem, 0.6rem, 0.9rem…), 18 off-token radii, and 23 hand-written line-heights —
 * next to a token block that says, in its own comment, "4pt scale. Nothing off-scale." The scale
 * was aspirational. This is what makes it true.
 *
 * RULES FOR TYPE, and both come from what `styles.css` already declares about itself.
 *
 *   1. EVERY font-size is a scale token, `inherit`, or `1em`. The stylesheet defines an eight-step
 *      scale from 11px to 28px and comments the top step "The ceiling: this is an OS, not a landing
 *      page." A raw `0.95rem` is not on that scale, cannot be reasoned about against it, and is how
 *      a scale erodes one component at a time.
 *
 *   2. NO COMPONENT MIXES TWO ADJACENT STEPS AT THE SAME REGISTER. Steps exist to be told apart. A
 *      block using both `--text-sm` and `--text-xs` with nothing else separating them produces a
 *      difference a reader registers as wrong without being able to say why — which is precisely
 *      the defect that prompted this file. Skipping a step reads as intent and passes.
 *
 *      TWO NARROWINGS, both earned rather than convenient. A rule that ALSO changes register —
 *      `text-transform: uppercase` or a `letter-spacing` — is making a different kind of text, and
 *      one step of size on top of that reads as deliberate; a column heading in small caps over its
 *      own column is the ordinary case and flagging it would teach people to ignore this scan. And
 *      rules inside `@media` are a different viewport, not a different element: a touch target that
 *      grows a step on a phone is not sitting beside anything.
 *
 *      The narrowings are proven, not asserted — the self-test plants the ORIGINAL reported bug and
 *      requires it still fails.
 *
 * THE ESCAPE HATCH IS NARROW AND MUST SAY WHY. `/* design-token-exempt: reason *\/` immediately above
 * the declaration. Text inside a drawn graphic — an SVG ring caption — is genuinely not on a
 * document type scale, and a validator with no honest exemption is a validator someone deletes.
 *
 * `--self-test` plants each violation and asserts the scan still catches it, per AGENTS.md.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STYLES = "src/client/styles.css";

/**
 * The other three scales. Same law as type: a value is a token, or one of a few things that assert
 * no size at all. These are checked by VALUE rather than by adjacency — a 2px difference in padding
 * is not the same kind of defect as a 1px difference in type, but a padding scale with 32 distinct
 * values is not a scale.
 */
const FAMILIES = [
  {
    name: "space",
    // Longhands included: `padding-left` erodes a scale exactly as fast as `padding`.
    prop: /\b((?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block)[a-z-]*)?)\s*:\s*([^;{}]+)/g,
    ok: (v) =>
      v.startsWith("var(--space-") ||
      v.startsWith("calc(") ||
      v.startsWith("env(") ||
      v.endsWith("%") ||
      ["0", "auto", "inherit", "initial", "unset"].includes(v),
    hint: "--space-3xs … --space-3xl (the 4pt scale), or 0/auto/a percentage",
  },
  {
    name: "radius",
    prop: /\b(border-radius)\s*:\s*([^;{}]+)/g,
    ok: (v) => v.startsWith("var(--radius-") || v.endsWith("%") || ["0", "inherit"].includes(v),
    hint: "--radius-xs/sm/md/lg/pill, or a percentage for a circle",
  },
  {
    name: "line-height",
    prop: /\b(line-height)\s*:\s*([^;{}]+)/g,
    // `1` is a reset on an icon or a badge — it means "no leading", not a chosen step.
    ok: (v) => v.startsWith("var(--lh-") || ["1", "inherit", "normal"].includes(v),
    hint: "--lh-tight/snug/normal, or 1 to reset leading on an icon",
  },
];

/** Declared in the `:root` token block. Order IS the scale — adjacency is computed from it. */
const SCALE = ["--text-2xs", "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl"];

/** Values that assert nothing about size and therefore cannot break the scale. */
const NEUTRAL = new Set(["inherit", "1em", "100%", "unset", "initial"]);

const EXEMPT = /design-token-exempt:/;

/**
 * The component a selector belongs to: the first one or two segments of its leading class.
 * `.page-purpose-can` and `.page-purpose-line` are one component; `.nav-link` and `.nav-group` are
 * two. Two segments is the right grain — West Peek class names are `block-element-modifier`, so
 * one segment lumps unrelated blocks together and three splits a block from its own parts.
 */
function componentOf(selector) {
  const m = selector.trim().match(/^\.([a-z0-9]+(?:-[a-z0-9]+)?)/);
  return m ? m[1] : null;
}

function scan(css) {
  const problems = [];

  /*
   * Comments blanked to same-length whitespace, so byte offsets still line up with `css` while
   * prose inside a comment cannot be read as a declaration. This scan's own explanatory comment
   * contains the words "gap: too small…", which the family scan duly reported as a spacing
   * violation — a validator that flags its own documentation is not one anybody will keep.
   */
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  // Rules, with their preceding text kept so an exemption comment can be seen.
  // Rules inside @media are recorded separately: a size that only applies at a breakpoint is not
  // sitting next to anything at the default one.
  const mediaRanges = [];
  const atRe = /@media[^{]*\{/g;
  let at;
  while ((at = atRe.exec(css)) !== null) {
    let depth = 1;
    let i = atRe.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    mediaRanges.push([at.index, i]);
  }
  const insideMedia = (i) => mediaRanges.some(([a, b]) => i >= a && i < b);

  const ruleRe = /([^{}]*)\{([^{}]*)\}/g;
  const byComponent = new Map();
  let m;
  while ((m = ruleRe.exec(css)) !== null) {
    // The raw leading group holds everything between the previous rule and this one — including
    // any comment. Read the exemption from HERE, not from a window before m.index: the selector
    // group is greedy and starts immediately after the previous `}`, so the comment is inside it.
    const lead = m[1];
    const selector = lead.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const body = m[2];
    if (!selector || selector.startsWith("@")) continue;

    const fs = /font-size:\s*([^;}]+)/.exec(body);
    if (!fs) continue;
    const value = fs[1].trim();

    // Only honoured when the comment is the last thing before the selector.
    const comments = lead.match(/\/\*[\s\S]*?\*\//g);
    if (comments && EXEMPT.test(comments[comments.length - 1])) continue;

    if (NEUTRAL.has(value)) continue;

    const token = /var\(\s*(--text-[a-z0-9]+)\s*\)/.exec(value);
    if (!token) {
      problems.push({ kind: "off-scale", selector, value });
      continue;
    }
    if (!SCALE.includes(token[1])) {
      problems.push({ kind: "unknown-token", selector, value: token[1] });
      continue;
    }
    if (insideMedia(m.index)) continue;
    // A rule that also changes register is making a different KIND of text, so a step of size on
    // top of it is intent rather than accident.
    const changesRegister = /text-transform:\s*uppercase|letter-spacing:/.test(body);
    if (changesRegister) continue;

    for (const part of selector.split(",")) {
      const comp = componentOf(part);
      if (!comp) continue;
      if (!byComponent.has(comp)) byComponent.set(comp, new Map());
      byComponent.get(comp).set(token[1], part.trim());
    }
  }

  // ── The other three scales ──────────────────────────────────────────────────
  for (const fam of FAMILIES) {
    fam.prop.lastIndex = 0;
    let f;
    while ((f = fam.prop.exec(bare)) !== null) {
      // An exemption is the comment immediately before the declaration, read from the real source.
      // The comment must be the last one before this declaration with no rule boundary between
      // them — a selector and its opening brace may sit in between, another rule's `}` may not.
      const lead = css.slice(Math.max(0, f.index - 400), f.index);
      const comments = lead.match(/\/\*[\s\S]*?\*\//g);
      if (comments) {
        const last = comments[comments.length - 1];
        const after = lead.slice(lead.lastIndexOf(last) + last.length);
        if (EXEMPT.test(last) && !after.includes("}")) continue;
      }
      const parts = f[2].trim().split(/\s+/);
      const offenders = parts.filter((v) => !fam.ok(v));
      if (offenders.length > 0) {
        problems.push({
          kind: `off-${fam.name}-scale`,
          selector: `${f[1]}: ${f[2].trim()}`,
          value: `${offenders.join(", ")} — use ${fam.hint}`,
        });
      }
    }
  }

  for (const [comp, used] of byComponent) {
    const idx = [...used.keys()].map((t) => SCALE.indexOf(t)).sort((a, b) => a - b);
    for (let i = 0; i + 1 < idx.length; i += 1) {
      if (idx[i + 1] - idx[i] === 1) {
        problems.push({
          kind: "adjacent-steps",
          selector: `.${comp}*`,
          value: `${SCALE[idx[i]]} beside ${SCALE[idx[i + 1]]} (${used.get(SCALE[idx[i]])} / ${used.get(SCALE[idx[i + 1]])})`,
        });
        break;
      }
    }
  }
  return problems;
}

const EXPLAIN = {
  "off-space-scale": "spacing is not on the 4pt scale",
  "off-radius-scale": "border-radius is not a radius token",
  "off-line-height-scale": "line-height is not a leading token",
  "off-scale": "font-size is not a scale token",
  "unknown-token": "font-size uses a token that is not on the declared scale",
  "adjacent-steps": "one component uses two adjacent scale steps — a difference readers see as a mistake",
};

function report(problems, label) {
  if (problems.length === 0) return true;
  console.error(`\nDESIGN TOKEN SCAN FAILED${label ? ` (${label})` : ""}: ${problems.length} problem(s).\n`);
  for (const p of problems) {
    console.error(`  ${p.selector}`);
    console.error(`    ${EXPLAIN[p.kind]}: ${p.value}`);
  }
  console.error(
    `\nUse one of: ${SCALE.join(", ")} — or \`inherit\`. If the text is inside a drawn graphic and` +
      ` genuinely off any document scale, put /* design-token-exempt: why */ directly above it.\n`,
  );
  return false;
}

if (process.argv.includes("--self-test")) {
  const clean = `
/* A heading in small caps one step under its body text: the ordinary case, and not a defect. */
.theta-block { font-size: var(--text-sm); padding: var(--space-sm) var(--space-md); gap: 0; }
.theta-round { border-radius: var(--radius-md); line-height: var(--lh-snug); margin: 0 auto; }
.theta-icon { line-height: 1; padding-inline: env(safe-area-inset-left); width: 50%; }
/* design-token-exempt: measured against the drawn ring, not the layout scale */
.theta-ring { padding: 7px; }
.theta-block th { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .08em; }
@media (max-width: 40rem) { .theta-block button { font-size: var(--text-base); } }
:root { --text-xs: .75rem; --text-sm: .8125rem; --text-base: .875rem; }
.alpha-one { font-size: var(--text-sm); }
.alpha-two { font-size: var(--text-base); }
.beta { font-size: inherit; }
/* design-token-exempt: caption drawn inside an SVG ring */
.ring-caption { font-size: 7px; }
`;
  const planted = {
    "a raw rem size": `.gamma { font-size: 0.95rem; }`,
    "a raw px size": `.delta { font-size: 15px; }`,
    "a token off the scale": `.epsilon { font-size: var(--text-huge); }`,
    // Two parts of ONE block, which is the real shape of the bug: `.page-purpose-line` at
    // --text-sm beside `.page-purpose-can` at --text-xs.
    "adjacent steps in one component": `.zeta-block-line { font-size: var(--text-xs); }\n.zeta-block-can { font-size: var(--text-sm); }`,
    "an exemption that is not adjacent to the rule": `/* design-token-exempt: stale */\n.eta { color: red; }\n.eta-two { font-size: 0.9rem; }`,
    // THE BUG THAT PROMPTED THIS FILE, verbatim. If a future narrowing lets this through, the scan
    // has stopped doing the one job it was written for.
    "the reported page-purpose bug": `.page-purpose-line { font-size: var(--text-sm); }\n.page-purpose-can { font-size: var(--text-xs); color: grey; }`,
    "off-scale padding": `.iota { padding: 0.35rem 0.6rem; }`,
    "off-scale padding longhand": `.kappa { padding-left: 0.9rem; }`,
    "off-scale gap": `.lambda { gap: 5px; }`,
    "off-scale margin in a shorthand": `.mu { margin: var(--space-sm) 0.75rem; }`,
    "a hand-written radius": `.nu { border-radius: 6px; }`,
    "a hand-written line-height": `.xi { line-height: 1.42; }`,
  };

  let ok = true;
  if (scan(clean).length !== 0) {
    console.error("SELF-TEST FAILED: the clean fixture did not pass.");
    report(scan(clean), "clean fixture");
    ok = false;
  }
  for (const [name, snippet] of Object.entries(planted)) {
    if (scan(clean + "\n" + snippet).length === 0) {
      console.error(`SELF-TEST FAILED: planted violation not caught — ${name}`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
  console.log(
    `SELF-TEST PASSED: clean fixture passes; all ${Object.keys(planted).length} violating fixtures are caught.`,
  );
  process.exit(0);
}

const css = readFileSync(new URL(STYLES, `file://${ROOT}`), "utf8");
const problems = scan(css);
if (!report(problems, STYLES)) process.exit(1);
console.log(
  `DESIGN TOKEN SCAN PASSED: every font-size, spacing, radius and line-height in ${STYLES} is on its declared scale, ` +
    "and no component mixes adjacent type steps.",
);
