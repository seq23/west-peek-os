/**
 * strip-comments.mjs — the one answer to "is this line code, or is it prose about code?"
 *
 * WHY THIS EXISTS. 18 Sep 2026: `validate:css-classes` failed a branch because
 * `DeliverableDocument.tsx` mentioned `.deliverable-body` **in a comment explaining that the class
 * had been removed**. The rule the scan enforces is real and useful — a misspelt class is the one
 * front-end mistake with no symptom, the element renders unstyled forever — but the block was
 * nonsense: the change was correct and the validator refused it for describing itself.
 *
 * The owner, on the whole family of these: "get rid of petty blocking and useless ones that do not
 * create meaningful blocking."
 *
 * THE MEASUREMENT THAT DECIDED WHAT TO DO. Every validator was timed. Thirty-nine of forty finish
 * in under 1.5 seconds and the whole gate costs about eight seconds, so the validators are not what
 * makes CI slow and deleting them buys nothing. What they cost is FALSE BLOCKS — and 25 of the 40
 * already stripped comments while 12 did not, each with its own copy or none at all. The tax was
 * never the number of validators; it was that half of them could be fooled by a sentence.
 *
 * So the simplification is this file: one implementation, applied everywhere a validator reads
 * source, and a guard that fails when a new scanner forgets it. A rule that only fires on behaviour
 * is one nobody learns to work around — and a validator people route around is worse than none,
 * because it still costs a run and no longer means anything.
 *
 * WHITESPACE IS PRESERVED, NEWLINES INCLUDED. Comment bodies become spaces rather than vanishing,
 * so every byte offset and line number in the stripped text still matches the original file. A
 * scanner that reports "line 412" must be pointing at line 412 of what a person opens.
 */

/** `/* … *\/` — CSS, and the block form in TS/JS. */
const BLOCK = /\/\*[\s\S]*?\*\//g;

const blank = (m) => m.replace(/[^\n]/g, " ");

/** CSS has no line comments. Treating `//` as one would eat the back half of a `url(//host)`. */
export function stripCssComments(css) {
  return String(css ?? "").replace(BLOCK, blank);
}

/**
 * TypeScript, JavaScript and TSX, scanned one character at a time.
 *
 * A REGEX IS NOT ENOUGH, and the first version of this proved it. `(^|[^:"'`\\])\/\/[^\n]*`
 * looks careful — it refuses to fire after a colon, a quote or a backslash — and it still ate the
 * tail of `'https://x.dev//y'`, because the character before the SECOND `//` is `v`. A validator
 * that silently examines less source than it claims is the inert-guard failure this repo has
 * shipped three times in a week, so the conservative-looking regex was the dangerous option.
 *
 * This tracks the only states that matter: single quotes, double quotes, template literals
 * (including `${…}` interpolation, which can itself contain strings and comments), and both
 * comment forms. Escapes are honoured. Whitespace and newlines are preserved byte for byte, so a
 * scanner reporting "line 412" still points at line 412 of the file a person opens.
 *
 * Regex literals are deliberately NOT tracked. Telling `/` division from `/` regex needs real
 * parsing, and the failure mode of getting it wrong is stripping live code. A `//` inside a regex
 * literal is rare, and treating it as a comment only ever removes MORE from the text being scanned
 * — it can cause a missed finding, never a false block, and a missed finding is caught by the
 * hard-fail-on-zero rule every validator here already carries.
 */
export function stripTsComments(source) {
  const src = String(source ?? "");
  let out = "";
  let i = 0;
  // Stack so a template literal's `${…}` can nest strings and comments inside it.
  const stack = [];
  const top = () => stack[stack.length - 1];

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    const state = top();

    if (state === "'" || state === '"') {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (ch === state) stack.pop();
      out += ch; i += 1; continue;
    }

    if (state === "`") {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (ch === "$" && next === "{") { stack.push("${"); out += "${"; i += 2; continue; }
      if (ch === "`") { stack.pop(); out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }

    // Code, or inside a `${…}` where code rules apply again.
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop; continue;
    }
    if (ch === "/" && next === "/") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      out += blank(src.slice(i, end));
      i = end; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { stack.push(ch); out += ch; i += 1; continue; }
    if (ch === "}" && state === "${") { stack.pop(); out += ch; i += 1; continue; }

    out += ch; i += 1;
  }
  return out;
}


/**
 * SQL — `--` to end of line, and the same `/* … *\/` blocks.
 *
 * Migrations in this repo are heavily commented by design: every one explains the defect it closes
 * and quotes the owner. That prose names tables, columns and enum values constantly, which is
 * exactly what a schema scan looks for — so a migration explaining a kind it is REMOVING can make a
 * scan believe the kind is still there. Strings are respected so a `--` inside a quoted default or
 * a seeded sentence is not mistaken for a comment.
 */
export function stripSqlComments(sql) {
  const src = String(sql ?? "");
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      // SQL escapes a quote by doubling it.
      if (ch === "'" && next === "'") { out += "''"; i += 2; continue; }
      if (ch === "'") inString = false;
      out += ch; i += 1; continue;
    }
    if (ch === "'") { inString = true; out += ch; i += 1; continue; }
    if (ch === "-" && next === "-") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = src.length;
      out += blank(src.slice(i, end));
      i = end; continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/** Pick by extension, so a caller reading a mixed file list does not have to think about it. */
export function stripCommentsFor(path, source) {
  if (/\.css$/i.test(path)) return stripCssComments(source);
  if (/\.sql$/i.test(path)) return stripSqlComments(source);
  return stripTsComments(source);
}
