import { createElement as h, useLayoutEffect, useMemo, useState, type JSX } from 'react';
import { browserDraftStorage, createLocalDraftStore } from './local-draft-store.js';

export interface LocalDraftControlsProps {
  readonly companyId: string;
  readonly workspaceRoot: string | null;
  readonly objective: string;
  readonly busy: boolean;
  readonly onRestore: (objective: string) => void;
}

/** Loading/saving editor text has no canonical bridge or submission-controller dependency. */
export function LocalDraftControls(props: LocalDraftControlsProps): JSX.Element {
  const store = useMemo(() => createLocalDraftStore(browserDraftStorage()), []);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const { companyId, workspaceRoot, onRestore } = props;
  useLayoutEffect(() => {
    // Clear old editor contents before paint; never carry one Workspace's draft into another.
    onRestore('');
    setFailed(false);
    if (workspaceRoot === null) { setNotice('选择工作区后可保存草稿。'); return; }
    try {
      const record = store.load(companyId, workspaceRoot);
      onRestore(record?.objective ?? '');
      setNotice(record === null ? '' : '已恢复本地未提交草稿，尚未发送。');
    } catch { setFailed(true); setNotice('读取草稿失败；未提交、未执行。'); }
  }, [store, companyId, workspaceRoot, onRestore]);
  const restore = () => {
    if (workspaceRoot === null || props.busy) return;
    try {
      const record = store.load(companyId, workspaceRoot);
      onRestore(record?.objective ?? '');
      setFailed(false); setNotice(record === null ? '当前工作区没有已保存草稿。' : '已恢复本地未提交草稿，尚未发送。');
    } catch { setFailed(true); setNotice('读取草稿失败；未提交、未执行。'); }
  };
  const save = () => {
    if (workspaceRoot === null || props.busy) return;
    try {
      store.save(companyId, workspaceRoot, props.objective);
      setFailed(false); setNotice('草稿已保存在本机；未发送、未创建目标。');
    } catch { setFailed(true); setNotice('保存失败：存储不可用、内容过长或包含凭据；未提交、未执行。'); }
  };
  return h('section', { 'data-testid': 'local-draft', 'aria-label': '本地草稿' },
    h('button', { type: 'button', disabled: props.busy || workspaceRoot === null, onClick: save }, '保存草稿'),
    h('button', { type: 'button', disabled: props.busy || workspaceRoot === null, onClick: restore }, '恢复草稿'),
    // UI-PAPER-INK: the line speaks only when there is something to say (restored / saved / failed).
    h('p', { role: failed ? 'alert' : 'status', title: '草稿只保存在本机，保存不会创建目标或调用模型' }, notice));
}
