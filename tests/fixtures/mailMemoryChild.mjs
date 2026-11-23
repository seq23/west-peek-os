/**
 * Run by tests/mailMemory.test.ts in a child `node --max-old-space-size=128` (a Worker isolate's limit). One request
 * is a message carrying a voice note of argv[2] MB, read the way the door reads it: ONE parse (`readMail`), held until
 * every reader the door uses has read it. Prints `ok <heap MB>`; a heap that runs out ends the process non-zero.
 *
 *   argv[3] = "retained" (with --expose-gc): the request runs inside a function that returns, as a door's request
 *     ends; after three gc() it prints `retained <MB>`, the heap plus ArrayBuffers still held. Nothing of a finished
 *     request may stay in the isolate for the next one (the module-level "last parse" cache removed 22 Nov 2026).
 *   argv[3] = "two": two such requests at once, each with its own words; prints `ok <heap MB>` only when each request
 *     read its own words and its own file, never the other's.
 */
import { readMail, messageText, pdfAttachments, requestAttachments, audioAttachments, unreadableDeckAttachments, topHeadersOf } from "../../src/worker/effects/mail.ts";

const mb = Number(process.argv[2]);
const message = (words, fill) => {
  const audio = Buffer.alloc(mb * 1024 * 1024, fill);
  const b64 = audio.toString("base64").replace(/.{76}/g, "$&\r\n");
  return "From: Example Sender <sender@example.test>\r\nTo: inbox@example.test\r\nSubject: voice note\r\n" +
    'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n' +
    `--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${words}\r\n` +
    '--b1\r\nContent-Type: audio/mp4; name="New Recording 4.m4a"\r\nContent-Disposition: attachment; filename="New Recording 4.m4a"\r\n' +
    "Content-Transfer-Encoding: base64\r\n\r\n" + b64 + "\r\n--b1--\r\n";
};

async function oneRequest(raw, words, fill) {
  const mail = await readMail(raw);
  if (mail.problem) throw new Error(`not parsed: ${mail.problem}`);
  const text = messageText(mail);
  const head = topHeadersOf(mail);
  const pdf = pdfAttachments(mail);
  const deck = unreadableDeckAttachments(mail);
  const files = requestAttachments(mail);
  const audio = audioAttachments(mail);
  const heard = audio.attachments[0];
  if (!heard || Buffer.from(heard.dataBase64.slice(0, 8), "base64")[0] !== fill || heard.bytes < mb * 1024 * 1024 || files.attachments.length !== 1 || text.body.trim() !== words || head?.subject !== "voice note" || pdf.attachments.length || deck.length) {
    throw new Error(`the readers did not read this request's own message (${words})`);
  }
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

if (process.argv[3] === "retained") {
  await oneRequest(message("Please hear the note.", 7), "Please hear the note.", 7);
  for (let i = 0; i < 3; i += 1) { globalThis.gc(); await new Promise((r) => setTimeout(r, 0)); }
  const m = process.memoryUsage();
  console.log(`retained ${Math.round((m.heapUsed + m.arrayBuffers) / 1024 / 1024)}`);
} else if (process.argv[3] === "two") {
  const heaps = await Promise.all([
    oneRequest(message("First sender's words.", 1), "First sender's words.", 1),
    oneRequest(message("Second sender's words.", 2), "Second sender's words.", 2),
  ]);
  console.log(`ok ${Math.max(...heaps)}`);
} else {
  console.log(`ok ${await oneRequest(message("Please hear the note.", 7), "Please hear the note.", 7)}`);
}
