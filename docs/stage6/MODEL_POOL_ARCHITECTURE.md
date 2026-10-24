# MODEL POOL ARCHITECTURE — Stage 6

Status: FROZEN (Stage 6)  
Date: 2026-10-02

## Architecture

```
Goal → Plan → Task → Required Capabilities
    → Model Selection Policy (deterministic)
    → ModelProfile
    → ExecutorProvider (Embedded DSH)
    → CompanyOS Model Broker (loopback)
    → External Model Provider
    → ExecutionResult → Settlement/Validation
```

**Selection Owner**: COMPANYOS (never DSH, never the kernel, never the model itself).

## ModelProfile Contract

| Field | Type | Description |
|---|---|---|
| modelProfileId | string | Unique identifier |
| providerId | string | Provider adapter identity |
| modelId | string | Model name at the provider |
| displayName | string | Human-readable name |
| endpointURL | string | Upstream provider endpoint |
| credentialRef | string | CompanyOS SecretVault pointer (NEVER a raw key) |
| enabled | boolean | Selection eligibility |
| capabilities | Set\<ModelCapability\> | Selection vocabulary |
| contextWindowTokens | number | Context capacity |
| maxOutputTokens | number | Output ceiling |
| supportsTools | boolean | Tool-calling capability |
| supportsStructuredOutput | boolean | Structured output capability |
| supportsStreaming | boolean | Streaming capability |
| costPerMillionInputTokens? | number | Optional cost metadata |
| costPerMillionOutputTokens? | number | Optional cost metadata |
| configurationVersion | number | Monotonic reproducibility |

## Deterministic Selection V1

**NO LLM-calling-LLM. NO randomness. NO model self-selection.**

Filter order:
1. Pinned profile (deterministic policy override)
2. Capability set match (tool-calling / structured-output / streaming / long-context)
3. Boolean capability match (supportsTools / supportsStructuredOutput)
4. Context window match (minimumContextTokens ≤ contextWindowTokens)
5. Enabled check
6. Deterministic ordering: alphabetical by modelProfileId

Fail-closed error taxonomy:
- `MODEL_POOL_EMPTY` — no enabled profiles
- `MODEL_CAPABILITY_MISMATCH` — no profile satisfies requirements
- `MODEL_PROFILE_UNAVAILABLE` — pinned profile missing or disabled

Selection explanation: `{selectedProfileId, matchedCapabilities, rejectedCandidates, selectionPolicy}` — machine-readable audit, not LLM chain-of-thought.

## Same-Kernel Multi-Model

The embedded DSH kernel executes Attempt A → Profile A, Attempt B → Profile B, Attempt C → Profile C without any canonical architecture change. The Selected Model Snapshot (modelProfileId/providerId/modelId/configurationVersion) is execution evidence on the attempt — not a second truth.

## NOT IMPLEMENTED (Future Backlog)

- Adaptive Smart Router
- Historical success/failure routing
- Token cost learning
- Latency learning
- Model tournaments / voting
- Memory Governor / Context Compaction Governor
