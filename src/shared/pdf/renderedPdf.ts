/**
 * IS THIS A RENDERED PDF, or HTML wearing a PDF's name? (22 Oct 2026)
 *
 * The TLC topics email went out with each one-sheet attached as the page's raw HTML source, and the
 * owner opened three files full of code instead of the designed page. A file that leaves this system
 * as a "one-sheet" is checked here first: it must start like a PDF, none of its streams (inflated)
 * may carry HTML source, and its title must name what it is about. Pure, so the worker and the tests
 * run the same check. Every caller that attaches an HTML-derived PDF goes through it.
 */

const HTML_MARKERS = ["<!doctype", "<html", "<head", "<body", "<div", "<style", "style=", "</p>", "<meta"] as const;

const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

async function inflate(bytes: Uint8Array): Promise<string | null> {
  try {
    const ds = new DecompressionStream("deflate");
    const out = new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(ds));
    return latin1(new Uint8Array(await out.arrayBuffer()));
  } catch {
    return null;
  }
}

/** Every stream's text, inflated where it is Flate-encoded, plus the raw file. */
async function pdfTexts(bytes: Uint8Array): Promise<string[]> {
  const raw = latin1(bytes);
  const texts = [raw];
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,2000})>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    if (/\/FlateDecode/.test(m[1]!)) {
      let stop = end;
      while (stop > start && (bytes[stop - 1] === 0x0a || bytes[stop - 1] === 0x0d)) stop--;
      const t = (await inflate(bytes.subarray(start, stop))) ?? (await inflate(bytes.subarray(start, end)));
      if (t) texts.push(t);
    }
    re.lastIndex = end;
  }
  return texts;
}

/** The document title from the Info dictionary: a literal `(…)` or UTF-16BE hex `<FEFF…>`. */
export function pdfTitle(bytes: Uint8Array): string | null {
  const raw = latin1(bytes);
  const hex = raw.match(/\/Title\s*<([0-9A-Fa-f\s]+)>/);
  if (hex) {
    const h = hex[1]!.replace(/\s+/g, "");
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return b[0] === 0xfe && b[1] === 0xff ? new TextDecoder("utf-16be").decode(b.subarray(2)) : latin1(b);
  }
  const lit = raw.match(/\/Title\s*\(((?:\\.|[^\\)])*)\)/);
  return lit ? lit[1]!.replace(/\\(.)/g, "$1") : null;
}

/** null when the bytes are a rendered PDF about `mustName`; otherwise the reason, in a sentence. */
export async function renderedPdfProblem(bytes: Uint8Array, mustName: string): Promise<string | null> {
  if (latin1(bytes.subarray(0, 5)) !== "%PDF-") return "the file is not a PDF";
  for (const t of await pdfTexts(bytes)) {
    const lower = t.toLowerCase();
    const hit = HTML_MARKERS.find((k) => lower.includes(k));
    if (hit) return `the PDF carries HTML source code (${hit}), not the rendered page`;
  }
  const title = pdfTitle(bytes);
  if (!title || !title.toLowerCase().includes(mustName.toLowerCase())) return `the PDF does not name "${mustName}" (title: ${title ?? "none"})`;
  return null;
}
