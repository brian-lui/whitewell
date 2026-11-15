import { readFileSync } from 'node:fs';
import { createGame } from '../js/engine.js';

const root = new URL('../', import.meta.url);
export const loadJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
export const loadConfig = () => loadJson('data/config.json');
export const loadText = () => loadJson('data/text.json');

// A config with every random event switched off, so tests control what happens.
export function quietConfig(edit = () => {}) {
  const c = loadConfig();
  c.logistics.eventChance = 0;
  c.politics.eventChance = 0;
  c.market.eventChance = 0;
  c.offers.freightChance = 0;
  c.doom.eventChance = 0;
  c.exportControls.rules = [];
  for (const p of c.ports) p.inspection = 0;
  c.heat.inspectionPerPoint = 0;
  edit(c);
  return c;
}

export function newGame(config = quietConfig(), opts = {}) {
  return createGame(config, { name: 'Tester', startId: 'steady', seed: 12345, ...opts });
}

// Click "continue" (or the given choice) through every pending event screen.
export function drain(game, choice = 'cooperate') {
  const seen = [];
  for (let step = game.currentStep(); step; step = game.currentStep()) {
    seen.push(step);
    const choices = game.stepChoices(step).filter((c) => c.enabled).map((c) => c.id);
    const r = game.resolveStep(choices.includes(choice) ? choice : choices[0]);
    if (!r.ok) throw new Error(`could not resolve ${step.type}: ${r.error}`);
  }
  return seen;
}

// Let n months pass by flying between two foreign cities.
export function advanceMonths(game, n, cities = ['singapore', 'kualalumpur']) {
  for (let i = 0; i < n; i++) {
    const dest = game.state.port === cities[0] ? cities[1] : cities[0];
    const r = game.travel(dest);
    if (!r.ok) throw new Error(`could not travel to ${dest}: ${r.error}`);
    drain(game);
  }
}
