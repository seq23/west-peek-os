// probe-record.mjs — read-only: who can read one conference record, as each partner, and what each firm room holds. Prints states and codes only, never a body.
//   npm run vault:run -- node scripts/meet/probe-record.mjs conferenceRecords/<id>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "../validate/lib/load-ts.mjs";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const g = await loadTs(path.join(ROOT, "src", "worker", "effects", "googleWorkspaceClient.ts"));
const env = { WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON: process.env.WP_OS_GOOGLE_SERVICE_ACCOUNT_JSON ?? process.env.GSC_SERVICE_ACCOUNT_JSON };
const RECORD = process.argv[2];
const subjects = ["sequoia@westpeek.ventures", "scooter@westpeek.ventures"];
for (const subject of subjects) {
  let t;
  try { t = await g.serviceAccountToken(env, [g.SCOPE.meetRead], subject); } catch (e) { console.log(subject, "token", e.code ?? e.message); continue; }
  try { const r = await g.getConferenceRecord(t, RECORD); console.log(subject, "get record OK", r.space, r.startTime, "→", r.endTime ?? "(live)"); 
        try { const ps = await g.listParticipants(t, RECORD); console.log("  participants:", ps.map(p => p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? "?").join(", ")); } catch (e) { console.log("  participants", e.code ?? e.message); }
  } catch (e) { console.log(subject, "get record", e.code ?? e.message); }
  for (const code of ["svf-nzzr-pax", "okf-vjho-uqc"]) {
    try { const rs = await g.listConferenceRecords(t, { meetingCode: code, startedAfter: new Date(Date.now() - 8 * 864e5) }); console.log(`  ${subject} ${code}: ${rs.length} record(s)`, rs.map(r => `${r.name.split("/")[1].slice(0,10)}… ${r.startTime}→${r.endTime ?? "live"}`).join(" | ")); } catch (e) { console.log(`  ${subject} ${code}:`, e.code ?? e.message); }
  }
}
