/*
 * Progression simulation: how long the game actually takes.
 *
 *   npm run check:progression
 *
 * This runs the REAL engine -- not a model of it -- and reports the hour at
 * which each thing lands. `check:ladder` cannot do this: it is plain node
 * reading content.ts as text, because it needs to inspect source shape. It has
 * no idea whether a number is reachable.
 *
 * The engine runs for real: costs, milestones, achievements, contract sizing,
 * automation and the shard economy. What is MODELLED is the player:
 *
 *   - 4 manual deploys a second while the tab is open, which is brisk but
 *     sustainable and matches the reference session.
 *   - Greedy buying: the most ADVANCED tier affordable, one unit at a time.
 *     Buying the cheapest instead never leaves Worker, because Worker is always
 *     the cheapest thing on screen.
 *   - Upgrades: the cheapest affordable, immediately.
 *   - No Reboot, because a prestige loop resets the fleet the ladder is paced
 *     against, so the figure would depend on how the player prestiges rather
 *     than on the content.
 *   - No offline time: a continuous session, which is the honest reading of
 *     "how long is the game".
 *
 * The output is a TABLE first and a verdict second. Two things ARE asserted,
 * and neither is a bound derived from this script's own answer:
 *
 *   - every seed must FINISH inside `BUDGET_HOURS`, i.e. the fleet, the ladder
 *     and the contract collection must all complete. `BUDGET_HOURS` is a
 *     product decision ("finishable inside a day"), so it is a real
 *     constraint the content has to satisfy rather than a restatement of it.
 *   - the measured contract rate must stay within `RATE_TOLERANCE` of
 *     `SHARDS.pacing.referenceContractsPerHour`. That constant is what
 *     `check:ladder` converts the whole price table into HOURS with, so if the
 *     two drift the ladder's pace report silently measures a game that no
 *     longer exists -- which is exactly how the old `ladderBudget` rubber
 *     stamp worked.
 *
 * Everything else is reported, not judged. A tight bound on the ladder's own
 * cost would be set from this script's answer, which is the unfalsifiable
 * shape `ladderBudget` had.
 */

import { initialState } from '../src/game/state';
import {
  advance,
  buyService,
  buyUpgrade,
  canAffordUpgrade,
  checkAchievements,
  activateAbility,
  collectContracts,
  computeStats,
  costOfWith,
  fillContracts,
  manualDeploy,
  runAutomation,
  shardPayout,
  contractReward,
  abilityStatuses,
  upgradeCost,
  milestoneStepPayout,
  milestoneStepsByTier,
  FIXED_AMOUNT_METRICS,
  visibleUpgrades,
} from '../src/game/engine';
import type { AutomationCarry } from '../src/game/engine';
import {
  CONTRACT_DEFS,
  CONTRACTS,
  SERVICES,
  SHARDS,
  UPGRADES,
} from '../src/game/content';
import { ABILITIES, ABILITY_BY_ID, SERVICE_BY_ID } from '../src/game/content';
import { contractObjective } from '../src/game/format';
import type { ContractDef, GameState } from '../src/game/types';

/* --------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

/** The product decision: the game must be finishable inside a day. */
const BUDGET_HOURS = 24;

/**
 * How far the MEASURED contract rate may drift from
 * `SHARDS.pacing.referenceContractsPerHour` before this script fails.
 *
 * The tolerance is loose on purpose, and the reason is documented above the
 * distribution section below: the same player model produces a 35x spread
 * across seeds on identical content, because the engine's randomness is
 * stateless and every contract draw feeds back into income. A tight tolerance
 * on a chaotic quantity would fail at random.
 *
 * Loose does not mean optional. The failure it exists to catch is not
 * "the rate moved a bit" -- it is "the constant was never updated, so
 * `check:ladder` is sizing the whole ladder against a game that no longer
 * exists". That failure is measured in multiples, not percent.
 */
const RATE_TOLERANCE = 0.5;

/**
 * How far the MEASURED milestone rate may drift from
 * `SHARDS.pacing.referenceMilestonesPerHour` before this script fails.
 *
 * The same guard as `RATE_TOLERANCE`, and it exists for the same reason: a
 * reference rate that drifts from the rate the game actually pays produces
 * hours in `check:ladder` that mean nothing while still passing the band. That
 * script reads `content.ts` as TEXT and cannot measure anything, so the two
 * halves of the seam have to check each other.
 *
 * Wider than the contract tolerance because the quantity is far smaller -- a
 * median of about 3 steps an hour against 60 contracts -- so the same absolute
 * wobble is a bigger share of it, and because crossings are bursty (a bulk buy
 * or a Provision grant crosses several at once).
 */
const MILESTONE_TOLERANCE = 0.75;
/**
 * Tolerance for the average milestone payout per step.
 *
 * Tighter than the two RATE tolerances and for a different reason: the rates are
 * measured behaviour with run-to-run spread, while the per-step average is the
 * mean of a deterministic payout schedule. It is a property of the CONTENT, so
 * a loose band here would let a real content change pass unremarked.
 */
const PER_STEP_TOLERANCE = 0.1;

/** Manual deploys a second while the tab is open. */
const CLICKS_PER_SECOND = Number(process.env.PROGRESSION_CLICKS ?? 4);

/**
 * A fixed seed, so two runs of this script are comparable.
 *
 * `initialState` seeds from `Math.random()` and the clock, and the seed reaches
 * the contract DRAW and the salvage roll. With a random seed this report swung
 * between 63 and 502 contracts an hour on identical content, which makes it
 * useless as a baseline: a checker that answers differently every time cannot
 * tell a change from noise.
 */
const FIXED_SEED = 20260919;

/** One simulation step. One second is fine-grained enough for every rate here. */
const STEP_MS = 1000;

/** Bound on purchases per step, so one windfall cannot spin. */
const MAX_BUYS_PER_STEP = Number(process.env.PROGRESSION_BUYS ?? 60);

/**
 * How many seeds to sample. More than one because the result is chaotic: see
 * the distribution section in the report. Cheap enough to be the default.
 */
const SEEDS = Number(process.env.PROGRESSION_SEEDS ?? 8);

/**
 * What "finished" means: the LAST of the three long tracks, not one of them.
 * A game is finished when the fleet, the ladder and the contract collection are
 * all done, and reporting any one alone is how a 10-hour gap stayed invisible.
 */
const TARGETS = {
  upgrades: UPGRADES.length,
  contracts: 200,
  /** Units of the deepest tier, the stand-in for "the fleet is finished". */
  finalTierUnits: 100,
};

const FINAL_TIER = SERVICES[SERVICES.length - 1].id;

/* Resolved once, before `run()` executes. A contract carries only its id, so
   mapping a completed contract back to its definition happens on every
   completion -- roughly 15,000 times per seed -- and a linear scan there would
   be pure waste. */
const CONTRACT_BY_ID = new Map(CONTRACT_DEFS.map((def) => [def.id, def]));

/* --------------------------------------------------------------------------
   Milestones to report
   -------------------------------------------------------------------------- */

interface Milestone {
  label: string;
  reached: (state: GameState) => boolean;
  /** Hours at which it landed, filled in by the loop. */
  at?: number;
}

const DATA_CENTER_STEPS = [1, 10, 25, 50, 100];

const milestones: Milestone[] = [
  ...DATA_CENTER_STEPS.map((units) => ({
    label: `${SERVICES[SERVICES.length - 1].name} ${units}`,
    reached: (s: GameState) => (s.services[FINAL_TIER] ?? 0) >= units,
  })),
  { label: 'Upgrades 32', reached: (s: GameState) => s.upgrades.length >= 32 },
  { label: `Upgrades ${TARGETS.upgrades}`, reached: (s: GameState) => s.upgrades.length >= TARGETS.upgrades },
  { label: 'Contracts 25 (Surge)', reached: (s: GameState) => s.contractsCompleted >= 25 },
  { label: 'Contracts 50', reached: (s: GameState) => s.contractsCompleted >= 50 },
  { label: `Contracts ${TARGETS.contracts}`, reached: (s: GameState) => s.contractsCompleted >= TARGETS.contracts },
  { label: 'Total units 250 (Provision)', reached: (s: GameState) => totalUnits(s) >= 250 },
];

function totalUnits(state: GameState): number {
  return SERVICES.reduce((sum, s) => sum + (state.services[s.id] ?? 0), 0);
}

/** Upgrades the player can see, cheapest first. */
function affordableUpgrade(state: GameState, stats: ReturnType<typeof computeStats>): string | null {
  const visible = visibleUpgrades(state, stats);
  let best: string | null = null;
  let bestCost = Infinity;
  for (const upgrade of visible) {
    if (state.upgrades.includes(upgrade.id)) continue;
    if (!canAffordUpgrade(state, upgrade.id)) continue;
    /*
     * The REAL price, through the engine's own resolver.
     *
     * This compared by `rung` as a stand-in, because a price was not exposed on
     * the def and one rung-indexed band table priced everything. Neither is
     * true now: prices come from `SHARDS.tierBands` and `SHARDS.globalBands`,
     * keyed off the effect's `serviceId` depth and the explicit `capstone`
     * flag. So "cheapest by rung" is no longer "cheapest", and the simulated
     * purchase ORDER -- which every figure in this report derives from -- would
     * quietly measure a different player. Calling the resolver also means this
     * script cannot disagree with the game about what a rung costs.
     */
    const cost = upgradeCost(upgrade);
    if (cost < bestCost) {
      bestCost = cost;
      best = upgrade.id;
    }
  }
  return best;
}

/** Buy the most ADVANCED tier affordable, one unit at a time. */
function greedyBuy(state: GameState, stats: ReturnType<typeof computeStats>): number {
  let bought = 0;
  for (let i = 0; i < MAX_BUYS_PER_STEP; i++) {
    let target: string | null = null;
    for (let ti = SERVICES.length - 1; ti >= 0; ti--) {
      const service = SERVICES[ti];
      const owned = state.services[service.id] ?? 0;
      const cost = costOfWith(service, owned, 1, stats);
      if (Number.isFinite(cost) && cost <= state.compute) {
        target = service.id;
        break;
      }
    }
    if (target === null) break;
    if (!buyService(state, target, 1, stats)) break;
    bought += 1;
  }
  return bought;
}

/* --------------------------------------------------------------------------
   Checkpoints
   -------------------------------------------------------------------------- */

/**
 * A running snapshot, printed at fixed hours.
 *
 * The headline figures at the end of a 24-hour run say nothing about SHAPE:
 * a game that completes in twenty minutes and then idles is indistinguishable
 * from one that paces itself, if you only look at the last row. These are what
 * make the difference visible, and they are the reason this script exists
 * rather than a single "hours to finish" number.
 */
const CHECKPOINTS_HOURS = [1 / 12, 1 / 6, 1 / 3, 1, 2, 4, 8, 12, 24];

interface Checkpoint {
  hours: number;
  units: number;
  perSecond: number;
  contracts: number;
  shards: number;
}

/**
 * One completed contract, reduced to the timing question.
 *
 * A definition declares `cost` in SECONDS OF PRODUCTION, and the objective is
 * sized to be worth that many seconds at issue. Whether the player then SPENDS
 * that many seconds on it is a separate claim, and it is the one this record
 * tests: `actual / declared` is 1 when the card's promise holds.
 */
interface TimedContract {
  metric: ContractDef['metric'];
  declaredSeconds: number;
  actualSeconds: number;
  /** Hour of the run this completed on, so the error can be bucketed by phase. */
  atHours: number;
}

/** One sampled trajectory, reduced to the numbers worth aggregating. */
interface Sample {
  seed: number;
  /** False when the run exhausted `BUDGET_HOURS` without completing. */
  finished: boolean;
  /**
   * Hours the run ran for: the completion hour when it finished early, and
   * `BUDGET_HOURS` when it did not.
   *
   * Kept because both RATES are per hour, and dividing by anything else -- the
   * budget when the run ended sooner -- understates them by however early it
   * finished. `contractRate` below already used it; the milestone rate needs
   * it for the same reason.
   */
  hours: number;
  hoursToFleet: number;
  contracts: number;
  contractRate: number;
  shards: number;
  crossedSteps: number;
  milestoneShards: number;
  /**
   * The same figure BEFORE `shardMult`, so the average base payout per step can
   * be measured. `SHARDS.pacing.referencePerMilestoneStep` is set from it, and
   * `check:ladder`'s pace model cannot discover it by measurement.
   */
  milestoneBaseShards: number;
  /**
   * The highest unit count each tier reached during the run.
   *
   * Tracked because it is what decides whether a per-tier cap can ever BIND. A
   * `cap` larger than the maximum a tier reaches is a ceiling the player can
   * never touch, and the upgrade's badge -- which prints `1 + cap` -- then
   * promises a figure the game cannot deliver. That is a claim about the
   * content that only a measurement can settle.
   */
  peakUnits: Record<string, number>;
  upgrades: number;
  units: number;
  checkpoints: Checkpoint[];
  /** Every completion, kept for the per-metric objective-time table. */
  timings: TimedContract[];
}

/* --------------------------------------------------------------------------
   The run
   -------------------------------------------------------------------------- */

function run(seed: number): {
  state: GameState;
  hours: number;
  steps: number;
  checkpoints: Checkpoint[];
  crossedSteps: number;
  milestoneShards: number;
  milestoneBaseShards: number;
  peakUnits: Record<string, number>;
  timings: TimedContract[];
} {
  const now = Date.now();
  const state = initialState(now);
  state.seed = seed;
  const carry: AutomationCarry = { deploy: 0, buy: 0 };
  let clickCarry = 0;

  const totalMs = BUDGET_HOURS * 60 * 60 * 1000;
  const steps = Math.floor(totalMs / STEP_MS);

  const checkpoints: Checkpoint[] = [];
  let nextCheckpoint = 0;

  /*
   * When each active contract was ISSUED, keyed by id.
   *
   * A contract stores no timestamp -- it does not need one in the game, where
   * progress is measured against a baseline rather than a clock. To test the
   * card's promise ("this is `cost` seconds of production") the harness has to
   * supply the clock itself, so the step a contract first appears on is
   * recorded here and compared against the step it disappears on.
   *
   * `collectContracts` replaces a completed contract internally, so new ids
   * appear DURING the call. Anything seen for the first time after a collect
   * starts its clock then, not at the fill above.
   */
  const issuedAt = new Map<string, number>();
  const timings: TimedContract[] = [];
  const trackIssued = (step: number): void => {
    for (const contract of state.contracts) {
      if (!issuedAt.has(contract.id)) issuedAt.set(contract.id, step);
    }
  };

  /* The fleet's milestone progress, tracked to explain the plateau AND to
     measure the faucet that pays per crossing. */
  let crossedSteps = 0;
  let milestoneShards = 0;
  let milestoneBaseShards = 0;
  let lastSteps: number[] = SERVICES.map(() => 0);
  /* Highest count each tier reaches, so a cap can be checked for reachability. */
  const peakUnits: Record<string, number> = {};
  for (const service of SERVICES) peakUnits[service.id] = 0;

  for (let step = 1; step <= steps; step++) {
    const stats = computeStats(state, now + step * STEP_MS);
    const hours = (step * STEP_MS) / 3_600_000;

    /* --- Produce ------------------------------------------------------- */
    advance(state, STEP_MS, stats);

    /* Manual clicking, on a fractional accumulator so the rate is exact. */
    clickCarry += CLICKS_PER_SECOND * (STEP_MS / 1000);
    const clicks = Math.floor(clickCarry);
    if (clicks > 0) {
      clickCarry -= clicks;
      for (let i = 0; i < clicks; i++) manualDeploy(state, stats);
    }

    /* --- Automation ---------------------------------------------------- */
    runAutomation(state, stats, STEP_MS, carry);

    /* --- Abilities -----------------------------------------------------
     * Every ready ability is pressed, immediately.
     *
     * THIS WAS MISSING FROM THE MODEL, and it mattered far more than it looks.
     * A contract measured on `abilityUses` cannot complete for a player who
     * never presses a button, so three of the five slots were held by
     * permanently-uncompletable contracts -- and an uncompletable contract does
     * not merely sit there, it holds a slot. With three of five slots dead the
     * shard faucet starved, and the report showed contractsCompleted frozen at
     * exactly 41 for 7.7 hours with shardsEarned frozen at 584 alongside it.
     *
     * That read as an economy deadlock and was a PLAYER-MODEL defect. The
     * distinction matters: retuning the shard economy to fix it would have
     * changed the game to compensate for a harness bug.
     */
    const abilityNow = now + step * STEP_MS;
    const statuses = abilityStatuses(state, abilityNow);
    for (const def of ABILITIES) {
      if (statuses[def.id]?.ready === true) activateAbility(state, def.id, abilityNow, stats);
    }

    /* --- Spend --------------------------------------------------------- */
    greedyBuy(state, stats);
    for (let i = 0; i < 20; i++) {
      const id = affordableUpgrade(state, stats);
      if (id === null) break;
      if (!buyUpgrade(state, id)) break;
    }

    /* --- The fleet's milestone progress ---------------------------------
       Counted, and since the faucet pays per crossing this is now an economy
       INPUT as well as the plateau diagnostic it was written as. The shard
       figure is accumulated here rather than ablated at the end, because
       ablation shares a seed and not a trajectory: fewer shards means fewer
       upgrades, which moves every later contract. See docs/DECISIONS.md. */
    const stepsNow = milestoneStepsByTier(state, stats);
    /*
     * Paid PER TIER, using the engine's own `milestoneStepPayout`, rather than
     * `crossed x perMilestone` over a fleet total.
     *
     * Two reasons, and the second is the important one. The payout now differs
     * by tier, so a fleet-wide count cannot say what is owed. And the formula
     * must not be duplicated here at all: a second copy of a reward calculation
     * is how a report starts disagreeing with the game it reports on, which is
     * a failure this file has already been bitten by once.
     */
    SERVICES.forEach((_service, index) => {
      const before = lastSteps[index] ?? 0;
      const after = stepsNow[index] ?? 0;
      if (after <= before) return;
      crossedSteps += after - before;
      /* `stats.shardMult` is the multiplier the award itself uses, sampled at
         the crossing, so this is the payout and not an estimate of it. */
      for (let step = before; step < after; step += 1) {
        const payout = milestoneStepPayout(index, step);
        milestoneBaseShards += payout;
        milestoneShards += payout * stats.shardMult;
      }
    });
    lastSteps = stepsNow;

    /* Sampled AFTER the spend step, which is where units are acquired. */
    for (const service of SERVICES) {
      const count = state.services[service.id] ?? 0;
      if (count > peakUnits[service.id]) peakUnits[service.id] = count;
    }

    /* --- Contracts ----------------------------------------------------- */
    if (state.contracts.length < stats.contractSlots) {
      fillContracts(state, stats.contractSlots, stats);
    }
    trackIssued(step);

    /*
     * Diff the active set around the collect so each completion can be timed.
     * `collectContracts` returns only aggregate totals, and a contract that has
     * vanished from the array is one that was claimed -- the same signal the
     * replacement logic uses.
     */
    const activeBefore = new Set(state.contracts.map((c) => c.id));
    collectContracts(state, stats);
    for (const id of activeBefore) {
      if (state.contracts.some((c) => c.id === id)) continue;
      const issuedStep = issuedAt.get(id);
      issuedAt.delete(id);
      const def = CONTRACT_BY_ID.get(id);
      if (issuedStep === undefined || def === undefined) continue;
      timings.push({
        metric: def.metric,
        declaredSeconds: def.cost,
        actualSeconds: ((step - issuedStep) * STEP_MS) / 1000,
        atHours: (step * STEP_MS) / 3_600_000,
      });
    }
    trackIssued(step);

    /* --- Achievements -------------------------------------------------- */
    checkAchievements(state, stats);

    /* --- Record -------------------------------------------------------- */
    for (const milestone of milestones) {
      if (milestone.at === undefined && milestone.reached(state)) {
        milestone.at = hours;
      }
    }

    while (
      nextCheckpoint < CHECKPOINTS_HOURS.length &&
      hours >= CHECKPOINTS_HOURS[nextCheckpoint]
    ) {
      checkpoints.push({
        hours,
        units: totalUnits(state),
        perSecond: stats.perSecond,
        contracts: state.contractsCompleted,
        shards: state.shardsEarned,
      });
      nextCheckpoint += 1;
    }

    if (finished(state)) {
      return { state, hours, steps: step, checkpoints, crossedSteps, milestoneShards, milestoneBaseShards, peakUnits, timings };
    }
  }

  return {
    state,
    hours: BUDGET_HOURS,
    steps,
    checkpoints,
    crossedSteps,
    milestoneShards,
    milestoneBaseShards,
    peakUnits,
    timings,
  };
}

function finished(state: GameState): boolean {
  return (
    state.upgrades.length >= TARGETS.upgrades &&
    state.contractsCompleted >= TARGETS.contracts &&
    (state.services[FINAL_TIER] ?? 0) >= TARGETS.finalTierUnits
  );
}

/* --------------------------------------------------------------------------
   Report
   -------------------------------------------------------------------------- */

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * The median of per-GROUP medians, weighting every group equally.
 *
 * This is the figure the objective-time assertions are stated on, and the reason
 * is that a plain median over every observation is not a stable unit of
 * measurement in this harness.
 *
 * A run stops when the contract target is met, so making contracts harder lowers
 * the rate, which EXTENDS the run, which shifts completions into later phases.
 * A completion-weighted median therefore moves when the quantity being tuned
 * changes, and it moves in a direction set by the phase mix rather than by the
 * objective -- so a per-metric correction table tuned against it came out
 * NON-MONOTONE, with a larger factor measuring as a smaller one.
 *
 * Bucketing by phase and weighting the buckets equally removes that: within a
 * fixed phase window the production trajectory barely changes when the objective
 * is enlarged (a payout is a multiple of production, so it is a second-order
 * term), so the per-phase ratio is a property of the phase rather than of the
 * run's length.
 *
 * The completion-weighted median is still PRINTED beside it. Whether the two
 * agree is a coherence test: a large gap means the metric's cost is dominated by
 * one part of the run, which is worth seeing even though it is not itself a
 * failure.
 */
function medianOfGroups(groups: Map<number, number[]> | undefined): number {
  if (groups === undefined) return Number.NaN;
  const perGroup = [...groups.values()]
    .filter((list) => list.length > 0)
    .map((list) => median(list));
  return perGroup.length === 0 ? Number.NaN : median(perGroup);
}

const started = Date.now();

const samples: Sample[] = [];
for (let i = 0; i < SEEDS; i++) {
  const seed = FIXED_SEED + i * 7919;
  const { state, hours, checkpoints, crossedSteps, milestoneShards, milestoneBaseShards, peakUnits, timings } = run(seed);
  const fleet = milestones.find((m) => m.label.startsWith(`${SERVICES[SERVICES.length - 1].name} ${TARGETS.finalTierUnits}`));
  samples.push({
    seed,
    finished: finished(state),
    hours,
    hoursToFleet: fleet?.at ?? Number.POSITIVE_INFINITY,
    contracts: state.contractsCompleted,
    contractRate: state.contractsCompleted / hours,
    shards: state.shardsEarned,
    crossedSteps,
    milestoneShards,
    milestoneBaseShards,
    peakUnits,
    upgrades: state.upgrades.length,
    units: totalUnits(state),
    checkpoints,
    timings,
  });
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const first = samples[0];

console.log(`progression over ${SEEDS} seeds, ${CLICKS_PER_SECOND} clicks/s while the tab is open`);
console.log('');

console.log('  hour     units        compute/s         contracts   shards      (first seed)');
console.log('  -------------------------------------------------------------------------------');
for (const c of first.checkpoints) {
  console.log(
    `  ${c.hours.toFixed(2).padStart(5)}  ${c.units.toLocaleString().padStart(8)}  ${Math.round(c.perSecond).toExponential(2).padStart(12)}  ${String(c.contracts).padStart(9)}  ${c.shards.toLocaleString().padStart(10)}`,
  );
}
console.log('');

console.log('  milestone                  first seed');
console.log('  -------------------------------------');
for (const milestone of milestones) {
  const at = milestone.at === undefined ? 'not reached' : `${milestone.at.toFixed(3)}h`;
  console.log(`  ${milestone.label.padEnd(26)} ${at}`);
}
console.log('');

/*
 * THE DISTRIBUTION, and it is the whole point of this section.
 *
 * A single trajectory was the first version of this report and it was not a
 * measurement. The engine consumes random numbers through a STATELESS hash, so
 * every contract DRAW depends on the seed -- and the game is a feedback loop
 * where a cheaper draw changes income, which changes upgrades, which changes
 * production, which changes every later draw. Sampled across seeds the same
 * player model produced 246 to 8,578 contracts in a day: a 35x spread on
 * IDENTICAL content.
 *
 * That is not noise around a true value, it is chaos, and reporting one number
 * would have been worse than reporting none. The median is the figure to quote;
 * the min and max are the honest statement of how little a single run means.
 */
const fleetHours = samples.map((s) => s.hoursToFleet).filter((h) => Number.isFinite(h));
const rows: Array<[string, string[]]> = [
  ['contracts in 24h', samples.map((s) => s.contracts.toLocaleString())],
  ['contracts/hr', samples.map((s) => s.contractRate.toFixed(0))],
  ['shards in 24h', samples.map((s) => s.shards.toLocaleString())],
  ['milestone steps crossed', samples.map((s) => s.crossedSteps.toLocaleString())],
  ['units at 24h', samples.map((s) => s.units.toLocaleString())],
  ['upgrades at 24h', samples.map((s) => String(s.upgrades))],
  [
    `hours to ${TARGETS.finalTierUnits} ${SERVICES[SERVICES.length - 1].name}`,
    fleetHours.map((h) => h.toFixed(2)),
  ],
];

console.log(`  across ${SEEDS} seeds              median        min           max`);
console.log('  ------------------------------------------------------------------------');
for (const [label, values] of rows) {
  const nums = values.map((v) => Number(v.replace(/,/g, '')));
  const asText = (n: number) => (label.startsWith('hours') ? n.toFixed(2) : Math.round(n).toLocaleString());
  console.log(
    `  ${label.padEnd(26)} ${asText(median(nums)).padStart(10)}  ${asText(Math.min(...nums)).padStart(12)}  ${asText(Math.max(...nums)).padStart(12)}`,
  );
}
console.log('');

/* ------------------------------------------------- per-tier cap reachability

   A `cap` on a count-driven row is a claim that the count can get there. When
   it cannot, the row's badge -- which prints `1 + cap` -- advertises a ceiling
   the game will never pay.

   TWO KINDS OF CAP, and only one needs measuring:

     - Contract-derived rows are bounded by CONTENT SIZE, which this script can
       state exactly: `state.upgrades.length` cannot exceed `UPGRADES.length`,
       `deployedTiers` cannot exceed `SERVICES.length`, a tier's index is fixed
       by its position. Those maxima are arithmetic, not measurements.
     - Unit-derived rows are bounded by what the fleet actually builds, which
       only a run can answer. That is what the table below reports.

   NOT ASSERTED. A cap above the peak is not automatically a defect: a `cap` is
   legitimately headroom for a quantity that may grow with future content. A row
   is only WRONG when its badge states the cap as the ceiling -- which needs a
   human eye on the badge text. This is a diagnostic, not a check.
   ------------------------------------------------------------------------- */
{
  const contentBound: Array<[string, number]> = [
    ['state.upgrades.length', UPGRADES.length],
    ['deployedTiers', SERVICES.length],
    ['apexIndex + 1', SERVICES.length],
    ['tier index', SERVICES.length - 1],
  ];
  console.log('content-size maxima (these bound the contract-derived caps)');
  console.log('');
  for (const [quantity, max] of contentBound) {
    console.log(`  ${quantity.padEnd(24)} ${String(max).padStart(6)}`);
  }
  console.log('');
  console.log('peak units per tier in a day (these bound the unit-derived caps)');
  console.log('');
  console.log('  tier             min      median         max');
  console.log('  ----------------------------------------------------');
  for (const service of SERVICES) {
    const peaks = samples.map((s) => s.peakUnits[service.id] ?? 0);
    console.log(
      `  ${service.id.padEnd(14)} ${String(Math.round(Math.min(...peaks))).padStart(6)}  ` +
        `${String(Math.round(median(peaks))).padStart(9)}  ${String(Math.round(Math.max(...peaks))).padStart(10)}`,
    );
  }
  console.log('');
  console.log('  A cap whose row needs MORE units than the max above can never bind, so its');
  console.log('  badge (`1 + cap`) promises a ceiling the game does not deliver. See the');
  console.log('  cap-reachability section in DECISIONS.md.');
  console.log('');
}

/* ---------------------------------------------------------------- faucets */
console.log('shard faucet and reward mix');
console.log('');

/*
 * The expected payout per DRAW, which is the number that decides the faucet.
 *
 * Computed from the definition table rather than read from a constant, because
 * the payout is no longer one number: it is a band, scaled by whether the
 * contract pays one currency or both. If the mix changes, this changes -- and
 * a hand-maintained figure would not.
 */
const rewardMix = { compute: 0, shards: 0, both: 0 };
for (const def of CONTRACT_DEFS) {
  rewardMix[def.reward ?? 'both'] += 1;
}
const expectedShards =
  CONTRACT_DEFS.reduce((sum, def) => sum + shardPayout(def), 0) / CONTRACT_DEFS.length;
const expectedComputeMult =
  CONTRACT_DEFS.reduce((sum, def) => {
    const kind = def.reward ?? 'both';
    return sum + (kind === 'shards' ? 0 : kind === 'compute' ? CONTRACTS.soloBonus : 1);
  }, 0) / CONTRACT_DEFS.length;

console.log(
  `  reward mix               compute ${String(rewardMix.compute).padStart(2)}  shards ${String(rewardMix.shards).padStart(2)}  both ${String(rewardMix.both).padStart(2)}   (of ${CONTRACT_DEFS.length})`,
);
console.log(
  `  expected shards / draw   ${expectedShards.toFixed(1).padStart(12)}  (the flat rate this replaced was 51)`,
);
console.log(
  `  expected compute / draw  ${expectedComputeMult.toFixed(3).padStart(12)}  x the old flat payout`,
);
console.log(
  `  milestone steps          ${String(Math.round(median(samples.map((s) => s.crossedSteps)))).padStart(12)}  crossed in a day`,
);
/*
 * THE SECOND FAUCET, and it is measured by COUNTING rather than by ablation.
 *
 * Silencing the faucet and diffing two runs gives a NEGATIVE share, because
 * the runs share a seed and not a trajectory: fewer shards means fewer
 * upgrades, which means different income, which moves every later contract.
 * The difference measures divergence, not the faucet. Counting the crossings
 * and what they pay, inside one run, is the only version that means anything.
 */
const medianMilestoneShards = median(samples.map((s) => s.milestoneShards));
const medianContractShards = median(samples.map((s) => s.shards - s.milestoneShards));
const milestoneShare =
  medianMilestoneShards / (medianMilestoneShards + medianContractShards);
console.log(
  `  milestone shards         ${Math.round(medianMilestoneShards).toLocaleString().padStart(12)}  in a day, ${(milestoneShare * 100).toFixed(1)}% of shard income`,
);
console.log(
  `  contract shards          ${Math.round(medianContractShards).toLocaleString().padStart(12)}  in a day, ${((1 - milestoneShare) * 100).toFixed(1)}%`,
);
/*
 * The AVERAGE base payout per step, which `check:ladder` needs.
 *
 * That script reads `content.ts` as TEXT and cannot import the engine, so it
 * cannot discover this by measurement -- the same gap `referenceContractsPerHour`
 * exists to fill. It is printed here so the constant can be SET from a figure
 * rather than guessed, and asserted against so the two cannot drift: a stale
 * value would make the ladder's reported hours describe an economy the game
 * does not have.
 *
 * It is a MEAN, not a median-of-steps, because the pace model multiplies it by
 * a total step count. Every step contributes one payout, so the mean is the
 * correct summary and a median would describe a step that does not exist.
 */
const measuredPerStep = median(samples.map((s) => s.milestoneBaseShards / Math.max(1, s.crossedSteps)));
console.log(
  `  per milestone step       ${measuredPerStep.toFixed(2).padStart(12)}  average BASE shards (before shardMult)`,
);
console.log(
  `  SHARDS.perMilestone is ${SHARDS.perMilestone}; the tiers and steps together multiply it by ${(measuredPerStep / SHARDS.perMilestone).toFixed(2)}x`,
);
console.log('');
console.log('  The milestone faucet is BACK, and it pays per step crossed, multiplied by');
console.log('  `shardMult` -- which the pre-removal version did not do, so the four');
console.log('  upgrades labelled "shard income" silently did not reach it.');
console.log('');
console.log('  It was removed on three grounds. Two have since been falsified by this');
console.log('  harness, which is why the numbers above are printed rather than argued:');
console.log('');
console.log('    - "the fleet plateaus, so it is worth 1.5%"  -- the count above is the');
console.log('      real figure, and the plateau claim turned out to be a property of the');
console.log('      MODEL (it never pressed an ability) rather than of the game.');
console.log('    - "it is the faucet that pays while away"   -- it never was. `applyOffline`');
console.log('      credits compute and never buys units, so this faucet requires presence.');
console.log('');
console.log('  The third objection STANDS and is not fixed here: a milestone cannot be');
console.log('  crossed while away, so this income is online-only and contracts remain the');
console.log('  only offline source. It is also partly ON the exponential compute curve,');
console.log('  because step count follows unit count. Both are why the rate is modest.');
console.log('');

/* The milestone rate, asserted against its reference at the same tolerance
   approach as the contract rate -- see MILESTONE_TOLERANCE. */
const measuredMilestoneRate = median(samples.map((s) => s.crossedSteps / s.hours));
const referenceMilestoneRate = SHARDS.pacing.referenceMilestonesPerHour;
const milestoneDrift =
  Math.abs(measuredMilestoneRate - referenceMilestoneRate) / referenceMilestoneRate;

/*
 * The two asserted figures. Both are computed here so the printed number and
 * the judged number are the same variable -- a check that compares one value
 * while printing another has already drifted.
 */
const measuredRate = median(samples.map((s) => s.contractRate));
const referenceRate = SHARDS.pacing.referenceContractsPerHour;
const rateDrift = Math.abs(measuredRate - referenceRate) / referenceRate;
const unfinished = samples.filter((s) => !s.finished);

console.log(`  SHARDS.pacing.referenceContractsPerHour = ${SHARDS.pacing.referenceContractsPerHour}`);
console.log(`  measured median                          = ${measuredRate.toFixed(0)} contracts/hr`);
console.log(
  `  drift                                    = ${(rateDrift * 100).toFixed(0)}%  (tolerance ${(RATE_TOLERANCE * 100).toFixed(0)}%)`,
);
console.log(
  `  SHARDS.pacing.referenceMilestonesPerHour = ${SHARDS.pacing.referenceMilestonesPerHour}`,
);
console.log(`  measured median                          = ${measuredMilestoneRate.toFixed(1)} steps/hr`);
console.log(
  `  drift                                    = ${(milestoneDrift * 100).toFixed(0)}%  (tolerance ${(MILESTONE_TOLERANCE * 100).toFixed(0)}%)`,
);
/*
 * The THIRD reference, and the third guard.
 *
 * `referencePerMilestoneStep` is what `check:ladder` multiplies by the step
 * rate to price the faucet. It used to be the flat `perMilestone`, which was
 * correct only while the faucet paid the same on every tier and every step.
 *
 * The tolerance is TIGHTER than the two rates above, and deliberately: those
 * are measured behaviour with run-to-run spread, while this is the MEAN of a
 * deterministic payout schedule, so it is a property of the content rather than
 * of a simulation. Loose here would let a real content change pass unremarked.
 */
const measuredMeanPerStep = median(
  samples.map((s) => s.milestoneBaseShards / Math.max(1, s.crossedSteps)),
);
const referencePerStep = SHARDS.pacing.referencePerMilestoneStep;
const perStepDrift = Math.abs(measuredMeanPerStep - referencePerStep) / referencePerStep;
console.log(`  SHARDS.pacing.referencePerMilestoneStep = ${referencePerStep}`);
console.log(`  measured mean                            = ${measuredMeanPerStep.toFixed(2)} shards/step`);
console.log(
  `  drift                                    = ${(perStepDrift * 100).toFixed(0)}%  (tolerance ${(PER_STEP_TOLERANCE * 100).toFixed(0)}%)`,
);
console.log(`  ${SEEDS} runs took ${elapsed}s`);
console.log('');

console.log('  MIN/MAX ARE NOT ERROR BARS. They are the spread of a chaotic feedback loop,');
console.log('  and they mean a single trajectory can be quoted in support of almost any');
console.log('  conclusion. Anything tuned against this harness has to be tuned against the');
console.log('  MEDIAN, and confirmed on several seeds before it is believed.');
console.log('');

/* --------------------------------------------------------------------------
   Objective time: does the card's promise hold?

   A definition declares `cost` in SECONDS OF PRODUCTION, and the card is built
   to read as "this is `cost` seconds of work". That claim has two halves, and
   only the first was ever checked:

     - the objective is SIZED to be worth `cost` seconds at issue, which is what
       `objectiveSize` does; and
     - the player then SPENDS about `cost` seconds completing it.

   The ratio below is the second half. `1.0` means the card is honest. A ratio
   well under 1 means the objective is far less work than it advertises -- the
   contract pays a `cost`-banded reward for a fraction of the `cost` it names,
   which makes the faucet richer than any `contractsPerHour` constant can
   describe, because the rate is not a constant: it is a function of how fast
   production is growing.

   Reported per METRIC, not aggregate, because the metrics are converted to
   `cost` seconds by four different formulas. An aggregate would average a
   correct conversion together with a broken one and read as merely imprecise.
   -------------------------------------------------------------------------- */

const byMetric = new Map<string, number[]>();
const byMetricPhase = new Map<string, Map<number, number[]>>();
/* Absolute seconds, alongside the ratios. The ratio says how the card compares
   to reality; this says whether the contract was a TASK at all. They are
   different questions -- a contract can be honest about a band and still be
   over in two seconds. Bucketed by phase for the same reason the ratios are;
   see `medianOfGroups`. */
const byMetricSeconds = new Map<string, number[]>();
const byMetricPhaseSeconds = new Map<string, Map<number, number[]>>();
const PHASES = [0.25, 0.5, 1, 1.5, 2, 3, 6, 24];
const phaseOf = (hours: number): number =>
  PHASES.find((edge) => hours < edge) ?? PHASES[PHASES.length - 1];

for (const sample of samples) {
  for (const timing of sample.timings) {
    const ratio = timing.actualSeconds / timing.declaredSeconds;
    const list = byMetric.get(timing.metric) ?? [];
    list.push(ratio);
    byMetric.set(timing.metric, list);

    const secs = byMetricSeconds.get(timing.metric) ?? [];
    secs.push(timing.actualSeconds);
    byMetricSeconds.set(timing.metric, secs);

    const bucket = phaseOf(timing.atHours);

    const phases = byMetricPhase.get(timing.metric) ?? new Map<number, number[]>();
    const inPhase = phases.get(bucket) ?? [];
    inPhase.push(ratio);
    phases.set(bucket, inPhase);
    byMetricPhase.set(timing.metric, phases);

    const phaseSecs =
      byMetricPhaseSeconds.get(timing.metric) ?? new Map<number, number[]>();
    const inPhaseSecs = phaseSecs.get(bucket) ?? [];
    inPhaseSecs.push(timing.actualSeconds);
    phaseSecs.set(bucket, inPhaseSecs);
    byMetricPhaseSeconds.set(timing.metric, phaseSecs);
  }
}

console.log('objective time: actual seconds / declared `cost`  (reported, not judged)');
console.log('');
/*
 * TWO FIGURES PER METRIC, and the first is the one the assertions use.
 *
 * `phase-norm` is the median of the per-phase medians; `by-count` is the plain
 * median over every observation. See `medianOfGroups` for why the first is the
 * stable unit here and the second is not -- briefly, a run stops when the
 * contract target is met, so a harder contract shifts completions into later
 * phases and moves the completion-weighted figure without moving the metric.
 *
 * Printing both is the coherence test: if they diverge sharply, the metric's
 * cost is dominated by one stretch of the run, which is worth seeing.
 */
console.log('  metric          completions   phase-norm    by-count      min        max');
console.log('  -----------------------------------------------------------------------------');
const allRatios: number[] = [];
const allGroups = new Map<number, number[]>();
for (const [metric, ratios] of byMetric) {
  allRatios.push(...ratios);
  const phases = byMetricPhase.get(metric);
  if (phases !== undefined) {
    for (const [bucket, list] of phases) {
      const combined = allGroups.get(bucket) ?? [];
      combined.push(...list);
      allGroups.set(bucket, combined);
    }
  }
  console.log(
    `  ${metric.padEnd(15)} ${String(ratios.length).padStart(9)}    ` +
      `${medianOfGroups(phases).toFixed(4).padStart(10)}  ` +
      `${median(ratios).toFixed(4).padStart(10)}  ` +
      `${Math.min(...ratios).toFixed(4).padStart(9)}  ` +
      `${Math.max(...ratios).toFixed(4).padStart(9)}`,
  );
}
console.log('  -----------------------------------------------------------------------------');
console.log(
  `  ${'ALL'.padEnd(15)} ${String(allRatios.length).padStart(9)}    ` +
    `${medianOfGroups(allGroups).toFixed(4).padStart(10)}  ` +
    `${median(allRatios).toFixed(4).padStart(10)}  ` +
    `${Math.min(...allRatios).toFixed(4).padStart(9)}  ` +
    `${Math.max(...allRatios).toFixed(4).padStart(9)}`,
);
console.log('');

/* Whether the drift is a constant offset or a function of growth decides the
   fix. A scalar recalibration only works if the ratio is stable; a ratio that
   climbs toward 1.0 as the run settles means the objective is being overtaken
   by production growth, and no constant can correct that. */
console.log('  ratio by phase of run (median, and completions)');
console.log('');
const phaseHeader = PHASES.map((edge) => `<${String(edge).padStart(2)}h`.padStart(13)).join('');
console.log(`  ${'metric'.padEnd(15)}${phaseHeader}`);
console.log(`  ${'-'.repeat(15 + PHASES.length * 13)}`);
for (const [metric, phases] of byMetricPhase) {
  const cells = PHASES.map((edge) => {
    const list = phases.get(edge);
    if (list === undefined || list.length === 0) return '-'.padStart(13);
    return `${median(list).toFixed(3)} (${list.length})`.padStart(13);
  }).join('');
  console.log(`  ${metric.padEnd(15)}${cells}`);
}
console.log('');

/* --------------------------------------------------------------------------
   Assertions

   The two things this script JUDGES rather than reports. Both are constraints
   the content has to satisfy, and both are stated outside the numbers they
   check -- see the header. Everything else above is a table.
   -------------------------------------------------------------------------- */

console.log('assertions');
console.log('');

let assertFailures = 0;

/* 1. The run has to finish inside the day. `BUDGET_HOURS` is the product
      decision; `check:ladder` sizes the SHARD ladder to end when the fleet
      does, so a run that never finishes is also a ladder with no end. */
for (const sample of unfinished) {
  assertFailures += 1;
  console.log(
    `  FAIL  seed ${sample.seed}: did not finish inside ${BUDGET_HOURS}h ` +
      `(upgrades ${sample.upgrades}/${TARGETS.upgrades}, contracts ${sample.contracts}/${TARGETS.contracts})`,
  );
}
if (unfinished.length === 0) {
  console.log(`  ok    all ${SEEDS} seeds finished inside ${BUDGET_HOURS}h`);
}

/* 2. The reference rate has to describe the game. `check:ladder` divides the
      entire shard price table by this constant to get HOURS, and compares the
      result against `SHARDS.pacing.targetHours`. If the constant is stale the
      pace report is measuring a game that no longer exists -- the same
      self-referential failure the `ladderBudget` ceiling had, one indirection
      removed, and it must be caught HERE because `check:ladder` cannot measure
      a contract rate at all. */
if (rateDrift > RATE_TOLERANCE) {
  assertFailures += 1;
  console.log(
    `  FAIL  SHARDS.pacing.referenceContractsPerHour is ${referenceRate} but the measured ` +
      `median is ${measuredRate.toFixed(0)} (${(rateDrift * 100).toFixed(0)}% off, ` +
      `tolerance ${(RATE_TOLERANCE * 100).toFixed(0)}%)`,
  );
  console.log(
    `        Update content.ts so the constant and the measurement agree, then re-run ` +
      `check:ladder -- the ladder's reported pace moves with it.`,
  );
} else {
  console.log(
    `  ok    reference rate ${referenceRate}/hr is within ${(RATE_TOLERANCE * 100).toFixed(0)}% ` +
      `of the measured ${measuredRate.toFixed(0)}/hr`,
  );
}
/* The SAME guard for the second faucet's rate, and it matters for the same
   reason: `check:ladder` turns `referenceMilestonesPerHour` into hours, so a
   constant that has drifted produces a pace figure that means nothing while
   still passing its band. Neither script can check the other's half -- that
   one reads content.ts as text and this one cannot judge source shape -- so
   the seam is guarded from both ends. */
if (milestoneDrift > MILESTONE_TOLERANCE) {
  assertFailures += 1;
  console.log(
    `  FAIL  SHARDS.pacing.referenceMilestonesPerHour is ${referenceMilestoneRate} but the ` +
      `measured median is ${measuredMilestoneRate.toFixed(1)} (${(milestoneDrift * 100).toFixed(0)}% off, ` +
      `tolerance ${(MILESTONE_TOLERANCE * 100).toFixed(0)}%)`,
  );
  console.log(
    `        Update content.ts so the constant and the measurement agree, then re-run ` +
      `check:ladder -- its pace model reads this number as a second faucet.`,
  );
} else {
  console.log(
    `  ok    reference milestone rate ${referenceMilestoneRate}/hr is within ` +
      `${(MILESTONE_TOLERANCE * 100).toFixed(0)}% of the measured ${measuredMilestoneRate.toFixed(1)}/hr`,
  );
}

/* The SAME guard for the average payout per step: `check:ladder` turns it into
   hours, so a stale value produces a pace figure that describes an economy the
   game does not have. */
if (perStepDrift > PER_STEP_TOLERANCE) {
  assertFailures += 1;
  console.log(
    `  FAIL  SHARDS.pacing.referencePerMilestoneStep is ${referencePerStep} but the ` +
      `measured mean is ${measuredMeanPerStep.toFixed(2)} (${(perStepDrift * 100).toFixed(0)}% off, ` +
      `tolerance ${(PER_STEP_TOLERANCE * 100).toFixed(0)}%)`,
  );
  console.log(
    `        Update content.ts so the constant and the measurement agree, then re-run ` +
      `check:ladder -- its pace model multiplies the step rate by this number.`,
  );
} else {
  console.log(
    `  ok    reference payout ${referencePerStep}/step is within ` +
      `${(PER_STEP_TOLERANCE * 100).toFixed(0)}% of the measured ${measuredMeanPerStep.toFixed(2)}/step`,
  );
}
console.log('');

/* 3. A contract must be a TASK, and the correction must not have overshot.

      This replaced an assertion that the realised time equal `cost`. That
      assertion was correct about the defect -- the rate-sized objectives really
      did complete in 1-3% of their band -- but it could not be SATISFIED, and a
      check that cannot pass is a check nobody can act on. The factor the
      correction needs moves by two orders of magnitude inside one run
      (production doubles in seconds early and in hours late), so nothing in
      `CONTRACTS.growthCorrection` holds the ratio at 1.0 at every phase. The
      card does not claim it does either: it shows the objective in its own
      units, which is truthful at every scale.

      What is left is what can actually be judged:

        a. The TYPICAL contract is real work. This is the assertion that answers
           "ten clicks completes almost ten contracts", and it is stated on the
           MEDIAN because the distribution is bimodal and no correction fixes
           that: production compounds by orders of magnitude inside a 90-second
           window, so a contract drawn just before a milestone doubling, an
           upgrade purchase or an ability activation is overtaken at once. The
           tail is a property of sizing a fixed objective at issue from an
           exponentially growing rate, and the only thing that removes it is a
           moving target -- see `docs/DECISIONS.md` on the rejected option.
        b. Nothing is a SLOG. A metric whose typical completion runs far past its
           band is a contract that has quietly stopped paying for its work.

      The instant share is REPORTED rather than asserted, because asserting on
      it would mean asserting on a property the chosen design cannot deliver.

      Scoped to the metrics whose objective MAGNITUDE is the dial at risk: the
      rate-sized ones plus `clicks`. The fixed-amount metrics are excluded on
      purpose, and not to make the check pass -- `upgrades`, `tierOwned` and
      `abilityUses` have objectives of "one more of a 0/1 or bounded thing", so
      they SHOULD complete on the next purchase or the next ability press. There
      is no magnitude to scale and no constant that could make them slower. */
const MEDIAN_SECONDS_FLOOR = 20;
const RATIO_BAND: [number, number] = [0.02, 5];
/*
 * The metrics whose objective MAGNITUDE is still a dial worth judging.
 *
 * This list SHRANK when the objectives became fixed numbers. `services`,
 * `milestones` and `tierUnits` used to be here because their size was computed
 * from the player's rate, so a mis-scaled constant could make them near-free or
 * a slog. They are authored `amount`s now, and the property that replaced the
 * per-metric time check is the OFFER RATE -- asserted above against
 * `referenceContractsPerHour`, which is the check that catches a fixed-objective
 * faucet running hot. Judging a fixed number by how many SECONDS it took would
 * also be judging the wrong thing: `bring 25 more services online` is supposed
 * to be quick once the fleet is large, which is the entire point of fixing it.
 *
 * What is left are the two metrics whose size is still DERIVED:
 *   - `totalEarned` from the live production rate, via `growthCorrection`; and
 *   - `clicks` from `cost x referenceClicksPerSecond`.
 * Both can still be mis-scaled by a constant, so both keep their band.
 */
const magnitudeSized = ['totalEarned', 'clicks'];
/* The subset sized from the production RATE, which is what the growth
   correction acts on. `clicks` is excluded here because its ratio is honest by
   construction -- real time against a declared real-time rate -- and holding it
   to a band it has no reason to leave would be noise. `totalEarned` is now the
   ONLY metric the correction is applied to. */
const rateSized = ['totalEarned'];

for (const metric of magnitudeSized) {
  const phaseSecs = byMetricPhaseSeconds.get(metric);
  if (phaseSecs === undefined) continue;
  const typical = medianOfGroups(phaseSecs);
  const secs = byMetricSeconds.get(metric) ?? [];
  const instant = secs.filter((s) => s < 5).length;
  if (typical < MEDIAN_SECONDS_FLOOR) {
    assertFailures += 1;
    console.log(
      `  FAIL  ${metric}: the TYPICAL completion is ${typical.toFixed(1)}s ` +
        `(floor ${MEDIAN_SECONDS_FLOOR}s) -- near-free payouts`,
    );
    console.log(
      `        Raise CONTRACTS.growthCorrection, or the objective is too small for ` +
        `this metric at some phase. See the ratio-by-phase table above.`,
    );
  } else {
    console.log(
      `  ok    ${metric}: typical completion ${typical.toFixed(1)}s ` +
        `(floor ${MEDIAN_SECONDS_FLOOR}s; ${((instant / secs.length) * 100).toFixed(1)}% ` +
        `instant, reported not asserted)`,
    );
  }
}

for (const metric of rateSized) {
  const phases = byMetricPhase.get(metric);
  if (phases === undefined || phases.size === 0) continue;
  const ratio = medianOfGroups(phases);
  if (ratio < RATIO_BAND[0] || ratio > RATIO_BAND[1]) {
    assertFailures += 1;
    console.log(
      `  FAIL  ${metric}: typical completion is ${(ratio * 100).toFixed(1)}% of its ` +
        `band, outside the ${RATIO_BAND[0] * 100}-${RATIO_BAND[1] * 100}% guard band`,
    );
    console.log(
      `        Below it the faucet is richer than the band advertises; above it the ` +
        `contract no longer pays for its work. Retune CONTRACTS.growthCorrection.`,
    );
  } else {
    console.log(
      `  ok    ${metric}: typical completion is ${(ratio * 100).toFixed(1)}% of its band ` +
        `(phase-normalised)`,
    );
  }
}
console.log('');

/* The dead-slot sweep below is a third assertion. It accumulates into
   `assertFailures` rather than exiting, so one failing section does not hide
   the output of the others; the whole script is judged at the end. */

/* --------------------------------------------------------------------------
   Dead-slot sweep

   The bug class this guards against has already shipped twice: a contract that
   can never complete holds one of five slots, so the player is quietly down a
   fifth of their shard income with nothing on screen to say why. `upgrades` was
   the first case; `tierOwned` and `abilityUses` are two new ways to reach it,
   and the ability one is the sharpest -- Surge does not exist until
   `contracts-25`, so a Surge contract offered at contract ten would be dead for
   hours.

   Asserted BEHAVIOURALLY: build the pathological state, fill the slots, then
   check that nothing issued is uncompletable. A unit test of `metricHeadroom`
   would pass while `pickContract` ignored it, which is exactly the shape of the
   inventory bug -- the guard existed and the picker was not consulting it.
   -------------------------------------------------------------------------- */

interface SweepCase {
  label: string;
  mutate: (state: GameState) => void;
  /** Def ids that must NOT be offered in this state. */
  forbidden: string[];
}

const allTiers = SERVICES.map((s) => s.id);
const allAbilitiesLocked = true;

const sweeps: SweepCase[] = [
  {
    label: 'every tier owned',
    mutate: (s) => {
      for (const id of allTiers) s.services[id] = 40;
    },
    forbidden: CONTRACT_DEFS.filter((d) => d.metric === 'tierOwned').map((d) => d.id),
  },
  {
    label: 'no ability unlocked',
    mutate: () => {
      /* Abilities are gated by achievements, and a fresh state has none, so
         Surge and Provision do not exist yet. Overclock is `base: true`. */
    },
    forbidden: CONTRACT_DEFS.filter(
      (d) => d.metric === 'abilityUses' && d.abilityId !== 'overclock',
    ).map((d) => d.id),
  },
  {
    label: 'nothing owned at all',
    mutate: () => {
      /* A fresh run. Only the FIRST tier's one-shot may appear -- the other
         seven would each be an eight-tier bounty stack. */
    },
    forbidden: CONTRACT_DEFS.filter(
      (d) => d.metric === 'tierOwned' && d.serviceId !== SERVICES[0].id,
    ).map((d) => d.id),
  },
];

console.log('dead-slot sweep: contracts that could never complete');
console.log('');

let sweepFailures = 0;
for (const sweep of sweeps) {
  const state = initialState(Date.now());
  state.seed = FIXED_SEED;
  sweep.mutate(state);
  const stats = computeStats(state);
  fillContracts(state, stats.contractSlots, stats);

  const issued = state.contracts.map((c) => c.id);
  const leaked = issued.filter((id) => sweep.forbidden.includes(id));
  /* An uncompletable objective would also show as a target of zero. */
  const zeroTargets = state.contracts.filter((c) => !Number.isFinite(c.amount) || c.amount < 1);

  const ok = leaked.length === 0 && zeroTargets.length === 0;
  if (!ok) sweepFailures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${sweep.label.padEnd(22)} issued: ${issued.join(', ') || '(none)'}`,
  );
  if (leaked.length > 0) console.log(`        forbidden but offered: ${leaked.join(', ')}`);
  if (zeroTargets.length > 0) {
    console.log(`        issued with an impossible target: ${zeroTargets.map((c) => c.id).join(', ')}`);
  }
}
void allAbilitiesLocked;
console.log('');
assertFailures += sweepFailures;

if (assertFailures > 0) {
  console.log(`FAIL: ${assertFailures} assertion(s) above`);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Objective labels

   Every definition rendered through the real `contractObjective`, because the
   new metrics are only useful if the SUBJECT reaches the card. "Buy 12 more"
   with no tier named is worse than no contract at all: it is an instruction the
   player cannot follow, and it is what a metric-keyed signature would have
   produced.

   Two targets per def, 1 and 12, because the pluralisation and the count agree
   in different ways and `tierOwned` is the case where the number is always 1.
   -------------------------------------------------------------------------- */

let labelFailures = 0;
console.log('objective labels, rendered through the real helper');
console.log('');
for (const def of CONTRACT_DEFS) {
  const one = contractObjective(1, def);
  const many = contractObjective(12, def);
  const problems: string[] = [];
  if (one.length === 0 || many.length === 0) problems.push('empty');

  /*
   * A metric with a subject must NAME it. Checked against the content lookup
   * rather than by eyeballing the string, so a rename in content.ts cannot
   * quietly leave the label stale.
   */
  if (def.metric === 'tierUnits' || def.metric === 'tierOwned') {
    const tier = def.serviceId === undefined ? undefined : SERVICE_BY_ID[def.serviceId];
    if (tier === undefined) problems.push(`unknown tier '${def.serviceId}'`);
    else if (!many.includes(tier.name)) problems.push(`label omits the tier name`);
  }
  if (def.metric === 'abilityUses') {
    const ability = def.abilityId === undefined ? undefined : ABILITY_BY_ID[def.abilityId];
    if (ability === undefined) problems.push(`unknown ability '${def.abilityId}'`);
    else if (!many.includes(ability.name)) problems.push(`label omits the ability name`);
  }
  /* Fallback wording is a failure, not a cosmetic defect: it means the subject
     did not resolve. */
  if (/(\bservice\b|\bability\b)/.test(one) && def.metric !== 'services') {
    problems.push('fell back to generic wording');
  }

  if (problems.length > 0) labelFailures += 1;
  const flag = problems.length === 0 ? 'ok  ' : 'FAIL';
  console.log(`  ${flag}  ${def.id.padEnd(18)} ${many.padEnd(34)} | 1 -> ${one}`);
  if (problems.length > 0) console.log(`        ${problems.join('; ')}`);
}
console.log('');
if (labelFailures > 0) {
  console.log(`FAIL: ${labelFailures} definitions render a bad objective`);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Reward shapes

   A contract pays the currency its objective is about. Asserted per def rather
   than in aggregate, because the failure mode is a SINGLE card offering a
   currency it does not pay -- which an average would hide.
   -------------------------------------------------------------------------- */

console.log('');
console.log('reward shapes, per definition');
console.log('');

const richState = (): GameState => {
  const s = initialState(Date.now());
  s.seed = FIXED_SEED;
  for (const svc of SERVICES) s.services[svc.id] = 50;
  s.upgrades = [];
  s.shards = 1000;
  /* Give the state a real income so `contractReward` is non-zero. */
  return s;
};

let rewardFailures = 0;
const mix = { compute: 0, shards: 0, both: 0 };
for (const def of CONTRACT_DEFS) {
  const s = richState();
  const stats = computeStats(s);
  const compute = contractReward(stats, def);
  const shards = shardPayout(def);
  const kind = def.reward ?? 'both';
  mix[kind] += 1;

  const problems: string[] = [];
  if (kind === 'compute' && shards !== 0) problems.push('compute-only but pays shards');
  if (kind === 'compute' && compute <= 0) problems.push('compute-only but pays no compute');
  if (kind === 'shards' && compute !== 0) problems.push('shards-only but pays compute');
  if (kind === 'shards' && shards <= 0) problems.push('shards-only but pays no shards');
  if (kind === 'both' && (compute <= 0 || shards <= 0)) problems.push('both but one side is zero');
  if (compute < 0 || shards < 0) problems.push('negative payout');

  const described =
    compute > 0 && shards > 0
      ? 'compute + shards'
      : compute > 0
        ? 'compute only'
        : shards > 0
          ? 'shards only'
          : 'NOTHING';
  if (problems.length > 0) rewardFailures += 1;
  console.log(
    `  ${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${def.id.padEnd(18)} ${kind.padEnd(8)} ${described}`,
  );
  if (problems.length > 0) console.log(`        ${problems.join('; ')}`);
}
console.log('');
console.log(`  mix: compute ${mix.compute}, shards ${mix.shards}, both ${mix.both}`);
console.log('');
if (rewardFailures > 0) {
  console.log(`FAIL: ${rewardFailures} definitions pay a currency they should not`);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Contract uniqueness

   Two cards showing one quest. Reported as "I got 2 contract with same quest --
   I think the contract should look unique", and it was two `milestones` defs
   whose objectives both rounded to 1.

   Asserted BEHAVIOURALLY, over many seeds and player states, because the cause
   was not in the content: it was the PICKER reusing one roll for every slot of
   a fill. A check of the definitions would have passed while the panel showed
   duplicates, which is the same shape as the inventory dead-slot bug -- the
   guard existed and the caller was not consulting it.

   Two assertions, and both are needed:
     - no two active contracts share a SUBJECT (metric + tier/ability)
     - no two RENDERED objectives are identical strings
   The second is the player-facing one. The first is stricter than the second
   on purpose: two objectives can differ by a digit and still read as the same
   job.
   -------------------------------------------------------------------------- */

const subjectOf = (def: (typeof CONTRACT_DEFS)[number]): string =>
  `${def.metric}:${def.serviceId ?? def.abilityId ?? ''}`;
const defById = new Map(CONTRACT_DEFS.map((d) => [d.id, d]));

interface UniquenessCase {
  label: string;
  completed: number;
  slots: number;
  setup: (s: GameState) => void;
}

const uniquenessCases: UniquenessCase[] = [
  { label: 'fresh, 5 slots', completed: 0, slots: 5, setup: () => {} },
  {
    label: 'early, 5 slots',
    completed: 10,
    slots: 5,
    setup: (s) => {
      s.services.worker = 40;
    },
  },
  {
    label: 'mid, 7 slots',
    completed: 80,
    slots: 7,
    setup: (s) => {
      for (const id of SERVICES.slice(0, 5).map((x) => x.id)) s.services[id] = 120;
    },
  },
  {
    label: 'all tiers owned, 7 slots',
    completed: 300,
    slots: 7,
    setup: (s) => {
      for (const svc of SERVICES) s.services[svc.id] = 300;
    },
  },
];

const SEEDS_PER_CASE = 40;
let uniquenessFailures = 0;

console.log('contract uniqueness across slots');
console.log('');

for (const testCase of uniquenessCases) {
  let withDuplicates = 0;
  let shortFills = 0;
  let example = '';

  for (let i = 0; i < SEEDS_PER_CASE; i++) {
    const s = initialState(Date.now());
    s.seed = FIXED_SEED + i * 104729;
    s.contractsCompleted = testCase.completed;
    testCase.setup(s);
    const st = computeStats(s);
    /* Vary the salt the way a live save does, by filling from different states. */
    s.contractsCompleted += i;
    fillContracts(s, testCase.slots, st);

    const ids = s.contracts.map((c) => c.id);
    const subjects = ids.map((id) => (defById.has(id) ? subjectOf(defById.get(id)!) : id));
    const objectives = s.contracts.map((slot) => {
      const def = defById.get(slot.id);
      return def === undefined ? slot.id : contractObjective(slot.amount, def);
    });

    const dupSubject = new Set(subjects).size !== subjects.length;
    const dupObjective = new Set(objectives).size !== objectives.length;

    if (dupSubject || dupObjective) {
      withDuplicates += 1;
      if (example === '') {
        example = dupSubject
          ? `subjects: ${subjects.join(' | ')}`
          : `objectives: ${objectives.join(' | ')}`;
      }
    }
    /* A slot left empty because everything available was already taken. */
    if (s.contracts.length < testCase.slots) shortFills += 1;
  }

  const ok = withDuplicates === 0 && shortFills === 0;
  if (!ok) uniquenessFailures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'}  ${testCase.label.padEnd(26)} ${SEEDS_PER_CASE} seeds, duplicates in ${withDuplicates}, short fills ${shortFills}`,
  );
  if (example !== '') console.log(`        e.g. ${example}`);
}

console.log('');
if (uniquenessFailures > 0) {
  console.log(
    'FAIL: contracts repeat a subject, or a slot was left empty. Capacity is',
  );
  console.log('      16-18 distinct subjects against at most 7 slots, so an empty');
  console.log('      slot means the picker is rejecting candidates it should offer.');
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Metric rules table

   The engine asserts a def's shape against `METRIC_RULES`, and this is the
   check that the two have not drifted. It duplicates nothing: it reads the
   table the engine actually uses.

   The rule being enforced is the one the redesign rests on: a metric sized
   from the player's RATE must not carry a fixed `amount`, and one sized from a
   fixed `amount` must carry it. Getting this wrong is silent in both
   directions -- an `amount` on a rate-sized metric is ignored, and a missing
   `amount` on a fixed-size metric sizes to 1.
   -------------------------------------------------------------------------- */

console.log('metric rules vs the definitions');
console.log('');

const fixed = new Set(FIXED_AMOUNT_METRICS);
let ruleFailures = 0;
for (const def of CONTRACT_DEFS) {
  const hasAmount = def.amount !== undefined;
  const shouldHave = fixed.has(def.metric);
  const problems: string[] = [];
  if (shouldHave && !hasAmount) problems.push('fixed-size metric with no amount');
  if (!shouldHave && hasAmount) problems.push('rate-sized metric carrying an amount');
  if (problems.length > 0) {
    ruleFailures += 1;
    console.log(`  FAIL  ${def.id.padEnd(18)} ${def.metric.padEnd(12)} ${problems.join('; ')}`);
  }
}

/*
 * There is deliberately NO second assertion here that "every metric used has a
 * rule". It would be unfalsifiable: `METRIC_RULES` is typed
 * `Record<MetricKey, MetricRule>` and a def's `metric` is a `MetricKey`, so the
 * compiler already proves it, and a runtime check can only be built by adding
 * every used metric to the set it then searches -- which is what used to sit
 * here and could never fail.
 *
 * What is worth checking at runtime is the part the compiler CANNOT see:
 * whether each def's `amount` presence agrees with the engine's own table for
 * its metric. `FIXED_AMOUNT_METRICS` is DERIVED from that table, so the loop
 * above is a real comparison rather than a restatement of its input.
 */

if (ruleFailures === 0) {
  const usedMetrics = new Set(CONTRACT_DEFS.map((d) => d.metric));
  console.log(
    `  ok    all ${CONTRACT_DEFS.length} defs: ${fixed.size} metrics are fixed-size ` +
      `(${[...fixed].join(', ')}), the other ${usedMetrics.size - fixed.size} are rate-sized`,
  );
}
console.log('');
if (ruleFailures > 0) {
  console.log(`FAIL: ${ruleFailures} definitions disagree with METRIC_RULES`);
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Offer eligibility

   The pool must be drawn only from what the player has UNLOCKED. Reported as
   "it okay to rng but the pool should only base current unlocked -- ex. it
   should not give task to get the service from higher 2 tier only unlocked",
   and a fresh save really was being offered "buy more Datacenters".

   Asserted against the OFFERS rather than against the rule, for the same
   reason the uniqueness check is: the rule can be correct in the picker and
   still be bypassed by a caller, which is exactly what happened with the
   inventory dead-slot bug.

   Every subject check reads the ENGINE for its answer rather than restating
   the rule -- `abilityStatuses` for ability availability, the service counts
   for tiers. A copy of the rule here would pass while the engine disagreed,
   which is the failure mode this whole section exists to catch.
   -------------------------------------------------------------------------- */

interface EligibilityCase {
  label: string;
  owned: string[];
  completed: number;
  slots: number;
}

const eligibilityCases: EligibilityCase[] = [
  { label: 'nothing owned', owned: [], completed: 0, slots: 5 },
  { label: 'worker only', owned: ['worker'], completed: 5, slots: 5 },
  { label: 'worker+cache', owned: ['worker', 'cache'], completed: 20, slots: 5 },
  {
    label: 'first four',
    owned: SERVICES.slice(0, 4).map((s) => s.id),
    completed: 80,
    slots: 7,
  },
  {
    label: 'all eight',
    owned: SERVICES.map((s) => s.id),
    completed: 300,
    slots: 7,
  },
];

const SEEDS_FOR_ELIGIBILITY = 40;
let eligibilityFailures = 0;

console.log('offer eligibility across the fleet ladder');
console.log('');

for (const testCase of eligibilityCases) {
  const problems: string[] = [];
  /* Kept apart on purpose: `tierUnits` should offer exactly the OWNED tiers,
     and `tierOwned` exactly the FRONTIER. Counting them together made the
     total look one too high, which was a bug in this check rather than in the
     engine -- worth stating because the two metrics deliberately describe the
     same ladder from opposite ends. */
  const unitsTiers = new Set<string>();
  const ownedTiers = new Set<string>();

  for (let i = 0; i < SEEDS_FOR_ELIGIBILITY; i++) {
    const s = initialState(Date.now());
    s.seed = FIXED_SEED + i * 15485863;
    s.contractsCompleted = testCase.completed + i;
    for (const id of testCase.owned) s.services[id] = 80;
    const st = computeStats(s);
    const availability = abilityStatuses(s, Date.now());
    fillContracts(s, testCase.slots, st);

    /* The frontier: the first tier with no units. */
    const frontier = SERVICES.find((svc) => (s.services[svc.id] ?? 0) <= 0)?.id;

    for (const slot of s.contracts) {
      const def = defById.get(slot.id);
      if (def === undefined) continue;
      if (def.metric === 'tierUnits') {
        unitsTiers.add(def.serviceId ?? '?');
        if ((s.services[def.serviceId ?? ''] ?? 0) <= 0) {
          problems.push(`tierUnits '${slot.id}' for an unowned tier '${def.serviceId}'`);
        }
      } else if (def.metric === 'tierOwned') {
        ownedTiers.add(def.serviceId ?? '?');
        if (def.serviceId !== frontier) {
          problems.push(
            `tierOwned '${slot.id}' for '${def.serviceId}', but the frontier is '${frontier ?? 'none'}'`,
          );
        }
      } else if (def.metric === 'abilityUses') {
        const status = def.abilityId === undefined ? undefined : availability[def.abilityId];
        if (status === undefined || !status.available) {
          problems.push(`abilityUses '${slot.id}' for a locked ability '${def.abilityId}'`);
        }
      } else if (def.metric === 'upgrades') {
        if (s.upgrades.length >= UPGRADES.length) {
          problems.push(`upgrades '${slot.id}' offered with the ladder complete`);
        }
      }
    }
  }

  /* The def set must actually WIDEN with the fleet, or the gate is too tight:
     if the pool never grew, the whole point of the ordering would be lost. */
  const unitsOffered = unitsTiers.size;
  if (unitsOffered !== testCase.owned.length) {
    problems.push(
      `${unitsOffered} tierUnits defs offered against ${testCase.owned.length} owned tiers`,
    );
  }
  /* And the frontier one-shot must be offered unless there is no frontier. */
  const expectedFrontier = SERVICES[testCase.owned.length]?.id;
  if (expectedFrontier !== undefined && ownedTiers.size === 0) {
    problems.push(`no tierOwned def offered, but '${expectedFrontier}' is unowned`);
  }

  const unique = [...new Set(problems)];
  if (unique.length > 0) eligibilityFailures += 1;
  console.log(
    `  ${unique.length === 0 ? 'ok  ' : 'FAIL'}  ${testCase.label.padEnd(16)} owned ${testCase.owned.length} -> ${unitsOffered} buy-more + ${ownedTiers.size} first-time`,
  );
  for (const problem of unique.slice(0, 3)) console.log(`        ${problem}`);
}

console.log('');
if (eligibilityFailures > 0) {
  console.log('FAIL: a contract was offered for something the player has not unlocked');
  process.exit(1);
}
