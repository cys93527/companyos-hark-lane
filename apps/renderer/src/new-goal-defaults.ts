/**
 * UI-AUDIT-3 — the default access policy for NEW Goals, chosen in 设置 → 新目标默认 (moved out
 * of the composer, where it was rarely changed per message).
 *
 * This is a UI preference, not authority: the value is only the policy the next goal.create
 * REQUESTS; the main process binds it canonically at create time and enforces it during
 * execution, and the Goal page reads it back from canonical state. An unreadable or unknown
 * stored value falls back to ASK_PERMISSION (the safest policy that still runs).
 */
import type { DraftStorage } from './local-draft-store.js';

export type NewGoalPolicy = 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS';
export const NEW_GOAL_POLICY_KEY = 'companyos.new-goal-defaults.v1:accessPolicy';
const POLICIES: readonly NewGoalPolicy[] = ['ASK_PERMISSION', 'READ_ONLY', 'WORKSPACE_OPERATIONS'];

export const readDefaultPolicy = (storage: Pick<DraftStorage, 'getItem'> | null): NewGoalPolicy => {
  try {
    const raw = storage?.getItem(NEW_GOAL_POLICY_KEY) ?? null;
    return POLICIES.find((policy) => policy === raw) ?? 'ASK_PERMISSION';
  } catch {
    return 'ASK_PERMISSION';
  }
};

export const writeDefaultPolicy = (storage: Pick<DraftStorage, 'setItem'> | null, policy: NewGoalPolicy): boolean => {
  if (storage === null || !POLICIES.includes(policy)) return false;
  try {
    storage.setItem(NEW_GOAL_POLICY_KEY, policy);
    return true;
  } catch {
    return false;
  }
};
