// Game rules. No DOM and no text here: the engine returns text *keys* and
// variables, and the UI looks them up in data/text.json.
// Works in the browser and in Node (for tests and the balance simulator).
import { penaltyMultiplier } from './penalty.js';

export const SAVE_VERSION = 5;
export const LEGALITY_ORDER = ['legal', 'restricted', 'contraband'];
const DURATIONAL_KINDS = ['price', 'legality', 'inspection', 'corruption', 'closure', 'freightCost', 'production'];
const INSTANT_KINDS = ['doom', 'target', 'heat', 'revenue'];
export const EVENT_KINDS = [...DURATIONAL_KINDS, ...INSTANT_KINDS];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rank = (legality) => LEGALITY_ORDER.indexOf(legality);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const roundTo = (v, step) => Math.round(v / step) * step;
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, vars = {}) => ({ ok: false, error, vars });

export function createGame(config, { name = 'Manager', startId, seed } = {}) {
  const start = config.startOptions.find((s) => s.id === startId) || config.startOptions[0];
  const empty = () => Object.fromEntries(config.goods.map((g) => [g.id, 0]));
  const state = {
    version: SAVE_VERSION,
    rng: (seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0,
    name,
    startId: start.id,
    month: 0,
    port: config.homePort,
    capacity: start.capacity,
    hold: empty(),
    warehouse: empty(),
    delivered: empty(), // production since you were last home (for the arrival report)
    reallocated: empty(), // production lost because the warehouse was full
    heat: 0,
    doom: config.doom.start, // the political doom meter: at doom.max the CEO is forced out, and the game ends
    profile: 0, // how visible your smuggling is in Washington: makes the hawks more aggressive
    pendingEnd: null, // set when the game will end once the current screens are dealt with
    target: start.target,
    targetScale: 1,
    quarter: { sales: 0, costs: 0 },
    quarters: [],
    bonus: 0,
    misses: 0,
    prices: {},
    effects: [],
    news: [],
    queue: [],
    seq: 0,
    stats: { trips: 0, sales: 0, smuggled: 0, inspections: 0, seizures: 0, bribesPaid: 0, bribesFailed: 0, finesPaid: 0 },
    gameOver: null,
  };
  const game = new Game(config, state);
  game._announceRules(0, true);
  // A first quarter with fewer trips than usual (e.g. starting in January, when the
  // first shipment lands in February) gets a proportionally smaller target.
  state.targetScale = Math.min(1, game.firstQuarterEnd / game.monthsPerQuarter);
  state.target = roundTo(start.target * state.targetScale, config.targets.roundTo || 10000);
  game.produce();
  state.delivered = empty();
  state.reallocated = empty();
  game.generatePrices();
  return game;
}

export class Game {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.goodsById = Object.fromEntries(config.goods.map((g) => [g.id, g]));
    this.portsById = Object.fromEntries(config.ports.map((p) => [p.id, p]));
    // Export-control rounds: permanent rule changes on a fixed schedule.
    this.rules = (config.exportControls?.rules || []).map((r) => ({ ...r, month: this.monthOf(r.start) }));
    this.normalize();
  }

  // Make an old save safe to use after goods/ports were edited in config.json.
  normalize() {
    const s = this.state;
    for (const box of [s.hold, s.warehouse, s.delivered, s.reallocated]) {
      for (const g of this.config.goods) if (typeof box[g.id] !== 'number') box[g.id] = 0;
      for (const id of Object.keys(box)) if (!this.goodsById[id]) delete box[id];
    }
    if (!this.portsById[s.port]) s.port = this.config.homePort;
    s.doom = clamp(s.doom ?? this.config.doom.start, 0, this.config.doom.max);
    s.profile = clamp(s.profile ?? 0, 0, this.config.profile.max);
    s.targetScale ??= 1;
    s.stats.smuggled ??= 0;
    const portOk = (p) => p == null || p === 'all'
      || (Array.isArray(p) ? p.every((x) => this.portsById[x]) : !!this.portsById[p]);
    s.effects = s.effects.filter((e) => portOk(e.port) && (e.good == null || e.good === 'all' || this.goodsById[e.good]));
    if (this.config.goods.some((g) => typeof s.prices[g.id] !== 'number')) this.generatePrices();
  }

  // ---------- randomness (seeded, stored in the save so reloading can't re-roll) ----------
  random() {
    let t = (this.state.rng = (this.state.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p) { return this.random() < p; }
  randRange(v) { return Array.isArray(v) ? v[0] + (v[1] - v[0]) * this.random() : v; }
  randInt(v) { return Array.isArray(v) ? v[0] + Math.floor(this.random() * (v[1] - v[0] + 1)) : v; }
  pick(arr) { return arr[Math.floor(this.random() * arr.length)]; }
  pickWeighted(arr) {
    const total = arr.reduce((sum, x) => sum + (x.weight ?? 1), 0);
    let r = this.random() * total;
    for (const x of arr) { r -= x.weight ?? 1; if (r < 0) return x; }
    return arr[arr.length - 1];
  }

  // ---------- queries ----------
  get goodIds() { return this.config.goods.map((g) => g.id); }
  get portIds() { return this.config.ports.map((p) => p.id); }
  get home() { return this.config.homePort; }
  get atHome() { return this.state.port === this.config.homePort; }
  get startOption() { return this.config.startOptions.find((o) => o.id === this.state.startId) || this.config.startOptions[0]; }
  get busy() { return this.state.queue.length > 0 || !!this.state.gameOver; }

  // Quarters follow the calendar (Jan-Mar, Apr-Jun...). The first quarter also
  // includes your starting month, so starting the calendar one month before a
  // quarter (e.g. December) gives the first quarter three full trips.
  get monthsPerQuarter() { return this.config.targets.monthsPerQuarter || 3; }
  calendarIndex(month) { return this.config.calendar.startMonth - 1 + month; }
  get firstQuarterEnd() {
    const k = this.monthsPerQuarter;
    let m = 1;
    while (this.calendarIndex(m) % k !== k - 1) m++;
    return m;
  }
  quarterIndex(month = this.state.month) {
    const first = this.firstQuarterEnd;
    return month <= first ? 0 : Math.ceil((month - first) / this.monthsPerQuarter);
  }
  quarterEnd(month = this.state.month) { return this.firstQuarterEnd + this.quarterIndex(month) * this.monthsPerQuarter; }
  quarterStart(month = this.state.month) {
    return this.quarterIndex(month) === 0 ? 0 : this.quarterEnd(month) - this.monthsPerQuarter + 1;
  }
  isQuarterEnd(month) { return month === this.quarterEnd(month); }
  monthsLeftInQuarter() { return this.quarterEnd() - this.state.month + 1; } // counts this month
  net() { return this.state.quarter.sales - this.state.quarter.costs; }
  // The political climate is the band of the doom meter you're in (doom.levels[].from).
  climateIndex(doom = this.state.doom) {
    const levels = this.config.doom.levels;
    let idx = 0;
    levels.forEach((l, i) => { if (doom >= l.from) idx = i; });
    return idx;
  }
  climateLevel(doom = this.state.doom) { return this.config.doom.levels[this.climateIndex(doom)]; }
  penaltyMultiplier(context = {}) { return penaltyMultiplier(this, { port: this.state.port, ...context }); }

  effectsFor(kind, port, good) {
    return this.state.effects.filter((e) => e.kind === kind
      && (port === undefined || e.port == null || e.port === 'all' || e.port === port
        || (Array.isArray(e.port) && e.port.includes(port)))
      && (good === undefined || e.good == null || e.good === 'all' || e.good === good));
  }
  // Effects that name this city (for "local news"), not world-wide ones.
  localEffects(port) {
    return this.state.effects.filter((e) => e.port === 'all' || e.port === port || (Array.isArray(e.port) && e.port.includes(port)));
  }

  // A month index for a "YYYY-MM" date (0 = the month the game starts).
  monthOf(date) {
    const [y, m] = String(date).split('-').map(Number);
    const c = this.config.calendar;
    return (y - c.startYear) * 12 + (m - c.startMonth);
  }
  _covers(spec, id) { return spec == null || spec === 'all' || spec === id || (Array.isArray(spec) && spec.includes(id)); }
  rulesInForce(month = this.state.month) { return this.rules.filter((r) => r.month <= month); }
  // Rules already announced but not in force yet.
  upcomingRules(month = this.state.month) {
    const notice = this.config.exportControls?.noticeMonths ?? 3;
    return this.rules.filter((r) => r.month > month && r.month - notice <= month);
  }
  // The city's own rules (config.json → ports[].legality). Prices are set against these.
  portLegality(port, good) { return this.portsById[port]?.legality?.[good] || 'legal'; }
  // The city's rules plus every export-control round in force. Rounds only make things
  // stricter unless they say "mode": "set". Pass a later month to see the rules then.
  baseLegality(port, good, month = this.state.month) {
    let legality = this.portLegality(port, good);
    for (const r of this.rules) {
      if (r.month > month || !this._covers(r.port, port) || !this._covers(r.good, good)) continue;
      if (r.mode === 'set' || rank(r.legality) > rank(legality)) legality = r.legality;
    }
    return legality;
  }
  // The rules plus any events changing them. For a later month, this is what's known
  // now: rounds in force by then, and only the events that won't have run out.
  // (An effect expires at the next new month when it has 1 month left.)
  legality(port, good, month = this.state.month) {
    let legality = this.baseLegality(port, good, month);
    const ahead = month - this.state.month;
    for (const e of this.effectsFor('legality', port, good)) {
      if (ahead > 0 && e.monthsLeft <= ahead) continue;
      if (e.mode === 'max') { if (rank(e.value) > rank(legality)) legality = e.value; }
      else legality = e.value;
    }
    return legality;
  }
  // The month you'd land in that city if you set off now: a trip out takes a month,
  // flying home is instant.
  arrivalMonth(port) { return port === this.home ? this.state.month : this.state.month + 1; }
  // Whether an effect will still be running in that month: the same rule as legality().
  _lasts(e, month) {
    const ahead = month - this.state.month;
    return ahead <= 0 || e.monthsLeft > ahead;
  }

  // Pass a later month for the chance then, as far as is known now: heat cools by
  // heat.monthlyDecay a month, and only the events that won't have run out count.
  inspectionChance(port, month = this.state.month) {
    const ahead = month - this.state.month;
    const heat = ahead > 0 ? Math.max(0, this.state.heat - ahead * this.config.heat.monthlyDecay) : this.state.heat;
    const base = this.portsById[port].inspection + heat * this.config.heat.inspectionPerPoint;
    const mod = this.effectsFor('inspection', port).filter((e) => this._lasts(e, month)).reduce((sum, e) => sum + e.value, 0);
    return clamp(base + mod, 0, this.config.customs.maxChance);
  }
  customsLevel(port, month = this.state.month) {
    if (this.isClosed(port, month)) return 'closed';
    const c = this.inspectionChance(port, month);
    if (c <= 0) return 'none';
    const idx = this.config.customs.levelThresholds.findIndex((t) => c < t);
    return ['lax', 'normal', 'strict', 'crackdown'][idx === -1 ? 3 : idx];
  }
  bribeChance(port) {
    const base = this.portsById[port].corruption - this.state.heat * this.config.heat.bribePenaltyPerPoint;
    const mod = this.effectsFor('corruption', port).reduce((sum, e) => sum + e.value, 0);
    return clamp(base + mod, 0, 0.95);
  }
  bribeHint(chance) {
    const idx = this.config.customs.bribeHintThresholds.findIndex((t) => chance < t);
    return idx === -1 ? this.config.customs.bribeHintThresholds.length : idx;
  }
  isClosed(port, month = this.state.month) {
    return this.effectsFor('closure', port).some((e) => e.port === port && this._lasts(e, month));
  }
  openPorts(month = this.state.month) { return this.portIds.filter((p) => !this.isClosed(p, month)); }
  freightCost() {
    const { costBase, costPerUnit } = this.config.freight;
    const mult = this.effectsFor('freightCost').reduce((m, e) => m * e.value, 1);
    return Math.round((costBase + costPerUnit * this.state.capacity) * mult);
  }

  used(box) { return Object.values(box).reduce((a, b) => a + b, 0); }
  holdUsed() { return this.used(this.state.hold); }
  holdFree() { return this.state.capacity - this.holdUsed(); }
  warehouseUsed() { return this.used(this.state.warehouse); }
  warehouseFree() { return this.config.warehouse.capacity - this.warehouseUsed(); }
  // What you can sell here: your cargo, plus the warehouse when you're home.
  stock(good) { return this.state.hold[good] + (this.atHome ? this.state.warehouse[good] : 0); }
  price(good) { return this.state.prices[good]; }
  // List price today. Older chips lose value every month (goods[].depreciation).
  currentBase(good, month = this.state.month) {
    const g = this.goodsById[good];
    return g.basePrice * Math.pow(1 - (g.depreciation || 0), month);
  }

  // ---------- production ----------
  // Multiplier on a chip's monthly output: its long-term trend times any political effects.
  productionFactor(good) {
    const g = this.goodsById[good];
    const trend = Math.pow(1 + (g.productionTrend || 0), this.state.month);
    return this.effectsFor('production', undefined, good).reduce((m, e) => m * e.value, trend);
  }
  // A month of output lands in the home warehouse. Whatever doesn't fit goes to another region.
  produce() {
    const s = this.state;
    for (const g of this.config.goods) {
      const made = Math.max(0, Math.round(this.randInt(g.production || 0) * this.productionFactor(g.id)));
      const kept = Math.min(made, this.warehouseFree());
      s.warehouse[g.id] += kept;
      s.delivered[g.id] += kept;
      s.reallocated[g.id] += made - kept;
    }
  }

  // ---------- prices ----------
  generatePrices() {
    const port = this.state.port;
    for (const g of this.config.goods) {
      let p = this._listPrice(port, g.id);
      p *= 1 + g.volatility * (2 * this.random() - 1);
      for (const e of this.effectsFor('price', port, g.id)) p *= e.value;
      this.state.prices[g.id] = Math.max(1, Math.round(p));
    }
  }
  // A chip's price in that city before the random swing and price events: the list
  // price that month, the city's demand, and the premium for its rules then.
  _listPrice(port, good, month = this.state.month) {
    const lf = this.config.legalityPriceFactor;
    return this.currentBase(good, month) * (this.portsById[port].prices?.[good] ?? 1)
      * (lf[this.legality(port, good, month)] / lf[this.portLegality(port, good)]);
  }
  // What a chip should fetch in that city when you'd land there, as far as is known
  // now: price events still running then count, but not the market's random swing,
  // spikes and crashes, or events that haven't happened yet. An estimate.
  indicativePrice(port, good, month = this.arrivalMonth(port)) {
    let p = this._listPrice(port, good, month);
    for (const e of this.effectsFor('price', port, good)) if (this._lasts(e, month)) p *= e.value;
    return Math.max(1, Math.round(p));
  }

  // ---------- player actions ----------
  _guard({ home = false } = {}) {
    if (this.state.gameOver || this.state.pendingEnd) return fail('errors.gameOver');
    if (this.state.queue.length) return fail('errors.busy');
    if (home && !this.atHome) return fail('errors.homeOnly');
    return null;
  }
  _amount(n) {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  _charge(amount) { this.state.quarter.costs += amount; }

  // At home, sales come out of the warehouse first, then your cargo.
  sell(good, qty) {
    const g = this._guard(); if (g) return g;
    const n = this._amount(qty); if (!n || !this.goodsById[good]) return fail('errors.invalidAmount');
    if (n > this.stock(good)) return fail('errors.notEnoughGoods', { good });
    const s = this.state;
    const fromWarehouse = this.atHome ? Math.min(n, s.warehouse[good]) : 0;
    s.warehouse[good] -= fromWarehouse;
    s.hold[good] -= n - fromWarehouse;
    const amount = n * this.price(good);
    s.quarter.sales += amount;
    s.stats.sales += amount;
    // Banned chips sold on the gray market get noticed in Washington.
    let profile = 0;
    if (this.legality(s.port, good) === 'contraband') {
      s.stats.smuggled += n;
      profile = this._addProfile(n * this.config.profile.perBannedUnitSold);
    }
    return ok({ amount, profile });
  }
  load(good, qty) {
    const g = this._guard({ home: true }); if (g) return g;
    const n = this._amount(qty); if (!n || !this.goodsById[good]) return fail('errors.invalidAmount');
    if (n > this.state.warehouse[good]) return fail('errors.notEnoughGoods', { good });
    if (n > this.holdFree()) return fail('errors.notEnoughSpace', { free: this.holdFree() });
    this.state.warehouse[good] -= n; this.state.hold[good] += n;
    return ok();
  }
  unload(good, qty) {
    const g = this._guard({ home: true }); if (g) return g;
    const n = this._amount(qty); if (!n || !this.goodsById[good]) return fail('errors.invalidAmount');
    if (n > this.state.hold[good]) return fail('errors.notEnoughGoods', { good });
    if (n > this.warehouseFree()) return fail('errors.warehouseFull', { free: this.warehouseFree() });
    this.state.hold[good] -= n; this.state.warehouse[good] += n;
    return ok();
  }
  // Fill the cargo space from the warehouse, most valuable chips first.
  loadAll() {
    const g = this._guard({ home: true }); if (g) return g;
    const order = [...this.goodIds].sort((a, b) => this.currentBase(b) - this.currentBase(a));
    let loaded = 0;
    for (const id of order) {
      const n = Math.min(this.state.warehouse[id], this.holdFree());
      if (n > 0) { this.state.warehouse[id] -= n; this.state.hold[id] += n; loaded += n; }
    }
    return ok({ loaded });
  }

  resign() {
    const g = this._guard({ home: true }); if (g) return g;
    this._endGame('resigned');
    return ok();
  }
  _endGame(reason) {
    this.state.gameOver = { reason, bonus: this.state.bonus, month: this.state.month };
    this.state.queue = [];
  }

  // ---------- quarters ----------
  // Score the quarter, pay the bonus, set the next target. Returns the review.
  _closeQuarter(startMonth, endMonth) {
    const s = this.state;
    const T = this.config.targets;
    const B = this.config.bonus;
    const { sales, costs } = s.quarter;
    const net = sales - costs;
    const target = s.target;
    const met = net >= target;
    const bonus = met
      ? roundTo((target * B.onTarget + (net - target) * B.overTarget) * (this.startOption.bonusMultiplier ?? 1), 100)
      : 0;
    s.misses = met ? 0 : s.misses + 1;
    s.bonus += bonus;
    s.quarters.push({ startMonth, endMonth, sales, costs, net, target, bonus, met });
    // Targets grow every quarter, and a big quarter raises the bar (the ratchet).
    const fullTarget = target / (s.targetScale || 1);
    s.targetScale = 1;
    s.target = roundTo(Math.max(fullTarget * (1 + T.growth), net * T.ratchet), T.roundTo || 10000);
    s.quarter = { sales: 0, costs: 0 };
    return { startMonth, endMonth, sales, costs, net, target, bonus, met, misses: s.misses, fired: s.misses >= T.missesToFire, next: s.target };
  }

  // ---------- travel ----------
  // A trip out to a city takes a month and costs freight. Flying back home is
  // quick and free, so every month can be one sales trip.
  travel(dest) {
    const g = this._guard(); if (g) return g;
    if (!this.portsById[dest]) return fail('errors.invalidPort');
    if (dest === this.state.port) return fail('errors.alreadyHere');
    // A closure that ends before you'd land doesn't stop you. One that starts on the
    // way diverts you below.
    if (this.isClosed(dest, this.arrivalMonth(dest))) return fail('errors.portClosed', { port: dest });
    if (dest === this.home) return this._returnHome();

    const s = this.state;
    const from = s.port;
    this._charge(this.freightCost());
    s.stats.trips++;
    this._tickMonth();
    if (s.gameOver) return ok(); // fired at the quarterly review
    this._rollDoom();
    this._rollPolitics();
    this.produce(); // after the news, so a production event covers the month it's announced
    if (s.pendingEnd) return ok(); // the doom meter maxed out on the way: the trip never lands

    let to = dest;
    if (this.chance(this.config.logistics.eventChance)) to = this._logisticsEvent(from, to);
    if (this.isClosed(to)) {
      const alt = this._alternative(to, from);
      this._push('message', { key: 'voyage.diverted', vars: { dest: to, port: alt } });
      to = alt;
    }
    this._arrive(to);
    return ok();
  }

  _returnHome() {
    this.state.port = this.home;
    this.generatePrices();
    this._push('arrival', { port: this.home });
    this._productionReport();
    return ok();
  }

  // Somewhere else to land when the destination is out: another open foreign city if possible.
  _alternative(to, from) {
    const open = this.openPorts().filter((p) => p !== to && p !== from);
    const foreign = open.filter((p) => p !== this.home);
    if (foreign.length) return this.pick(foreign);
    return open.length ? this.pick(open) : from;
  }

  _push(type, data = {}) {
    this.state.queue.push({ id: ++this.state.seq, type, entered: false, data });
  }
  // headline/body are text keys. A news item without a body is a short update.
  _news(headline, body, vars = {}) {
    const item = { month: this.state.month, headline, body, vars };
    this.state.news.unshift(item);
    this.state.news.length = Math.min(this.state.news.length, 40);
    this._push('news', item);
  }

  _tickMonth() {
    const s = this.state;
    s.heat = Math.max(0, s.heat - this.config.heat.monthlyDecay);
    s.month++;
    if (this.isQuarterEnd(s.month - 1)) {
      const review = this._closeQuarter(this.quarterStart(s.month - 1), s.month - 1);
      if (review.fired) { this._endGame('fired'); return; }
      this._push('quarter', review);
    }
    this._announceRules(s.month);
    const remaining = [];
    for (const e of s.effects) {
      e.monthsLeft--;
      if (e.monthsLeft > 0) remaining.push(e);
      else this._news(`events.${e.eventId}.end`, null, e.vars);
    }
    s.effects = remaining;
  }

  // How much harder the hawks push because of your profile: 1 at profile 0,
  // profile.hawkMultiplierAtMax at a full profile.
  hawkMultiplier() {
    const P = this.config.profile;
    return 1 + (this.state.profile / P.max) * ((P.hawkMultiplierAtMax ?? 1) - 1);
  }
  _addProfile(points) {
    const s = this.state;
    const before = s.profile;
    s.profile = clamp(s.profile + points, 0, this.config.profile.max);
    return s.profile - before;
  }

  // Move the doom meter. Returns the actual change. At the top, the CEO is forced
  // out: the screens already queued (news, messages) still show, then the game ends.
  _addDoom(points) {
    const s = this.state;
    const D = this.config.doom;
    const before = s.doom;
    s.doom = clamp(s.doom + Math.round(points), 0, D.max);
    if (s.doom >= D.max && !s.pendingEnd && !s.gameOver) {
      s.pendingEnd = 'ceoOusted';
      s.queue = s.queue.filter((step) => ['news', 'message', 'quarter'].includes(step.type));
    }
    return s.doom - before;
  }
  _doomVars(change, hawks = 1) {
    const vars = { doomChange: change, doom: this.state.doom, climate: this.climateLevel().id };
    const shown = Math.round(hawks * 10) / 10; // only worth mentioning once it shows as more than ×1
    if (change > 0 && shown > 1) vars.hawks = shown;
    return vars;
  }
  // Political pressure: rises are amplified by your profile (the hawks smell blood).
  _politicalDoom(points) {
    const hawks = points > 0 ? this.hawkMultiplier() : 1;
    return this._doomVars(this._addDoom(points * hawks), hawks);
  }
  // End the game once nothing is left to show.
  _settle() {
    const s = this.state;
    if (s.pendingEnd && !s.gameOver && !s.queue.length) this._endGame(s.pendingEnd);
  }

  // Export-control news for this month: rounds announced in advance, and rounds taking effect.
  // At the start of the game (atStart), rounds whose notice period has already begun are announced too.
  _announceRules(month, atStart = false) {
    const notice = this.config.exportControls?.noticeMonths ?? 3;
    for (const r of this.rules) {
      const announce = r.month - notice;
      if (r.month > month && (atStart ? announce <= month : announce === month)) {
        this._news('exportControls.announced', 'exportControls.announcedBody', { rule: r.id, quarter: r.month });
      }
      if (!atStart && r.month === month) {
        this._news('exportControls.inForce', `exportControls.rules.${r.id}.body`, { rule: r.id });
      }
    }
  }

  // Each month Washington may move the doom meter: one "doom" event, picked by weight.
  _rollDoom() {
    const events = this.config.politics.events.filter((e) => e.kind === 'doom');
    if (!events.length || !this.chance(this.config.doom.eventChance)) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.triggerEvent(this.pickWeighted(events).id)) break;
    }
  }

  // Everything else in the news.
  _rollPolitics() {
    const pol = this.config.politics;
    const events = pol.events.filter((e) => e.kind !== 'doom');
    let n = 0;
    if (this.chance(pol.eventChance)) n = this.chance(pol.secondEventChance) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (this.triggerEvent(this.pickWeighted(events).id)) break;
      }
    }
  }

  // Fire a political event by id. Returns false if it has no valid target right now.
  triggerEvent(id) {
    const ev = this.config.politics.events.find((e) => e.id === id);
    if (!ev) return false;
    const target = this._eventTarget(ev);
    if (!target) return false;
    this._applyEvent(ev, target);
    return true;
  }

  // "port" in an event can be an id, a list of ids (all of them at once),
  // "all", "random", "randomForeign" or "home". "good" can be an id, "all" or "random".
  _eventTarget(ev) {
    const scope = (spec, all, extra = {}) => {
      if (spec == null) return [null];
      if (Array.isArray(spec)) return [spec];
      if (spec === 'all') return ['all'];
      if (spec === 'random') return all;
      if (extra[spec]) return extra[spec];
      return [spec];
    };
    const ports = scope(ev.port, this.portIds, {
      randomForeign: this.portIds.filter((p) => p !== this.home),
      home: [this.home],
    });
    const goods = scope(ev.good, this.goodIds);
    const pairs = [];
    for (const port of ports) for (const good of goods) if (this._validTarget(ev, port, good)) pairs.push({ port, good });
    return pairs.length ? this.pick(pairs) : null;
  }

  _expandPorts(port) {
    if (port == null || port === 'all') return this.portIds;
    return Array.isArray(port) ? port : [port];
  }

  _validTarget(ev, port, good) {
    const s = this.state;
    if (s.effects.some((e) => e.eventId === ev.id && same(e.port, port) && same(e.good, good))) return false;
    switch (ev.kind) {
      case 'legality': {
        const goods = good == null || good === 'all' ? this.goodIds : [good];
        return this._expandPorts(port).some((p) => goods.some((g) => {
          const cur = this.legality(p, g);
          return ev.mode === 'max' ? rank(ev.legality) > rank(cur) : cur !== ev.legality;
        }));
      }
      case 'closure':
        return typeof port === 'string' && !!this.portsById[port] && !this.isClosed(port)
          && this.openPorts().length - 1 >= this.config.politics.minOpenPorts;
      case 'doom': {
        const up = (Array.isArray(ev.value) ? ev.value[0] + ev.value[1] : ev.value) > 0;
        return up ? s.doom < this.config.doom.max : s.doom > 0;
      }
      default:
        return true;
    }
  }

  _applyEvent(ev, { port, good }) {
    const s = this.state;
    const vars = { good };
    if (typeof port === 'string' && port !== 'all') vars.port = port;
    let value = null;
    switch (ev.kind) {
      case 'price':
      case 'freightCost':
      case 'production':
        value = Math.round(this.randRange(ev.value) * 100) / 100;
        vars.pct = Math.round(Math.abs(value - 1) * 100);
        break;
      case 'inspection':
      case 'corruption':
        value = this.randRange(ev.value);
        vars.pct = Math.round(Math.abs(value) * 100);
        break;
      case 'legality':
        value = ev.legality;
        break;
      case 'doom':
        Object.assign(vars, this._politicalDoom(this.randInt(ev.value)));
        break;
      case 'target': {
        const mult = Math.round(this.randRange(ev.value) * 100) / 100;
        vars.pct = Math.round(Math.abs(mult - 1) * 100);
        s.target = roundTo(s.target * mult, this.config.targets.roundTo || 10000);
        vars.amount = s.target;
        break;
      }
      case 'heat':
        vars.points = this.randInt(ev.value);
        s.heat = clamp(s.heat + vars.points, 0, this.config.heat.max);
        break;
      case 'revenue':
        vars.amount = roundTo(this.randInt(ev.value), 1000);
        s.quarter.sales += vars.amount;
        break;
      default:
        value = true;
    }
    if (DURATIONAL_KINDS.includes(ev.kind)) {
      vars.months = this.randInt(ev.months || [1, 1]);
      s.effects.push({ uid: ++s.seq, eventId: ev.id, kind: ev.kind, port, good, value, mode: ev.mode || 'set', monthsLeft: vars.months, vars });
    }
    // Any event can also nudge the doom meter: "doom": [min, max] (negative = calmer).
    const extra = ev.doom !== undefined && ev.kind !== 'doom' ? this._politicalDoom(this.randInt(ev.doom)) : {};
    this._news(`events.${ev.id}.headline`, `events.${ev.id}.body`, { ...vars, ...extra });
  }

  _logisticsEvent(from, to) {
    const s = this.state;
    const ev = this.pickWeighted(this.config.logistics.events);
    if (ev.id === 'theft') {
      const carried = this.goodIds.filter((g) => s.hold[g] > 0);
      if (!carried.length) return to;
      const good = this.pick(carried);
      const qty = Math.max(1, Math.round(s.hold[good] * this.randRange(ev.fraction)));
      s.hold[good] -= qty;
      this._push('message', { key: 'logistics.theft', vars: { good, qty } });
    } else if (ev.id === 'rerouted') {
      const port = this._alternative(to, from);
      if (port === from) return to;
      this._push('message', { key: 'logistics.rerouted', vars: { dest: to, port } });
      return port;
    } else if (ev.id === 'delay') {
      const cost = roundTo(this.randInt(ev.cost), 1000);
      this._charge(cost);
      this._push('message', { key: 'logistics.delay', vars: { cost } });
    }
    return to;
  }

  _arrive(port) {
    const s = this.state;
    s.port = port;
    this.generatePrices();
    this._push('arrival', { port });
    if (port === this.home) this._productionReport(); // only if a diversion sent you home
    if (this.chance(this.inspectionChance(port))) this._push('inspection');

    const m = this.config.market;
    if (this.chance(m.eventChance)) {
      const good = this.pick(this.goodIds);
      const crash = this.chance(0.5);
      s.prices[good] = Math.max(1, Math.round(s.prices[good] * this.randRange(crash ? m.crash : m.spike)));
      this._push('message', { key: crash ? 'market.crash' : 'market.spike', vars: { good, port, price: s.prices[good] } });
    }

    const o = this.config.offers;
    if (this.chance(o.freightChance)) {
      const add = this.randInt(o.capacityStep);
      const price = roundTo(add * this.randInt(o.pricePerUnit), 10000);
      this._push('freightOffer', { add, price });
    }
  }

  _productionReport() {
    const s = this.state;
    const list = (box) => this.goodIds.filter((g) => box[g] > 0).map((g) => ({ good: g, qty: box[g] }));
    const delivered = list(s.delivered);
    const reallocated = list(s.reallocated);
    if (delivered.length || reallocated.length) {
      this._push('message', { key: reallocated.length ? 'production.overflow' : 'production.report', vars: { delivered, reallocated } });
    }
    for (const g of this.goodIds) { s.delivered[g] = 0; s.reallocated[g] = 0; }
  }

  // ---------- step queue (events shown one screen at a time) ----------
  // Returns the step the player must deal with now, or null when they're free.
  currentStep() {
    const q = this.state.queue;
    while (q.length) {
      const step = q[0];
      if (!step.entered) {
        step.entered = true;
        if (!this._enter(step)) { q.shift(); continue; }
      }
      return step;
    }
    this._settle();
    return null;
  }

  stepChoices(step) {
    if (step.type === 'inspection' && !step.data.clean) {
      return [{ id: 'cooperate', enabled: true }, { id: 'bribe', enabled: true }];
    }
    if (step.type === 'freightOffer') {
      return [{ id: 'accept', enabled: true }, { id: 'decline', enabled: true }];
    }
    return [{ id: 'continue', enabled: true }];
  }

  resolveStep(choice) {
    const step = this.currentStep();
    if (!step) return fail('errors.noStep');
    const allowed = this.stepChoices(step).find((c) => c.id === choice);
    if (!allowed || !allowed.enabled) return fail('errors.invalidChoice');
    this.state.queue.shift();
    const follow = [];
    if (step.type === 'inspection' && !step.data.clean) this._resolveInspection(step, choice, follow);
    if (step.type === 'freightOffer' && choice === 'accept') {
      this._charge(step.data.price);
      this.state.capacity += step.data.add;
      follow.push({ key: 'offers.accepted', vars: { add: step.data.add, capacity: this.state.capacity } });
    }
    this.state.queue.unshift(...follow.map((data) => ({ id: ++this.state.seq, type: 'message', entered: true, data })));
    this._settle();
    return ok();
  }

  _enter(step) {
    if (step.type === 'inspection') return this._enterInspection(step);
    return true;
  }

  _enterInspection(step) {
    const s = this.state;
    const port = s.port;
    const c = this.config.customs;
    s.stats.inspections++;
    const items = [];
    let atStake = 0;
    for (const good of this.goodIds) {
      const qty = s.hold[good];
      if (!qty) continue;
      const legality = this.legality(port, good);
      if (legality === 'legal') continue;
      const value = qty * s.prices[good];
      const rate = legality === 'contraband' ? c.fineRate : c.dutyRate;
      const fine = Math.round(value * rate * this.penaltyMultiplier({ port, good, qty, legality, value }));
      items.push({ good, qty, legality, fine });
      atStake += fine + (legality === 'contraband' ? value : 0);
    }
    if (!items.length) {
      s.heat = clamp(s.heat + this.config.heat.cleanInspection, 0, this.config.heat.max);
      step.data = { port, clean: true };
      return true;
    }
    const bribe = Math.max(c.minBribe, roundTo(atStake * this.portsById[port].bribeRate, 1000));
    const bribeChance = this.bribeChance(port);
    step.data = {
      port, clean: false, items, bribe, bribeChance,
      hint: this.bribeHint(bribeChance),
      fine: items.reduce((sum, i) => sum + i.fine, 0),
      hasContraband: items.some((i) => i.legality === 'contraband'),
      climate: this.climateLevel().id,
      doomRisk: items.some((i) => i.legality === 'contraband') ? this.config.doom.seizure : 0,
    };
    return true;
  }

  _resolveInspection(step, choice, follow) {
    const s = this.state;
    const d = step.data;
    const H = this.config.heat;
    if (choice === 'bribe') {
      this._charge(d.bribe);
      s.stats.bribesPaid += d.bribe;
      if (this.random() < d.bribeChance) {
        s.heat = clamp(s.heat + H.successfulBribe, 0, H.max);
        follow.push({ key: 'inspection.bribeSuccess', vars: { bribe: d.bribe } });
        return;
      }
      s.stats.bribesFailed++;
      const extra = Math.round(d.bribe * this.config.customs.failedBribeExtraFine);
      const r = this._applyPenalty(d.items, extra);
      s.heat = clamp(s.heat + H.failedBribe, 0, H.max);
      follow.push({ key: 'inspection.bribeFailed', vars: { bribe: d.bribe, seized: r.seized, fine: r.fine, ...this._seizureDoom(d) } });
      return;
    }
    const r = this._applyPenalty(d.items, 0);
    if (d.hasContraband) s.heat = clamp(s.heat + H.seizure, 0, H.max);
    follow.push({ key: d.hasContraband ? 'inspection.seized' : 'inspection.dutyPaid', vars: { seized: r.seized, fine: r.fine, ...this._seizureDoom(d) } });
  }

  // A seizure of banned chips makes the news: the doom meter and your profile rise.
  _seizureDoom(d) {
    if (!d.hasContraband) return {};
    this._addProfile(this.config.profile.perSeizure);
    return this._doomVars(this._addDoom(this.config.doom.seizure));
  }

  // Seize banned chips and charge the fines to this quarter.
  _applyPenalty(items, extraFine) {
    const s = this.state;
    const seized = [];
    for (const i of items) {
      if (i.legality !== 'contraband') continue;
      seized.push({ good: i.good, qty: i.qty });
      s.hold[i.good] = 0;
      s.stats.seizures++;
    }
    const fine = items.reduce((sum, i) => sum + i.fine, 0) + extraFine;
    this._charge(fine);
    s.stats.finesPaid += fine;
    return { seized, fine };
  }
}
