// A finished game's score goes on the high-score list exactly once, even if the
// browser won't store it at first (issues.md, issue 1).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, mount } from './browser.js';
import { App } from '../js/ui.js';
import { quietConfig, newGame, drain, loadText } from './helpers.js';

const config = quietConfig();
const text = loadText();
const SAVE = 'whitewell.save';
const SCORES = 'whitewell.scores';

beforeEach(() => { store.data.clear(); store.failing.clear(); store.broken = false; });

const scores = () => JSON.parse(store.getItem(SCORES)) ?? [];
const saved = () => JSON.parse(store.getItem(SAVE));
const buttons = (app) => app.actionsEl.childNodes.flatMap((group) => group.childNodes);
const findButton = (app, label) => buttons(app).find((b) => b.textContent === label);
function click(app, label) {
  const b = findButton(app, label);
  assert.ok(b, `no "${label}" button on screen: ${buttons(app).map((x) => x.textContent).join(' | ')}`);
  b.click();
}

// Start a game, resign it at once, and land on the game-over screen.
function finishGame() {
  const app = new App(mount(), config, text);
  app.game = newGame();
  drain(app.game);
  app.go('confirm', { kind: 'resign' });
  click(app, app.button('yes'));
  assert.ok(app.game.state.gameOver, 'the game is over');
  return app;
}
const onScreen = (app, s) => app.screenEl.textContent.includes(s);

test('text.json has the score warning and the retry button', () => {
  assert.ok(text.gameOver?.scoreNotSaved, 'gameOver.scoreNotSaved');
  assert.ok(text.ui?.buttons?.retry, 'ui.buttons.retry');
});

test('a score that could not be written is not marked as recorded, and the player is told', () => {
  store.failing.add(SCORES); // the high-score list can't be written; the saved game can
  const app = finishGame();
  assert.deepEqual(scores(), [], 'the score list was not written');
  assert.ok(saved().gameOver, 'the finished game was saved');
  assert.notEqual(saved().scoreRecorded, true, 'the saved game does not claim the score was recorded');
  assert.ok(onScreen(app, app.t('gameOver.scoreNotSaved')), 'the game-over screen says the score was not saved');
  assert.ok(findButton(app, app.button('retry')), 'and offers to try again');
});

test('trying again records the score once storage works, and only once', () => {
  store.failing.add(SCORES);
  const app = finishGame();

  click(app, app.button('retry')); // still failing
  assert.deepEqual(scores(), []);
  assert.ok(onScreen(app, app.t('gameOver.scoreNotSaved')), 'still warned');

  store.failing.clear();
  click(app, app.button('retry'));
  assert.equal(scores().length, 1, 'recorded');
  assert.equal(scores()[0].name, 'Tester');
  assert.equal(scores()[0].bonus, app.game.state.gameOver.bonus);
  assert.ok(!onScreen(app, app.t('gameOver.scoreNotSaved')), 'the warning is gone');
  assert.ok(!findButton(app, app.button('retry')), 'and so is the retry button');
  assert.equal(saved().scoreRecorded, true, 'the saved game now says it was recorded');

  // Looking at the screen again, or the high scores and back, adds nothing.
  app.render(); app.render();
  click(app, app.button('highScores'));
  click(app, app.button('back'));
  assert.equal(scores().length, 1, 'no duplicates');
});

test('a score that could not be written is recorded the next time the game is opened', () => {
  store.failing.add(SCORES);
  finishGame();
  assert.deepEqual(scores(), []);

  store.failing.clear(); // e.g. the player freed up space, then reloaded the page
  new App(mount(), config, text);
  assert.equal(scores().length, 1, 'recorded on opening the game');
  assert.equal(saved().scoreRecorded, true);
  new App(mount(), config, text);
  assert.equal(scores().length, 1, 'and not again');
});

test('a score that made it onto the list is not added again, even if the game could not note that it was', () => {
  store.failing.add(SCORES);
  const app = finishGame();
  // The score list can be written now, but the game can't save that it was.
  store.failing.clear();
  store.failing.add(SAVE);
  click(app, app.button('retry'));
  assert.equal(scores().length, 1);
  assert.notEqual(saved().scoreRecorded, true, 'the saved game still says it was not recorded');

  store.failing.clear();
  new App(mount(), config, text); // reload
  assert.equal(scores().length, 1, 'not recorded twice');
});

test('when nothing can be saved at all, the score warning shows, and trying again works later', () => {
  store.broken = true;
  const app = finishGame();
  assert.ok(onScreen(app, app.t('gameOver.scoreNotSaved')));
  store.broken = false;
  click(app, app.button('retry'));
  assert.equal(scores().length, 1);
});

test('normally a score is recorded exactly once', () => {
  const app = finishGame();
  assert.equal(scores().length, 1);
  assert.ok(!onScreen(app, app.t('gameOver.scoreNotSaved')), 'no warning');
  assert.ok(!findButton(app, app.button('retry')), 'no retry button');
  app.render(); app.render();
  click(app, app.button('highScores'));
  click(app, app.button('back'));
  new App(mount(), config, text);
  new App(mount(), config, text);
  assert.equal(scores().length, 1);
});
