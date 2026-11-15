import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../js/engine.js';
import { App } from '../js/ui.js';
import { quietConfig, loadText } from './helpers.js';

// Just enough of a browser for the UI to render into. Hidden nodes show no text.
class FakeNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.childNodes = []; this.className = ''; this.hidden = false; this.value = ''; }
  setAttribute() {}
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
const store = {
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

const config = quietConfig();
const text = loadText();

test('the player is warned while progress is not being saved, until a save works again', () => {
  const root = new FakeNode('div');
  const app = new App(root, config, text);

  // Storage stops working. The player starts a game.
  store.broken = true;
  app.game = createGame(config, { name: 'Tester', startId: 'steady', seed: 1 });
  assert.equal(app.save(), false, 'save() reports the failure');
  app.go('port');
  assert.ok(text.ui?.saveFailed, 'text.json has a ui.saveFailed warning');
  const warning = app.t('ui.saveFailed');
  assert.ok(root.textContent.includes(warning), 'the warning is on screen');

  // The warning stays up as the player moves between screens.
  app.go('regulations');
  assert.ok(root.textContent.includes(warning), 'the warning is still on screen on the next screen');
  app.go('news');
  assert.ok(root.textContent.includes(warning), 'and the one after');

  // Storage works again. The next save clears the warning.
  store.broken = false;
  app.apply({ ok: true }, null, { name: 'port' });
  assert.ok(!root.textContent.includes(warning), 'the warning is gone after a save works');
  assert.equal(app.save(), true, 'save() reports success');
  assert.equal(JSON.parse(store.getItem('whitewell.save')).name, 'Tester', 'and the game really was saved');
});
