/**
 * Run by tests/mailMemory.test.ts in a child `node --max-old-space-size=128 --expose-gc` (a Worker isolate has 128 MB).
 * One request is an email of argv[2] MB AS IT ARRIVES (the raw message, attachment base64 included; Email Routing
 * delivers at most 25 MB), carrying one voice note, read the way the door reads it: inside `oneBigMailAtATime`, the
 * message is read, parsed ONCE (`readMail`), every reader the door uses runs on that parse and their lists stay alive,
 * and the voice note is read as base64 once, as the transcriber reads it.
 *
 * MEMORY IS COUNTED HONESTLY: heap AND ArrayBuffers (a parsed file's bytes are an ArrayBuffer, outside the heap that
 * --max-old-space-size limits), over the baseline before any message exists, after gc() and two ticks at each step,
 * so the number is what the request really holds there, not garbage the collector has not reached yet.
 *
 * Prints `ok <peak MB> <held MB>`: the peak over every step, and what one request holds once every reader has run.
 *   argv[3] = "two": two such requests at once, each with its own words and file; `ok <peak MB>` only when each read
 *     its own words and its own file, never the other's.
 *   argv[3] = "retained": after the request ends and three gc(), prints `retained <MB>` (heap plus ArrayBuffers in
 *     all, modules included). Nothing of a finished request may stay in the isolate for the next one.
 */
import {
  audioAttachments,
  messageText,
  oneBigMailAtATime,
  pdfAttachments,
  readMail,
  requestAttachments,
  topHeadersOf,
  unreadableDeckAttachments,
} from "../../src/worker/effects/mail.ts";

const MB = 1024 * 1024;
const rawBytes = Number(process.argv[2]) * MB;
const used = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
globalThis.gc();
const base = used();
let peak = 0;
// Node frees a finished parse's Blob buffers a tick after gc(), so each count lets two ticks pass first.
const settle = async () => {
  for (let i = 0; i < 2; i += 1) {
    globalThis.gc();
    await new Promise((r) => setImmediate(r));
  }
};
const live = async () => {
  await settle();
  peak = Math.max(peak, used() - base);
};
const asMb = (n) => Math.round(n / MB);

const HEAD = (words) =>
  "From: Example Sender <sender@example.test>\r\nTo: inbox@example.test\r\nSubject: voice note\r\n" +
  'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n' +
  `--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${words}\r\n` +
  '--b1\r\nContent-Type: audio/mp4; name="New Recording 4.m4a"\r\nContent-Disposition: attachment; filename="New Recording 4.m4a"\r\n' +
  "Content-Transfer-Encoding: base64\r\n\r\n";
// Base64 in 76-character lines is 78 bytes per 57 bytes of audio: the audio that makes the message rawBytes long.
const audioBytes = (words) => Math.floor(((rawBytes - HEAD(words).length - 12) / 78) * 57);
const message = (words, fill) => HEAD(words) + Buffer.alloc(audioBytes(words), fill).toString("base64").replace(/.{76}/g, "$&\r\n") + "\r\n--b1--\r\n";

function oneRequest(words, fill) {
  return oneBigMailAtATime(rawBytes, async () => {
    const raw = message(words, fill);
    await live();
    const mail = await readMail(raw);
    await live();
    if (mail.problem) throw new Error(`not parsed: ${mail.problem}`);
    const text = messageText(mail);
    const head = topHeadersOf(mail);
    const pdf = pdfAttachments(mail);
    const deck = unreadableDeckAttachments(mail);
    const files = requestAttachments(mail);
    const audio = audioAttachments(mail);
    await live();
    await settle();
    const held = used() - base;
    const heard = audio.attachments[0];
    const b64 = heard?.dataBase64 ?? "";
    await live();
    if (!heard || Buffer.from(b64.slice(0, 8), "base64")[0] !== fill || heard.bytes !== audioBytes(words) || files.attachments.length !== 1 || text.body.trim() !== words || head?.subject !== "voice note" || pdf.attachments.length || deck.length) {
      throw new Error(`the readers did not read this request's own message (${words})`);
    }
    return held;
  });
}

if (process.argv[3] === "retained") {
  await oneRequest("Please hear the note.", 7);
  for (let i = 0; i < 3; i += 1) {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 0));
  }
  console.log(`retained ${asMb(used())}`);
} else if (process.argv[3] === "two") {
  await Promise.all([oneRequest("First sender's words.", 1), oneRequest("Second sender's words.", 2)]);
  console.log(`ok ${asMb(peak)}`);
} else {
  const held = await oneRequest("Please hear the note.", 7);
  console.log(`ok ${asMb(peak)} ${asMb(held)}`);
}
