/**
 * DRA-05 test support — a MINIMAL DOM that lets the renderer tests mount REAL React
 * components (real roots, real effects) in the plain node test environment, with NO
 * new dependency added (the repository ships no jsdom/happy-dom and this fix is not
 * allowed to introduce one).
 *
 * It implements exactly the host surface react-dom touches for mounting, updating,
 * text commits, removal, and delegated event dispatch: Element/Text/Comment nodes,
 * attributes/className/style, ownerDocument/documentElement/body, an event-target
 * mixin with capture/bubble registration, and a window facade whose timers delegate
 * to the CURRENT globals (so vitest fake timers stay in control).
 *
 * Installing happens at module-eval; the importing test file lists this module
 * BEFORE `react-dom` so the globals exist when react-dom's feature detection runs.
 */

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;

type Listener = (event: unknown) => void;

class MiniEventTarget {
  private readonly listeners = new Map<string, { capture: Set<Listener>; bubble: Set<Listener> }>();

  addEventListener(type: string, listener: Listener, options?: unknown): void {
    const capture =
      options === true ||
      (typeof options === 'object' && options !== null && (options as { capture?: unknown }).capture === true);
    let bucket = this.listeners.get(type);
    if (bucket === undefined) {
      bucket = { capture: new Set(), bubble: new Set() };
      this.listeners.set(type, bucket);
    }
    (capture ? bucket.capture : bucket.bubble).add(listener);
  }

  removeEventListener(type: string, listener: Listener, options?: unknown): void {
    const capture =
      options === true ||
      (typeof options === 'object' && options !== null && (options as { capture?: unknown }).capture === true);
    this.listeners.get(type)?.[capture ? 'capture' : 'bubble'].delete(listener);
  }

  /** Capture listeners first (root→target), then bubble listeners (target→root). */
  dispatchListenersFor(type: string, target: MiniNode, event: Record<string, unknown>): void {
    const path: MiniNode[] = [];
    for (let node: MiniNode | null = target; node !== null; node = node.parentNode) path.push(node);
    for (const node of [...path].reverse()) {
      for (const listener of [...(node.listenersFor(type)?.capture ?? [])]) listener(event);
    }
    for (const node of path) {
      for (const listener of [...(node.listenersFor(type)?.bubble ?? [])]) listener(event);
    }
  }

  protected listenersFor(type: string): { capture: Set<Listener>; bubble: Set<Listener> } | undefined {
    return this.listeners.get(type);
  }
}

export class MiniStyle {
  [key: string]: unknown;
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: unknown): void {
    this.properties.set(name, String(value));
  }
  removeProperty(name: string): void {
    this.properties.delete(name);
  }
  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? '';
  }
  get cssText(): string {
    return [...this.properties.entries()].map(([name, value]) => `${name}: ${value}`).join('; ');
  }
  set cssText(value: string) {
    this.properties.clear();
    void value;
  }
}

export class MiniDocument extends MiniEventTarget {
  readonly nodeType = DOCUMENT_NODE;
  readonly nodeName = '#document';
  readonly documentElement: MiniElement;
  readonly head: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement | null = null;
  defaultView: unknown = null;
  ownerDocument: MiniDocument = this;

  constructor() {
    super();
    this.documentElement = new MiniElement('html', this);
    this.head = this.documentElement.appendChild(new MiniElement('head', this));
    this.body = this.documentElement.appendChild(new MiniElement('body', this));
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName, this);
  }
  createElementNS(namespaceURI: string | null, tagName: string): MiniElement {
    return new MiniElement(tagName, this, namespaceURI);
  }
  createTextNode(text: string): MiniText {
    return new MiniText(text, this);
  }
  createComment(text: string): MiniComment {
    return new MiniComment(text, this);
  }
  contains(node: MiniNode | null): boolean {
    return node !== null && (node === (this as unknown as MiniNode) || this.documentElement.contains(node));
  }
}

export class MiniNode extends MiniEventTarget {
  readonly nodeType: number;
  readonly ownerDocument: MiniDocument;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];

  constructor(nodeType: number, ownerDocument: MiniDocument) {
    super();
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): MiniNode | null {
    const parent = this.parentNode;
    if (parent === null) return null;
    return parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
  }

  appendChild<T extends MiniNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends MiniNode>(child: T, before: MiniNode | null): T {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(child);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild<T extends MiniNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }
  contains(node: MiniNode | null): boolean {
    for (let current: MiniNode | null = node; current !== null; current = current.parentNode) {
      if (current === (this as unknown as MiniNode)) return true;
    }
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value));
  }
}

export class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly nodeName: string;
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly attributes = new Map<string, string>();
  readonly style = new MiniStyle();
  nodeValue: null = null;

  constructor(tagName: string, ownerDocument: MiniDocument, namespaceURI: string | null = null) {
    super(ELEMENT_NODE, ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.localName = tagName.toLowerCase();
    this.namespaceURI = namespaceURI;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  get id(): string {
    return this.attributes.get('id') ?? '';
  }
  set id(value: string) {
    this.setAttribute('id', value);
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
}

export class MiniText extends MiniNode {
  readonly nodeName = '#text';
  nodeValue: string | null;

  constructor(text: string, ownerDocument: MiniDocument) {
    super(TEXT_NODE, ownerDocument);
    this.nodeValue = text;
  }
  get data(): string {
    return this.nodeValue ?? '';
  }
  set data(value: string) {
    this.nodeValue = value;
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(value: string) {
    this.nodeValue = value;
  }
}

export class MiniComment extends MiniNode {
  private data: string;
  readonly nodeName = '#comment';

  constructor(text: string, ownerDocument: MiniDocument) {
    super(COMMENT_NODE, ownerDocument);
    this.data = text;
  }
  get nodeValue(): string {
    return this.data;
  }
  set nodeValue(value: string | null) {
    this.data = value ?? '';
  }
  override get textContent(): string {
    return '';
  }
  override set textContent(value: string) {
    void value;
  }
}

export interface MiniWindow {
  readonly document: MiniDocument;
  /** react-dom's getActiveElementDeep does `element instanceof view.HTMLIFrameElement`. */
  readonly HTMLIFrameElement: unknown;
  addEventListener(type: string, listener: Listener, options?: unknown): void;
  removeEventListener(type: string, listener: Listener, options?: unknown): void;
  setTimeout(handler: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms?: number): unknown;
  clearInterval(handle: unknown): void;
  requestAnimationFrame(handler: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
  getSelection(): null;
}

const installOnce = (root: Record<string, unknown>): MiniDocument => {
  const existing = root['document'];
  if (typeof existing === 'object' && existing !== null) return existing as MiniDocument;
  const document = new MiniDocument();
  const window: MiniWindow = {
    document,
    // No node in this shim is ever an iframe; the class exists so the instanceof check works.
    HTMLIFrameElement: class {},
    addEventListener: (type, listener, options) => document.addEventListener(type, listener, options),
    removeEventListener: (type, listener, options) => document.removeEventListener(type, listener, options),
    // Delegated at CALL time, so vitest fake timers keep control.
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as never),
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as never),
    requestAnimationFrame: (handler) => globalThis.setTimeout(handler, 16),
    cancelAnimationFrame: (handle) => globalThis.clearTimeout(handle as never),
    getSelection: () => null,
  };
  document.defaultView = window;
  root['document'] = document;
  root['window'] = window;
  root['IS_REACT_ACT_ENVIRONMENT'] = true;
  return document;
};

export const miniDocument: MiniDocument = installOnce(globalThis as unknown as Record<string, unknown>);
export const miniWindow = miniDocument.defaultView as MiniWindow;

/** Create a detached container appended to <body> (the react-dom root container). */
export const createContainer = (): MiniElement => miniDocument.body.appendChild(miniDocument.createElement('div'));

export const removeContainer = (container: MiniElement): void => {
  miniDocument.body.removeChild(container);
};

/**
 * Dispatch a minimal event the way a browser would: capture listeners root→target,
 * then bubble listeners target→root (react-dom delegates at the root container, so
 * each of its two phase listeners fires exactly once).
 */
export const dispatchMiniEvent = (target: MiniElement, type: string): void => {
  const event: Record<string, unknown> = {
    type,
    target,
    currentTarget: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    isTrusted: false,
    timeStamp: 0,
    preventDefault(): void {
      event['defaultPrevented'] = true;
    },
    stopPropagation(): void {},
    stopImmediatePropagation(): void {},
    persist(): void {},
    getModifierState(): boolean {
      return false;
    },
  };
  (target as unknown as MiniEventTarget).dispatchListenersFor(type, target, event);
};

/** All elements under (and including) `root` whose own text matches `text`. */
export const elementsWithText = (root: MiniNode, text: string): readonly MiniElement[] => {
  const found: MiniElement[] = [];
  const walk = (node: MiniNode): void => {
    if (node instanceof MiniElement && node.textContent.includes(text)) found.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return found;
};

/** The DEEPEST element carrying `text` that has a click handler reachable from it. */
export const clickableWithText = (root: MiniNode, text: string): MiniElement | null => {
  const matches = elementsWithText(root, text).filter((element) => element.tagName === 'BUTTON');
  return matches[matches.length - 1] ?? null;
};
