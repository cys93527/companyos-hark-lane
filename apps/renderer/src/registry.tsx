/**
 * Minimal Model Registry UI (Sprint 7 section: "Registry UI minimal list").
 *
 * It reads and writes ONLY through the preload bridge (one IPC operation at a time) and
 * shows exactly what the registry returns: model key, provider binding, capability
 * profile, context window, price, availability. No routing, no "recommended model", no
 * local cache that could drift from the registry (Sprint 7 test P).
 */
import { useCallback, useEffect, useState, type JSX } from 'react';

import type { WorkflowBridge } from './designer.js';

interface Response {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ModelRow {
  readonly modelKey: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly providerModelId: string;
  readonly availability: string;
  readonly enabled: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number | null;
  readonly capabilities: readonly string[];
  readonly price: string;
}

const asResponse = (value: unknown): Response =>
  typeof value === 'object' && value !== null ? (value as Response) : { ok: false, error: { code: 'IPC', message: 'no response' } };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asText = (value: unknown, fallback = '-'): string => (typeof value === 'string' && value.length > 0 ? value : fallback);

/** Comma-separated input -> normalized list (the IPC layer validates it again). */
const splitList = (value: string): readonly string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asBool = (value: unknown): boolean => value === true;

const capabilityLabels = (capabilities: Record<string, unknown>): readonly string[] => {
  const labels: string[] = [];
  if (asBool(capabilities['streaming'])) labels.push('stream');
  if (asBool(capabilities['structuredOutput'])) labels.push('json');
  if (asBool(capabilities['toolCalling'])) labels.push('tools');
  if (asBool(capabilities['vision'])) labels.push('vision');
  if (asBool(capabilities['reasoning'])) labels.push('reasoning');
  if (asBool(capabilities['audio'])) labels.push('audio');
  return labels;
};

const priceLabel = (pricing: Record<string, unknown>): string => {
  const input = pricing['inputPerMillion'];
  const output = pricing['outputPerMillion'];
  const currency = asText(pricing['currency'], '?');
  if (typeof input !== 'number' && typeof output !== 'number') return 'unpublished';
  return `${currency} ${input === null || input === undefined ? '?' : String(input)} / ${output === null || output === undefined ? '?' : String(output)} per 1M`;
};

/** Pure projection: the registry's payload, reshaped for display. */
export const toModelRows = (response: unknown): readonly ModelRow[] => {
  if (!Array.isArray(response)) return [];
  return response.map((entry) => {
    const record = asRecord(entry);
    return {
      modelKey: asText(record['modelKey']),
      displayName: asText(record['displayName']),
      providerId: asText(record['providerId']),
      providerModelId: asText(record['providerModelId']),
      availability: asText(record['availability'], 'unknown'),
      enabled: asBool(record['enabled']),
      contextWindow: asNumber(record['contextWindow']),
      maxOutputTokens: typeof record['maxOutputTokens'] === 'number' ? asNumber(record['maxOutputTokens']) : null,
      capabilities: capabilityLabels(asRecord(record['capabilities'])),
      price: priceLabel(asRecord(record['pricing'])),
    };
  });
};

let counter = 0;
const nextRequestId = (): string => {
  counter += 1;
  return `reg_${String(counter)}`;
};

export function ModelRegistry(props: { readonly bridge: WorkflowBridge }): JSX.Element {
  const { bridge } = props;
  const [rows, setRows] = useState<readonly ModelRow[]>([]);
  const [includeDisabled, setIncludeDisabled] = useState(true);
  const [alias, setAlias] = useState('');
  const [aliasTarget, setAliasTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  /* Sprint 7.5: Model Selection Mode (configuration only - no router exists). */
  const [mode, setMode] = useState<'MANUAL' | 'AUTO' | 'HYBRID'>('MANUAL');
  const [manualModelKey, setManualModelKey] = useState('');
  const [allowedModels, setAllowedModels] = useState('');
  const [preferredModels, setPreferredModels] = useState('');
  const [blockedModels, setBlockedModels] = useState('');
  const [allowedProviders, setAllowedProviders] = useState('');
  const [requiredCapabilities, setRequiredCapabilities] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [maxLatency, setMaxLatency] = useState('');
  const [fallback, setFallback] = useState<'NEVER' | 'ASK' | 'AUTO_WITHIN_POLICY'>('NEVER');
  const [explanation, setExplanation] = useState<readonly string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'models.list',
        requestId: nextRequestId(),
        payload: { includeDisabled },
      }),
    );
    if (response.ok) setRows(toModelRows(response.value));
    else setMessage(`${response.error?.code ?? 'IPC'}: ${response.error?.message ?? 'failed'}`);
  }, [bridge, includeDisabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (modelKey: string, enabled: boolean): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: enabled ? 'models.disable' : 'models.enable',
        requestId: nextRequestId(),
        payload: { modelKey, actorId: 'user_owner' },
      }),
    );
    setMessage(response.ok ? null : `${response.error?.code ?? 'IPC'}: ${response.error?.message ?? 'failed'}`);
    await refresh();
  };

  const bind = async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'models.alias',
        requestId: nextRequestId(),
        payload: { alias, modelKey: aliasTarget, scope: 'default', actorId: 'user_owner' },
      }),
    );
    setMessage(response.ok ? `alias ${alias} bound` : `${response.error?.code ?? 'IPC'}: ${response.error?.message ?? 'failed'}`);
    await refresh();
  };

  const savePolicy = async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'models.policy',
        requestId: nextRequestId(),
        payload: {
          actorId: 'user_owner',
          scopeType: 'ROLE',
          scopeId: 'developer',
          mode,
          manualModelKey: manualModelKey.length === 0 ? null : manualModelKey,
          allowedModels: splitList(allowedModels),
          preferredModels: splitList(preferredModels),
          blockedModels: splitList(blockedModels),
          allowedProviders: splitList(allowedProviders),
          requiredCapabilities: splitList(requiredCapabilities),
          maxCost: maxCost.length === 0 ? null : Number(maxCost),
          maxLatency: maxLatency.length === 0 ? null : Number(maxLatency),
          allowFallback: fallback,
        },
      }),
    );
    setMessage(response.ok ? 'Selection policy saved.' : `${response.error?.code ?? 'IPC'}: ${response.error?.message ?? 'failed'}`);
  };

  const explainChoice = async (): Promise<void> => {
    const response = asResponse(
      await bridge.workflowRequest({
        operation: 'models.policy.explain',
        requestId: nextRequestId(),
        payload: {
          modelKey: manualModelKey,
          scopes: [{ scopeType: 'ROLE', scopeId: 'developer' }],
          explicit: true,
        },
      }),
    );
    if (!response.ok) {
      setExplanation([`${response.error?.code ?? 'IPC'}: ${response.error?.message ?? 'failed'}`]);
      return;
    }
    const verdict = asRecord(response.value);
    const refusals = Array.isArray(verdict['reasons']) ? (verdict['reasons'] as readonly string[]) : [];
    setExplanation(
      verdict['accepted'] === true
        ? ['Accepted: the explicitly chosen model satisfies every applicable rule.']
        : refusals.map((reason) => `Refused: ${reason}`),
    );
  };

  return (
    <section aria-label="model-registry">
      <p>
        <label>
          <input
            type="checkbox"
            checked={includeDisabled}
            onChange={(event) => setIncludeDisabled(event.target.checked)}
          />
          Show disabled models
        </label>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </p>
      {message === null ? null : <p role="alert">{message}</p>}
      <table aria-label="model-registry-table">
        <thead>
          <tr>
            <th>Model Key</th>
            <th>Name</th>
            <th>Provider Binding</th>
            <th>Capabilities</th>
            <th>Context</th>
            <th>Max Output</th>
            <th>Price</th>
            <th>Availability</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.modelKey}>
              <td>{row.modelKey}</td>
              <td>{row.displayName}</td>
              <td>
                {row.providerId} / {row.providerModelId}
              </td>
              <td>{row.capabilities.join(', ') || '-'}</td>
              <td>{row.contextWindow}</td>
              <td>{row.maxOutputTokens ?? '-'}</td>
              <td>{row.price}</td>
              <td>{row.availability}</td>
              <td>
                <button type="button" onClick={() => void toggle(row.modelKey, row.enabled)}>
                  {row.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" onClick={() => setAliasTarget(row.modelKey)}>
                  Use as alias target
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        aria-label="alias-form"
        onSubmit={(event) => {
          event.preventDefault();
          void bind();
        }}
      >
        <label>
          Alias
          <input value={alias} onChange={(event) => setAlias(event.target.value)} />
        </label>
        <label>
          Target model key
          <input value={aliasTarget} onChange={(event) => setAliasTarget(event.target.value)} />
        </label>
        <button type="submit">Bind alias</button>
      </form>
      <p>
        Aliases resolve to exactly one model. There is no automatic selection, no scoring and no fallback: if
        the bound model is disabled or unavailable, the request is refused.
      </p>

      <section aria-label="selection-mode">
        <h3>Model Selection Mode</h3>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void savePolicy();
          }}
        >
          {(['MANUAL', 'AUTO', 'HYBRID'] as const).map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="selection-mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
              />
              {option === 'MANUAL' ? 'Manual' : option === 'AUTO' ? 'Auto' : 'Hybrid'}
            </label>
          ))}

          {mode === 'MANUAL' ? (
            <div>
              <label>
                Model
                <select value={manualModelKey} onChange={(event) => setManualModelKey(event.target.value)}>
                  <option value="">(choose a registered model)</option>
                  {rows.map((row) => (
                    <option key={row.modelKey} value={row.modelKey}>
                      {row.modelKey} - {row.capabilities.join('/') || 'no capabilities'} - {row.availability} -{' '}
                      {row.contextWindow} tokens - {row.price}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => void explainChoice()}>
                Check this choice
              </button>
            </div>
          ) : null}

          {mode === 'HYBRID' ? (
            <div>
              <label>
                Allowed Models (comma separated)
                <input value={allowedModels} onChange={(event) => setAllowedModels(event.target.value)} />
              </label>
              <label>
                Preferred Models
                <input value={preferredModels} onChange={(event) => setPreferredModels(event.target.value)} />
              </label>
              <label>
                Blocked Models
                <input value={blockedModels} onChange={(event) => setBlockedModels(event.target.value)} />
              </label>
              <label>
                Allowed Providers
                <input value={allowedProviders} onChange={(event) => setAllowedProviders(event.target.value)} />
              </label>
              <label>
                Required Capabilities
                <input
                  value={requiredCapabilities}
                  onChange={(event) => setRequiredCapabilities(event.target.value)}
                />
              </label>
              <label>
                Max Cost (per 1M input)
                <input value={maxCost} onChange={(event) => setMaxCost(event.target.value)} />
              </label>
              <label>
                Max Latency (ms)
                <input value={maxLatency} onChange={(event) => setMaxLatency(event.target.value)} />
              </label>
            </div>
          ) : null}

          {mode === 'AUTO' ? (
            <p role="note">
              Router will decide within policy. No router is implemented yet, so an AUTO policy is saved as
              configuration and never executed automatically.
            </p>
          ) : null}

          <label>
            Fallback Policy
            <select
              value={fallback}
              onChange={(event) => setFallback(event.target.value as 'NEVER' | 'ASK' | 'AUTO_WITHIN_POLICY')}
            >
              <option value="NEVER">NEVER - stop if the chosen model fails</option>
              <option value="ASK">ASK - ask me before switching</option>
              <option value="AUTO_WITHIN_POLICY">AUTO_WITHIN_POLICY - only inside my allowed set</option>
            </select>
          </label>
          <button type="submit">Save selection policy</button>
        </form>
        {explanation.length === 0 ? null : (
          <ul aria-label="policy-explanation">
            {explanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <p>
          A model you choose explicitly is never replaced silently: the system either uses it or tells you why it
          cannot.
        </p>
      </section>
    </section>
  );
}
