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
  const [notice, setNotice] = useState('本地未提交草稿（LOCAL_DRAFT）；保存不会创建任务或执行 AI。');
  const [failed, setFailed] = useState(false);
  const { companyId, workspaceRoot, onRestore } = props;
  useLayoutEffect(() => {
    // Clear old editor contents before paint; never carry one Workspace's draft into another.
    onRestore('');
    setFailed(false);
    if (workspaceRoot === null) { setNotice('选择工作区后可保存本地未提交草稿。'); return; }
    try {
      const record = store.load(companyId, workspaceRoot);
      onRestore(record?.objective ?? '');
      setNotice(record === null ? '本地未提交草稿（LOCAL_DRAFT）；保存不会执行 AI。' : '已恢复本地未提交草稿（LOCAL_DRAFT），尚未提交或执行。');
    } catch { setFailed(true); setNotice('读取草稿失败；未提交、未执行。'); }
  }, [store, companyId, workspaceRoot, onRestore]);
  const restore = () => {
    if (workspaceRoot === null || props.busy) return;
    try {
      const record = store.load(companyId, workspaceRoot);
      onRestore(record?.objective ?? '');
      setFailed(false); setNotice(record === null ? '当前工作区没有已保存草稿。' : '已恢复本地未提交草稿（LOCAL_DRAFT），尚未执行。');
    } catch { setFailed(true); setNotice('读取草稿失败；未提交、未执行。'); }
  };
  const save = () => {
    if (workspaceRoot === null || props.busy) return;
    try {
      store.save(companyId, workspaceRoot, props.objective);
      setFailed(false); setNotice('已保存本地未提交草稿（LOCAL_DRAFT）；未创建 Goal，未开始执行。');
    } catch { setFailed(true); setNotice('保存失败：存储不可用、内容过长或包含凭据；未提交、未执行。'); }
  };
  return h('section', { 'aria-label': 'local-draft' },
    h('button', { type: 'button', disabled: props.busy || workspaceRoot === null, onClick: save }, '保存草稿'),
    h('button', { type: 'button', disabled: props.busy || workspaceRoot === null, onClick: restore }, '恢复草稿'),
    h('p', { role: failed ? 'alert' : 'status' }, notice));
}
