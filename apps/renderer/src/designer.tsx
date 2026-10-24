/**
 * Minimal Workflow Library + Designer (Sprint 5 STEP 4/5).
 *
 * Deliberately plain: a table and forms, no drag-and-drop, no canvas, no animation
 * (Sprint 5 section 8). Every button sends ONE IPC operation; the server stays the
 * source of truth, so the UI never keeps authoritative state of its own.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';

import {
  toCompareRows,
  toDesignerView,
  toLibraryRows,
  type CompareRow,
  type DesignerStage,
  type DesignerView,
  type LibraryRow,
} from './designer-model.js';

export interface WorkflowBridge {
  workflowRequest(request: {
    readonly operation: string;
    readonly requestId?: string;
    readonly payload?: unknown;
  }): Promise<unknown>;
}

interface Response {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

const asResponse = (value: unknown): Response =>
  typeof value === 'object' && value !== null ? (value as Response) : { ok: false, error: { code: 'IPC', message: 'no response' } };

const errorText = (response: Response): string =>
  response.error === undefined ? 'operation failed' : `${response.error.code}: ${response.error.message}`;

let requestCounter = 0;
const nextRequestId = (): string => {
  requestCounter += 1;
  return `ui_${String(requestCounter)}`;
};

export function WorkflowLibrary(props: {
  readonly bridge: WorkflowBridge;
  readonly onOpen: (templateId: string) => void;
}): JSX.Element {
  const { bridge, onOpen } = props;
  const [rows, setRows] = useState<readonly LibraryRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [compare, setCompare] = useState<readonly CompareRow[] | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const response = asResponse(await bridge.workflowRequest({ operation: 'library.list', requestId: nextRequestId() }));
    if (response.ok) setRows(toLibraryRows(response.value));
    else setMessage(errorText(response));
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = async (operation: string, payload: Record<string, unknown>): Promise<Response> => {
    const response = asResponse(
      await bridge.workflowRequest({ operation, requestId: nextRequestId(), payload }),
    );
    setMessage(response.ok ? null : errorText(response));
    await refresh();
    return response;
  };

  const createDraft = async (): Promise<void> => {
    const name = window.prompt('Workflow name', 'New SOP');
    if (name === null || name.trim().length === 0) return;
    await send('draft.create', { orgId: 'org_default', name, actorId: 'user_designer' });
  };

  const fork = async (templateId: string, name: string): Promise<void> => {
    await send('fork', { templateId, name: `${name} (fork)`, actorId: 'user_designer' });
  };

  const deprecate = async (templateId: string): Promise<void> => {
    const reason = window.prompt('Deprecation reason', 'superseded');
    if (reason === null || reason.trim().length === 0) return;
    await send('deprecate', { templateId, reason, actorId: 'user_lead' });
  };

  const archive = async (templateId: string): Promise<void> => {
    await send('archive', { templateId, actorId: 'user_lead' });
  };

  const compareVersions = async (): Promise<void> => {
    const fromVersionId = window.prompt('Compare: FROM version id', '');
    const toVersionId = window.prompt('Compare: TO version id', '');
    if (fromVersionId === null || toVersionId === null) return;
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'compare',
        requestId: nextRequestId(),
        payload: { fromVersionId, toVersionId },
      }),
    );
    if (response.ok) setCompare(toCompareRows(response.value));
    else setMessage(errorText(response));
  };

  return (
    <section aria-label="workflow-library">
      <h2>Workflow Library</h2>
      <button type="button" onClick={() => void createDraft()}>
        Create Draft
      </button>
      {message === null ? null : <p role="alert">{message}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Industry Pack</th>
            <th>Current Version</th>
            <th>Lifecycle State</th>
            <th>Usage Count</th>
            <th>Last Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.templateId}>
              <td>{row.name}</td>
              <td>{row.industryPack}</td>
              <td>{row.currentVersion}</td>
              <td>{row.state}</td>
              <td>{row.usageCount}</td>
              <td>{row.updatedAt}</td>
              <td>
                <button type="button" onClick={() => onOpen(row.templateId)}>
                  Open
                </button>
                <button type="button" onClick={() => void fork(row.templateId, row.name)}>
                  Fork
                </button>
                <button type="button" onClick={() => void compareVersions()}>
                  Compare
                </button>
                <button type="button" onClick={() => void deprecate(row.templateId)}>
                  Deprecate
                </button>
                <button type="button" onClick={() => void archive(row.templateId)}>
                  Archive
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {compare === null ? null : (
        <table aria-label="version-compare">
          <tbody>
            {compare.map((entry) => (
              <tr key={entry.label}>
                <th>{entry.label}</th>
                <td>{entry.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const emptyStage = (): DesignerStage => ({
  id: '',
  title: '',
  kind: 'pack-a:step',
  roleId: '',
  validatorIds: [],
  riskLevel: '',
  approvalRequired: false,
  approvalMode: '',
  approvalAuthority: '',
});

export function WorkflowDesigner(props: {
  readonly bridge: WorkflowBridge;
  readonly templateId: string;
  readonly onBack: () => void;
}): JSX.Element {
  const { bridge, templateId, onBack } = props;
  const [view, setView] = useState<DesignerView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [form, setForm] = useState<DesignerStage>(emptyStage());
  const [edgeFrom, setEdgeFrom] = useState('');
  const [edgeTo, setEdgeTo] = useState('');
  const [rationale, setRationale] = useState('describe why this change is needed');

  const load = useCallback(async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'draft.open',
        requestId: nextRequestId(),
        payload: { templateId },
      }),
    );
    if (response.ok) setView(toDesignerView(response.value));
    else setMessage(errorText(response));
  }, [bridge, templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (ops: readonly Record<string, unknown>[]): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'draft.applyOps',
        requestId: nextRequestId(),
        payload: { templateId, actorId: 'user_designer', ops },
      }),
    );
    setMessage(response.ok ? null : errorText(response));
    await load();
  };

  const publish = async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'publish',
        requestId: nextRequestId(),
        payload: { templateId, actorId: 'user_lead' },
      }),
    );
    setMessage(response.ok ? 'Published.' : errorText(response));
    await load();
  };

  const submitReview = async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'review.submit',
        requestId: nextRequestId(),
        payload: {
          templateId,
          actorId: 'user_designer',
          rationale,
          summary: 'designer change request',
          changeSummary: [{ op: 'UPDATE_STAGE', stageId: selected || 'workflow' }],
        },
      }),
    );
    setMessage(response.ok ? 'Review requested.' : errorText(response));
    await load();
  };

  if (view === null) {
    return (
      <section aria-label="workflow-designer">
        <button type="button" onClick={onBack}>
          Back to library
        </button>
        <p>{message ?? 'Loading...'}</p>
      </section>
    );
  }

  const readOnly = !view.editable;

  return (
    <section aria-label="workflow-designer">
      <button type="button" onClick={onBack}>
        Back to library
      </button>
      <h2>{view.name}</h2>
      <p>
        State: <strong>{view.state}</strong> | Version: {view.versionLabel} |{' '}
        {view.validation.valid ? 'Validation OK' : `${String(view.validation.issues.length)} validation problem(s)`}
      </p>
      {view.readOnlyReason === null ? null : <p role="alert">{view.readOnlyReason}</p>}
      {readOnly || view.validation.valid ? null : (
        <ul aria-label="validation-issues">
          {view.validation.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {message === null ? null : <p role="alert">{message}</p>}

      <h3>Stages</h3>
      <ul aria-label="stage-list">
        {view.stages.map((stage) => (
          <li key={stage.id}>
            <button
              type="button"
              onClick={() => {
                setSelected(stage.id);
                setForm(stage);
              }}
            >
              {stage.title} ({stage.id})
            </button>
            {' '}
            role: {stage.roleId || '-'} | risk: {stage.riskLevel || '-'} | approval:{' '}
            {stage.approvalRequired ? stage.approvalMode : 'none'}
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => void apply([{ op: 'REMOVE_STAGE', stageId: stage.id }])}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {readOnly ? null : (
        <form
          aria-label="stage-form"
          onSubmit={(event) => {
            event.preventDefault();
            const base = [
              {
                op: 'ADD_STAGE',
                stage: { id: form.id, kind: form.kind, title: form.title || form.id, config: {} },
              },
              { op: 'SET_ROLE', stageId: form.id, roleId: form.roleId.length === 0 ? null : form.roleId },
              { op: 'SET_VALIDATOR', stageId: form.id, validatorIds: form.validatorIds },
            ];
            const withRisk =
              form.riskLevel.length === 0
                ? base
                : [...base, { op: 'SET_RISK', stageId: form.id, riskLevel: form.riskLevel }];
            const withApproval = form.approvalMode.length === 0
              ? withRisk
              : [
                  ...withRisk,
                  {
                    op: 'SET_APPROVAL',
                    stageId: form.id,
                    approval: {
                      required: form.approvalRequired,
                      mode: form.approvalMode,
                      ...(form.approvalAuthority.length === 0 ? {} : { authority: form.approvalAuthority }),
                    },
                  },
                ];
            void apply(withApproval);
          }}
        >
          <h3>{view.stages.some((stage) => stage.id === form.id) ? 'Edit stage' : 'Add stage'}</h3>
          <label>
            Stage id
            <input
              value={form.id}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
              required
            />
          </label>
          <label>
            Title
            <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>
          <label>
            Kind
            <input value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} />
          </label>
          <label>
            Role
            <input value={form.roleId} onChange={(event) => setForm({ ...form, roleId: event.target.value })} />
          </label>
          <label>
            Validators (comma separated)
            <input
              value={form.validatorIds.join(',')}
              onChange={(event) =>
                setForm({
                  ...form,
                  validatorIds: event.target.value
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0),
                })
              }
            />
          </label>
          <label>
            Risk
            <select
              value={form.riskLevel}
              onChange={(event) => setForm({ ...form, riskLevel: event.target.value })}
            >
              <option value="">(unset)</option>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </label>
          <label>
            Approval
            <select
              value={form.approvalMode}
              onChange={(event) => setForm({ ...form, approvalMode: event.target.value })}
            >
              <option value="">(none)</option>
              <option value="auto">auto</option>
              <option value="owner">owner</option>
              <option value="authority">authority</option>
            </select>
          </label>
          <label>
            Approval required
            <input
              type="checkbox"
              checked={form.approvalRequired}
              onChange={(event) => setForm({ ...form, approvalRequired: event.target.checked })}
            />
          </label>
          <label>
            Authority
            <input
              value={form.approvalAuthority}
              onChange={(event) => setForm({ ...form, approvalAuthority: event.target.value })}
            />
          </label>
          <button type="submit">Apply stage</button>
          <button
            type="button"
            onClick={() => {
              setForm(emptyStage());
              setSelected('');
            }}
          >
            New stage
          </button>
        </form>
      )}

      <h3>Connections</h3>
      <ul aria-label="edge-list">
        {view.edges.map((edge) => (
          <li key={`${edge.from}->${edge.to}`}>
            {edge.from} -&gt; {edge.to}
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => void apply([{ op: 'DISCONNECT_STAGE', from: edge.from, to: edge.to }])}
              >
                Disconnect
              </button>
            )}
          </li>
        ))}
      </ul>

      {readOnly ? null : (
        <form
          aria-label="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            void apply([{ op: 'CONNECT_STAGE', from: edgeFrom, to: edgeTo }]);
          }}
        >
          <label>
            From
            <input value={edgeFrom} onChange={(event) => setEdgeFrom(event.target.value)} />
          </label>
          <label>
            To
            <input value={edgeTo} onChange={(event) => setEdgeTo(event.target.value)} />
          </label>
          <button type="submit">Connect</button>
        </form>
      )}

      {readOnly ? null : (
        <section aria-label="draft-actions">
          <h3>Draft actions</h3>
          <label>
            Change rationale
            <input value={rationale} onChange={(event) => setRationale(event.target.value)} />
          </label>
          <button
            type="button"
            onClick={() =>
              void bridge
                .workflowRequest({
                  operation: 'draft.validate',
                  requestId: nextRequestId(),
                  payload: { templateId },
                })
                .then((value) => {
                  const response = asResponse(value);
                  setMessage(response.ok ? 'Validation OK.' : errorText(response));
                })
            }
          >
            Validate
          </button>
          <button type="button" onClick={() => void submitReview()}>
            Submit for Review
          </button>
          <button type="button" onClick={() => void publish()}>
            Publish
          </button>
          {view.state === 'published' ? (
            <button
              type="button"
              onClick={() =>
                void apply([{ op: 'ADD_STAGE', stage: { id: `s${String(view.stages.length + 1)}`, kind: 'pack-a:step', title: 'New stage', config: {} } }])
              }
            >
              Start revision (draft)
            </button>
          ) : null}
        </section>
      )}
      {readOnly && view.state === 'published' ? (
        <p>
          To change a published workflow: submit a Change Proposal (review.submit), let a second person accept it,
          then open a revision - or Fork it into a new draft.
        </p>
      ) : null}
    </section>
  );
}
