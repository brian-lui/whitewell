# WHITEWELL

A single-player, text-only game in the browser. You're a senior operations manager at
NVIDEO, a trillion-dollar GPU maker. Every month the fabs in Hsinchu hand you a batch of
chips. You don't choose what gets made. You decide where it goes, and whether to fly the
cutting-edge Whitewell chips into China, where they're banned and buyers pay triple.

Your score is the bonus you earn by hitting quarterly revenue targets. Miss two in a row
and you're fired. There's no time limit: the game ends when Washington's doom meter fills
up and the national-security establishment forces NVIDEO's CEO to resign. The meter rises
on its own, and smuggling makes it rise faster, so every Whitewell you sneak into China
earns more now but shortens your career.

There's no build step, no server code, and no dependencies. It's plain HTML, CSS and
JavaScript, so it runs on GitHub Pages as-is.

```
index.html          page shell
style.css           look and feel (colours are CSS variables at the top)
data/text.json      ALL player-facing text
data/config.json    all numbers and rules: cities, chips, prices, targets, events, odds
js/engine.js        game rules (no text, no DOM)
js/penalty.js       how BIS penalties are calculated (add new factors here)
js/ui.js            screens, buttons, keyboard shortcuts
js/main.js          loads the two JSON files and starts the game
tests/              automated checks (node --test)
tools/simulate.js   balance simulator
```

## Play locally

Browsers refuse to run the game when you open `index.html` straight from disk, so use
any static web server from this folder:

```
python -m http.server 8000
```

Then open <http://localhost:8000>. Saves go in the browser's localStorage.

## Put it on GitHub Pages

1. Create a GitHub repository and push this folder to it.
2. In the repo, go to **Settings → Pages**. Under "Build and deployment", choose
   **Deploy from a branch**, select `main` and `/ (root)`, then save.
3. After a minute it's live at `https://<your-username>.github.io/<repo-name>/`.

Every push to `main` updates the site. The `tests/` and `tools/` folders get published too;
that's harmless.

## How a turn works

1. In Hsinchu, chips from the fabs are waiting in the warehouse. Load some into your cargo.
2. Fly to a city (a month passes, freight is charged to the quarter). Political news,
   logistics trouble and BIS end-use checks happen on the way in.
3. Sell, then fly home. The flight home is free and takes no time, so every month can be
   one sales trip.
4. At the end of each calendar quarter, net revenue (sales minus freight, fines and
   fixers' fees) is compared with the target.
5. Repeat until the CEO is forced out (or you're fired, or you resign).

## Editing text: `data/text.json`

Change any string. A value can be one string or a list of strings; a list shows as separate
paragraphs. Keys starting with `_` are notes and are ignored.

Words in `{braces}` are filled in by the game. The main ones:

| Placeholder | Becomes |
|---|---|
| `{name}` | the player's name (available everywhere) |
| `{company}` | `game.company`, i.e. NVIDEO (available everywhere) |
| `{home}` | the home city's name (available everywhere) |
| `{strikes}` | missed quarters in a row that get you fired (available everywhere) |
| `{port}`, `{dest}` | a city name |
| `{good}` | a chip name |
| `{climate}` | a political climate level's name |
| `{doom}`, `{doomMax}` | the doom meter's current value and its maximum (`{doomMax}` is available everywhere) |
| `{pct}` | a percentage (in event text: the size of the change) |
| `{months}` in events | how long the event lasts |
| `{amount}`, `{cost}`, `{price}`, `{fine}`, `{bribe}`, `{target}`, `{bonus}`… | money, formatted like `$12,500` |
| `{qty}`, `{max}`, `{capacity}` | unit counts |

Each string can only use the placeholders the game passes to it, so check the existing
text for what's available. If you mistype a key or placeholder, the game shows
`[some.key]` or the raw `{name}` instead of crashing, and `npm test` points at the problem.

## Editing rules and balance: `data/config.json`

- **`calendar`**: when the game starts. Quarters follow the calendar (Jan–Mar and so on),
  and the first one also includes your starting month. Your first sale lands a month after
  you start, so start in the last month of a quarter (March, June, September or December)
  to give the first quarter three full trips. Start anywhere else and the first quarter's
  target is cut to match (e.g. 2/3 when starting in January).
- **`startOptions`**: the starting choices: cargo `capacity`, first quarterly `target`, and
  a `bonusMultiplier`. Each needs a matching entry in `text.json` → `startOptions`.
- **`targets`**: `growth` (each quarter's target is this much higher than the last),
  `missesToFire`, and `ratchet` (0 = off; e.g. 0.9 makes the next target at least 90% of
  what you just made, so big quarters raise the bar).
- **`bonus`**: `onTarget` (share of the target paid when you hit it) and `overTarget`
  (share of everything above the target).
- **`goods`**: the chips. `basePrice`, `volatility` (0.25 = prices swing ±25%),
  `depreciation` (monthly loss of value), `production` (units per month, `[min, max]`) and
  `productionTrend` (monthly growth or decline in output).
- **`ports`**: the cities. Per city:
  - `inspection`: chance of a BIS end-use check on arrival.
  - `corruption`: chance your local fixer can make a check go away.
  - `bribeRate`: the fixer's fee as a share of what you stand to lose.
  - `prices`: multipliers on each chip's price (below 1 = cheap).
  - `legality`: `"restricted"` (needs a license) or `"contraband"` (banned). Anything not
    listed is legal.
- **`freight`**: cost per trip out (`costBase` + `costPerUnit` × cargo capacity).
- **`warehouse`**: how many units the Hsinchu warehouse holds.
- **`doom`** and **`profile`**: the doom meter and your profile (see below).
- **`customs`** (BIS checks): `bribeHintThresholds` are the fixer odds that separate the fixer
  ratings shown on Regulations and during a check (labels in `text.json` → `briberyLevels`,
  the fixer's lines in `inspection.hints`; both need one more entry than there are thresholds).
  `dutyRate` (penalty on unlicensed chips) and `fineRate` (penalty on banned
  chips, which are also seized), as a share of their value. Both are multiplied by the
  penalty factors below.
- **`heat`** (scrutiny): how much detained chips and fixers raise it, how fast it fades,
  and how much it raises the odds of a BIS check.
- **`politics.events`**: the random political events (see below).
- **`ratings`**: end-of-game titles by total bonus. Text lives in `text.json` → `ratings`.

### The doom meter

`doom` in `config.json` is a meter from 0 to `max` that measures how angry Washington is.

- `levels`: the political climates, each starting at a meter value (`from`) and with its own
  `penaltyMultiplier` for BIS penalties. The first level must start at 0.
- `start`: where the meter begins.
- `eventChance`: the chance each month that Washington moves the meter. One event of kind
  `doom` is picked (by weight) from `politics.events`. These must push the meter up on
  average, or the game would never end; `npm test` checks this.
- `seizure`: how many points it rises every time BIS detains banned chips. A fixer who
  makes the check go away keeps it quiet, so the meter doesn't move.
- At `max`, NVIDEO's CEO is forced to resign and the game ends (the `ceoOusted` ending).

`profile` is how visible your smuggling is in Washington (0 to `max`). It never goes down.

- `perBannedUnitSold`: profile gained for each banned chip you sell.
- `perSeizure`: profile gained each time BIS detains banned chips.
- `hawkMultiplierAtMax`: how hard the hawks push at a full profile. Every rise of the doom
  meter from political news is multiplied by `1 + profile / max × (hawkMultiplierAtMax − 1)`,
  so at `hawkMultiplierAtMax: 2` a full profile doubles them. Calming news isn't affected.

### BIS penalties

When a BIS end-use check finds something:

```
penalty = value of the chips × base rate (customs.dutyRate or customs.fineRate)
                             × every factor listed in penalty.factors
```

Right now there is one factor, `climate`: the `penaltyMultiplier` of the doom meter's
current level. To add another (bigger fines for repeat offenders, for larger
shipments, for certain cities...), write a small function in `js/penalty.js` and add its
name to `"penalty": { "factors": [...] }`. Each factor gets the game and the details of
what was found (city, chip, quantity, legal status, value) and returns a multiplier.

### Political events

Each event has an `id` (its text lives in `text.json` → `events.<id>` with `headline`,
`body`, and `end` for when it expires), a `weight` (how often it's picked), a `kind`, and
these fields:

| kind | what it does | fields |
|---|---|---|
| `doom` | moves the doom meter up or down, once. Rolled separately each month (`doom.eventChance`) | `value: [min, max]` (negative = calmer) |
| `legality` | changes a chip's legal status | `port`, `good`, `legality`, optional `"mode": "max"` (only makes things stricter), `months` |
| `price` | multiplies a chip's price | `port`, `good`, `value: [min, max]`, `months` |
| `production` | multiplies the fabs' output of a chip | `good`, `value: [min, max]`, `months` |
| `inspection` | adds to the chance of a BIS check (-1 = no checks) | `port`, `value`, `months` |
| `corruption` | adds to the chance your fixer succeeds | `port`, `value`, `months` |
| `closure` | closes a city | `port` (one city, or `"randomForeign"`), `months` |
| `freightCost` | multiplies freight costs | `value: [min, max]`, `months` |
| `target` | multiplies this quarter's target, once | `value: [min, max]` |
| `revenue` | adds money to this quarter's sales, once | `value: [min, max]` |
| `heat` | adds scrutiny, once | `value: [min, max]` |

Any event can also nudge the doom meter on the side: add `"doom": [min, max]` to it (the
`leak` event does this). The game shows the change under the headline automatically.

`port` can be a city id, a list of ids (e.g. all of China: `["shenzhen", "shanghai",
"beijing"]`), `"random"`, `"randomForeign"` (not home), `"home"` or `"all"`. `good` can be a
chip id, `"random"` or `"all"`. `politics.eventChance` is the chance of other (non-doom) news each month.

### Adding a new chip, city or event

Add it to `config.json`, then add its text to `text.json` under the same id. For a city,
also give it a `prices` multiplier for each chip and any `legality` overrides. For a chip,
give every city a price for it.

## Checking your edits

With Node.js installed:

```
npm test                              # checks both JSON files and the game rules
node tools/simulate.js                # plays 1,000 games per bot style: bonuses, when the CEO fell, firings
node tools/simulate.js 1000 stretch   # same, for another start option
```

The simulator is the fastest way to tune. Change a number, re-run it, and check that
playing it straight, careful smuggling and reckless smuggling still have a sensible spread
of outcomes.
