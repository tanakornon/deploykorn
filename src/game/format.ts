/* ==========================================================================
   Number and duration formatting.

   Pure functions with no DOM access, ASCII-only output.

   One-way dependency: this file reads the content lookup tables, and
   content.ts never imports it.
   ========================================================================== */

import { ABILITY_BY_ID, CLICK, CURVE, MATURE_UNITS, MILESTONE, RARITY_LABELS, SERVICE_BY_ID } from './content';
import type { ConceptId } from './concepts';
import type { AchievementReward, ContractDef, UpgradeDef } from './types';

/** Short-scale suffixes up to 10^35, then exponential notation beyond. */
const SUFFIXES = [
  '',
  'K',
  'M',
  'B',
  'T',
  'Qa',
  'Qi',
  'Sx',
  'Sp',
  'Oc',
  'No',
  'Dc',
] as const;

/**
 * Strip trailing zeros, but only after a decimal point: an unanchored
 * `/0+$/` would turn "100" into "1".
 */
function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/**
 * Format a quantity for display. Below 1000 the value is plain, with no
 * grouping: grouped digits beside suffixes look inconsistent in a monospace
 * column.
 */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '0';

  const negative = value < 0;
  const abs = Math.abs(value);
  let out: string;

  if (abs < 1000) {
    const places = abs < 10 && decimals < 2 ? decimals + 1 : decimals;
    out = trimTrailingZeros(abs.toFixed(places));
  } else {
    let tier = Math.floor(Math.log10(abs) / 3);
    tier = Math.min(tier, SUFFIXES.length - 1);

    let scaled = abs / Math.pow(1000, tier);

    /* Rounding must not produce "1000K" instead of "1.00M". */
    if (scaled >= 999.995 && tier < SUFFIXES.length - 1) {
      tier += 1;
      scaled = abs / Math.pow(1000, tier);
    }

    const places = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
    out = `${scaled.toFixed(places)}${SUFFIXES[tier]}`;
  }

  return negative ? `-${out}` : out;
}

/** Rates keep one decimal until they are large enough to look noisy. */
export function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 10) return trimTrailingZeros(value.toFixed(2));
  if (value < 1000) return Math.floor(value).toString();
  return formatNumber(value);
}

/**
 * A multiplier for display: two decimals below 100, then the suffixed form.
 *
 * Milestone bonuses are FRACTIONAL, so the value is not a whole number:
 * 2.25^4 is 25.62890625. Two decimals matches the fleet multiplier.
 */
export function formatMultiplier(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0x';
  return value < 100 ? `${value.toFixed(2)}x` : `${formatNumber(value)}x`;
}

/**
 * A shard price, as a plain integer below 10,000.
 *
 * Deliberately does not use the K/M suffixes: upgrade prices are a short,
 * fixed set of bands and are meant to be RECOGNISED. `formatNumber` would
 * render 1000 as "1.00K", a different string to the one the price table
 * declares.
 */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const whole = Math.floor(value);
  return whole < PRICE_PLAIN_MAX ? whole.toString() : formatNumber(whole);
}

/** Above this a price falls back to the suffixed form. */
const PRICE_PLAIN_MAX = 10_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45s", "12m 30s", "3h 20m", "2d 4h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';

  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.floor((ms % MINUTE) / 1000);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Percentage with at most one decimal, e.g. "37.5%". */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  const pct = fraction * 100;
  const out = pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
  return `${out.replace(/\.0$/, '')}%`;
}

/* --------------------------------------------------------------------------
   Achievement reward labels
   -------------------------------------------------------------------------- */

/** A multiplier expressed as a signed percentage gain: 1.25 becomes "+25%". */
function gain(value: number): string {
  const pct = (value - 1) * 100;
  const rounded = pct >= 10 || pct <= -10
    ? Math.round(pct)
    : Math.round(pct * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded}%`;
}

function plain(value: number): string {
  return trimTrailingZeros(value.toFixed(2));
}

function serviceName(serviceId: string | undefined, fallback = 'Tier'): string {
  return serviceId === undefined ? fallback : SERVICE_BY_ID[serviceId]?.name ?? fallback;
}

/**
 * One short label per achievement reward, for the chips on a card.
 *
 * Derived from the reward itself, so a renamed service or a new reward kind
 * cannot leave a stale label on screen.
 */
export function describeReward(reward: AchievementReward): string {
  switch (reward.kind) {
    /*
     * Percent form, not `gain()`. The pool is ADDITIVE, so "+200%" is this
     * card's literal contribution; "x3" would read as a multiplier and invite
     * the player to multiply the cards together, which overstates the total.
     */
    case 'globalBonus':
      return `All output +${Math.round(reward.bonus * 100)}%`;
    case 'clickMult':
      return `Deploys ${gain(reward.value)}`;
    case 'serviceMult':
      return `${SERVICE_BY_ID[reward.serviceId]?.name ?? reward.serviceId} ${gain(
        reward.value,
      )}`;
    case 'offlineCap':
      return `Away cap +${plain(reward.hours)}h`;
    case 'offlineEfficiency':
      return `Away rate ${Math.round(reward.value * 100)}%`;
    case 'boostPower':
      return `Ability power +${plain(reward.value)}x`;
    case 'boostDuration':
      return `Ability length ${gain(reward.value)}`;
    case 'boostCooldown':
      return `Ability cooldown ${gain(reward.value)}`;
    case 'synergy':
      return `Tier synergy +${Math.round(reward.value * 100)}%`;
    case 'milestone':
      return `All milestones x${plain(1 + reward.value)}`;
    case 'contractReward':
      return `Contract pay ${gain(reward.value)}`;
    /*
     * Worded to match the upgrade that grants the same thing, and "deploys"
     * rather than "automation": the rate only feeds the deploy channel.
     */
    case 'autoRate':
      return `${plain(reward.value)}/s deploys`;
    case 'coreGain':
      return `Cores ${gain(reward.value)}`;
    case 'shardGain':
      return `Shards ${gain(reward.value)}`;
    case 'contractSlots':
      return `+${plain(reward.slots)} contract${reward.slots === 1 ? '' : 's'} at once`;
    case 'reserveBonus':
      return `Reserve +${(reward.per * 100).toFixed(1)}% per shard`;
    case 'coreAmplify':
      return `Cores +${Math.round(reward.per * 100)}% stronger`;
    case 'unlockAbility':
      return `Unlocks ${ABILITY_BY_ID[reward.abilityId]?.name ?? reward.abilityId}`;
  }
}

/**
 * The concept a reward chip names, when it names one.
 *
 * A judgement about what the LABEL is about: `clickMult` reads "Deploys x1.5"
 * and is a deploy figure, while `offlineCap` reads "Away cap +4h" and names no
 * concept. Null means the reward is a property, not a quantity.
 */
export function rewardConcept(reward: AchievementReward): ConceptId | null {
  switch (reward.kind) {
    case 'coreGain':
    case 'coreAmplify':
      return 'cores';
    case 'clickMult':
    case 'autoRate':
      return 'deploy';
    case 'globalBonus':
    case 'milestone':
    case 'synergy':
      return 'multiplier';
    case 'shardGain':
    case 'reserveBonus':
      return 'shards';
    /* A contract reward is attributed to contracts, exactly as the matching
       shop row is, so it wears the same rings and hue. */
    case 'contractReward':
    case 'contractSlots':
      return 'contract';
    /* Away time is a quantity in its own right, so both rewards carry the
       clock. */
    case 'offlineCap':
    case 'offlineEfficiency':
      return 'away';
    default:
      return null;
  }
}

/* --------------------------------------------------------------------------
   Upgrade effect labels

   Derived from the upgrade's `effect`, so the badge cannot drift from the
   balance table. The same derivation files the upgrade into a panel group,
   which is why `UpgradeDef` has no `group` field.
   -------------------------------------------------------------------------- */

/** Section of the upgrades panel an upgrade is filed under. */
export type UpgradeGroup =
  | 'deploys'
  | 'services'
  | 'global'
  /**
   * Everything the fleet does on its own: auto-DEPLOY (creates compute) and
   * auto-BUY (spends it), sharing one section so the two ladders read as one
   * investment.
   *
   * Sharing a HEADING does not merge the channels: the two remain separate
   * effect kinds fed from separate sources in engine.ts, so an auto-deploy
   * effect still cannot spend anything.
   */
  | 'automation'
  | 'offline'
  /**
   * The shard economy in one section: what contracts PAY OUT (`shardGain`) and
   * what the balance you are HOLDING is worth (`reserveBonus`).
   *
   * `coreAmplify` used to be the third member, when a core multiplied the
   * reserve bonus. Cores are a fleet-wide FINAL multiplier now, so it files
   * under `global` -- leaving it here would preserve the misconception that
   * change removed.
   */
  | 'reserve';

export interface EffectSummary {
  /** Badge text, e.g. "x2 Workers". */
  text: string;
  /** Which section of the upgrades panel this belongs in. */
  group: UpgradeGroup;
  /**
   * The concept this badge states a quantity OF, when it names one.
   *
   * Set only where a named quantity is the SUBJECT: "Contract shards x1.5" is
   * a shard figure and takes the shard glyph, while "+2% output per unit
   * owned" names nothing and stays plain.
   *
   * `fleet` covers the badges that count the fleet's shape -- units owned,
   * tiers deployed, a tier's share. Absent means no concept, not "plain is
   * fine".
   */
  concept?: ConceptId;
}

/** A multiplier as "x2" or "x1.5". */
function times(value: number): string {
  return `x${trimTrailingZeros(value.toFixed(2))}`;
}

/**
 * A contract's objective, in the units the metric is counted in.
 *
 * The objective is COMPUTED when a contract is issued, so it cannot be
 * authored on the card and must be rendered from the stored target.
 *
 * Takes the DEF rather than the bare metric, because three metrics have a
 * SUBJECT that has to appear in the sentence: "Buy 12 more Caches" and "Use
 * Surge twice" are only actionable because they name the row and the button.
 */
export function contractObjective(target: number, def: ContractDef): string {
  const n = formatNumber(target);
  const one = target === 1;
  switch (def.metric) {
    case 'clicks':
      return `Perform ${n} manual ${one ? 'deploy' : 'deploys'}`;
    case 'services':
      /* The objective CAN be 1: a scaled objective is clamped to a minimum of
         one. */
      return `Bring ${n} more ${one ? 'service' : 'services'} online`;
    case 'totalEarned':
      return `Earn ${n} more compute`;
    case 'milestones':
      /* The milestone metric is COARSE -- a milestone is 25 units -- so scaled
         objectives round to 1 whenever production is modest. */
      return `Cross ${n} more ${one ? 'milestone' : 'milestones'}`;
    case 'upgrades':
      return `Buy ${n} more ${one ? 'upgrade' : 'upgrades'}`;
    case 'tierUnits': {
      /* The tier's NAME is the whole reason this metric exists: the player has
         to know which row to deepen. */
      const tier = def.serviceId === undefined ? undefined : SERVICE_BY_ID[def.serviceId];
      const name = tier?.name ?? 'service';
      return `Buy ${n} more ${name}${one ? '' : 's'}`;
    }
    case 'tierOwned': {
      const tier = def.serviceId === undefined ? undefined : SERVICE_BY_ID[def.serviceId];
      return `Deploy your first ${tier?.name ?? 'service'}`;
    }
    case 'abilityUses': {
      const ability = def.abilityId === undefined ? undefined : ABILITY_BY_ID[def.abilityId];
      const name = ability?.name ?? 'ability';
      return `Use ${name} ${n} ${one ? 'time' : 'times'}`;
    }
  }
}

/**
 * A per-unit rate as a percentage, with enough precision for tiny rates: a
 * Worker upgrade grants a fraction of a percent PER UNIT, and whole-percent
 * rounding turns "+0.01%" into "+0%", which reads as doing nothing.
 */
function ratePercent(fraction: number): string {
  const pct = fraction * 100;
  /* One decimal above 1%: the reserve upgrades grant 1.5%, and rounding that
     to 2% overstates the purchase by a third. */
  if (pct >= 1) return `${trimTrailingZeros((Math.round(pct * 10) / 10).toFixed(1))}%`;
  if (pct >= 0.1) return `${(Math.round(pct * 10) / 10).toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

function describeEffectInner(def: UpgradeDef): EffectSummary {
  const effect = def.effect;
  switch (effect.kind) {
    case 'serviceMult':
      return {
        text: `${times(effect.mult ?? 1)} ${
          SERVICE_BY_ID[effect.serviceId ?? '']?.name ?? effect.serviceId ?? 'service'
        }`,
        group: 'services',
      };
    case 'globalMult':
      return {
        text: `${times(effect.mult ?? 1)} all output`,
        group: 'global',
        concept: 'multiplier',
      };
    /*
     * The additive global. Shown as a PERCENTAGE, not a multiplier, and the
     * distinction is load-bearing: additive cards SUM, so a `x2` reading would
     * invite the player to multiply them together and overstate the total.
     * This is the same convention the achievement `globalBonus` chip already
     * uses (`All output +25%`), which is the point -- the two are one pool.
     */
    case 'globalAdd':
      return {
        text: `All output +${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'global',
        concept: 'multiplier',
      };
    case 'clickMult':
      return {
        text: `${times(effect.mult ?? 1)} deploys`,
        group: 'deploys',
        concept: 'deploy',
      };
    /* Percentage, not a factor: additive cards SUM, so a `x` reading would
       invite the player to multiply them together and overstate the total. */
    case 'clickAdd':
      return {
        text: `Deploys +${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'deploys',
        concept: 'deploy',
      };
    /*
     * Stated in SECONDS, because that is the only honest unit here: the share
     * IS a duration -- 0.1 means one deploy is worth a tenth of a second of the
     * fleet's production. A percentage would be wrong twice over: the share
     * sizes the throughput term rather than the finished click, and it is ADDED
     * to `CLICK.throughputShare` rather than applied to anything. The click
     * tree that multiplies the result is what makes the real figure large, and
     * it is deliberately not restated here.
     */
    case 'throughputShare':
      return {
        text: `Deploys +${(effect.per ?? 0).toFixed(1)}s production`,
        group: 'deploys',
        concept: 'deploy',
      };
    case 'shardAdd':
      return {
        text: `Shards +${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'reserve',
        concept: 'shards',
      };
    case 'contractRewardAdd':
      return {
        text: `Contract pay +${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'global',
        concept: 'contract',
      };
    /* A DISCOUNT, so the label carries a minus sign and the magnitude is what
       the row adds to the pool. `gain()` would read the same here but also
       accepts a neutering 0%; the explicit form says what the direction is. */
    case 'costAdd':
      return {
        text: `All units cost -${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'global',
        concept: 'compute',
      };
    case 'autoDeploy':
      return {
        /*
         * States the VALUE, not just the rate. An automated deploy shards a
         * share of production rather than the click amount, so "1/s deploys"
         * described the mechanism without saying what it was worth -- and with
         * the rate alone a player cannot tell whether this is a big upgrade or
         * a rounding error.
         */
        text: `${plain(effect.rate ?? 0)}/s deploys · +${Math.round(
          (effect.rate ?? 0) * CLICK.autoDeployShare * 100,
        )}% production`,
        group: 'automation',
        concept: 'deploy',
      };
    case 'autoBuy':
      return {
        text: `${plain(effect.rate ?? 0)}/s units`,
        group: 'automation',
        concept: 'fleet',
      };
    case 'offlineCap':
      return {
        text: `+${plain(effect.hours ?? 0)}h away cap`,
        group: 'offline',
        concept: 'away',
      };
    case 'offlineEfficiency':
      return {
        text: `${Math.round((effect.value ?? 0) * 100)}% away rate`,
        group: 'offline',
        concept: 'away',
      };
    /* The four per-tier mechanisms. All file under 'services', because each
       one lives in the card of the tier it names -- the same destination the
       plain `serviceMult` upgrades use.
       `globalPerOwned` is the exception: with no `serviceId` it counts units
       of every tier, so it is a shop-wide upgrade and files under 'global'.
       Filing it with the tier upgrades would put a fleet-wide effect inside
       one service's card, which reads as a tier upgrade that is not one. */
    case 'globalPerOwned':
      return effect.serviceId === undefined
        ? {
            text: `+${ratePercent(effect.per ?? 0)} all output per unit owned · max +${Math.round(
              (effect.cap ?? 0) * 100,
            )}%`,
            group: 'global',
            concept: 'multiplier',
          }
        : {
            text: `+${ratePercent(effect.per ?? 0)} all output per ${
              serviceName(effect.serviceId, 'unit')
            } · max +${Math.round((effect.cap ?? 0) * 100)}%`,
            group: 'services',
            concept: 'multiplier',
          };
    case 'milestoneStep':
      return {
        text: `${serviceName(effect.serviceId)} doubles every ${Math.max(
          1,
          MILESTONE.step - (effect.reduce ?? 0),
        )} · was ${MILESTONE.step}`,
        group: 'services',
      };
    case 'serviceCost':
      return {
        text: `${serviceName(effect.serviceId)} units cost ${gain(effect.mult ?? 1)}`,
        group: 'services',
      };
    case 'serviceAdd':
      /* Percentage, not a factor -- additive per-tier cards SUM with any
         achievement `serviceMult` on the same tier, so a `x` reading would
         overstate. Same convention as `globalAdd` and `globalBonus`. */
      return {
        text: `${serviceName(effect.serviceId)} +${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'services',
      };
    case 'serviceMilestone':
      /* The engine MULTIPLIES the tier's finished milestone factor, so the
         bonus is a factor on the result (`2^steps x (1 + bonus)`), not an
         addition to the base. The badge states the factor, matching
         `milestoneMultiplier()`; a `(2 + bonus)^steps` reading would describe
         a growth-rate change the engine deliberately does not implement. */
      return {
        text: `${serviceName(effect.serviceId)} milestones x${plain(
          1 + (effect.bonus ?? 0),
        )} stronger`,
        group: 'services',
      };
    case 'serviceClick':
      return {
        text: `${serviceName(effect.serviceId)} adds +${Math.round(
          (effect.mult ?? 0) * 100,
        )}% to deploys`,
        group: 'services',
        concept: 'deploy',
      };
    case 'serviceOffline':
      return {
        text: `${serviceName(effect.serviceId)} runs at full rate while away`,
        group: 'services',
      };
    case 'serviceAutoDeploy': {
      /*
       * Stated as "1/s per N units" rather than as the raw per-unit rate, and
       * that is a legibility choice rather than an arbitrary one: `0.02/s per
       * Worker` is a figure a player has to divide in their head to picture
       * ("so 50 Workers is 1/s"), while "per 50 Workers" is the unit they are
       * already counting the tier in. `milestoneStepPayout`'s badge states its
       * rate per 1,000 shards for the same reason.
       *
       * The production figure goes through `CLICK.autoDeployShare` because that
       * is what the engine pays -- an automated deploy is a share of production
       * rather than a click, so quoting anything else would be a second,
       * wrong number on the card.
       */
      const per = effect.per ?? 0;
      const cap = effect.cap ?? 0;
      const perUnits = per > 0 ? Math.round(1 / per) : 0;
      return {
        text: `+1/s deploy per ${formatNumber(perUnits)} ${
          serviceName(effect.serviceId)
        }s · up to +${Math.round(cap * CLICK.autoDeployShare * 100)}% production`,
        group: 'services',
        concept: 'deploy',
      };
    }
    /*
     * Each tier's SECOND signature. Eight mechanisms that all scale one
     * tier's output, but each by a different quantity. The wording below is
     * load-bearing, not decoration: every one of these must be textually
     * distinguishable from the other seven AND from the first signature on
     * its own tier, or the row is a duplicate to the player regardless of how
     * different the code is. Note each names the axis it counts -- "per
     * deployed tier", "fleet-wide", "of the fleet" -- because that axis is
     * the only thing separating them.
     */
    case 'serviceCurve':
      return {
        text: `${serviceName(effect.serviceId)} gains an extra ${times(effect.mult ?? 1)} every ${CURVE.step} units · max ${times(
          effect.cap ?? 1,
        )}`,
        group: 'services',
      };
    case 'servicePerOwned':
      return {
        text: `Each ${serviceName(effect.serviceId)} adds +${ratePercent(effect.per ?? 0)} to its own output · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
      };
    case 'serviceThroughput':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} output per unit owned fleet-wide · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'fleet',
      };
    case 'serviceDepth':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} output per deployed tier · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'fleet',
      };
    case 'serviceDeployPerOwned':
      /*
       * The TARGET leads the badge, not the counter.
       *
       * `worker-3` on the same card is `globalPerOwned` scaled by the same
       * quantity at the same rate, so a badge reading "Each Worker adds +0.5%
       * ..." on both rows would make two different purchases look like one
       * stated twice. Leading with what the bonus applies TO ("Deploy power"
       * against worker-3's "All output") makes the pair legible at a glance
       * while both counters stay honest about what they are counting.
       *
       * A per-unit rate that IS legible, unlike the compute-denominated rows:
       * the quantity is a unit count in the hundreds, so `per: 0.005` reads as
       * `+0.5%` and never rounds to zero.
       *
       * `concept: 'deploy'`, because the subject is the deploy rather than the
       * tier's output. The figure is a bonus to `clickPower`, which is the
       * HUD's "Per deploy" chip, so it carries that chip's hue.
       */
      return {
        text: `Deploy power +${ratePercent(effect.per ?? 0)} per ${serviceName(
          effect.serviceId,
        )} · max ${times(1 + (effect.cap ?? 0))}`,
        group: 'services',
        concept: 'deploy',
      };
    case 'serviceMatureTiers':
      /*
       * The figure is stated against `MATURE_UNITS` rather than as a bare
       * rate, because "per mature tier" means nothing until the player knows
       * what makes a tier mature -- and that threshold is also the last
       * upgrade reveal, so naming it here is the only place the two are tied
       * together in words.
       */
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per tier holding ${MATURE_UNITS}+ units · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'fleet',
      };
    case 'serviceShardsEarned':
      /*
       * Stated per 1,000 shards, matching `serviceShardsSpent` below and the
       * row's own blurb.
       *
       * Per SHARD the rate is `0.0004`, i.e. `0.04%`, which is legible but
       * reads as a rounding error next to its own "up to +150%". The blurb on
       * this card has always said "for every 1,000 shards you have ever
       * earned", so the badge was the surface out of step. The two shard rows
       * are a deliberate pair and must state their rate in the same unit, or
       * the pair does not read as a pair.
       */
      return {
        text: `${serviceName(effect.serviceId)} output +${ratePercent(
          (effect.per ?? 0) * 1000,
        )} per 1,000 shards ever earned · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'shards',
      };
    case 'serviceReboots':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per reboot · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'reboots',
      };
    case 'serviceRarity':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per ${RARITY_LABELS[
          effect.rarity ?? 'bronze'
        ].toLowerCase()} achievement · max ${times(1 + (effect.cap ?? 0))}`,
        group: 'services',
        concept: 'achievements',
      };
    case 'serviceAbilityUses':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per ability use · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
      };
    case 'serviceReturns':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per return from being away · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'away',
      };
    case 'serviceShardsSpent':
      /*
       * Stated per THOUSAND shards, not per shard.
       *
       * The real rate is `0.00006` per shard, which is 0.006% -- exactly the
       * value `ratePercent` rounds to `+0.01%`, and a badge reading
       * `+0.01% per shard spent` is the same "reads as nothing" defect the
       * hand-deploy row was removed for. Scaling the unit up puts the figure
       * back in the range the formatter is built for.
       */
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(
          (effect.per ?? 0) * 1000,
        )} per 1,000 shards spent · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'shards',
      };
    case 'serviceShare':
      return {
        text: `${serviceName(effect.serviceId)} output grows with its share of the fleet · max ${times(effect.cap ?? 1)}`,
        group: 'services',
        concept: 'fleet',
      };
    case 'serviceGlobalShare':
      return {
        text: `${serviceName(effect.serviceId)} share of the fleet adds to ALL output · max +${Math.round((effect.cap ?? 0) * 100)}%`,
        group: 'services',
        concept: 'fleet',
      };
    /* Labels should name the tier and the quantity they scale, not a different tier or a vague shared effect. */
    case 'serviceParity':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per evenly-sized tier · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'fleet',
      };
    case 'serviceUpgrades':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per upgrade owned · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
      };
    case 'serviceContracts':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per contract completed · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
      };
    case 'serviceFleetMilestones':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per milestone banked fleet-wide · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'fleet',
      };
    /*
       "per shard held" is now ambiguous: shards held ALSO produce globally
       through the reserve, so an unqualified phrase reads as that mechanic
       rather than as this tier-only one. Naming the tier as the subject and
       the effect as "output" keeps the two apart -- this is the tier getting
       better, the reserve is everything getting better.
    */
    case 'serviceReserve':
      return {
        text: `${serviceName(effect.serviceId)} output +${ratePercent(effect.per ?? 0)} per shard held · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'shards',
      };
    case 'serviceEconomy':
      return {
        text: `${serviceName(effect.serviceId)} gets ${ratePercent(effect.per ?? 0)} cheaper per unit owned · floor ${Math.round(
          (effect.cap ?? 1) * 100,
        )}%`,
        group: 'services',
      };
    case 'serviceCores':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per core held · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'cores',
      };
    case 'serviceAchievements':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per achievement unlocked · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
      };
    case 'servicePosition':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per step up the ladder · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
      };
    case 'serviceLifetime':
      return {
        text: `${serviceName(effect.serviceId)} grows with all compute ever earned · max ${times(1 + (effect.cap ?? 0))}`,
        group: 'services',
      };
    case 'serviceFullStack':
      return {
        text: `${serviceName(effect.serviceId)} ${times(effect.mult ?? 1)} while every tier is deployed`,
        group: 'services',
        concept: 'fleet',
      };
    case 'serviceApex':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} per tier deployed · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'fleet',
      };
    /* The two structural kinds. Both touch contracts, so both file into the
       Global group -- they are no longer tied to a single tier or a single
       panel, and the Contracts panel lists its own payouts. */
    case 'contractSlots':
      return {
        text: `+${plain(effect.slots ?? 0)} contracts at once`,
        group: 'global',
        concept: 'contract',
      };
    case 'shardGain':
      return {
        /* "Shards", not "Contract shards": a contract is the only source of
           shards, so naming it says nothing the word "shards" has not already
           said -- it is a second noun on a badge that reads at a glance. */
        text: `Shards ${times(effect.mult ?? 1)}`,
        group: 'reserve',
        concept: 'shards',
      };
    case 'serviceShardGain':
      return {
        text: `${serviceName(effect.serviceId)} +${ratePercent(effect.per ?? 0)} shards per unit · max ${times(
          1 + (effect.cap ?? 0),
        )}`,
        group: 'services',
        concept: 'shards',
      };
    case 'costMult':
      /*
       * The compute concept, because that is what a unit is BOUGHT with: the
       * badge states a change to the compute price of every tier, so it
       * carries the same bolt the compute chip and every price tag use.
       */
      return {
        text: `All units cost ${gain(effect.mult ?? 1)}`,
        group: 'global',
        concept: 'compute',
      };
    case 'synergy':
      /*
       * Stated as what it DOES rather than as the name of the mechanic.
       * "Tier synergy +75%" was the label and it named a system the player is
       * never taught: synergy in this game means each tier lifts the tier
       * beneath it, so the bonus is a percentage on that lift. Naming the
       * direction is the whole explanation.
       */
      return {
        text: `Each tier boosts the one below it +${Math.round((effect.value ?? 0) * 100)}%`,
        group: 'global',
        concept: 'multiplier',
      };
    case 'milestone':
      /* "x" and not "per step": the reward multiplies a tier's milestone
         result, it does not raise what each individual milestone is worth.
         The old wording promised a change to the exponent, which is what made
         one cheap upgrade worth millions of percent. */
      return {
        text: `All milestone multipliers x${plain(1 + (effect.value ?? 0))}`,
        group: 'global',
        concept: 'multiplier',
      };
    case 'contractReward':
      return {
        text: `Contract pay ${times(effect.value ?? 1)}`,
        group: 'global',
        concept: 'contract',
      };
    /* The reserve kind. Stated as a rate, because that is what it is: it has no
       fixed outcome to report the way a multiplier does, since what it produces
       depends on the balance the player happens to be holding. Naming the
       variable is the honest label -- "per shard held" tells the player which
       number to watch. */
    case 'reserveBonus':
      return {
        text: `+${ratePercent(effect.per ?? 0)} production per held shard`,
        group: 'reserve',
        concept: 'shards',
      };
    /*
       `coreAmplify` files under `global`, not `reserve`, and that is a
       CORRECTNESS fix rather than a tidy-up. It used to sit with the shard
       economy because a core multiplied the reserve bonus; cores are now a
       fleet-wide final multiplier, so the row belongs with the other
       everything-at-once upgrades. Phrased as a rate, because that is what it
       is: it raises the PER-CORE rate and has no fixed outcome to report until
       there are cores to multiply.
    */
    case 'coreAmplify':
      return {
        text: `+${ratePercent(effect.per ?? 0)} production per core`,
        group: 'global',
        concept: 'cores',
      };
  }
}

/*
 * The trailing ceiling claim on a count-driven badge: ` · max x3`.
 *
 * Anchored to the end of the string and to the separator this file writes, so
 * it can only ever remove the clause the badges actually emit. If the
 * separator changes, this stops matching and the softened rows keep their
 * ceiling -- a visible regression rather than a silent one.
 */
const CEILING_CLAIM = / · max [^·]+$/;

/**
 * The badge for an upgrade.
 *
 * Wraps the switch so the CAP RULE lives in one place rather than in every
 * count-driven branch. A HARD cap is a promise -- it is reached by playing, so
 * printing it tells the player what the row tops out at. A SOFT cap is a LIMIT
 * the curve approaches and never touches: it reaches half its cap where the
 * hard cap used to bind, and 90% only at nine times the cap. Printing that as
 * a maximum advertises a figure the game cannot deliver, which is the same
 * defect an unreachable cap has, inverted.
 *
 * So a softened row states its RATE and the bracket it counts, and no ceiling.
 * That is truthful at every scale, and it is why the rate and the bracket are
 * written before the clause rather than after it.
 *
 * `cap === undefined` is stripped for the same reason and is not a special
 * case: a row whose cap was DELETED is one whose quantity is content-bounded
 * (eight tiers, sixty-four upgrades), so there is no authored ceiling to state.
 * Without this, the templates fall back to `1 + (cap ?? 0)` and print
 * `max x1` -- a claim that is not merely unhelpful but false, since those rows
 * reach +200% or more. Two different reasons not to print a number, one test.
 */
export function describeEffect(def: UpgradeDef): EffectSummary {
  const summary = describeEffectInner(def);
  if (def.effect.soft === true || def.effect.cap === undefined) {
    return { ...summary, text: summary.text.replace(CEILING_CLAIM, '') };
  }
  return summary;
}

