// Just enough of a browser for the UI (js/ui.js) to render into, for tests.
// Importing this installs it globally. Node runs each test file in its own
// process, so it only affects the test files that import it.

// Hidden nodes show no text.
export class FakeNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = {}; this.className = ''; this.hidden = false; this.value = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  focus() {}
  select() {}
  get textContent() {
    return this.hidden ? '' : this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join(' ');
  }
}

// Browser storage that can be switched to fail, like a full or disabled localStorage.
export const store = {
  data: new Map(),
  broken: false,
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
  setItem(key, value) {
    if (this.broken) throw new Error('QuotaExceededError: the quota has been exceeded');
    this.data.set(key, String(value));
  },
  removeItem(key) { this.data.delete(key); },
};

globalThis.Node = FakeNode;
globalThis.document = { title: '', createElement: (tag) => new FakeNode(tag), addEventListener() {} };
globalThis.window = { confirm: () => true };
globalThis.localStorage = store;
