/**
 * @companyos/engine — the deterministic workflow engine (Sprint 2).
 *
 * Outer ring (AGENTS.md §1.3): it depends on `@companyos/core` contracts and ports
 * ONLY. It knows nothing about models, providers, roles or repositories; execution
 * is delegated to injected `StageHandler`s (Sprint 2 ships deterministic stubs).
 */
export {
  createWorkflowEngine,
  CRASHABLE_STATES,
  type DispatchOutcome,
  type DriveOptions,
  type DriveResult,
  type DriveStopReason,
  type WorkflowEngine,
  type WorkflowEngineDeps,
} from './engine.js';

export {
  COMMAND_TO_EVENT,
  assertReasonConsistency,
  routeCommand,
  type RoutedCommand,
} from './command-router.js';

export {
  alwaysFail,
  alwaysSucceed,
  createScriptedRegistry,
  createStaticRegistry,
  failTimes,
  type StageExecutionContext,
  type StageHandler,
  type StageHandlerOutcome,
  type StageHandlerRegistry,
  type StageHandlerReturn,
} from './handlers.js';

export {
  createFaultProbe,
  type FaultProbe,
  type FaultProbeScript,
} from './fault-probe.js';
export {
  createSessionKernel,
  SESSION_CONTEXT_SEED_SCHEMA,
  type ActiveSessionContext,
  type AppendSessionEntryInput,
  type SessionKernelDeps,
  type SessionOwnershipReaders,
  type SessionRedactionBoundary,
} from './session/session-kernel.js';
export {
  decideTokenBudget,
  estimateInputTokensUpperBound,
  validateBudgetConfiguration,
  FIXED_SAFETY_MARGIN_TOKENS,
  type TokenBudgetDecision,
  type TokenBudgetInput,
} from './session/token-budget.js';
export {
  createWorkSessionRuntime,
  WORK_ROLE_OUTPUT_KIND,
  type WorkRoleRegistration,
  type WorkSessionDeps,
  type WorkSessionTurnResult,
  type RunWorkTurnInput,
} from './session/work-session-runtime.js';


export {
  createInMemoryCommandLedger,
  createInMemoryEntityStore,
  createInMemoryMemoryStore,
  createInMemoryDecisionStore,
  createInMemoryEventStore,
  type InMemoryCommandLedger,
  type InMemoryEventStore,
  type ObservableEntityStore,
} from './memory-store.js';

/* ------------------------------------------- model providers (Sprint 6) ------- */
export {
  classifyProviderFailure,
  createProviderRegistry,
  normalizeCapabilities,
  normalizeModelInfo,
  PROVIDER_KIND_MARKER,
  type ProviderRegistry,
  type ProviderRegistryDeps,
} from './providers/registry.js';
export {
  createMockProvider,
  type MockInvocationOutcome,
  type MockProvider,
  type MockProviderInput,
  type MockProviderScript,
} from './providers/mock-provider.js';
export {
  createEnvSecretVault,
  requireSecret,
  type EnvSecretResolverInput,
  type SecretVault,
} from './providers/secret-vault.js';
export {
  createAuthorizationService,
  ensureBootstrapOwner,
  type AssignRoleInput,
  type AuthorizationDeps,
  type AuthorizationService,
  type BootstrapOwnerOptions,
  type BootstrapOwnerOutcome,
  type DefineRoleInput,
} from './authorization.js';

/* ------------------------------------------- model registry (Sprint 7) -------- */
export {
  createModelRegistry,
  type ModelRegistryDeps,
  type ModelRegistryService,
  type RegisterModelFromProviderInput,
} from './registry/model-registry.js';
export {
  createSelectionPolicyService,
  type SavePolicyInput,
  type SelectionPolicyDeps,
  type SelectionPolicyService,
} from './registry/selection-policy.js';

/* --------------------------------------- agent execution runtime (Sprint 8) --- */
export {
  createAgentRuntime,
  type AgentRuntimeDeps,
  type AgentRuntimeService,
  type ContextInput,
  type ExecuteInput,
  type ExecutionArtifactRecord,
  type ModelRequest,
  type PrepareExecutionInput,
  type PromptOptions,
  type RunExecutionInput,
} from './runtime/agent-runtime.js';

/* ------------------------------------------------- tool registry (Sprint 9) --- */
export {
  createToolRegistry,
  type ToolInvocationArtifactRecord,
  type ToolRegistry,
  type ToolRegistryDeps,
} from './tools/registry.js';
export {
  CRITICAL_TOOL_SPEC,
  ECHO_TOOL_SPEC,
  FAILING_TOOL_SPEC,
  HIGH_RISK_TOOL_SPEC,
  MOCK_TOOL_SPECS,
  READ_ONLY_TOOL_SPEC,
  SLOW_TOOL_SPEC,
  createMockTool,
  createMockToolRecord,
  type MockTool,
  type MockToolBehaviour,
  type MockToolSpec,
} from './tools/mock-tools.js';
export {
  createWorkflowLifecycle,
  GOVERNANCE_EVENT_TYPES,
  LIFECYCLE_AUTHORITIES,
  type ArchiveInput,
  type CreateRunInput,
  type CreateTemplateInput,
  type CreatedRun,
  type DecideProposalInput,
  type DeprecateInput,
  type ForkInput,
  type LockInput,
  type OpenProposalInput,
  type OpenRevisionInput,
  type PublishInput as LifecyclePublishInput,
  type SaveDraftInput,
  type UnlockInput,
  type WorkflowLifecycle,
  type WorkflowLifecycleDeps,
} from './lifecycle-service.js';
/** Run goal contract (Sprint 18) — the pure domain half lives in Core; re-exported here so
 *  consumers have one engine-level surface. */
export {
  RUN_GOAL_ARTIFACT_KIND,
  RUN_GOAL_MAX_OBJECTIVE_CHARS,
  RUN_GOAL_MAX_STRUCTURED_BYTES,
  RUN_GOAL_SCHEMA,
  decodeRunGoal,
  encodeRunGoal,
  runGoalCommandId,
  validateRunGoalInput,
  RUN_BINDING_KEY_PATTERN,
  UNPINNABLE_AVAILABILITY,
  validateRunModelBindings,
  type ResolvedRunGoalInput,
  type RunGoal,
  type RunGoalInput,
  type RunGoalSource,
  type RunGoalSourceType,
  type RunModelBindingRecord,
  type RunModelBindingResolver,
} from '@companyos/core';
export {
  createRunGoalService,
  type RunGoalReader,
  type RunGoalService,
  type RunGoalServiceDeps,
  type RunGoalWriter,
} from './goal/run-goal-service.js';
export {
  createRunSnapshotVerifier,
  type RunSnapshotVerifier,
  type RunSnapshotVerifierDeps,
} from './lifecycle/run-snapshot-verifier.js';
export {
  createReviewFindingsSink,
  type DraftFindingInput,
  type RecordReviewReportCommand,
  type ReviewFindingsSink,
  type ReviewFindingsSinkDeps,
  type ReviewReportView,
} from './supervisor/review-findings-sink.js';
export {
  createRunObservationService,
  createRunObservationNotifier,
  type AgentProvenanceObservation,
  type ExecutionAttemptObservation,
  type FindingObservation,
  type RunBlocker,
  type RunObservationDeps,
  type RunObservationNotifier,
  type RunOverview,
  type RunProgressObservation,
  type RunTimelinePage,
  type StageObservation,
  type TaskObservation,
  type TimelineEntry,
} from './observability/run-observation-service.js';
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
} from '@companyos/core';
export {
  createCorrectiveProvisioner,
  type CorrectiveProvisioner,
  type CorrectiveProvisionerDeps,
  type LatestReviewReportPort,
  type ProvisionCorrectiveTaskCommand,
  type ProvisionedTask,
} from './supervisor/corrective-provisioner.js';
export {
  CORRECTIVE_TASK_CAUSES,
  CORRECTIVE_TASK_INPUTS_KEY,
  CORRECTIVE_TASK_SCHEMA,
  correctiveLineageFingerprint,
  correctiveLineageOf,
  correctiveTaskIdOf,
  validateCorrectiveLineage,
  workPayloadOf,
  type CorrectiveTaskCause,
  type CorrectiveTaskLineage,
} from '@companyos/core';
export {
  SUPERVISOR_DECISION_ACTIONS,
  SUPERVISOR_DECISION_COMMAND_PREFIX,
  SUPERVISOR_DECISION_REASONS,
  SUPERVISOR_DECISION_SCHEMA,
  createSupervisorDecisionSink,
  supervisorDecisionCommandId,
  supervisorDecisionFingerprint,
  supervisorDecisionIdOf,
  supervisorDecisionPayloadOf,
  type RecordSupervisorDecisionCommand,
  type SupervisorDecisionAction,
  type SupervisorDecisionReader,
  type SupervisorDecisionReason,
  type SupervisorDecisionSink,
  type SupervisorDecisionSinkDeps,
} from './supervisor/decision-sink.js';
export {
  SUPERVISOR_BLOCKING_CONDITIONS,
  SUPERVISOR_CONTEXT_LIMITS,
  SUPERVISOR_ACTION_JSON_SCHEMA,
  SUPERVISOR_PROPOSAL_KEYS,
  SUPERVISOR_PROPOSAL_SCHEMA,
  SUPERVISOR_TURN_TIMEOUT_MS,
  createSupervisorDecisionRuntime,
  decodeSupervisorProposal,
  renderSupervisorContext,
  supervisorConstraints,
  reviewVerdictConsumedBy,
  correctiveCauseIdsOf,
  latestValidationPerValidator,
  supervisorDecisionEvidenceOf,
  supervisorSystemPrompt,
  type RunSupervisorDecisionTurnCommand,
  type SupervisorBlockingCondition,
  type SupervisorContext,
  type SupervisorContextRef,
  type SupervisorDecisionEvidence,
  type SupervisorDecisionHistoryReader,
  type SupervisorDecisionRuntime,
  type SupervisorDecisionRuntimeDeps,
  type SupervisorDecisionTurnResult,
  type SupervisorProposal,
  type SupervisorReviewReader,
  type SupervisorValidationReader,
} from './supervisor/supervisor-runtime.js';
export {
  REVIEW_CANDIDATE_KIND,
  VALIDATION_CANDIDATE_KIND,
  BOUNDED_AGENT_CONTEXT_LIMITS,
  createBoundedAgentContext,
  decideBoundedContextBudget,
  createEvidenceLifecycleApplicator,
  createPinnedAgentExecution,
  createStageOutputCarrier,
  stageOutputOf,
  type AppliedLifecycleEvent,
  type BoundedAgentContextDeps,
  type BoundedContextFieldClass,
  type BoundedLatestReview,
  type BoundedReviewContext,
  type BoundedValidationContext,
  type EvidenceLifecycleApplicator,
  type EvidenceLifecycleDeps,
  type EvidenceLifecycleEngine,
  type EvidenceLifecycleReaders,
  compareCanonicalReportOrder,
  latestCanonicalReportOf,
  type CanonicalReportOrder,
  type PinnedAgentExecution,
  type PinnedAgentExecutionDeps,
  type PinnedRoundInput,
  type RoutedStageOutput,
  type StageOutputCarrier,
  type StageOutputCarrierDeps,
  type StageOutputCarrierExecutions,
  type StageOutputCarrierReviewSink,
  type StageOutputCarrierValidationService,
} from './supervisor/index.js';
export {
  MODEL_CALL_RETRY_MAX_ATTEMPTS,
  MODEL_CALL_RETRY_BACKOFF_MS,
  MODEL_CALL_RETRY_AFTER_MAX_MS,
  runWithModelCallRetry,
  type RetryPolicyClock,
  type RetrySleeper,
  type RetryTelemetry,
  type RetryInvocationResult,
  type ModelCallRetryOptions,
} from './runtime/model-call-retry.js';
export {
  AUTONOMOUS_STOP_REASONS,
  DEFAULT_MAX_IDLE_TURNS,
  MAX_CORRECTIVE_ROUNDS,
  MAX_CONSECUTIVE_INVALID_TURNS,
  MAX_SUPERVISOR_TURNS,
  SUPERVISOR_APPLICATION_COMMAND_PREFIX,
  SUPERVISOR_APPLICATION_KIND,
  SUPERVISOR_APPLICATION_SCHEMA,
  consecutiveIllegalProposalCount,
  createAutonomousSupervisorRuntime,
  supervisorApplicationCommandId,
  type AppliedDecision,
  type AutonomousEnginePort,
  type AutonomousStopReason,
  type AutonomousSupervisionOutcome,
  type AutonomousSupervisorConfig,
  type AutonomousSupervisorRuntime,
  type AutonomousSupervisorRuntimeDeps,
  type PagedStore,
  type RunAutonomousSupervisionCommand,
  type WorkflowGraphShape,
} from './supervisor/autonomous-supervisor.js';
export { DEFAULT_MAX_CORRECTIVE_ROUNDS } from './supervisor/corrective-provisioner.js';
export {
  createRunModelBindingReader,
  type RunModelBindingReader,
  type RunModelBindingReaderDeps,
} from './lifecycle/run-model-bindings.js';
export {
  MAX_STORED_EVALUATIONS,
  MAX_STORED_REJECTIONS,
  ROUTER_AUDIT_REPAIR_KEYS,
  ROUTER_TERMINAL_AUDIT_EVENT_TYPES,
  createDeterministicModelRouter,
  reconcileAndRepairRouterAudit,
  reconcileRouterAudit,
  repairEventTypeOf,
  repairReasonOf,
  type RouterTerminalAuditEventType,
  repairPayloadOf,
  type DeterministicModelRouter,
  type DeterministicRouterDeps,
  type RouterAuditEmitter,
  type RouterAuditGap,
  type RouterAuditPayload,
  type RouterDecisionRecord,
  type RouterDecisionStorePort,
} from './router/deterministic-router.js';
export {
  createRouterApplicationService,
  registryRevisionOf,
  type RouterApplicationService,
  type RouterOverrideInput,
  type RouterOverrideOutcome,
  type RouterRecommendationDeps,
  type RouterRecommendationInput,
} from './router/router-application-service.js';
export {
  createHandoffService,
  type HandoffAuditEmitter,
  type HandoffAuditPayload,
  type HandoffAuthority,
  type HandoffService,
  type HandoffServiceDeps,
} from './handoff/handoff-service.js';
export {
  createValidatorResolver,
  type ValidatorDescriptor,
  type ValidatorResolver,
  type ValidatorResolverDeps,
} from './validation/validator-resolver.js';
export {
  resolveDurableReferences,
  resolveArtifactReference,
  resolveValidationReference,
  type DurableReference,
  type DurableReferenceResolution,
} from './validation/durable-references.js';
export {
  createValidationService,
  validationCommandFingerprint,
  validatorInvocationKey,
  reportArtifactCommandId,
  decodeValidatorOutput,
  type RunValidationCommand,
  type ValidationService,
  type ValidationServiceDeps,
  type ValidatorPlanEntry,
} from './validation/validation-service.js';
export {
  VALIDATOR_VERDICTS,
  type DecodedValidatorOutput,
  type ValidatorVerdict,
} from './validation/validator-output.js';
export {
  createArtifactCasReconciler,
  type ArtifactCasReconciler,
  type ReconcilerDeps,
  type ReconciliationReport,
} from './validation/cas-reconciler.js';
export {
  createValidationEvidenceGuard,
  type EvidenceGateInput,
  type EvidenceGateVerdict,
  type GateStagePolicy,
  type ValidationEvidenceGuard,
  type ValidationEvidenceGuardDeps,
} from './validation/evidence-guard.js';
export {
  createMemoryService,
  type MemoryService,
  type MemoryServiceDeps,
  type MemoryAudit,
} from './memory/memory-service.js';
export {
  verifyArtifactMemoryProvenance,
  verifyValidationMemoryProvenance,
} from './memory/artifact-validation-provenance.js';
export {
  artifactCommandFingerprint,
  createArtifactService,
  type ArtifactService,
  type ArtifactServiceDeps,
  type CreateArtifactCommand,
} from './artifact/artifact-service.js';
export {
  createDecisionService,
  type DecisionService,
  type DecisionServiceDeps,
  type DecisionAudit,
} from './decision/decision-service.js';

export {
  createStartupRecoveryOrchestrator,
  type StartupRecoveryReport,
  type StartupRecoveryDeps,
  type StartupRecoveryOrchestrator,
} from './recovery/startup-recovery.js';

export {
  createPackService,
  type PackService,
  type PackServiceDeps,
  type PackInstallInput,
  type PackLifecycleCommandInput,
  type PackUpgradeCommandInput,
  type PackMaterializationPlanItem,
  type ToolRequirementResolver,
} from './pack/pack-service.js';
export {
  createPackAvailabilityPolicy,
  type PackAvailabilityPolicyDeps,
} from './pack/pack-availability.js';
export {
  createRunPackProvenanceResolver,
  type RunPackProvenanceResolver,
} from './pack/run-pack-provenance.js';

/* ------------------------------------- repository runtime (Sprint 17 T17-02) --- */
export {
  createWorkspaceManager,
  workspaceIdOf,
  type OpenWorkspaceInput,
  type RepositoryCommandDescriptor,
  type RepositoryCommandProfile,
  type RepositoryOperation,
  type ResolvedRepositoryPath,
  type WorkspaceContext,
  type WorkspaceManager,
} from './repository/workspace.js';
export {
  createRepositoryPathPolicy,
  type RepositoryPathPolicy,
  type ResolveRepositoryPathInput,
} from './repository/path-policy.js';
export {
  MAX_MATCH_LINE_PREVIEW_BYTES,
  MAX_SEARCH_FILES,
  MAX_SEARCH_MATCHES,
  MAX_TEXT_FILE_BYTES,
  REPOSITORY_TOOL_SPECS,
  createRepositoryToolPort,
  createRepositoryToolRecord,
  createRepositoryTools,
  type RepositoryToolDeps,
  type RepositoryToolSpec,
} from './repository/repository-tools.js';
export {
  MAX_PROCESS_CAPTURE_BYTES,
  MAX_PROCESS_INLINE_PREVIEW_BYTES,
  buildFilteredProcessEnvironment,
  createRepositoryProcessRunner,
  type ProcessRunOutcome,
  type ProcessStreamSummary,
  type ProcessTermination,
  type RepositoryProcessRunner,
  type RepositoryProcessRunnerDeps,
  type RepositoryProcessRunInput,
} from './repository/repository-process-runner.js';
export {
  createFailureEvidenceLinker,
  validateEvidenceArtifactRefs,
  type EvidenceRefVerdict,
  type EvidenceReferenceResolver,
  type FailureEvidenceLinkInput,
  type FailureEvidenceLinkResult,
  type FailureEvidenceLinker,
} from './tools/failure-evidence.js';
export {
  GIT_DIFF_SAFETY_ARGV,
  GIT_REASONS,
  GIT_SAFETY_ARGV,
  GIT_SAFE_ENV_ADDITIONS,
  MAX_GIT_STATE_ENTRIES,
  computeRepositoryAnchor,
  createRepositoryRevisionAnchorProvider,
  type AnchorResult,
  type RepositoryGitDeps,
  type RepositoryRevisionAnchor,
  type RepositoryRevisionAnchorProvider,
} from './repository/repository-git.js';
export {
  REPOSITORY_GIT_TOOL_SPEC,
  createRepositoryGitToolPort,
  createRepositoryGitToolRecord,
  type GitOperation,
  type RepositoryGitToolDeps,
  type RepositoryGitToolSpec,
} from './repository/repository-git-tools.js';
export {
  REPOSITORY_COMMAND_DESCRIPTOR_FINGERPRINT_PURPOSE,
  repositoryCommandDescriptorFingerprint,
} from './repository/command-fingerprint.js';
export {
  REQUIRED_QA_EVIDENCE_SLOTS,
  repositoryQaEvidenceReport,
  verifyRepositoryQaEvidence,
  type QaEvidenceSlot,
  type QaEvidenceSlotResult,
  type QaEvidenceVerdict,
  type RepositoryEvidenceSource,
  type RepositoryEvidenceToolRecordReader,
  type RepositoryQaEvidenceDeps,
} from './repository/qa-evidence.js';
export {
  REPOSITORY_VALIDATION_EVIDENCE_SPEC,
  createRepositoryValidationEvidencePort,
  createRepositoryValidationEvidenceRecord,
  type RepositoryValidationEvidenceDeps,
  type RepositoryValidationEvidenceSpec,
} from './repository/validation-evidence-tools.js';
export {
  EVIDENCE_GROUNDING_SPEC,
  EVIDENCE_GROUNDING_TOOL_ID,
  createEvidenceGroundingPort,
  createEvidenceGroundingRecord,
  type EvidenceGroundingDeps,
  type EvidenceGroundingSpec,
} from './validation/evidence-grounding-tool.js';
export {
  REPO_TEST_CHECK_REPORT_KIND,
  REPO_TEST_CHECK_SPEC,
  REPO_TEST_CHECK_TOOL_ID,
  createRepoTestCheckPort,
  createRepoTestCheckRecord,
  type RepoTestCheckDeps,
  type RepoTestCheckSpec,
} from './validation/repo-test-check-tool.js';
export {
  createWorkspaceExecutionLease,
  workspaceInUseError,
  type AcquireLeaseInput,
  type WorkspaceExecutionLease,
  type WorkspaceExecutionLeaseService,
} from './repository/workspace-lease.js';
export {
  createTaskBaselineService,
  taskBaselineIdempotencyKey,
  type CaptureTaskBaselineInput,
  type TaskBaselineService,
  type TaskBaselineServiceDeps,
  type TaskRepositoryBaseline,
} from './repository/task-baseline.js';
export {
  createRepositoryHandlerRegistry,
  createRepositoryStageHandler,
  repositoryAgentBusyError,
  type RepositoryHandlerRegistry,
  type RepositoryStageHandlerDeps,
} from './repository/repository-agent.js';
export {
  PROCESS_TOOL_SPECS,
  REPOSITORY_PROCESS_TOOL_SPECS,
  createRepositoryProcessToolPort,
  createRepositoryProcessToolRecord,
  createRepositoryProcessTools,
  type ProcessToolId,
  type RepositoryProcessToolDeps,
  type RepositoryProcessToolSpec,
} from './repository/repository-process-tools.js';
export {
  findPackOwnersOfMaterializedEntity,
  resolveExactDependencyClosure,
  sortedPackVersionMap,
  type PackProvenanceStores,
} from './pack/pack-provenance.js';
export {
  WORK_PACKAGE_CONTRACT,
  WORK_PACKAGE_LIMITS,
  createWorkPackageProjector,
  stageSubjectTaskOf,
  type ProjectWorkPackageInput,
  type WorkPackage,
  type WorkPackageDependency,
  type WorkPackageHandoff,
  type WorkPackageProjectorDeps,
} from './projection/work-package-projector.js';
export {
  PLAN_COMPILER_CONTRACT,
  PLAN_COMPILATION_ANCHOR_KIND,
  compilePlanGraph,
  compiledNodeId,
  compiledTemplateId,
  compiledTemplateName,
  createPlanCompiler,
  executionRunIdOf,
  validateCompilationCoverage,
  type PlanCompilationSpec,
  type PlanCompilerDeps,
  type PlanItemCompilationProfile,
  type CompilePlanInput,
  type CompiledPlanResult,
} from './planning/plan-compiler.js';
export {
  PLANNER_RESERVED_OUTPUT_TOKENS,
  PLANNER_TASK_KIND,
  PLAN_PROPOSAL_JSON_SCHEMA,
  createPlannerRuntime,
  planArtifactCommandId,
  type PlannerRuntimeDeps,
  type PlanningTurnInput,
  type PlanningTurnResult,
} from './planning/planner-runtime.js';
export {
  createPlanReferenceValidator,
  type PlanReferenceValidator,
  type PlanReferenceValidatorDeps,
  type PlanReferenceValidationInput,
} from './planning/plan-reference-validator.js';
export {
  NORMAL_TASK_INPUTS_MAX_BYTES,
  createNormalTaskMaterializer,
  normalTaskIdOf,
  type MaterializeNormalTaskInput,
  type MaterializedNormalTask,
  type NormalTaskMaterializerDeps,
} from './planning/normal-task-materializer.js';
export {
  EXECUTOR_CAPABILITY_NAMES,
  assertExecutorCapabilities,
  createExecutorProviderRegistry,
  providerDispatchIdOf,
  providerDispatchKeyOf,
  type ExecutorCapabilityName,
  type ExecutorExecutionRequest,
  type ExecutorProvider,
  type ExecutorProviderDescriptor,
  type ExecutorProviderOutcome,
  type ExecutorProviderRegistry,
  type ExecutorWorkInput,
  type ProviderRoleContext,
  type SelectedModelRoute,
} from './executor/executor-provider.js';
export {
  createProcessExecutorProvider,
  parseNdjsonEvents,
  type ExecutorEnvPolicyInput,
  type ProcessExecutorConfig,
} from './executor/process-executor-provider.js';
export {
  EXECUTION_SAFETY_STAGE_ORDER,
  assertExecutionCwdAllowed,
  assertExecutionSafety,
  assertSecretRefIsPointer,
  assertWritePathWithinRoot,
  assertConfigUnchanged,
  assertNoSecretMaterial,
  buildExecutorEnvironment,
  configDriftOf,
  configFieldOf,
  executorConfigFingerprint,
  executorEnvAllowlistFor,
  isSecretShapedEnvName,
  redactExecutionText,
  reportSecretResolution,
  resolveExecutionSecret,
  resolveExecutorConfig,
  resolveTrustedWorkspaceRoot,
  type ConfigDriftVerdict,
  type ExecutionSafetyRequest,
  type ExecutionSafetyStageName,
  type ExecutionSafetyStageResult,
  type ExecutionSafetyVerdict,
  type ExecutionSecretOutcome,
  type ExecutionSecretReport,
  type ExecutorConfigField,
  type ExecutorConfigFieldSpec,
  type ExecutorConfigInput,
  type ExecutorConfigSchema,
  type ExecutorConfigSource,
  type ExecutorEnvironmentPolicy,
  type TypedExecutorConfig,
  type WorkspaceFsSeams,
} from './executor/execution-safety.js';
export { createGoalExecutionBudget } from './runtime/goal-execution-budget.js';
