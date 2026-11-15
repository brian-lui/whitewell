import { App } from './ui.js';

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status}).`);
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

const root = document.getElementById('app');
try {
  const [config, text] = await Promise.all([loadJson('data/config.json'), loadJson('data/text.json')]);
  new App(root, config, text);
} catch (err) {
  console.error(err);
  // The only hard-coded text in the game: we can't read text.json if it failed to load.
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `${err.message}\n\nIf you opened index.html straight from your disk, the browser blocks `
    + 'loading the data files. Run a local web server instead (see README.md).';
  root.replaceChildren(pre);
}
