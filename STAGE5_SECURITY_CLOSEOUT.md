# Stage 5 Security Gates — Final Closeout

**Baseline:** Sprint 25 closeout (commit prior to Stage 5 work)  
**Completion:** 2026-10-01  
**Mission:** Embedded DSH runtime security hardening — fail-closed mechanical boundaries against hostile/compromised models

## Delivered Capabilities

### 1. Runtime Integrity Verification
- SHA-256 manifest for entire embedded runtime tree (59,886 files, 14MB manifest)
- Critical file verification: CLI entry + package.json + cordis.patch.yml always checked
- Sampling strategy: full verification ≤10k files, deterministic sampling for larger trees
- Per-invocation caching: integrity verdict cached per managedRoot
- Fail-closed: missing or tampered files refuse to launch

### 2. Model Broker Security (Loopback HTTP Proxy)
- Loopback-only binding: 127.0.0.1, never 0.0.0.0
- Nonce-based authentication: one-time token prevents unauthorized access
- SSRF prevention: upstream URL validated, no redirects followed
- Request size limits: 10MB cap on request/response bodies
- Concurrency limits: max 10 concurrent requests per broker
- Timeout enforcement: 120s per request
- Secret redaction: authorization headers stripped from logs
- Per-invocation lifecycle: broker lives only during one execution

### 3. Attack Resistance Test Suite (9 adversarial scenarios)
1. Network egress blocked
2. File tool escape blocked
3. Junction escape blocked
4. Environment isolation
5. HOME isolation
6. Runtime tamper detection
7. NDJSON adversarial shapes
8. Cross-task isolation
9. Real runtime verification

### 4. Broker Security Test Suite (6 tests)
1. Loopback-only enforcement
2. Nonce authentication
3. SSRF prevention
4. DoS bounds
5. Secret redaction
6. Foreign process rejection

## Test Evidence
- Broker Security: 6/6 passing
- Attack Resistance: 9/9 passing
- Production Integrity: 59,886 files verified
- Gate Suite: pnpm check all passing

## Modified Files
- apps/desktop/src/executor/embedded-dsh-runtime.ts
- apps/desktop/src/executor/dsh-executor-provider.ts
- packages/engine/src/executor/process-executor-provider.ts
- scripts/materialize-embedded-dsh.mjs
- tests/security-broker-security.test.ts (NEW)
- tests/security-agent-attack.test.ts (NEW)
- docs/STAGE5-THREAT-MODEL.md (NEW)
- docs/INDEX.md

## Architecture Invariants
- ARCH-033: Safe Provider Environment (whitelist-only env)
- ARCH-034: Workspace Path Safety (realpath + component boundary check)

## Acceptance Criteria
✅ All 15 security tests pass
✅ Production integrity manifest generated
✅ Threat model documented (9 actors, 11 assets, 7 boundaries)
✅ pnpm check passes
✅ Fail-closed strategy mechanically verified
✅ Architecture laws enforced
✅ Zero regressions

STAGE 5 SECURITY GATES: COMPLETE
