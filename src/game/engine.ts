/* ==========================================================================
   Game engine.

   Every function is a pure calculation or an explicitly documented mutator of
   the state it is handed. No DOM, no globals, no storage: the rules can be
   reasoned about independently of the interface.
   ========================================================================== */

import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BY_ID,
  ABILITIES,
  ABILITY_BY_ID,
  CLICK,
  CONTRACTS,
  CONTRACT_DEFS,
  CURVE,
  MATURE_UNITS,
  MILESTONE,
  OFFLINE,
  PRESTIGE,
  SERVICE_BY_ID,
  SERVICES,
  SHARDS,
  SYNERGY,
  UPGRADE_BY_ID,
  UPGRADES,
} from './content';
import { rollChance, weightedPick } from './rng';
import type {
  AbilityDef,
  AbilityStatus,
  BuyQuantity,
  ContractDef,
  GameState,
  MetricKey,
  Rarity,
  ServiceDef,
  Stats,
  UpgradeDef,
} from './types';

/**
 * Accumulate compute, keeping the run and lifetime totals in step.
 *
 * `produced` distinguishes compute the FLEET made from compute the GAME handed
 * the player, and only produced compute reaches `totalEarned`.
 *
 * That distinction is load-bearing for contracts, and leaving it out was a
 * feedback loop. A completed contract pays compute, the payout went through
 * this function, and `state.totalEarned` is what the `totalEarned` contract
 * metric counts -- so collecting ANY contract advanced every open `totalEarned`
 * contract, including itself. Measured, 38% of them completed in under five
 * seconds against a band that names ninety: the metric was measuring "compute
 * you received", the payout is denominated in deploys and therefore scales with
 * production, and the loop closed on itself.
 *
 * `runEarned` deliberately KEEPS the payout, and that is not an oversight --
 * `prestigeCores` measures `runEarned`, and the engine already goes out of its
 * way to collect contracts before a Reboot precisely so the cores are not lost.
 * A payout is part of what the run earned. `totalEarned` is a claim about
 * PRODUCTION, which is why the metric is defined that way in the rule table.
 */
function credit(state: GameState, amount: number, produced = true): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  state.compute += amount;
  state.runEarned += amount;
  if (produced) state.totalEarned += amount;
}

/* --------------------------------------------------------------------------
   Per-tier rate channels

   The bulk of the per-tier mechanisms share one shape: "this tier's output
   rises with some quantity, up to a cap". They differ only in WHICH quantity
   they count. Rather than a record per mechanism, the count-driven ones share
   a helper and a uniform `Record<string, TierRate>`, with the quantity
   supplied at fold time.
   -------------------------------------------------------------------------- */

/** A per-unit bonus, the ceiling on the total bonus, and how that ceiling acts. */
interface TierRate {
  per: number;
  cap: number;
  /** Limit as `cap` above, or wall. See `UpgradeEffect.soft`. */
  soft: boolean;
}

/** One channel per tier, all starting at their no-op value. */
function tierChannel(): Record<string, TierRate> {
  const out: Record<string, TierRate> = {};
  for (const service of SERVICES) out[service.id] = { per: 0, cap: 0, soft: false };
  return out;
}

/**
 * Record a rate for one tier. Two sources on the same tier ADD their rates and
 * take the higher cap, rather than nesting products the cap cannot see.
 *
 * `soft` is OR-ed rather than taken from the last writer: it describes the
 * QUANTITY ("this one can run away"), and a quantity that needs softening does
 * not stop needing it because a second source on the same tier was authored
 * without the flag.
 */
function addTierRate(
  channel: Record<string, TierRate>,
  serviceId: string | undefined,
  effect: { per?: number; cap?: number; soft?: boolean },
): void {
  if (serviceId === undefined || !(serviceId in channel)) return;
  const existing = channel[serviceId];
  channel[serviceId] = {
    per: existing.per + (effect.per ?? 0),
    cap: Math.max(existing.cap, effect.cap ?? 0),
    soft: existing.soft || (effect.soft ?? false),
  };
}

/**
 * The bonus a per-unit rate pays for `quantity` -- the BONUS, not the
 * multiplier, so the two cap behaviours live in exactly one place.
 *
 * `cap <= 0` means "no ceiling at all", which is correct only where the
 * quantity bounds itself; the content is responsible for not leaving a
 * runaway quantity uncapped.
 */
function cappedBonus(
  per: number,
  cap: number,
  quantity: number,
  soft: boolean,
): number {
  const raw = per * quantity;
  if (cap <= 0) return raw;
  if (!soft) return Math.min(raw, cap);
  return (cap * raw) / (cap + raw);
}

/** `1 + the capped bonus`, the shared shape of every count-driven one. */
function scaleBy(rate: TierRate, quantity: number): number {
  if (rate.per <= 0) return 1;
  return 1 + cappedBonus(rate.per, rate.cap, quantity, rate.soft);
}

/* --------------------------------------------------------------------------
   Costs
   -------------------------------------------------------------------------- */

/**
 * Total cost of buying `count` units when `ownedCount` are held. Sum of a
 * geometric series, so O(1) rather than a loop.
 */
export function costOf(def: ServiceDef, ownedCount: number, count: number): number {
  if (count <= 0) return 0;
  const g = def.costGrowth;
  const base = def.baseCost * Math.pow(g, ownedCount);
  if (g === 1) return base * count;
  return (base * (Math.pow(g, count) - 1)) / (g - 1);
}

/** Largest number of units affordable with `compute`. */
export function maxAffordable(
  def: ServiceDef,
  ownedCount: number,
  compute: number,
): number {
  const firstUnit = def.baseCost * Math.pow(def.costGrowth, ownedCount);
  if (!Number.isFinite(compute) || compute < firstUnit) return 0;

  const g = def.costGrowth;
  if (g <= 1) return Math.floor(compute / firstUnit);

  let n = Math.floor(
    Math.log(1 + (compute * (g - 1)) / firstUnit) / Math.log(g),
  );
  if (!Number.isFinite(n) || n < 0) n = 0;

  /* Correct for floating-point drift in both directions. The closed form is
     accurate to roughly 1e-12 relative, so these run a handful of times. */
  while (n > 0 && costOf(def, ownedCount, n) > compute) n -= 1;
  while (costOf(def, ownedCount, n + 1) <= compute) n += 1;

  return n;
}

export function quoteBuy(
  def: ServiceDef,
  ownedCount: number,
  quantity: BuyQuantity,
  compute: number,
): { count: number; cost: number } {
  const count =
    quantity === 'max' ? maxAffordable(def, ownedCount, compute) : quantity;
  return { count, cost: costOf(def, ownedCount, count) };
}

/* --------------------------------------------------------------------------
   Derived stats
   -------------------------------------------------------------------------- */

/**
 * Milestone STEPS banked on a tier. Exported separately from
 * `milestoneMultiplier` because the UI shows the step count -- "4 steps" is
 * legible where "25.63x" is not -- and the two must never disagree.
 *
 * A reduced `step` grants EXTRA steps, capped at `MILESTONE.stepBonusMax`.
 * Uncapped, a smaller step compounds without limit as a tier grows.
 */
export function milestoneSteps(
  ownedCount: number,
  step: number = MILESTONE.step,
): number {
  /* A step of zero would divide by zero, so it is floored at one. */
  const span = Math.max(1, step);
  const normalSteps = Math.floor(ownedCount / MILESTONE.step);

  if (span >= MILESTONE.step) return normalSteps;

  const boostedSteps = Math.floor(ownedCount / span);
  const extra = Math.min(
    MILESTONE.stepBonusMax,
    Math.max(0, boostedSteps - normalSteps),
  );
  return normalSteps + extra;
}

/**
 * Multiplier a tier earns from its own milestone steps.
 *
 * `bonus` multiplies the RESULT rather than changing the base. Putting it in
 * the base -- `(2 + bonus) ^ steps` -- changes the growth RATE of an exponent:
 * +1 would be worth `3^steps / 2^steps`, which at 32 steps is 431,000x.
 *
 * Capping the ratio instead does not work: the four milestone achievements
 * contribute +0.6 between them, so a cap low enough to be sane binds before
 * the milestone upgrades can be bought. Multiplying the result is bounded by
 * construction and always does something.
 */
export function milestoneMultiplier(
  ownedCount: number,
  bonus = 0,
  step: number = MILESTONE.step,
): number {
  const steps = milestoneSteps(ownedCount, step);
  return Math.pow(MILESTONE.multiplier, steps) * Math.max(0, 1 + bonus);
}

/**
 * Everything the UI needs to state a tier's milestone position: the steps
 * banked and the unit counts either side of the next one.
 *
 * `nextAt` is found by scanning rather than assumed to be the next multiple of
 * `MILESTONE.step`, because a reduced step makes the cadence uneven: at step 20
 * a tier banks a step at 20 units and then nothing until 40, so "next at 25"
 * would point at a threshold that grants nothing.
 */
export function milestoneWindow(
  ownedCount: number,
  step: number = MILESTONE.step,
): { steps: number; prevAt: number; nextAt: number; nextSteps: number } {
  const steps = milestoneSteps(ownedCount, step);

  let prevAt = 0;
  for (
    let n = ownedCount - 1;
    n >= Math.max(0, ownedCount - MILESTONE.step);
    n -= 1
  ) {
    if (milestoneSteps(n, step) < steps) {
      prevAt = n + 1;
      break;
    }
  }

  let nextAt = ownedCount + MILESTONE.step;
  for (let n = ownedCount + 1; n <= ownedCount + MILESTONE.step; n += 1) {
    if (milestoneSteps(n, step) > steps) {
      nextAt = n;
      break;
    }
  }

  return { steps, prevAt, nextAt, nextSteps: milestoneSteps(nextAt, step) };
}

/**
 * Milestone steps banked across EVERY tier.
 *
 * Honours `stats.milestoneStep` rather than assuming `MILESTONE.step`, because
 * a `milestoneStep` upgrade gives one tier a different cadence. Counting
 * against the base step reports boundaries that no longer exist -- at 30 units
 * a tier with `step: 25` has banked one step, and with `step: 20` it has
 * banked one as well, but at 40 the two disagree.
 *
 * THE ONE DEFINITION. This existed twice -- once here and once in
 * `check:progression` -- and the two disagreed, because only one honoured the
 * reduced step. A reward that pays per crossing makes that disagreement a
 * balance bug rather than a reporting one, so the second copy is gone and the
 * harness reads this.
 */
export function milestoneStepsTotal(state: GameState, stats?: Stats): number {
  return SERVICES.reduce((sum, service) => {
    const step = stats?.milestoneStep[service.id] ?? MILESTONE.step;
    return sum + milestoneSteps(state.services[service.id] ?? 0, step);
  }, 0);
}

/**
 * Bonus a tier receives from the tier above it.
 * Capped, so a deep top tier cannot run away with the whole economy.
 * `bonus` widens the per-unit rate before that cap applies.
 */
function synergyMultiplier(ownedAbove: number, bonus = 0): number {
  const perUnit = SYNERGY.perUnit * (1 + bonus);
  return 1 + Math.min(ownedAbove * perUnit, SYNERGY.max);
}

/**
 * The global multiplier earned from `globalPerOwned` upgrades.
 *
 * The individually capped bonuses are SUMMED, not multiplied: multiplying
 * means two upgrades can exceed the ceiling alone, making every upgrade after
 * the second worthless.
 *
 * Each contribution is capped on its OWN quantity through `cappedBonus`, so a
 * soft cap here means the same thing it means on a per-tier row: the source
 * keeps paying as the count grows, just less each time.
 */
function perOwnedMultiplier(
  state: GameState,
  perService: Record<string, TierRate>,
  anyOwned: TierRate | null = null,
): number {
  let bonus = 0;
  for (const [serviceId, spec] of Object.entries(perService)) {
    const ownedCount = state.services[serviceId] ?? 0;
    bonus += cappedBonus(spec.per, spec.cap, ownedCount, spec.soft);
  }
  /*
   * The tier-agnostic variant: units of EVERY tier count, summed. A separate
   * accumulator rather than a pseudo-entry in `perService`, which is keyed on
   * nothing.
   */
  if (anyOwned !== null) {
    const total = Object.values(state.services).reduce((a, b) => a + b, 0);
    bonus += cappedBonus(anyOwned.per, anyOwned.cap, total, anyOwned.soft);
  }
  /* Clamped as a backstop only: with the authored caps the sum cannot reach
     this, so the clamp should never actually bind. */
  return Math.min(PER_OWNED_HARD_CEILING, Math.max(0, 1 + bonus));
}

/**
 * Absolute ceiling on the `globalPerOwned` bonus. A backstop, not a balance
 * number: the authored caps cannot sum past it, so it should never bind. It
 * exists because a per-unit bonus grows with a count, and a count is
 * unbounded.
 */
const PER_OWNED_HARD_CEILING = 6;

/*
 * Every bonus from every source, folded into one shape.
 *
 * Multiplicative kinds start at 1, additive kinds at 0, so merging in a
 * bonus is always the same operation regardless of where it came from.
 *
 * Achievements fold through here; upgrades fold separately inside
 * `computeStats()`, which is the only place that knows the ownership counts
 * the per-tier channels are read against.
 */
interface Modifiers {
  /* --- Achievement-sourced ------------------------------------------- */
  /**
   * The achievement OUTPUT pool as a SUM of percentage points: 47.0 is
   * "+4700%". A sum rather than a product, and `computeStats()` is the only
   * place it becomes a multiplier (`1 + globalBonus`). Zero is the identity.
   */
  globalBonus: number;
  click: number;
  service: Record<string, number>;
  offlineHours: number;
  offlineEfficiency: number;
  boostPower: number;
  boostDuration: number;
  boostCooldown: number;
  synergy: number;
  milestone: number;
  contractReward: number;
  autoRate: number;
  coreGain: number;
  /** Extra concurrent contracts, additive: 0 means the base count. */
  contractSlots: number;
  /** Multiplier on shards paid per completed contract. */
  shards: number;
  /**
   * Added to `SHARDS.reservePer`, the rate a held shard produces at. Additive
   * onto the RATE rather than multiplicative onto the bonus, which is already
   * unbounded in shards.
   */
  reservePer: number;
  /** Added to `PRESTIGE.bonusPerCore`. Zero means the base rate only. */
  coreAmplify: number;
  /** Ability ids granted by unlocked achievements. */
  abilities: Set<string>;
}

/** All the identity values, so no call site has to remember them. */
function baseModifiers(): Modifiers {
  return {
    globalBonus: 0,
    click: 1,
    service: {},
    offlineHours: 0,
    offlineEfficiency: 0,
    boostPower: 0,
    boostDuration: 1,
    boostCooldown: 1,
    synergy: 0,
    milestone: 0,
    contractReward: 1,
    autoRate: 0,
    coreGain: 1,
    contractSlots: 0,
    shards: 1,
    reservePer: 0,
    coreAmplify: 0,
    abilities: new Set<string>(),
  };
}

/**
 * Fold every achievement bonus into one Modifiers object.
 *
 * Achievements are the only source. Upgrades are folded separately inside
 * `computeStats()`, because they are the only source that needs the ownership
 * counts and the per-tier channels those counts are read against.
 */
export function computeModifiers(state: GameState): Modifiers {
  const mods = baseModifiers();

  /* Achievements. The unlocked set only grows, so this is O(unlocked)
     rather than O(all achievements) on the common path. */
  for (const id of state.achievements) {
    const def = ACHIEVEMENT_BY_ID[id];
    if (def === undefined) continue;

    for (const reward of def.rewards) {
      switch (reward.kind) {
        case 'globalBonus':
          mods.globalBonus += reward.bonus;
          break;
        case 'clickMult':
          mods.click *= reward.value;
          break;
        case 'serviceMult':
          mods.service[reward.serviceId] =
            (mods.service[reward.serviceId] ?? 1) * reward.value;
          break;
        case 'offlineCap':
          mods.offlineHours += reward.hours;
          break;
        case 'offlineEfficiency':
          mods.offlineEfficiency = Math.max(
            mods.offlineEfficiency,
            reward.value,
          );
          break;
        case 'boostPower':
          mods.boostPower += reward.value;
          break;
        case 'boostDuration':
          mods.boostDuration *= reward.value;
          break;
        case 'boostCooldown':
          mods.boostCooldown *= reward.value;
          break;
        case 'synergy':
          mods.synergy += reward.value;
          break;
        case 'milestone':
          mods.milestone += reward.value;
          break;
        case 'contractReward':
          mods.contractReward *= reward.value;
          break;
        case 'autoRate':
          mods.autoRate += reward.value;
          break;
        case 'coreGain':
          mods.coreGain *= reward.value;
          break;
        case 'shardGain':
          mods.shards *= reward.value;
          break;
        case 'contractSlots':
          mods.contractSlots += reward.slots;
          break;
        case 'reserveBonus':
          mods.reservePer += reward.per;
          break;
        case 'coreAmplify':
          mods.coreAmplify += reward.per;
          break;
        case 'unlockAbility':
          mods.abilities.add(reward.abilityId);
          break;
      }
    }
  }

  /*
   * Achievements only. Upgrades are NOT folded here: they are folded in
   * `computeStats()` so they can share the per-tier channels.
   */

  return mods;
}

function isAbilityAvailable(def: AbilityDef, mods: Modifiers): boolean {
  return def.base === true || mods.abilities.has(def.id);
}

function cooldownOf(def: AbilityDef, mods: Modifiers): number {
  return Math.max(0, Math.round(def.cooldownMs * mods.boostCooldown));
}

/** Live status of every ability, derived from state. Never cached. */
export function abilityStatuses(
  state: GameState,
  now: number,
  mods: Modifiers = computeModifiers(state),
): Record<string, AbilityStatus> {
  const out: Record<string, AbilityStatus> = {};

  for (const def of ABILITIES) {
    const stored = state.abilities[def.id];
    const until = stored?.until ?? 0;
    const readyAt = stored?.readyAt ?? 0;

    const available = isAbilityAvailable(def, mods);
    const active = until > now;
    const cooling = readyAt > now;

    out[def.id] = {
      id: def.id,
      available,
      active,
      activeMs: active ? until - now : 0,
      ready: available && !active && !cooling,
      cooldownMs: cooling ? readyAt - now : 0,
      multiplier:
        def.kind === 'boost' ? def.multiplier + mods.boostPower : def.multiplier,
      durationMs:
        def.kind === 'boost'
          ? Math.round(def.durationMs * mods.boostDuration)
          : def.durationMs,
      cooldownTotalMs: cooldownOf(def, mods),
    };
  }

  return out;
}

/**
 * Combined multiplier of every running boost ability. Boosts stack
 * multiplicatively, so unlocking a second one is a real reward.
 */
function boostMultiplier(
  state: GameState,
  now: number,
  mods: Modifiers,
): { multiplier: number; active: boolean } {
  let multiplier = 1;
  let active = false;

  for (const def of ABILITIES) {
    if (def.kind !== 'boost') continue;
    if (!isAbilityAvailable(def, mods)) continue;
    if ((state.abilities[def.id]?.until ?? 0) <= now) continue;

    multiplier *= def.multiplier + mods.boostPower;
    active = true;
  }

  return { multiplier, active };
}

/**
 * Recompute all derived values from state. Cheap enough to run every tick, and
 * always consistent with the save data because nothing is cached across ticks.
 */
export function computeStats(state: GameState, now = Date.now()): Stats {
  const serviceMult: Record<string, number> = {};
  const milestoneMult: Record<string, number> = {};
  const synergyMult: Record<string, number> = {};
  for (const service of SERVICES) {
    serviceMult[service.id] = 1;
    milestoneMult[service.id] = 1;
    synergyMult[service.id] = 1;
  }

  const mods = computeModifiers(state);

  const boost = boostMultiplier(state, now, mods);

  let upgradeMult = 1;
  /*
   * The ADDITIVE global pool, seeded from the achievements and extended by any
   * upgrade declaring `add`. One pool for both sources on purpose: that is what
   * makes an additive upgrade and an additive achievement comparable, and it is
   * the axis the `globalBonus` reward already described.
   */
  let globalAdd = mods.globalBonus;
  let clickMult = 1;
  /* The additive twin of `clickMult`, a sum with identity 0. */
  let clickAdd = 0;
  /*
   * SHARE POINTS, added to `CLICK.throughputShare`. A sum with identity 0 like
   * `clickAdd`, but it feeds the THROUGHPUT TERM of `clickPower` rather than
   * multiplying the finished value -- so it decides how much of PRODUCTION a
   * click reads, and is worth nothing while `CLICK.base` still dominates.
   */
  let clickShareAdd = 0;
  /* The additive twin of `shardMult`. */
  let shardAdd = 0;
  /* The additive twin of `upgradeContractReward`. */
  let contractRewardAdd = 0;
  /*
   * The additive twin of `upgradeCostMult`, as a fraction to REMOVE from the
   * price. Clamped when it is applied, not here, so the clamp is visible at the
   * one place the value is consumed.
   */
  let costAdd = 0;
  /*
   * The two reserve channels. They are RATES rather than multipliers: each is
   * added to the constant it extends, so an upgrade says "+0.005 per shard"
   * and not "x1.5 bonus".
   */
  let reservePerBonus = mods.reservePer;
  let coreAmplifyBonus = mods.coreAmplify;
  /* Clamped at zero: an effect can subtract hours, and a negative cap would
     credit negative offline time. */
  let offlineCapMs = Math.max(
    0,
    OFFLINE.baseCapMs + mods.offlineHours * 60 * 60 * 1000,
  );
  /* Offline efficiency only ever improves, from either source. */
  let offlineEfficiency: number = Math.max(
    OFFLINE.baseEfficiency,
    mods.offlineEfficiency,
  );
  /*
   * Automation splits into two channels with different consents.
   *
   * Auto-DEPLOY only CREATES compute, so sharing one rate is harmless.
   * Auto-BUY SPENDS it, and spending on the player's behalf is a different
   * act: folding it into `autoRate` made every module labelled "Automation
   * +X/s" silently start buying services, overriding a player who was
   * deliberately saving. It is fed ONLY by an explicit `autoBuy` effect.
   */
  let autoDeployRate = mods.autoRate;
  let autoBuyRate = 0;

  /* How many contracts run at once. Base plus the `contractSlots` upgrade and
     achievement rewards. */
  let contractSlots = CONTRACTS.active + mods.contractSlots;
  /* Multiplier on the shards a completed contract pays. */
  let shardMult = mods.shards;
  /* Global discount on every tier's units, from `costMult` upgrades. */
  let upgradeCostMult = 1;
  /* Shop levers on the three mechanisms achievements already reach, folded
     onto the achievement values so the two sources cannot disagree. */
  let upgradeSynergy = 0;
  let upgradeMilestone = 0;
  let upgradeContractReward = 1;

  /* Per-service upgrade channels. Defaults are the no-op value, so a tier
     with no upgrade of that kind behaves exactly as before. */
  const costPerService: Record<string, number> = {};
  const milestoneStep: Record<string, number> = {};
  const milestoneBonusPerService: Record<string, number> = {};
  const clickBonusPerService: Record<string, number> = {};
  const offlineFullPerService: Record<string, boolean> = {};
  const perOwned = tierChannel();
  /*
   * The channels behind each tier's SECOND signature -- the eight mechanisms
   * that scale a tier's output by something other than a flat multiplier.
   *
   * They are separate records rather than one map keyed by kind because each
   * scales by a DIFFERENT quantity (own count, fleet count, fleet share, the
   * tier below, deployed tiers, a fixed curve), and keeping them apart is
   * what makes it obvious at the point of use which quantity is in play.
   */
  const curvePerService: Record<string, { mult: number; cap: number }> = {};
  /*
   * Each tier's ADDITIVE pool, and it starts EMPTY rather than at 1.
   *
   * An additive channel is a SUM of percentage points whose identity is 0, not
   * a product whose identity is 1 -- the same reason `Modifiers.globalBonus` is
   * a sum whose identity is 0. Starting it at 1 would give every tier a free
   * +100% before a single upgrade was bought.
   */
  const serviceAddPool: Record<string, number> = {};
  const perOwnedTier = tierChannel();
  const throughputPerService = tierChannel();
  const depthPerService = tierChannel();
  const sharePerService: Record<string, { mult: number; cap: number }> = {};
  /* `serviceGlobalShare` leaves its own tier and lands on the global
     multiplier, so it needs the tier it is watching rather than a record. */
  let globalShareServiceId: string | null = null;
  let globalShareMult = 1;
  let globalShareCap = 0;
  /* `globalPerOwned` with no `serviceId` counts units of EVERY tier. Kept
     out of `perOwned` because it is keyed on nothing, so it cannot be one
     more entry there without inventing a fake service id. Plain numbers
     rather than a nullable record: a nullable let is narrowed to `never`
     inside the loop below, which TS then rejects on read. */
  let perOwnedAnyPer = 0;
  let perOwnedAnyCap = 0;
  let perOwnedAnySoft = false;
  let perOwnedAnySeen = false;
  /* Shard income per tier, from `serviceShardGain` upgrades. */
  const shardBonusPerService = tierChannel();
  /*
   * The count-driven channels, one per mechanism. Each holds a rate and a cap
   * per tier; the quantity is supplied at fold time below.
   *
   * EVERY quantity these read is this tier's own or the WHOLE fleet's -- none
   * of them looks at a neighbouring tier. That is a rule, not a coincidence:
   * a row scaling by "the tier above" prices one card from another card the
   * player may not own, and a tier reading a neighbour's RESULT cannot be
   * folded in one pass at all (which is why `serviceFloor` used to force a
   * second loop over every tier). `check:ladder` enforces the rule.
   */
  const maturityPerService = tierChannel();
  const parityPerService = tierChannel();
  const upgradesPerService = tierChannel();
  const contractsPerService = tierChannel();
  const fleetMilestonesPerService = tierChannel();
  const reservePerService = tierChannel();
  const coresPerService = tierChannel();
  const achievementsPerService = tierChannel();
  const positionPerService = tierChannel();
  const lifetimePerService = tierChannel();
  const apexPerService = tierChannel();
  const deployPerOwnedPerService = tierChannel();
  const shardsEarnedPerService = tierChannel();
  const rebootsPerService = tierChannel();
  const abilityUsesPerService = tierChannel();
  const returnsPerService = tierChannel();
  const shardsSpentPerService = tierChannel();
  /* Automated deploy RATE scaled by one tier's unit count. Folded into
     `autoDeployRate`, which is fleet-wide rather than per-service. */
  const autoDeployPerService = tierChannel();
  /*
   * `serviceRarity` counts UNLOCKED achievements of one rarity, so it needs
   * the rarity alongside the rate. Keyed by tier like the rest, with the
   * rarity carried in the same record -- a second parallel map would have to
   * stay in step with this one for no benefit.
   */
  const rarityPerService: Record<
    string,
    { per: number; cap: number; soft: boolean; rarity: Rarity }
  > = {};
  /* Flat, not count-driven: a plain multiplier while all eight tiers stand. */
  const fullStackPerService: Record<string, number> = {};
  /* Per-tier cost discount that deepens with ownership, from `serviceEconomy`.
     `per` is the discount rate and `cap` is the floor multiplier. */
  const economyPerService: Record<string, TierRate> = {};
  /*
   * Every per-tier channel starts at its no-op value. Upgrades are the only
   * source that writes to them.
   */
  for (const service of SERVICES) {
    costPerService[service.id] = 1;
    milestoneStep[service.id] = MILESTONE.step;
    serviceAddPool[service.id] = 0;
    milestoneBonusPerService[service.id] = 0;
    clickBonusPerService[service.id] = 0;
    fullStackPerService[service.id] = 1;
    economyPerService[service.id] = { per: 0, cap: 1, soft: false };
  }

  for (const service of SERVICES) {
    curvePerService[service.id] = { mult: 1, cap: 1 };
    sharePerService[service.id] = { mult: 0, cap: 1 };
    rarityPerService[service.id] = { per: 0, cap: 0, soft: false, rarity: 'bronze' };
  }

  for (const id of state.upgrades) {
    const upgrade = UPGRADE_BY_ID[id];
    if (!upgrade) continue;
    const effect = upgrade.effect;

    switch (effect.kind) {
      case 'globalMult':
        upgradeMult *= effect.mult ?? 1;
        break;
      case 'globalAdd':
        /*
         * The additive twin: joins the pool the achievements' `globalBonus`
         * writes to. `value` rather than `mult` because an additive bonus has
         * no pre-existing value to multiply -- it carries its contribution.
         */
        globalAdd += effect.value ?? 0;
        break;
      case 'serviceAdd':
        /* The per-tier additive pool. Same shape as `globalAdd`, one tier wide. */
        if (effect.serviceId && effect.serviceId in serviceAddPool) {
          serviceAddPool[effect.serviceId] += effect.value ?? 0;
        }
        break;
      case 'clickMult':
        clickMult *= effect.mult ?? 1;
        break;
      case 'clickAdd':
        clickAdd += effect.value ?? 0;
        break;
      case 'throughputShare':
        clickShareAdd += effect.per ?? 0;
        break;
      case 'shardAdd':
        shardAdd += effect.value ?? 0;
        break;
      case 'contractRewardAdd':
        contractRewardAdd += effect.value ?? 0;
        break;
      case 'costAdd':
        costAdd += effect.value ?? 0;
        break;
      case 'serviceMult':
        if (effect.serviceId && effect.serviceId in serviceMult) {
          serviceMult[effect.serviceId] *= effect.mult ?? 1;
        }
        break;
      case 'globalPerOwned':
        if (effect.serviceId && effect.serviceId in serviceMult) {
          addTierRate(perOwned, effect.serviceId, effect);
        } else if (!effect.serviceId) {
          /* No tier named: every unit of every tier counts. */
          perOwnedAnySeen = true;
          perOwnedAnyPer += effect.per ?? 0;
          perOwnedAnyCap = Math.max(perOwnedAnyCap, effect.cap ?? 0);
          perOwnedAnySoft = perOwnedAnySoft || (effect.soft ?? false);
        }
        break;
      case 'milestoneStep':
        if (effect.serviceId && effect.serviceId in milestoneStep) {
          milestoneStep[effect.serviceId] = Math.max(
            1,
            milestoneStep[effect.serviceId] - (effect.reduce ?? 0),
          );
        }
        break;
      case 'serviceMilestone':
        if (effect.serviceId && effect.serviceId in milestoneBonusPerService) {
          milestoneBonusPerService[effect.serviceId] += effect.bonus ?? 0;
        }
        break;
      case 'serviceClick':
        if (effect.serviceId && effect.serviceId in clickBonusPerService) {
          clickBonusPerService[effect.serviceId] += effect.mult ?? 0;
        }
        break;
      /*
       * `serviceOffline` and `serviceCost` are folded but CURRENTLY UNUSED --
       * no content row grants either since Worker's "Warm pool" became
       * `serviceAutoDeploy` and `serviceEconomy` replaced the per-tier cost
       * multiplier. Kept because nothing else expresses the mechanics.
       */
      case 'serviceOffline':
        if (effect.serviceId && effect.serviceId in costPerService) {
          offlineFullPerService[effect.serviceId] = true;
        }
        break;
      case 'serviceCost':
        if (effect.serviceId && effect.serviceId in costPerService) {
          costPerService[effect.serviceId] *= effect.mult ?? 1;
        }
        break;
      /*
       * The eight second signatures. Each records its rate here; the count it
       * scales by is not known until the ownership pass below, so all of them
       * are folded into `serviceMult` there.
       */
      case 'serviceCurve':
        if (effect.serviceId && effect.serviceId in curvePerService) {
          curvePerService[effect.serviceId] = {
            mult: curvePerService[effect.serviceId].mult * (effect.mult ?? 1),
            cap: Math.max(curvePerService[effect.serviceId].cap, effect.cap ?? 1),
          };
        }
        break;
      case 'servicePerOwned':
        addTierRate(perOwnedTier, effect.serviceId, effect);
        break;
      case 'serviceThroughput':
        addTierRate(throughputPerService, effect.serviceId, effect);
        break;
      case 'serviceDepth':
        addTierRate(depthPerService, effect.serviceId, effect);
        break;
      case 'serviceShare':
        if (effect.serviceId && effect.serviceId in sharePerService) {
          sharePerService[effect.serviceId] = {
            mult: Math.max(sharePerService[effect.serviceId].mult, effect.mult ?? 0),
            cap: Math.max(sharePerService[effect.serviceId].cap, effect.cap ?? 1),
          };
        }
        break;
      case 'serviceGlobalShare':
        globalShareServiceId = effect.serviceId ?? globalShareServiceId;
        globalShareMult = Math.max(globalShareMult, effect.mult ?? 1);
        globalShareCap = Math.max(globalShareCap, effect.cap ?? 0);
        break;
      case 'offlineCap':
        offlineCapMs += (effect.hours ?? 0) * 60 * 60 * 1000;
        break;
      case 'offlineEfficiency':
        /* Take the best available rather than compounding. */
        offlineEfficiency = Math.max(offlineEfficiency, effect.value ?? 0);
        break;
      case 'autoDeploy':
        autoDeployRate += effect.rate ?? 0;
        break;
      case 'autoBuy':
        autoBuyRate += effect.rate ?? 0;
        break;
      case 'contractSlots':
        contractSlots += effect.slots ?? 0;
        break;
      case 'shardGain':
        shardMult *= effect.mult ?? 1;
        break;
      case 'reserveBonus':
        reservePerBonus += effect.per ?? 0;
        break;
      case 'coreAmplify':
        coreAmplifyBonus += effect.per ?? 0;
        break;
      case 'serviceShardGain':
        addTierRate(shardBonusPerService, effect.serviceId, effect);
        break;
      case 'costMult':
        upgradeCostMult *= effect.mult ?? 1;
        break;
      case 'synergy':
        upgradeSynergy += effect.value ?? 0;
        break;
      case 'milestone':
        upgradeMilestone += effect.value ?? 0;
        break;
      case 'contractReward':
        upgradeContractReward *= effect.value ?? 1;
        break;
      /*
       * The count-driven mechanisms. Each records its rate here; the quantity
       * it scales by is not known until the ownership pass below, so all of
       * them are folded into `serviceMult` there.
       *
       * One case per mechanism, and that is not verbosity: the case is what
       * makes the quantity visible in the TYPE. A single `serviceScaled` kind
       * carrying a `quantity` string would move this choice into content.ts as
       * data, where a typo becomes a silently-zero row.
       */
      case 'serviceMatureTiers':
        addTierRate(maturityPerService, effect.serviceId, effect);
        break;
      case 'serviceParity':
        addTierRate(parityPerService, effect.serviceId, effect);
        break;
      case 'serviceUpgrades':
        addTierRate(upgradesPerService, effect.serviceId, effect);
        break;
      case 'serviceContracts':
        addTierRate(contractsPerService, effect.serviceId, effect);
        break;
      case 'serviceFleetMilestones':
        addTierRate(fleetMilestonesPerService, effect.serviceId, effect);
        break;
      case 'serviceReserve':
        addTierRate(reservePerService, effect.serviceId, effect);
        break;
      case 'serviceCores':
        addTierRate(coresPerService, effect.serviceId, effect);
        break;
      case 'serviceAchievements':
        addTierRate(achievementsPerService, effect.serviceId, effect);
        break;
      case 'servicePosition':
        addTierRate(positionPerService, effect.serviceId, effect);
        break;
      case 'serviceLifetime':
        addTierRate(lifetimePerService, effect.serviceId, effect);
        break;
      case 'serviceApex':
        addTierRate(apexPerService, effect.serviceId, effect);
        break;
      case 'serviceDeployPerOwned':
        addTierRate(deployPerOwnedPerService, effect.serviceId, effect);
        break;
      case 'serviceShardsEarned':
        addTierRate(shardsEarnedPerService, effect.serviceId, effect);
        break;
      case 'serviceReboots':
        addTierRate(rebootsPerService, effect.serviceId, effect);
        break;
      case 'serviceAbilityUses':
        addTierRate(abilityUsesPerService, effect.serviceId, effect);
        break;
      case 'serviceReturns':
        addTierRate(returnsPerService, effect.serviceId, effect);
        break;
      case 'serviceShardsSpent':
        addTierRate(shardsSpentPerService, effect.serviceId, effect);
        break;
      case 'serviceAutoDeploy':
        addTierRate(autoDeployPerService, effect.serviceId, effect);
        break;
      case 'serviceRarity':
        if (effect.serviceId && effect.serviceId in rarityPerService) {
          rarityPerService[effect.serviceId] = {
            per: rarityPerService[effect.serviceId].per + (effect.per ?? 0),
            cap: Math.max(rarityPerService[effect.serviceId].cap, effect.cap ?? 0),
            soft: rarityPerService[effect.serviceId].soft || (effect.soft ?? false),
            rarity: effect.rarity ?? rarityPerService[effect.serviceId].rarity,
          };
        }
        break;
      case 'serviceFullStack':
        if (effect.serviceId && effect.serviceId in fullStackPerService) {
          fullStackPerService[effect.serviceId] *= effect.mult ?? 1;
        }
        break;
      case 'serviceEconomy':
        if (effect.serviceId && effect.serviceId in economyPerService) {
          economyPerService[effect.serviceId] = {
            per: economyPerService[effect.serviceId].per + (effect.per ?? 0),
            /* The cap is a FLOOR here: it is the smallest multiplier the
               discount may reach, so the tier can never become free. A floor
               is never `soft` -- softening it would let the price approach a
               limit instead of respecting a bound, which is the one place the
               flag would mean the opposite of what it says. */
            cap: Math.min(economyPerService[effect.serviceId].cap, effect.cap ?? 1),
            soft: false,
          };
        }
        break;
    }
  }

  /* The quantities the count-driven mechanisms scale by, gathered once. */
  let totalUnits = 0;
  let deployedTiers = 0;
  let fleetMilestonesTotal = 0;
  /* Tiers staffed to `MATURE_UNITS` or more. Bounded at `SERVICES.length`. */
  let matureTiers = 0;
  /* Index of the highest tier that has any units, or -1 when none has. */
  let apexIndex = -1;
  for (const [index, service] of SERVICES.entries()) {
    const count = state.services[service.id] ?? 0;
    totalUnits += count;
    if (count > 0) {
      deployedTiers += 1;
      apexIndex = index;
    }
    if (count >= MATURE_UNITS) matureTiers += 1;
    fleetMilestonesTotal += Math.floor(count / MILESTONE.step);
  }

  /*
   * How many tiers are roughly in line with an even split of the fleet.
   *
   * "Balanced fleet" rewards an evenly spread fleet, which is the opposite
   * pressure to `serviceShare` (which rewards concentration). Both are worth
   * having precisely because they disagree: they make breadth and depth
   * compete rather than one always winning.
   */
  let balancedTiers = 0;
  if (totalUnits > 0) {
    const even = totalUnits / SERVICES.length;
    for (const service of SERVICES) {
      const count = state.services[service.id] ?? 0;
      /* Within a quarter either side of an even split. */
      if (count >= even * 0.75 && count <= even * 1.25) balancedTiers += 1;
    }
  }

  /*
   * This tier's share of the fleet, as a multiplier on the WHOLE fleet.
   * Zero when nothing is deployed, so a fresh run does not divide by zero.
   */
  let globalShareBonus = 0;
  if (globalShareServiceId !== null && totalUnits > 0) {
    const share = (state.services[globalShareServiceId] ?? 0) / totalUnits;
    globalShareBonus = Math.min(globalShareCap, share * globalShareMult);
  }

  /*
   * `serviceRarity`: how many UNLOCKED achievements are of each rarity.
   *
   * Counted from the unlocked set against the content table, so a rarity with
   * more entries in the game is naturally worth more of them -- the quantity
   * is "how many of this rarity have I earned", not a share.
   *
   * A `Record<Rarity, number>` built once rather than a filter per tier,
   * because eight tiers reading it would otherwise walk the achievement table
   * eight times on a 10Hz path.
   */
  const unlockedByRarity: Record<Rarity, number> = {
    bronze: 0,
    silver: 0,
    gold: 0,
    mythic: 0,
  };
  for (const id of state.achievements) {
    const def = ACHIEVEMENT_BY_ID[id];
    if (def !== undefined) unlockedByRarity[def.rarity] += 1;
  }

  /*
   * `serviceAbilityUses`: total ability activations this save.
   *
   * Read from `state.abilities` rather than from a counter of its own, because
   * `uses` is already stored per ability and already survives a reload -- a
   * second total would be one more field to migrate and could drift from it.
   */
  let abilityUsesTotal = 0;
  for (const ability of Object.values(state.abilities)) {
    abilityUsesTotal += ability.uses;
  }

  /*
   * `serviceMatureTiers` needs no derived value of its own: it is counted
   * beside `deployedTiers` in the ownership pass just below, from the same
   * iteration, and it is bounded by construction at `SERVICES.length`.
   */

  /* Milestones and synergies are per tier, so they need the ownership
     counts in tier order. */
  /*
   * Fold the GLOBAL milestone bonus into the per-tier record before the loop,
   * so the record is the EFFECTIVE bonus for that tier rather than only its
   * share of it. The UI needs the effective figure to state what the next
   * milestone is worth, and deriving it twice is how the number on screen
   * drifts from the number in the simulation.
   */
  const milestoneBonusGlobal = mods.milestone + upgradeMilestone;
  for (const id of Object.keys(milestoneBonusPerService)) {
    milestoneBonusPerService[id] += milestoneBonusGlobal;
  }

  SERVICES.forEach((service, index) => {
    const ownedCount = state.services[service.id] ?? 0;
    const above = SERVICES[index + 1];
    const ownedAbove = above ? (state.services[above.id] ?? 0) : 0;

    /* Synergy is authored on the tier above and falls downward; the bottom
     * tier applies it to itself because there is no tier above it. */
    const synergyBonus = mods.synergy;

    milestoneMult[service.id] = milestoneMultiplier(
      ownedCount,
      milestoneBonusPerService[service.id] ?? 0,
      milestoneStep[service.id] ?? MILESTONE.step,
    );
    synergyMult[service.id] =
      synergyMultiplier(
        index === 0 ? ownedCount : ownedAbove,
        synergyBonus,
      ) *
      /*
       * `upgradeSynergy` comes from the `synergy` upgrade kind, which NO
       * content row grants any more (the old `synergy-1` row is now a
       * `throughputShare` row), so this factor is 1 today. The fold is kept
       * because the kind still exists and it MULTIPLIES the tier's finished
       * synergy factor -- the shape that pays for itself, unlike widening the
       * pre-cap rate. A tier's synergy factor saturates at +50% in ordinary
       * play, so the additive form measured +2.8% on a fresh fleet and +0.7%
       * on a developed one against a 250-shard price.
       */
      (1 + upgradeSynergy);
    serviceMult[service.id] *=
      /*
       * The tier's ADDITIVE axis, then its multiplicative one. Written as
       * `(1 + pool) * product` rather than folding the pool in beside the
       * product, because the two modes have to stay separable: the pool is a
       * sum whose relative worth SHRINKS as it grows, and the product is a
       * chain of factors whose worth does not. Mixing them into one `*=` chain
       * would make an additive bonus behave multiplicatively, which is the
       * whole distinction the two kinds exist to express.
       */
      (1 + serviceAddPool[service.id]) *
      milestoneMult[service.id] *
      synergyMult[service.id] *
      (mods.service[service.id] ?? 1);

    /*
     * This tier's SECOND signature, if it has one. The three per-unit branches
     * below go through `scaleBy`, so they share the cap rule with the
     * seventeen first-signature channels -- a row here and a row there must
     * not disagree about what a cap means. `serviceCurve` and `serviceShare`
     * keep their own clamp: a curve's cap bounds a compound total rather than
     * a per-unit rate, and a share is bounded at 1 by arithmetic, so neither
     * has the flat-marginal-value problem a soft cap exists to fix.
     */
    const curve = curvePerService[service.id];
    const perOwnedRate = perOwnedTier[service.id];
    const throughput = throughputPerService[service.id];
    const depth = depthPerService[service.id];
    const share = sharePerService[service.id];

    if (curve.mult > 1) {
      /* A second, finer curve. Compounded per step but bounded by `cap`, so
         it cannot outrun the milestone curve it sits beside. */
      const steps = Math.floor(ownedCount / CURVE.step);
      serviceMult[service.id] *= Math.min(curve.cap, curve.mult ** steps);
    }
    serviceMult[service.id] *= scaleBy(perOwnedRate, ownedCount);
    serviceMult[service.id] *= scaleBy(throughput, totalUnits);
    serviceMult[service.id] *= scaleBy(depth, deployedTiers);
    if (share.mult > 0 && totalUnits > 0) {
      serviceMult[service.id] *= Math.min(
        share.cap,
        1 + share.mult * (ownedCount / totalUnits),
      );
    }

    /*
     * The count-driven mechanisms. Each scales this tier by a different
     * quantity; the quantity is PASSED IN, so the shapes stay readable side by
     * side and it is obvious at a glance which one reads what.
     *
     * `serviceRarity` is passed its count rather than the whole record, so it
     * uses the same helper as the rest and cannot drift in shape.
     */
    const rarityRate = rarityPerService[service.id];
    serviceMult[service.id] *=
      scaleBy(maturityPerService[service.id], matureTiers) *
      scaleBy(parityPerService[service.id], balancedTiers) *
      scaleBy(upgradesPerService[service.id], state.upgrades.length) *
      scaleBy(contractsPerService[service.id], state.contractsCompleted) *
      scaleBy(fleetMilestonesPerService[service.id], fleetMilestonesTotal) *
      scaleBy(reservePerService[service.id], state.shards) *
      scaleBy(coresPerService[service.id], state.cores) *
      scaleBy(achievementsPerService[service.id], state.achievements.length) *
      scaleBy(positionPerService[service.id], index) *
      scaleBy(lifetimePerService[service.id], state.totalEarned) *
      scaleBy(apexPerService[service.id], apexIndex + 1) *
      scaleBy(shardsEarnedPerService[service.id], state.shardsEarned) *
      scaleBy(rebootsPerService[service.id], state.reboots) *
      scaleBy(abilityUsesPerService[service.id], abilityUsesTotal) *
      scaleBy(returnsPerService[service.id], state.offlineReturns) *
      scaleBy(shardsSpentPerService[service.id], Math.max(0, state.shardsEarned - state.shards)) *
      scaleBy(rarityRate, unlockedByRarity[rarityRate.rarity]) *
      /* Flat while every tier stands, 1 otherwise. */
      (deployedTiers === SERVICES.length ? fullStackPerService[service.id] : 1);

    /*
     * `serviceEconomy`: units get cheaper the more you own. Applied to this
     * tier's cost, so `costOfWith` charges it without a second channel.
     * `cap` is a FLOOR, so the discount can never make a tier free.
     */
    const economy = economyPerService[service.id];
    if (economy.per > 0) {
      costPerService[service.id] *= Math.max(
        economy.cap,
        1 - economy.per * ownedCount,
      );
    }
  });

  const abilities = abilityStatuses(state, now, mods);

  /* Units owned, converted into a global multiplier. This is what keeps a
     cheap, early tier contributing after it has stopped being worth buying. */
  const perOwnedMult = perOwnedMultiplier(
    state,
    perOwned,
    perOwnedAnySeen
      ? { per: perOwnedAnyPer, cap: perOwnedAnyCap, soft: perOwnedAnySoft }
      : null,
  );

  /*
   * `serviceShardGain`: fleet depth raises shard income.
   *
   * Summed across tiers, each contribution individually capped, then folded
   * into the same `shardMult` that the `shardGain` shop upgrades write to.
   * The one per-tier mechanism that pays in the OTHER currency, which is what
   * earns it a slot: every other tier upgrade makes compute arrive faster,
   * and compute is not what gates the upgrade ladder.
   */
  for (const service of SERVICES) {
    const spec = shardBonusPerService[service.id];
    if (spec.per > 0) {
      const owned = state.services[service.id] ?? 0;
      shardMult *= scaleBy(spec, owned);
    }
  }

  /*
   * `serviceAutoDeploy`: a tier's unit count drives the automated deploy RATE.
   *
   * Accumulated HERE rather than in the tier loop above, because that loop
   * builds `serviceMult` -- a per-service multiplier -- while `autoDeployRate`
   * is one fleet-wide scalar. Each tier's contribution is capped on its OWN
   * count, so a deep Worker fleet cannot run the rate away.
   */
  for (const service of SERVICES) {
    const spec = autoDeployPerService[service.id];
    if (spec.per > 0) {
      autoDeployRate += cappedBonus(
        spec.per,
        spec.cap,
        state.services[service.id] ?? 0,
        spec.soft,
      );
    }
  }

  /*
   * The shard reserve, and what cores do to it -- TWO INDEPENDENT THINGS.
   *
   * Held shards produce, so the currency keeps a job once the finite ladder is
   * exhausted. Production is on a SQUARE ROOT of the balance because a mature
   * save holds thousands and Reboot does not clear shards: at a linear rate
   * NEVER SPENDING would dominate every other multiplier combined and delete
   * the ladder. `Math.sqrt(0)` is 0, so a fresh save needs no special case.
   *
   * Cores are a FINAL multiplier on the whole fleet, NOT an amplifier of the
   * reserve bonus. They used to nest inside it, which meant a core multiplied
   * a bonus that is ADDED TO 1 (so it was diluted by every other factor) and
   * was worth literally nothing at zero shards, where `sqrt(0)` collapsed the
   * term. Applied to `perSecond` below, a core multiplies every tier, upgrade,
   * achievement and boost, and is always worth something.
   *
   * So `reserveBonus` is purely the shards' own contribution, with no core
   * term, and the shards and cores HUD chips no longer multiply to one figure.
   * That is deliberate -- do not re-couple them.
   *
   * Computed HERE, after the upgrade loop, because `reservePerBonus` and
   * `coreAmplifyBonus` are filled by that loop.
   */
  const coreAmplifyPer = PRESTIGE.bonusPerCore + coreAmplifyBonus;
  const coreMult = 1 + coreAmplifyPer * state.cores;
  const reserveBonus = (SHARDS.reservePer + reservePerBonus) * Math.sqrt(state.shards);
  const reserveMult = 1 + reserveBonus;

  const globalMult =
    reserveMult *
    /*
     * The additive pool becomes a multiplier HERE, and only here. Seeded from
     * the achievements and extended by additive upgrades, so the two sources
     * are one axis -- see `globalAdd` above.
     */
    (1 + globalAdd) *
    upgradeMult *
    boost.multiplier *
    perOwnedMult *
    /* `serviceGlobalShare`: a fleet-wide bonus sized by how concentrated the
       fleet is in one tier. The only one of the eight that leaves its tier. */
    (1 + globalShareBonus);

  const perService: Record<string, number> = {};
  let perSecond = 0;
  let totalServices = 0;

  /*
   * A SINGLE pass. Every tier's output is its own base, unit count, per-tier
   * multiplier and the fleet multiplier -- no tier reads another tier's
   * RESULT, so nothing needs a second loop.
   *
   * This pass used to be split in two by `serviceFloor`, the one mechanism
   * that lifted a tier toward a share of the tier above. A neighbour's result
   * is not known until it has been computed, so the whole fleet had to be
   * evaluated into `rawOutput` first and only then summed. Deleting the
   * mechanism deleted the phase with it.
   */
  for (const service of SERVICES) {
    const ownedCount = state.services[service.id] ?? 0;
    totalServices += ownedCount;
    /*
     * `coreMult` is applied HERE rather than to the sum afterwards, so
     * `perService` and `perSecond` stay consistent: the per-tier figures the
     * Services panel prints still add up to the fleet total. Applying it to
     * the sum alone would make the two disagree by exactly the core multiplier.
     */
    const output =
      service.baseOutput * ownedCount * serviceMult[service.id] * globalMult * coreMult;
    perService[service.id] = output;
    perSecond += output;
  }

  /*
   * A tier can strengthen manual deploys, which is otherwise the one system no
   * service touches. TWO additive channels feed it, summed rather than
   * multiplied because sources unlock in arbitrary order and the same set must
   * be worth the same however it was assembled:
   *
   *   - `serviceClick`, a FLAT multiplier from one tier (Load balancer).
   *   - `serviceDeployPerOwned`, this tier's unit count, capped. The
   *     compute-powered path to clicking: compute buys the units, the units
   *     raise the deploy.
   */
  let clickFromUnits = 0;
  for (const service of SERVICES) {
    clickFromUnits +=
      scaleBy(deployPerOwnedPerService[service.id], state.services[service.id] ?? 0) - 1;
  }
  const clickFromTiers =
    1 + Object.values(clickBonusPerService).reduce((a, b) => a + b, 0) + clickFromUnits;

  return {
    perSecond,
    perService,
    serviceMult,
    milestoneMult,
    synergyMult,
    totalServices,
    /*
     * `CLICK.base` sits INSIDE the bracket with the throughput share, which is
     * why a share point is worth nothing early -- at 0.1/s of production the
     * flat base of 1 is the whole deploy. The share rises 0.5 via two shop
     * rows, so a click keeps scaling with the fleet.
     */
    clickPower:
      (CLICK.base + perSecond * (CLICK.throughputShare + clickShareAdd)) *
      (1 + clickAdd) *
      clickMult *
      mods.click *
      clickFromTiers,
    /*
     * Automation shards a share of PRODUCTION, not `clickPower`.
     *
     * The two were the same number, which is what made automation inherit the
     * click tree: with ~195x of click multipliers it paid ~83x the fleet's
     * production, and the click rate could not be raised without taking that
     * up with it. Splitting them means the button and the automation can be
     * tuned independently, and each reward stays legible as its own thing.
     */
    autoDeployValue: perSecond * CLICK.autoDeployShare,
    globalMult,
    /* The two terms of `globalMult` the HUD breakdown cannot read off anything
       else. The other four (`reserveMult`, `upgradeMult`, `boostMult`,
       `perOwnedMult`) were already exposed for their own chips. */
    additiveMult: 1 + globalAdd,
    concentrationMult: 1 + globalShareBonus,
    achievementMult: 1 + mods.globalBonus,
    reserveMult,
    reserveBonus,
    reservePerRate: SHARDS.reservePer + reservePerBonus,
    coreMult,
    coreAmplifyPer,
    upgradeMult,
    offlineCapMs,
    offlineEfficiency,
    boostMult: boost.multiplier,
    boostActive: boost.active,
    abilities,
    autoDeployRate,
    autoBuyRate,
    contractRewardMult:
      (1 + contractRewardAdd) * mods.contractReward * upgradeContractReward,
    synergyBonus: mods.synergy + upgradeSynergy,
    milestoneBonus: mods.milestone + upgradeMilestone,
    coreGainMult: mods.coreGain,
    /* Per-service upgrade channels. */
    perOwnedMult,
    costPerService,
    milestoneStep,
    milestoneBonusPerService,
    /* The channel that gives one tier a full-rate offline pass. */
    offlineEfficiencyPerService: Object.fromEntries(
      SERVICES.map((svc) => [
        svc.id,
        offlineFullPerService[svc.id] ? 1 : offlineEfficiency,
      ]),
    ),
    contractSlots,
    /*
     * Additive first, then multiplicative, at the one place the axis is
     * finalised. `shardMult` itself stays the MULTIPLICATIVE chain (upgrade
     * mults and the per-tier depth bonus); the additive pool multiplies the
     * finished chain rather than joining it, because a sum folded into a `*=`
     * chain would behave multiplicatively and the two modes would stop being
     * distinguishable.
     */
    shardMult: Math.max(0, shardMult * (1 + shardAdd)),
    costMult: Math.max(
      0.01,
      /*
       * Additive FIRST, then multiplicative, and the clamp is on the RESULT.
       * `(1 - costAdd)` is a discount whose sum can exceed 1 if enough rows are
       * bought, which would make units FREE and then NEGATIVE; the 0.9 ceiling
       * on the pool keeps the additive half from ever being the thing that
       * breaks, and the 0.01 floor bounds the product. */
      upgradeCostMult * (1 - Math.min(0.9, Math.max(0, costAdd))),
    ),
  };
}

/* --------------------------------------------------------------------------
   Services cost modifier

   `Stats.costMult` has to reach `costOf()`, which is deliberately a pure
   function of a definition and a count. Rather than thread `Stats` through
   every cost call site -- buy buttons, max-affordable, automation, the quote
   for a bulk buy -- the multiplier is applied by the callers that already
   hold `Stats`. `scaledCost` is that one place.
   -------------------------------------------------------------------------- */

/** A cost after the run's cost multiplier, rounded to a whole number. */
export function scaledCost(base: number, stats: Stats, serviceId?: string): number {
  const run = Number.isFinite(stats.costMult) ? stats.costMult : 1;
  /* Per-tier discounts stack with the global one, so a tier made cheap by an
     upgrade is still affected by the global cost multiplier -- one does not
     cancel the other out. */
  const tier =
    serviceId === undefined ? 1 : (stats.costPerService[serviceId] ?? 1);
  const scale = run * tier;
  return Math.max(0, base * (Number.isFinite(scale) ? scale : 1));
}

/**
 * Cost of buying `count` units with the run's cost multiplier applied.
 * The multiplier is applied once to the summed total rather than per unit,
 * so it cannot compound differently depending on how the buy was split.
 */
export function costOfWith(
  def: ServiceDef,
  ownedCount: number,
  count: number,
  stats: Stats,
): number {
  return scaledCost(costOf(def, ownedCount, count), stats, def.id);
}

/**
 * Largest number affordable with `compute`, accounting for the run's cost
 * multiplier. Solved by dividing the multiplier out and reusing the closed
 * form, so this stays O(1) rather than searching.
 */
export function maxAffordableWith(
  def: ServiceDef,
  ownedCount: number,
  compute: number,
  stats: Stats,
): number {
  const run = Number.isFinite(stats.costMult) && stats.costMult > 0 ? stats.costMult : 1;
  const tier =
    Number.isFinite(stats.costPerService[def.id]) && (stats.costPerService[def.id] ?? 0) > 0
      ? (stats.costPerService[def.id] as number)
      : 1;
  return maxAffordable(def, ownedCount, compute / (run * tier));
}

/* --------------------------------------------------------------------------
   Active abilities
   -------------------------------------------------------------------------- */

export interface AbilityActivation {
  ok: boolean;
  /** Units granted, for 'freeUnits' abilities. Zero for everything else. */
  granted: number;
}

/**
 * Fire an ability. Mutates state.
 *
 * A 'freeUnits' ability costs NO compute -- it grants capacity outright, which
 * is the whole reason it exists. It can only fail by not being ready; there is
 * nothing to afford.
 *
 * `stats` is optional and is NOT used to decide anything: it is read only to
 * value the milestone shards a `freeUnits` grant crosses. That is a different
 * need from affording a purchase, so the old note that this "takes no `stats`"
 * was true about the cost and wrong about the reward -- without it the grant
 * would have to either skip the payment or re-derive `shardMult`, which is a
 * fold that must not exist in two places.
 */
export function activateAbility(
  state: GameState,
  id: string,
  now: number,
  stats?: Stats,
): AbilityActivation {
  const def = ABILITY_BY_ID[id];
  if (def === undefined) return { ok: false, granted: 0 };

  const mods = computeModifiers(state);
  const status = abilityStatuses(state, now, mods)[id];
  if (status === undefined || !status.ready) return { ok: false, granted: 0 };

  const slot = state.abilities[id] ?? { until: 0, readyAt: 0, uses: 0 };
  const cooldown = cooldownOf(def, mods);

  let granted = 0;

  if (def.kind === 'boost') {
    slot.until = now + status.durationMs;
    slot.readyAt = slot.until + cooldown;
  } else {
    slot.until = 0;
    slot.readyAt = now + cooldown;

    /*
     * Provision: a FLAT budget of free units, shared across every tier the
     * player already owns in proportion to its size, floor one unit, at no
     * compute cost.
     *
     * Both halves are deliberate. Units are not linear here -- a tier's output
     * is `2^floor(owned/25)` times its base -- so a grant's worth depends on how
     * many milestone boundaries it crosses. Scaling the grant with the fleet
     * would cross a proportional number of them:
     *
     *     @250 owned    +25 into one tier   -> +122% production
     *     @2,500        +250                -> +119,367%
     *     @6,505        +650                -> +7,801,405,340%
     *
     * A flat 25 measures +10.6% / +1.0% / +0.4% at the same three fleets. A
     * modest top-up rather than a burst, and bounded at every scale. A smaller
     * SHARE would not fix it -- a smaller unbounded number is still unbounded.
     * See `docs/DECISIONS.md` for the measurements.
     */
    const totalOwned = SERVICES.reduce(
      (sum, service) => sum + (state.services[service.id] ?? 0),
      0,
    );

    let total = 0;

    /* Steps banked per tier around the grant, so the award is the boundaries
       the grant crossed. A `freeUnits` grant can cross several at once, and it
       crosses them on EVERY tier at once -- which is why this is the per-tier
       vector rather than the fleet total: the faucet pays a different rate on
       each tier, so a single count cannot say what is owed. */
    const stepsBefore = milestoneStepsByTier(state, stats);

    if (totalOwned > 0) {
      for (const service of SERVICES) {
        const ownedCount = state.services[service.id] ?? 0;
        if (ownedCount <= 0) continue;

        /* Proportional to this tier's share of the fleet, floored at one so a
           tier the player owns one of still visibly moves. The floors can push
           the total a unit or two past the budget, which is the intended
           trade: the guarantee that every row moves is worth more than
           exactness about a number nobody can see. */
        const grant = Math.max(
          1,
          Math.floor((def.amount * ownedCount) / totalOwned),
        );
        state.services[service.id] = ownedCount + grant;
        total += grant;
      }
    }

    granted = total;
    const stepsAfter = milestoneStepsByTier(state, stats);
    SERVICES.forEach((_service, index) => {
      awardMilestoneSteps(
        state,
        index,
        stepsBefore[index],
        stepsAfter[index],
        stats?.shardMult ?? 1,
      );
    });
  }

  slot.uses += 1;
  state.abilities[id] = slot;

  return { ok: true, granted };
}

/**
 * How much of a contract's metric the player can still earn, or Infinity.
 *
 * An uncompletable contract does not merely sit there: it holds a SLOT, and
 * slots are the faucet. `inventory-1` and `inventory-2` ask for 1 and 3
 * purchases against a ladder of `UPGRADES.length`, so a player who owns all of
 * them would be permanently down two of five slots -- 40% of shard income,
 * silently, with no way to clear the row.
 *
 * THREE metrics are bounded, each failing its own way:
 *
 *   upgrades    the pool is finite, so it runs out
 *   tierOwned   owning a tier cannot un-happen, so it is 0 or 1
 *   abilityUses an ability the player has not UNLOCKED cannot be used at all
 *
 * The last is the one most easily missed: Surge does not exist until
 * `contracts-25`, so a Surge contract offered early would be uncompletable for
 * hours while holding a slot -- the same bug by a different door.
 *
 * Takes the DEF rather than the bare metric because the answer depends on WHICH
 * tier or ability the def names.
 */
function metricHeadroom(state: GameState, def: ContractDef): number {
  return METRIC_RULES[def.metric].headroom(state, def);
}

/**
 * Shards one contract pays, before `shardMult` and the salvage strike.
 *
 * Resolved from the def's `cost` by taking the largest band that does not
 * exceed it, rather than an exact-value lookup: an exact match would fall
 * through for any cost off the four-value table, and a fall-through on a payout
 * is a silent zero. The largest band at or below the cost is monotone (more
 * work never pays less) and TOTAL (every cost resolves).
 */
export function shardPayout(def: ContractDef): number {
  /*
   * A contract whose objective is about COMPUTE pays no shards at all, and one
   * whose objective IS shards is paid `soloBonus` for concentrating. Default
   * (`both`, and any def that omits the field) pays the band as written.
   */
  const kind = def.reward ?? 'both';
  if (kind === 'compute') return 0;

  const bands: Array<[number, number]> = [
    [CONTRACTS.cost.quick, SHARDS.perCost.quick],
    [CONTRACTS.cost.standard, SHARDS.perCost.standard],
    [CONTRACTS.cost.project, SHARDS.perCost.project],
    [CONTRACTS.cost.epic, SHARDS.perCost.epic],
  ];
  let payout = bands[0][1];
  for (const [cost, value] of bands) {
    if (def.cost >= cost) payout = value;
  }
  return kind === 'shards' ? Math.round(payout * CONTRACTS.soloBonus) : payout;
}

/**
 * The objective size for one def.
 *
 * MOST METRICS RETURN AN AUTHORED `amount`. That is the normal case; this
 * function exists mainly to be the ONE place the size is resolved, so the
 * stored target and the rule table cannot disagree.
 *
 * The exception is `totalEarned`, sized as `perSecond x cost x
 * growthCorrection`. Compute is the metric that legitimately scales without
 * limit -- "earn 150 seconds of production" is a fair ask whether the player
 * makes 5,000 a second or 5e11 -- so it is the one metric whose objective is
 * derived rather than authored. `clicks` is derived too, from
 * `cost x referenceClicksPerSecond`, because a click contract's work is real
 * time at a declared rate.
 *
 * So the conversions are now three, not five:
 *
 *   totalEarned  perSecond x cost x growthCorrection   the metric IS production
 *   clicks       cost x clicks per second              real time, declared rate
 *   everything   def.amount                            authored, fixed
 *   else
 *
 * `services`, `milestones` and `tierUnits` USED to be converted through
 * production ("units `cost` seconds buys"). That is gone, and the reason is
 * worth keeping because it is the defect this whole file's contract section
 * was rewritten around: the conversion priced every unit at the CURRENT
 * marginal price, which ignores the `1.15^n` cost curve, so the richer the
 * player got the MORE units the card asked for. The number grew while the work
 * did not. Sizing as a SHARE OF THE CURRENT STOCK ("bring 20% more units
 * online") failed the other way: auto-buy turns compute into units
 * continuously, so 20% of a fleet arrives in SECONDS while the card still pays
 * `cost` seconds for it.
 *
 * The pacing that used to come out of a growing objective now comes from
 * `CONTRACTS.offerMs`, which bounds the FAUCET'S RATE -- the thing the shard
 * ladder is actually priced against -- and from `METRIC_RULES[metric].ready`,
 * which withholds a band until the fleet has reached it.
 *
 * (There is no `shards` metric: a contract cannot be measured on the currency
 * the ladder is bought with.)
 *
 * `growthCorrected` is an explicit flag rather than `!fixedAmount` because the
 * two are not complements: `clicks` is neither. Applying the correction to it
 * would introduce the very drift the correction exists to remove.
 */
function objectiveSize(state: GameState, def: ContractDef, stats: Stats): number {
  const rule = METRIC_RULES[def.metric];
  const raw = rule.size(state, def, stats, def.cost);

  /*
   * One correction, applied ONCE, for the ONE metric still sized from the
   * production rate.
   *
   * It used to cover four metrics (`services`, `milestones` and `tierUnits` as
   * well). Those three became fixed `amount`s, so `totalEarned` is now the
   * only reader -- and the correction is kept rather than deleted because
   * compute is the one metric that legitimately scales without limit.
   *
   * `perSecond x cost` is the area of a rectangle under a curve that is still
   * rising, so the fleet delivers it in a fraction of `cost`. The correction is
   * a MEASURED constant rather than a live growth model, because modelling the
   * whole economy inside a sizing function would put any error in that model
   * somewhere invisible.
   *
   * A per-metric table was tried twice and did not converge, because the
   * metrics are coupled through the shard faucet -- see the note on the
   * constant in `content.ts`. That conclusion is now moot for the three fixed
   * metrics, but the constant's VALUE is still the measured one for
   * `totalEarned`, so it must not be moved without re-measuring.
   *
   * It is NOT a time claim and the card must not present it as one. It is a
   * difficulty dial: what it buys is an objective that costs a reasonable amount
   * of work, and the exact seconds are unattainable because the required factor
   * moves by two orders of magnitude inside a single run (production doubles in
   * seconds early, in hours late). `check:progression` asserts that no metric's
   * typical completion has left its band; it reports the ratio rather than
   * asserting it equals 1.
   */
  const corrected = rule.growthCorrected ? raw * CONTRACTS.growthCorrection : raw;

  const sized = Math.max(1, Math.round(corrected));
  const headroom = rule.headroom(state, def);
  return Number.isFinite(headroom) ? Math.min(sized, Math.max(1, headroom)) : sized;
}

/**
 * Milestone steps banked across the WHOLE fleet.
 *
 * Extracted so the contract `value` and the contract `ready` gate cannot
 * disagree about what a milestone count is -- the two must read one number.
 * The step is the `MILESTONE.step` CONSTANT, not `stats.milestoneStep`: a
 * `milestoneStep` upgrade changes how many steps a tier has banked for its own
 * output, and a contract must not silently mean a different quantity because
 * the player bought one.
 */
function totalMilestoneSteps(state: GameState): number {
  return SERVICES.reduce(
    (sum, s) => sum + Math.floor((state.services[s.id] ?? 0) / MILESTONE.step),
    0,
  );
}

function totalUnits(state: GameState): number {
  return SERVICES.reduce((sum, s) => sum + (state.services[s.id] ?? 0), 0);
}

/* --------------------------------------------------------------------------
   The metric rules table

   EVERYTHING the engine knows about a contract metric, in one place. A metric
   has exactly three behaviours -- how its counter is read, how much room it
   has left, and how an objective is sized -- and they were previously three
   parallel `switch (def.metric)` blocks in three different parts of this file
   (plus a fourth for the label in format.ts, and a hand-maintained list of
   "fixed amount" metrics in `check-upgrade-ladder.mjs`).

   That meant adding a metric took five coordinated edits, and missing one
   compiled cleanly: the three switches were each independently exhaustive, so
   TypeScript would catch a missing case in the switch you forgot but not that
   you had forgotten a switch. Three metrics were added in one session and each
   one was a five-file change.

   `Record<MetricKey, MetricRule>` makes the table exhaustive by construction:
   a new member of `MetricKey` fails to compile until it is given a rule here,
   which is a better guarantee than any of the switches gave.

   The label for each metric still lives in `format.ts`, deliberately. Text is
   a rendering concern, and format.ts has a one-way dependency on content.ts
   that this file would break by reaching into it.
   -------------------------------------------------------------------------- */

interface MetricRule {
  /**
   * True when the objective is a fixed `def.amount` rather than a rate.
   *
   * This is now the NORMAL case. `clicks`, `abilityUses` (real time),
   * `upgrades` (a bounded pool, `UPGRADES.length`), `tierOwned` (a 0/1 fact),
   * `services`, `milestones` and `tierUnits` all carry a fixed `amount`.
   *
   * `totalEarned` is the exception, and it is the only metric left that is
   * sized from the player's rate -- compute scales without limit, so "earn 90
   * seconds of production" is a fair ask at every point in a run.
   */
  fixedAmount: boolean;
  /**
   * True when the objective is sized from the player's PRODUCTION RATE, and so
   * has to carry `CONTRACTS.growthCorrection`.
   *
   * `totalEarned` IS NOW ITS ONLY USER. It used to carry four metrics; the
   * other three became fixed `amount`s and no longer read it at all.
   *
   * The flag is kept distinct from `fixedAmount` rather than inferred from it
   * because the two are not complements: `clicks` is sized from `def.cost`
   * (so it is not a fixed `amount`) but its work is real time at a declared
   * rate, so it is already honest and MUST NOT be corrected. Applying the
   * correction to a metric that has no drift would INTRODUCE the error it
   * removes.
   */
  growthCorrected: boolean;
  /**
   * Whether the def's ask SUITS the player yet.
   *
   * This is the piece that makes fixed objectives work, and it is not a
   * difficulty dial -- it is what stops a fixed ask from being illegible. An
   * authored number does not grow, so if every def were offered from the first
   * minute the player would be handed an epic-sized job to a three-unit fleet:
   * "bring 25 more services online" is exactly the card that fixed amounts
   * were introduced to remove, one band lower down.
   *
   * The rule for the three unit metrics is `value(state, def) >= def.amount`:
   * a contract asking for N more of something is offered once the player
   * ALREADY HAS N of it. Two things follow, and both matter:
   *
   *   - the ask is always about roughly a DOUBLING of what it measures, which
   *     is near-constant work at every scale, because unit costs grow
   *     geometrically at `COST_GROWTH`. The completion RATE is therefore
   *     bounded by the content rather than by a separate rate limiter; and
   *   - the number on the card is never larger than what the player already
   *     owns, so it cannot read as impossible.
   *
   * What it does NOT replace is `headroom`, and the two ask different
   * questions: `headroom` asks whether the counter CAN advance at all, this
   * asks whether it should be asked YET. `tier-datacenter` needs both -- the
   * tier must exist, and the player must already hold the one it asks for.
   *
   * The rate-sized and real-time metrics return `true`: `totalEarned` is sized
   * from the live rate and so is appropriate by construction, and `clicks`,
   * `upgrades`, `tierOwned` and `abilityUses` carry amounts that do not scale
   * with the fleet at all.
   */
  ready: (state: GameState, def: ContractDef) => boolean;
  /** The counter a contract measures, read from live state. */
  value: (state: GameState, def: ContractDef) => number;
  /**
   * How much the counter can still advance, or `Infinity` when unbounded.
   * Zero means a contract on this metric could never complete -- the dead-slot
   * condition `pickContract` exists to avoid.
   */
  headroom: (state: GameState, def: ContractDef) => number;
  /** Objective size at the player's current rate, in the metric's own units. */
  size: (state: GameState, def: ContractDef, stats: Stats, cost: number) => number;
}

const METRIC_RULES: Record<MetricKey, MetricRule> = {
  clicks: {
    fixedAmount: false,
    /*
     * Real time, NOT production -- so no growth correction. See the note on
     * `growthCorrected`.
     *
     * Sized from the band at the declared reference rate rather than from an
     * authored `amount`, and that reversal is the fix for "ten clicks completes
     * almost ten contracts". The `amount` was `25` against a `quick` band
     * declared as ninety seconds, i.e. six seconds of work paying for ninety --
     * and because it was authored per-def the card could not be honest, and
     * `CONTRACTS.referenceClicksPerSecond` sat declared, documented and
     * UNREAD. A constant nothing reads is worse than no constant: the gap it
     * was meant to make visible was itself invisible.
     */
    growthCorrected: false,
    value: (state) => state.clicks,
    ready: () => true,
    headroom: () => Infinity,
    size: (_state, def) => def.cost * CONTRACTS.referenceClicksPerSecond,
  },
  services: {
    fixedAmount: true,
    /*
     * A FIXED number of units, and no longer sized from the rate. This was the
     * metric that made the report "contract quest still growth too fast 75
     * service at early game": a cost-derived objective priced every unit at
     * the CURRENT marginal price, so it ignored the `1.15^n` cost curve
     * entirely and the number ballooned as production grew without the work
     * growing with it. `bring 25 more services online` means twenty-five units
     * at every scale now, and the band decides which of 1 / 5 / 10 / 25 the
     * card asks for.
     */
    growthCorrected: false,
    value: (state) => totalUnits(state),
    /* The player must already run as many units as the def asks for. */
    ready: (state, def) => totalUnits(state) >= (def.amount ?? 1),
    headroom: () => Infinity,
    size: (_state, def) => def.amount ?? 1,
  },
  totalEarned: {
    fixedAmount: false,
    growthCorrected: true,
    value: (state) => state.totalEarned,
    /* Sized from the live rate, so it is appropriate at every point already. */
    ready: () => true,
    headroom: () => Infinity,
    /*
     * The plain rectangle, with no per-metric correction, because the growth
     * correction is applied ONCE in `objectiveSize()` -- and this is now the
     * only metric it is applied to.
     *
     * It previously carried its own `CONTRACTS.totalEarnedTime` factor, and
     * that was the wrong shape twice over. It was the only metric with one, so
     * the other three rate-sized metrics stayed uncorrected while this one was
     * corrected by an amount measured for this one alone -- and it was a dial
     * calibrated against a quantity that moves by two orders of magnitude
     * inside a single run, so whatever it was set to it was wrong for most of
     * the run. One correction, in one place, shared by every metric that needs
     * it, is the only version of this that can be reasoned about.
     *
     * "Every metric that needs it" is now this one. The other three became
     * fixed `amount`s and no longer read the correction at all, which is what
     * finally retired the coupling this comment was written about.
     */
    size: (_state, _def, stats, cost) => stats.perSecond * cost,
  },
  milestones: {
    fixedAmount: true,
    /*
     * A FIXED number of STEPS, and one step is `MILESTONE.step` (25) units in
     * a SINGLE tier. The metric still counts a real quantity; only the ASK is
     * authored now.
     *
     * The step is read from the `MILESTONE.step` constant rather than from
     * `stats.milestoneStep`, so a `milestoneStep` upgrade cannot quietly change
     * what "one milestone" means to a contract -- the same reason
     * `milestones` in `value` above uses the constant.
     */
    growthCorrected: false,
    /* Derived rather than stored: a pure function of the unit counts, and a
       stored copy would need invalidating on every purchase. */
    value: (state) => totalMilestoneSteps(state),
    /* A step is reachable exactly when some tier has banked one. */
    ready: (state, def) => totalMilestoneSteps(state) >= (def.amount ?? 1),
    headroom: () => Infinity,
    size: (_state, def) => def.amount ?? 1,
  },
  upgrades: {
    fixedAmount: true,
    growthCorrected: false,
    value: (state) => state.upgrades.length,
    ready: () => true,
    /* The only metric with a hard end: a bounded number of purchases exist in
       the whole game, and an uncompletable contract holds one of five slots
       forever. */
    headroom: (state) => UPGRADES.length - state.upgrades.length,
    size: (_state, def) => def.amount ?? 1,
  },
  tierUnits: {
    fixedAmount: true,
    /*
     * A FIXED number of units of ONE named tier, and the number DESCENDS as the
     * tier gets dearer (25 Workers to 1 Datacenter). A single band table could
     * not serve this metric: every tier shares `COST_GROWTH`, but `baseCost`
     * spans 15 to 330,000,000, so one number would be trivial on the cheap rows
     * and absurd on the deep ones.
     */
    growthCorrected: false,
    value: (state, def) =>
      def.serviceId === undefined ? 0 : (state.services[def.serviceId] ?? 0),
    /*
     * The player must already hold as many of the tier as the def asks for, and
     * that single clause covers BOTH requirements this metric has.
     *
     * "Buy 12 more Datacenters" is wrong when you own none of them -- the word
     * "more" has nothing to attach to, and the objective names a row the player
     * has never seen. Reported as "the pool should only base current unlocked
     * ... it should not give task to get the service from higher 2 tier", and a
     * fresh save really was being offered `tier-database` and `tier-region`.
     *
     * `amount >= 1` on every def means `owned >= amount` implies `owned > 0`, so
     * the owned-tier requirement is subsumed rather than duplicated: the ask is
     * always at least a doubling of a row the player is already running.
     */
    ready: (state, def) =>
      def.serviceId !== undefined &&
      (state.services[def.serviceId] ?? 0) >= (def.amount ?? 1),
    headroom: (state, def) => {
      if (def.serviceId === undefined) return 0;
      return (state.services[def.serviceId] ?? 0) > 0 ? Infinity : 0;
    },
    size: (_state, def) => def.amount ?? 1,
  },
  tierOwned: {
    fixedAmount: true,
    growthCorrected: false,
    /* 1 once the tier exists, so the objective can only ever be 1. */
    value: (state, def) =>
      def.serviceId !== undefined && (state.services[def.serviceId] ?? 0) > 0 ? 1 : 0,
    /*
     * Deliberately `true` rather than `value >= amount`, and the difference is
     * the whole point of the metric: this is the ONE def that asks for a tier
     * the player does NOT have, and it is offered only while that is true.
     */
    ready: () => true,
    /* Offered only while the tier is absent, so one purchase consumes it. */
    headroom: (state, def) => {
      if (def.serviceId === undefined) return 0;
      return (state.services[def.serviceId] ?? 0) > 0 ? 0 : 1;
    },
    size: (_state, def) => def.amount ?? 1,
  },
  abilityUses: {
    fixedAmount: true,
    growthCorrected: false,
    value: (state, def) =>
      def.abilityId === undefined ? 0 : (state.abilities[def.abilityId]?.uses ?? 0),
    /* Real time in charges, at a cooldown the fleet cannot change. */
    ready: () => true,
    /*
     * A LOCKED ability has no headroom, and this guard is load-bearing: Surge
     * does not exist until `contracts-25`, so a Surge contract offered at
     * contract ten would be uncompletable for hours while holding a slot.
     */
    headroom: (state, def) => {
      if (def.abilityId === undefined) return 0;
      const ability = ABILITY_BY_ID[def.abilityId];
      if (ability === undefined) return 0;
      return isAbilityAvailable(ability, computeModifiers(state)) ? Infinity : 0;
    },
    size: (_state, def) => def.amount ?? 1,
  },
};

/** Metrics whose objective comes from `def.amount` rather than the player's rate. */
export const FIXED_AMOUNT_METRICS: MetricKey[] = (
  Object.keys(METRIC_RULES) as MetricKey[]
).filter((metric) => METRIC_RULES[metric].fixedAmount);

/* --------------------------------------------------------------------------
   Contracts
   -------------------------------------------------------------------------- */

/**
 * Current value of the counter a contract is measured against. See
 * `METRIC_RULES` for the per-metric read, and `MetricKey` for why every one of
 * them is monotonic within a run.
 */
export function metricValue(
  state: GameState,
  def: ContractDef,
): number {
  return METRIC_RULES[def.metric].value(state, def);
}

export interface ContractView {
  def: ContractDef;
  current: number;
  target: number;
  complete: boolean;
}

/** Progress of one contract, measured from where it was issued. */
function contractView(state: GameState, id: string): ContractView | null {
  const def = CONTRACT_DEFS.find((c) => c.id === id);
  const slot = state.contracts.find((c) => c.id === id);
  if (def === undefined || slot === undefined) return null;

  const progressed = metricValue(state, def) - slot.baseline;
  const current = Math.max(0, progressed);
  return {
    def,
    current,
    /* The STORED target, not one recomputed from the definition: the size was
       fixed when the contract was issued, against the player's rate at that
       moment, and recomputing it would move the goalposts as the fleet grows
       -- in the generous direction, which is the worst way for a contract to
       be wrong. */
    target: slot.amount,
    complete: current >= slot.amount,
  };
}

export function contractViews(state: GameState): ContractView[] {
  const views: ContractView[] = [];
  for (const slot of state.contracts) {
    const view = contractView(state, slot.id);
    if (view !== null) views.push(view);
  }
  return views;
}

/**
 * Compute awarded for completing a contract.
 *
 * `clickPower x deployMult`: a contract pays a fixed number of DEPLOYS, so a
 * quick errand pays ten and an epic a hundred. Deriving it from the objective
 * (the old `perSecond x cost x payback`) guaranteed the two agreed about
 * DIFFICULTY and said nothing about legibility -- a quick contract paid 0.86
 * seconds of production for ninety seconds of work, which no player can picture.
 *
 * The band resolves from `cost` the same way `shardPayout` does: the largest
 * band at or below the cost, which is monotone and TOTAL (an off-table cost
 * pays sensibly rather than falling through to a silent zero).
 *
 * NOTE the coupling this creates: the payout scales with the CLICK tree, so
 * `clickMult` moves contract income. Deliberate -- it gives the click tree a
 * second reason to exist -- but it means contract tuning must be measured.
 */
export function contractReward(
  stats: Stats,
  def: ContractDef,
): number {
  /*
   * A contract whose objective is about SHARDS pays no compute, and one whose
   * objective IS compute is paid `soloBonus` for concentrating.
   *
   * Note what this does to the economy: a shards-only contract pays no compute,
   * so it does not feed the loop that buys units and raises production. A small
   * damper on the contract feedback loop, not a fix for it.
   */
  const kind = def.reward ?? 'both';
  if (kind === 'shards') return 0;

  const bands: Array<[number, number]> = [
    [CONTRACTS.cost.quick, CONTRACTS.deployMult.quick],
    [CONTRACTS.cost.standard, CONTRACTS.deployMult.standard],
    [CONTRACTS.cost.project, CONTRACTS.deployMult.project],
    [CONTRACTS.cost.epic, CONTRACTS.deployMult.epic],
  ];
  let deploys = bands[0][1];
  for (const [cost, value] of bands) {
    if (def.cost >= cost) deploys = value;
  }

  const base = stats.clickPower * deploys * stats.contractRewardMult;
  return kind === 'compute' ? base * CONTRACTS.soloBonus : base;
}

/**
 * What a contract is ABOUT, as a key. Two contracts with the same subject are
 * the same work to a player and must not run side by side.
 *
 * The metric alone is not enough, and neither is the def id:
 *   - `tierUnits` covers eight defs, and "buy more Caches" and "buy more
 *     Replicas" are genuinely different work, so the tier is part of it.
 *   - `manual-surge` and `handover` are DIFFERENT defs on the same metric and
 *     are NOT different work: both are "click N times". They collided on the
 *     panel as two click objectives at different sizes, which reads as
 *     repetition rather than as choice.
 *
 * So the key is the metric plus whichever subject field that metric uses. For
 * the metrics with no subject field the metric IS the subject: one at a time.
 */
function contractSubject(def: ContractDef): string {
  return `${def.metric}:${def.serviceId ?? def.abilityId ?? ''}`;
}

/**
 * Pick the next contract id.
 *
 * A seeded, UNIFORM draw over the eligible pool. Eligibility is the whole
 * curriculum, so the pool shrinks to fit the player rather than being weighted:
 *
 *   - a tier objective only appears for a tier already in play (`tierUnits`),
 *     or for the next tier the player has not opened (`tierOwned`);
 *   - an ability objective only once the ability is unlocked;
 *   - an upgrade objective only while upgrades remain;
 *   - no two active contracts share a subject;
 *   - and a def whose metric has run out of headroom is never offered.
 */
function pickContract(state: GameState): string {
  const active = new Set(state.contracts.map((c) => c.id));
  /* The subjects already on the panel, so the new one cannot repeat one. */
  const activeSubjects = new Set(
    state.contracts
      .map((c) => CONTRACT_DEFS.find((d) => d.id === c.id))
      .filter((def): def is ContractDef => def !== undefined)
      .map(contractSubject),
  );
  /*
   * The offer filter, in five clauses:
   *
   *   1. not already on the panel;
   *   2. not repeating a SUBJECT -- the metric plus its tier or ability, so two
   *      cards can never render the same quest ("Cross 1 more milestones"
   *      twice), while the eight `tierUnits` defs stay distinct;
   *   3. the metric still has headroom, which is the dead-slot guard: it asks
   *      whether the counter CAN still advance at all;
   *   4. `tierOwned` is offered ONLY for the frontier tier, the first one the
   *      player owns none of. Headroom alone would make all eight one-shots
   *      available at once, which reads as eight free bounties in the opening
   *      minutes rather than a guided tour of the tiers;
   *   5. the def's ask SUITS the player yet (`METRIC_RULES[metric].ready`).
   *
   * Clause 5 is the one that makes FIXED objectives work, and it is why this
   * pool is a staircase rather than a lottery. An authored number does not grow,
   * so without this a fresh save could draw `expansion-3` and be told to bring
   * 25 more services online while running three -- the same illegible card the
   * fixed amounts were introduced to remove. `ready` requires the player to
   * already hold what the def asks for, so the ask is always about a doubling
   * and deeper bands surface as the fleet reaches them.
   *
   * Clauses 3 and 5 are NOT redundant. `headroom` asks "can this ever finish",
   * `ready` asks "should it be asked now"; `tier-datacenter` needs the tier to
   * exist AND the player to hold the one unit it wants.
   */
  const nextUnowned = SERVICES.find((s) => (state.services[s.id] ?? 0) <= 0)?.id;
  const available = CONTRACT_DEFS.filter(
    (def) =>
      !active.has(def.id) &&
      !activeSubjects.has(contractSubject(def)) &&
      metricHeadroom(state, def) >= 1 &&
      METRIC_RULES[def.metric].ready(state, def) &&
      (def.metric !== 'tierOwned' || def.serviceId === nextUnowned),
  );
  if (available.length === 0) return '';

  /*
   * A plain draw, uniform over what is ELIGIBLE. There is no difficulty bias,
   * and its absence is still the point -- but the reason has changed with the
   * objectives.
   *
   * It used to be that sizing at ISSUE time made every def the same difficulty
   * by construction, so there was nothing to bias away from. Now that most asks
   * are fixed, difficulty is real and it is handled in the POOL instead of in a
   * weight: `ready` withholds a band until the fleet has reached it, so the
   * eligible set IS the player's curriculum and no ordering of draws can hand
   * out a job that is out of scale.
   *
   * A weight would be strictly worse here. It would make the deep bands
   * possible-but-rare from the first minute, which is the failure `ready`
   * exists to prevent, and it would need re-tuning whenever an `amount`
   * changed.
   *
   * THE SALT CARRIES THE SLOT COUNT. `contractsCompleted` does NOT change
   * between the slots of one fill and `weightedPick` is pure in
   * `(seed, salt, items)`, so a salt without the count reuses the SAME roll for
   * every slot, mapped onto a list that shrinks as each def is taken. That is
   * how two cards came to show one quest. `length` is persisted, so the draw
   * stays reproducible across a reload.
   */
  const picked = weightedPick(
    state.seed,
    `contract-pick:${state.contractsCompleted}:${state.contracts.length}`,
    available,
    () => 1,
  );

  return picked?.id ?? available[0]?.id ?? '';
}

/**
 * Issue a new contract.
 *
 * No rarity roll. The size is either an authored `amount` or, for
 * `totalEarned` alone, computed from the live rate -- and in both cases it is
 * STORED on the contract, so the card's promise and the engine's charge cannot
 * disagree and nothing hidden changes what a contract is worth.
 *
 * The baseline is what makes progress countable: a contract asks for `amount`
 * MORE of a metric, so the target is measured from where the counter stood when
 * the card was drawn. Wording it as an absolute showed `0 / 60` to a player
 * already holding 125.
 *
 * Counts against the offer budget, and only here. Every other path into
 * `state.contracts` is a Reboot refill, which is a re-issue of work the reset
 * invalidated rather than new work the player earned -- see `applyReboot`.
 */
function issueContract(state: GameState, id: string, stats: Stats): void {
  const def = CONTRACT_DEFS.find((c) => c.id === id);
  if (def === undefined) return;
  if (state.contracts.some((c) => c.id === id)) return;

  state.contracts.push({
    id,
    baseline: metricValue(state, def),
    amount: objectiveSize(state, def, stats),
  });
  state.contractsIssued += 1;
}

/**
 * Fill every empty contract slot. Mutates state.
 *
 * `slots` is the concurrent capacity, which the `contractSlots` upgrade can
 * raise above `CONTRACTS.active`. Passed in rather than read from the content
 * table so the caller's already-computed `Stats` is the single source of
 * truth -- the panel and the fill can never disagree about the count.
 */
export function fillContracts(
  state: GameState,
  slots: number = CONTRACTS.active,
  stats?: Stats,
): void {
  const target = Math.max(0, Math.floor(slots));
  /* Computed once if the caller did not already have them: issuing five
     contracts would otherwise recompute the same statistics five times. */
  const live = stats ?? computeStats(state);

  while (state.contracts.length < target) {
    /*
     * THE OFFER BUDGET, checked every iteration rather than once, because a
     * fill of five slots spends five issues.
     *
     * See `CONTRACTS.offerMs` for what this bounds and why it is here rather
     * than in the objective. In one line: the objective had to stop growing, so
     * the pacing moved to the FAUCET'S RATE, which is what the shard ladder is
     * actually priced against.
     */
    if (state.contractsIssued >= issuesAllowed(state, target)) break;

    const id = pickContract(state);
    if (id === '') break;
    const before = state.contracts.length;
    issueContract(state, id, live);
    /*
     * `issueContract` refuses a def that is already active, so a repeated pick
     * would spin this loop forever. The guard stays even though the picker
     * filters duplicates out and salts per slot: a loop that trusts the picker
     * is a loop that hangs if the picker is ever wrong.
     *
     * On failure the slot is left EMPTY rather than filled with the duplicate.
     * An empty slot is the honest failure -- it is visible as a gap, it fills
     * on the next tick, and it never shows the player the same quest twice.
     * Preferring a visible vacancy over a wrong card is the same trade
     * `metricHeadroom` makes against the dead-slot problem.
     *
     * It is ALSO the correct behaviour for a spent offer budget, and that is
     * why the budget needs no separate empty-slot state in the UI: an empty
     * slot is already a deliberate outcome here.
     */
    if (state.contracts.length === before) break;
  }
}

/**
 * How many contracts this save is allowed to have issued by now.
 *
 * `slots` up front, so the opening panel is full, then one more per
 * `CONTRACTS.offerMs` of PLAY. Exported so the panel can state the cadence
 * truthfully rather than leaving an empty slot unexplained -- see the note in
 * `ui.ts`.
 *
 * `playtime` rather than a wall-clock delta: a save that sits closed for a day
 * would otherwise bank 1,570 issues and dump them on the returning player in
 * one tick, which is both a windfall and a flood of cards to read.
 */
export function issuesAllowed(state: GameState, slots: number = CONTRACTS.active): number {
  const base = Math.max(0, Math.floor(slots));
  const earned = Math.floor(Math.max(0, state.playtime) / CONTRACTS.offerMs);
  return base + earned;
}

/**
 * How long until the next contract may be issued, in milliseconds of play.
 *
 * Zero when one is available NOW. This is what the Contracts panel reads to
 * explain an empty slot instead of leaving the player to guess whether the
 * game is broken.
 */
export function msUntilNextContract(
  state: GameState,
  slots: number = CONTRACTS.active,
): number {
  /*
   * Purely a function of the BUDGET -- deliberately not of how full the panel
   * is.
   *
   * An earlier version short-circuited to 0 whenever the panel was below
   * capacity, on the reasoning that a slot was therefore waiting to be filled.
   * That is exactly backwards in the case this function exists for: the panel
   * is below capacity BECAUSE the budget is spent, so the guard reported "one
   * is available now" at the one moment that was false, and the panel showed
   * an unexplained empty slot with no countdown.
   */
  if (state.contractsIssued < issuesAllowed(state, slots)) return 0;

  /*
   * The next allowance is the one that lifts `issuesAllowed` past the count
   * already spent. `issuesAllowed` rises by one every `offerMs` from `slots`,
   * so the playtime at which it does is a whole multiple of the cadence --
   * which makes this arithmetic rather than a scheduler.
   */
  const need = Math.max(
    1,
    state.contractsIssued - Math.max(0, Math.floor(slots)) + 1,
  );
  const dueAt = need * CONTRACTS.offerMs;
  const playtime = Math.max(0, state.playtime);
  return dueAt > playtime ? dueAt - playtime : 0;
}

/** Replace a completed contract with a fresh one. Mutates state. */
function replaceContract(state: GameState, id: string, slots: number, stats: Stats): void {
  state.contracts = state.contracts.filter((c) => c.id !== id);
  fillContracts(state, slots, stats);
}

/**
 * Claim any completed contracts. Mutates state.
 *
 * Pays the currency the contract's objective is ABOUT, and both when it is
 * about neither -- see `ContractDef.reward`. So compute scaled to what the
 * fleet currently produces (which keeps pace with the exponential side of the
 * game) and shards from a cost-banded faucet (which funds the ladder) are now
 * distributed across the panel rather than paid identically by everything.
 */
export function collectContracts(
  state: GameState,
  stats: Stats,
): {
  count: number;
  reward: number;
  shards: number;
  bonuses: number;
} {
  let count = 0;
  let reward = 0;
  let shards = 0;
  let bonuses = 0;

  /* Iterate over a snapshot: replaceContract mutates the live array. */
  for (const view of contractViews(state)) {
    if (!view.complete) continue;

    const amount = contractReward(stats, view.def);
    /* NOT produced: this is compute the game handed the player. Crediting it to
       `totalEarned` would let the `totalEarned` metric pay for itself -- see the
       note on `credit`. */
    credit(state, amount, false);
    state.contractsCompleted += 1;
    count += 1;
    reward += amount;

    /*
     * Banded by the contract's own cost, and zero for a compute-reward def.
     * `stats.shardMult` already folds the shard upgrades and the per-tier
     * depth bonus, so this line needs to know none of them.
     */
    let payout = shardPayout(view.def) * stats.shardMult;

    /*
     * The salvage strike: a small chance of tripling a contract's shards.
     *
     * Salted with the contract's own completion ordinal, so it pays the same on
     * every reload -- a surprise, not a gamble, and not something save-scumming
     * can fish for. `contractsCompleted` was incremented above, so minus one is
     * this completion's 0-based ordinal.
     */
    if (rollChance(state.seed, `salvage:${state.contractsCompleted - 1}`, SHARDS.bonusChance)) {
      payout *= SHARDS.bonusMult;
      bonuses += 1;
    }

    shards += awardShards(state, Math.round(payout));

    replaceContract(state, view.def.id, stats.contractSlots, stats);
  }

  return { count, reward, shards, bonuses };
}

/**
 * Add shards. Mutates state.
 *
 * The single entry point for shard income, so `shardsEarned` cannot drift from
 * `shards`. Both are needed: the balance goes DOWN when an upgrade is bought,
 * and a contract measured against a balance would be un-completable by design.
 */
export function awardShards(state: GameState, amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const gained = Math.floor(amount);
  state.shards += gained;
  state.shardsEarned += gained;
  return gained;
}

/**
 * Position of a tier on the ladder, so the milestone faucet can pay more for a
 * deeper one. `Worker` is 0 and `Datacenter` is 7.
 *
 * Derived from `SERVICES` rather than authored: the index IS the fleet order,
 * and a second table would be one more thing to keep in step.
 */
export const TIER_INDEX = new Map(SERVICES.map((service, index) => [service.id, index]));

/**
 * Shards one milestone step pays, before `shardMult`.
 *
 * The payout is `perMilestone x tierTerm x stepTerm`, and the two terms answer
 * two different questions:
 *
 *   - `tierTerm` (a per-tier multiplier TABLE) pays more on a DEEPER tier, so
 *     climbing is worth something even after a tier's output per compute has
 *     fallen behind. The shipped table makes the eight base payouts exactly
 *     10 12 15 18 21 24 27 30.
 *   - `stepTerm` (`stepsBanked + 1`) pays more the deeper THAT TIER already is:
 *     the 1st milestone on a tier pays 1x its base, the 2nd pays 2x, the 3rd
 *     3x, up to `milestoneStepMax`.
 *
 * `stepTerm` is CLAMPED at `milestoneStepMax`, and the clamp is load-bearing:
 * step count follows the unit count, units double every 25, and the payout feeds
 * shards which buy upgrades which make units arrive faster. Unbounded, the step
 * term compounds -- the same shape that makes `serviceShardsSpent` need a cap
 * and the reserve need a root.
 *
 * The `+ 1` on the step term is what makes the bound a CAP on a multiplier
 * rather than an offset into one. `stepsBanked` counts the milestones ALREADY
 * banked, so the first crossing on a tier arrives with `stepsBanked = 0`; without
 * the `+ 1` the opening milestone would pay nothing at all.
 *
 * The tier table is indexed defensively rather than promised to be long enough:
 * `check:ladder` asserts its length against `SERVICES`, and the `?? 1` means a
 * future ninth tier pays the base rate instead of `NaN` -- a payout of `NaN`
 * would reach the balance as `NaN` and be silently ignored by `awardShards`.
 *
 * EXPORTED so `check:progression` accumulates THIS function rather than a copy.
 * A second copy of a reward calculation is how a report starts disagreeing with
 * the game it reports on.
 */
export function milestoneStepPayout(tierIndex: number, stepsBanked: number): number {
  const index = Math.max(0, Math.floor(tierIndex));
  const tierTerm = SHARDS.milestoneTierMult[index] ?? 1;
  const stepTerm = Math.min(stepsBanked + 1, SHARDS.milestoneStepMax);
  return SHARDS.perMilestone * tierTerm * Math.max(1, stepTerm);
}

/**
 * Pay for the milestone boundaries one tier crossed.
 *
 * Takes STEP COUNTS rather than unit counts, so a purchase crossing several
 * boundaries at once is paid for each: a `max` purchase, an `autoBuy` tick or
 * the `freeUnits` grant can each cross three or four in one call, and a
 * unit-count signature could only express the net.
 *
 * Steps are summed SEQUENTIALLY rather than multiplied by the count, because
 * `stepTerm` RISES with each step -- `crossed x payout(stepsBefore)` would
 * underpay every boundary after the first and `stepsAfter` would overpay the
 * first ones.
 *
 * `shardMult` is REQUIRED rather than defaulting to 1, because the earlier
 * version of this faucet read `crossed * perMilestone` with no multiplier at
 * all -- so four upgrades labelled "shard income" silently missed it while the
 * copy claimed they applied. A required argument means a new award site cannot
 * reintroduce that by forgetting, and a site with no `Stats` must say so aloud.
 */
function awardMilestoneSteps(
  state: GameState,
  tierIndex: number,
  stepsBefore: number,
  stepsAfter: number,
  shardMult: number,
): number {
  if (stepsAfter <= stepsBefore) return 0;
  let base = 0;
  for (let step = stepsBefore; step < stepsAfter; step += 1) {
    base += milestoneStepPayout(tierIndex, step);
  }
  return awardShards(state, base * shardMult);
}

/**
 * Milestone steps banked per tier, in fleet order.
 *
 * The per-tier counterpart of `milestoneStepsTotal`, and it exists because the
 * faucet now pays a different rate on each tier: a single fleet-wide total
 * cannot say WHERE the boundaries were crossed, only how many. Provision grants
 * to every tier at once, so it needs the vector rather than the sum.
 */
export function milestoneStepsByTier(state: GameState, stats?: Stats): number[] {
  return SERVICES.map((service) =>
    milestoneSteps(
      state.services[service.id] ?? 0,
      stats?.milestoneStep[service.id] ?? MILESTONE.step,
    ),
  );
}


/* --------------------------------------------------------------------------
   Automation
   Handled with fractional accumulators so a rate of 2/s does not depend on
   how often the tick happens to land.
   -------------------------------------------------------------------------- */

export interface AutomationCarry {
  deploy: number;
  buy: number;
}

export interface AutomationResult {
  deploys: number;
  buys: number;
}

/** Cheapest service the player could buy right now, by absolute cost. */
function cheapestAffordable(state: GameState, stats: Stats): ServiceDef | null {
  let best: ServiceDef | null = null;
  let bestCost = Infinity;

  for (const service of SERVICES) {
    const ownedCount = state.services[service.id] ?? 0;
    const cost = costOfWith(service, ownedCount, 1, stats);
    if (cost <= state.compute && cost < bestCost) {
      best = service;
      bestCost = cost;
    }
  }

  return best;
}

/**
 * Run automation for a tick. Mutates state and the carry object.
 * Automation deliberately only runs while the tab is open; offline earnings
 * are handled separately by applyOffline.
 */
export function runAutomation(
  state: GameState,
  stats: Stats,
  dtMs: number,
  carry: AutomationCarry,
): AutomationResult {
  const result: AutomationResult = { deploys: 0, buys: 0 };
  if (!Number.isFinite(dtMs) || dtMs <= 0) return result;

  const seconds = dtMs / 1000;

  if (stats.autoDeployRate > 0) {
    carry.deploy += stats.autoDeployRate * seconds;
    const whole = Math.floor(carry.deploy);
    if (whole > 0) {
      carry.deploy -= whole;
      /* Same award as clicking, but without the click-count side effects:
         automated deploys should not unlock click achievements.

         The AMOUNT is not the same, though: automation shards a share of
         production rather than `clickPower`, so it cannot inherit the click
         tree's multipliers. See `CLICK.autoDeployShare`. */
      credit(state, stats.autoDeployValue * whole);
      result.deploys = whole;
    }
  }

  if (stats.autoBuyRate > 0) {
    carry.buy += stats.autoBuyRate * seconds;
    const whole = Math.floor(carry.buy);
    if (whole > 0) {
      carry.buy -= whole;
      /*
       * The per-unit price ceiling that holds total auto-buy spend to
       * `CLICK.autoBuyBudget` of production per second. Derived from the rate
       * rather than fixed, because the drain is `rate x price`: a per-unit cap
       * alone would still let a high rate spend everything. See the constant
       * for why the surplus exists at all.
       */
      const unitBudget =
        (stats.perSecond * CLICK.autoBuyBudget) / stats.autoBuyRate;
      for (let i = 0; i < whole; i++) {
        const target = cheapestAffordable(state, stats);
        if (target === null) break;
        const targetOwned = state.services[target.id] ?? 0;
        /* Expensive relative to production: stop, and let the balance build
           toward a tier worth saving for. */
        if (costOfWith(target, targetOwned, 1, stats) > unitBudget) break;
        if (!buyService(state, target.id, 1, stats)) break;
        result.buys += 1;
      }
    }
  }

  return result;
}

/* --------------------------------------------------------------------------
   Actions
   -------------------------------------------------------------------------- */

/**
 * Perform a manual deploy. Mutates state.
 * Returns the compute granted, so the UI can show a floating number.
 */
export function manualDeploy(state: GameState, stats: Stats): number {
  const amount = stats.clickPower;
  credit(state, amount);
  state.clicks += 1;
  return amount;
}

/**
 * Buy units of one service. Mutates state.
 * Returns true when the purchase went through.
 *
 * `stats` is optional so the pure cost helpers stay usable without one, but
 * every real call site passes it: without it the run's cost multiplier would
 * be ignored. `quoteBuyWith` is the single place that
 * applies the multiplier, so the UI's displayed price and the charged price
 * cannot disagree.
 */
export function buyService(
  state: GameState,
  serviceId: string,
  quantity: BuyQuantity,
  stats?: Stats,
): boolean {
  const def = SERVICE_BY_ID[serviceId];
  if (!def) return false;

  const ownedCount = state.services[serviceId] ?? 0;
  const { count, cost } = quoteBuyWith(def, ownedCount, quantity, state.compute, stats);

  if (count <= 0 || !Number.isFinite(cost) || cost > state.compute) return false;

  state.compute -= cost;

  /*
   * Milestone crossings, counted BEFORE ownership moves so the award is the
   * boundaries THIS purchase bought rather than the tier's standing total.
   *
   * The step comes from `stats.milestoneStep` rather than `MILESTONE.step`,
   * because a `milestoneStep` upgrade gives this tier a different cadence and
   * counting against the base step would pay for boundaries that no longer
   * exist.
   *
   * `stats?.shardMult ?? 1` is the only place in this file that has to guess,
   * and it can only be reached by calling this without a `Stats` -- which every
   * production call site avoids (the UI passes the rendered one, automation
   * and the progression harness pass theirs). A missing `Stats` awards the
   * BASE rate rather than zero, so the failure mode is a smaller payout and
   * not a silent one.
   */
  const step = stats?.milestoneStep[serviceId] ?? MILESTONE.step;
  const stepsBefore = milestoneSteps(ownedCount, step);
  state.services[serviceId] = ownedCount + count;
  awardMilestoneSteps(
    state,
    TIER_INDEX.get(serviceId) ?? 0,
    stepsBefore,
    milestoneSteps(ownedCount + count, step),
    stats?.shardMult ?? 1,
  );

  return true;
}

/**
 * Resolve a purchase request into an actual unit count and its cost, with
 * the run's cost multiplier applied.
 *
 * The multiplier is applied once to the summed total rather than per unit,
 * so a x10 buy and ten x1 buys cost the same.
 */
export function quoteBuyWith(
  def: ServiceDef,
  ownedCount: number,
  quantity: BuyQuantity,
  compute: number,
  stats?: Stats,
): { count: number; cost: number } {
  if (stats === undefined) return quoteBuy(def, ownedCount, quantity, compute);

  const count =
    quantity === 'max'
      ? maxAffordableWith(def, ownedCount, compute, stats)
      : quantity;
  return { count, cost: costOfWith(def, ownedCount, count, stats) };
}

/**
 * How many upgrades belong to a single tier rather than to the shop.
 *
 * Derived from the content rather than written as 32: `upgradeCost` indexes
 * the SHOP table by `rung - this`, so a literal here would silently reprice
 * every shop row the day a tier gains or loses an upgrade.
 */
const PER_TIER_UPGRADE_COUNT = UPGRADES.filter(
  (upgrade) => upgrade.effect.serviceId !== undefined,
).length;

/**
 * What an upgrade costs, in shards.
 *
 * TWO LADDERS, TWO TABLES, and which one applies is decided by whether the
 * upgrade belongs to a tier. They are different ladders with different
 * escalations -- a per-tier row is paced by how deep the fleet is, a shop row
 * by how far through the shop the player is -- and one shared table forced
 * every boundary to serve both at once, which is why the boundaries kept
 * moving. See `SHARDS.tierBands` and `SHARDS.globalBands`.
 *
 * A CAPSTONE (the fourth upgrade of a tier) takes its OWN tier's row
 * `capstone` price rather than its `base` price, so it always out-prices the
 * next tier's entry. Its rung cannot express that: a tier's four upgrades are
 * consecutive rungs, so they would share a price and the game-changer would
 * cost the same as the tier's first purchase.
 *
 * The SHOP is indexed by POSITION in the global list rather than by rung,
 * because the rung sequence is shared with the per-tier ladder. Indexing the
 * shop by a number the other ladder also consumes is what let a per-tier
 * renumbering silently reprice the shop.
 */
export function upgradeCost(upgrade: UpgradeDef): number {
  /* The per-row override, which is the exception to both tables. See
     `UpgradeDef.price` for why it exists and why it is rare. */
  if (upgrade.price !== undefined) return upgrade.price;

  const tierBands = SHARDS.tierBands;

  if (upgrade.effect.serviceId !== undefined) {
    const depth = SERVICES.findIndex((service) => service.id === upgrade.effect.serviceId);
    const row = tierBands[depth < 0 ? 0 : depth] ?? tierBands[tierBands.length - 1];
    if (row === undefined) return 0;
    return upgrade.capstone ? row.capstone : row.base;
  }

  /*
   * Position within the GLOBAL ladder. `PER_TIER_UPGRADE_COUNT` is derived
   * from the content rather than written as 32, so adding or removing a tier
   * cannot silently shift every shop price by one band.
   */
  const position = upgrade.rung - PER_TIER_UPGRADE_COUNT;
  const bands = SHARDS.globalBands;
  const band = bands.find((entry) => position <= entry.through);
  const resolved = band ?? bands[bands.length - 1];
  return resolved === undefined ? 0 : resolved.cost;
}

/**
 * True when the player can afford an upgrade right now.
 *
 * Kept next to `buyUpgrade` so the button's disabled state and the charge
 * cannot disagree about the price or the balance.
 */
export function canAffordUpgrade(state: GameState, upgradeId: string): boolean {
  const upgrade = UPGRADE_BY_ID[upgradeId];
  if (!upgrade) return false;
  if (state.upgrades.includes(upgradeId)) return false;
  return state.shards >= upgradeCost(upgrade);
}

/**
 * Buy a one-time upgrade with SHARDS. Mutates state.
 *
 * Shards, not compute: compute buys services, and the two currencies are kept
 * to one sink each so that each one's income shape matches the shape of what
 * it buys. See the SHARDS block in content.ts for why that matters.
 */
export function buyUpgrade(state: GameState, upgradeId: string): boolean {
  const upgrade = UPGRADE_BY_ID[upgradeId];
  if (!upgrade) return false;
  if (state.upgrades.includes(upgradeId)) return false;

  const cost = upgradeCost(upgrade);
  if (state.shards < cost) return false;

  state.shards -= cost;
  state.upgrades.push(upgradeId);
  return true;
}

/* --------------------------------------------------------------------------
   Reboot (prestige)
   -------------------------------------------------------------------------- */

/**
 * Cores that a Reboot right now would award. Zero below the threshold.
 *
 * `coreGainMult` is passed in from the stats rather than re-derived, so this
 * stays cheap enough to call on every render.
 */
export function prestigeCores(state: GameState, coreGainMult = 1): number {
  if (state.runEarned < PRESTIGE.threshold) return 0;
  const raw = Math.pow(state.runEarned / PRESTIGE.threshold, PRESTIGE.exponent);
  return Math.max(0, Math.floor(raw * coreGainMult));
}

/**
 * Everything the UI needs to state a run's prestige position concretely: the
 * cores a Reboot would award now, and the compute at either end of the band
 * that award sits in.
 *
 * `nextAt` is SOLVED rather than assumed to be `PRESTIGE.threshold`, because
 * cores grow with the square root of the run: the 2nd core needs 4x the
 * threshold, the 3rd needs 9x, the 10th needs 100x. A bar pinned to the
 * threshold therefore reads 100% for the entire time it takes to earn
 * everything after the first core -- it is structurally incapable of showing
 * progress, which is the bug this exists to fix.
 *
 * `coreGainMult` is applied before the floor, matching `prestigeCores`, so
 * the boundary reported here is exactly the one that function will cross.
 * Both ends are clamped to `PRESTIGE.threshold` because that value is a
 * GATE, not just a scale: below it a Reboot is refused outright, so the
 * first core cannot be earned early however large the bonus is.
 */
export function prestigeWindow(
  state: GameState,
  coreGainMult = 1,
): { gain: number; prevAt: number; nextAt: number } {
  const gain = prestigeCores(state, coreGainMult);
  /* A zero or negative multiplier would make the boundary unsolvable rather
     than merely large, so it falls back to the neutral value. */
  const mult = coreGainMult > 0 ? coreGainMult : 1;

  const need = (cores: number): number =>
    PRESTIGE.threshold * Math.pow(cores / mult, 1 / PRESTIGE.exponent);

  return {
    gain,
    /* Zero, not the threshold: a run with no core yet has come from nothing. */
    prevAt: gain === 0 ? 0 : Math.max(PRESTIGE.threshold, need(gain)),
    nextAt: Math.max(PRESTIGE.threshold, need(gain + 1)),
  };
}

/**
 * Reboot: reset the run, keep cores, achievements and lifetime stats. Mutates
 * state. Returns the number of cores gained.
 *
 * Completed contracts are CASHED IN FIRST, and this is load-bearing rather
 * than a convenience. `prestigeCores` measures `runEarned`, and `credit()` is
 * what adds a contract's payout to it -- so a completed but UNCLAIMED contract
 * contributes nothing to the cores it is worth, and the run is emptied on the
 * other side of this call. Collecting here means the payout reaches the core
 * calculation, rather than the player losing cores silently for not having
 * pressed Claim in the right order.
 */
export function applyReboot(state: GameState, coreGainMult = 1): number {
  if (contractViews(state).some((view) => view.complete)) {
    /* Pre-reboot stats: the run is about to be emptied, so this is the last
       moment the payout can be measured against the production that earned
       it. `fillContracts` issues fresh work for the emptied slots. */
    collectContracts(state, computeStats(state));
  }

  const gain = prestigeCores(state, coreGainMult);
  if (gain < 1) return 0;

  state.cores += gain;
  state.reboots += 1;
  state.compute = 0;
  state.runEarned = 0;
  state.services = {};
  state.upgrades = [];

  /*
   * Hand back the offer allowance the emptied slots had spent.
   *
   * `ui.ts` clears `state.contracts` on a Reboot because the reset breaks the
   * baselines of the three metrics it resets (`services`, `milestones`,
   * `upgrades`), so the panel has to be re-drawn from scratch. Those are NOT
   * new work the player earned -- they are replacements for cards the reset
   * invalidated -- so charging them to the offer budget would leave the panel
   * empty for minutes after every prestige, which reads as the feature being
   * broken.
   *
   * Refunding exactly what the cleared panel had spent keeps the budget
   * meaningful (a Reboot cannot be used to FARM contracts: it returns the same
   * number it removes) while keeping the panel full across the transition.
   *
   * The amount is `CONTRACTS.active` because that is what `ui.ts` refills with
   * -- it calls `fillContracts(state, CONTRACTS.active)` after the reset,
   * deliberately not the upgraded slot count. The two must agree; if the
   * refill ever moves to the upgraded count, this has to move with it.
   */
  state.contractsIssued = Math.max(0, state.contractsIssued - CONTRACTS.active);

  /* clicks, totalEarned, playtime, offline stats, achievements, shards,
     contracts and the RNG counters all persist. */
  return gain;
}

/* --------------------------------------------------------------------------
   Progress
   -------------------------------------------------------------------------- */

/** Advance the simulation by a wall-clock delta in milliseconds. Mutates state. */
export function advance(state: GameState, dtMs: number, stats: Stats): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return;
  credit(state, stats.perSecond * (dtMs / 1000));
  state.playtime += dtMs;
}

export interface OfflineResult {
  /** Real time elapsed, uncapped. */
  elapsedMs: number;
  /** Time actually credited. */
  creditedMs: number;
  earned: number;
}

/**
 * Credit production for time spent away. Mutates state.
 *
 * Returns null when there is nothing to award. The elapsed value is clamped
 * and validated so a system-clock change cannot inject a negative or absurd
 * amount, and `lastSavedAt` is moved forward so a failed save cannot cause
 * the same away-time to be credited twice.
 */
export function applyOffline(
  state: GameState,
  stats: Stats,
  now: number,
): OfflineResult | null {
  const elapsedMs = now - state.lastSavedAt;
  state.lastSavedAt = now;

  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (stats.perSecond <= 0) return null;

  const creditedMs = Math.min(elapsedMs, stats.offlineCapMs);

  /*
   * Summed per tier rather than `perSecond * efficiency`, because a
   * `serviceOffline` upgrade lifts ONE tier to full rate. With no such
   * upgrade every rate equals `stats.offlineEfficiency`, so this reduces
   * exactly to the old single-multiplication figure.
   */
  const seconds = creditedMs / 1000;
  let earned = 0;
  for (const service of SERVICES) {
    const rate =
      stats.offlineEfficiencyPerService[service.id] ?? stats.offlineEfficiency;
    earned += (stats.perService[service.id] ?? 0) * seconds * rate;
  }

  if (!Number.isFinite(earned) || earned <= 0) return null;

  credit(state, earned);

  /* Only count a genuine return, not a fast refresh. */
  if (creditedMs >= OFFLINE.minReturnMs) {
    state.offlineReturns += 1;
    state.totalOfflineEarned += earned;
  }

  return { elapsedMs, creditedMs, earned };
}

/* --------------------------------------------------------------------------
   Achievements
   -------------------------------------------------------------------------- */

/**
 * Unlock any newly satisfied achievements. Mutates state.
 * Returns the ids unlocked by this call so the UI can announce them.
 */
export function checkAchievements(state: GameState, stats: Stats): string[] {
  const unlocked: string[] = [];

  for (const achievement of ACHIEVEMENTS) {
    if (state.achievements.includes(achievement.id)) continue;
    let passed = false;
    try {
      passed = achievement.test(state, stats);
    } catch {
      /* A broken predicate must never break the render loop. */
      passed = false;
    }
    if (passed) {
      state.achievements.push(achievement.id);
      unlocked.push(achievement.id);
    }
  }

  return unlocked;
}

/* --------------------------------------------------------------------------
   Visibility helpers used by the UI
   -------------------------------------------------------------------------- */

/** Upgrades that should be listed: already bought, or currently revealed. */
export function visibleUpgrades(state: GameState, stats: Stats): UpgradeDef[] {
  return UPGRADES.filter((upgrade) => {
    if (state.upgrades.includes(upgrade.id)) return true;
    try {
      return upgrade.reveal(state, stats);
    } catch {
      return false;
    }
  });
}
