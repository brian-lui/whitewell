import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNode, store } from './browser.js';
import { createGame } from '../js/engine.js';
import { App } from '../js/ui.js';
import { quietConfig, loadText } from './helpers.js';

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
