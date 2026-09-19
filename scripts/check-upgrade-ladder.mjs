/*
 * Verification for the BANDED upgrade price and the PACE of the ladder.
 *
 *   npm run check:ladder
 *
 * Prices come from `SHARDS.tierBands` and `SHARDS.globalBands` rather than one
 * per row, so the list shows a short set of recognisable prices. What this
 * checks is that both tables are well-formed -- ascending, positive, covering
 * every rung -- and that the CONTENT still holds the shape the price assumes.
 *
 * Exits non-zero on any failure, so it can be wired into CI.
 *
 * Structure it enforces:
 *   - 64 upgrades: 8 tiers x 4 (32) plus 32 global;
 *   - exactly FOUR upgrades per tier, revealed at SHARDS.revealAt in order;
 *   - every per-tier upgrade uses a DISTINCT mechanism: no kind repeats within
 *     a tier's four, and no kind repeats across tiers either;
 *   - every rung 0..N-1 used exactly once;
 *   - exactly EIGHT capstones, one per tier, each on that tier's fourth slot
 *     (`rung % 4 === 3`), because the price rule keys off the flag;
 *   - both price tables ascend, and the last band reaches the highest rung so
 *     no upgrade is left unpriced;
 *   - every CAPSTONE costs more than the next tier's FIRST upgrade;
 *   - every multi-row effect kind is a LADDER: distinct steps, value rising
 *     with price;
 *   - the whole ladder takes `SHARDS.pacing.targetHours` to clear at the
 *     reference session declared alongside it, and no single rung is a wall;
 *   - every effect group an upgrade can file under is one the UI renders.
 *
 * THE PACING CHECK IS THE IMPORTANT ONE. It replaced a `ladderBudget` shard
 * total that had been set from this script's own reported figure, so it agreed
 * with whatever the table cost and could not fail. A target in HOURS cannot do
 * that: the conversion needs the reference rates and the price table to agree,
 * so moving either moves the hours while the target stays put.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/game/content.ts'), 'utf8');

let failures = 0;
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  failures += 1;
};

/* --- Read the SHARDS config ---------------------------------------------- */
const shardsStart = source.indexOf('export const SHARDS');
const shardsBlock = source.slice(shardsStart, source.indexOf('} as const', shardsStart));
const num = (key) => {
  const m = shardsBlock.match(new RegExp(`${key}: ([\\d_.]+)`));
  return m === null ? NaN : Number(m[1].replace(/_/g, ''));
};
const ladderBudget = num('ladderBudget');
/* The reference session the ladder is paced against. These live in content.ts
   so the goal is a fact about the GAME, not a number this script invented. */
const pacing = {
  contractsPerHour: num('referenceContractsPerHour'),
  milestonesPerHour: num('referenceMilestonesPerHour'),
  perMilestoneStep: num('referencePerMilestoneStep'),
  targetHours: num('targetHours'),
  tolerance: num('tolerance'),
  targetTotal: num('targetTotal'),
};
const bonusChance = num('bonusChance');
const bonusMult = num('bonusMult');
/*
 * The SECOND faucet. `perMilestone` pays per milestone step crossed, so the
 * pace model needs both the rate here and the amount below.
 */
const perMilestone = num('perMilestone');
/* The shard payout is a TABLE keyed on a contract's cost band, read per band so
   the pace model can compute the expected payout from the definitions. */
const perCost = {
  quick: num('quick'),
  standard: num('standard'),
  project: num('project'),
  epic: num('epic'),
};
if (![perCost.quick, perCost.standard, perCost.project, perCost.epic].every(Number.isFinite)) {
  fail('could not read SHARDS.perCost.{quick,standard,project,epic}');
}
if (Number.isFinite(ladderBudget)) {
  fail('SHARDS.ladderBudget still exists; pacing replaced it, and a ceiling set from this script cannot fail');
}
for (const [key, value] of Object.entries(pacing)) {
  if (!Number.isFinite(value)) fail(`could not read SHARDS.pacing.${key}`);
}
for (const [key, value] of Object.entries({ bonusChance, bonusMult })) {
  if (!Number.isFinite(value)) fail(`could not read SHARDS.${key}`);
}
/*
 * `perMilestone` must EXIST and be a round multiple of 10.
 *
 * This assertion used to run the other way -- it failed if the constant was
 * present at all, because the faucet had been deleted. A check whose job is
 * "this thing must not exist" has to be rewritten when the thing comes back,
 * and the shape rules below are what replace it: they are the same rules
 * `perCost` carries, for the same reason (a reward should be a number the
 * player recognises).
 *
 * A zero is a failure rather than a neutral value: a faucet that is switched
 * on but pays nothing passes every arithmetic check here while leaving a
 * constant that reads as live.
 */
if (!Number.isFinite(perMilestone)) {
  fail('could not read SHARDS.perMilestone');
} else {
  if (perMilestone <= 0) {
    fail(`SHARDS.perMilestone is ${perMilestone}; a live faucet must pay something`);
  }
  if (perMilestone % 10 !== 0) {
    fail(`SHARDS.perMilestone is ${perMilestone}, which is not a round multiple of 10`);
  }
}

/*
 * The PER-TIER milestone multiplier table.
 *
 * Read from the source as a list of numbers rather than by importing it, for
 * the same reason every other slice here is textual: this script cannot import
 * the engine. It is ASSERTED after the SERVICES slice below, because its length
 * is checked against the tier count -- so this note is placed here, beside the
 * other `SHARDS` shape rules, and the check itself lives further down.
 */
/*
 * TWO price tables. The per-tier ladder and the shop ladder are paced by
 * different things -- fleet depth against shop progress -- so they are priced
 * and parsed separately. One shared table forced every boundary to serve both
 * at once, so raising the cheap end of one repriced the expensive end of the
 * other; parsing them apart also means a mistake in one cannot pass by being
 * covered by the other.
 */
const tierBandsMatch = shardsBlock.match(/tierBands:\s*\[([\s\S]*?)\n\s*\]/);
const tierBands =
  tierBandsMatch === null
    ? []
    : [
        ...tierBandsMatch[1].matchAll(/\{\s*base:\s*([\d_]+),\s*capstone:\s*([\d_]+)\s*\}/g),
      ].map((m) => ({
        base: Number(m[1].replace(/_/g, '')),
        capstone: Number(m[2].replace(/_/g, '')),
      }));

const globalBands = [
  ...shardsBlock.matchAll(/\{\s*through:\s*(\d+),\s*cost:\s*([\d_]+)\s*\}/g),
].map((m) => ({ through: Number(m[1]), cost: Number(m[2].replace(/_/g, '')) }));

const revealMatch = shardsBlock.match(/revealAt: \[([\d, ]+)\]/);
const revealAt = revealMatch === null ? [] : revealMatch[1].split(',').map((v) => Number(v.trim()));

if (tierBands.length === 0) {
  fail('could not parse SHARDS.tierBands, or it is empty');
  process.exit(1);
}
if (globalBands.length === 0) {
  fail('could not parse SHARDS.globalBands, or it is empty');
  process.exit(1);
}

/*
 * The TIER table must have one row per tier, and prices must never FALL with
 * depth. Equal is allowed and deliberate -- the eight tiers are priced in four
 * PAIRS (Worker/Cache, Queue/Database, Balancer/Replica, Region/Datacenter) --
 * so this asserts non-decreasing rather than strictly ascending.
 */
for (let i = 0; i < tierBands.length; i += 1) {
  const row = tierBands[i];
  if (!(row.base > 0)) fail(`tierBands[${i}].base is ${row.base}; must be positive`);
  if (!(row.capstone > row.base)) {
    fail(`tierBands[${i}].capstone (${row.capstone}) must exceed its base (${row.base})`);
  }
  if (i > 0 && row.base < tierBands[i - 1].base) {
    fail(
      `tierBands[${i}].base (${row.base}) is cheaper than tierBands[${i - 1}].base (${tierBands[i - 1].base}); a deeper tier must not cost less`,
    );
  }
}

/* --- Read SERVICES ------------------------------------------------------- */
const services = [];
/* Display names too, so a per-tier blurb can be checked for naming a
   DIFFERENT tier. Keyed id -> name. */
const serviceNames = new Map();
const serviceBlock = source.slice(
  source.indexOf('export const SERVICES'),
  source.indexOf('export const SERVICE_BY_ID'),
);
for (const m of serviceBlock.matchAll(/id: '([a-z]+)',\s*\n\s*name: '([^']+)'/g)) {
  services.push(m[1]);
  serviceNames.set(m[1], m[2]);
}
if (services.length !== 8) {
  fail(`parsed ${services.length} services, expected 8`);
  process.exit(1);
}
const tierSet = new Set(services);

/*
 * The PER-TIER milestone multiplier table, asserted against the tier count.
 *
 * FOUR shape rules, and each catches a different way the table can be wrong:
 *
 *   - LENGTH against `SERVICES`, because the table is indexed by tier depth. A
 *     short table silently pays the base rate on the tiers past its end, which
 *     is a balance change nobody asked for and no card would show.
 *   - the FIRST entry is 1, because `perMilestone` is documented as what a first
 *     Worker milestone pays. A first entry below 1 would make `perMilestone` a
 *     CEILING rather than a floor, and every comment describing it as the base
 *     would be wrong.
 *   - NON-DECREASING, because "a deeper tier is worth more per milestone" is the
 *     entire reason the term exists. A dip makes climbing a penalty.
 *   - an ESCALATION at the top, so a table flattened to all-ones -- which would
 *     make the whole term dead content -- is caught here rather than in play.
 *
 * The exact values are deliberately NOT asserted: they are balance, and
 * `check:progression` is what measures whether the payout they produce is right.
 * These are shape rules, the same division of labour `tierBands` uses.
 */
const tierMultMatch = source.match(/milestoneTierMult:\s*\[([^\]]*)\]/);
if (tierMultMatch === null) {
  fail('could not read SHARDS.milestoneTierMult from content.ts');
} else {
  const mults = tierMultMatch[1]
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));

  if (mults.length !== services.length) {
    fail(
      `SHARDS.milestoneTierMult has ${mults.length} entries but there are ${services.length} tiers; a short table pays the base rate on the tiers past its end`,
    );
  }
  if (mults.length > 0 && mults[0] !== 1) {
    fail(
      `SHARDS.milestoneTierMult[0] is ${mults[0]}, but the first tier must pay exactly SHARDS.perMilestone (1) or perMilestone is a ceiling rather than a floor`,
    );
  }
  for (let i = 1; i < mults.length; i++) {
    if (mults[i] < mults[i - 1]) {
      fail(
        `SHARDS.milestoneTierMult[${i}] (${mults[i]}) is below [${i - 1}] (${mults[i - 1]}); a deeper tier must not pay less per milestone`,
      );
    }
  }
  if (mults.length > 1 && !(mults[mults.length - 1] > mults[0])) {
    fail(
      `SHARDS.milestoneTierMult is flat at ${mults[0]}; the depth term would be dead content`,
    );
  }
}

/*
 * The STEP MULTIPLIER's cap, which must exist and must be a real bound.
 *
 * It is the ceiling on `stepsBanked + 1`, so 1 or less would make the step term
 * a constant 1x and pay no escalation at all. The upper bound is the runaway:
 * step count follows unit count and units double every 25, so this cap is the
 * only thing stopping the faucet compounding with itself.
 */
const stepMaxMatch = source.match(/milestoneStepMax:\s*([\d_.]+)/);
if (stepMaxMatch === null) {
  fail('could not read SHARDS.milestoneStepMax from content.ts');
} else {
  const stepMax = Number(stepMaxMatch[1].replace(/_/g, ''));
  if (!Number.isFinite(stepMax) || stepMax < 2) {
    fail(
      `SHARDS.milestoneStepMax is ${stepMaxMatch[1]}; it must be at least 2 or the step term is a constant 1x and pays no escalation at all`,
    );
  }
  if (stepMax > 10) {
    fail(
      `SHARDS.milestoneStepMax is ${stepMax}, a multiplier that large lets the milestone faucet compound with itself (more steps -> more shards -> more units -> more steps); re-measure before raising it past 10`,
    );
  }
}

/*
 * Whether an upgrade belongs to a TIER or to the SHOP. Decided by the id
 * prefix against the service list, which is the same distinction the engine
 * draws from `effect.serviceId` -- and the two must agree, because one decides
 * the price and the other decides the panel.
 *
 * Defined here rather than beside the capstone checks that first used it: the
 * SHOP band coverage check needs it too, and that runs earlier.
 */
const isTierUpgradeRow = (u) => {
  const dash = u.id.indexOf('-');
  return tierSet.has(dash === -1 ? u.id : u.id.slice(0, dash));
};

/* --- Read every upgrade -------------------------------------------------- */
/*
 * Anchored to the start of a LINE, not found by bare `indexOf`.
 *
 * This file is sliced out of `content.ts` as text, and the obvious way to
 * write that is `source.indexOf('export const UPGRADES')`. That breaks the
 * moment any comment in `content.ts` mentions the declaration by name -- and
 * the comment right beside `MATURE_UNITS` does exactly that, to explain why it
 * must sit above the array. The slice then runs from the COMMENT to the next
 * mention 32 characters later and parses zero upgrades.
 *
 * A note explaining a rule must not be able to trip the rule, so the search
 * requires the declaration to begin its own line. Prose is indented; a real
 * export is not.
 */
const sectionStart = (name) => {
  const m = source.match(new RegExp(`^export const ${name}\\b`, 'm'));
  return m === null ? -1 : m.index;
};
const upgradesAt = sectionStart('UPGRADES');
const upgradeByIdAt = sectionStart('UPGRADE_BY_ID');
if (upgradesAt === -1 || upgradeByIdAt === -1 || upgradeByIdAt < upgradesAt) {
  console.error('FAIL: could not locate the UPGRADES array in content.ts');
  process.exit(1);
}
const upgradeBlock = source.slice(upgradesAt, upgradeByIdAt);

const upgrades = [];
for (const m of upgradeBlock.matchAll(
  /id: '([^']+)',[\s\S]*?rung: (\d+),\s*\n[\s\S]*?effect: \{ kind: '([a-zA-Z]+)'(?:, (mult|value|rate|slots|per|hours): ([\d_.]+))?/g,
)) {
  /* The whole entry, so the `capstone: true` flag (which sits between `rung`
     and `effect`) can be read without a second pass. */
  const entry = m[0];
  const priceMatch = entry.match(/\bprice: ([\d_]+)/);
  /*
   * The payload FIELD NAME is captured, not assumed to be `mult`.
   *
   * This used to read `mult` only, which was fine while every number-carrying
   * kind used it -- but `globalAdd` carries its contribution in `value` (an
   * additive bonus has no pre-existing value to multiply, so it states the
   * amount rather than a factor). Reading one field meant a `globalAdd` looked
   * like it declared nothing at all, and the mode check failed with
   * `undefined` rather than with anything about the content.
   *
   * The set of names mirrors `stepValue` below, so the two parsers agree about
   * where a kind keeps its number.
   */
  const field = m[4];
  const amount = m[5] === undefined ? undefined : Number(m[5].replace(/_/g, ''));
  /*
   * The blurb, so a per-tier row can be checked for naming ANOTHER tier --
   * see the cross-tier guard below. Captured from the same match rather than
   * a second pass, because `entry` is already the whole record.
   */
  const blurbMatch = entry.match(/blurb:\s*'((?:[^'\\]|\\.)*)'/);
  upgrades.push({
    id: m[1],
    rung: Number(m[2]),
    kind: m[3],
    blurb: blurbMatch === null ? '' : blurbMatch[1].replace(/\\'/g, "'"),
    /** The payload field this kind uses, and its value. */
    field,
    amount,
    /* Only meaningful for `shardGain`, which is the ladder's own income
       ramp and so the thing the pace model needs to know about. */
    mult: field === 'mult' ? amount : undefined,
    /* The additive amount, for `globalAdd`. */
    value: field === 'value' ? amount : undefined,
    capstone: /capstone: true/.test(entry),
    /* The per-row override, when present. Absent means "use the band". */
    price: priceMatch === null ? undefined : Number(priceMatch[1].replace(/_/g, '')),
  });
}

if (upgrades.length === 0) {
  fail('parsed 0 upgrades -- did the entry field order change?');
  process.exit(1);
}

/* Duplicate ids are save keys; duplicates silently collapse in UPGRADE_BY_ID. */
const idCounts = new Map();
for (const u of upgrades) idCounts.set(u.id, (idCounts.get(u.id) ?? 0) + 1);
for (const [id, count] of idCounts) {
  if (count > 1) fail(`${id} appears ${count} times`);
}

/* --- Rungs: unique and contiguous 0..N-1 --------------------------------- */
const byRung = new Map();
for (const u of upgrades) {
  if (byRung.has(u.rung)) {
    fail(`rung ${u.rung} claimed by both ${byRung.get(u.rung).id} and ${u.id}`);
  }
  byRung.set(u.rung, u);
}
for (let r = 0; r < upgrades.length; r += 1) {
  if (!byRung.has(r)) fail(`rung ${r} is unused (rungs must be contiguous 0..${upgrades.length - 1})`);
}

const ordered = [...upgrades].sort((a, b) => a.rung - b.rung);

/* --- Price: the shop band table is well-formed --------------------------- */
/*
 * `through` must ascend and `cost` must ascend with it, or the table is not a
 * ladder: a band that does not advance would swallow the rest of the list, and
 * a band that gets CHEAPER would mean buying later is better for no reason.
 */
for (let i = 0; i < globalBands.length; i += 1) {
  const band = globalBands[i];
  if (!(band.cost > 0)) fail(`globalBands[${i}] costs ${band.cost}; must be positive`);
  if (i === 0) continue;
  if (globalBands[i - 1].through >= band.through) {
    fail(
      `globalBands[${i}].through (${band.through}) must be greater than the previous band's (${globalBands[i - 1].through})`,
    );
  }
  if (band.cost <= globalBands[i - 1].cost) {
    fail(
      `globalBands[${i}].cost (${band.cost}) must be greater than the previous band's (${globalBands[i - 1].cost})`,
    );
  }
}

/* --- Coverage: every row has a price, and the tables have room ----------- */
/*
 * A shorter TIER table silently clamps the deep capstones onto their own tier's
 * price, which is the exact comparison the bump exists to win -- and it fails
 * invisibly, because a clamped price is still a price.
 */
if (tierBands.length !== services.length) {
  fail(
    `tierBands has ${tierBands.length} entries but there are ${services.length} tiers; one price row per tier`,
  );
}

/* The SHOP table must cover every global row, or the last ones are unpriced. */
const globalRows = upgrades.filter((u) => !isTierUpgradeRow(u));
const highestGlobalPosition = globalRows.length - 1;
if (globalBands[globalBands.length - 1].through < highestGlobalPosition) {
  fail(
    `the last global band ends at position ${globalBands[globalBands.length - 1].through} but the shop has ${globalRows.length} rows; the top of the shop is unpriced`,
  );
}

/* --- Capstones ------------------------------------------------------------
 * The fourth upgrade of a tier, priced by the `capstone` field of its tier's
 * row. Both failure modes are silent -- the flag missing from a row that should
 * have it, or present on the wrong slot -- and in either case the price is
 * merely different from what was intended rather than obviously wrong.
 */
const capstones = upgrades.filter((u) => u.capstone);
if (capstones.length !== services.length) {
  fail(
    `${capstones.length} capstones marked, expected ${services.length} (one per tier)`,
  );
}
for (const u of capstones) {
  if (!isTierUpgradeRow(u)) {
    fail(`${u.id} is marked capstone but is not a per-tier upgrade`);
    continue;
  }
  if (u.rung % 4 !== 3) {
    fail(`${u.id} is marked capstone but sits at rung ${u.rung}, not the fourth slot (rung % 4 === 3)`);
  }
}
for (const u of upgrades) {
  if (!u.capstone && isTierUpgradeRow(u) && u.rung % 4 === 3) {
    fail(`${u.id} sits on a tier's fourth slot but is not marked capstone`);
  }
}

/*
 * Mirrors `upgradeCost()` in engine.ts, the one place the two ladders are told
 * apart. A direct transcription rather than a cleverer derivation: if this
 * drifts from the engine, the pace model measures a ladder nobody plays.
 *
 * This script reads `content.ts` as TEXT, because its job is to inspect source
 * SHAPE, so it cannot import the real resolver. `check:progression` can and
 * does (it runs the engine), so the two scripts are the cross-check: if this
 * transcription drifts, the ladder's reported pace and the progression sim's
 * purchase order stop agreeing about what a rung costs.
 */
const price = (upgrade) => {
  if (upgrade.price !== undefined) return upgrade.price;

  if (isTierUpgradeRow(upgrade)) {
    const depth = services.indexOf(upgrade.id.slice(0, upgrade.id.indexOf('-')));
    const row = tierBands[depth < 0 ? 0 : depth] ?? tierBands[tierBands.length - 1];
    return upgrade.capstone ? row.capstone : row.base;
  }

  const position = globalRows.indexOf(upgrade);
  const band = globalBands.find((b) => position <= b.through);
  return (band ?? globalBands[globalBands.length - 1]).cost;
};

/*
 * A per-row price OVERRIDE must still be a price the tables offer. The banded
 * tables exist so a price is a number the player recognises, and an override
 * inventing 137 would put the single unrecognisable price on the single row
 * that opted out of the rule.
 */
const bandCosts = new Set([
  ...tierBands.flatMap((row) => [row.base, row.capstone]),
  ...globalBands.map((b) => b.cost),
]);
for (const u of upgrades) {
  if (u.price === undefined) continue;
  if (!(u.price > 0)) {
    fail(`${u.id} declares price ${u.price}; a price must be positive`);
  } else if (!bandCosts.has(u.price)) {
    fail(
      `${u.id} declares price ${u.price}, which is not a band cost (${[...bandCosts].sort((a, b) => a - b).join(', ')})`,
    );
  }
}

/*
 * A capstone must out-price the NEXT service's first upgrade. Compared directly
 * rather than assumed from the bump size, because the two sit in different
 * bands and the comparison depends on where the boundaries fall.
 */
for (const tier of services) {
  const last = upgrades.find((u) => u.id === `${tier}-4`);
  const nextIndex = services.indexOf(tier) + 1;
  if (last === undefined || nextIndex >= services.length) continue;
  const nextFirst = upgrades.find((u) => u.id === `${services[nextIndex]}-1`);
  if (nextFirst === undefined) continue;
  if (price(last) <= price(nextFirst)) {
    fail(
      `${last.id} costs ${price(last)} but ${nextFirst.id} costs ${price(nextFirst)}; a capstone must out-price the next tier's first upgrade`,
    );
  }
}

const total = upgrades.reduce((sum, u) => sum + price(u), 0);

/*
 * The sink's DEPTH, asserted against a declared constant.
 *
 * This replaces a figure that was only ever PRINTED below. A printed total is
 * not a constraint: a band edit moves it, the diff shows a different number in
 * a report nobody diffs, and the change is invisible. `SHARDS.pacing` exists
 * because a bound derived from the thing it bounds cannot fail, so the total
 * gets the same treatment as the pace -- stated in `content.ts`, checked here.
 *
 * Deliberately NOT a tolerance. The pace is a band because a run that clears
 * in 10 hours and one that clears in 12 are the same game; the price table is
 * exact arithmetic with no measurement in it, so it either sums to the target
 * or the two disagree about what the ladder costs.
 */
if (!Number.isFinite(pacing.targetTotal)) {
  fail('could not read SHARDS.pacing.targetTotal');
} else if (total !== pacing.targetTotal) {
  fail(
    `the ladder sums to ${total} but SHARDS.pacing.targetTotal is ${pacing.targetTotal}; ` +
      `the sink's depth is a declared figure, so move it deliberately or fix the tables`,
  );
}

/* --- Every KIND is a LADDER ---------------------------------------------
 * An investment channel the player can put more than one purchase into must
 * read as a LADDER: distinct steps, each dearer than the last, value rising
 * with the price. A repeated value is not a ladder, it is one step written
 * several times, and a player reading it cannot tell which purchase is the
 * upgrade.
 *
 * Two properties, per kind with more than one row:
 *   1. every step's value is DISTINCT;
 *   2. value moves MONOTONICALLY with price, in the direction the kind means.
 */
const LOWER_IS_BETTER = new Set(['costMult']);

/*
 * The effect payload is read from the row's own source text, slicing between
 * `id:` lines rather than one whole-entry regex: an entry carrying a comment
 * above `id` would be skipped by a `{`-anchored pattern, and a skipped row is
 * a row these assertions silently do not check.
 */
const upgradeIdLine = /^    id: '([^']+)',$/gm;
const upgradeMarks = [...upgradeBlock.matchAll(upgradeIdLine)];
const upgradeBodies = new Map();
for (let i = 0; i < upgradeMarks.length; i += 1) {
  const from = upgradeMarks[i].index;
  const to = i + 1 < upgradeMarks.length ? upgradeMarks[i + 1].index : upgradeBlock.length;
  upgradeBodies.set(upgradeMarks[i][1], upgradeBlock.slice(from, to));
}

function stepValue(upgrade) {
  const body = upgradeBodies.get(upgrade.id) ?? '';
  const m = /effect: \{ kind: '[a-zA-Z]+'(?:, (?:mult|value|rate|slots|per|hours): ([\d_.]+))?/.exec(body);
  return m === null || m[1] === undefined ? undefined : Number(m[1].replace(/_/g, ''));
}

const byKind = new Map();
for (const u of globalRows) {
  const list = byKind.get(u.kind);
  if (list === undefined) byKind.set(u.kind, [u]);
  else list.push(u);
}

let ladderFailures = 0;
let laddersChecked = 0;

for (const [kind, rows] of [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (rows.length < 2) continue;
  laddersChecked += 1;

  const ordered = [...rows].sort((a, b) => price(a) - price(b));
  const values = ordered.map(stepValue);

  if (values.some((v) => v === undefined)) {
    fail(`${kind}: a step's value could not be read, so its ladder is unchecked`);
    ladderFailures += 1;
    continue;
  }

  /* 1. Distinct. A repeated value is a step the player has no reason to take. */
  const seen = new Map();
  for (let i = 0; i < ordered.length; i += 1) {
    const prior = seen.get(values[i]);
    if (prior !== undefined) {
      fail(
        `${kind} ladder: ${ordered[i].id} and ${prior} both grant ${values[i]}; ` +
          `a repeated step is not a step`,
      );
      ladderFailures += 1;
    }
    seen.set(values[i], ordered[i].id);
  }

  /* 2. Monotone in the direction the kind means. */
  for (let i = 1; i < values.length; i += 1) {
    const up = values[i] > values[i - 1];
    const want = LOWER_IS_BETTER.has(kind) ? !up : up;
    if (!want) {
      fail(
        `${kind} ladder: ${ordered[i].id} (${values[i]}) is dearer than ` +
          `${ordered[i - 1].id} (${values[i - 1]}) but not ${LOWER_IS_BETTER.has(kind) ? 'cheaper' : 'stronger'}; ` +
          `a ladder must not charge more for less`,
      );
      ladderFailures += 1;
    }
  }
}

if (ladderFailures === 0) {
  console.log(
    `ladders: ${laddersChecked} kinds with more than one step, all distinct and ascending with price`,
  );
}
if (!Number.isFinite(total)) {
  fail('total cost is not a number; some rung has no band');
}

/* --- Pace: how long the ladder takes to clear ---------------------------- */
/*
 * The model, simple enough to check by hand.
 *
 * Shard income at the reference session is TWO faucets:
 *
 *   contracts/hr x expected payout x salvage   +   milestones/hr x perMilestone
 *
 * `salvage` is the EXPECTED VALUE of the completion bonus,
 * `1 + chance x (mult - 1)`, and it applies to the CONTRACT term only -- a
 * milestone crossing is not a contract and cannot strike. `expected payout` is
 * computed from the def table, since the payout bands by a contract's cost and
 * is zero for a def that does not pay shards. Both terms are multiplied by the
 * `shardGain` ramp bought so far, because that ramp feeds `shardMult` and
 * `shardMult` scales BOTH faucets.
 *
 * The milestone term is a flat rate x a flat amount, which understates it a
 * little: crossings per hour rise as the fleet grows, so a single constant
 * cannot represent the second half of a run. That is the same limitation the
 * contract constant has, and it is the reason `check:progression` -- which
 * measures -- is the authority.
 *
 * Hours accumulate per rung rather than total/rate, because the rate CHANGES
 * partway up. Each upgrade is costed at the income available when it is bought,
 * which is before its own effect applies -- you pay for an income upgrade out
 * of the income you had without it.
 *
 * NOT modelled: `serviceShardGain`, because it depends on a unit count rather
 * than on the ladder, so including it would make the target depend on how the
 * fleet was played. It is strictly a bonus on top of the figure here.
 *
 * Pace is a CONSISTENCY check, not a pacing authority: one constant cannot
 * represent a contract rate that starts near a thousand an hour and settles at
 * eighty. `check:progression`, which runs the real engine, is the authority.
 */
const salvage = 1 + bonusChance * (bonusMult - 1);

/*
 * The expected shard payout for ONE draw, computed from the definitions.
 *
 * Computed rather than read from a constant, because the payout depends on the
 * def's cost BAND and on whether the def pays shards at all. When reward kinds
 * were introduced the old `perContract` constant became `undefined` and this
 * script kept reporting a pace from `NaN`, which a reader could not tell was
 * nonsense. Deriving it means the model cannot describe an economy that is not
 * there.
 */
const contractsCostBlock = source.slice(
  source.indexOf('export const CONTRACTS'),
  source.indexOf('} as const', source.indexOf('export const CONTRACTS')),
);
const costBand = (name) => {
  const m = contractsCostBlock.match(new RegExp(`${name}: ([\\d_.]+)`));
  return m === null ? NaN : Number(m[1].replace(/_/g, ''));
};
const soloBonusMatch = contractsCostBlock.match(/soloBonus: ([\d.]+)/);
const SOLO_BONUS = soloBonusMatch === null ? 1 : Number(soloBonusMatch[1]);
const CONTRACT_COST = {
  quick: costBand('quick'),
  standard: costBand('standard'),
  project: costBand('project'),
  epic: costBand('epic'),
};
if (Object.values(CONTRACT_COST).some((v) => !Number.isFinite(v))) {
  fail('could not read CONTRACTS.cost.{quick,standard,project,epic}');
}
if (Object.values(perCost).some((v) => !Number.isFinite(v))) {
  fail('could not read SHARDS.perCost');
}

/*
 * The reward bands must be ROUND multiples of 10, asserted rather than trusted
 * to whoever edits the table next. The upgrade ladder already solved this for
 * PRICES (a few recognisable bands instead of dozens of arbitrary ones) and a
 * reward is the same kind of thing.
 *
 * Multiples of 10 also keep `soloBonus` (x1.5) landing on a whole number for
 * every band, so a shards-only contract shows 60/120/240/480 rather than 70.5.
 */
for (const [band, value] of Object.entries(perCost)) {
  if (value % 10 !== 0) {
    fail(`SHARDS.perCost.${band} is ${value}, which is not a round multiple of 10`);
  }
}
const soloBonus = Number(
  (source.slice(source.indexOf('export const CONTRACTS')).match(/soloBonus: ([\d.]+)/) ?? [])[1],
);
if (Number.isFinite(soloBonus)) {
  for (const [band, value] of Object.entries(perCost)) {
    if (!Number.isInteger(value * soloBonus)) {
      fail(
        `SHARDS.perCost.${band} x soloBonus (${soloBonus}) is ${value * soloBonus}, not a whole number -- a shards-only contract would show a fraction`,
      );
    }
  }
}

const contractsStart = source.indexOf('export const CONTRACT_DEFS');
const contractsArray = source.indexOf('= [', contractsStart);
const defsBlock = source.slice(contractsArray, source.indexOf('\n];', contractsArray));
const defEntries = [...defsBlock.matchAll(/\{\s*\n\s*id: '([^']+)',[\s\S]*?\n  \},/g)].map((m) => m[0]);
if (defEntries.length === 0) fail('parsed 0 contract defs for the pace model');

const bandOf = (cost) => {
  if (cost >= CONTRACT_COST.epic) return perCost.epic;
  if (cost >= CONTRACT_COST.project) return perCost.project;
  if (cost >= CONTRACT_COST.standard) return perCost.standard;
  return perCost.quick;
};

let payoutSum = 0;
let shardPayingDefs = 0;
for (const entry of defEntries) {
  const costName = entry.match(/cost: CONTRACTS\.cost\.([a-zA-Z]+)/)?.[1];
  const reward = entry.match(/reward: '([a-zA-Z]+)'/)?.[1] ?? 'both';
  const band = bandOf(costName === undefined ? CONTRACT_COST.quick : (CONTRACT_COST[costName] ?? CONTRACT_COST.quick));
  if (reward === 'compute') continue; // pays no shards at all
  payoutSum += reward === 'shards' ? band * SOLO_BONUS : band;
  shardPayingDefs += 1;
}
const expectedPayout = payoutSum / defEntries.length;
const basePerHour =
  pacing.contractsPerHour * expectedPayout * salvage +
  /*
   * The milestone term uses the AVERAGE payout per step, not `perMilestone`.
   *
   * The payout is tier- and step-dependent (`milestoneStepPayout` in the
   * engine): the base is multiplied by a per-tier table AND by the milestone
   * count on that tier, so the flat constant is only the base of it -- using it
   * here would understate the faucet by the average of both terms, which this
   * script has no way to derive. Hence a measured reference, the same
   * arrangement as the contract rate beside it.
   */
  pacing.milestonesPerHour * pacing.perMilestoneStep;

let incomeMult = 1;
let hours = 0;
let worstRung = null;
const rungHours = new Map();

for (const u of ordered) {
  const rate = basePerHour * incomeMult;
  const h = price(u) / rate;
  hours += h;
  rungHours.set(u.rung, h);
  if (worstRung === null || h > rungHours.get(worstRung.rung)) worstRung = u;
  /* Applied AFTER, deliberately: see above. */
  if (u.kind === 'shardGain' && u.mult !== undefined) incomeMult *= u.mult;
}

if (Number.isFinite(pacing.targetHours) && pacing.targetHours > 0) {
  const low = pacing.targetHours * (1 - pacing.tolerance);
  const high = pacing.targetHours * (1 + pacing.tolerance);
  if (hours < low || hours > high) {
    fail(
      `the ladder takes ${hours.toFixed(1)}h to clear at the reference session, outside the ${low.toFixed(0)}-${high.toFixed(0)}h band around SHARDS.pacing.targetHours (${pacing.targetHours})`,
    );
  }
  /*
   * And no single rung may be a wall. This is the check the old budget was
   * missing: 86% of the cost being in the last twelve rungs passed a total
   * assertion comfortably, and was still the reason the game stopped being
   * playable late. A share of the whole run is the right shape for the bound,
   * because it stays meaningful however long the run is.
   *
   * AGAINST `hours`, NOT `pacing.targetHours`, and that is a FIX rather than a
   * loosening. The comment above says "a share of the whole run" and the report
   * below prints exactly that (`rungHours / hours`), but this comparison used
   * the TARGET -- so the check judged one quantity while the line beneath it
   * printed another, and the two disagreed in the only case that matters (a
   * borderline rung). It also mis-scaled the bound: the run takes 6.7h against a
   * 5h target, so a 1000-shard rung measured 7.5% of the run and was failed for
   * exceeding 10% of the target.
   *
   * That is not cosmetic. This assertion is WHY the two deepest capstones were
   * lowered to 750 in an earlier pass, and the failure MOVED when they were
   * fixed ("fixing Region relocated it to datacenter-4") -- which is what a
   * bound that is measuring the wrong denominator looks like. A check that
   * compares one value while printing another has already drifted.
   */
  const wallShare = 0.1;
  if (worstRung !== null && rungHours.get(worstRung.rung) > hours * wallShare) {
    fail(
      `${worstRung.id} alone takes ${rungHours.get(worstRung.rung).toFixed(2)}h, more than ${wallShare * 100}% of the ${hours.toFixed(1)}h run`,
    );
  }
}

/* Bands with no upgrade in them are dead entries, not errors, but they mean
 * the table no longer describes the list, so they are reported. */
const bandCounts = globalBands.map(() => 0);
for (const u of globalRows) {
  const index = globalBands.findIndex((b) => globalRows.indexOf(u) <= b.through);
  if (index >= 0) bandCounts[index] += 1;
}
/* --- Contract metrics ----------------------------------------------------
 * A contract captures a baseline when it is issued and counts progress from
 * there, which only means anything if the counter advances ON ITS OWN. Two
 * metrics failed that: `cores` and `reboots` move only during a Reboot, so a
 * contract on one is a prestige-timescale objective holding a slot in a pool
 * where every other objective ticks continuously -- and the gameplay it
 * demands (a Reboot) resets seven other contract types.
 *
 * Hardcoded, like the global-upgrade count: a list derived from the content
 * would agree with whatever the content says, which is the one thing this
 * check exists to falsify.
 */
const PRESTIGE_ONLY_METRICS = ['cores', 'reboots'];

const contractStart = source.indexOf('export const CONTRACT_DEFS');
/* From the array literal, not the declaration: the type annotation
   (`ContractDef[]`) contains a `]` that a naive search would stop at. */
const contractArray = source.indexOf('= [', contractStart);
const contractBlock = source.slice(contractArray, source.indexOf('\n];', contractArray));
const contractMetrics = [...contractBlock.matchAll(/metric: '([a-zA-Z]+)'/g)].map((m) => m[1]);
if (contractMetrics.length === 0) {
  fail('parsed 0 contract metrics -- did the CONTRACT_DEFS shape change?');
}
for (const metric of PRESTIGE_ONLY_METRICS) {
  if (contractMetrics.includes(metric)) {
    fail(
      `a contract is measured on '${metric}', which only advances during a Reboot; a contract needs a counter that moves on its own`,
    );
  }
}

/*
 * EVERY contract must declare a cost. `cost` is what BOTH payout bands are
 * resolved from (shard and compute), so a definition without one pays ZERO.
 * A definition with neither a cost nor an amount would ask for an objective of
 * 1 and pay nothing. Both are impossible to see on the card, so both are
 * asserted here.
 */
const contractEntries = [...contractBlock.matchAll(/\{\s*\n\s*id: '([^']+)',[\s\S]*?\n  \},/g)].map(
  (m) => m[0],
);
if (contractEntries.length === 0) {
  fail('parsed 0 contract entries');
}

/*
 * The ability names the defs may reference, read from the content for the same
 * reason the tier list above is: a hardcoded list would need hand-editing
 * whenever an ability is added, which is the drift this check exists to catch.
 */
const abilityBlock = source.slice(
  source.indexOf('export const ABILITIES'),
  source.indexOf('export const ABILITY_BY_ID'),
);
const knownAbilities = new Set(
  [...abilityBlock.matchAll(/\n\s+id: '([^']+)',/g)].map((m) => m[1]),
);
if (knownAbilities.size === 0) fail('could not parse ABILITIES ids from content.ts');

/*
 * Which currency a metric MEASURES, where it measures one at all.
 *
 * `totalEarned` measures compute and `upgrades` measures the ladder, but only
 * a currency-measuring metric can be circular: a contract that pays in the
 * same currency it asks the player to accumulate is a contract that pays for
 * itself. The `shards` metric was exactly that and has been removed, so this
 * map is now the guard that keeps it from coming back rather than a live case.
 *
 * Hardcoded like `PRESTIGE_ONLY_METRICS`, for the same reason: a map derived
 * from the content would agree with the content, which is the one thing this
 * check exists to falsify.
 */
const CURRENCY_METRICS = {
  /** Measures lifetime shards, so paying shards would be circular. */
  shards: 'shards',
};

let uncosted = 0;
let unscoped = 0;
for (const entry of contractEntries) {
  const id = entry.match(/id: '([^']+)'/)?.[1] ?? '?';
  const metric = entry.match(/metric: '([a-zA-Z]+)'/)?.[1] ?? '?';
  if (!/\bcost:/.test(entry)) {
    uncosted += 1;
    fail(`${id} declares no cost, so its reward would be zero`);
  }
  /* The metrics whose objective is a fixed `amount`. MOST metrics are in this
     list now: the design was inverted, because a cost-derived objective priced
     every unit at the current marginal price and so ignored the `1.15^n` cost
     curve -- which is how "bring 75 more services online" appeared against a
     thirty-unit fleet.

     `totalEarned` is the ONE metric that must NOT have an amount: compute
     scales without limit, so its objective is still sized from the live rate.
     `clicks` is also NOT here, and for the same reason it was removed the
     first time: its work is real time at a declared rate
     (`cost x referenceClicksPerSecond`), which is not the same thing as
     unknowable. Giving it an authored amount is exactly what let a `quick`
     click contract cost six seconds and pay for ninety.

     This list is a HARDCODED copy of the engine's `fixedAmount` column, because
     this script reads content.ts as text and cannot import the engine. The
     authoritative comparison is in `check:progression`, which derives the set
     from `FIXED_AMOUNT_METRICS`; this one exists to catch the mistake earlier
     and name the def. Keep them in step. */
  const scalarMetric =
    metric === 'upgrades' ||
    metric === 'tierOwned' ||
    metric === 'abilityUses' ||
    metric === 'services' ||
    metric === 'milestones' ||
    metric === 'tierUnits';
  const hasAmount = /\bamount:/.test(entry);
  if (scalarMetric && !hasAmount) {
    unscoped += 1;
    fail(
      `${id} is a '${metric}' contract and needs a fixed amount -- without one the objective silently sizes to 1`,
    );
  }
  if (!scalarMetric && hasAmount) {
    unscoped += 1;
    fail(
      `${id} is a '${metric}' contract and must be sized from the player's rate, not given a fixed amount -- its objective would ignore the rate entirely`,
    );
  }

  /*
   * The SUBJECT fields, and they are required in exactly one direction each.
   *
   * `tierUnits` and `tierOwned` are meaningless without a tier, and
   * `abilityUses` without an ability -- worse than meaningless, since the
   * objective would fall back to a generic label and the contract would point
   * at nothing. Carrying a subject on a metric that does not use it is the
   * other half: it reads as though it matters.
   */
  const tierMetric = metric === 'tierUnits' || metric === 'tierOwned';
  const subject = entry.match(/serviceId: '([^']+)'/)?.[1];
  if (tierMetric && subject === undefined) {
    fail(`${id} is a '${metric}' contract and needs a serviceId`);
  }
  if (!tierMetric && subject !== undefined) {
    fail(`${id} carries a serviceId but is not a per-tier metric`);
  }
  if (subject !== undefined && !tierSet.has(subject)) {
    fail(`${id} names serviceId '${subject}', which is not a service in SERVICES`);
  }

  const abilitySubject = entry.match(/abilityId: '([^']+)'/)?.[1];
  if (metric === 'abilityUses' && abilitySubject === undefined) {
    fail(`${id} is an 'abilityUses' contract and needs an abilityId`);
  }
  if (metric !== 'abilityUses' && abilitySubject !== undefined) {
    fail(`${id} carries an abilityId but is not an 'abilityUses' metric`);
  }
  if (abilitySubject !== undefined && !knownAbilities.has(abilitySubject)) {
    fail(`${id} names abilityId '${abilitySubject}', which is not in ABILITIES`);
  }

  /*
   * The REWARD KIND, which decides which currency the contract pays.
   *
   * Absent means `both`, so the assertion is about the values that ARE present
   * rather than about coverage -- a typo like `reward: 'shard'` would silently
   * become `both` and quietly pay double, so the spelling is checked.
   */
  const reward = entry.match(/reward: '([a-zA-Z]+)'/)?.[1];
  if (reward !== undefined && !['compute', 'shards', 'both'].includes(reward)) {
    fail(`${id} declares reward '${reward}', which is not compute/shards/both`);
  }

  /*
   * The kind must MATCH the objective, and the rule protects two things.
   *
   *   1. An UPGRADES objective must pay shards -- declare 'shards' or omit
   *      `reward` for both -- because it asks the player to spend the currency
   *      the ladder costs, and being rewarded in a currency the objective never
   *      touches reads as a mismatch. It USED to be shards-ONLY, and that was
   *      wrong: a shards-only payout on a shard-spending objective is a rebate,
   *      which is the reported "buy 15 more upgrades for 30 shards" -- the card
   *      promised less than the purchase cost. Compute is what makes it a job.
   *   2. No metric may pay the currency it MEASURES. That is the circularity
   *      reported as "contract that collect shard to reward shard is weird",
   *      and it is checked against `CURRENCY_METRICS` rather than hardcoded,
   *      so re-adding a currency-measuring metric cannot quietly reintroduce
   *      a contract that pays in its own objective.
   */
  if (metric === 'upgrades' && reward === 'compute') {
    fail(
      `${id} is an 'upgrades' objective and must pay shards or both, not compute alone`,
    );
  }
  const measuredCurrency = CURRENCY_METRICS[metric];
  if (measuredCurrency !== undefined && reward === measuredCurrency) {
    fail(
      `${id} measures '${metric}' and pays '${reward}' -- a contract must not pay in the currency it asks the player to collect`,
    );
  }
}

/*
 * One def per ability, so every skill has contract work.
 *
 * Counted rather than inferred from the union, and compared against ABILITIES
 * itself: an ability added without a contract would leave the layer partly
 * invisible, which is the complaint this set exists to answer.
 */
const abilityDefs = [...contractBlock.matchAll(/abilityId: '([^']+)'/g)].map((m) => m[1]);
for (const ability of knownAbilities) {
  if (!abilityDefs.includes(ability)) {
    fail(`ability '${ability}' has no abilityUses contract, so its layer has no objectives`);
  }
}

/*
 * One `tierOwned` def per tier, and one `tierUnits` def per tier.
 *
 * Both counted against SERVICES, so a tier added to the fleet without its two
 * contract types is caught here rather than noticed as a gap on the panel.
 */
const tierOwnedDefs = [...contractBlock.matchAll(/metric: 'tierOwned',?\s*\n?\s*serviceId: '([^']+)'/g)].map((m) => m[1]);
const tierUnitsDefs = [...contractBlock.matchAll(/metric: 'tierUnits',?\s*\n?\s*serviceId: '([^']+)'/g)].map((m) => m[1]);
for (const tier of tierSet) {
  if (!tierOwnedDefs.includes(tier)) {
    fail(`tier '${tier}' has no 'first time' contract`);
  }
  if (!tierUnitsDefs.includes(tier)) {
    fail(`tier '${tier}' has no 'buy more' contract`);
  }
}

/* And every metric a def uses must be one the type declares, or the union has
 * drifted from the content. `MetricKey` lives in types.ts, so that file is
 * read here rather than reusing `source`. */
const typesSource = readFileSync(join(root, 'src/game/types.ts'), 'utf8');
const metricTypeBlock = typesSource.slice(
  typesSource.indexOf('export type MetricKey'),
  typesSource.indexOf(';', typesSource.indexOf('export type MetricKey')),
);
const declaredMetrics = new Set(
  [...metricTypeBlock.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]),
);
if (declaredMetrics.size === 0) {
  fail('could not parse MetricKey from types.ts');
}
for (const metric of new Set(contractMetrics)) {
  if (!declaredMetrics.has(metric)) {
    fail(`contracts use metric '${metric}', which MetricKey does not declare`);
  }
}
/* --- Per-tier shape ------------------------------------------------------ */
const tierUpgrades = new Map(services.map((id) => [id, []]));
const globalUpgrades = [];

for (const u of upgrades) {
  const dash = u.id.indexOf('-');
  const prefix = dash === -1 ? u.id : u.id.slice(0, dash);
  if (tierSet.has(prefix)) tierUpgrades.get(prefix).push(u);
  else globalUpgrades.push(u);
}

/*
 * EVERY per-tier upgrade must be a distinct mechanism: thirty-two rows,
 * thirty-two kinds, one use each. A shared kind across tiers would make those
 * rows one purchase wearing several names, which is the sameness this ladder
 * exists to prevent.
 */
const kindOwner = new Map();
for (const tier of services) {
  const mine = tierUpgrades.get(tier);
  if (mine.length !== 4) {
    fail(`${tier}: ${mine.length} upgrades, expected exactly 4`);
    continue;
  }

  /* No repeated kind inside one tier's four. */
  const local = new Set();
  for (const u of mine) {
    if (local.has(u.kind)) {
      fail(`${tier}: kind ${u.kind} is used twice (${u.id})`);
    }
    local.add(u.kind);

    /* And no repeated kind anywhere in the per-tier set. */
    if (kindOwner.has(u.kind)) {
      fail(
        `${u.kind} is already used by ${kindOwner.get(u.kind)}, so ${u.id} is a duplicate mechanism`,
      );
    } else {
      kindOwner.set(u.kind, u.id);
    }
  }
}

/* `serviceShardGain` is the only per-tier kind that feeds shard income. */
const allKinds = new Set(upgrades.map((u) => u.kind));
if (!allKinds.has('serviceShardGain')) {
  fail('no upgrade uses serviceShardGain -- shard income has no per-tier source');
}

if (kindOwner.size !== services.length * 4) {
  fail(
    `${kindOwner.size} distinct per-tier mechanisms, expected ${services.length * 4} (4 x ${services.length} tiers)`,
  );
}

/* --- Cross-tier independence (per tier) ----------------------------------
 *
 * A PER-TIER upgrade must not depend on a NEIGHBOURING tier.
 *
 * The rule this enforces is about legibility, not about the code. A row that
 * scales by "the tier above" makes a card's value depend on a card the player
 * may not own yet, and it makes the ladder read as a chain of obligations
 * ("buy Region so Replica improves") rather than as thirty-two independent
 * purchases. It also costs real machinery: a tier reading a neighbour's
 * RESULT cannot be folded in one pass, so `serviceFloor` forced a second loop
 * over every tier.
 *
 * WHAT IS CHECKED, and what is not. Two surfaces can name another tier:
 *   - the BLURB in content.ts, which this script can read directly;
 *   - the effect BADGE, built by `describeEffect()` in format.ts, which it
 *     cannot -- format.ts is TypeScript and this script reads the content as
 *     TEXT. The badge is guarded below by a narrower rule: the per-tier arms
 *     of the cross-tier kinds must not be present at all, and the arms of the
 *     new kinds must not embed a service name themselves.
 *
 * A tier is ALLOWED to name ITSELF -- "Workers produce more ..." is the
 * subject of the row, not a dependency.
 */
const crossTierKinds = [
  'servicePair',
  'serviceSynergy',
  'serviceIntake',
  'serviceReverseSynergy',
  'serviceCascade',
  'serviceAbove',
  'serviceFloor',
];
for (const u of upgrades) {
  if (isTierUpgradeRow(u) && crossTierKinds.includes(u.kind)) {
    fail(
      `${u.id} uses ${u.kind}, which reads a NEIGHBOURING tier; per-tier rows must scale by their own tier or the fleet`,
    );
  }
}

let crossTierChecked = 0;
for (const u of upgrades) {
  if (!isTierUpgradeRow(u)) continue;
  crossTierChecked += 1;
  const own = u.id.slice(0, u.id.indexOf('-'));
  for (const [id, name] of serviceNames) {
    if (id === own) continue;
    /* Case-sensitive and word-bounded: "Cache" is the tier, "cache" in prose
       is the object. A generic mention is not a dependency, and failing on one
       would make this check cry wolf until somebody weakened it. */
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (pattern.test(u.blurb)) {
      fail(
        `${u.id} names ${name} in its blurb, so the row depends on a tier the player may not own yet`,
      );
    }
  }
}

/* The per-tier arms must not announce a direction either -- "the tier above"
   is a neighbour dependency even when the sentence avoids the proper noun.
 *
 * The phrases are deliberately NARROW. A bare "above it" was tried and it
 * flagged `datacenter-2` -- "the top of the stack sees every layer below it" --
 * which describes the ladder the player is standing on, not a dependency
 * between two upgrade rows. A check that fails on a true statement gets
 * weakened by whoever hits it next, which is worse than a check that misses
 * one phrasing. The hard guarantee is the kind list above; this is the naming
 * guard on top of it.
 */
for (const u of upgrades) {
  if (!isTierUpgradeRow(u)) continue;
  if (/\b(the tier above|tier above|the tier below|tier below|tier beneath|the one above|the one below)\b/i.test(u.blurb)) {
    fail(`${u.id} describes a neighbouring tier in its blurb ("above"/"below")`);
  }
}

/* --- Global count -------------------------------------------------------- */
/*
 * Hardcoded on purpose: a count derived from the content would agree with
 * whatever the content says, which is the one thing this check exists to
 * falsify. Update it deliberately whenever the ladder grows.
 */
if (globalUpgrades.length !== 32) {
  fail(`${globalUpgrades.length} global upgrades, expected 32`);
}

/* --- Reveal thresholds (per tier) ---------------------------------------- */
for (const [tier, mine] of tierUpgrades) {
  const reveals = mine
    .map((u) => {
      const entry = upgradeBlock.slice(upgradeBlock.indexOf(`id: '${u.id}'`));
      const m = entry.match(/reveal: \(state\) => owned\(state, '[a-z]+'\) >= (\d+)/);
      return m === null ? null : Number(m[1]);
    })
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  if (reveals.join(',') !== [...revealAt].sort((a, b) => a - b).join(',')) {
    fail(`${tier}: reveal thresholds [${reveals.join(', ')}] do not match SHARDS.revealAt [${revealAt.join(', ')}]`);
  }
}

/* --- Report -------------------------------------------------------------- */
const pad = (v, n) => String(v).padEnd(n);
console.log(pad('rung', 6) + pad('upgrade', 22) + pad('kind', 20) + pad('price', 8) + 'note');
console.log('-'.repeat(78));
for (const u of ordered) {
  console.log(
    pad(u.rung, 6) +
      pad(u.id, 22) +
      pad(u.kind, 20) +
      pad(price(u), 8) +
      (u.capstone ? 'CAPSTONE' : ''),
  );
}
console.log('-'.repeat(78));
console.log(`upgrades: ${upgrades.length} (${services.length} tiers x 4 = ${services.length * 4}, ${globalUpgrades.length} global)`);
console.log(`rungs: 0..${upgrades.length - 1}, unique and contiguous`);
console.log(`per-tier mechanisms: ${kindOwner.size} distinct across ${services.length} tiers`);
console.log(
  `price: two tables -- tiers ${tierBands[0].base}..${tierBands[tierBands.length - 1].capstone} (${tierBands.length} rows), shop ${globalBands[0].cost}..${globalBands[globalBands.length - 1].cost} (${globalBands.length} bands)  |  total ${total}`,
);
for (let i = 0; i < globalBands.length; i += 1) {
  const from = i === 0 ? 0 : globalBands[i - 1].through + 1;
  /* Hours for the band, summed from the per-rung figures, so the shop's
     share of the run is visible against the tiers'. */
  let bandHours = 0;
  for (const u of globalRows) {
    const position = globalRows.indexOf(u);
    if (position >= from && position <= globalBands[i].through) {
      bandHours += rungHours.get(u.rung) ?? 0;
    }
  }
  console.log(
    `  SHOP ${String(globalBands[i].cost).padStart(4)} shards  positions ${from}-${globalBands[i].through}  (${bandCounts[i]} upgrades)  ${bandHours.toFixed(1)}h`,
  );
}
console.log(
  `pace: ${hours.toFixed(1)}h to clear at ${basePerHour.toFixed(0)} shards/hr (target ${pacing.targetHours}h +/- ${(pacing.tolerance * 100).toFixed(0)}%), final income x${incomeMult}`,
);
console.log(
  `  reference: ${pacing.contractsPerHour} contracts/hr, salvage x${salvage.toFixed(2)}`,
);
if (worstRung !== null) {
  console.log(
    `  slowest rung: ${worstRung.id} at ${rungHours.get(worstRung.rung).toFixed(2)}h (${((rungHours.get(worstRung.rung) / hours) * 100).toFixed(1)}% of the run)`,
  );
}

/* --- Contract report ------------------------------------------------------ */
const metricTally = {};
for (const metric of contractMetrics) metricTally[metric] = (metricTally[metric] ?? 0) + 1;
console.log(
  `contracts: ${contractMetrics.length} objectives across ${Object.keys(metricTally).length} metrics (${Object.entries(
    metricTally,
  )
    .map(([m, n]) => `${m} ${n}`)
    .join(', ')})`,
);
console.log('  every metric advances on its own; none requires a Reboot');

/* --- Group coverage ------------------------------------------------------
 * A kind that files under a group id no section declares renders NOWHERE,
 * silently. This guards that hole; `ui.ts` derives tier-ness from
 * `describeEffect().group`, so the common drift is already impossible.
 */
const formatSource = readFileSync(join(root, 'src/game/format.ts'), 'utf8');
const uiSource = readFileSync(join(root, 'src/game/ui.ts'), 'utf8');

/*
 * The slice must cover `describeEffectInner` -- where every `group:` string is
 * written -- and it must be found by a LINE-ANCHORED search, for the same
 * reason every other slice in this script is.
 *
 * It used to be `formatSource.indexOf('export function describeEffect')`, and
 * that was silently checking NOTHING: `describeEffect` is a thin wrapper
 * declared AFTER `describeEffectInner`, so the slice began past every group
 * string, `producedGroups` came out empty, and the loop reported "all
 * rendered" having compared zero groups. A check that can pass while finding
 * nothing is worth less than no check, because it is read as coverage.
 *
 * Anchoring to `^` also stops a comment naming either function from matching
 * first -- the failure that broke the upgrade slice once already. The general
 * rule this file keeps rediscovering: a note explaining a rule must not be
 * able to trip the rule.
 */
const innerAt = formatSource.search(/^function describeEffectInner\b/m);
const wrapperAt = formatSource.search(/^export function describeEffect\b/m);
if (innerAt === -1 || wrapperAt === -1 || wrapperAt <= innerAt) {
  fail(
    'could not locate describeEffectInner / describeEffect in format.ts; ' +
      'the effect-group coverage check would compare nothing',
  );
}
const effectFn = formatSource.slice(innerAt, wrapperAt);
const producedGroups = new Set([...effectFn.matchAll(/group: '([a-zA-Z]+)'/g)].map((m) => m[1]));

if (producedGroups.size === 0) {
  fail('parsed 0 effect groups; the formatter slice or its `group:` shape has changed');
}

const declared = new Set(['services']); // rendered by the per-tier service cards
/*
 * `\s*` before `const` because the table is declared INSIDE a function in
 * ui.ts, so it is indented -- a bare `^const` anchor finds nothing and this
 * check then fails on every group at once for the wrong reason.
 */
const groupsAt = uiSource.search(/^\s*const UPGRADE_GROUPS\b/m);
if (groupsAt === -1) {
  fail('could not locate UPGRADE_GROUPS in ui.ts, so no group can be checked as rendered');
}
const groupsBlock = uiSource.slice(groupsAt, uiSource.indexOf('];', groupsAt));
for (const m of groupsBlock.matchAll(/id: '([a-zA-Z]+)'/g)) declared.add(m[1]);

const orphans = [...producedGroups].filter((g) => !declared.has(g));
if (orphans.length > 0) {
  fail(`effect groups rendered nowhere: ${orphans.join(', ')} -- add them to UPGRADE_GROUPS in ui.ts`);
} else {
  console.log(`effect groups: ${[...producedGroups].sort().join(', ')} -- all rendered`);
}

/* --- Achievement ordering ------------------------------------------------
 * The achievements panel renders SOURCE ORDER, with no sort: sorting by rarity
 * alone cannot keep a chain together, because a chain's members span rarity
 * bands, so the panel interleaved them and within one rarity showed the EASY
 * end first.
 *
 * Two properties, asserted rather than assumed:
 *   1. each `chain` occupies ONE contiguous run inside its group;
 *   2. within a run, difficulty is NON-INCREASING -- rarity rank rises from
 *      rarest to commonest, which is hardest-first.
 */
const contentSource = readFileSync(join(root, 'src/game/content.ts'), 'utf8');
const achBlock = contentSource.slice(
  contentSource.indexOf('export const ACHIEVEMENTS'),
  contentSource.indexOf('export const ACHIEVEMENT_RARITIES'),
);

/*
 * Parsed by SLICING between id lines rather than one whole-entry regex: three
 * entries carry a comment block inside the object literal, before `id`, and a
 * `{`-anchored pattern silently skipped them -- the worst kind of parser bug
 * here, because "61 parsed" looks like a content problem rather than a regex
 * one.
 */
const idLineRe = /^    id: '([a-z0-9-]+)',$/gm;
const idMarks = [...achBlock.matchAll(idLineRe)];

const achEntries = idMarks.map((mark, i) => {
  const from = mark.index;
  const to = i + 1 < idMarks.length ? idMarks[i + 1].index : achBlock.length;
  const body = achBlock.slice(from, to);

  const rarity = /^    rarity: '(\w+)',$/m.exec(body)?.[1];
  const chain = /^    chain: '([a-z0-9-]+)',$/m.exec(body)?.[1];
  const group = /^    group: '(\w+)',$/m.exec(body)?.[1];

  if (!rarity || !chain || !group) {
    fail(`achievement ${mark[1]} is missing rarity, chain or group`);
  }

  return { id: mark[1], rarity, chain, group, body };
});

/* 64 is a literal for the same reason the global count is: a figure derived
   from the content would agree with whatever the content says. */
const EXPECTED_ACHIEVEMENTS = 64;
if (achEntries.length !== EXPECTED_ACHIEVEMENTS) {
  fail(`${achEntries.length} achievements parsed, expected ${EXPECTED_ACHIEVEMENTS}`);
}

const achIds = achEntries.map((a) => a.id);
if (new Set(achIds).size !== achIds.length) {
  const dupes = achIds.filter((id, i) => achIds.indexOf(id) !== i);
  fail(`duplicate achievement ids: ${[...new Set(dupes)].join(', ')}`);}

/* Rarest first, matching ACHIEVEMENT_RARITIES in content.ts. Difficulty must
   DECREASE as the list is read, so this rank must never go DOWN. */
const RARITY_RANK = { mythic: 0, gold: 1, silver: 2, bronze: 3 };

/*
 * The upgrade chain is RUN-SCOPED, and the rung has to stay that way.
 *
 * `state.upgrades` is cleared by a Reboot, so `upgrades.length` counts the
 * CURRENT RUN. A lifetime counter would silently change what the achievement
 * means, and the difference is not cosmetic: it would be trivially satisfied by
 * a save that has rebooted a few times.
 *
 * It asks for 50 rather than the full 64. Measured, 50 lands at 14.3h of the 24h
 * reference day while 64 is NOT reached (the simulation tops out at 62), so
 * making the top rung the goal would leave an unreachable summit.
 */
const ladder50 = achEntries.find((a) => a.id === 'ladder-50');
if (!ladder50) {
  fail('ladder-50 is missing; the upgrade chain has no rung');
} else if (!/state\.upgrades\.length >= 50/.test(ladder50.body)) {
  fail('ladder-50 must ask for 50 upgrades bought this run');
}


const GROUP_ORDER = ['deploys', 'fleet', 'output', 'idle', 'prestige'];
let orderFailures = 0;
let chainCount = 0;

for (const group of GROUP_ORDER) {
  const members = achEntries.filter((a) => a.group === group);
  if (members.length === 0) continue;

  /* Property 1: every chain is one contiguous run. */
  const runs = [];
  for (const entry of members) {
    const last = runs[runs.length - 1];
    if (last && last.chain === entry.chain) last.entries.push(entry);
    else runs.push({ chain: entry.chain, entries: [entry] });
  }
  const runNames = runs.map((r) => r.chain);
  if (new Set(runNames).size !== runNames.length) {
    const split = runNames.filter((n, i) => runNames.indexOf(n) !== i);
    fail(`${group}: chain(s) split into non-adjacent runs: ${[...new Set(split)].join(', ')}`);
    orderFailures += 1;
  }

  /* Property 2: within a run, difficulty is non-increasing. */
  for (const run of runs) {
    chainCount += 1;
    const ranks = run.entries.map((e) => RARITY_RANK[e.rarity] ?? 99);
    for (let i = 1; i < ranks.length; i += 1) {
      if (ranks[i] < ranks[i - 1]) {
        fail(
          `${group}/${run.chain}: ${run.entries[i].id} (${run.entries[i].rarity}) is ` +
            `rarer than ${run.entries[i - 1].id} (${run.entries[i - 1].rarity}); ` +
            `a chain must descend from hardest to easiest`,
        );
        orderFailures += 1;
      }
    }
  }
}

if (orderFailures === 0) {
  console.log(
    `achievements: ${achEntries.length} in source order, ${chainCount} chains contiguous and descending`,
  );
}

/* --- Achievement REWARD quality ------------------------------------------
 * The ordering check above asserts rarities descend, which is a property of the
 * LIST. It says nothing about the rewards, and rewards are where the content
 * actually drifted -- every mismatch rendered as a slightly larger number on a
 * card rather than as a broken layout or a wrong order, so nothing caught it.
 *
 * Three assertions cover the shapes: a `globalBonus` must match its rarity, no
 * harder entry may grant LESS of a kind than an easier one in the same chain,
 * and no `offlineEfficiency` value may be granted twice (the fold is Math.max,
 * so a duplicate can never take effect).
 */

/* 1. A `globalBonus` must match its achievement's rarity exactly.
   Read from the reward line, which is the only place the value lives. */
const RARITY_BONUS_CONST = {
  bronze: 'BRONZE_BONUS',
  silver: 'SILVER_BONUS',
  gold: 'GOLD_BONUS',
  mythic: 'MYTHIC_BONUS',
};

const achWithRewards = idMarks.map((mark, i) => {
  const from = mark.index;
  const to = i + 1 < idMarks.length ? idMarks[i + 1].index : achBlock.length;
  const body = achBlock.slice(from, to);
  const rarity = /^    rarity: '(\w+)',$/m.exec(body)?.[1];
  const group = /^    group: '(\w+)',$/m.exec(body)?.[1];
  const chain = /^    chain: '([a-z0-9-]+)',$/m.exec(body)?.[1];
  const bonus = /kind: 'globalBonus', bonus: ([A-Z_]+)/.exec(body)?.[1] ?? null;
  return { id: mark[1], rarity, group, chain, bonus, body };
});

const expectedBonuses = new Set(Object.values(RARITY_BONUS_CONST));
let rewardFailures = 0;
let bonusCount = 0;

for (const entry of achWithRewards) {
  if (entry.bonus === null) continue;
  bonusCount += 1;

  const want = RARITY_BONUS_CONST[entry.rarity];
  if (entry.bonus !== want) {
    fail(
      `${entry.id} is ${entry.rarity} but pays ${entry.bonus} (expected ${want}); ` +
        `a reward must match its rarity or rarity is not a tier`,
    );
    rewardFailures += 1;
  }

  if (!expectedBonuses.has(entry.bonus)) {
    fail(`${entry.id} pays an unknown bonus constant ${entry.bonus}`);
    rewardFailures += 1;
  }
}

if (bonusCount === 0) {
  fail('no achievement pays a globalBonus -- the parser or the content is wrong');
  rewardFailures += 1;
}

/* 2. A HARDER entry must not grant LESS of a reward kind than an easier one in
   the same chain. The chain is read hardest-first, so a kind's value must be
   NON-INCREASING as the list is read: if an easier entry ever grants MORE of
   something than the hardest one that already granted it, the chain is asking
   the player to work harder for less.

   Compared per kind on the numeric field, which is all these rewards carry. */
const REWARD_FIELD = {
  globalBonus: 'bonus',
  clickMult: 'value',
  contractReward: 'value',
  coreGain: 'value',
  shardGain: 'value',
  boostPower: 'value',
  offlineCap: 'hours',
  reserveBonus: 'per',
  coreAmplify: 'per',
  contractSlots: 'slots',
  serviceMult: 'value',
};

/*
 * The ADDITIVE global has to be validated, because it is the one kind whose
 * payoff is not self-evident from its own number: `+20%` additive is worth
 * `1 + 0.2/(1 + pool)`, so it is worth a lot when the pool is small and little
 * when it is large. Two things are checked rather than assumed -- the amount is
 * positive (a negative would be a nerf in a list the player buys from), and the
 * ladder check above already proves the additive steps ascend with price.
 */
const additiveGlobals = upgrades.filter((u) => u.kind === 'globalAdd');
for (const upgrade of additiveGlobals) {
  if (!(upgrade.value > 0)) {
    fail(`${upgrade.id} is a globalAdd with a non-positive value (${upgrade.value})`);
  }
}

console.log('globalMult modes');
console.log('');
console.log(
  `  additive    ${String(additiveGlobals.length).padStart(3)}` +
    `${additiveGlobals.length === 0 ? '  (none yet -- nothing uses the additive axis)' : ''}`,
);
console.log(
  `  mult        ${String(upgrades.filter((u) => u.kind === 'globalMult').length).padStart(3)}`,
);
console.log('');

/*
 * `boostCooldown` is deliberately NOT in the table: lower is better there, so it
 * needs an inverted comparison. It is left unchecked rather than checked
 * backwards, because a silently inverted comparison is worse than none.
 */

for (const group of GROUP_ORDER) {
  const members = achWithRewards.filter((a) => a.group === group);
  const seenPerChain = new Map();

  /* `members` is source order, which the ordering check above has already
     proved is hardest-first within each chain. */
  for (const entry of members) {
    const key = `${group}/${entry.chain}`;
    const seen = seenPerChain.get(key) ?? new Map();

    for (const [kind, field] of Object.entries(REWARD_FIELD)) {
      const raw = new RegExp(`kind: '${kind}', ${field}: ([0-9.]+)`).exec(entry.body)?.[1];
      if (raw === undefined) continue;

      const value = Number.parseFloat(raw);
      const prior = seen.get(kind);

      if (prior !== undefined && value > prior.value) {
        fail(
          `${key}: ${entry.id} is easier than ${prior.id} but grants MORE ` +
            `${kind} (${value} against ${prior.value}); a chain must not pay ` +
            `less for more work`,
        );
        rewardFailures += 1;
      }
      /* Keep the running MAXIMUM, which walking hardest-first is the hardest
         entry's value unless a violation is found. */
      if (prior === undefined || value > prior.value) {
        seen.set(kind, { id: entry.id, value });
      }
    }
    seenPerChain.set(key, seen);
  }
}

/* 3. `offlineEfficiency` is folded with Math.max, so only the LARGEST value in
   the game has any effect. Two entries granting the same value, or a smaller
   one that arrives by an easier route, is a reward the player cannot feel. */
const efficiencyValues = [
  ...achBlock.matchAll(/kind: 'offlineEfficiency', value: ([0-9.]+)/g),
].map((m) => ({ value: Number.parseFloat(m[1]) }));

const dupeEfficiency = efficiencyValues
  .map((e) => e.value)
  .filter((v, i, all) => all.indexOf(v) !== i);
if (dupeEfficiency.length > 0) {
  fail(
    `offlineEfficiency ${[...new Set(dupeEfficiency)].join(', ')} granted more than once; ` +
      `the fold is Math.max, so the duplicate can never take effect`,
  );
  rewardFailures += 1;
}

if (rewardFailures === 0) {
  console.log(
    `rewards: ${bonusCount} global bonuses all match their rarity, none dominated within a chain, ` +
      `no inert offlineEfficiency`,
  );
}

console.log(failures === 0 ? `\nOK: ${upgrades.length} upgrades on a contiguous 0..${upgrades.length - 1} ladder.` : `\n${failures} FAILURES.`);
process.exit(failures === 0 ? 0 : 1);
