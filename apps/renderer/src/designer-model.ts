/**
 * Designer view models (Sprint 5 STEP 4/5).
 *
 * Pure projection: IPC responses in, plain view data out. No IO, no clocks, no rules.
 * The renderer therefore cannot become a second source of truth: every fact shown here
 * was decided by WorkflowLifecycle/Core and merely re-shaped for display.
 */
/** Structural shape only: the renderer must not depend on @companyos/core. */
interface GraphLike {
  readonly nodes?: readonly unknown[];
  readonly edges?: readonly unknown[];
}

export interface LibraryRow {
  readonly templateId: string;
  readonly name: string;
  readonly industryPack: string;
  readonly currentVersion: string;
  readonly state: string;
  readonly usageCount: number;
  readonly updatedAt: string;
  readonly editable: boolean;
}

export interface DesignerStage {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly roleId: string;
  readonly validatorIds: readonly string[];
  readonly riskLevel: string;
  readonly approvalRequired: boolean;
  readonly approvalMode: string;
  readonly approvalAuthority: string;
}

export interface DesignerView {
  readonly templateId: string;
  readonly name: string;
  readonly state: string;
  readonly editable: boolean;
  readonly readOnlyReason: string | null;
  readonly versionLabel: string;
  readonly stages: readonly DesignerStage[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly validation: { readonly valid: boolean; readonly issues: readonly string[] };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asText = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

const asStringArray = (value: unknown): readonly string[] =>
  asArray(value).filter((entry): entry is string => typeof entry === 'string');

const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Library screen rows (Sprint 5 section 7). */
export function toLibraryRows(response: unknown): readonly LibraryRow[] {
  return asArray(response).map((entry) => {
    const row = asRecord(entry);
    return {
      templateId: asText(row['templateId'], '(unknown)'),
      name: asText(row['name'], '(unnamed)'),
      // Industry pack comes from the org/pack binding; V1 has no pack selection yet.
      industryPack: asText(row['industryPack'], 'generic'),
      currentVersion: asText(row['currentVersion'], '(draft)'),
      state: asText(row['state'], 'unknown'),
      usageCount: asNumber(row['usageCount']),
      updatedAt: asText(row['updatedAt'], ''),
      editable: row['editable'] === true,
    };
  });
}

/** Designer screen view (stages + edges + validation), straight from the service. */
export function toDesignerView(response: unknown): DesignerView {
  const payload = asRecord(response);
  const template = asRecord(payload['template']);
  const graph = asRecord(payload['graph']) as GraphLike;
  const validation = asRecord(payload['validation']);
  const state = asText(template['state'], 'unknown');
  const editable = payload['editable'] === true;

  const issues = asArray(validation['issues']).map((entry) => {
    const issue = asRecord(entry);
    return `${asText(issue['code'], 'ISSUE')}: ${asText(issue['message'], '')}`;
  });

  return {
    templateId: asText(template['templateId'], ''),
    name: asText(template['name'], '(unnamed)'),
    state,
    editable,
    readOnlyReason: editable ? null : readOnlyBanner(state),
    versionLabel: asText(template['currentVersion'], '(no published version)'),
    stages: asArray(graph?.nodes).map((entry) => {
      const node = asRecord(entry);
      const config = asRecord(node['config']);
      const approval = asRecord(config['approval']);
      return {
        id: asText(node['id'], ''),
        title: asText(node['title'], asText(node['id'], '')),
        kind: asText(node['kind'], ''),
        roleId: asText(config['roleId'], ''),
        validatorIds: asStringArray(config['validatorIds']),
        riskLevel: asText(config['riskLevel'], ''),
        approvalRequired: approval['required'] === true,
        approvalMode: asText(approval['mode'], ''),
        approvalAuthority: asText(approval['authority'], ''),
      };
    }),
    edges: asArray(graph?.edges).map((entry) => {
      const edge = asRecord(entry);
      return { from: asText(edge['from'], ''), to: asText(edge['to'], '') };
    }),
    validation: { valid: validation['valid'] === true, issues },
  };
}

/**
 * Why editing is closed. The UI shows this because the STATE says so; the refusal itself
 * still comes from Core/Lifecycle (UI text is never a security boundary).
 */
export function readOnlyBanner(state: string): string | null {
  switch (state) {
    case 'published':
      return 'Published version is read-only here: change it through a Change Proposal or a Fork.';
    case 'deprecated':
      return 'Deprecated: no new runs. Fork it to publish a replacement.';
    case 'archived':
      return 'Archived: read-only forever, kept for audit.';
    default:
      return null;
  }
}

export interface CompareRow {
  readonly label: string;
  readonly detail: string;
}

/** Compare Versions rows (requirement K). */
export function toCompareRows(response: unknown): readonly CompareRow[] {
  const payload = asRecord(response);
  const from = asRecord(payload['from']);
  const to = asRecord(payload['to']);
  const diff = asRecord(payload['diff']);
  const list = (value: unknown): string => asStringArray(value).join(', ') || '-';
  return [
    { label: 'From', detail: `${asText(from['semver'], '?')} (${asText(from['versionId'], '?')})` },
    { label: 'To', detail: `${asText(to['semver'], '?')} (${asText(to['versionId'], '?')})` },
    { label: 'Added stages', detail: list(diff['addedStageIds']) },
    { label: 'Removed stages', detail: list(diff['removedStageIds']) },
    { label: 'Changed stages', detail: list(diff['changedStageIds']) },
    { label: 'Added edges', detail: list(diff['addedEdges']) },
    { label: 'Removed edges', detail: list(diff['removedEdges']) },
  ];
}
