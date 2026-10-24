# V1 STANDARD EXECUTION SECURITY MODEL

Status: FROZEN (Stage 5E)  
Date: 2026-10-02  
Replaces: All prior "Production Security Certified" / "Host Network Blocked" / "Full Sandbox" claims

## 1. Threat Model

**STANDARD_TRUSTED_WORKSPACE_EXECUTION**

V1 operates on workspaces the user chose or created. The model operates under CompanyOS Authority. V1 does NOT claim hostile-workload sandbox, malicious-model absolute containment, zero network exfiltration, or zero host file read escape. Those are in HARDENED_EXECUTION_BACKLOG.

## 2. What V1 Guarantees (HARD REQUIREMENTS)

### A. CompanyOS Authority
CompanyOS is the sole Authority for Task, Role, Workspace, Approval, Capability, Artifact, Validation, and Outcome. Windows identities are OS enforcement identities, not Authority truths.

### B. Model cannot self-escalate
Model cannot expand Tool, Workspace, Approval, Capability, or Authority without CompanyOS explicit provisioning.

### C. Secret Isolation
Model API credentials NEVER enter DSH child env, Tool Process env, Artifact, or Log.

### D. Model Broker Security
Maintains Stage 5B verified properties: loopback binding, nonce authentication, attempt binding, replay rejection, foreign-process rejection, secret redaction.

### E. Runtime Integrity
FULL_EXECUTION_CLOSURE_VERIFIED. Critical sampling: NO. No regression permitted.

### F. Structured File Tool Boundary
CompanyOS structured file tool (read/write/edit/list) enforces workspace scope: canonical path resolution, realpath/reparse defense-in-depth, outside path deny. This is the STRUCTURED_TOOL_BOUNDARY — distinct from GENERAL_PROCESS_TRUST_BOUNDARY.

### G. Process Launch
Fixed executable, literal argv, shell:false launcher boundary, controlled cwd, env allowlist, bounded stdout/stderr, timeout, cancel.

### H. Process Tree Lifecycle
All descendant processes (child, grandchild, background) are terminated via Job Object KILL_ON_JOB_CLOSE on cancel/timeout. Windows Standard Execution includes this as baseline.

### I. Audit Evidence
Every tool call carries: attempt identity, task identity, tool identity, input metadata, result, error classification, timing.

### J. High-Risk Actions
Destructive or external actions go through Authority / Approval. DSH does not self-authorize.

## 3. What V1 Does NOT Guarantee (Standard Mode Boundaries)

| Boundary | Status in Standard Mode |
|---|---|
| HOST_READ_ISOLATION | NOT GUARANTEED AGAINST HOSTILE SHELL |
| HOST_NETWORK_ISOLATION | NOT GUARANTEED AGAINST HOSTILE SHELL |
| STRUCTURED_TOOL_BOUNDARY | ENFORCED (CompanyOS file tool path) |
| GENERAL_PROCESS_TRUST_BOUNDARY | NOT PROVIDED IN STANDARD MODE |

**Prohibited claims** (enforced by architecture tests):
- "SANDBOXED" / "FULLY ISOLATED" / "ZERO NETWORK" / "HOST ESCAPE IMPOSSIBLE"

## 4. Network Semantics

| Term | Meaning |
|---|---|
| EXPLICIT_NETWORK_TOOL: DENIED | CompanyOS did not grant a Network Tool to this task |
| HOST_NETWORK_ISOLATION: NOT GUARANTEED | General shell/process may reach the network |

"Network Tool not mounted" ≠ "Network blocked" when the same task has shell/process access.

## 5. Untrusted Input
V1 does not execute hostile workloads. External repos, downloaded code, internet-induced commands are outside the V1 hostile-isolation guarantee. If needed in the future → HARDENED_EXECUTION_BACKLOG.

## 6. Execution Profile

**STANDARD_TRUSTED_WORKSPACE** — projection of existing CompanyOS Authority onto one attempt.

Minimum fields: workspaceId, taskId, attemptId, allowedTools, environmentPolicy, processPolicy, approvalPolicy, networkToolPolicy, trustClassification.

This is NOT a second Task Truth or second Authority Truth — it is a derived projection.

## 7. Hardened Execution Backlog

Status: NOT_IMPLEMENTED / NOT_AVAILABLE

Stage 5B/5C/5D/5D-B research evidence:
- AppContainer: isolation strong, toolchain incompatible (Node crashes, msys Git /dev/null)
- Dedicated Identity: toolchain compatible, host default-read ACL insufficient (Authenticated Users RX inherited)
- Restricting SID composition: CreateProcessWithTokenW err=5 on Win11 22631 (synthetic S-1-4 rejected)
- DNS identity isolation: DNS Client Service (SYSTEM) bypasses per-identity firewall

Candidate mechanisms (not selected): WSL2, Hyper-V, VM, Container, WFP. All in backlog — no current selection.

## 8. Role Principle (Product Canon)

User provides: Idea / Goal.
CompanyOS automatically: understands goal → generates Plan → decomposes → analyzes required Professional Responsibility → determines Role per work item → matches Capabilities, Model, Tools, Authority.

Role ≠ Model. Role = Professional Responsibility. Model = Execution Intelligence Provider. Same Role can use different Models. Model switch does not change Role responsibility.

Role ≠ Fixed Agent. Role Instances appear dynamically per work item and may end after completion. CompanyOS does not maintain a fixed "Agent 1 / Agent 2 / Agent 3" list.

Role Catalog is a directory of available professional capabilities. AI workers are dynamically organized by CompanyOS. Simple projects may use Engineer → Reviewer. Complex projects may form a full team (PM / Architect / Researcher / Engineer / Test Engineer / Security Engineer / Reviewer / QA).

Implementation: Stage 7 (Automatic Role Resolution). Stage 5E freezes the principles only.
