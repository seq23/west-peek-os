/**
 * CPU OF READING A 25 MB PARTNER REPLY (22 Nov 2026, engineering sweep row 7). Synthetic, same shape as
 * tests/bigPartnerMail (his words, a voice note, a zip, a PDF). Prints CPU ms per call for the hand-built parser
 * (src/worker/effects/mimeAttachments.ts) and, when it is installed, for postal-mime's one full parse.
 *
 *   npx tsx scripts/probes/mime-cpu-bench.mts
 *   npm i --no-save postal-mime@4.2.0 && npx tsx scripts/probes/mime-cpu-bench.mts   # with the library
 *
 * Run it before any change that would swap the parser: the Worker's email handler died at ~2,010 ms of CPU.
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

async function cpu(name: string, f: () => unknown): Promise<void> {
  await f(); // warm
  const t0 = process.cpuUsage();
  for (let i = 0; i < 3; i++) await f();
  const u = process.cpuUsage(t0);
  console.log(`${name.padEnd(28)} ${((u.user + u.system) / 3000).toFixed(1)} ms`);
}

console.log(`message ${(raw.length / 1048576).toFixed(1)} MB`);
await cpu("textBodyOf", () => m.textBodyOf(raw));
await cpu("messageText", () => m.messageText(raw));
await cpu("pdfAttachments", () => m.pdfAttachments(raw));
await cpu("requestAttachments", () => m.requestAttachments(raw));
await cpu("audioAttachments", () => m.audioAttachments(raw));
await cpu("attachmentBytes(zip)", () => m.attachmentBytes(raw, "files.zip"));
const lib = await import("postal-mime" as string).catch(() => null);
if (!lib) console.log("postal-mime not installed: skipped");
else {
  await cpu("postal-mime (ArrayBuffer)", () => lib.default.parse(raw));
  await cpu("postal-mime (base64)", () => lib.default.parse(raw, { attachmentEncoding: "base64" }));
}
