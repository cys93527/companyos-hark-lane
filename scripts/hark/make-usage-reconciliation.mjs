#!/usr/bin/env node
// Hark lane H12c: the OPERATOR records the real usage of a model call whose charge is UNKNOWN
// (e.g. the app died mid-call), backed by evidence — typically the provider's invoice/usage
// export line for that call. This is the operator's own act; the app never writes it and no
// IPC channel exposes the directory. The app applies it on its next start (after recovery).
//   node make-usage-reconciliation.mjs <budgetDir> <goalRunId> <callId> <tokens> <costMicros> <attestedBy> <evidenceFile> [reconciliationId]
// Writes <budgetDir>/evidence/<sha256> (the evidence bytes) and appends one entry to
// <budgetDir>/reconciliations.json (schema companyos:usage-reconciliation:1). Prints the entry.
// Values come from the command line only, never guessed. The app refuses an entry whose
// usage exceeds the call's trusted admission bound, whose evidence hash does not match, or
// whose call is not UNKNOWN.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [budgetDir, goalRunId, callId, tokensRaw, costRaw, attestedBy, evidenceFile, idArg] = process.argv.slice(2);
const tokens = Number(tokensRaw);
const costMicros = Number(costRaw);
if (!budgetDir || !goalRunId || !callId || !attestedBy || !evidenceFile || !Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(costMicros) || costMicros < 0) {
  console.error('usage: <budgetDir> <goalRunId> <callId> <tokens> <costMicros> <attestedBy> <evidenceFile> [reconciliationId]');
  process.exit(64);
}
const bytes = readFileSync(evidenceFile);
if (bytes.length === 0) { console.error('evidence file is empty'); process.exit(65); }
const hex = createHash('sha256').update(bytes).digest('hex');
mkdirSync(join(budgetDir, 'evidence'), { recursive: true });
writeFileSync(join(budgetDir, 'evidence', hex), bytes);
const file = join(budgetDir, 'reconciliations.json');
const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schema: 'companyos:usage-reconciliation:1', entries: [] };
if (doc.schema !== 'companyos:usage-reconciliation:1' || !Array.isArray(doc.entries)) { console.error('existing reconciliations.json has an unknown schema'); process.exit(66); }
const entry = {
  reconciliationId: idArg ?? `rec-${randomUUID()}`,
  goalRunId, callId, tokens, costMicros, attestedBy,
  attestedAt: new Date().toISOString(),
  evidence: `sha256:${hex}`,
};
if (doc.entries.some((e) => e.reconciliationId === entry.reconciliationId)) { console.error('reconciliationId already used'); process.exit(67); }
doc.entries.push(entry);
writeFileSync(file, JSON.stringify(doc, null, 2));
console.log(JSON.stringify(entry, null, 2));
