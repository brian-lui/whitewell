// The travel screen describes each city as you'll find it when you land: a trip out
// takes a month, and heat cools and temporary effects run out on the way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNode } from './browser.js';
import { App } from '../js/ui.js';
import { quietConfig, newGame, drain, loadText } from './helpers.js';

const text = loadText();

// Open the travel screen and read a city's option: the BIS checks level it shows
// (a customsLevels id) and whether you can pick it.
function travelOption(g, port) {
  const app = new App(new FakeNode('div'), g.config, text);
  app.game = g;
  app.go('travel');
  const buttons = app.actionsEl.childNodes.flatMap((group) => group.childNodes);
  const button = buttons.find((b) => b.textContent.includes(app.portName(port)));
  assert.ok(button, `no travel option for ${port}`);
  const level = Object.keys(text.customsLevels)
    .find((id) => button.textContent.includes(app.t('travel.option', { port, level: app.t(`customsLevels.${id}`) })));
  return { level, disabled: 'disabled' in button.attributes };
}

// ---------- BIS checks level ----------

test('the BIS checks level on the travel screen allows for your heat cooling on the way', () => {
  const g = newGame(quietConfig((c) => {
    c.heat.inspectionPerPoint = 0.004;
    c.heat.monthlyDecay = 4;
    c.ports.find((p) => p.id === 'singapore').inspection = 0.25;
  }));
  drain(g);
  g.state.heat = 15; // 25% + 15 × 0.4% = 31% today (frequent); 11 heat on landing: 29.4% (occasional)
  assert.equal(g.customsLevel('singapore'), 'strict', 'frequent today');
  assert.equal(travelOption(g, 'singapore').level, 'normal');
  g.travel('singapore');
  assert.equal(g.customsLevel('singapore'), 'normal', 'and occasional when you land, as shown');
});

const probe = (months) => quietConfig((c) => {
  c.ports.find((p) => p.id === 'singapore').inspection = 0.1;
  c.politics.events = [{ id: 'transshipment_probe', kind: 'inspection', port: 'singapore', value: [0.3, 0.3], months: [months, months] }];
});

test('the BIS checks level on the travel screen leaves out a crackdown that ends on the way', () => {
  const g = newGame(probe(1));
  g.triggerEvent('transshipment_probe'); drain(g);
  assert.equal(g.customsLevel('singapore'), 'strict', '40% today');
  assert.equal(travelOption(g, 'singapore').level, 'lax');
  g.travel('singapore');
  assert.equal(g.customsLevel('singapore'), 'lax', 'back to 10% when you land, as shown');
});

test('the BIS checks level on the travel screen keeps a crackdown that lasts past your arrival', () => {
  const g = newGame(probe(2));
  g.triggerEvent('transshipment_probe'); drain(g);
  assert.equal(travelOption(g, 'singapore').level, 'strict');
  g.travel('singapore');
  assert.equal(g.customsLevel('singapore'), 'strict');
});

// ---------- closures ----------

const lockdown = (months) => quietConfig((c) => {
  c.politics.events = [{ id: 'lockdown', kind: 'closure', port: 'singapore', months: [months, months] }];
});

test('you can set off for a city that reopens before you land', () => {
  const g = newGame(lockdown(1));
  g.triggerEvent('lockdown'); drain(g);
  assert.ok(g.isClosed('singapore'), 'closed today');
  const option = travelOption(g, 'singapore');
  assert.equal(option.disabled, false, 'but you can pick it on the travel screen');
  assert.notEqual(option.level, 'closed', 'which does not call it closed');
  assert.ok(g.travel('singapore').ok);
  const steps = drain(g);
  assert.ok(!steps.some((s) => s.data?.key === 'voyage.diverted'), 'no diversion');
  assert.equal(g.state.port, 'singapore', 'and you land there');
});

test('a city that stays closed past your arrival is still off limits', () => {
  const g = newGame(lockdown(2));
  g.triggerEvent('lockdown'); drain(g);
  const option = travelOption(g, 'singapore');
  assert.equal(option.disabled, true);
  assert.equal(option.level, 'closed');
  assert.equal(g.travel('singapore').error, 'errors.portClosed');
});
