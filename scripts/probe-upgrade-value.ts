/*
 * What is one upgrade WORTH, and is a price band internally fair?
 *
 *   npm run probe:value
 *
 * The price table is BANDED -- a price comes from the rung -- so six to ten
 * upgrades share every price. That makes a claim the game has to honour: "the
 * same 250 shards buys the same amount of power". This measures it.
 *
 * VALUE IS MARGINAL INCOME. A `clickMult` is not worth what a `globalMult` is
 * worth just because both are multipliers: `clickPower` already contains
 * `perSecond * CLICK.throughputShare`, so a click upgrade multiplies a fraction
 * of production while a global multiplies production AND the click power
 * derived from it. The only honest comparison runs both through one income
 * formula.
 *
 * Each upgrade is measured in rung order against a fleet that OWNS EVERY RUNG
 * BELOW IT. Count-driven effects read zero against an empty list, so measuring
 * a bare fleet would report a row as worthless when it is only starved.
 *
 * NOT VISIBLE HERE: cost reductions, contract slots and shard income do not add
 * income, so they read 0 and are listed separately rather than averaged in.
 */

import { initialState } from '../src/game/state';
import { computeStats, upgradeCost } from '../src/game/engine';
import { ACHIEVEMENTS, ABILITIES, SERVICES, UPGRADES } from '../src/game/content';
import type { GameState } from '../src/game/types';

/** Clicks per second while the tab is open. Matches `check:progression`. */
const CLICKS_PER_SECOND = Number(process.env.PROBE_CLICKS ?? 4);

/** Units per tier in the reference fleet, before it is topped up per row. */
const UNITS_PER_TIER = 50;

/** A late-but-not-endgame save with production and progression counters populated. */
function referenceState(): GameState {
  const state = initialState(20260920);
  for (const service of SERVICES) state.services[service.id] = UNITS_PER_TIER;
  state.playtime = 4 * 60 * 60 * 1000;
  state.contractsCompleted = 40;
  state.clicks = 2_000;
  state.shards = 5_000;
  state.shardsEarned = 5_000;
  state.totalEarned = 1e12;
  state.runEarned = 1e12;
  state.offlineReturns = 5;
  state.totalOfflineEarned = 1e9;
  /*
   * Reboots, so `serviceReboots` has a quantity. A saved `reboots` count
   * without cores would be incoherent, so the cores the same reboots would
   * have banked are set too -- which also gives `serviceCores` something.
   */
  state.reboots = 2;
  state.cores = 25;
  /*
   * UNLOCKED achievements, and they are load-bearing for `serviceRarity`:
   * that row counts the unlocked set by rarity, so an empty one makes the row
   * read 0 and be reported as non-income content. Filled from the content
   * table at its real rarities rather than an even split, so the measured
   * value matches what a player of this size would actually hold.
   *
   * The FIRST EIGHT of each rarity, so the count is bounded and the number is
   * one a save of this age could really have.
   */
  const byRarity = new Map<string, number>();
  for (const def of ACHIEVEMENTS) {
    const seen = byRarity.get(def.rarity) ?? 0;
    if (seen >= 8) continue;
    byRarity.set(def.rarity, seen + 1);
    state.achievements.push(def.id);
  }
  /*
   * Ability uses, likewise: `serviceAbilityUses` sums `uses` across the
   * ability records. Iterated from `ABILITIES` and not from the state, because
   * `initialState()` ships `abilities: {}` -- the map is populated lazily, the
   * first time an ability is activated -- so walking the state's own keys
   * finds nothing and the row silently measures zero.
   */
  for (const def of ABILITIES) {
    state.abilities[def.id] = { until: 0, readyAt: 0, uses: 6 };
  }
  state.startedAt = Date.now() - 48 * 60 * 60 * 1000;
  return state;
}

/** Total income rate, including the player's own clicking and the automation. */
function incomeOf(state: GameState, clickRate: number): number {
  const stats = computeStats(state);
  return (
    stats.perSecond +
    clickRate * stats.clickPower +
    stats.autoDeployRate * stats.autoDeployValue
  );
}

interface Row {
  id: string;
  rung: number;
  price: number;
  gain: number;
  perShard: number;
  capstone: boolean;
  /** A per-tier row, judged inside its own tier rather than across the shop. */
  perTier: boolean;
}

/**
 * Below this a row does not move income and is not a "value" row. A threshold
 * rather than `> 0`: `after / before - 1` on a row that cannot affect income
 * still returns float dust around 1e-16, which is positive, so a bare `> 0`
 * test counts it as an income upgrade and reports it as the worst in its band.
 */
const INCOME_EPSILON = 1e-4;

/**
 * Per-tier rows scale ONE tier, and `perSecond` is dominated by the deepest
 * tier (base output runs 0.1 to 44,000), so a Worker bonus is invisible to a
 * total-income metric even when it works. They are measured and printed but
 * excluded from the fairness table: they never compete with a global at the
 * same price, because they are only available inside their own service card.
 *
 * Classified from the EFFECT, not from a list of ids: a per-tier row is one
 * whose effect names a `serviceId`. Testing the kind STRING for a `service`
 * prefix is not enough -- `globalPerOwned` (worker-3) and `milestoneStep`
 * (database-3) are per-tier mechanisms whose names do not say so.
 */
function isPerTier(effect: { serviceId?: string }): boolean {
  return effect.serviceId !== undefined;
}

function measure(clickRate: number): { rows: Row[]; nonIncome: string[] } {
  const rows: Row[] = [];
  const nonIncome: string[] = [];

  /* Rebuilt per rate: `marginal` needs a clean, rung-ordered owned list. */
  const state = referenceState();

  for (const upgrade of UPGRADES) {
    while (state.upgrades.length < upgrade.rung) {
      const below = UPGRADES[state.upgrades.length];
      if (below === undefined) break;
      state.upgrades.push(below.id);
    }

    const price = upgradeCost(upgrade);
    const before = incomeOf(state, clickRate);
    state.upgrades.push(upgrade.id);
    const after = incomeOf(state, clickRate);
    state.upgrades.pop();
    const gain = after / before - 1;

    if (gain < INCOME_EPSILON) {
      nonIncome.push(`${upgrade.id} (${upgrade.effect.kind})`);
      continue;
    }

    rows.push({
      id: upgrade.id,
      rung: upgrade.rung,
      price,
      gain,
      perShard: gain / price,
      capstone: upgrade.capstone === true,
      perTier: isPerTier(upgrade.effect),
    });
  }

  return { rows, nonIncome };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const { rows, nonIncome } = measure(CLICKS_PER_SECOND);

console.log('UPGRADE VALUE PER SHARD');
console.log(`${CLICKS_PER_SECOND} clicks/s, reference fleet ${UNITS_PER_TIER}/tier, 40 contracts`);
console.log('');
console.log('rung  price  gain      per-shard   id');
for (const row of rows) {
  console.log(
    String(row.rung).padStart(4),
    String(row.price).padStart(6),
    pct(row.gain).padStart(8),
    (row.perShard * 1000).toFixed(2).padStart(9),
    `  ${row.id}${row.capstone ? ' (capstone)' : ''}${row.perTier ? ' [tier]' : ''}`,
  );
}

/*
 * The click tree cannot be judged at one click rate. `clickPower` contains
 * `perSecond * (throughputShare + share upgrades)`, so the click channel's
 * weight is (clicks/s x share) relative to 1 -- at 4 clicks/s and the 0.2
 * base share clicking is worth 80% of production, at 1 click/s a fifth of
 * that, and at the 0.5 ceiling it is worth twice the whole fleet.
 */
console.log('');
console.log('CLICK CHAIN vs CLICK RATE (per-shard value)');
console.log('');
/*
 * The two `throughputShare` rows belong in this view because they act on the
 * click channel and are therefore worth nothing at all to a player who does not
 * click. Their ids still read `synergy-1` / `offline-1` because an id is a save
 * key -- see the notes in content.ts.
 *
 * WHAT NOT TO CLAIM ABOUT THEM: that they are the most rate-sensitive rows
 * here. They are LESS sensitive than the tree, measured. Across 1 -> 8 clicks/s
 * `click-1` moves 6.53 -> 9.38 per shard while this pair moves 0.59 -> 0.66,
 * and the reason is structural rather than tunable: a share point's gain is
 * bounded by its own RATIO to the share it joins (0.1 onto 0.2 is +33% of that
 * term, and the ratio only falls as the ladder is bought), whereas a `clickMult`
 * of 2 is worth 100% of the whole click however large the click channel gets.
 */
const clickRows = [
  'click-1',
  'click-2',
  'click-3',
  'click-4',
  'synergy-1',
  'offline-1',
];
const rates = [1, 2, 4, 8];
const byRate = new Map<number, Row[]>();
for (const rate of rates) byRate.set(rate, measure(rate).rows);

console.log(`id        price  ${rates.map((r) => `${r}/s`.padStart(9)).join('')}`);
for (const id of clickRows) {
  const row = rows.find((r) => r.id === id);
  if (row === undefined) continue;
  const cells = rates.map((rate) => {
    const found = byRate.get(rate)?.find((r) => r.id === id);
    return (found === undefined ? '-' : (found.perShard * 1000).toFixed(2)).padStart(9);
  });
  console.log(`${id.padEnd(9)} ${String(row.price).padStart(5)}  ${cells.join('')}`);
}

/* The fairness table, which is the actual question: within one price, the
   spread between the best and worst per-shard value is what a player faces. */
console.log('');
console.log('SAME-PRICE FAIRNESS (global income upgrades only)');
console.log('');
console.log('price  count  best              worst             spread');
const byPrice = new Map<number, Row[]>();
for (const row of rows) {
  if (row.perTier) continue;
  const list = byPrice.get(row.price) ?? [];
  list.push(row);
  byPrice.set(row.price, list);
}

let widest = 0;
for (const [price, list] of [...byPrice.entries()].sort((a, b) => a[0] - b[0])) {
  const sorted = [...list].sort((a, b) => b.perShard - a.perShard);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const spread = best.perShard / worst.perShard;
  if (spread > widest) widest = spread;
  console.log(
    String(price).padStart(5),
    String(list.length).padStart(6),
    `  ${best.id} ${(best.perShard * 1000).toFixed(2)}`.padEnd(18),
    `  ${worst.id} ${(worst.perShard * 1000).toFixed(2)}`.padEnd(18),
    `${spread.toFixed(1)}x`.padStart(8),
  );
}

console.log('');
console.log(`widest spread inside one price: ${widest.toFixed(1)}x`);
console.log('(1.0x would mean every row at that price is equally worth buying)');

/*
 * The kinds that do not multiply a tier's OUTPUT, so `incomeOf()` cannot see
 * them however large their number is.
 *
 * An explicit set rather than a name test. `kind.startsWith('service')` was
 * tried and it mislabels `serviceEconomy` (a cost discount) and
 * `serviceShardGain` (shard income) as output rows that merely measured
 * small -- which is a false statement about what those rows do. The set is
 * the honest unit here because the question is "what does this act on", and
 * that is not recoverable from the kind's spelling.
 *
 * `milestoneStep` is deliberately NOT in this set: it does act on output, by
 * moving where the doublings fall, and it measures zero at 50 units because
 * 50/25 and 50/20 are both two steps. That is a fact about the reference
 * fleet, which is the other list.
 */
const NON_OUTPUT_KINDS = new Set([
  'costMult',
  'serviceEconomy',
  'contractReward',
  'contractSlots',
  'shardGain',
  'serviceShardGain',
  'autoBuy',
  'offlineCap',
  'coreAmplify',
]);

if (nonIncome.length > 0) {
  /* TWO reasons a row lands here, and they are NOT the same fact. */
  const genuinelyNonIncome = nonIncome.filter((entry) => {
    const kind = entry.slice(entry.indexOf('(') + 1, -1);
    return NON_OUTPUT_KINDS.has(kind);
  });
  const belowFloor = nonIncome.filter((entry) => !genuinelyNonIncome.includes(entry));

  console.log('');
  console.log(`NOT INCOME AT ALL (${genuinelyNonIncome.length}) -- they act on cost, slots, shard income or offline time:`);
  console.log(`  ${genuinelyNonIncome.join(', ')}`);
  console.log('');
  console.log(`OUTPUT ROWS BELOW THE FLOOR HERE (${belowFloor.length}) -- under ${INCOME_EPSILON} of TOTAL income at this fleet:`);
  console.log(
    'income is dominated by the deepest tier (base output 0.1 vs 44,000), so a cheap tier\'s bonus is lost in it;',
  );
  console.log(
    'and `milestoneStep` moves where the doublings fall, which at 50 units is no boundary at all:',
  );
  console.log(`  ${belowFloor.join(', ')}`);
}

console.log('');
console.log(
  `achievements in the reference state: ${referenceState().achievements.length} of ${ACHIEVEMENTS.length} (seeded by rarity, so \`serviceRarity\` has a quantity)`,
);
console.log(
  `ability uses in the reference state: ${ABILITIES.length} abilities x 6 (seeded, so \`serviceAbilityUses\` has a quantity)`,
);
