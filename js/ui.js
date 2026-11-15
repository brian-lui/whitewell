// Browser UI. Every string shown to the player comes from data/text.json.
import { Game, createGame, SAVE_VERSION, LEGALITY_ORDER } from './engine.js';

const SAVE_KEY = 'whitewell.save';
const SCORES_KEY = 'whitewell.scores';
const MONEY_VARS = new Set(['price', 'cost', 'fine', 'bribe', 'amount', 'bonus', 'target', 'net', 'sales', 'costs',
  'fines', 'bribes', 'next']);
const PORT_VARS = new Set(['port', 'dest', 'home']);
const SETUP_VIEWS = new Set(['title', 'highScores', 'setupName', 'setupStart']);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; /* disabled or full */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const pct = (x) => Math.round(x * 1000) / 10;

export class App {
  constructor(root, config, text) {
    this.config = config;
    this.text = text;
    this.game = null;
    this.view = { name: 'title' };
    this.flash = null;
    this.saveFailed = false;
    this.warned = new Set();
    this.hotkeys = new Map();
    root.replaceChildren(
      (this.statusEl = el('header', { class: 'status' })),
      (this.screenEl = el('main', { class: 'screen', 'aria-live': 'polite' })),
      (this.actionsEl = el('nav', { class: 'actions' })),
      (this.footerEl = el('footer', { class: 'footer' })),
    );
    document.title = this.t('game.title');
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.render();
  }

  // ---------- text ----------
  raw(key) {
    let v = this.text;
    for (const part of key.split('.')) v = v?.[part];
    if (v === undefined || v === null) {
      if (!this.warned.has(key)) { console.warn(`text.json is missing "${key}"`); this.warned.add(key); }
      return `[${key}]`;
    }
    return v;
  }
  t(key, vars) {
    const v = this.raw(key);
    return this.fmt(Array.isArray(v) ? v.join(' ') : String(v), vars);
  }
  paras(key, vars) {
    const v = this.raw(key);
    return (Array.isArray(v) ? v : [v]).filter((s) => s !== '').map((s) => this.fmt(String(s), vars));
  }
  fmt(str, vars = {}) {
    const all = { ...this.globals(), ...vars };
    return str.replace(/\{(\w+)\}/g, (m, name) => (name in all ? this.formatVar(name, all[name]) : m));
  }
  globals() {
    return {
      name: this.game?.state.name ?? this.pendingName ?? '',
      company: this.raw('game.company'),
      home: this.config.homePort,
      strikes: this.config.targets.missesToFire,
      doomMax: this.config.doom.max,
    };
  }
  formatVar(name, value) {
    if (Array.isArray(value)) {
      if (!value.length) return this.raw('ui.nothing');
      return value.map((i) => this.t('ui.itemFormat', { qty: i.qty, good: i.good })).join(this.raw('ui.listSeparator'));
    }
    if (MONEY_VARS.has(name) && typeof value === 'number') return this.money(value);
    if (PORT_VARS.has(name)) return this.portName(value);
    if (name === 'good') return this.goodName(value);
    if (name === 'climate') return this.t(`climate.levels.${value}.name`);
    if (name === 'quarter') return this.quarterLabel(value);
    if (name === 'rule') return this.t(`exportControls.rules.${value}.rule`);
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return String(value);
  }
  money(n) { return (n < 0 ? '-' : '') + this.raw('ui.currency') + Math.abs(Math.round(n)).toLocaleString('en-US'); }
  moneyShort(n) {
    const a = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const cur = this.raw('ui.currency');
    if (a >= 1e6) return `${sign}${cur}${(a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}${this.raw('ui.millions')}`;
    if (a >= 1e4) return `${sign}${cur}${Math.round(a / 1e3)}${this.raw('ui.thousands')}`;
    return this.money(n);
  }
  portName(id) { return this.raw(`ports.${id}.name`); }
  goodName(id) { return this.raw(`goods.${id}.name`); }
  button(key) { return this.t(`ui.buttons.${key}`); }
  dateParts(month) {
    const c = this.config.calendar;
    const idx = c.startMonth - 1 + month;
    return { month: this.raw('months')[idx % 12], year: String(c.startYear + Math.floor(idx / 12)) };
  }
  // A quarter is named after the calendar quarter its last month falls in.
  quarterLabel(endMonth) {
    const c = this.config.calendar;
    const idx = c.startMonth - 1 + endMonth;
    return this.t('ui.quarterFormat', { n: Math.floor((idx % 12) / 3) + 1, year: String(c.startYear + Math.floor(idx / 12)) });
  }

  // ---------- state helpers ----------
  // Returns whether the game was saved. A failure keeps a warning on screen until a save works.
  save() {
    if (!this.game) return false;
    this.saveFailed = !storage.set(SAVE_KEY, this.game.state);
    return !this.saveFailed;
  }
  savedState() {
    const s = storage.get(SAVE_KEY);
    return s && s.version === SAVE_VERSION ? s : null;
  }
  go(name, data = {}) {
    this.view = { name, ...data };
    this.flash = null;
    this.render();
  }
  // Show the outcome of an engine action, then move to `next` if it worked.
  apply(result, okText, next) {
    if (result.ok) {
      this.save();
      if (next) this.view = next;
      this.flash = okText ? { text: okText, kind: 'ok' } : null;
    } else {
      this.flash = { text: this.t(result.error, result.vars), kind: 'error' };
    }
    this.render();
  }
  restart() {
    if (!window.confirm(this.t('ui.restartConfirm'))) return;
    storage.remove(SAVE_KEY);
    this.game = null;
    this.go('title');
  }
  rating(bonus) {
    let best = null;
    for (const r of this.config.ratings) {
      const min = r.min ?? -Infinity;
      if (bonus >= min && (!best || min >= (best.min ?? -Infinity))) best = r;
    }
    return best;
  }
  climateClass() {
    const m = this.game.climateLevel().penaltyMultiplier;
    return m > 2 ? 'danger' : m > 1 ? 'warn' : 'ok';
  }

  // ---------- rendering ----------
  render() {
    this.inputEl = null;
    const v = this.buildView();
    const inGame = !!this.game && !SETUP_VIEWS.has(this.view.name);
    this.statusEl.hidden = !inGame;
    this.statusEl.replaceChildren(...(inGame ? this.renderStatus() : []));
    const body = [inGame && this.saveFailed ? el('p', { class: 'flash error' }, this.t('ui.saveFailed')) : null,
      v.body, v.input ? this.renderInput(v.input) : null,
      this.flash ? el('p', { class: `flash ${this.flash.kind}` }, this.flash.text) : null];
    this.screenEl.replaceChildren(...body.flat(Infinity).filter(Boolean));
    this.renderActions(v.actions || []);
    const showRestart = inGame && !this.game.state.gameOver;
    this.footerEl.replaceChildren(...(showRestart
      ? [el('button', { type: 'button', class: 'link', onclick: () => this.restart() }, this.button('restart'))] : []));
    if (this.inputEl) { this.inputEl.focus(); this.inputEl.select(); }
  }

  buildView() {
    const g = this.game;
    if (g && !SETUP_VIEWS.has(this.view.name)) {
      if (g.state.gameOver) return this.viewGameOver();
      const step = g.currentStep();
      if (step) { this.save(); return this.viewStep(step); }
      if (g.state.gameOver) { this.save(); return this.viewGameOver(); } // the last screen before the end was just dismissed
    }
    const fn = this[`view_${this.view.name}`];
    return fn ? fn.call(this) : this.view_port();
  }

  renderStatus() {
    const g = this.game;
    const s = g.state;
    const bar = (v, max) => { const n = Math.round((v / max) * 10); return '■'.repeat(n) + '□'.repeat(10 - n); };
    const net = g.net();
    const item = (key, value, cls = '', tip = null) => {
      const node = el('span', { class: `stat ${cls}${tip ? ' has-tip' : ''}`, tabindex: tip ? '0' : null },
        el('span', { class: 'label' }, this.t(`ui.status.${key}`)), ' ', el('span', { class: 'value' }, value),
        tip && el('span', { class: 'tip', role: 'tooltip' }, tip));
      if (tip) for (const ev of ['mouseenter', 'focus']) node.addEventListener(ev, () => this.placeTip(node));
      return node;
    };
    const level = g.climateLevel();
    const whFull = g.warehouseUsed() / this.config.warehouse.capacity;
    return [
      el('div', { class: 'status-top' },
        el('strong', {}, this.t('ui.status.who')),
        el('span', {}, [this.t('ui.status.date', this.dateParts(s.month)), this.quarterLabel(g.quarterEnd())].join(' · '))),
      el('div', { class: 'status-grid' },
        item('location', this.portName(s.port)),
        item('quarter', `${this.moneyShort(net)} / ${this.moneyShort(s.target)}`, s.misses > 0 ? 'danger' : net >= s.target ? 'ok' : ''),
        item('bonus', this.money(s.bonus)),
        item('cargo', `${g.holdUsed()}/${s.capacity}`),
        item('warehouse', `${g.warehouseUsed()}/${this.config.warehouse.capacity}`, whFull >= 0.9 ? 'danger' : whFull >= 0.7 ? 'warn' : ''),
        item('heat', bar(s.heat, this.config.heat.max), s.heat >= 50 ? 'danger' : s.heat >= 25 ? 'warn' : '',
          this.t('ui.tips.heat', { heat: Math.round(s.heat), heatMax: this.config.heat.max })),
        item('doom', `${bar(s.doom, this.config.doom.max)} ${this.t(`climate.levels.${level.id}.name`)}`, this.climateClass(),
          this.t('ui.tips.doom', { doom: s.doom, climate: level.id, mult: level.penaltyMultiplier, points: this.config.doom.seizure })),
        item('profile', bar(s.profile, this.config.profile.max), s.profile >= 50 ? 'danger' : s.profile >= 20 ? 'warn' : '',
          this.t('ui.tips.profile', { profile: Math.round(s.profile), profileMax: this.config.profile.max, hawks: Math.round(g.hawkMultiplier() * 10) / 10 }))),
    ];
  }

  // Keep a status pop-up on screen: if it would run off the right edge, anchor it to the right instead.
  placeTip(node) {
    const tip = node.querySelector('.tip');
    tip.classList.remove('flip');
    tip.style.display = 'block'; // measure it even if the hover style hasn't applied yet
    if (tip.getBoundingClientRect().right > document.documentElement.clientWidth - 8) tip.classList.add('flip');
    tip.style.display = '';
  }

  // Buttons get keyboard shortcuts automatically: numbers for lists, a letter otherwise.
  renderActions(actions) {
    this.hotkeys = new Map();
    this.escAction = null;
    this.enterAction = null;
    const used = new Set();
    const list = el('div', { class: 'options' });
    const row = el('div', { class: 'buttons' });
    let num = 0;
    for (const a of actions) {
      let key = null;
      if (a.option) {
        num++;
        if (num <= 9) key = String(num);
      } else {
        key = [...a.label.toLowerCase()].find((ch) => /[a-z]/.test(ch) && !used.has(ch)) || null;
        if (key) used.add(key);
      }
      const btn = el('button', {
        type: 'button',
        class: a.option ? 'option' : a.primary ? 'primary' : '',
        disabled: !!a.disabled,
        onclick: () => a.run(),
      }, this.labelNodes(a.label, key, !!a.option));
      (a.option ? list : row).append(btn);
      if (a.disabled) continue;
      if (key) this.hotkeys.set(key, a);
      if (a.escape) this.escAction = a;
      if (a.primary) this.enterAction = a;
    }
    this.actionsEl.replaceChildren(...[list, row].filter((n) => n.childNodes.length));
  }
  labelNodes(label, key, numbered) {
    if (!key) return [label];
    if (numbered) return [el('span', { class: 'hk' }, key), ' ', label];
    const i = label.toLowerCase().indexOf(key);
    return [label.slice(0, i), el('span', { class: 'hk' }, label[i]), label.slice(i + 1)];
  }

  renderInput(input) {
    this.inputEl = el('input', {
      type: 'text',
      inputmode: input.numeric ? 'numeric' : 'text',
      maxlength: input.maxLength || 40,
      autocomplete: 'off',
      'aria-label': input.label || '',
    });
    this.inputEl.value = input.value ?? '';
    this.inputSubmit = () => input.submit(this.inputEl.value);
    return el('div', { class: 'input-row' }, el('span', { class: 'prompt' }, '>'), this.inputEl);
  }

  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const inInput = this.inputEl && e.target === this.inputEl;
    if (e.key === 'Escape') {
      if (this.escAction) { e.preventDefault(); this.escAction.run(); }
      return;
    }
    if (e.key === 'Enter') {
      if (inInput) { e.preventDefault(); this.inputSubmit(); return; }
      if (e.target.tagName === 'BUTTON') return; // let the focused button handle it
      if (this.enterAction) { e.preventDefault(); this.enterAction.run(); }
      return;
    }
    if (inInput || e.target.tagName === 'INPUT') return;
    const a = this.hotkeys.get(e.key.toLowerCase());
    if (a) { e.preventDefault(); a.run(); }
  }

  back(name = 'port') {
    return { label: this.button('back'), escape: true, run: () => this.go(name) };
  }
  p(text, cls) { return el('p', cls ? { class: cls } : {}, text); }

  table(cols, rows, numeric = []) {
    return el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: numeric.includes(c) ? 'num' : '' }, this.t(`ui.table.${c}`))))),
      el('tbody', {}, rows)));
  }
  quarterTable(quarters) {
    return this.table(['quarter', 'net', 'target', 'bonus'], quarters.map((q) => el('tr', {},
      el('td', {}, this.quarterLabel(q.endMonth)),
      el('td', { class: `num ${q.met ? '' : 'danger'}` }, this.money(q.net)),
      el('td', { class: 'num' }, this.money(q.target)),
      el('td', { class: `num ${q.met ? '' : 'danger'}` }, q.met ? this.money(q.bonus) : this.t('performance.missed')))),
    ['net', 'target', 'bonus']);
  }

  // ---------- setup screens ----------
  view_title() {
    const saved = this.savedState();
    const canContinue = saved && !saved.gameOver;
    return {
      body: [el('h1', { class: 'title' }, this.t('game.title')), this.p(this.t('game.subtitle'), 'subtitle')],
      actions: [
        { label: this.button('newGame'), primary: !canContinue, run: () => {
          if (canContinue && !window.confirm(this.t('ui.restartConfirm'))) return;
          this.go('setupName');
        } },
        canContinue && { label: this.button('continueGame'), primary: true, run: () => {
          try { this.game = new Game(this.config, saved); } catch (err) {
            console.error(err);
            storage.remove(SAVE_KEY);
            this.go('title');
            return;
          }
          this.go('port');
        } },
        { label: this.button('highScores'), run: () => this.go('highScores') },
      ].filter(Boolean),
    };
  }

  view_highScores() {
    const scores = storage.get(SCORES_KEY) || [];
    const cols = ['name', 'bonus', 'rating', 'until', 'date'];
    const body = [el('h2', {}, this.t('highScores.title'))];
    if (!scores.length) body.push(this.p(this.t('highScores.empty'), 'dim'));
    else {
      body.push(el('div', { class: 'scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, cols.map((c) => el('th', {}, this.t(`highScores.columns.${c}`))))),
        el('tbody', {}, scores.map((sc) => el('tr', {},
          el('td', {}, sc.name),
          el('td', { class: 'num' }, this.money(sc.bonus)),
          el('td', {}, this.t(`ratings.${sc.rating}.title`)),
          el('td', {}, sc.month == null ? '' : this.t('ui.status.date', this.dateParts(sc.month))),
          el('td', {}, new Date(sc.date).toLocaleDateString())))))));
    }
    return { body, actions: [this.back(this.game?.state.gameOver ? 'gameOver' : 'title')] };
  }

  view_setupName() {
    const submit = (value) => {
      this.pendingName = value.trim().slice(0, 40) || this.t('setup.defaultName');
      this.go('setupStart');
    };
    return {
      body: [this.p(this.t('setup.namePrompt'))],
      input: { value: this.t('setup.defaultName'), maxLength: 40, label: this.t('setup.namePrompt'), submit },
      actions: [
        { label: this.button('ok'), primary: true, run: () => this.inputSubmit() },
        { label: this.button('cancel'), escape: true, run: () => this.go('title') },
      ],
    };
  }

  view_setupStart() {
    const opts = this.config.startOptions;
    const vars = (o) => ({ target: o.target, capacity: o.capacity, multiplier: o.bonusMultiplier ?? 1 });
    return {
      body: [
        el('h2', {}, this.t('game.title')),
        this.paras('game.intro', this.dateParts(0)).map((p) => this.p(p)),
        this.p(this.t('setup.startPrompt'), 'kicker'),
        el('ul', { class: 'plain' }, opts.map((o, i) => el('li', {},
          el('strong', {}, `${i + 1}. ${this.t(`startOptions.${o.id}.name`)}: `),
          this.t(`startOptions.${o.id}.description`, vars(o))))),
      ],
      actions: [
        ...opts.map((o) => ({ option: true, label: this.t(`startOptions.${o.id}.name`), run: () => {
          this.game = createGame(this.config, { name: this.pendingName, startId: o.id });
          this.save();
          this.go('port');
        } })),
        { label: this.button('cancel'), escape: true, run: () => this.go('title') },
      ],
    };
  }

  // ---------- city ----------
  view_port() {
    const g = this.game;
    const s = g.state;
    const here = s.port;
    const level = g.customsLevel(here);
    let changed = false;
    const cols = ['good', 'price', 'status', 'cargo', ...(g.atHome ? ['warehouse'] : [])];
    const rows = g.goodIds.map((id) => {
      const leg = g.legality(here, id);
      const isChanged = leg !== g.baseLegality(here, id);
      changed ||= isChanged;
      return el('tr', {},
        el('td', {}, this.goodName(id)),
        el('td', { class: 'num' }, this.money(g.price(id))),
        el('td', { class: leg }, this.t(`legality.${leg}`) + (isChanged ? '*' : '')),
        el('td', { class: 'num' }, s.hold[id] || '·'),
        g.atHome ? el('td', { class: 'num' }, s.warehouse[id] || '·') : null);
    });
    const local = g.localEffects(here);
    const B = (k) => this.button(k);
    return {
      body: [
        el('h2', {}, this.portName(here)),
        this.p(this.t(`ports.${here}.description`), 'dim'),
        this.p(this.t('port.customs', { level: this.t(`customsLevels.${level}`) }), `customs ${level}`),
        g.atHome && this.p(this.t('port.home', { used: g.warehouseUsed(), capacity: this.config.warehouse.capacity })),
        this.table(cols, rows, ['price', 'cargo', 'warehouse']),
        changed && this.p(this.t('port.changedNote'), 'dim small'),
        local.length > 0 && [this.p(this.t('port.localNews'), 'kicker'),
          el('ul', { class: 'news-list' }, local.map((e) => el('li', {}, this.t(`events.${e.eventId}.headline`, e.vars))))],
      ],
      actions: [
        { label: B('sell'), run: () => this.go('sell') },
        g.atHome && { label: B('load'), run: () => this.go('load') },
        g.atHome && { label: B('unload'), run: () => this.go('unload') },
        { label: B('travel'), run: () => this.go('travel') },
        { label: B('performance'), run: () => this.go('performance') },
        { label: B('regulations'), run: () => this.go('regulations') },
        { label: B('news'), run: () => this.go('news') },
        { label: B('help'), run: () => this.go('help') },
        g.atHome && { label: B('resign'), run: () => this.go('confirm', { kind: 'resign' }) },
      ].filter(Boolean),
    };
  }

  view_sell() {
    const g = this.game;
    const any = g.goodIds.some((id) => g.stock(id) > 0);
    return {
      body: [el('h2', {}, this.t('sell.title')),
        g.atHome && this.p(this.t('sell.homeNote'), 'dim'),
        !any && this.p(this.t('sell.nothing'), 'dim')],
      actions: [
        ...g.goodIds.map((id) => ({
          option: true, disabled: !g.stock(id),
          label: this.t('sell.option', { good: id, price: g.price(id), qty: g.stock(id) }),
          run: () => this.go('qty', { mode: 'sell', good: id }),
        })),
        !g.atHome && { label: this.button('sellAll'), primary: true, disabled: g.holdUsed() === 0, run: () => this.sellAll() },
        this.back(),
      ].filter(Boolean),
    };
  }
  sellAll() {
    const g = this.game;
    let amount = 0;
    let profile = 0;
    for (const id of g.goodIds) {
      const n = g.state.hold[id];
      if (!n) continue;
      const r = g.sell(id, n);
      if (r.ok) { amount += r.amount; profile += r.profile; }
    }
    this.apply({ ok: true }, this.saleText(this.t('sell.allDone', { amount }), profile), { name: 'port' });
  }
  saleText(text, profile) {
    return profile > 0 ? `${text} ${this.t('sell.profileUp', { points: Math.round(profile * 10) / 10 })}` : text;
  }

  view_load() {
    const g = this.game;
    const s = g.state;
    return {
      body: [el('h2', {}, this.t('load.title')), this.p(this.t('load.info', { free: g.holdFree(), capacity: s.capacity }), 'dim')],
      actions: [
        ...g.goodIds.map((id) => ({
          option: true, disabled: !s.warehouse[id] || g.holdFree() <= 0,
          label: this.t('load.option', { good: id, qty: s.warehouse[id] }),
          run: () => this.go('qty', { mode: 'load', good: id }),
        })),
        { label: this.button('loadAll'), primary: true, disabled: g.holdFree() <= 0 || g.warehouseUsed() === 0, run: () => {
          const r = g.loadAll();
          this.apply(r, r.ok ? this.t('load.allDone', { qty: r.loaded }) : null, { name: 'port' });
        } },
        this.back(),
      ],
    };
  }

  view_unload() {
    const g = this.game;
    const s = g.state;
    return {
      body: [el('h2', {}, this.t('unload.title')), this.p(this.t('unload.info', { free: g.warehouseFree() }), 'dim')],
      actions: [
        ...g.goodIds.map((id) => ({
          option: true, disabled: !s.hold[id] || g.warehouseFree() <= 0,
          label: this.t('unload.option', { good: id, qty: s.hold[id] }),
          run: () => this.go('qty', { mode: 'unload', good: id }),
        })),
        this.back(),
      ],
    };
  }

  // The worst legal status of anything in your cargo at that city, by the time you'd
  // land there (or in the given month).
  cargoRisk(port, month = this.game.arrivalMonth(port)) {
    const g = this.game;
    let worst = 0;
    for (const id of g.goodIds) {
      if (g.state.hold[id] > 0) worst = Math.max(worst, LEGALITY_ORDER.indexOf(g.legality(port, id, month)));
    }
    return worst > 0 ? LEGALITY_ORDER[worst] : null;
  }

  view_travel() {
    const g = this.game;
    const s = g.state;
    const label = (p) => {
      if (p === g.home) return this.t('travel.home', { port: p });
      const risk = this.cargoRisk(p);
      const changed = risk !== this.cargoRisk(p, s.month); // known to change while you're on the way
      const base = this.t('travel.option', { port: p, level: this.t(`customsLevels.${g.customsLevel(p)}`) });
      if (changed) return `${base} ${this.t(`travel.riskOnArrival.${risk || 'legal'}`)}`;
      return risk ? `${base} ${this.t(`travel.risk.${risk}`)}` : base;
    };
    // Home first when you're away: it's the usual next move.
    const order = g.portIds.filter((p) => p !== s.port).sort((a, b) => (b === g.home) - (a === g.home));
    return {
      body: [el('h2', {}, this.t('travel.title')), this.p(this.t('travel.cost', { cost: g.freightCost() })),
        g.holdUsed() > 0 && this.p(this.t('travel.riskNote'), 'dim small')],
      actions: [
        ...order.map((p) => ({
          option: true,
          disabled: g.isClosed(p),
          label: label(p),
          run: () => this.apply(g.travel(p), null, { name: 'port' }),
        })),
        this.back(),
      ],
    };
  }

  // One screen for every "how many?" prompt.
  view_qty() {
    const g = this.game;
    const s = g.state;
    const { mode, good } = this.view;
    const qty = (raw) => Math.floor(Number(raw));
    const specs = {
      sell: () => ({ max: g.stock(good), back: 'sell', prompt: this.t('sell.qtyPrompt', { good, price: g.price(good), max: g.stock(good) }),
        run: (n) => { const r = g.sell(good, n); this.apply(r, r.ok ? this.saleText(this.t('sell.done', { qty: qty(n), good, amount: r.amount }), r.profile) : null, { name: 'port' }); } }),
      load: () => { const max = Math.min(s.warehouse[good], g.holdFree()); return { max, back: 'load', instantMax: true, prompt: this.t('load.qtyPrompt', { good, max }),
        run: (n) => this.apply(g.load(good, n), this.t('load.done', { qty: qty(n), good }), { name: 'load' }) }; },
      unload: () => { const max = Math.min(s.hold[good], g.warehouseFree()); return { max, back: 'unload', instantMax: true, prompt: this.t('unload.qtyPrompt', { good, max }),
        run: (n) => this.apply(g.unload(good, n), this.t('unload.done', { qty: qty(n), good }), { name: 'unload' }) }; },
    };
    const spec = specs[mode]();
    return {
      body: [this.p(spec.prompt)],
      input: { numeric: true, label: spec.prompt, value: '', submit: (raw) => spec.run(raw.trim().toLowerCase() === 'max' ? spec.max : raw) },
      actions: [
        { label: this.button('ok'), primary: true, run: () => this.inputSubmit() },
        spec.instantMax
          ? { label: this.button('max'), disabled: spec.max <= 0, run: () => spec.run(spec.max) }
          : { label: this.button('max'), run: () => { this.inputEl.value = String(spec.max); this.inputEl.focus(); } },
        { label: this.button('cancel'), escape: true, run: () => this.go(spec.back) },
      ],
    };
  }

  view_performance() {
    const g = this.game;
    const s = g.state;
    const q = s.quarter;
    const B = this.config.bonus;
    const mult = g.startOption.bonusMultiplier ?? 1;
    return {
      body: [
        el('h2', {}, this.t('performance.title')),
        this.p(this.t('performance.current', { quarter: g.quarterEnd(), sales: q.sales, costs: q.costs, net: g.net(),
          target: s.target, n: g.monthsLeftInQuarter() })),
        s.misses > 0 && this.p(this.t('performance.onNotice', { n: this.config.targets.missesToFire - s.misses }), 'danger'),
        s.quarters.length ? this.quarterTable(s.quarters) : this.p(this.t('performance.none'), 'dim'),
        this.p(this.t('performance.total', { bonus: s.bonus }), 'big'),
        this.p(this.t('performance.rules', { on: pct(B.onTarget * mult), over: pct(B.overTarget * mult),
          growth: pct(this.config.targets.growth) }), 'dim small'),
      ],
      actions: [this.back()],
    };
  }

  // Export rules announced but not in force yet.
  upcomingList() {
    const rules = this.game.upcomingRules();
    if (!rules.length) return null;
    return [this.p(this.t('exportControls.upcoming'), 'kicker'),
      el('ul', { class: 'news-list' }, rules.map((r) => el('li', { class: 'warn' }, this.t('exportControls.upcomingItem', { quarter: r.month, rule: r.id }))))];
  }

  climateLine() {
    const g = this.game;
    return this.p(this.t('doom.status', { climate: g.climateLevel().id, doom: g.state.doom, mult: g.climateLevel().penaltyMultiplier,
      hawks: Math.round(g.hawkMultiplier() * 10) / 10 }), this.climateClass());
  }
  // "Doom meter +12: now 57 of 100 (Tense)." for any news or message that moved the meter.
  doomLine(vars) {
    if (!vars?.doomChange) return null;
    const up = vars.doomChange > 0;
    const cls = this.config.doom.levels.find((l) => l.id === vars.climate)?.penaltyMultiplier > 2 || vars.doom >= this.config.doom.max ? 'danger' : up ? 'warn' : 'ok';
    const key = !up ? 'doom.down' : vars.hawks ? 'doom.upHawks' : 'doom.up';
    return this.p(this.t(key, { ...vars, points: Math.abs(vars.doomChange) }), cls);
  }

  view_regulations() {
    const g = this.game;
    const goods = g.goodIds;
    const levels = this.raw('briberyLevels');
    return {
      body: [
        el('h2', {}, this.t('regulations.title')),
        this.p(this.t('regulations.intro'), 'dim'),
        this.climateLine(),
        el('div', { class: 'scroll' }, el('table', { class: 'regs' },
          el('thead', {}, el('tr', {}, el('th', {}, this.t('ui.table.port')),
            goods.map((id) => el('th', {}, this.text.goods?.[id]?.short || this.goodName(id))),
            el('th', {}, this.t('ui.table.customs')), el('th', {}, this.t('ui.table.bribery')))),
          el('tbody', {}, g.portIds.map((p) => el('tr', { class: p === g.state.port ? 'here' : '' },
            el('td', {}, this.portName(p)),
            goods.map((id) => {
              const leg = g.legality(p, id);
              return el('td', { class: leg }, this.t(`regulations.short.${leg}`) + (leg !== g.baseLegality(p, id) ? '*' : ''));
            }),
            el('td', { class: `customs ${g.customsLevel(p)}` }, this.t(`customsLevels.${g.customsLevel(p)}`)),
            el('td', {}, Array.isArray(levels) ? levels[g.bribeHint(g.bribeChance(p))] ?? '' : '')))))),
        this.paras('regulations.legend').map((t) => this.p(t, 'small')),
        this.upcomingList(),
      ],
      actions: [this.back()],
    };
  }

  view_news() {
    const g = this.game;
    const s = g.state;
    const date = (m) => this.t('ui.status.date', this.dateParts(m));
    return {
      body: [
        el('h2', {}, this.t('news.title')),
        this.climateLine(),
        this.upcomingList(),
        this.p(this.t('news.active'), 'kicker'),
        s.effects.length
          ? el('ul', { class: 'news-list' }, s.effects.map((e) => el('li', {},
            this.t(`events.${e.eventId}.headline`, e.vars), ' ', el('span', { class: 'dim' }, `(${this.t('news.monthsLeft', { months: e.monthsLeft })})`))))
          : this.p(this.t('news.noActive'), 'dim'),
        this.p(this.t('news.recent'), 'kicker'),
        s.news.length
          ? el('ul', { class: 'news-list' }, s.news.slice(0, 15).map((n) => el('li', {},
            el('span', { class: 'dim' }, `${date(n.month)}: `), this.t(n.headline, n.vars))))
          : this.p(this.t('news.none'), 'dim'),
      ],
      actions: [this.back()],
    };
  }

  view_help() {
    return {
      body: [el('h2', {}, this.t('help.title')), this.paras('help.body').map((t) => this.p(t))],
      actions: [this.back()],
    };
  }

  view_confirm() {
    const g = this.game;
    const { kind } = this.view;
    return {
      body: [this.p(this.t(`${kind}.confirm`, { bonus: g.state.bonus }))],
      actions: [
        { label: this.button('yes'), run: () => this.apply(g.resign(), null, { name: 'gameOver' }) },
        { label: this.button('no'), escape: true, run: () => this.go('port') },
      ],
    };
  }

  // ---------- events, one screen at a time ----------
  viewStep(step) {
    const g = this.game;
    const d = step.data;
    const body = [];
    switch (step.type) {
      case 'arrival':
        body.push(el('h2', {}, this.t('voyage.arrive', d)), this.p(this.t(`ports.${d.port}.description`), 'dim'));
        break;
      case 'news':
        body.push(this.p(this.t(d.body ? 'news.breaking' : 'news.update'), 'kicker'),
          el('h2', { class: 'headline' }, this.t(d.headline, d.vars)),
          d.body && this.paras(d.body, d.vars).map((p) => this.p(p)),
          this.doomLine(d.vars));
        break;
      case 'message':
        body.push(this.paras(d.key, d.vars).map((p) => this.p(p, 'event')), this.doomLine(d.vars));
        break;
      case 'inspection':
        if (d.clean) body.push(this.p(this.t('inspection.clean', d), 'warn'));
        else {
          const hints = this.paras('inspection.hints');
          const level = this.config.doom.levels.find((l) => l.id === d.climate);
          body.push(this.p(this.t('inspection.boarded', d), 'warn'),
            el('ul', { class: 'findings' }, d.items.map((i) => el('li', { class: i.legality }, this.t(`inspection.${i.legality}`, i)))),
            level && this.p(this.t('inspection.climate', { climate: d.climate, mult: level.penaltyMultiplier }), 'dim'),
            d.doomRisk > 0 && this.p(this.t('inspection.doomWarning', { points: d.doomRisk }), 'warn'),
            this.p(`${this.t('inspection.fixer', { port: d.port, level: this.raw('briberyLevels')[d.hint] ?? '' })} ${hints[d.hint] ?? ''}`, 'dim'));
        }
        break;
      case 'quarter': {
        const vars = { ...d, quarter: d.endMonth };
        body.push(this.p(this.t('quarter.kicker', vars), 'kicker'),
          el('h2', { class: d.met ? '' : 'danger' }, this.t(d.met ? 'quarter.metTitle' : 'quarter.missedTitle', vars)),
          this.p(this.t('quarter.numbers', vars)),
          this.p(this.t(d.met ? 'quarter.met' : 'quarter.missed', vars), d.met ? 'big' : 'danger'),
          !d.met && this.p(this.t('quarter.warning', { n: this.config.targets.missesToFire - d.misses }), 'danger'),
          this.p(this.t('quarter.next', vars)));
        break;
      }
      case 'freightOffer':
        body.push(this.p(this.t('offers.freight', { ...d, port: g.state.port })));
        break;
      default:
        body.push(this.p(`[unknown step: ${step.type}]`));
    }
    const label = {
      continue: () => this.button('continue'),
      cooperate: () => this.t('inspection.cooperate'),
      bribe: () => this.t('inspection.bribe', d),
      accept: () => this.t('offers.accept'),
      decline: () => this.t('offers.decline'),
    };
    const actions = g.stepChoices(step).map((c) => ({
      label: label[c.id](),
      disabled: !c.enabled,
      primary: c.id === 'continue',
      run: () => this.apply(g.resolveStep(c.id), null, { name: 'port' }),
    }));
    return { body, actions };
  }

  // ---------- end ----------
  view_gameOver() { return this.viewGameOver(); }
  viewGameOver() {
    const g = this.game;
    const s = g.state;
    const over = s.gameOver;
    const rating = this.rating(over.bonus);
    if (!s.scoreRecorded) {
      s.scoreRecorded = true;
      const scores = storage.get(SCORES_KEY) || [];
      scores.push({ name: s.name, bonus: over.bonus, rating: rating.id, month: over.month, date: new Date().toISOString() });
      scores.sort((a, b) => b.bonus - a.bonus);
      storage.set(SCORES_KEY, scores.slice(0, 10));
      this.save();
    }
    const st = s.stats;
    return {
      body: [
        el('h1', { class: 'title' }, this.t('gameOver.title')),
        this.paras(`endings.${over.reason}`).map((p) => this.p(p)),
        this.p(this.t('gameOver.when', { ...this.dateParts(over.month), n: s.quarters.length }), 'dim'),
        this.p(this.t('gameOver.bonus', { bonus: over.bonus }), 'big'),
        this.p(this.t('gameOver.rating', { rating: this.t(`ratings.${rating.id}.title`) }), 'big'),
        this.p(this.t(`ratings.${rating.id}.text`), 'dim'),
        s.quarters.length > 0 && this.quarterTable(s.quarters),
        this.p(this.t('gameOver.stats', { trips: st.trips, sales: st.sales, inspections: st.inspections, seizures: st.seizures,
          bribes: st.bribesPaid, fines: st.finesPaid }), 'small'),
      ],
      actions: [
        { label: this.button('newGame'), primary: true, run: () => { this.game = null; this.go('setupName'); } },
        { label: this.button('highScores'), run: () => this.go('highScores') },
      ],
    };
  }
}
