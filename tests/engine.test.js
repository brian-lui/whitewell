import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, createGame, LEGALITY_ORDER } from '../js/engine.js';
import { PENALTY_FACTORS } from '../js/penalty.js';
import { quietConfig, newGame, drain, advanceMonths, loadConfig } from './helpers.js';

const HOME = 'hsinchu';
const total = (items) => items.reduce((sum, i) => sum + i.qty, 0);
const roundTo = (v, step) => Math.round(v / step) * step;

// ---------- setup, production, prices ----------

test('new game: starting assignment, first batch in the warehouse, prices set', () => {
  const g = newGame();
  const start = g.config.startOptions.find((o) => o.id === 'steady');
  assert.equal(g.state.port, HOME);
  assert.equal(g.state.capacity, start.capacity);
  assert.equal(g.state.target, roundTo(start.target * g.state.targetScale, g.config.targets.roundTo));
  assert.equal(g.holdUsed(), 0);
  assert.ok(g.warehouseUsed() > 0);
  for (const id of g.goodIds) assert.ok(g.price(id) > 0, id);
});

test('production arrives every month, and what does not fit goes to another region', () => {
  const g = newGame(quietConfig((c) => {
    c.warehouse.capacity = 50;
    for (const good of c.goods) { good.production = [20, 20]; good.productionTrend = 0; }
  }));
  assert.equal(g.warehouseUsed(), 50);
  assert.ok(g.loadAll().ok);
  assert.equal(g.warehouseUsed(), 0);
  g.travel('singapore'); drain(g);
  assert.equal(g.warehouseUsed(), 50, 'a month of production landed while away');
  g.travel(HOME);
  const report = drain(g).find((s) => s.data.key === 'production.overflow');
  assert.ok(report, 'the overflow is reported on arrival home');
  assert.equal(total(report.data.vars.delivered), 50);
  assert.equal(total(report.data.vars.reallocated), 30);
});

test('production follows each chip\'s long-term trend', () => {
  const g = newGame();
  g.state.month = 10;
  for (const c of g.config.goods) {
    assert.ok(Math.abs(g.productionFactor(c.id) - (1 + (c.productionTrend || 0)) ** 10) < 1e-9, c.id);
  }
});

test('older chips lose value every month; Whitewell does not', () => {
  const g = newGame();
  const gray = g.goodsById.z200;
  assert.equal(g.currentBase('z200', 10), gray.basePrice * (1 - gray.depreciation) ** 10);
  assert.equal(g.currentBase('whitewell', 10), g.goodsById.whitewell.basePrice);
});

// ---------- selling, loading ----------

test('at home, sales come out of the warehouse first; abroad, out of your cargo', () => {
  const g = newGame();
  const s = g.state;
  const stored = s.warehouse.riptide;
  assert.ok(g.load('riptide', 5).ok);
  const r = g.sell('riptide', 3);
  assert.ok(r.ok);
  assert.equal(r.amount, 3 * g.price('riptide'));
  assert.equal(s.warehouse.riptide, stored - 8);
  assert.equal(s.hold.riptide, 5);
  assert.equal(s.quarter.sales, r.amount);
  assert.equal(g.sell('riptide', 10_000).error, 'errors.notEnoughGoods');
  assert.equal(g.sell('riptide', -3).error, 'errors.invalidAmount');
  assert.equal(g.sell('riptide', 'abc').error, 'errors.invalidAmount');

  g.travel('singapore'); drain(g);
  assert.equal(g.stock('riptide'), 5, 'the warehouse is not reachable from abroad');
  assert.ok(g.sell('riptide', 5).ok);
  assert.equal(s.hold.riptide, 0);
});

test('loading and unloading respect space and only work at home', () => {
  const g = newGame(quietConfig((c) => { c.startOptions[0].capacity = 10; }));
  assert.equal(g.load('riptide', 11).error, 'errors.notEnoughSpace');
  assert.ok(g.load('riptide', 10).ok);
  assert.equal(g.holdFree(), 0);
  assert.ok(g.unload('riptide', 4).ok);
  assert.equal(g.state.hold.riptide, 6);
  g.travel('singapore'); drain(g);
  assert.equal(g.load('riptide', 1).error, 'errors.homeOnly');
  assert.equal(g.unload('riptide', 1).error, 'errors.homeOnly');
  assert.equal(g.loadAll().error, 'errors.homeOnly');
});

test('"load all" takes the most valuable chips first', () => {
  const g = newGame();
  const ww = g.state.warehouse.whitewell;
  g.state.capacity = ww + 3;
  const r = g.loadAll();
  assert.equal(r.loaded, ww + 3);
  assert.equal(g.state.hold.whitewell, ww);
  assert.equal(g.state.hold.z200, 3);
});

// ---------- travel ----------

test('a trip out costs freight and a month; flying home is free and instant', () => {
  const g = newGame();
  const cost = g.freightCost();
  assert.ok(g.travel('singapore').ok);
  assert.equal(g.state.month, 1);
  assert.equal(g.state.quarter.costs, cost);
  assert.deepEqual(drain(g).map((s) => s.type), ['arrival']);
  assert.equal(g.travel('singapore').error, 'errors.alreadyHere');

  assert.ok(g.travel(HOME).ok);
  assert.equal(g.state.month, 1);
  assert.equal(g.state.quarter.costs, cost);
  assert.equal(g.state.port, HOME);
  const steps = drain(g);
  assert.equal(steps[0].type, 'arrival');
  assert.ok(steps.some((s) => s.data.key === 'production.report'));
});

test('actions are blocked while an event is waiting', () => {
  const g = newGame();
  g.travel('singapore');
  assert.equal(g.sell('riptide', 1).error, 'errors.busy');
  assert.equal(g.travel(HOME).error, 'errors.busy');
});

test('freight offers: accepting adds space and charges the quarter', () => {
  const g = newGame(quietConfig((c) => { c.offers.freightChance = 1; }));
  g.travel('singapore');
  g.resolveStep('continue');
  const offer = g.currentStep();
  assert.equal(offer.type, 'freightOffer');
  const costs = g.state.quarter.costs;
  const capacity = g.state.capacity;
  g.resolveStep('accept');
  assert.equal(g.state.capacity, capacity + offer.data.add);
  assert.equal(g.state.quarter.costs, costs + offer.data.price);
});

// ---------- customs ----------

function inspectedAt(port, edit = () => {}) {
  return newGame(quietConfig((c) => {
    c.ports.find((p) => p.id === port).inspection = 1;
    edit(c);
  }));
}

test('banned chips are seized, and the fine depends on the political climate', () => {
  const g = inspectedAt('shenzhen');
  g.load('whitewell', 2);
  g.load('riptide', 5);
  g.travel('shenzhen');
  assert.equal(g.currentStep().type, 'arrival');
  g.resolveStep('continue');
  const step = g.currentStep();
  assert.equal(step.type, 'inspection');
  assert.deepEqual(step.data.items.map((i) => i.good), ['whitewell']);
  const fine = Math.round(2 * g.price('whitewell') * g.config.customs.fineRate * g.climateLevel().penaltyMultiplier);
  assert.equal(step.data.items[0].fine, fine);
  const costs = g.state.quarter.costs;
  g.resolveStep('cooperate');
  assert.equal(g.state.hold.whitewell, 0);
  assert.equal(g.state.hold.riptide, 5);
  assert.equal(g.state.quarter.costs, costs + fine);
  assert.equal(g.state.heat, g.config.heat.seizure);
  assert.equal(g.state.doom, g.config.doom.start + g.config.doom.seizure, 'the bust makes the news');
  assert.equal(g.state.profile, g.config.profile.perSeizure);
  const msg = g.currentStep().data;
  assert.equal(msg.key, 'inspection.seized');
  assert.equal(msg.vars.doomChange, g.config.doom.seizure);
});

test('the same bust costs more in a worse political climate', () => {
  const fineAt = (doom) => {
    const g = inspectedAt('shenzhen');
    g.state.doom = doom;
    g.load('whitewell', 2);
    g.travel('shenzhen');
    g.resolveStep('continue');
    return g.currentStep().data.items[0].fine;
  };
  const levels = loadConfig().doom.levels;
  const calm = fineAt(levels[0].from);
  const war = fineAt(levels.at(-1).from);
  const ratio = levels.at(-1).penaltyMultiplier / levels[0].penaltyMultiplier;
  assert.ok(Math.abs(war / calm - ratio) < 0.01, `${war} / ${calm} should be about ${ratio}`);
});

test('penalty factors are modular: listed in config, written in penalty.js', () => {
  assert.equal(newGame(quietConfig((c) => { c.penalty.factors = []; })).penaltyMultiplier(), 1);
  assert.equal(newGame(quietConfig((c) => { c.penalty.factors = ['noSuchFactor']; })).penaltyMultiplier(), 1);
  PENALTY_FACTORS.double = () => 2;
  try {
    const g = newGame(quietConfig((c) => { c.penalty.factors = ['climate', 'double']; }));
    assert.equal(g.penaltyMultiplier(), 2 * g.climateLevel().penaltyMultiplier);
  } finally {
    delete PENALTY_FACTORS.double;
  }
});

// Reported: after a BIS check finds banned chips, they stayed in the cargo.
test('a BIS check takes banned chips out of your cargo and keeps licensed ones, charging both', () => {
  for (const choice of ['cooperate', 'fixerFails']) {
    const g = inspectedAt('shenzhen');
    g.load('whitewell', 5); // banned in Shenzhen
    g.load('z200', 7); // needs a license in Shenzhen
    g.load('riptide', 3); // legal
    g.travel('shenzhen');
    g.resolveStep('continue');
    const step = g.currentStep();
    assert.equal(step.type, 'inspection');
    const costs = g.state.quarter.costs;
    if (choice === 'fixerFails') step.data.bribeChance = 0;
    g.resolveStep(choice === 'cooperate' ? 'cooperate' : 'bribe');
    assert.equal(g.state.hold.whitewell, 0, `${choice}: banned chips are taken`);
    assert.equal(g.state.hold.z200, 7, `${choice}: licensed chips are kept`);
    assert.equal(g.state.hold.riptide, 3, `${choice}: legal chips are untouched`);
    const extra = choice === 'cooperate' ? 0 : 2 * step.data.bribe;
    assert.equal(g.state.quarter.costs, costs + step.data.fine + extra, `${choice}: both penalties charged`);
    drain(g);
    assert.equal(g.stock('whitewell'), 0, `${choice}: nothing left to sell`);
  }
});

test('unlicensed chips pay a penalty but are kept', () => {
  const g = inspectedAt('shenzhen');
  g.load('z200', 2);
  g.travel('shenzhen');
  drain(g, 'cooperate');
  assert.ok(g.state.stats.finesPaid > 0);
  assert.equal(g.state.hold.z200, 2);
  assert.equal(g.state.heat, 0);
  assert.equal(g.state.quarter.costs, g.freightCost() + g.state.stats.finesPaid);
});

test('clean inspections cool your scrutiny', () => {
  const g = inspectedAt('singapore');
  g.state.heat = 30;
  g.load('whitewell', 2);
  g.travel('singapore');
  const steps = drain(g);
  assert.ok(steps.some((s) => s.type === 'inspection' && s.data.clean));
  assert.equal(g.state.heat, 30 - g.config.heat.monthlyDecay + g.config.heat.cleanInspection);
});

test('bribes: success keeps the chips; failure costs more than cooperating', () => {
  for (const succeed of [true, false]) {
    const g = inspectedAt('shenzhen');
    g.load('whitewell', 2);
    g.travel('shenzhen');
    g.resolveStep('continue');
    const step = g.currentStep();
    assert.ok(g.stepChoices(step).find((c) => c.id === 'bribe').enabled, 'a bribe is always on offer');
    step.data.bribeChance = succeed ? 1 : 0;
    const before = g.state.quarter.costs;
    g.resolveStep('bribe');
    if (succeed) {
      assert.equal(g.state.hold.whitewell, 2);
      assert.equal(g.state.quarter.costs, before + step.data.bribe);
      assert.equal(g.state.doom, g.config.doom.start, 'a quiet bribe keeps the bust out of the news');
    } else {
      assert.equal(g.state.hold.whitewell, 0);
      assert.equal(g.state.quarter.costs, before + step.data.bribe + step.data.fine + step.data.bribe);
      assert.equal(g.state.heat, g.config.heat.failedBribe);
      assert.equal(g.state.doom, g.config.doom.start + g.config.doom.seizure);
    }
  }
});

// ---------- the doom meter and political climate ----------

test("the doom meter's level sets the political climate", () => {
  const g = newGame();
  const levels = g.config.doom.levels;
  for (const [i, l] of levels.entries()) {
    assert.equal(g.climateLevel(l.from).id, l.id);
    if (i > 0) assert.equal(g.climateLevel(l.from - 1).id, levels[i - 1].id);
  }
  assert.equal(g.climateLevel(g.config.doom.max).id, levels.at(-1).id);
});

test('doom events move the meter both ways and stop at the ends', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [
      { id: 'senate_hearing', kind: 'doom', value: [10, 10] },
      { id: 'trade_summit', kind: 'doom', value: [-10, -10] },
    ];
  }));
  g.state.doom = 50;
  assert.ok(g.triggerEvent('senate_hearing'));
  assert.equal(g.state.doom, 60);
  assert.equal(g.state.news[0].vars.doomChange, 10);
  assert.equal(g.state.news[0].vars.climate, g.climateLevel(60).id);
  assert.ok(g.triggerEvent('trade_summit'));
  assert.equal(g.state.doom, 50);
  g.state.doom = 5;
  assert.ok(g.triggerEvent('trade_summit'));
  assert.equal(g.state.doom, 0, 'never below zero');
  assert.equal(g.state.news[0].vars.doomChange, -5);
  assert.equal(g.triggerEvent('trade_summit'), false, 'already as calm as it gets');
  g.state.doom = g.config.doom.max;
  assert.equal(g.triggerEvent('senate_hearing'), false);
});

test('any political event can also nudge the doom meter', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [{ id: 'leak', kind: 'heat', value: [10, 10], doom: [7, 7] }];
  }));
  g.triggerEvent('leak');
  assert.equal(g.state.heat, 10);
  assert.equal(g.state.doom, g.config.doom.start + 7);
  assert.equal(g.state.news[0].vars.doomChange, 7);
});

test('every month Washington may move the doom meter, using only doom events', () => {
  const g = newGame(quietConfig((c) => { c.doom.eventChance = 1; }));
  const before = g.state.doom;
  g.travel('singapore');
  const news = drain(g).filter((st) => st.type === 'news');
  assert.equal(news.length, 1, 'exactly one doom headline');
  const id = news[0].data.headline.split('.')[1];
  assert.equal(g.config.politics.events.find((e) => e.id === id).kind, 'doom');
  assert.equal(g.state.doom, before + news[0].data.vars.doomChange);
});

test('other political news never comes from the doom events', () => {
  const g = newGame(quietConfig((c) => { c.politics.eventChance = 1; c.politics.secondEventChance = 1; c.targets.missesToFire = 999; }));
  for (let i = 0; i < 12; i++) advanceMonths(g, 1);
  const ids = g.state.news.filter((n) => n.body).map((n) => n.headline.split('.')[1]);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.notEqual(g.config.politics.events.find((e) => e.id === id).kind, 'doom', id);
});

test('selling banned chips raises your profile; legal sales do not', () => {
  const g = newGame();
  g.load('whitewell', 4);
  g.load('riptide', 4);
  g.travel('shenzhen'); drain(g);
  const legal = g.sell('riptide', 4);
  assert.equal(legal.profile, 0);
  const banned = g.sell('whitewell', 4);
  assert.equal(banned.profile, 4 * g.config.profile.perBannedUnitSold);
  assert.equal(g.state.profile, banned.profile);
  assert.equal(g.state.stats.smuggled, 4);
});

test('a higher profile makes the hawks push the doom meter up harder', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [
      { id: 'senate_hearing', kind: 'doom', value: [10, 10] },
      { id: 'trade_summit', kind: 'doom', value: [-10, -10] },
    ];
  }));
  const P = g.config.profile;
  g.state.doom = 30;
  g.state.profile = P.max;
  assert.equal(g.hawkMultiplier(), P.hawkMultiplierAtMax);
  g.triggerEvent('senate_hearing');
  assert.equal(g.state.doom, 30 + Math.round(10 * P.hawkMultiplierAtMax));
  assert.equal(g.state.news[0].vars.hawks, P.hawkMultiplierAtMax);
  const high = g.state.doom;
  g.triggerEvent('trade_summit');
  assert.equal(g.state.doom, high - 10, 'calming news is not amplified');
  g.state.profile = P.max / 2;
  assert.equal(g.hawkMultiplier(), 1 + (P.hawkMultiplierAtMax - 1) / 2);
});

test('a bust that maxes out the doom meter forces the CEO out', () => {
  const g = inspectedAt('shenzhen');
  g.state.doom = g.config.doom.max - 5;
  g.load('whitewell', 2);
  g.travel('shenzhen');
  g.resolveStep('continue');
  g.resolveStep('cooperate');
  assert.equal(g.state.doom, g.config.doom.max);
  assert.equal(g.state.gameOver, null, 'you still see what happened first');
  assert.equal(g.currentStep().data.key, 'inspection.seized');
  assert.equal(g.sell('riptide', 1).error, 'errors.gameOver');
  drain(g);
  assert.equal(g.state.gameOver.reason, 'ceoOusted');
});

test('political news that maxes out the doom meter ends the trip and the game', () => {
  const g = newGame(quietConfig((c) => {
    c.doom.eventChance = 1;
    c.politics.events = [{ id: 'chip_security_act', kind: 'doom', value: [50, 50] }];
  }));
  g.state.doom = 60;
  assert.ok(g.travel('singapore').ok);
  const steps = drain(g);
  assert.deepEqual(steps.map((s) => s.type), ['news'], 'the shipment never lands');
  assert.equal(g.state.gameOver.reason, 'ceoOusted');
});

// ---------- political events ----------

test('legality events can cover several cities at once, then expire', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [{ id: 'malaysia_permits', kind: 'legality', port: ['kualalumpur', 'johor'], good: 'whitewell', legality: 'restricted', mode: 'max', months: [2, 2] }];
  }));
  assert.ok(g.triggerEvent('malaysia_permits'));
  assert.equal(g.legality('kualalumpur', 'whitewell'), 'restricted');
  assert.equal(g.legality('johor', 'whitewell'), 'restricted');
  assert.equal(g.legality('singapore', 'whitewell'), 'legal');
  assert.equal(g.triggerEvent('malaysia_permits'), false, 'no duplicate on the same target');
  assert.ok(g.localEffects('johor').length === 1 && g.localEffects('singapore').length === 0);
  drain(g);
  advanceMonths(g, 1);
  assert.equal(g.legality('johor', 'whitewell'), 'restricted');
  g.travel('johor');
  assert.ok(drain(g).some((s) => s.type === 'news' && s.data.headline === 'events.malaysia_permits.end'));
  assert.equal(g.legality('johor', 'whitewell'), 'legal');
});

test('"max" legality events never relax a ban', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [{ id: 'sweep', kind: 'legality', port: 'shenzhen', good: 'all', legality: 'restricted', mode: 'max', months: [3, 3] }];
  }));
  g.triggerEvent('sweep');
  assert.equal(g.legality('shenzhen', 'whitewell'), 'contraband');
  assert.equal(g.legality('shenzhen', 'riptide'), 'restricted');
});

test('price events move prices on arrival', () => {
  const config = quietConfig((c) => {
    for (const good of c.goods) good.volatility = 0;
    c.politics.events = [{ id: 'tariffs', kind: 'price', port: 'singapore', good: 'riptide', value: [2, 2], months: [3, 3] }];
  });
  const g = newGame(config);
  g.triggerEvent('tariffs');
  drain(g);
  g.travel('singapore'); drain(g);
  const factor = config.ports.find((p) => p.id === 'singapore').prices.riptide;
  assert.equal(g.price('riptide'), Math.round(g.currentBase('riptide') * factor * 2));
});

test('production events change what the fabs make', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [{ id: 'yield_breakthrough', kind: 'production', good: 'whitewell', value: [2, 2], months: [3, 3] }];
  }));
  const before = g.productionFactor('whitewell');
  g.triggerEvent('yield_breakthrough');
  assert.equal(g.productionFactor('whitewell'), before * 2);
  assert.equal(g.productionFactor('riptide'), 1);
});

// The fabs make exactly 10 Whitewell a month (and nothing else). An earthquake that
// halves output for `eventMonths` strikes on the first trip, through the normal
// monthly news roll. Returns how much Whitewell landed in the warehouse each month.
function outputDuringEarthquake(eventMonths, months) {
  const g = newGame(quietConfig((c) => {
    for (const good of c.goods) { good.production = 0; good.productionTrend = 0; }
    c.goods.find((good) => good.id === 'whitewell').production = [10, 10];
    c.politics.secondEventChance = 0;
    c.politics.events = [{ id: 'earthquake', kind: 'production', good: 'all', value: [0.5, 0.5], months: [eventMonths, eventMonths] }];
  }));
  const outputs = [];
  for (let i = 0; i < months; i++) {
    g.config.politics.eventChance = i === 0 ? 1 : 0;
    const before = g.state.warehouse.whitewell;
    advanceMonths(g, 1);
    outputs.push(g.state.warehouse.whitewell - before);
  }
  return outputs;
}

test('a one-month production event affects that month\'s output, then output returns to normal', () => {
  assert.deepEqual(outputDuringEarthquake(1, 3), [5, 10, 10]);
});

test('a production event lasting N months affects N months of output', () => {
  assert.deepEqual(outputDuringEarthquake(3, 5), [5, 5, 5, 10, 10]);
});

test('target and revenue events change this quarter\'s numbers', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.events = [
      { id: 'guidance_raise', kind: 'target', value: [1.1, 1.1] },
      { id: 'subsidy', kind: 'revenue', value: [500000, 500000] },
    ];
  }));
  const target = g.state.target;
  g.triggerEvent('guidance_raise');
  assert.equal(g.state.target, roundTo(target * 1.1, 10000));
  g.triggerEvent('subsidy');
  assert.equal(g.state.quarter.sales, 500000);
});

test('a city that closes mid-trip diverts you to another foreign city', () => {
  const g = newGame(quietConfig((c) => {
    c.politics.eventChance = 1;
    c.politics.secondEventChance = 0;
    c.politics.events = [{ id: 'lockdown', kind: 'closure', port: 'singapore', months: [2, 2] }];
  }));
  g.travel('singapore');
  const steps = drain(g);
  assert.ok(steps.some((s) => s.type === 'message' && s.data.key === 'voyage.diverted'));
  assert.notEqual(g.state.port, 'singapore');
  assert.notEqual(g.state.port, HOME);
  assert.equal(g.travel('singapore').error, 'errors.portClosed');
});

test('closures never leave fewer than the minimum number of open cities', () => {
  const g = newGame();
  for (let i = 0; i < 20; i++) g.triggerEvent('lockdown');
  assert.ok(g.openPorts().length >= g.config.politics.minOpenPorts);
  assert.ok(!g.isClosed(HOME));
});

test('every political event can fire without breaking the game', () => {
  const g = newGame(loadConfig());
  for (const ev of g.config.politics.events) {
    g.state.doom = g.config.doom.max / 2; // keep the doom meter away from either end
    g.triggerEvent(ev.id);
  }
  const seen = new Set(g.state.news.map((n) => n.headline.split('.')[1]));
  for (const ev of g.config.politics.events) assert.ok(seen.has(ev.id), `${ev.id} never fired`);
  drain(g);
});

test('customs strikes stop inspections entirely', () => {
  const g = newGame(quietConfig((c) => {
    c.ports.find((p) => p.id === 'shenzhen').inspection = 0.5;
    c.politics.events = [{ id: 'officers_expelled', kind: 'inspection', port: 'shenzhen', value: -1, months: [2, 2] }];
  }));
  g.triggerEvent('officers_expelled');
  assert.equal(g.inspectionChance('shenzhen'), 0);
  assert.equal(g.customsLevel('shenzhen'), 'none');
});

// ---------- export-control rounds ----------

// The real schedule, everything else quiet, and no firing (these test players never sell).
const withRealRules = (edit = () => {}) => quietConfig((c) => {
  c.exportControls.rules = loadConfig().exportControls.rules;
  c.targets.missesToFire = 999;
  edit(c);
});

test('export-control rounds are announced a quarter ahead, then stay in force for good', () => {
  const g = newGame(withRealRules());
  const first = g.rules[0];
  const notice = g.config.exportControls.noticeMonths;
  const [city] = [].concat(first.port);
  assert.notEqual(g.legality(city, first.good), first.legality, 'not in force at the start');
  advanceMonths(g, first.month - notice);
  const announced = g.state.news.find((n) => n.headline === 'exportControls.announced');
  assert.ok(announced, 'announced in advance');
  assert.equal(announced.vars.rule, first.id);
  assert.equal(announced.month, first.month - notice);
  assert.deepEqual(g.upcomingRules().map((r) => r.id), [first.id]);
  assert.notEqual(g.legality(city, first.good), first.legality, 'not yet in force');
  advanceMonths(g, notice);
  assert.ok(g.state.news.some((n) => n.headline === 'exportControls.inForce' && n.vars.rule === first.id));
  assert.equal(g.legality(city, first.good), first.legality);
  assert.equal(g.baseLegality(city, first.good), first.legality, 'permanent: not marked as a temporary change');
  const last = g.rules.at(-1);
  advanceMonths(g, last.month - g.state.month + 12);
  for (const r of g.rules) {
    for (const p of [].concat(r.port)) {
      const rank = (l) => LEGALITY_ORDER.indexOf(l);
      assert.ok(rank(g.legality(p, r.good)) >= rank(r.legality), `${r.id} still in force at ${p} (or replaced by something stricter)`);
    }
  }
  assert.equal(g.upcomingRules().length, 0);
});

test('export-control rounds only make things stricter', () => {
  const g = newGame(quietConfig((c) => {
    c.exportControls.rules = [{ id: 'softer', start: '2024-03', port: 'shenzhen', good: 'whitewell', legality: 'restricted' }];
  }));
  assert.equal(g.legality('shenzhen', 'whitewell'), 'contraband', 'a banned chip stays banned');
});

test('when a round bans a chip, its price there rises like any ban', () => {
  const config = withRealRules((c) => { for (const good of c.goods) good.volatility = 0; });
  const g = newGame(config);
  const ban = g.rules.find((r) => r.id === 'z200_ban_china');
  const factor = config.ports.find((p) => p.id === 'shanghai').prices.z200;
  const lf = config.legalityPriceFactor;
  while (g.state.month < ban.month || g.state.port !== 'shanghai') advanceMonths(g, 1, ['shanghai', 'singapore']);
  assert.equal(g.price('z200'), Math.round(g.currentBase('z200') * factor * lf.contraband / lf.restricted));
});

test('a game that starts after a notice went out announces the coming round right away', () => {
  const g = newGame(quietConfig((c) => {
    c.exportControls.rules = [{ id: 'z20_license_china', start: '2024-05', port: 'shenzhen', good: 'z20', legality: 'restricted' }];
  }));
  const step = g.currentStep();
  assert.equal(step.type, 'news');
  assert.equal(step.data.headline, 'exportControls.announced');
});

// ---------- quarters ----------

test('quarters follow the calendar, and the first one includes the starting month', () => {
  const dec = newGame(quietConfig((c) => { c.calendar.startMonth = 12; }));
  assert.equal(dec.quarterStart(0), 0);
  assert.equal(dec.quarterEnd(0), 3);
  assert.equal(dec.quarterEnd(3), 3);
  assert.equal(dec.quarterStart(4), 4);
  assert.equal(dec.quarterEnd(4), 6);

  const jan = newGame(quietConfig((c) => { c.calendar.startMonth = 1; }));
  assert.equal(jan.quarterEnd(0), 2);
  assert.equal(jan.quarterStart(3), 3);
});

test('a short first quarter gets a smaller target; the next one is back to normal', () => {
  const config = quietConfig((c) => { c.calendar.startMonth = 1; c.targets.ratchet = 0; });
  const g = newGame(config);
  const full = config.startOptions.find((o) => o.id === 'steady').target;
  const T = config.targets;
  assert.equal(g.state.target, roundTo(full * (2 / 3), T.roundTo), 'January start: two trips in Q1');
  advanceMonths(g, 3);
  assert.equal(g.state.quarters.length, 1);
  assert.equal(g.state.target, roundTo(full * (1 + T.growth), T.roundTo));

  const dec = newGame(quietConfig((c) => { c.calendar.startMonth = 12; }));
  assert.equal(dec.state.target, full, 'December start: three trips in Q1, full target');
});

// Set this quarter's sales so that, after the next trip's freight, net = target + extra.
function setNetAfterNextTrip(g, extra) {
  g.state.quarter.sales = g.state.target + g.state.quarter.costs + g.freightCost() + extra;
}

test('meeting the target pays a bonus; missing twice in a row gets you fired', () => {
  const g = newGame();
  const T = g.config.targets;
  const B = g.config.bonus;
  advanceMonths(g, g.firstQuarterEnd);
  assert.equal(g.state.quarters.length, 0);
  const target = g.state.target;
  const fullTarget = target / g.state.targetScale;
  setNetAfterNextTrip(g, 1_000_000);
  g.travel(g.state.port === 'singapore' ? 'kualalumpur' : 'singapore');
  const review = g.currentStep();
  assert.equal(review.type, 'quarter');
  assert.equal(review.data.met, true);
  assert.equal(review.data.net, target + 1_000_000);
  const bonus = roundTo(target * B.onTarget + 1_000_000 * B.overTarget, 100);
  assert.equal(review.data.bonus, bonus);
  assert.equal(g.state.bonus, bonus);
  assert.equal(g.state.misses, 0);
  assert.equal(g.state.target, roundTo(Math.max(fullTarget * (1 + T.growth), review.data.net * T.ratchet), T.roundTo));
  drain(g);

  advanceMonths(g, 3); // no sales: missed
  assert.equal(g.state.quarters.at(-1).met, false);
  assert.equal(g.state.misses, 1);
  assert.equal(g.state.gameOver, null);
  advanceMonths(g, 2);
  g.travel(g.state.port === 'singapore' ? 'kualalumpur' : 'singapore');
  assert.equal(g.state.gameOver.reason, 'fired');
  assert.equal(g.currentStep(), null);
});

test('the ratchet (if switched on) raises the next target after a big quarter', () => {
  const g = newGame(quietConfig((c) => { c.targets.ratchet = 0.9; }));
  advanceMonths(g, g.firstQuarterEnd);
  setNetAfterNextTrip(g, 5_000_000);
  const net = g.state.target + 5_000_000;
  advanceMonths(g, 1);
  assert.equal(g.state.target, roundTo(net * 0.9, 10000));
});

test('stretch goals multiply the bonus', () => {
  const g = newGame(quietConfig(), { startId: 'stretch' });
  advanceMonths(g, g.firstQuarterEnd);
  const target = g.state.target;
  setNetAfterNextTrip(g, 0);
  advanceMonths(g, 1);
  const mult = g.config.startOptions.find((o) => o.id === 'stretch').bonusMultiplier;
  assert.equal(g.state.bonus, roundTo(target * g.config.bonus.onTarget * mult, 100));
});

test('there is no time limit: with Washington quiet, the game just goes on', () => {
  const g = newGame(quietConfig((c) => { c.targets.missesToFire = 999; }));
  advanceMonths(g, 120);
  assert.equal(g.state.gameOver, null);
  assert.equal(g.state.month, 120);
});

test('resigning is only possible at home', () => {
  const g = newGame();
  g.travel('singapore'); drain(g);
  assert.equal(g.resign().error, 'errors.homeOnly');
  g.travel(HOME); drain(g);
  assert.ok(g.resign().ok);
  assert.equal(g.state.gameOver.reason, 'resigned');
});

// ---------- saves and robustness ----------

test('same seed + same moves = same game, even across save/load', () => {
  const play = (g, saveMidway) => {
    for (const [i, city] of ['shenzhen', 'johor', 'beijing', 'singapore', 'shanghai', 'kualalumpur'].entries()) {
      if (saveMidway && i === 3) g = new Game(g.config, JSON.parse(JSON.stringify(g.state)));
      g.loadAll();
      if (g.travel(city).ok) drain(g);
      for (const id of g.goodIds) if (g.state.hold[id]) g.sell(id, g.state.hold[id]);
      if (g.travel(HOME).ok) drain(g);
    }
    return g.state;
  };
  const a = play(createGame(loadConfig(), { name: 'A', startId: 'steady', seed: 99 }), false);
  const b = play(createGame(loadConfig(), { name: 'A', startId: 'steady', seed: 99 }), true);
  assert.deepEqual(a, b);
});

test('old saves survive a chip being added to config.json', () => {
  const g = newGame();
  const saved = JSON.parse(JSON.stringify(g.state));
  const config = quietConfig((c) => { c.goods.push({ id: 'hbm', basePrice: 500, volatility: 0.2, production: [5, 10] }); });
  const loaded = new Game(config, saved);
  assert.equal(loaded.state.hold.hbm, 0);
  assert.equal(loaded.state.warehouse.hbm, 0);
  assert.ok(loaded.price('hbm') > 0);
});

test('random play never breaks the invariants', () => {
  const config = loadConfig();
  for (let seed = 1; seed <= 150; seed++) {
    const g = createGame(config, { name: 'Fuzz', startId: seed % 2 ? 'steady' : 'stretch', seed });
    const r = () => g.random();
    let guard = 0;
    while (!g.state.gameOver && guard++ < 3000) {
      const step = g.currentStep();
      if (step) {
        const choices = g.stepChoices(step).filter((c) => c.enabled);
        assert.ok(g.resolveStep(choices[Math.floor(r() * choices.length)].id).ok);
        continue;
      }
      for (const id of g.goodIds) if (g.stock(id) && r() < 0.5) g.sell(id, Math.ceil(g.stock(id) * r()));
      if (g.atHome) {
        if (r() < 0.8) g.loadAll();
        else g.load(g.pick(g.goodIds), Math.ceil(10 * r()));
        if (r() < 0.2) g.unload(g.pick(g.goodIds), Math.ceil(10 * r()));
      }
      const options = g.openPorts().filter((p) => p !== g.state.port);
      g.travel(g.atHome || r() < 0.3 ? g.pick(options.filter((p) => p !== HOME)) : HOME);
      const s = g.state;
      for (const v of [s.heat, ...Object.values(s.hold), ...Object.values(s.warehouse)]) {
        assert.ok(Number.isInteger(v) && v >= 0, `bad value ${v} (seed ${seed})`);
      }
      for (const v of [s.quarter.sales, s.quarter.costs, s.target, s.bonus]) assert.ok(Number.isFinite(v), `bad money ${v} (seed ${seed})`);
      assert.ok(g.holdUsed() <= s.capacity);
      assert.ok(g.warehouseUsed() <= g.config.warehouse.capacity);
      assert.ok(s.heat <= g.config.heat.max);
      assert.ok(s.doom >= 0 && s.doom <= g.config.doom.max);
      assert.ok(s.profile >= 0 && s.profile <= g.config.profile.max);
    }
    assert.ok(['fired', 'ceoOusted'].includes(g.state.gameOver?.reason), `seed ${seed} ended badly: ${g.state.gameOver?.reason}`);
  }
});
