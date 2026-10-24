/**
 * PackService — the Industry Pack lifecycle orchestrator (Sprint 15 — Task-15-04;
 * ADR-0024/0025/0026/0027).
 *
 * Position (layering): an APPLICATION-layer service inside `@companyos/engine`. It
 * depends on Core ports/services, UnitOfWork/EventStore/CommandLedger and the
 * authorization seam. It never touches Electron/Renderer and never writes subsystem
 * tables with raw SQL — materialization goes through existing services.
 *
 * Install pipeline (frozen order, Task-15-04 §8):
 *   1. authorize `pack.manage` (company scope)
 *   2. parse / normalize / validate the manifest (canonical semantic model)
 *   3. construct the canonical PackVersion (fingerprint derived, trusted)
 *   4. resolve the exact required dependency closure (candidate manifest included)
 *   5. reject missing dependencies / cycles
 *   6. validate coreApi / Tool requirements / Validator capability / Role
 *      authorities / declaration conflicts
 *   7. precompute the materialization plan (prevalidate BEFORE writes)
 *   8. ONE shared UnitOfWork: PackVersion (replay/insert) → PackInstallation
 *      (create/replay) → materialization via existing services (roles via the
 *      authorization service, workflow drafts via the lifecycle service) →
 *      PackContentRefs (real entity refs) → lifecycle event → commit
 *
 * Permanent install identity follows the Sprint 13 pattern: the bounded command
 * ledger is a retry cache; `creation_command_id` + `creation_command_fingerprint`
 * on the durable installation row are the permanent idempotency truth.
 *
 * Disable availability: the ONLY availability source is `status = 'installed'`.
 * Disable never deletes (PackVersion / installation / refs / materialized
 * subsystem rows all survive); live catalog exposure disappears.
 */
import {
  createPackContentRef,
  isPackManifestFingerprint,
  packManifestFingerprint,
  validatePackManifest,
  type PackContentKind,
  type PackInstallation,
  type PackManifest,
  type PackVersion,
  type Role,
  type RoleDeclaration,
} from '@companyos/core';
import {
  contentHash,
  defineEvent,
  domainError,
  err,
  ok,
  type Clock,
  type CommandLedgerPort,
  type DomainError,
  type EventStorePort,
  type IdFactory,
  type Result,
  type UnitOfWork,
} from '@companyos/core';

import { resolveExactDependencyClosure } from './pack-provenance.js';

import type { AuthorizationService } from '../authorization.js';
import type { WorkflowLifecycle } from '../lifecycle-service.js';
import type {
  PackContentRefStore,
  PackInstallationStore,
  PackVersionStore,
} from '@companyos/core';

/* ------------------------------------------------------------------- types --- */

export interface PackInstallInput {
  readonly commandId: string;
  readonly companyId: string;
  readonly actorId: string;
  /** The untrusted manifest payload — normalized + validated inside the service. */
  readonly manifest: unknown;
  readonly traceId: string;
}

export interface PackLifecycleCommandInput {
  readonly commandId: string;
  readonly companyId: string;
  readonly actorId: string;
  readonly packId: string;
  readonly packVersion?: string;
  readonly traceId: string;
}

export interface PackUpgradeCommandInput extends PackLifecycleCommandInput {
  readonly manifest: unknown;
}

export interface PackMaterializationPlanItem {
  readonly contentKind: PackContentKind;
  readonly logicalKey: string;
}

/** Tool/validator requirement resolution — existence + capability facts, never an execution. */
export interface ToolRequirementResolver {
  resolve(toolId: string): Promise<
    | { readonly ok: true; readonly capabilities: readonly string[] }
    | { readonly ok: false }
  >;
}

export interface PackServiceDeps {
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly authorization: AuthorizationService;
  readonly lifecycle: WorkflowLifecycle;
  readonly packVersions: PackVersionStore;
  readonly packInstallations: PackInstallationStore;
  readonly packContentRefs: PackContentRefStore;
  readonly events: EventStorePort;
  readonly ledger: CommandLedgerPort;
  readonly unitOfWork: UnitOfWork;
  readonly toolRequirementResolver: ToolRequirementResolver;
}

export interface PackService {
  install(input: PackInstallInput): Promise<Result<PackInstallation, DomainError>>;
  enable(input: PackLifecycleCommandInput): Promise<Result<PackInstallation, DomainError>>;
  disable(input: PackLifecycleCommandInput): Promise<Result<PackInstallation, DomainError>>;
  upgrade(input: PackUpgradeCommandInput): Promise<Result<PackInstallation, DomainError>>;
  /** Availability source for a company: ONLY installed installations. */
  listInstalled(companyId: string): Promise<Result<readonly PackInstallation[], DomainError>>;
  getInstallation(companyId: string, packId: string, packVersion: string): Promise<Result<PackInstallation | null, DomainError>>;
  getPackVersion(packId: string, packVersion: string): Promise<Result<PackVersion | null, DomainError>>;
}

/* --------------------------------------------------------------- internals --- */

const PACK_AUTHORITY = 'pack.manage';
const VALIDATOR_CAPABILITY = 'validation:validator';

/** Payload whitelist for lifecycle events (no manifest body / prompt / template content). */
const packEventPayload = (input: {
  readonly companyId: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly installationId: string;
  readonly actorId: string;
}): Readonly<Record<string, unknown>> => ({
  companyId: input.companyId,
  packId: input.packId,
  packVersion: input.packVersion,
  installationId: input.installationId,
  actorId: input.actorId,
});

/** Permanent install-command fingerprint: every semantic input participates. */
const packCommandFingerprint = (input: {
  readonly commandId: string;
  readonly companyId: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly manifestFingerprint: string;
}): string =>
  contentHash({
    purpose: 'pack.install',
    commandId: input.commandId,
    companyId: input.companyId,
    packId: input.packId,
    packVersion: input.packVersion,
    manifestFingerprint: input.manifestFingerprint,
  });

/* ---------------------------------------------------------------- service --- */

/**
 * Company role keys follow the Role contract (`^[a-z][a-z0-9-]{1,31}$`, ADR-0002): a
 * pack's namespaced declaration key flattens to exactly one company role key, so two
 * packs never share a role and a pack's own key is stable across its versions.
 */
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const materializedRoleKey = (logicalKey: string): string => logicalKey.replace(/:/g, '-');

export function createPackService(deps: PackServiceDeps): PackService {
  const { clock, ids, authorization, lifecycle, packVersions, packInstallations, packContentRefs, events, ledger, unitOfWork, toolRequirementResolver } = deps;

  const emit = async (
    type: string,
    input: {
      readonly companyId: string;
      readonly packId: string;
      readonly packVersion: string;
      readonly installationId: string;
      readonly actorId: string;
      readonly traceId: string;
    },
  ): Promise<void> => {
    await events.append([
      defineEvent(
        {
          type,
          aggregateId: input.installationId,
          aggregateType: 'PackInstallation',
          traceId: input.traceId,
          actorId: input.actorId,
          payload: packEventPayload(input),
        },
        ids,
        clock.nowIso(),
      ),
    ]);
  };

  /**
   * Authorization + company scope: the actor needs `pack.manage` AND must hold a role
   * inside the target company (the roles table is company-scoped). A cross-company
   * mutation is denied here, before any read of foreign installations.
   */
  const authorizeCompany = async (
    companyId: string,
    actorId: string,
  ): Promise<Result<true, DomainError>> => {
    const decision = await authorization.decide({ actorId, authority: PACK_AUTHORITY, scopeId: companyId });
    if (!decision.ok) return err(decision.error);
    const roles = await authorization.listRoles();
    const assignments = await authorization.assignmentsOf(actorId);
    const heldRoles = roles.filter((role) => assignments.some((assignment) => assignment.roleId === role.id));
    if (!heldRoles.some((role) => role.companyId === companyId)) {
      return err(
        domainError('PERMISSION_DENIED', `Actor "${actorId}" holds no role inside company "${companyId}".`, {
          reason: 'PACK_COMPANY_SCOPE_DENIED',
          companyId,
        }),
      );
    }
    return ok(true);
  };

  /** Steps 2/3: canonical PackVersion (validate + derive fingerprint, never caller-supplied). */
  const canonicalVersion = (manifest: unknown): Result<PackVersion, DomainError> => {
    const validated = validatePackManifest(manifest);
    if (!validated.ok) return err(validated.error);
    const manifestValue: PackManifest = validated.value;
    return ok({
      packId: manifestValue.packId,
      packVersion: manifestValue.packVersion,
      manifest: manifestValue,
      manifestFingerprint: packManifestFingerprint(manifestValue),
    });
  };

  /** Steps 4/5: exact required dependency closure, candidate included, cycle-safe. */
  /** Step 6: requirement + conflict preflight (read-only; zero writes). */
  /**
   * Roles this pack materialized in an EARLIER installation of the same company
   * (disable never deletes them): the entity id is the pack's own durable handle.
   */
  const packOwnedRoleEntities = async (
    companyId: string,
    packId: string,
  ): Promise<Result<Map<string, string>, DomainError>> => {
    const rows = await packInstallations.listByCompany(companyId);
    if (!rows.ok) return rows;
    const owned = new Map<string, string>();
    for (const installation of rows.value) {
      if (installation.packId !== packId) continue;
      const refs = await packContentRefs.listByInstallation(installation.id);
      if (!refs.ok) return refs;
      for (const ref of refs.value) {
        if (ref.contentKind === 'role' && ref.materializedEntityRef !== null) {
          owned.set(ref.materializedEntityRef, ref.logicalKey);
        }
      }
    }
    return ok(owned);
  };

  /** A pack-owned role is reusable only for a BYTE-IDENTICAL declaration (no silent authority rewrite). */
  const roleMatchesDeclaration = (role: Role, declaration: RoleDeclaration): boolean =>
    role.name === declaration.label &&
    role.authority.length === declaration.authorityRefs.length &&
    [...role.authority].sort().join('\n') === [...declaration.authorityRefs].sort().join('\n');

  /**
   * Fresh definition, or exact reuse of a role this same pack materialized earlier.
   * Any other key clash is a CONFLICT (no last-writer-wins, no silent role rewrite).
   */
  const resolveRoleDeclaration = (
    companyId: string,
    declaration: RoleDeclaration,
    existingRoles: readonly Role[],
    owned: ReadonlyMap<string, string>,
  ): Result<{ readonly reuseId: string | null }, DomainError> => {
    const clash = existingRoles.find(
      (role) => role.companyId === companyId && role.key === materializedRoleKey(declaration.key),
    );
    if (clash === undefined) return ok({ reuseId: null });
    if (owned.get(clash.id) !== declaration.key || !roleMatchesDeclaration(clash, declaration)) {
      return err(
        domainError('CONFLICT', `Role "${declaration.key}" collides with an existing role in this company.`, {
          reason: 'PACK_ROLE_CONFLICT',
          logicalKey: declaration.key,
        }),
      );
    }
    return ok({ reuseId: clash.id });
  };

  const preflight = async (
    companyId: string,
    version: PackVersion,
  ): Promise<Result<void, DomainError>> => {
    if (!isPackManifestFingerprint(version.manifestFingerprint)) {
      return err(
        domainError('INVALID_ARGUMENT', 'The pack manifest fingerprint is not a canonical sha256 ref.', {
          reason: 'PACK_FINGERPRINT_FORMAT',
        }),
      );
    }
    const manifest = version.manifest;

    // Role conflict: a pack-owned role key (local segment) must not clash with a role
    // that already exists in this company — unless it is this same pack's own
    // byte-identical earlier declaration (upgrade reuse; a changed definition is a clash).
    const existingRoles = await authorization.listRoles();
    const owned = await packOwnedRoleEntities(companyId, manifest.packId);
    if (!owned.ok) return owned;
    for (const declaration of manifest.declarations.roles) {
      if (!ROLE_KEY_PATTERN.test(materializedRoleKey(declaration.key))) {
        return err(
          domainError('INVALID_ARGUMENT', `Role "${declaration.key}" cannot materialize a company role key.`, {
            reason: 'PACK_ROLE_KEY_INVALID',
            logicalKey: declaration.key,
          }),
        );
      }
      const resolved = resolveRoleDeclaration(companyId, declaration, existingRoles, owned.value);
      if (!resolved.ok) return resolved;
    }

    // Tool requirements: existence only (no adapter is installed or executed).
    for (const declaration of manifest.declarations.tools) {
      const resolved = await toolRequirementResolver.resolve(declaration.toolId);
      if (!resolved.ok) {
        return err(
          domainError('CONFLICT', `Required tool "${declaration.toolId}" is not registered.`, {
            reason: 'PACK_TOOL_MISSING',
            toolId: declaration.toolId,
          }),
        );
      }
    }

    // Validator requirements: the resolved tool must carry the validator capability.
    for (const declaration of manifest.declarations.validators) {
      const resolved = await toolRequirementResolver.resolve(declaration.validatorId);
      if (!resolved.ok || !resolved.capabilities.includes(VALIDATOR_CAPABILITY)) {
        return err(
          domainError('CONFLICT', `Validator "${declaration.validatorId}" lacks the "${VALIDATOR_CAPABILITY}" capability.`, {
            reason: 'PACK_VALIDATOR_MISSING',
            validatorId: declaration.validatorId,
          }),
        );
      }
    }
    return ok(undefined);
  };

  /** The one install/upgrade write transaction (prevalidated inputs only; throws roll back). */
  const writePhase = async (args: {
    readonly input: PackInstallInput | PackUpgradeCommandInput;
    readonly version: PackVersion;
    readonly commandFingerprint: string;
    readonly traceId: string;
    readonly event: string;
    readonly disableOf: string | null;
  }): Promise<Result<PackInstallation, DomainError>> => {
    const { input, version, commandFingerprint, traceId, event, disableOf } = args;
    const now = clock.nowIso();
    return unitOfWork.transaction(async () => {
      // 15. persist / reuse the PackVersion (same identity + same fingerprint replays).
      const storedVersion = await packVersions.put(version);
      if (!storedVersion.ok) throw storedVersion.error;
      // Upgrade: the previous enabled version is disabled INSIDE the same transaction
      // (the one-active-version invariant stays consistent at every visible commit).
      if (disableOf !== null) {
        const previous = await packInstallations.setStatus(disableOf, 'disabled', now);
        if (!previous.ok) throw previous.error;
        await emit('pack.disabled', {
          companyId: input.companyId,
          packId: previous.value.packId,
          packVersion: previous.value.packVersion,
          installationId: previous.value.id,
          actorId: input.actorId,
          traceId,
        });
      }

      // 16. create (or replay) the installation.
      const installation: PackInstallation = {
        id: ids.id('pak') as PackInstallation['id'],
        companyId: input.companyId as PackInstallation['companyId'],
        packId: version.packId,
        packVersion: version.packVersion,
        name: version.manifest.name,
        coreApi: version.manifest.coreApi,
        capabilities: version.manifest.capabilities.map((capability) => capability.id),
        status: 'installed',
        installedBy: input.actorId,
        installedAt: now,
        updatedAt: now,
      };
      const stored = await packInstallations.create({
        installation,
        creationCommandId: input.commandId,
        creationCommandFingerprint: commandFingerprint,
      });
      if (!stored.ok) throw stored.error;
      const installedId = stored.value.id;

      // 17. materialize declarations via EXISTING services (roles: definition only —
      //     never a user assignment; workflows: company-scoped drafts, never a
      //     published-version rewrite). A failure here rolls the whole UoW back.
      const refs: { kind: PackContentKind; key: string; entityId: string | null }[] = [];
      const existingRoles = await authorization.listRoles();
      const owned = await packOwnedRoleEntities(input.companyId, version.packId);
      if (!owned.ok) throw owned.error;
      for (const declaration of version.manifest.declarations.roles) {
        const resolved = resolveRoleDeclaration(input.companyId, declaration, existingRoles, owned.value);
        if (!resolved.ok) throw resolved.error;
        if (resolved.value.reuseId !== null) {
          refs.push({ kind: 'role', key: declaration.key, entityId: resolved.value.reuseId });
          continue;
        }
        const role = await authorization.defineRole({
          companyId: input.companyId,
          key: materializedRoleKey(declaration.key),
          name: declaration.label,
          authorities: declaration.authorityRefs,
        });
        if (!role.ok) throw role.error;
        refs.push({ kind: 'role', key: declaration.key, entityId: role.value.id });
      }
      for (const declaration of version.manifest.declarations.workflowTemplates) {
        const template = await lifecycle.createTemplate({
          orgId: input.companyId,
          name: declaration.name,
          actorId: input.actorId,
          traceId,
        });
        if (!template.ok) throw template.error;
        const draft = await lifecycle.saveDraftGraph({
          templateId: template.value.id,
          graph: declaration.graph,
          actorId: input.actorId,
          traceId,
        });
        if (!draft.ok) throw draft.error;
        refs.push({ kind: 'workflowTemplate', key: declaration.key, entityId: template.value.id });
      }
      // Pack-native declarations: no subsystem entity exists (prompt / tool / validator /
      // artifactType / riskRule / capabilityRule / generic template).
      const packNative: readonly { kind: PackContentKind; key: string }[] = [
        ...version.manifest.declarations.prompts.map((d) => ({ kind: 'prompt' as const, key: d.key })),
        ...version.manifest.declarations.tools.map((d) => ({ kind: 'tool' as const, key: d.key })),
        ...version.manifest.declarations.validators.map((d) => ({ kind: 'validator' as const, key: d.key })),
        ...version.manifest.declarations.artifacts.map((d) => ({ kind: 'artifactType' as const, key: d.key })),
        ...version.manifest.declarations.riskRules.map((d) => ({ kind: 'riskRule' as const, key: d.key })),
        ...version.manifest.declarations.capabilityRules.map((d) => ({ kind: 'capabilityRule' as const, key: d.key })),
        ...version.manifest.declarations.templates.map((d) => ({ kind: 'template' as const, key: d.key })),
      ];

      // 18. PackContentRefs: one per canonical declaration item (materialized entity
      //     refs for subsystem-landed declarations, null for pack-native ones).
      for (const ref of refs) {
        const built = createPackContentRef({
          packId: version.packId,
          packVersion: version.packVersion,
          contentKind: ref.kind,
          logicalKey: ref.key,
          materializedEntityRef: ref.entityId,
        });
        if (!built.ok) throw built.error;
        const storedRef = await packContentRefs.insert(installedId, built.value);
        if (!storedRef.ok) throw storedRef.error;
      }
      for (const ref of packNative) {
        const built = createPackContentRef({
          packId: version.packId,
          packVersion: version.packVersion,
          contentKind: ref.kind,
          logicalKey: ref.key,
          materializedEntityRef: null,
        });
        if (!built.ok) throw built.error;
        const storedRef = await packContentRefs.insert(installedId, built.value);
        if (!storedRef.ok) throw storedRef.error;
      }


      await emit(event, {
        companyId: input.companyId,
        packId: version.packId,
        packVersion: version.packVersion,
        installationId: installedId,
        actorId: input.actorId,
        traceId,
      });
      await ledger.put({
        commandId: input.commandId,
        fingerprint: commandFingerprint,
        runId: '',
        outcome: { installationId: installedId },
        recordedAt: now,
      });
      return stored.value;
    });
  };

  /** Step 14/15: permanent install idempotency (ledger cache, then durable identity). */
  /**
   * Permanent command identity (Sprint 13 Option B), resolved BEFORE any preflight so a
   * reused command fails closed instead of re-running materialization:
   *   - the ledger's bounded fingerprint answers a reused command with different content
   *   - the durable installation row answers the permanent identity: a command reused for
   *     a different pack tuple is a conflict, otherwise the installation replays
   *   - the PackVersion row's fingerprint makes a same-tuple manifest rewrite impossible
   */
  const resolveCommandIdentity = async (
    input: PackInstallInput | PackUpgradeCommandInput,
    version: PackVersion,
    commandFingerprint: string,
  ): Promise<Result<PackInstallation | null, DomainError>> => {
    const ledgerHit = await ledger.get(input.commandId);
    if (ledgerHit !== null && ledgerHit.fingerprint !== commandFingerprint) {
      return err(
        domainError('CONFLICT', `Pack command "${input.commandId}" was already used with a different fingerprint.`, {
          reason: 'PACK_COMMAND_FINGERPRINT_CONFLICT',
          commandId: input.commandId,
        }),
      );
    }
    const durable = await packInstallations.findByCreationCommand(input.commandId);
    if (!durable.ok) return durable;
    if (durable.value !== null) {
      if (durable.value.packId !== version.packId || durable.value.packVersion !== version.packVersion) {
        return err(
          domainError('CONFLICT', `Pack command "${input.commandId}" already produced a different pack installation.`, {
            reason: 'PACK_COMMAND_FINGERPRINT_CONFLICT',
            commandId: input.commandId,
          }),
        );
      }
      return ok(durable.value);
    }
    if (ledgerHit !== null) {
      const outcome = ledgerHit.outcome as { readonly installationId?: string };
      if (typeof outcome.installationId === 'string') {
        const replayed = await packInstallations.get(outcome.installationId);
        if (!replayed.ok) return replayed;
        if (replayed.value !== null) return ok(replayed.value);
      }
    }
    const existingVersion = await packVersions.get(version.packId, version.packVersion);
    if (!existingVersion.ok) return existingVersion;
    if (existingVersion.value !== null && existingVersion.value.manifestFingerprint !== version.manifestFingerprint) {
      return err(
        domainError('CONFLICT', `Pack ${version.packId}@${version.packVersion} already exists with different manifest content.`, {
          reason: 'PACK_VERSION_CONFLICT',
          packId: version.packId,
          packVersion: version.packVersion,
        }),
      );
    }
    // §17: the durable identity is per tuple — the same tuple replays, never duplicates.
    const sameTuple = await packInstallations.findByCompanyPackVersion(
      input.companyId,
      version.packId,
      version.packVersion,
    );
    if (!sameTuple.ok) return sameTuple;
    return ok(sameTuple.value);
  };

  const install = async (input: PackInstallInput): Promise<Result<PackInstallation, DomainError>> => {
    // 1. authorize (company scope).
    const authorized = await authorizeCompany(input.companyId, input.actorId);
    if (!authorized.ok) return authorized;

    // 2/3. canonical version (fingerprint derived).
    const version = canonicalVersion(input.manifest);
    if (!version.ok) return version;
    const commandFingerprint = packCommandFingerprint({
      commandId: input.commandId,
      companyId: input.companyId,
      packId: version.value.packId,
      packVersion: version.value.packVersion,
      manifestFingerprint: version.value.manifestFingerprint,
    });

    // Permanent command identity first: a reused command must never re-materialize.
    const identity = await resolveCommandIdentity(input, version.value, commandFingerprint);
    if (!identity.ok) return identity;
    if (identity.value !== null) return ok(identity.value);

    // 4-7. dependency closure + preflight (zero writes).
    const closure = await resolveExactDependencyClosure(
      { packInstallations, packContentRefs, packVersions },
      input.companyId,
      [{ packId: version.value.packId, packVersion: version.value.packVersion }],
      new Map([[version.value.packId, version.value]]),
    );
    if (!closure.ok) return closure;
    const checked = await preflight(input.companyId, version.value);
    if (!checked.ok) return checked;

    return writePhase({ input, version: version.value, commandFingerprint, traceId: input.traceId, event: 'pack.installed', disableOf: null });
  };

  const findInstallation = async (
    input: PackLifecycleCommandInput,
  ): Promise<Result<PackInstallation, DomainError>> => {
    if (input.packVersion === undefined) {
      const found = await packInstallations.findEnabled(input.companyId, input.packId);
      if (!found.ok) return found;
      if (found.value === null) {
        return err(
          domainError('NOT_FOUND', `Pack "${input.packId}" has no enabled installation for this company.`, {
            reason: 'PACK_NOT_INSTALLED',
            packId: input.packId,
          }),
        );
      }
      return ok(found.value);
    }
    const found = await packInstallations.findByCompanyPackVersion(input.companyId, input.packId, input.packVersion);
    if (!found.ok) return found;
    if (found.value === null) {
      return err(
        domainError('NOT_FOUND', `Pack "${input.packId}@${input.packVersion}" is not installed for this company.`, {
          reason: 'PACK_NOT_INSTALLED',
          packId: input.packId,
          packVersion: input.packVersion,
        }),
      );
    }
    return ok(found.value);
  };

  const enable = async (input: PackLifecycleCommandInput): Promise<Result<PackInstallation, DomainError>> => {
    const authorized = await authorizeCompany(input.companyId, input.actorId);
    if (!authorized.ok) return authorized;
    const found = await findInstallation(input);
    if (!found.ok) return found;
    if (found.value.status === 'installed') return ok(found.value);
    if (input.packVersion === undefined) {
      return err(
        domainError('INVALID_ARGUMENT', 'enable needs the exact pack version.', {
          reason: 'PACK_VERSION_REQUIRED',
          packId: input.packId,
        }),
      );
    }
    // Re-enable: revalidate the dependency closure (no re-materialization: the rows exist).
    const version = await packVersions.get(input.packId, input.packVersion);
    if (!version.ok) return version;
    if (version.value === null) {
      return err(
        domainError('NOT_FOUND', `Pack "${input.packId}@${input.packVersion}" is unknown.`, {
          reason: 'PACK_VERSION_MISSING',
          packId: input.packId,
          packVersion: input.packVersion,
        }),
      );
    }
    const closure = await resolveExactDependencyClosure(
      { packInstallations, packContentRefs, packVersions },
      input.companyId,
      [{ packId: version.value.packId, packVersion: version.value.packVersion }],
      new Map([[version.value.packId, version.value]]),
    );
    if (!closure.ok) return closure;
    const checked = await preflight(input.companyId, version.value);
    if (!checked.ok) return checked;
    const now = clock.nowIso();
    return unitOfWork.transaction(async () => {
      const enabled = await packInstallations.setStatus(found.value.id, 'installed', now);
      if (!enabled.ok) throw enabled.error;
      await emit('pack.enabled', {
        companyId: input.companyId,
        packId: enabled.value.packId,
        packVersion: enabled.value.packVersion,
        installationId: enabled.value.id,
        actorId: input.actorId,
        traceId: input.traceId,
      });
      return enabled.value;
    });
  };

  /**
   * Installed packs of this company whose manifests require the EXACT (packId, packVersion).
   * Used by disable AND by upgrade (which disables the previous version in the same
   * transaction): lifting a version another pack still requires would strand a live
   * dependency, so both paths fail closed with PACK_DEPENDENCY_IN_USE.
   */
  const installedDependentsOf = async (
    companyId: string,
    packId: string,
    packVersion: string,
  ): Promise<Result<readonly string[], DomainError>> => {
    const installed = await packInstallations.listByCompany(companyId);
    if (!installed.ok) return installed;
    const dependents: string[] = [];
    for (const dependent of installed.value) {
      if (dependent.status !== 'installed') continue;
      if (dependent.packId === packId && dependent.packVersion === packVersion) continue;
      const version = await packVersions.get(dependent.packId, dependent.packVersion);
      if (!version.ok) return version;
      if (version.value === null) continue;
      const blocking = version.value.manifest.dependsOn.some(
        (dependency) => dependency.packId === packId && dependency.packVersion === packVersion,
      );
      if (blocking) dependents.push(`${dependent.packId}@${dependent.packVersion}`);
    }
    return ok(dependents);
  };

  const disable = async (input: PackLifecycleCommandInput): Promise<Result<PackInstallation, DomainError>> => {
    const authorized = await authorizeCompany(input.companyId, input.actorId);
    if (!authorized.ok) return authorized;
    const found = await findInstallation(input);
    if (!found.ok) return found;
    if (found.value.status === 'disabled') return ok(found.value);
    // §24: refuse to disable a pack another installed pack of this company depends on.
    const dependents = await installedDependentsOf(input.companyId, found.value.packId, found.value.packVersion);
    if (!dependents.ok) return dependents;
    if (dependents.value.length > 0) {
      return err(
        domainError('CONFLICT', `Pack "${found.value.packId}@${found.value.packVersion}" is required by installed packs and cannot be disabled.`, {
          reason: 'PACK_DEPENDENCY_IN_USE',
          requiredBy: dependents,
        }),
      );
    }
    const now = clock.nowIso();
    return unitOfWork.transaction(async () => {
      const disabled = await packInstallations.setStatus(found.value.id, 'disabled', now);
      if (!disabled.ok) throw disabled.error;
      await emit('pack.disabled', {
        companyId: input.companyId,
        packId: disabled.value.packId,
        packVersion: disabled.value.packVersion,
        installationId: disabled.value.id,
        actorId: input.actorId,
        traceId: input.traceId,
      });
      return disabled.value;
    });
  };

  const upgrade = async (input: PackUpgradeCommandInput): Promise<Result<PackInstallation, DomainError>> => {
    const authorized = await authorizeCompany(input.companyId, input.actorId);
    if (!authorized.ok) return authorized;
    const version = canonicalVersion(input.manifest);
    if (!version.ok) return version;

    const existingVersion = await packVersions.get(version.value.packId, version.value.packVersion);
    if (!existingVersion.ok) return existingVersion;
    if (existingVersion.value !== null && existingVersion.value.manifestFingerprint !== version.value.manifestFingerprint) {
      return err(
        domainError('CONFLICT', `Pack ${version.value.packId}@${version.value.packVersion} already exists with different manifest content.`, {
          reason: 'PACK_VERSION_CONFLICT',
          packId: version.value.packId,
          packVersion: version.value.packVersion,
        }),
      );
    }

    const previous = await packInstallations.findEnabled(input.companyId, version.value.packId);
    if (!previous.ok) return previous;
    const previousInstallation = previous.value;
    // Idempotent replay: the target version is already enabled.
    if (previousInstallation !== null && previousInstallation.packVersion === version.value.packVersion) {
      return ok(previousInstallation);
    }

    if (previousInstallation !== null) {
      const dependents = await installedDependentsOf(
        input.companyId,
        previousInstallation.packId,
        previousInstallation.packVersion,
      );
      if (!dependents.ok) return dependents;
      if (dependents.value.length > 0) {
        return err(
          domainError('CONFLICT', `Pack "${previousInstallation.packId}@${previousInstallation.packVersion}" is required by installed packs and cannot be upgraded away.`, {
            reason: 'PACK_DEPENDENCY_IN_USE',
            requiredBy: dependents.value,
          }),
        );
      }
    }

    const commandFingerprint = packCommandFingerprint({
      commandId: input.commandId,
      companyId: input.companyId,
      packId: version.value.packId,
      packVersion: version.value.packVersion,
      manifestFingerprint: version.value.manifestFingerprint,
    });
    const closure = await resolveExactDependencyClosure(
      { packInstallations, packContentRefs, packVersions },
      input.companyId,
      [{ packId: version.value.packId, packVersion: version.value.packVersion }],
      new Map([[version.value.packId, version.value]]),
    );
    if (!closure.ok) return closure;
    const checked = await preflight(input.companyId, version.value);
    if (!checked.ok) return checked;
    const sameTuple = await packInstallations.findByCompanyPackVersion(
      input.companyId,
      version.value.packId,
      version.value.packVersion,
    );
    if (sameTuple.ok && sameTuple.value !== null) {
      return ok(sameTuple.value);
    }
    // Same permanent-identity rules as install: a reused command never re-materializes.
    const identity = await resolveCommandIdentity(input, version.value, commandFingerprint);
    if (!identity.ok) return identity;
    if (identity.value !== null) return ok(identity.value);
    return writePhase({
      input,
      version: version.value,
      commandFingerprint,
      traceId: input.traceId,
      event: 'pack.upgraded',
      disableOf: previousInstallation === null ? null : previousInstallation.id,
    });
  };

  return {
    install,
    enable,
    disable,
    upgrade,
    async listInstalled(companyId: string) {
      const list = await packInstallations.listByCompany(companyId);
      if (!list.ok) return list;
      return ok(list.value.filter((installation) => installation.status === 'installed'));
    },
    async getInstallation(companyId: string, packId: string, packVersion: string) {
      return packInstallations.findByCompanyPackVersion(companyId, packId, packVersion);
    },
    async getPackVersion(packId: string, packVersion: string) {
      return packVersions.get(packId, packVersion);
    },
  };
}
