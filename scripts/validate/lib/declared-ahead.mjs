/**
 * declared-ahead.mjs — classes the stylesheet defines BEFORE any page wears them.
 *
 * WHY THIS EXISTS. The Deals section (design/DEALS_SECTION_DESIGN.md §12) is built tokens-first:
 * one branch adds every class the six tabs will need, and five tab branches start from it so they
 * never disagree about a name or a size. That leaves a window in which `styles.css` carries rules
 * nothing emits — and `validate:css-classes` only asks the OPPOSITE question (does every className
 * used have a rule?). A rule aimed at air is exactly how the Home masthead shipped with no heading
 * scale (see heading-scale-applies.mjs), so declaring ahead without a check would reopen that hole
 * for seventy-odd classes at once.
 *
 * THE REGISTER (`design/DEALS_SECTION_CLASSES.json`) closes it from both sides:
 *
 *   1. every registered class has a rule in the stylesheet NOW — "declared ahead" never means
 *      "promised";
 *   2. once every tab that owns a class has landed, something must emit it — a class no page ever
 *      wore is dead and its rule goes;
 *   3. a tab is marked `landed` the moment anything emits one of its classes — the register may
 *      not describe a product that no longer exists.
 *
 * Both validators that read it hard-fail on an empty register, an unknown owner, or a class with
 * no owners: a register that governs nothing is prose, and prose governs nothing.
 */
import { readFileSync } from "node:fs";

export const REGISTER = "design/DEALS_SECTION_CLASSES.json";

/**
 * Parse a register. Returns { tabs, classes, problems }; a non-empty `problems` means the register
 * itself is malformed and no conclusion drawn from it can be trusted.
 */
export function parseRegister(json, where = REGISTER) {
  const problems = [];
  let doc;
  try {
    doc = typeof json === "string" ? JSON.parse(json) : json;
  } catch (e) {
    return { tabs: {}, classes: {}, problems: [`${where}: not JSON — ${e.message}`] };
  }
  const tabs = doc?.tabs && typeof doc.tabs === "object" ? doc.tabs : {};
  const classes = doc?.classes && typeof doc.classes === "object" ? doc.classes : {};
  if (Object.keys(tabs).length === 0) problems.push(`${where}: declares no tabs`);
  if (Object.keys(classes).length === 0) problems.push(`${where}: declares no classes — a register of nothing governs nothing`);
  for (const [tab, t] of Object.entries(tabs)) {
    if (typeof t?.landed !== "boolean") problems.push(`${where}: tab "${tab}" has no boolean \`landed\``);
  }
  for (const [cls, owners] of Object.entries(classes)) {
    if (!Array.isArray(owners) || owners.length === 0) {
      problems.push(`${where}: .${cls} names no owning tab`);
      continue;
    }
    for (const o of owners) if (!(o in tabs)) problems.push(`${where}: .${cls} is owned by "${o}", which is not a tab in the register`);
  }
  return { tabs, classes, problems };
}

export function readRegister(path = REGISTER) {
  return parseRegister(readFileSync(path, "utf8"), path);
}

/** True when every tab that owns `cls` has landed — from then on the class must be emitted. */
export function allOwnersLanded(reg, cls) {
  const owners = reg.classes[cls];
  if (!owners) return true;
  return owners.every((o) => reg.tabs[o]?.landed === true);
}

/** True when no tab that owns `cls` has landed — the class is still allowed to be unworn. */
export function noOwnerLanded(reg, cls) {
  const owners = reg.classes[cls];
  if (!owners) return false;
  return owners.every((o) => reg.tabs[o]?.landed !== true);
}

/** The tabs still to land for `cls`, for a message. */
export function pendingOwners(reg, cls) {
  return (reg.classes[cls] ?? []).filter((o) => reg.tabs[o]?.landed !== true);
}

/**
 * Check a register against what the stylesheet defines and what the client emits.
 *
 * `defined` and `emitted` are Sets of class names. Returns the list of problems, each a sentence a
 * person can act on; an empty list means the register and the product agree.
 */
export function checkRegister(reg, defined, emitted) {
  const problems = [...reg.problems];
  if (problems.length > 0) return problems;
  for (const [cls, owners] of Object.entries(reg.classes)) {
    if (!defined.has(cls)) {
      problems.push(`.${cls} is declared ahead for ${owners.join(", ")} but has NO rule in the stylesheet — declared ahead never means promised`);
      continue;
    }
    const worn = emitted.has(cls);
    if (worn && noOwnerLanded(reg, cls)) {
      problems.push(`.${cls} is emitted by the client, yet the register says none of its owners (${owners.join(", ")}) has landed — mark the tab that emits it \`landed\``);
    } else if (!worn && allOwnersLanded(reg, cls)) {
      problems.push(`.${cls} is worn by nothing although every owner (${owners.join(", ")}) has landed — emit it, or drop the rule and the entry`);
    }
  }
  return problems;
}

/** One line for a PASS message: how much of the register is still awaiting its tab. */
export function registerSummary(reg, emitted) {
  const all = Object.keys(reg.classes);
  const worn = all.filter((c) => emitted.has(c)).length;
  const pendingTabs = Object.entries(reg.tabs).filter(([, t]) => !t.landed).map(([n]) => n);
  return `${all.length} classes declared ahead in ${REGISTER}, ${worn} worn so far; awaiting ${pendingTabs.length === 0 ? "nothing — every tab has landed, the register can go" : pendingTabs.join(", ")}`;
}
