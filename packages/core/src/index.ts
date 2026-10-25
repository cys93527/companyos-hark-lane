/**
 * @companyos/core — the industry-agnostic domain kernel of CompanyOS.
 *
 * HARD RULE (docs/CORE_BOUNDARIES.md, ADR-0002): nothing in this package may
 * name or import a vertical concept (coding, version control, developer roles,
 * publishing, media, commerce). Those live in `@companyos/pack-*`.
 * ZERO runtime dependencies (ADR-0005): `packages/core/package.json` has no
 * `dependencies` block at all, and the boundary gate enforces it.
 */

/* ------------------------------------------------------------------ kernel */
export {
  ERROR_CODES,
  DomainError,
  LifecycleError,
  PackManifestError,
  NotImplementedError,
  domainError,
} from './kernel/errors.js';
export type { ErrorCode, DomainErrorOptions } from './kernel/errors.js';

export {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  mapResult,
  mapError,
  allResults,
} from './kernel/result.js';
export type { Ok, Err, Result } from './kernel/result.js';

export { UlidFactory, SequenceIdFactory, isUlid, ULID_LENGTH_CONST } from './kernel/ids.js';

export {
  canonicalJson,
  sha256Hex,
  sha256Ref,
  isSha256Ref,
  parseSha256Ref,
  SHA256_REF_PATTERN,
  contentHash,
  shortHash,
} from './kernel/hash.js';
export type { JsonValue } from './kernel/hash.js';

export { defineEvent, InMemoryEventBus } from './kernel/events.js';
export type { DomainEvent, EventEnvelopeInit } from './kernel/events.js';

/* ------------------------------------------------------------------- ports */
export { SystemClock, FixedClock } from './ports/clock.js';
export type { Clock } from './ports/clock.js';

export { ID_PREFIX } from './ports/id-factory.js';
export type { IdFactory, IdPrefix } from './ports/id-factory.js';

export { MemoryLogger, nullLogger } from './ports/logger.js';
export type { Logger, LogLevel, LogFields } from './ports/logger.js';

export type {
  EntityId,
  EntityStore,
  UnitOfWork,
  Page,
  PageRequest,
  MigrationRunner,
  MigrationInfo,
  MigrationReport,
} from './ports/store.js';
export type { CommandLedgerPort, CommandLedgerRecord } from './ports/command-ledger.js';

/* ------------------------------------------- model providers (Sprint 6) ------- */
export { DEFAULT_MODEL_CAPABILITIES, PROVIDER_ERROR_KINDS } from './ports/model-provider.js';
export type {
  FinishReason,
  HealthReport,
  HealthStatus,
  InvocationRequest,
  InvocationResult,
  MessageRole,
  ModelCapabilities,
  ModelInfo,
  ModelPricing,
  ModelProviderPort,
  ModelProviderDescriptor,
  NormalizedProviderError,
  PartialModelCapabilities,
  ProviderErrorKind,
  ProviderMessage,
  ProviderModelRecord,
  ProviderRegistration,
  ProviderRegistryPort,
  ProviderSelection,
  RawModelInfo,
  StreamChunk,
  StructuredOutputContract,
  TokenUsage,
  ToolCall,
  ToolDeclaration,
} from './ports/model-provider.js';
export { SECRET_SOURCES } from './ports/secrets.js';
export {
  FAULT_CHECKPOINTS,
  FaultCrashError,
  faultCheckpointRefused,
  type FaultCheckpointKey,
  type FaultCheckpointName,
  type FaultCheckpointPort,
} from './ports/fault-checkpoint.js';
export type { SecretRef, SecretRefResolverPort, SecretSource } from './ports/secrets.js';
export {
  ERROR_CODE_BY_KIND,
  REDACTED,
  RETRYABLE_KINDS,
  assertNoSecrets,
  containsSecret,
  normalizeProviderError,
  providerErrorToDomainError,
  redactSecrets,
  redactValue,
} from './domain/provider-error.js';
export {
  AUTHORITIES,
  AUTHORITY_PATTERN,
  assignmentId,
  authoritiesOfActor,
  decideAuthority,
  effectiveAuthorities,
  isAuthority,
  rolesOfActor,
  validateRoleAuthorities,
} from './domain/role-authority.js';
export type { Authority, AuthorityDecisionInput, RoleAssignment } from './domain/role-authority.js';

/* ------------------------------------------ model registry (Sprint 7) --------- */
export {
  ALIAS_PATTERN,
  MODEL_AVAILABILITY,
  MODEL_KEY_PATTERN,
  aliasConflict,
  aliasId,
  availabilityOf,
  bindAlias,
  capabilityProfileOf,
  createModelRecord,
  isAliasName,
  isModelKey,
  modelRecordFromProviderModel,
  normalizeAlias,
  normalizeModelKey,
  resolveAlias,
  setModelEnabled,
} from './domain/model-registry.js';
export type {
  CreateModelRecordInput,
  LogicalAlias,
  ModelAvailability,
  ModelCapabilityProfile,
  ModelRecord,
} from './domain/model-registry.js';
export {
  TOKEN_RATIO,
  assertWithinContextWindow,
  estimateContext,
  estimateText,
} from './domain/context-estimate.js';
export type { ContextBreakdown, ContextEstimate } from './domain/context-estimate.js';

/* ------------------------------- model selection policy + benchmark (Sprint 7.5) -- */
export {
  AUTO_POLICY_STATEMENT,
  FALLBACK_MODES,
  POLICY_SCOPE_TYPES,
  PRECEDENCE_LADDER,
  SCOPE_SPECIFICITY,
  SELECTION_CAPABILITIES,
  SELECTION_MODES,
  createPolicy,
  describeAutoPolicy,
  evaluateManualSelection,
  hybridCandidates,
  isSelectionCapability,
  policyId,
  precedenceLevelOf,
  resolvePolicy,
  rulesExcludeCandidate,
  selectionRulesFromPolicy,
  evaluateCandidateAgainstSelectionRules,
  isCandidateAdmissible,
  EXCLUSION_TO_MANUAL_REFUSAL,
  SELECTION_EXCLUSION_CODES,
} from './domain/model-selection-policy.js';
export type {
  AutoContractView,
  FallbackMode,
  HybridCandidateSet,
  ManualEvaluationInput,
  ManualRefusal,
  ManualSelectionVerdict,
  PolicyDraft,
  PolicyScopeRef,
  PolicyScopeType,
  PrecedenceLevel,
  SelectionCapability,
  SelectionMode,
  SelectionRules,
  SelectionExclusion,
  SelectionExclusionCode,
  SelectionContext,
  ModelSelectionPolicy,
} from './domain/model-selection-policy.js';
export {
  BENCHMARK_CATEGORIES,
  PERFORMANCE_METADATA_PURPOSE,
  isBenchmarkCategory,
  summarizePerformance,
  validateBenchmarkResult,
} from './domain/benchmark.js';
export type {
  BenchmarkCase,
  BenchmarkCategory,
  BenchmarkExpectation,
  BenchmarkResult,
  BenchmarkSuite,
  ModelPerformanceMetadata,
} from './domain/benchmark.js';

/* ------------------------------------------------- agent runtime (Sprint 8) ------ */
export {
  AGENT_EXECUTION_STATES,
  EMPTY_USAGE,
  EXECUTION_ERROR_CODES,
  EXECUTION_ERROR_KINDS,
  RETRYABLE_EXECUTION_KINDS,
  TERMINAL_EXECUTION_STATES,
  canTransitionExecution,
  createExecution,
  executionErrorToDomainError,
  isTerminalStatus,
  markCancelled,
  markCompleted,
  markFailed,
  markInterrupted,
  markReady,
  markRunning,
  markWaitingExternal,
  needsRecovery,
  normalizeExecutionError,
} from './domain/agent-execution.js';
export type {
  AgentExecution,
  AgentExecutionStatus,
  CompleteExecutionInput,
  CreateExecutionInput,
  ExecutionError,
  ExecutionErrorKind,
  ExecutionUsage,
  ModelBinding,
} from './domain/agent-execution.js';
export { CONTEXT_LIMITS, buildAgentContext, contextSummary } from './domain/agent-context.js';
export type {
  AgentContext,
  BuildAgentContextInput,
  ContextReference,
} from './domain/agent-context.js';
export {
  PROMPT_TEMPLATE_VERSION,
  assemblePrompt,
  canonicalPromptBody,
  cloneJsonValue,
  deepFreezeJson,
  stableHash,
  toMessages,
} from './domain/prompt-assembly.js';
export type {
  PromptAssemblyInput,
  PromptMessages,
  PromptPlan,
  PromptToolDescriptor,
} from './domain/prompt-assembly.js';

/* --------------------------------------------- model router contract (Sprint 10A) -- */
export {
  BENCHMARK_WEIGHT_CAP,
  HARD_FILTER_EMITTED_REASONS,
  HISTORICAL_MIN_SAMPLE,
  LATENCY_FILTER_MODE,
  MODEL_DIVERSITY_CONSTRAINTS,
  RANKING_HARD_CONSTRAINTS,
  REASON_CODE_PRODUCERS,
  ROUTER_DECISIONS,
  ROUTER_HARD_FILTER_STAGES,
  ROUTER_PIPELINE,
  ROUTER_POSITIVE_REASONS,
  ROUTER_PRESENTATION_STAGES,
  ROUTER_REASON_PRODUCERS,
  ROUTER_REJECTION_REASONS,
  ROUTER_RISK_CONSTRAINT_HOOKS,
  ROUTER_VERSION,
  ROUTER_POLICY_VIEW_ORIGIN,
  ROUTER_V1_RANKING,
  ROUTER_V1_WEIGHTS,
  TIE_BREAK_KEYS,
  V1_NOT_RANKED_MARKER,
  V1_NOT_RANKED_SIGNALS,
  applyHardFilters,
  applyHumanOverride,
  assertDerivedPolicyView,
  assertRankingInput,
  assertRouterRequestAllowed,
  checkDiversity,
  compareTieBreak,
  contentDigestOf,
  SELECTION_EXCLUSION_TO_ROUTER_REASON,
  validateRouterPolicyViewShape,
  decideFallback,
  deriveRouterPolicyView,
  effectiveBenchmarkWeight,
  manualOutcome,
  noCandidateOutcome,
  overrideRecord,
  reasonProducerOf,
  routerAppliesTo,
  routerUnavailableOutcome,
  routerV1Policy,
  sampleConfidence,
  tieBreakContract,
  validateRecommendation,
} from './domain/model-router.js';
export type {
  BenchmarkReference,
  CandidateEvaluation,
  DiversityContext,
  FallbackAction,
  FallbackDecision,
  HardFilterOutcome,
  HistoricalPerformanceSnapshot,
  HumanOverrideInput,
  HumanOverrideOutcome,
  ModelDiversityConstraint,
  ModelRecommendation,
  OverrideRecord,
  FilteredCandidateSet,
  RankingSignalPolicyV1,
  RejectedCandidate,
  RejectionSummary,
  RouterDecision,
  RouterPipelineStage,
  RouterPolicySnapshot,
  RouterPositiveReason,
  RouterProvenance,
  RouterPolicyView,
  RouterReasonCode,
  RouterRejectionReason,
  RouterRequest,
  RouterRiskConstraint,
  RouterRiskConstraintHook,
  RouterV1Policy,
  TieBreakFacts,
  TieBreakKey,
} from './domain/model-router.js';
export type {
  ModelRouterPort,
  RouterExecutionContext,
  RouterExplanation,
} from './ports/model-router.js';
export type { RouterDecisionRecord, RouterDecisionStorePort } from './ports/router-decision.js';

/* --------------------------------------------- structured handoff (Sprint 11) ----- */
export {
  HANDOFF_REF_KINDS,
  HANDOFF_REJECTION_REASONS,
  HANDOFF_REQUIRED_AT_READY,
  HANDOFF_STATES,
  HANDOFF_TRANSITIONS,
  acceptHandoffPacket,
  applyHandoffTransition,
  assertHandoffSafety,
  canTransitionHandoff,
  cancelHandoffPacket,
  createHandoffPacket,
  handoffCardOf,
  handoffContextViewIfAccepted,
  handoffToAgentContextView,
  markHandoffReady,
  previousHandoffTextOf,
  rejectHandoffPacket,
  serializeHandoffContextView,
  supersedeHandoff,
  validateHandoffRefs,
} from './domain/handoff.js';
export type {
  CreateHandoffInput,
  HandoffCardViewModel,
  HandoffContextView,
  HandoffModelBinding,
  HandoffPacket,
  HandoffRef,
  HandoffRefKind,
  HandoffRejectionReason,
  HandoffState,
} from './domain/handoff.js';
export type { HandoffStorePort } from './ports/handoff.js';
export type { SessionEntryRow, SessionStorePort } from './ports/session-store.js';
/** Sprint 15: Industry Pack persistence + live-availability ports. */
export type {
  PackVersionStore,
  PackInstallationStore,
  PackContentRefStore,
  PackAvailabilityPolicy,
  PackRunProvenancePolicy,
} from './ports/pack.js';
export type { MemoryStorePort } from './ports/memory.js';
export type { DecisionStorePort } from './ports/decision.js';
export type {
  ArtifactStorePort,
  ArtifactCreationMetadata,
  DurableArtifactLookup,
} from './ports/artifact.js';
export type {
  ArtifactContentStore,
  ContentIntegrity,
  StoredContent,
  ArtifactContentDiagnosticsPort,
  CasDiagnosticsSnapshot,
  ManagedCasEntry,
  StagingEntry,
  UnknownEntry,
} from './ports/artifact-content.js';
export type {
  ValidationStorePort,
  ValidationCreationMetadata,
  DurableValidationLookup,
  ReportArtifactDescriptor,
} from './ports/validation.js';

/* --------------------------------------------- router ranking engine (Sprint 10B) -- */
export {
  PROVIDER_HEALTH_VALUES,
  RANKED_SIGNAL_KEYS,
  ROUTER_BENCHMARK_CAP_REFERENCE,
  SIGNAL_SKIP_REASONS,
  evaluateRankingSignals,
  rankCandidates,
  selectWinner,
} from './domain/model-router-ranking.js';
export type {
  ProviderHealthValue,
  RankedCandidateEvaluation,
  RankingContext,
  RankingOutcome,
  RankingSignalResult,
  SignalSkipReason,
} from './domain/model-router-ranking.js';

/* -------------------------------------------------- tool registry (Sprint 9) ----- */
export {
  DEFAULT_TOOL_TIMEOUT_MS,
  IDEMPOTENCY_MODES,
  RISK_POLICY,
  TOOL_AUDIT_POLICIES,
  TOOL_ID_PATTERN,
  TOOL_RISK_LEVELS,
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  decideToolApproval,
  describeTool,
  isToolRiskLevel,
  normalizeToolId,
  riskPolicyOf,
  setToolEnabled,
  toolHasSideEffects,
} from './domain/tool.js';
export type {
  CreateToolInput,
  IdempotencyMode,
  RiskPolicy,
  ToolAuditPolicy,
  ToolDescriptor,
  ToolRecord,
  ToolRiskLevel,
} from './domain/tool.js';
export {
  TOOL_ERROR_CODES,
  TOOL_ERROR_KINDS,
  TOOL_INVOCATION_STATES,
  TOOL_TERMINAL_STATES,
  canRetryInvocation,
  canTransitionToolInvocation,
  createToolInvocation,
  digestInput,
  isTerminalToolStatus,
  markInvocationApproved,
  markInvocationCancelled,
  markInvocationCompleted,
  markInvocationFailed,
  markInvocationInterrupted,
  markInvocationStarted,
  markWaitingApproval,
  normalizeToolError,
  baseIdempotencyKey,
  retryIdempotencyKey,
  toolInvocationNeedsRecovery,
} from './domain/tool-invocation.js';
export type {
  CreateToolInvocationInput,
  ToolError,
  ToolErrorKind,
  ToolInvocation,
  ToolInvocationStatus,
} from './domain/tool-invocation.js';
export { isUsableSchema, validateAgainstSchema } from './domain/schema-validation.js';
export type { SchemaIssue } from './domain/schema-validation.js';
export type {
  ToolHealth,
  ToolInvocationIndexPort,
  ToolInvocationOutcome,
  ToolInvocationPage,
  ToolInvocationRecord,
  ToolInvokeInput,
  ToolPage,
  ToolPort,
  ToolRecoveryReport,
  ToolRegistration,
  ToolRegistryPort,
  ToolRequest,
  ToolResult,
} from './ports/tool.js';

export type { EventBus, EventHandler } from './ports/event-bus.js';
export type { SecretResolver } from './ports/secrets.js';
export type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ModelMessage,
  ModelCapability,
  ProviderDescriptor,
} from './ports/model-gateway.js';
export type {
  AgentRuntimePort,
  ExecutionTask,
  ExecutionResult,
  ExecutionOutcome,
} from './ports/agent-runtime.js';

/* --------------------------------------------------------------- lifecycle */
export {
  LIFECYCLE_STATES,
  LIFECYCLE_EVENTS,
  TRANSITIONS,
  findTransition,
  canTransition,
  allowedEvents,
  isTerminal,
  isState,
  nextState,
  requireState,
} from './lifecycle/machine.js';
export type {
  LifecycleState,
  LifecycleEvent,
  TransitionRule,
  TransitionTarget,
} from './lifecycle/machine.js';

export {
  INITIAL_SEMVER,
  parseSemver,
  formatSemver,
  isSemver,
  isDraftSemver,
  bumpMinor,
  bumpPatch,
  draftSemverFor,
  releaseSemver,
  createWorkflowVersion,
  recomputeContentHash,
  isVersionIntact,
  isRunnableGraph,
} from './lifecycle/version.js';
export type {
  WorkflowVersion,
  WorkflowGraph,
  WorkflowNode,
  WorkflowEdge,
  SemverParts,
  CreateVersionInput,
} from './lifecycle/version.js';

export type { ChangeOp, ChangeOpKind } from './lifecycle/proposal-diff.js';
export {
  applyChangeOp,
  applyChangeOps,
  assertEditable,
  approvalOf,
  APPROVAL_MODES,
  isEditableLifecycleState,
  riskLevelOf,
  RISK_LEVELS,
  roleIdOf,
  taskProfileOf,
  type PinnedTaskProfile,
  STAGE_CONFIG_KEYS,
  validatorIdsOf,
} from './lifecycle/change-ops.js';
export type { ApprovalConfig, ApprovalMode, StageOp, StageOpKind } from './lifecycle/change-ops.js';
export {
  RUN_GOAL_ARTIFACT_KIND,
  RUN_GOAL_MAX_OBJECTIVE_CHARS,
  RUN_GOAL_MAX_STRUCTURED_BYTES,
  RUN_GOAL_SCHEMA,
  decodeRunGoal,
  encodeRunGoal,
  runGoalCommandId,
  validateRunGoalInput,
  type ResolvedRunGoalInput,
  type RunGoal,
  type RunGoalInput,
  type RunGoalSource,
  type RunGoalSourceType,
} from './lifecycle/run-goal.js';
export {
  PLAN_ARTIFACT_KIND,
  PLAN_SCHEMA,
  PLAN_PROPOSAL_SCHEMA,
  PLAN_LIMITS,
  PLAN_LOCAL_ID_SOURCE,
  isPlanItemId,
  isCriterionId,
  planIdOf,
  planFingerprintOf,
  comparePlanFingerprint,
  validatePlanningProposal,
  validatePlanArtifactPayload,
  type PlanningProposal,
  type PlanningProposalItem,
  type PlanningProposalCriterion,
  type ProfessionalResponsibilityDeclaration,
  type ValidatedPlanContent,
  type PlanArtifactPayload,
  type PlanReplayComparison,
} from './lifecycle/plan.js';
export {
  SESSION_COMPACTION_CHECKPOINT_SCHEMA,
  SESSION_CONTEXT_SEED_SCHEMA,
  SESSION_ENTRY_KINDS,
  SESSION_ENTRY_LIMITS,
  SESSION_FIRST_SEQUENCE,
  SESSION_ID_NAMESPACE,
  SESSION_REF_KINDS,
  sessionIdOf,
  isValidSessionRef,
  utf8ByteLength,
  type SessionCanonicalRef,
  type SessionEntry,
  type SessionEntryKind,
  type SessionRecord,
  type SessionRefKind,
  type SessionTokenAccounting,
} from './lifecycle/session.js';
export {
  CORRECTIVE_TASK_CAUSES,
  CORRECTIVE_TASK_INPUTS_KEY,
  CORRECTIVE_TASK_SCHEMA,
  correctiveLineageFingerprint,
  correctiveLineageOf,
  correctiveTaskIdOf,
  reassessmentTaskIdOf,
  descendantReassessmentTaskIdOf,
  validateCorrectiveLineage,
  workPayloadOf,
  type CorrectiveTaskCause,
  type CorrectiveTaskLineage,
} from './lifecycle/corrective-task.js';
export {
  EXECUTION_ATTEMPT_SCHEMA,
  EXECUTION_ATTEMPT_STATES,
  applyExecutionAttemptTransition,
  createExecutionAttempt,
  executionAttemptIdOf,
  executionAttemptSeedFingerprint,
  nextExecutionAttemptState,
  type ExecutionAttempt,
  type ExecutionAttemptSeed,
  type ExecutionAttemptState,
} from './lifecycle/execution-attempt.js';
export {
  REVIEW_FINDINGS_ARTIFACT_KIND,
  REVIEW_FINDINGS_LIMITS,
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_VERDICTS,
  decodeReviewReport,
  encodeReviewReport,
  isReviewEvidenceRefShape,
  isReviewLocatorPath,
  reviewFindingFingerprint,
  reviewFindingIdOf,
  reviewFindingsArtifactFingerprint,
  reviewFindingsCommandId,
  validateReviewFinding,
  validateReviewReport,
  type DraftReviewFinding,
  type ReviewFinding,
  type ReviewFindingLocator,
  type ReviewProvenance,
  type ReviewReportPayload,
  type ReviewVerdict,
} from './lifecycle/review-findings.js';
export {
  STAGE_HANDLER_STATUSES,
  STAGE_OUTPUT_LIMITS,
  STAGE_OUTPUT_SCHEMA,
  STAGE_OUTPUT_TASK_KEY,
  decodeStageHandlerOutput,
  encodeStageHandlerOutput,
  normalizeStageHandlerResult,
  validateStageHandlerOutput,
  type StageHandlerOutput,
  type StageHandlerResult,
  type StageHandlerStatus,
} from './lifecycle/stage-output.js';
export {
  RUN_BINDING_KEY_PATTERN,
  UNPINNABLE_AVAILABILITY,
  validateRunModelBindings,
  type RunModelBindingRecord,
  type RunModelBindingResolver,
} from './lifecycle/run-model-bindings.js';
export { assertPublishable, validateWorkflowGraph } from './lifecycle/graph-validation.js';
export type {
  GraphValidationIssue,
  GraphValidationOptions,
  GraphValidationReport,
} from './lifecycle/graph-validation.js';

export {
  PROPOSAL_STATUSES,
  openChangeProposal,
  acceptChangeProposal,
  rejectChangeProposal,
  supersedeChangeProposal,
  requireAcceptedProposal,
} from './lifecycle/change-proposal.js';
export type {
  ChangeProposal,
  ChangeProposalStatus,
  ChangeProposalSubject,
  OpenProposalInput,
} from './lifecycle/change-proposal.js';

export {
  createWorkflowTemplate,
  publishInitialVersion,
  openRevision,
  publishRevision,
  forkTemplate,
  deprecateTemplate,
  archiveTemplate,
  findVersion,
  currentVersion,
  draftVersion,
  releasedVersions,
  isRunnable,
} from './lifecycle/template.js';
export type {
  WorkflowTemplate,
  ForkOrigin,
  ForkInput,
  ForkOutcome,
  CommandContext,
  TemplateMutation,
  CreateTemplateInput,
  PublishInput,
  OpenRevisionInput,
} from './lifecycle/template.js';

export {
  LOCK_SCOPES,
  createTemplateLock,
  releaseTemplateLock,
  isLockActive,
  activeLocksFor,
  assertMutable,
  assertForkable,
  lockPolicyFor,
} from './lifecycle/template-lock.js';
export type { TemplateLock, LockScope, CreateLockInput } from './lifecycle/template-lock.js';

export {
  snapshotHashOf,
  versionSnapshotHash,
  createRunSnapshot,
  verifyRunSnapshot,
} from './lifecycle/snapshot.js';
export type { RunSnapshot, RunSnapshotRef, CreateSnapshotInput } from './lifecycle/snapshot.js';

export {
  RUN_OUTCOMES,
  percentile,
  computeWorkflowMetrics,
  emptyMetrics,
} from './lifecycle/metrics.js';
export type {
  RunOutcome,
  RunOutcomeSample,
  WorkflowMetrics,
  MetricsWindow,
} from './lifecycle/metrics.js';

/* ---------------------------------------------------------------- registry */
export {
  PACK_API_VERSION,
  PACK_MANIFEST_VERSION,
  OPAQUE_TOKEN_PATTERN,
  PACK_ID_PATTERN,
  SEMVER_PATTERN,
  capabilityId,
  coreApiIsCompatible,
  isJsonValue,
  isNamespacedCapability,
  packQualifiedKey,
  parsePackQualifiedKey,
  validatePackManifest,
  PackRegistry,
} from './registry/pack-manifest.js';
export type {
  ArtifactTypeDeclaration,
  CapabilityRuleDeclaration,
  GenericTemplateDeclaration,
  PackCapability,
  PackContentKind,
  PackDeclarations,
  PackDependency,
  PackManifest,
  PromptDeclaration,
  RiskRuleDeclaration,
  RoleDeclaration,
  ToolRequirementDeclaration,
  ValidatorDeclaration,
  WorkflowTemplateDeclaration,
} from './registry/pack-manifest.js';

/* ------------------------------------------------ Sprint 1: kernel freeze -- */
export { brand, unbrand, sameId } from './kernel/brand.js';
export type { Brand } from './kernel/brand.js';

export { DOMAIN_ID_PREFIX, asId, hasIdPrefix, makeId } from './kernel/identifiers.js';
export type {
  AgentId,
  ApprovalId,
  ArtifactId,
  CompanyId,
  DecisionId,
  DomainIdKind,
  EventId,
  HandoffId,
  PackInstallationId,
  RoleId,
  RunSnapshotId,
  StageId,
  TaskId,
  ValidationId,
  WorkflowId,
  WorkflowRunId,
  WorkflowTemplateId,
  WorkflowVersionId,
} from './kernel/identifiers.js';

/* -------------------------------------------- Sprint 1: Core Domain models -- */
export * from './domain/index.js';

/* ------------------------------------------- Sprint 1: frozen port boundary -- */
export type {
  StageExecutionOutcome,
  StageExecutionRequest,
  StageExecutionResult,
  WorkflowEnginePort,
} from './ports/workflow-engine.js';
export type { EventStorePort, StoredEvent } from './ports/event-store.js';
export type { GoalBudgetPolicy, CostAdmissionBound, BudgetReservation, GoalExecutionBudget, ExecutionBudgetStore, UsageReconciliation } from './ports/execution-budget.js';
