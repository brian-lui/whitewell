// The destination comparison on the travel and load screens: for each foreign city,
// BIS checks, and the estimated price and status of your chips when you'd land there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeNode } from './browser.js';
import { App } from '../js/ui.js';
import { quietConfig, newGame, drain, loadText } from './helpers.js';

const text = loadText();
const CHINA = ['shenzhen', 'shanghai', 'beijing'];
const Z200_BAN_NEXT_MONTH = { id: 'z200_ban_china', start: '2024-04', port: CHINA, good: 'z200', legality: 'contraband' };

// No random price swings, so an estimate should be exact.
const steady = (edit = () => {}) => quietConfig((c) => {
  for (const good of c.goods) good.volatility = 0;
  edit(c);
});

// ---------- the estimate ----------

test('the estimated price is what you get on landing, barring market swings and new events', () => {
  for (const port of ['singapore', 'johor', 'shenzhen']) {
    const g = newGame(steady());
    drain(g);
    const expected = Object.fromEntries(g.goodIds.map((id) => [id, g.indicativePrice(port, id)]));
    g.travel(port); drain(g);
    for (const id of g.goodIds) assert.equal(g.price(id), expected[id], `${id} in ${port}`);
  }
});

test('the estimate allows for a ban that starts on the way: banned chips fetch more', () => {
  const g = newGame(steady((c) => { c.exportControls.rules = [Z200_BAN_NEXT_MONTH]; }));
  drain(g);
  const expected = g.indicativePrice('shenzhen', 'z200');
  assert.ok(expected > g.indicativePrice('shenzhen', 'z200', g.state.month), 'more than the price today');
  g.travel('shenzhen'); drain(g);
  assert.equal(g.price('z200'), expected);
});

test('the estimate allows for price effects that end on the way, and keeps those that last', () => {
  for (const months of [1, 2]) {
    const g = newGame(steady((c) => {
      c.politics.events = [{ id: 'tariffs', kind: 'price', port: 'singapore', good: 'riptide', value: [0.5, 0.5], months: [months, months] }];
    }));
    g.triggerEvent('tariffs'); drain(g);
    const expected = g.indicativePrice('singapore', 'riptide');
    g.travel('singapore'); drain(g);
    assert.equal(g.price('riptide'), expected, `a ${months}-month tariff`);
  }
});

// ---------- the table ----------

const find = (node, match) => {
  if (typeof node !== 'object' || !node) return null;
  if (match(node)) return node;
  for (const c of node.childNodes) { const hit = find(c, match); if (hit) return hit; }
  return null;
};
const cells = (tr) => tr.childNodes.map((td) => ({ text: td.textContent.trim(), className: td.className }));

// Render a screen and read its destination comparison, by city name and column header.
// Returns null if the screen has none.
function comparison(g, view) {
  const app = new App(new FakeNode('div'), g.config, text);
  app.game = g;
  app.go(view);
  const table = find(app.screenEl, (n) => n.tagName === 'TABLE' && n.className.split(' ').includes('compare'));
  if (!table) return null;
  const [thead, tbody] = table.childNodes;
  const header = cells(thead.childNodes[0]).map((c) => c.text);
  const rows = {};
  for (const tr of tbody.childNodes) {
    const row = cells(tr);
    rows[row[0].text] = Object.fromEntries(header.map((h, i) => [h, row[i]]));
  }
  return { app, header, rows, cities: Object.keys(rows) };
}

// At home with an empty warehouse and some chips loaded.
function loadedAtHome(config, hold) {
  const g = newGame(config);
  drain(g);
  for (const id of g.goodIds) g.state.warehouse[id] = 0;
  Object.assign(g.state.hold, hold);
  return g;
}

test('the travel screen compares every foreign city for the chips you carry', () => {
  const g = loadedAtHome(steady(), { whitewell: 5, z200: 10 });
  const { app, header, rows, cities } = comparison(g, 'travel');
  const short = (id) => text.goods[id].short;
  assert.deepEqual(cities, g.portIds.filter((p) => p !== g.home).map((p) => app.portName(p)), 'every foreign city, not home');
  assert.deepEqual(header, [app.t('ui.table.port'), app.t('ui.table.customs'), short('whitewell'), short('z200'), app.t('ui.table.cargoValue')]);
  for (const p of g.portIds.filter((x) => x !== g.home)) {
    const row = rows[app.portName(p)];
    const month = g.arrivalMonth(p);
    assert.equal(row[app.t('ui.table.customs')].text, app.t(`customsLevels.${g.customsLevel(p, month)}`), `${p}: BIS checks`);
    for (const id of ['whitewell', 'z200']) {
      const cell = row[short(id)];
      const leg = g.legality(p, id, month);
      const mark = leg !== g.legality(p, id) ? '*' : '';
      assert.equal(cell.text, app.moneyK(g.indicativePrice(p, id)) + mark, `${p} ${id}: just the price, no status text`);
      assert.ok(cell.className.split(' ').includes(leg), `${p} ${id}: coloured by status`);
    }
    const value = 5 * g.indicativePrice(p, 'whitewell') + 10 * g.indicativePrice(p, 'z200');
    assert.equal(row[app.t('ui.table.cargoValue')].text, app.moneyK(value), `${p}: cargo value`);
  }
});

test('the comparison marks the best price for each chip', () => {
  const g = loadedAtHome(steady(), { whitewell: 5, z200: 10 });
  const { app, rows } = comparison(g, 'travel');
  for (const id of ['whitewell', 'z200']) {
    const prices = g.portIds.filter((p) => p !== g.home).map((p) => [p, g.indicativePrice(p, id)]);
    const top = Math.max(...prices.map(([, v]) => v));
    for (const [p, v] of prices) {
      const best = rows[app.portName(p)][text.goods[id].short].className.split(' ').includes('best');
      assert.equal(best, v === top, `${id} in ${p}`);
    }
  }
});

test('the comparison shows status on arrival and marks what changes on the way', () => {
  const g = loadedAtHome(steady((c) => { c.exportControls.rules = [Z200_BAN_NEXT_MONTH]; }), { z200: 10 });
  const { app, rows } = comparison(g, 'travel');
  const shenzhen = rows[app.portName('shenzhen')][text.goods.z200.short];
  assert.equal(shenzhen.text, `${app.moneyK(g.indicativePrice('shenzhen', 'z200'))}*`);
  assert.ok(shenzhen.className.split(' ').includes('contraband'), shenzhen.className);
  const singapore = rows[app.portName('singapore')][text.goods.z200.short];
  assert.ok(!singapore.text.includes('*'), singapore.text);
  assert.ok(singapore.className.split(' ').includes('legal'), singapore.className);
});

test('a city still closed when you would land shows as closed; one reopening on the way does not', () => {
  const g = loadedAtHome(steady((c) => {
    c.politics.events = [
      { id: 'lockdown', kind: 'closure', port: 'singapore', months: [2, 2] },
      { id: 'lockdown_short', kind: 'closure', port: 'johor', months: [1, 1] },
    ];
  }), { z200: 10 });
  g.triggerEvent('lockdown'); g.triggerEvent('lockdown_short'); drain(g);
  const { app, rows } = comparison(g, 'travel');
  const closed = app.t('customsLevels.closed');
  assert.equal(rows[app.portName('singapore')][app.t('ui.table.customs')].text, closed);
  assert.ok(!rows[app.portName('singapore')][text.goods.z200.short].text.includes('$'), 'no price for a closed city');
  assert.notEqual(rows[app.portName('johor')][app.t('ui.table.customs')].text, closed);
  assert.ok(rows[app.portName('johor')][text.goods.z200.short].text.includes(app.moneyK(g.indicativePrice('johor', 'z200'))));
});

test('the load screen compares cities for the chips in your warehouse too', () => {
  const g = newGame(steady());
  drain(g);
  for (const id of g.goodIds) g.state.warehouse[id] = 0;
  g.state.warehouse.z20 = 30;
  const { app, header } = comparison(g, 'load');
  assert.deepEqual(header, [app.t('ui.table.port'), app.t('ui.table.customs'), text.goods.z20.short], 'no cargo column with an empty hold');
  g.state.hold.riptide = 20;
  assert.deepEqual(comparison(g, 'load').header,
    [app.t('ui.table.port'), app.t('ui.table.customs'), text.goods.z20.short, text.goods.riptide.short, app.t('ui.table.cargoValue')]);
});

test('abroad, the comparison leaves out where you are, and is not shown with an empty hold', () => {
  const g = newGame(steady());
  drain(g);
  g.travel('singapore'); drain(g);
  for (const id of g.goodIds) g.state.hold[id] = 0;
  assert.equal(comparison(g, 'travel'), null);
  g.state.hold.z200 = 10;
  const { app, cities } = comparison(g, 'travel');
  assert.ok(!cities.includes(app.portName('singapore')));
  assert.ok(!cities.includes(app.portName(g.home)));
  assert.equal(cities.length, g.portIds.length - 2);
});

test('comparison prices are in thousands: $xxk and $xxxk, and $x.xk below $10,000', () => {
  const app = new App(new FakeNode('div'), quietConfig(), text);
  const cases = [[48_123, '$48k'], [134_400, '$134k'], [10_000, '$10k'], [8_336, '$8.3k'], [1_843, '$1.8k'],
    [1_000, '$1.0k'], [500, '$0.5k'], [9_960, '$10k'], [1_060_000, '$1.06M']];
  for (const [n, shown] of cases) assert.equal(app.moneyK(n), shown, String(n));
});

test('the comparison shows cheap chips as $x.xk', () => {
  const g = loadedAtHome(steady(), { z20: 10, riptide: 10 });
  const { app, rows } = comparison(g, 'travel');
  for (const p of g.portIds.filter((x) => x !== g.home)) {
    for (const id of ['z20', 'riptide']) {
      const price = g.indicativePrice(p, id);
      if (price >= 9_950) continue;
      assert.match(rows[app.portName(p)][text.goods[id].short].text, /^\$\d\.\dk\*?$/, `${id} in ${p}`);
    }
  }
});
