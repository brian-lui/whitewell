import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../js/ui.js';
import { quietConfig, newGame, drain } from './helpers.js';

// The cargo warning the travel screen shows next to a city.
const travelWarning = (g, port) => App.prototype.cargoRisk.call({ game: g }, port);

// A trip abroad takes a month. Z200 is restricted in Shenzhen until this ban
// takes effect, one month after the game starts: while you're on the way.
const banNextMonth = () => quietConfig((c) => {
  c.exportControls.rules = [{ id: 'z200_ban_china', start: '2024-04', port: ['shenzhen', 'shanghai', 'beijing'], good: 'z200', legality: 'contraband' }];
});
const z200Licenses = (months) => quietConfig((c) => {
  c.politics.events = [{ id: 'z200_licenses', kind: 'legality', port: ['shenzhen', 'shanghai', 'beijing'], good: 'z200', legality: 'legal', months: [months, months] }];
});

test('travel warnings use the export rules in force when you land, not when you leave', () => {
  const g = newGame(banNextMonth());
  drain(g);
  g.state.hold.z200 = 10;
  assert.equal(g.legality('shenzhen', 'z200'), 'restricted', 'restricted today');
  assert.equal(travelWarning(g, 'shenzhen'), 'contraband');
  g.travel('shenzhen'); drain(g);
  assert.equal(g.state.port, 'shenzhen');
  assert.equal(g.legality('shenzhen', 'z200'), 'contraband', 'and banned on arrival, as warned');
});

test('travel warnings ignore rules announced for after you land', () => {
  const g = newGame(quietConfig((c) => {
    c.exportControls.rules = [{ id: 'z200_ban_china', start: '2024-05', port: ['shenzhen', 'shanghai', 'beijing'], good: 'z200', legality: 'contraband' }];
  }));
  drain(g);
  g.state.hold.z200 = 10;
  assert.equal(travelWarning(g, 'shenzhen'), 'restricted');
});

test('travel warnings know when a temporary legality change runs out before you land', () => {
  const g = newGame(z200Licenses(1));
  g.triggerEvent('z200_licenses'); drain(g);
  g.state.hold.z200 = 10;
  assert.equal(g.legality('shenzhen', 'z200'), 'legal', 'licensed this month only');
  assert.equal(travelWarning(g, 'shenzhen'), 'restricted');
  g.travel('shenzhen'); drain(g);
  assert.equal(g.legality('shenzhen', 'z200'), 'restricted', 'the license ran out on the way, as warned');
});

test('travel warnings keep a temporary legality change that lasts past your arrival', () => {
  const g = newGame(z200Licenses(2));
  g.triggerEvent('z200_licenses'); drain(g);
  g.state.hold.z200 = 10;
  assert.equal(travelWarning(g, 'shenzhen'), null);
  g.travel('shenzhen'); drain(g);
  assert.equal(g.legality('shenzhen', 'z200'), 'legal');
});

test('a temporary license expiring on the way does not hide a ban that starts on the way', () => {
  const g = newGame(z200Licenses(1));
  g.config.exportControls.rules = [];
  g.rules = [{ id: 'z200_ban_china', start: '2024-04', month: 1, port: ['shenzhen', 'shanghai', 'beijing'], good: 'z200', legality: 'contraband' }];
  g.triggerEvent('z200_licenses'); drain(g);
  g.state.hold.z200 = 10;
  assert.equal(g.legality('shenzhen', 'z200'), 'legal', 'licensed this month');
  assert.equal(travelWarning(g, 'shenzhen'), 'contraband');
  g.travel('shenzhen'); drain(g);
  assert.equal(g.legality('shenzhen', 'z200'), 'contraband');
});
