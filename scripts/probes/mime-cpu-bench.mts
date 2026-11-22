/**
 * CPU AND MEMORY OF READING A 26 MB PARTNER REPLY (22 Nov 2026, engineering sweep row 7). Synthetic, same shape as
 * tests/bigPartnerMail (his words, a voice note, a zip, a PDF). It prints, for the hand-built parser
 * (src/worker/effects/mimeAttachments.ts), CPU ms per call, the SUM over one handler's calls, and the memory held
 * after one read (largest single read). When postal-mime is given, it prints the same for the library's one full parse.
 *
 *   npx -y tsx@4 --expose-gc scripts/probes/mime-cpu-bench.mts   # tsx is not a dev dependency: npx fetches it once
 *   npm i --prefix "$TMPDIR/pm" postal-mime@4.2.0     # the library goes in a scratch folder, never this repo's node_modules
 *   POSTAL_MIME="$TMPDIR/pm/node_modules/postal-mime/dist/esm/postal-mime.js" npx -y tsx@4 --expose-gc scripts/probes/mime-cpu-bench.mts
 *
 * Production CPU is 30 s (wrangler.toml); the 128 MB isolate memory is the limit that decides. Run it before any
 * change that would swap the parser.
 */
const m = await import("../../src/worker/effects/mimeAttachments.ts");
const total = (25 * 1024 * 1024) / 0.73;
const b64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString("base64").replace(/(.{76})/g, "$1\r\n");
const B = "Apple-Mail=_BIG_TEST";
const part = (type: string, name: string, share: number, fill: number) => [`--${B}`, `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", b64(Math.floor(total * share * 0.75), fill)];
const raw = [
  "From: Test <t@example.com>", "To: os@example.com", "Subject: =?UTF-8?Q?Re:_big_=E2=80=94_reply?=", "Message-ID: <x@y>", "MIME-Version: 1.0",
  `Content-Type: multipart/mixed;\r\n boundary="${B}"`, "",
  `--${B}`, "Content-Type: text/plain; charset=UTF-8", "", "words here #wpdeck", "",
  ...part("audio/x-m4a", "New Recording 4.m4a", 0.53, 7), ...part("application/zip", "files.zip", 0.15, 8), ...part("application/pdf", "deck.pdf", 0.05, 9),
  `--${B}--`, "",
].join("\r\n");

let summed = 0;
async function cpu(name: string, f: () => unknown, sum = false): Promise<void> {
  await f(); // warm
  const t0 = process.cpuUsage();
  for (let i = 0; i < 3; i++) await f();
  const u = process.cpuUsage(t0);
  const ms = (u.user + u.system) / 3000;
  if (sum) summed += ms;
  console.log(`${name.padEnd(28)} ${ms.toFixed(1)} ms`);
}
/**
 * MEMORY HELD after one read, in a fresh child process with GC (run with --expose-gc): heap + ArrayBuffers beyond
 * the message already in memory. Max RSS was tried and is too noisy on Node to compare (±35 MB run to run).
 */
const MEM = process.argv.find((a) => a.startsWith("--mem="))?.slice(6);
if (MEM) {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error("run with --expose-gc");
  const held = () => { gc(); gc(); const u = process.memoryUsage(); return u.heapUsed + u.arrayBuffers; };
  const before = held();
  let max = 0;
  const reads: Array<() => unknown> =
    MEM === "hand-built" ? [() => m.textBodyOf(raw), () => m.messageText(raw), () => m.pdfAttachments(raw), () => m.requestAttachments(raw), () => m.audioAttachments(raw), () => m.attachmentBytes(raw, "files.zip")]
    : [async () => (await import(process.env.POSTAL_MIME ?? "postal-mime")).default.parse(raw, MEM === "postal-mime-base64" ? { attachmentEncoding: "base64" } : {})];
  for (const f of reads) {
    const kept = await f();
    max = Math.max(max, held() - before);
    if (kept === Symbol.for("never")) console.log("");
  }
  console.log((max / 1048576).toFixed(0));
  process.exit(0);
}
async function memory(name: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const mb = execFileSync(process.execPath, [...process.execArgv, process.argv[1]!, `--mem=${name}`], { encoding: "utf8" }).trim().split("\n").pop();
  console.log(`${`${name}, held`.padEnd(28)} ${mb} MB beyond the message (largest single read, after GC)`);
}

console.log(`message ${(raw.length / 1048576).toFixed(1)} MB`);
await cpu("textBodyOf", () => m.textBodyOf(raw), true);
await cpu("messageText", () => m.messageText(raw), true);
await cpu("pdfAttachments", () => m.pdfAttachments(raw), true);
await cpu("requestAttachments", () => m.requestAttachments(raw), true);
await cpu("audioAttachments", () => m.audioAttachments(raw), true);
await cpu("attachmentBytes(zip)", () => m.attachmentBytes(raw, "files.zip"), true);
console.log(`${"hand-built, summed".padEnd(28)} ${summed.toFixed(1)} ms (one handler's calls on the same message)`);
await memory("hand-built");
const lib = await import(process.env.POSTAL_MIME ?? "postal-mime").catch(() => null);
if (!lib) console.log("postal-mime not installed: skipped");
else {
  await cpu("postal-mime (ArrayBuffer)", () => lib.default.parse(raw));
  await cpu("postal-mime (base64)", () => lib.default.parse(raw, { attachmentEncoding: "base64" }));
  await memory("postal-mime");
  await memory("postal-mime-base64");
}
