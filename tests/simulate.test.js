// The balance simulator's bots must play the way their labels say (tools/simulate.js),
// or strategy comparisons tell us nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOTS, playGame, homeTurn, abroadTurn } from '../tools/simulate.js';
import { quietConfig, newGame, drain, loadConfig } from './helpers.js';

const CHINA = ['shenzhen', 'shanghai', 'beijing'];

// Each chip in the hold must be one the bot's strategy lets it sell in that city
// when it lands there: lawful only legal chips, cautious also restricted ones, and
// the smugglers banned chips only while the climate is calm enough for them.
function assertCargoFits(g, botName, dest) {
  const bot = BOTS[botName];
  for (const good of g.goodIds) {
    if (!g.state.hold[good]) continue;
    const leg = g.legality(dest, good, g.arrivalMonth(dest));
    const fits = leg === 'legal' || (leg === 'restricted' && bot.restricted)
      || (leg === 'contraband' && g.climateIndex() <= bot.smuggleUpTo);
    assert.ok(fits, `${botName} is taking ${good} to ${dest}, where it will be ${leg} on arrival`);
  }
}

test('the lawful and cautious bots never sell banned chips', () => {
  const config = loadConfig();
  for (const name of ['lawful', 'cautious']) {
    for (let seed = 1; seed <= 200; seed++) {
      const r = playGame(config, seed, name);
      assert.equal(r.stats.smuggled, 0, `${name}, seed ${seed}: sold ${r.stats.smuggled} banned chips`);
      assert.ok(r.reason, `${name}, seed ${seed}: the game never finished`);
    }
  }
});

// ---------- planning a trip from home ----------

// Nothing in the warehouse but Z200, and one city pays by far the most for it.
function z200Game(bestCity, rule) {
  const g = newGame(quietConfig((c) => {
    for (const p of c.ports) p.prices.z200 = p.id === bestCity ? 3 : 0.5;
    c.exportControls.rules = [rule];
  }));
  drain(g);
  for (const id of g.goodIds) g.state.warehouse[id] = 0;
  g.state.warehouse.z200 = 50;
  return g;
}

test('the cautious bot does not plan to carry chips that are banned by the time it lands', () => {
  // Z200 needs a license in Shenzhen today, and is banned from next month.
  const g = z200Game('shenzhen', { id: 'z200_ban_china', start: '2024-04', port: CHINA, good: 'z200', legality: 'contraband' });
  const dest = homeTurn(g, BOTS.cautious);
  assertCargoFits(g, 'cautious', dest);
});

test('the lawful bot does not plan to carry chips that need a license by the time it lands', () => {
  // Z200 is legal in Singapore today, and needs a license from next month.
  const g = z200Game('singapore', { id: 'z200_license_sea', start: '2024-04', port: ['singapore', 'kualalumpur', 'johor'], good: 'z200', legality: 'restricted' });
  const dest = homeTurn(g, BOTS.lawful);
  assertCargoFits(g, 'lawful', dest);
});

// ---------- selling abroad ----------

// The bot has landed in Shenzhen (e.g. diverted there) with Whitewell, which is banned there.
function whitewellInShenzhen() {
  const g = newGame();
  drain(g);
  g.state.port = 'shenzhen';
  g.state.hold.whitewell = 20;
  g.generatePrices();
  return g;
}

function assertKeptBannedCargo(g, botName) {
  const next = abroadTurn(g, BOTS[botName]);
  assert.equal(g.state.stats.smuggled, 0, `${botName} sold banned chips`);
  assert.equal(g.state.hold.whitewell, 20, `${botName} kept the Whitewell`);
  assertCargoFits(g, botName, next);
}

test('a lawful or cautious bot that lands where its cargo is banned keeps the cargo', () => {
  for (const name of ['lawful', 'cautious']) assertKeptBannedCargo(whitewellInShenzhen(), name);
});

test('... even in the last month of a quarter it is behind on', () => {
  for (const name of ['lawful', 'cautious']) {
    const g = whitewellInShenzhen();
    g.state.month = g.quarterEnd(0);
    assert.equal(g.monthsLeftInQuarter(), 1);
    assert.ok(g.net() < g.state.target);
    assertKeptBannedCargo(g, name);
  }
});

test('the smuggling bots do not sell banned chips while the climate is too hot for them', () => {
  const levels = loadConfig().doom.levels;
  for (const name of ['careful', 'smuggler']) {
    const g = whitewellInShenzhen();
    g.state.doom = levels[BOTS[name].smuggleUpTo + 1].from + 1;
    assertKeptBannedCargo(g, name);
  }
});
