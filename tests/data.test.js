// Checks the two data files agree with each other. Run after editing them: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EVENT_KINDS, LEGALITY_ORDER } from '../js/engine.js';
import { PENALTY_FACTORS } from '../js/penalty.js';
import { loadConfig, loadText } from './helpers.js';

const config = loadConfig();
const text = loadText();
const portIds = config.ports.map((p) => p.id);
const goodIds = config.goods.map((g) => g.id);

// Every {placeholder} the game knows how to fill in.
const KNOWN_VARS = new Set(['name', 'company', 'home', 'quarters', 'strikes', 'month', 'year', 'months', 'port', 'dest',
  'good', 'pct', 'amount', 'points', 'qty', 'fine', 'bribe', 'seized', 'add', 'capacity', 'price', 'cost', 'max',
  'level', 'used', 'free', 'n', 'bonus', 'rating', 'trips', 'inspections', 'seizures', 'bribes', 'fines', 'sales',
  'costs', 'net', 'target', 'next', 'quarter', 'misses', 'climate', 'mult', 'delivered', 'reallocated', 'on', 'over',
  'growth', 'multiplier', 'doom', 'doomMax', 'hawks', 'heat', 'heatMax', 'profile', 'profileMax', 'rule']);

function* strings(node, path = '') {
  if (typeof node === 'string') yield [path, node];
  else if (Array.isArray(node)) for (const [i, v] of node.entries()) yield* strings(v, `${path}[${i}]`);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('_')) yield* strings(v, path ? `${path}.${k}` : k);
  }
}

test('text.json only uses placeholders the game knows', () => {
  for (const [path, s] of strings(text)) {
    for (const [, name] of s.matchAll(/\{(\w+)\}/g)) {
      assert.ok(KNOWN_VARS.has(name), `${path} uses unknown placeholder {${name}}`);
    }
  }
});

test('every text key the code asks for exists in text.json', () => {
  const resolve = (key) => key.split('.').reduce((node, part) => node?.[part], text);
  const sections = new Set(Object.keys(text));
  const missing = [];
  for (const file of ['js/engine.js', 'js/ui.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const keys = [...src.matchAll(/'([a-zA-Z]+\.[a-zA-Z.]+)'/g)].map((m) => m[1]).filter((k) => sections.has(k.split('.')[0]));
    keys.push(...[...src.matchAll(/(?:this\.button|B)\('(\w+)'\)/g)].map((m) => `ui.buttons.${m[1]}`));
    for (const key of new Set(keys)) if (resolve(key) === undefined) missing.push(`${key} (used in ${file})`);
  }
  assert.deepEqual(missing, []);
});

test('every city, chip, start option, climate level and rating has text', () => {
  for (const id of portIds) {
    assert.ok(text.ports[id]?.name, `ports.${id}.name`);
    assert.ok(text.ports[id]?.description, `ports.${id}.description`);
  }
  for (const id of goodIds) assert.ok(text.goods[id]?.name, `goods.${id}.name`);
  for (const o of config.startOptions) {
    assert.ok(text.startOptions[o.id]?.name, `startOptions.${o.id}.name`);
    assert.ok(text.startOptions[o.id]?.description, `startOptions.${o.id}.description`);
  }
  for (const l of config.doom.levels) assert.ok(text.climate.levels[l.id]?.name, `climate.levels.${l.id}.name`);
  for (const r of config.ratings) {
    assert.ok(text.ratings[r.id]?.title, `ratings.${r.id}.title`);
    assert.ok(text.ratings[r.id]?.text, `ratings.${r.id}.text`);
  }
  for (const reason of ['fired', 'resigned', 'ceoOusted']) assert.ok(text.endings[reason], `endings.${reason}`);
  assert.equal(text.months.length, 12);
});

test('doom meter and penalty settings make sense', () => {
  const { levels, start, max, eventChance } = config.doom;
  assert.ok(start >= 0 && start < max, `doom.start ${start} must be between 0 and max`);
  assert.ok(eventChance >= 0 && eventChance <= 1, 'doom.eventChance is a chance between 0 and 1');
  const P = config.profile;
  assert.ok(P.max > 0 && P.hawkMultiplierAtMax >= 1, 'profile.max > 0 and profile.hawkMultiplierAtMax >= 1');
  assert.equal(levels[0].from, 0, 'the first doom level starts at 0');
  for (const [i, l] of levels.entries()) {
    assert.ok(l.penaltyMultiplier >= 0, `${l.id}: penaltyMultiplier`);
    assert.ok(l.from < max, `${l.id}: "from" must be below max`);
    if (i > 0) assert.ok(l.from > levels[i - 1].from, `${l.id}: levels must be in rising order of "from"`);
  }
  for (const name of config.penalty.factors) assert.ok(PENALTY_FACTORS[name], `penalty factor "${name}" is not defined in js/penalty.js`);
});

test('Washington gets angrier on average: doom events push the meter up', () => {
  const mid = (v) => (Array.isArray(v) ? (v[0] + v[1]) / 2 : v);
  const doom = config.politics.events.filter((e) => e.kind === 'doom');
  assert.ok(doom.length > 0, 'there must be doom events, or the CEO is never forced out');
  const weight = doom.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  const average = doom.reduce((sum, e) => sum + (e.weight ?? 1) * mid(e.value), 0) / weight;
  assert.ok(average > 0, `doom events average ${average.toFixed(2)} points; they must average above 0 so the game ends`);
});

test('every chip has a price and a production rate', () => {
  for (const g of config.goods) {
    assert.ok(g.basePrice > 0, `${g.id}: basePrice`);
    assert.ok(Array.isArray(g.production) || typeof g.production === 'number', `${g.id}: production`);
    assert.ok((g.depreciation ?? 0) >= 0 && (g.depreciation ?? 0) < 1, `${g.id}: depreciation`);
  }
});

test('every political event is valid and has text', () => {
  const instant = ['doom', 'target', 'heat', 'revenue'];
  const range = (v) => typeof v === 'number' || (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number'));
  const validPort = (p) => portIds.includes(p);
  for (const ev of config.politics.events) {
    assert.ok(EVENT_KINDS.includes(ev.kind), `${ev.id}: unknown kind "${ev.kind}"`);
    const t = text.events[ev.id];
    assert.ok(t?.headline, `events.${ev.id}.headline`);
    assert.ok(t?.body, `events.${ev.id}.body`);
    if (!instant.includes(ev.kind)) {
      assert.ok(t.end, `events.${ev.id}.end (shown when it expires)`);
      assert.ok(Array.isArray(ev.months), `${ev.id}: needs "months": [min, max]`);
    }
    if (Array.isArray(ev.port)) for (const p of ev.port) assert.ok(validPort(p), `${ev.id}: unknown city ${p}`);
    else if (ev.port && !['all', 'random', 'randomForeign', 'home'].includes(ev.port)) assert.ok(validPort(ev.port), `${ev.id}: unknown city ${ev.port}`);
    if (ev.good && !['all', 'random'].includes(ev.good)) assert.ok(goodIds.includes(ev.good), `${ev.id}: unknown chip ${ev.good}`);
    if (ev.kind === 'legality') assert.ok(LEGALITY_ORDER.includes(ev.legality), `${ev.id}: bad legality`);
    if (ev.kind === 'closure') assert.ok(typeof ev.port === 'string' && ev.port !== 'all', `${ev.id}: closures need a single city`);
    if (ev.kind === 'doom') assert.ok(range(ev.value), `${ev.id}: doom value must be a number or [min, max]`);
    if (ev.doom !== undefined) assert.ok(range(ev.doom), `${ev.id}: "doom" must be a number or [min, max]`);
    if (['price', 'freightCost', 'production', 'inspection', 'corruption', 'target', 'heat', 'revenue'].includes(ev.kind)) {
      assert.ok(ev.value !== undefined, `${ev.id}: needs "value"`);
    }
  }
});

test('every fixer rating has a label and a line from the fixer', () => {
  const tiers = config.customs.bribeHintThresholds.length + 1;
  assert.equal(text.briberyLevels.length, tiers, `briberyLevels needs ${tiers} labels (one more than customs.bribeHintThresholds)`);
  assert.equal(text.inspection.hints.length, tiers, `inspection.hints needs ${tiers} lines (one more than customs.bribeHintThresholds)`);
});

test('every export-control round is valid and has text', () => {
  const { rules, noticeMonths } = config.exportControls;
  assert.ok(Number.isInteger(noticeMonths) && noticeMonths >= 0, 'exportControls.noticeMonths');
  const ids = new Set();
  for (const r of rules) {
    assert.ok(!ids.has(r.id), `${r.id}: duplicate id`);
    ids.add(r.id);
    assert.match(String(r.start), /^\d{4}-(0[1-9]|1[0-2])$/, `${r.id}: "start" must look like "2025-04"`);
    for (const p of [].concat(r.port)) assert.ok(p === 'all' || portIds.includes(p), `${r.id}: unknown city ${p}`);
    assert.ok(r.good === 'all' || goodIds.includes(r.good), `${r.id}: unknown chip ${r.good}`);
    assert.ok(LEGALITY_ORDER.includes(r.legality), `${r.id}: bad legality`);
    assert.ok(text.exportControls.rules[r.id]?.rule, `exportControls.rules.${r.id}.rule`);
    assert.ok(text.exportControls.rules[r.id]?.body, `exportControls.rules.${r.id}.body`);
  }
});

test('cities reference real chips and legal statuses', () => {
  assert.ok(portIds.includes(config.homePort));
  for (const p of config.ports) {
    for (const [good, leg] of Object.entries(p.legality || {})) {
      assert.ok(goodIds.includes(good), `${p.id}.legality: unknown chip ${good}`);
      assert.ok(LEGALITY_ORDER.includes(leg), `${p.id}.legality.${good}: "${leg}"`);
    }
    for (const good of Object.keys(p.prices || {})) assert.ok(goodIds.includes(good), `${p.id}.prices: unknown chip ${good}`);
  }
  assert.ok(config.politics.minOpenPorts <= portIds.length);
});
