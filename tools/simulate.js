// Balance simulator: plays many games with simple bots and prints how they did.
// Usage: node tools/simulate.js [gamesPerBot=1000] [startOptionId]
// Edit data/config.json, re-run, compare. A healthy setup: playing it straight
// is safe but tends to fall behind rising targets; smuggling earns more but
// sometimes gets you fired.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGame } from '../js/engine.js';

// What a player can work out from the Regulations and News screens: the price
// in that city next month, before the random swing.
function expectedPrice(g, port, good) {
  const p = g.portsById[port];
  const lf = g.config.legalityPriceFactor;
  let v = g.currentBase(good, g.state.month + 1) * (p.prices?.[good] ?? 1);
  v *= lf[g.legality(port, good)] / lf[g.portLegality(port, good)];
  for (const e of g.effectsFor('price', port, good)) v *= e.value;
  return v;
}

// Expected customs loss per unit of this chip flown into that city.
function expectedLoss(g, port, good, value) {
  const leg = g.legality(port, good);
  if (leg === 'legal') return 0;
  const p = g.inspectionChance(port);
  const mult = g.climateLevel().penaltyMultiplier;
  const c = g.config.customs;
  if (leg === 'restricted') return p * value * c.dutyRate * mult;
  return p * value * (1 + c.fineRate * mult);
}

export const BOTS = {
  // Only carries chips that are fully legal where it's going.
  lawful: { restricted: false, smuggleUpTo: -1, riskWeight: 1, bribeAbove: 2 },
  // Pays license penalties when caught, never carries banned chips.
  cautious: { restricted: true, smuggleUpTo: -1, riskWeight: 1, bribeAbove: 2 },
  // Smuggles Whitewell into China only when the climate is calm or better.
  careful: { restricted: true, smuggleUpTo: 1, riskWeight: 1, bribeAbove: 0.45 },
  // Smuggles unless there's a crackdown.
  smuggler: { restricted: true, smuggleUpTo: 2, riskWeight: 1, bribeAbove: 0.45 },
  // Always smuggles, ignores the risk, always bribes.
  reckless: { restricted: true, smuggleUpTo: 99, riskWeight: 0, bribeAbove: 0 },
};

function allowed(g, bot, port, good) {
  const leg = g.legality(port, good);
  if (leg === 'restricted') return bot.restricted;
  if (leg === 'contraband') return g.climateIndex() <= bot.smuggleUpTo;
  return true;
}

function unitValue(g, bot, port, good) {
  if (!allowed(g, bot, port, good)) return -Infinity;
  const v = expectedPrice(g, port, good);
  return v - bot.riskWeight * expectedLoss(g, port, good, v);
}

function expectedMonthlyOutput(g) {
  return g.config.goods.reduce((sum, c) => {
    const avg = Array.isArray(c.production) ? (c.production[0] + c.production[1]) / 2 : c.production || 0;
    return sum + avg * g.productionFactor(c.id);
  }, 0);
}

// At home: pick a destination and the load that earns most there.
function planTrip(g, bot) {
  let best = null;
  for (const dest of g.openPorts()) {
    if (dest === g.home) continue;
    let space = g.state.capacity;
    let value = -g.freightCost();
    const load = [];
    const ranked = g.goodIds
      .map((good) => ({ good, v: unitValue(g, bot, dest, good) }))
      .filter((r) => r.v > g.price(r.good))
      .sort((a, b) => b.v - a.v);
    for (const r of ranked) {
      const n = Math.min(space, g.state.warehouse[r.good]);
      if (!n) continue;
      load.push([r.good, n]);
      value += n * r.v;
      space -= n;
    }
    if (!best || value > best.value) best = { dest, load, value };
  }
  return best;
}

function homeTurn(g, bot) {
  const s = g.state;
  for (const id of g.goodIds) if (s.hold[id]) g.unload(id, Math.min(s.hold[id], g.warehouseFree()));
  const plan = planTrip(g, bot);
  for (const [good, n] of plan.load) g.load(good, n);
  const byValue = [...g.goodIds].sort((a, b) => g.currentBase(a) - g.currentBase(b));
  // Make room for the next two months of production by selling the cheapest stock here.
  let need = Math.ceil(2 * expectedMonthlyOutput(g)) - g.warehouseFree();
  for (const id of byValue) {
    if (need <= 0) break;
    const n = Math.min(need, s.warehouse[id]);
    if (n > 0) { g.sell(id, n); need -= n; }
  }
  // Last month of the quarter and short of target: dump stock at home to close the gap.
  if (g.monthsLeftInQuarter() === 1) {
    for (const id of [...byValue].reverse()) {
      const gap = s.target - (g.net() - g.freightCost());
      if (gap <= 0) break;
      const n = Math.min(s.warehouse[id], Math.ceil(gap / g.price(id)));
      if (n > 0) g.sell(id, n);
    }
  }
  return plan.dest;
}

function abroadTurn(g, bot) {
  const s = g.state;
  const mustSell = g.monthsLeftInQuarter() === 1 && g.net() < s.target;
  // Keep chips that another city pays much more for; sell the rest here.
  let best = { port: g.home, keep: [], extra: 0 };
  if (!mustSell) {
    for (const p of g.openPorts()) {
      if (p === s.port || p === g.home) continue;
      const keep = [];
      let extra = -g.freightCost();
      for (const id of g.goodIds) {
        const n = s.hold[id];
        if (!n) continue;
        const v = unitValue(g, bot, p, id);
        if (v > g.price(id) * 1.25) { keep.push(id); extra += n * (v - g.price(id)); }
      }
      if (keep.length && extra > best.extra) best = { port: p, keep, extra };
    }
  }
  for (const id of g.goodIds) if (s.hold[id] && !best.keep.includes(id)) g.sell(id, s.hold[id]);
  return best.port;
}

export function playGame(config, seed, botName, startId) {
  const bot = BOTS[botName];
  const g = createGame(config, { name: botName, startId, seed });
  let guard = 0;
  while (!g.state.gameOver && guard++ < 3000) {
    const step = g.currentStep();
    if (step) {
      const choices = g.stepChoices(step).filter((c) => c.enabled).map((c) => c.id);
      let choice = choices[0];
      if (choices.includes('bribe') && step.data.bribeChance >= bot.bribeAbove) choice = 'bribe';
      if (choices.includes('accept')) choice = step.data.price < 0.12 * g.state.target ? 'accept' : 'decline';
      g.resolveStep(choice);
      continue;
    }
    g.travel(g.atHome ? homeTurn(g, bot) : abroadTurn(g, bot));
  }
  const s = g.state;
  return {
    bonus: s.bonus,
    reason: s.gameOver?.reason,
    profile: s.profile,
    month: s.gameOver?.month ?? s.month,
    met: s.quarters.filter((q) => q.met).length,
    quarters: s.quarters.length,
    nets: s.quarters.map((q) => q.net),
    targets: s.quarters.map((q) => q.target),
    stats: s.stats,
  };
}

function main() {
  const config = JSON.parse(readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
  const text = JSON.parse(readFileSync(new URL('../data/text.json', import.meta.url), 'utf8'));
  const GAMES = Number(process.argv[2]) || 1000;
  const START = process.argv[3] || config.startOptions[0].id;
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const date = (m) => {
    const idx = config.calendar.startMonth - 1 + m;
    return `${text.months[idx % 12]} ${config.calendar.startYear + Math.floor(idx / 12)}`;
  };
  const share = (list) => `${Math.round((100 * list.length) / GAMES)}%`;

  console.log(`${GAMES} games per bot, start "${START}". The game ends when the CEO is forced out (or you're fired).\n`);
  for (const name of Object.keys(BOTS)) {
    const results = [];
    for (let i = 0; i < GAMES; i++) results.push(playGame(config, 1000 + i, name, START));
    const bonuses = results.map((r) => r.bonus).sort((a, b) => a - b);
    const ratings = {};
    for (const b of bonuses) {
      let best = config.ratings[0];
      for (const r of config.ratings) if (b >= (r.min ?? -Infinity)) best = r;
      ratings[best.id] = (ratings[best.id] || 0) + 1;
    }
    const fired = results.filter((r) => r.reason === 'fired');
    const ousted = results.filter((r) => r.reason === 'ceoOusted');
    const avg = (list, f) => (list.length ? list.reduce((s, r) => s + f(r), 0) / list.length : 0).toFixed(1);
    const months = (list) => list.map((r) => r.month).sort((a, b) => a - b);
    const out = months(ousted);
    const ends = months(results);
    console.log(`== ${name}`);
    console.log(`  bonus        p10 ${money(pct(bonuses, 0.1))}  median ${money(pct(bonuses, 0.5))}  p90 ${money(pct(bonuses, 0.9))}  max ${money(bonuses.at(-1))}`);
    console.log(`  how it ended CEO forced out ${share(ousted)}, fired ${share(fired)}`);
    if (out.length) console.log(`  CEO out      earliest 10% by ${date(pct(out, 0.1))}   median ${date(pct(out, 0.5))}   latest 10% ${date(pct(out, 0.9))}`);
    if (fired.length) console.log(`  fired        median ${date(pct(months(fired), 0.5))}`);
    console.log(`  game over    median ${date(pct(ends, 0.5))} (any reason)`);
    console.log(`  per game     targets met ${avg(results, (r) => r.met)}/${avg(results, (r) => r.quarters)}   banned chips sold ${avg(results, (r) => r.stats.smuggled)}   inspections ${avg(results, (r) => r.stats.inspections)}   seizures ${avg(results, (r) => r.stats.seizures)}   final profile ${avg(results, (r) => r.profile)}`);
    console.log(`  ratings      ${config.ratings.map((r) => `${r.id} ${((100 * (ratings[r.id] || 0)) / GAMES).toFixed(0)}%`).join('  ')}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
