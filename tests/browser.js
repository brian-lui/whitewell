// Just enough of a browser for the UI (js/ui.js) to render into, for tests.
// Importing this installs it globally. Node runs each test file in its own
// process, so it only affects the test files that import it.

// Like a real browser, focus() only works on a focusable element (a button, an input,
// or anything with a tabindex) that is on the page, and an element that is taken off
// the page loses focus: document.activeElement goes back to the body.
// Hidden nodes show no text.
export class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = {};
    this.className = ''; this.hidden = false; this.value = ''; this.listeners = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  get tabIndex() { return 'tabindex' in this.attributes ? Number(this.attributes.tabindex) : FOCUSABLE.has(this.tagName) ? 0 : -1; }
  set tabIndex(v) { this.attributes.tabindex = String(v); }
  get disabled() { return 'disabled' in this.attributes; }
  set disabled(v) { if (v) this.attributes.disabled = ''; else delete this.attributes.disabled; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
  // What the browser does when you press Enter or Space on a focused button, or click it.
  click() { if (!this.disabled) this.dispatch('click'); }
  #adopt(nodes) { for (const n of nodes) if (n instanceof FakeNode) n.parentNode = this; }
  append(...nodes) { this.#adopt(nodes); this.childNodes.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const n of this.childNodes) if (n instanceof FakeNode) n.parentNode = null;
    this.childNodes = nodes;
    this.#adopt(nodes);
  }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  get isConnected() { return document.body.contains(this); }
  focus() {
    const focusable = (FOCUSABLE.has(this.tagName) && !this.disabled) || 'tabindex' in this.attributes;
    if (focusable && this.isConnected) focused = this;
  }
  blur() { if (focused === this) focused = null; }
  select() {}
  get textContent() {
    return this.hidden ? '' : this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
}
const FOCUSABLE = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
let focused = null;

// Browser storage that can be switched to fail, like a full or disabled localStorage:
// for every key (broken), or just some (failing).
export const store = {
  data: new Map(),
  broken: false,
  failing: new Set(),
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  setItem(key, value) {
    if (this.broken || this.failing.has(key)) throw new Error('QuotaExceededError: the quota has been exceeded');
    this.data.set(key, String(value));
  },
  removeItem(key) { this.data.delete(key); },
};

const body = new FakeNode('body');
globalThis.Node = FakeNode;
globalThis.document = {
  title: '',
  body,
  createElement: (tag) => new FakeNode(tag),
  addEventListener() {},
  get activeElement() { return focused?.isConnected ? focused : body; },
};
globalThis.window = { confirm: () => true };
globalThis.localStorage = store;

// A fresh element on the page for an App to render into.
export function mount() {
  const root = new FakeNode('div');
  body.replaceChildren(root);
  return root;
}
