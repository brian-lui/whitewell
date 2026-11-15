// How hard customs comes down on you when an inspection finds something.
//
//   penalty = value of the chips × base rate × every factor listed in config.json
//
// Base rates live in config.json → "customs" (dutyRate for chips that need a
// license, fineRate for banned chips, which are also seized).
//
// Each factor below returns a multiplier. To add one (say, bigger fines for
// repeat offenders, or for larger shipments), write a function here and add
// its name to "penalty": { "factors": [...] } in data/config.json.
// `context` holds: port, good, qty, legality, value.
export const PENALTY_FACTORS = {
  // The political climate. Each level sets its own penaltyMultiplier in config.json.
  climate: (game) => game.climateLevel().penaltyMultiplier ?? 1,
};

export function penaltyMultiplier(game, context = {}) {
  let multiplier = 1;
  for (const name of game.config.penalty?.factors || []) {
    const factor = PENALTY_FACTORS[name];
    if (factor) multiplier *= factor(game, context);
  }
  return multiplier;
}
