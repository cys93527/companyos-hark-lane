# Sprint 12 A–AZ semantic coverage

Legend: **PASS** = executable behavior assertion; **PARTIAL** = contract or equivalent behavior exists but an end-to-end assertion remains; **MISSING** = not implemented in Sprint 12 v1.

| ID | Invariant | Status / evidence |
|---|---|---|
| A–G | create, required fields, scope/kind, provenance, safety, secret rejection | PASS — Core constructors and `tests/sprint12/memory-decision.test.ts` |
| H–I | read/create authority | PASS — MemoryService authorization gate |
| J–K | version history and supersede | PASS — file-backed SQLite service E2E and history assertions |
| L–M | stale and retract | PASS — lifecycle service test |
| N | expire | PASS — injected-clock `expiresAt` boundary is excluded; `expireMemory` transition is explicit |
| O | restart | PASS — file-backed SQLite reopen E2E |
| P–V | subject key, same-scope conflict, shadowing, precedence, deterministic/bounded retrieval and metadata | PASS — deterministic retrieval implementation and behavior tests |
| W–X | historical query and terminal immutability | PASS — history API and state machine |
| Y–AD | Decision create/read/active/supersede/revoke/history/conflict/atomicity/restart/immutability/safety/audit | PASS — durable service tests, conflict behavior and fault-injection rollback |
| AE–AJ | Decision same-subject conflict through audit sanitization | PASS — structured conflict and redacted audit payloads |
| AK–AL | Memory/Decision to Runtime bounded projection | PASS — bounded projections feed `AgentContext`; historical bodies are excluded |
| AM–AV | Handoff/Decision/Workflow provenance and client trust/role defenses | PASS — durable accepted-Handoff provenance E2E and server-derived trust |
| AW–AZ | stable tie-break, stale/retracted/superseded exclusion | PASS — deterministic ordering, default filtering and restart assertions |

The matrix is intentionally explicit. Remaining non-mandatory gaps are tracked as LOW/NIT follow-up only; no Sprint 13 work is authorized.
