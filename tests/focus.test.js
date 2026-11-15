// Keyboard focus after the screen is redrawn (issues.md, issue 3). Every action rebuilds
// the screen, which takes the focused button off the page, and the browser then drops
// focus to the page body: players using Tab and Enter lose their place. The policy:
//  - a new screen: focus its heading (h1/h2), or the screen itself if it has none;
//    a screen with an input focuses the input, as before;
//  - back on the screen you just came from: focus the button you left it with, or an
//    option next to it if that one can't be used now;
//  - the same screen redrawn: focus stays on the same control.
// Focus never moves onto a button on its own otherwise, so Enter still runs a screen's
// main action, and the shortcut keys still work.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, mount } from './browser.js';
import { App } from '../js/ui.js';
import { quietConfig, newGame, drain, loadText } from './helpers.js';

const config = quietConfig();
const text = loadText();

beforeEach(() => { store.data.clear(); store.failing.clear(); store.broken = false; });

const active = () => document.activeElement;
const show = (n) => (n === document.body ? 'the page body (nothing focused)' : `${n.tagName} "${n.textContent.slice(0, 40)}"`);
const buttons = (app) => app.actionsEl.childNodes.flatMap((group) => group.childNodes);
const options = (app) => buttons(app).filter((b) => b.className.split(' ').includes('option'));
function button(app, label) {
  const b = buttons(app).find((x) => x.textContent === label);
  assert.ok(b, `no "${label}" button: ${buttons(app).map((x) => x.textContent).join(' | ')}`);
  return b;
}
const option = (app, good) => options(app).find((b) => b.textContent.includes(app.goodName(good)));
function heading(app) {
  const find = (n) => (typeof n !== 'object' ? null : /^H[12]$/.test(n.tagName) ? n : n.childNodes.map(find).find(Boolean));
  return find(app.screenEl) ?? null;
}
// Tab to a button and press Enter on it.
function press(b) {
  b.focus();
  assert.ok(active() === b, `could not focus ${show(b)}`);
  b.click();
}
// A key press, wherever focus is now.
const key = (app, k) => app.onKey({ key: k, target: active(), preventDefault() {} });

// In the home city at the start of a game.
function atHome() {
  const app = new App(mount(), config, text);
  app.game = newGame();
  drain(app.game);
  app.go('port');
  return app;
}
function assertOnHeading(app, what) {
  const h = heading(app);
  assert.ok(h, `${what}: the screen has a heading`);
  assert.ok(active() === h, `${what}: focus is on ${show(active())}, not the heading`);
}

// ---------- new screens ----------

test('pressing a button that opens another screen puts focus on its heading', () => {
  for (const k of ['sell', 'load', 'unload', 'travel', 'performance', 'regulations', 'news', 'help']) {
    const app = atHome();
    press(button(app, app.button(k)));
    assertOnHeading(app, k);
  }
});

test('a screen without a heading gets focus itself', () => {
  const app = atHome();
  press(button(app, app.button('resign'))); // "are you sure?"
  assert.ok(active() === app.screenEl, `focus is on ${show(active())}`);
  press(button(app, app.button('yes')));
  assertOnHeading(app, 'game over');
});

test('each event screen on a trip takes focus in turn', () => {
  const app = atHome();
  press(button(app, app.button('travel')));
  press(options(app).find((b) => b.textContent.includes(app.portName('singapore'))));
  let screens = 0;
  while (app.game.currentStep()) {
    assert.ok(app.screenEl.contains(active()) && active() !== document.body, `event screen ${screens}: focus is on ${show(active())}`);
    if (heading(app)) assertOnHeading(app, `event screen ${screens}`);
    press(button(app, app.button('continue')));
    screens++;
  }
  assert.ok(screens > 0, 'there were event screens');
  assertOnHeading(app, 'Singapore');
});

test('a quantity prompt still puts focus in its input', () => {
  const app = atHome();
  press(button(app, app.button('load')));
  press(option(app, 'z200'));
  assert.equal(active().tagName, 'INPUT');
});

// ---------- back where you were ----------

test('after a quantity prompt, focus goes back to the option you chose', () => {
  const app = atHome();
  press(button(app, app.button('load')));
  const before = app.game.state.hold.z200;
  press(option(app, 'z200'));
  active().value = '1';
  key(app, 'Enter');
  assert.equal(app.game.state.hold.z200, before + 1, 'loaded one');
  assert.ok(active() === option(app, 'z200'), `after loading: focus is on ${show(active())}`);

  press(option(app, 'z200'));
  key(app, 'Escape');
  assert.ok(active() === option(app, 'z200'), `after cancelling: focus is on ${show(active())}`);
});

test('Back puts focus on the button that opened the screen', () => {
  const app = atHome();
  press(button(app, app.button('regulations')));
  press(button(app, app.button('back')));
  assert.ok(active() === button(app, app.button('regulations')), `focus is on ${show(active())}`);
});

test('if the option you chose cannot be used any more, focus goes to one that can', () => {
  const app = atHome();
  app.game.state.warehouse.z200 = 5;
  press(button(app, app.button('load')));
  press(option(app, 'z200'));
  press(button(app, app.button('max'))); // loads all 5 at once
  assert.ok(option(app, 'z200').disabled, 'nothing left to load');
  const now = active();
  assert.ok(options(app).includes(now) && !now.disabled, `focus is on ${show(now)}, not an option you can use`);
});

// ---------- the same screen ----------

test('redrawing the same screen keeps focus where it was', () => {
  const app = atHome();
  press(button(app, app.button('travel')));
  options(app)[2].focus();
  const label = active().textContent;
  app.render();
  assert.ok(active() === options(app)[2], `focus is on ${show(active())}`);
  assert.equal(active().textContent, label);

  heading(app).focus();
  app.render();
  assertOnHeading(app, 'travel, redrawn');
});

// ---------- the keyboard shortcuts still work ----------

test('with focus on a heading, Enter still runs the main action', () => {
  const app = atHome();
  press(button(app, app.button('load')));
  assertOnHeading(app, 'load');
  key(app, 'Enter'); // Load all
  assert.equal(app.view.name, 'port');
  assert.ok(app.game.holdUsed() > 0, 'loaded everything');
});

test('using the shortcut keys does not move focus onto a button', () => {
  const app = atHome();
  press(button(app, app.button('load')));
  key(app, '2'); // Z200
  assert.equal(app.view.good, 'z200');
  key(app, 'Escape');
  assertOnHeading(app, 'load, after a shortcut and cancel');
});
