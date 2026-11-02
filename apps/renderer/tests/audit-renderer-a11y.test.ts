/**
 * AUDIT-R14: accessible names are Chinese (screen readers announced English slugs such as
 * "goal-objective"); test selectors live on data-testid; a popover dialog takes focus and closes
 * on Escape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { popoverDialogProps } from '../src/composer.js';

const srcDir = join(__dirname, '../src');
const sources = readdirSync(srcDir)
  .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
  .map((name) => ({ name, text: readFileSync(join(srcDir, name), 'utf8') }));

describe('AUDIT-R14 accessible names', () => {
  it('no aria-label in the renderer is an English slug', () => {
    const offenders: string[] = [];
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/aria-label['"]?\s*[:=]\s*['"]([^'"]*)['"]/g)) {
        if (/^[a-z0-9-]+$/.test(match[1] ?? '')) offenders.push(`${name}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('inputs wrapped in a visible <label> carry no overriding aria-label', () => {
    const app = sources.find((s) => s.name === 'App.tsx')!.text;
    expect(app).toMatch(/h\('label', null, '相对文件路径', h\('input', \{ value: deliveryPath, 'data-testid': 'delivery-path', onChange/);
    expect(app).toMatch(/h\('textarea', \{ value: deliveryText, 'data-testid': 'delivery-content', onChange/);
  });

  it('the goal objective textarea is announced in Chinese', () => {
    const composer = sources.find((s) => s.name === 'composer.tsx')!.text;
    expect(composer).toContain("'data-testid': 'goal-objective', 'aria-label': '目标描述'");
  });

  it('popover dialogs focus on open and close on Escape', () => {
    let closed = 0;
    let focused = 0;
    const props = popoverDialogProps(() => { closed += 1; });
    expect(props.tabIndex).toBe(-1);
    props.ref({ focus: () => { focused += 1; } });
    props.ref(null);
    expect(focused).toBe(1);
    props.onKeyDown({ key: 'Enter' });
    expect(closed).toBe(0);
    props.onKeyDown({ key: 'Escape' });
    expect(closed).toBe(1);
    const composer = sources.find((s) => s.name === 'composer.tsx')!.text;
    expect(composer.match(/role: 'dialog'[^\n]*\.\.\.popoverDialogProps\(/g)?.length).toBe(3);
  });
});
