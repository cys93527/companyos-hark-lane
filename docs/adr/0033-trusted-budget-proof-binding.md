# ADR-0033 — Trusted budget proof binding in the desktop outer layer

Status: Boss-authorized bounded implementation; independent review pending (2026-10-24).
Related: ADR-0032; planning §五十八 (Security/Approval/Persistence), §五十九 (execution boundaries).

## Decision

Reuse `BudgetReservation.bound.evidenceRef` for a content-addressed proof reference
(`sha256:<digest>`) and the existing Artifact CAS for its immutable bytes. No new budget
table, state, migration, scheduler or settlement authority. Reservation owner/call identities
remain the existing ExecutionAttempt/AgentExecution and physical-network-attempt identities.

`TrustedBudgetProofSource` is an explicitly injected **trusted deployment port**, never a
renderer/Goal field, environment flag, model response or a self-declared `verified: true`.
Its `identify` resolves the actual registered transport and independently verified upstream
model/billing mapping. Its `approved` resolves durable approval/deployment evidence for the
exact digest. Its existing CAS `get` is read-only. `select` may select a newer approved proof
for a NEW request, but is never consulted during settlement. Missing ports/evidence deny.
Production composition rejects TEST_ONLY sources; a TEST_ONLY proof also cannot be read by
a PRODUCTION_VERIFIED source. No production source/price/account credential is supplied here.

The identity includes Provider, request Model and attested upstream identity, endpoint,
routing identity, non-secret credential reference, billing account/optional organization and
identity-attestation reference. No raw credential is accepted or serialized. The Agent path
reads its canonical AgentExecution rather than interpreting a logical model label; actual
endpoint/account verification is the trusted transport resolver's responsibility. The Executor
path additionally checks the selected endpoint/credential reference (or explicit fallback).
Unknown identity refuses admission. The attested identity passed to the selector is frozen.

The bounded proof format records price source/version, currency, units, rounding, separate
input/output bounds and token evidence, start/expiry and scope. Only attested linear input /
output rates in integer currency-micros per million tokens with ceiling on the total per-call
charge are supported. BigInt arithmetic avoids floating-point or overflow under-reservation.
Cached tiers, extra fees, taxes or any other billing structure must not be guessed into this
format. A provider's unqualified `totalCost` is not a currency/account proof.

The opt-in deployment policy ID is a deterministic hash of the configured policy ID, trust
scope, currency and billing scope, persisted in the EXISTING Goal policy field. It is a normal
application policy identity value, not a changed canonical entity-identity rule. It prevents a
second configuration from mixing units/accounts into the same Goal even under concurrent
requests. Old configurations without this feature keep their policy IDs and behavior. A
different proof format/account cannot silently promote legacy reservations.

## Reservation and settlement

1. Resolve actual identity and approved proof; check schema, scope, policy/billing identity,
   hash, expiry, token/output limits and attested worst-case charge before reservation.
2. The unchanged canonical budget authority atomically reserves the bound including its
   immutable CAS reference, owner, run and call ID. No in-memory proof-pin map is used.
3. Settlement re-reads the matching canonical reservation and fetches/verifies THAT proof
   reference. It checks bound limits/cost/expiry identity against those immutable bytes and
   applies the same attested rate version. No latest-price or selector fallback exists.
4. Proof expiry denies new calls, but does not invent a different price for a call already
   admitted under it. Missing/revoked/corrupt proof or missing/invalid usage stays UNKNOWN.
5. Restart uses the persisted reference and existing CAS; RESERVED still becomes UNKNOWN
   under ADR-0032. Reading the original proof does NOT authorize refining UNKNOWN, refunding,
   replaying or claiming remote stop. Canonical settlement conflicts remain conflicts.
6. Proof updates/concurrent callbacks cannot overwrite an older reservation's accounting.
   Duplicate known callbacks go through the original canonical idempotence check. Known
   charges are retained after cancellation/deadline; publishing a late success is still denied.

Proof publication, retention and approval must use the existing approved Artifact/CAS and
deployment/approval mechanisms. This patch introduces no automatic JSON import, proof
publication, proof approval service or second registry. Production provisioning must retain
the old proof bytes/approvals for existing reservations; missing originals never resolve to
the latest quote. Test approvals/selectors are explicitly TEST ONLY files and real local CAS
fixtures, recreated on database/CAS reopen; they are not a real attestation system.

## rationale

The existing durable reference is sufficient to bind complete identity/price bytes without
a Schema or budget-arbitration change. Separating trusted attestation from matching avoids
manufacturing evidence from an endpoint/model label, and immutable references preserve the
accounting basis across updates and restarts.

## alternatives

- Key-only price lookup: rejected; actual upstream/billing identity is not proven by a key.
- Latest-price lookup or process-local pin map: rejected; not stable across update/restart.
- New budget/proof database or new fields: unnecessary for this bounded content-addressed
  reference contract and not authorized.
- Treat recovered UNKNOWN as known merely because the proof is readable: rejected; proof
  identity does not establish actual usage or exactly-once remote execution.

## frozenAreas

Canonical Schema, Goal/Run state machines, ExecutionAttempt arbitration, durable budget
reserve/settle/recover rules, UNKNOWN, cancellation, Guard, DSH approvals and the frozen/E
repositories. Production limits remain 4 calls / 32768 tokens / zero configured cost /
180000ms, with no implicit proof source or Provider activation.

## revisitWhen

After independent delta review and externally verified model/account/price/token evidence,
explicit spending authorization and approved proof provisioning/retention. Unsupported
billing schemes, new account/currency policy or any new persistence/authority requirement
needs a separate decision. Real Provider admission and real Windows DSH sandbox acceptance
are NOT granted by this ADR or by synthetic offline proof tests.
