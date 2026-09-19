/* ==========================================================================
   GAME CONTENT AND BALANCE

   This is the only file to edit to retune the game; everything else derives
   from it.

   Service cost curve:
     cost(n) = baseCost * costGrowth^owned   (summed over a multi-buy)
   So a tier becomes ~1.15x more expensive per unit bought, keeping each new
   tier meaningfully out of reach until the previous one is scaled up.
   ========================================================================== */

import type {
  AbilityDef,
  AchievementDef,
  AchievementGroup,
  AchievementRarity,
  ContractDef,
  ServiceDef,
  Stats,
  UpgradeDef,
  GameState,
} from './types';

/* --------------------------------------------------------------------------
   Manual deploy
   -------------------------------------------------------------------------- */

export const CLICK = {
  /** Flat compute granted per manual deploy. */
  base: 1,
  /**
   * Plus this share of current throughput per second. The BASE of an
   * upgradeable axis: two shop rows add share points on top, reaching 0.5.
   *
   * At 0.2 one click is worth a fifth of a second of production, so a player
   * clicking four times a second roughly keeps pace with the fleet before
   * investing in anything. The two `throughputShare` rows add 0.1 and 0.2, so
   * the axis runs 0.2 -> 0.5 and a deploy is eventually worth half a second of
   * the fleet's own output.
   *
   * The share is only HALF the click and the smaller half. `clickPower`
   * multiplies this throughput term by the click tree (four shop rows totalling
   * 120x), the achievement `clickMult` pool and the two per-tier channels, so a
   * fully invested click is worth minutes of production rather than the half
   * second this number alone describes. Every figure on a click upgrade's card
   * states the SHARE POINTS it adds, never what the finished click is worth.
   */
  throughputShare: 0.2,
  /**
   * Share of production an AUTOMATED deploy credits, per deploy.
   *
   * Deliberately NOT `clickPower`: the click tree multiplies to 120x, so
   * automation worth a full click would be worth hundreds of times the fleet's
   * production and would grow with `clickMult` upgrades bought for another
   * reason. A share of production bounds automation on its own terms.
   *
   * The rate is 14/s from the shop plus up to 6/s from `worker-4`, so the
   * channel tops out at +300% production -- large, bounded by construction, and
   * independent of the click tree.
   */
  autoDeployShare: 0.15,
  /**
   * The share of production auto-buy may spend on units, per second.
   *
   * Without a ceiling, auto-buy would spend compute the instant it arrived and
   * the balance would never rise above one cheap unit's price, leaving the
   * tiers worth saving for unreachable. At 0.5 it consumes at most half of
   * what the fleet makes and the rest accumulates.
   *
   * The ceiling is on the SPEND RATE rather than the unit price, because the
   * drain is `rate x price` and a fixed price ceiling would not scale with
   * either.
   */
  autoBuyBudget: 0.5,
} as const;

/* --------------------------------------------------------------------------
   Reboot (prestige)
   -------------------------------------------------------------------------- */

export const PRESTIGE = {
  /** Minimum compute earned this run before a Reboot is allowed. */
  threshold: 1e9,
  /**
   * cores = floor(sqrt(runEarned / threshold))
   * Reaching the threshold exactly yields 1 core; 100x the threshold yields 10.
   */
  exponent: 0.5,
  /**
   * Per-core rate of the FINAL fleet multiplier:
   *
   *     coreMult = 1 + (this + any `coreAmplify` upgrades) * cores
   *
   * applied to `perSecond` after every other factor. A core adds no flat
   * production -- it multiplies the whole fleet.
   *
   * Do NOT re-describe it as multiplying the shard reserve. The two used to
   * nest, and that was a defect: a core was diluted by every other factor and
   * was worth nothing at all at zero shards. See `computeStats()`.
   *
   * NOT yet tuned for this model. 0.05 is x2.25 at 25 cores and x16.8 at 316,
   * which is strong, and `check:progression` models no Reboots so it always runs
   * at zero cores. Treat the rate as an open item needing a reboot-aware
   * measurement.
   */
  bonusPerCore: 0.05,
} as const;

/* --------------------------------------------------------------------------
   Offline progress
   -------------------------------------------------------------------------- */

export const OFFLINE = {
  /** Efficiency of production while away. */
  baseEfficiency: 0.5,
  /** Base cap on credited away time, extended by upgrades. */
  baseCapMs: 8 * 60 * 60 * 1000,
  /** A return shorter than this does not count as an "offline return". */
  minReturnMs: 60_000,
} as const;

/* --------------------------------------------------------------------------
   Milestones

   Every `step` units of a tier doubles that tier's own output. This gives a
   reason to deepen a tier rather than always buying the newest one, which is
   what makes the mid-game a decision instead of a straight line.
   -------------------------------------------------------------------------- */

export const MILESTONE = {
  step: 25,
  multiplier: 2,
  /**
   * Most extra doublings a `milestoneStep` upgrade may grant.
   *
   * Reducing the step alone is unbounded: at a step of 20 instead of 25, 1000
   * units is 2^50 rather than 2^40, so a cheap tier eventually dwarfs
   * everything above it. Capping the EXTRA steps turns it into a fixed prize.
   */
  stepBonusMax: 3,
} as const;

/* --------------------------------------------------------------------------
   A mature tier

   Units at which a tier counts as ESTABLISHED, for the `serviceMatureTiers`
   mechanic. It equals the last threshold in `SHARDS.revealAt`, which is not a
   coincidence: a tier that has shown you all four of its upgrades is one you
   have finished, and "finished" is what the breadth reward counts.

   Kept as its own constant rather than reading `SHARDS.revealAt` directly, so
   the two can diverge deliberately -- a deeper reveal gate should not silently
   move what counts as mature.

   Declared HERE, above the UPGRADES array, because `check:ladder` slices the
   upgrade list out of the source file and would be corrupted by an export
   sitting between the array and the UPGRADE_BY_ID map that follows it.

   (That sentence deliberately avoids writing those two declarations out in
   full. The checker searches this file for the literal text, so a comment
   that NAMES them is found before the real thing and the slice collapses to
   nothing. A note explaining the rule must not trip the rule.)
   -------------------------------------------------------------------------- */

export const MATURE_UNITS = 100;

/* --------------------------------------------------------------------------
   Synergy

   Units of a tier boost the tier beneath it. Caps out so a deep top tier
   cannot run away with the whole economy.
   -------------------------------------------------------------------------- */

export const SYNERGY = {
  /** Bonus to the tier below, per unit owned of this tier. */
  perUnit: 0.005,
  /** Ceiling on that bonus, as a fraction (0.5 = up to +50%). */
  max: 0.5,
} as const;

/* --------------------------------------------------------------------------
   Second curves

   `serviceCurve` gives a tier a SECOND, finer milestone curve stacked on the
   normal one: `multiplier` extra per `step` units.

   Deliberately gentler than MILESTONE (1.05 rather than 2) and capped by the
   upgrade itself, because unlike a milestone it has no other bound: two
   exponential curves multiplying each other is how a cheap tier overtakes the
   whole ladder.
   -------------------------------------------------------------------------- */

export const CURVE = {
  step: 10,
} as const;

/* --------------------------------------------------------------------------
   Active abilities

   The things the player has to decide to do. Defined in ABILITIES, beside the
   achievements that unlock them. Overclock is available from the start; the
   rest are granted by an `unlockAbility` reward.
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   Contracts

   Repeatable objectives measured from a baseline captured when the contract
   is issued.

   MOST OBJECTIVES ARE FIXED NUMBERS, authored on the definition as `amount`.
   "Bring 1 more service online" means one unit whether the player has three
   units or three thousand. Which NUMBER the player is offered is what scales,
   not the number itself: the band a def declares decides both how big its
   `amount` is and when it is eligible to be drawn, so the panel walks up the
   scale as the fleet grows while every individual card stays a round figure.

   THE ONE EXCEPTION IS `totalEarned`, which stays sized from the player's
   production rate. Compute is the metric that legitimately scales without
   limit -- "earn 90 seconds of production" is a fair ask at any point in a
   run -- so it is the single metric that keeps the cost-derived objective. It
   is the only reader of `CONTRACTS.growthCorrection`.

   This replaced a design where EVERY objective was computed from the player's
   rate at issue time. That made the numbers honest about the work but
   illegible: "Bring 75 more services online" against a thirty-unit fleet is a
   true statement and an unreadable one, and it made the same contract a
   different SIZE on every draw. Fixed amounts are the same job at every scale,
   which is what a contract is supposed to be.

   `cost` remains on EVERY definition and is not decoration: it selects the
   payout band in BOTH currencies -- the shard band by `shardPayout()` and the
   compute band by `contractReward()` -- so a definition without one pays zero
   in both, invisibly. For `totalEarned` it also SIZES the objective.
   -------------------------------------------------------------------------- */

export const CONTRACTS = {
  /**
   * Milliseconds of PLAY that earn one issued contract.
   *
   * THE OFFER CADENCE. It exists because the objectives are now fixed numbers,
   * and this is where the difficulty that used to live in the objective went.
   *
   * A fixed ask does not grow with the fleet, so once production is large the
   * work is over in seconds and the panel would pay out as fast as the player
   * can collect. MEASURED WITHOUT THIS: **305 contracts an hour against the 65
   * the ladder is priced for**, and daily shard income up 61%
   * (69,258 -> 111,451), with the ladder finishing at 0.84h instead of 2.9h.
   * That is the same runaway the old design hit at 1,200 contracts an hour --
   * a faucet whose rate is set by how fast the objective completes rather than
   * by what the ladder costs.
   *
   * The rate is bounded HERE rather than by growing the objective, because the
   * objective is exactly the thing that had to stop growing. This leaves every
   * card a round, readable number and puts the pacing in one constant.
   *
   * A save is granted `CONTRACTS.active` issues up front, so the opening panel
   * is always full; beyond that it earns one issue per this many ms of
   * `playtime`. `playtime` and not wall clock, so a save left closed does not
   * bank a burst of contracts to collect on return -- the same reasoning that
   * keeps the milestone faucet online-only.
   *
   * THE COST IS A TRICKLE, and it should be stated plainly. Once the fleet is
   * large a slot's work finishes in seconds while its refill takes about a
   * minute, so the panel legitimately shows fewer cards than it has slots. That
   * is the honest shape of a fixed objective with a scaling payout: the panel
   * pace and the faucet rate cannot both be held, and the faucet is the one the
   * ladder depends on.
   */
  offerMs: 55_000,

  /**
   * How many contracts are offered at once. The `contractSlots` upgrade raises
   * this further, which is the only upgrade that changes a structure rather
   * than a number.
   */
  active: 5,
  /**
   * What a contract pays, as a number of DEPLOYS by definition.
   *
   * A deploy is the most legible unit of value in the game: it is the number
   * on the button the player presses from the first second, and it already
   * carries the click tree, so this reads as "a quick errand pays ten deploys
   * and a project pays fifty".
   *
   * The four values are round and ascend together with `SHARDS.perCost`, so a
   * harder definition pays more in BOTH currencies and a card cannot be a bad
   * deal. Neither table is a ramp: this one is 10/25/50/100 and `perCost` is
   * 10/30/60/100, so a reward is a number the player recognises rather than one
   * that grows with progress.
   *
   * WHAT THIS COUPLES: the payout scales with the CLICK tree as well as with
   * production, so contract income cannot be tuned without `clickMult`.
   */
  deployMult: {
    quick: 10,
    standard: 25,
    project: 50,
    epic: 100,
  },

  /**
   * A contract's BAND, by definition.
   *
   * The band is three things at once, and they are all keyed off this one
   * number rather than three parallel tables that could drift:
   *
   *   1. the SHARD payout band, via `SHARDS.perCost`;
   *   2. the COMPUTE payout, via `CONTRACTS.deployMult`; and
   *   3. how much WORK the contract asks for -- the `amount` on the def, and
   *      the rate at which the def becomes eligible to be offered.
   *
   * So a `quick` errand is a small ask for a small prize and an `epic` project
   * is a large ask for a large one, and a card cannot be a bad deal because
   * there is no separate figure to get wrong.
   *
   * The seconds are the SPREAD of the band -- a 90-second errand and a
   * 12-minute project are different experiences -- not a promise of duration
   * for the objective-sized metrics. See `ContractDef.cost` for what a band
   * does and does not claim, and `growthCorrection` below for the one metric
   * that still converts it into an objective size.
   */
  cost: {
    quick: 90,
    standard: 150,
    project: 300,
    epic: 720,
  },

  /**
   * Clicks a second a `clicks` objective is sized against.
   *
   * A click contract's work is real wall-clock time at whatever rate the player
   * clicks; there is no production to convert. So the rate is DECLARED, and the
   * engine sizes the objective as `cost x this` -- which makes a click contract
   * the ONE kind whose card is literally honest about its band, because both
   * sides are the same unit of time.
   *
   * This constant was declared, documented, and UNREAD for a while: the two
   * click defs each carried a hand-authored `amount` instead (`25` and `50`
   * against a ninety- and a hundred-and-fifty-second band), so a `quick` click
   * contract asked for six seconds of work and paid for ninety. That is what
   * made a run able to clear approaching ten contracts on ten clicks. The
   * amounts are now DERIVED from this, so the gap cannot reopen by authoring --
   * see the note on the defs below.
   *
   * Four a second is brisk but sustainable, and it is the figure
   * `check:progression` models, so the card and the harness agree about what the
   * ask costs.
   */
  referenceClicksPerSecond: 4,

  /**
   * What a single-currency contract pays, as a multiple of its normal share.
   *
   * A contract whose objective is about ONE currency pays only that currency
   * (see `ContractDef.reward`). Paying the same amount would make the variety
   * a strict downgrade -- half a reward for the same work -- so concentrating
   * pays, and the multiple is what makes the choice real rather than cosmetic.
   */
  soloBonus: 1.5,

  /**
   * Growth correction for every objective sized from the production RATE.
   *
   * **`totalEarned` IS NOW ITS ONLY READER.** It used to carry four metrics
   * (`services`, `milestones` and `tierUnits` also went through it), and those
   * three became fixed `amount`s instead. The constant is kept rather than
   * deleted because compute is the one metric that legitimately scales without
   * limit, so the correction still has a real job.
   *
   * `perSecond x cost` is the area of a rectangle under a curve that is still
   * rising, so the fleet delivers it long before `cost` seconds pass. Measured
   * uncorrected, the rate-sized objectives complete in 0.02%-1.3% of their band.
   *
   * WHY A NUMBER AND NOT A FORMULA: the required correction is a property of the
   * whole content set (unit costs, milestones, synergy, achievements), not of
   * any one objective's arithmetic. Modelling it inside the sizing function
   * would put any error in the model somewhere invisible. So it is MEASURED and
   * held, and `npm run check:progression` fails if a metric leaves its band.
   *
   * IT IS A DIFFICULTY DIAL, NOT A TIME CLAIM. `cost` names the PAYOUT BAND and
   * sets the objective's MAGNITUDE, not a number of seconds -- the required
   * factor moves by two orders of magnitude inside one run, so no value makes
   * realised time equal the band at every phase. The card shows the real
   * objective via `contractObjective()`, which is truthful at every scale.
   *
   * ONE VALUE, NOT A PER-METRIC TABLE. A per-metric table is the obvious next
   * step for one reader only if its difficulty is wrong, and the one reader is
   * `totalEarned`. The table was tried while four metrics shared the value and
   * it CANNOT converge: they were coupled through ONE loop (contracts pay
   * compute -> shard faucet IS the completion rate -> shards buy the ladder ->
   * the ladder drives production -> production sizes every objective), so
   * changing one factor moved the AGGREGATE rate, which moved every ratio --
   * including the one changed, in the OPPOSITE direction. Measured: making
   * `services` 2.3x harder (18 -> 42) moved its time from 0.239 to 0.117 of
   * band, i.e. CHEAPER, because the change also pushed the rate from 84 to 159
   * contracts/hr.
   *
   * That coupling is now BROKEN for the three unit metrics by fixing them
   * outright, so this value serves `totalEarned` alone and the story above is
   * history rather than a live constraint. It is kept because it explains why
   * the number is a single measured constant instead of a table, and because
   * anyone adding a SECOND rate-sized metric would walk straight back into it.
   *
   * **Never measure this with a completion-weighted median over a run that
   * terminates on the contract count** -- that feeds the tuned quantity back
   * into its own unit of measurement and the response comes out non-monotone.
   * `check:progression` uses a PHASE-NORMALISED median instead.
   *
   * RE-MEASURED when it became `totalEarned`'s sole reader: it was 12 while
   * four metrics shared it, and at 12 a typical `totalEarned` contract
   * completed in 16.0s -- under the checker's 20s "near-free payouts" floor,
   * because the throttled contract rate had flattened the production curve the
   * correction was calibrated against. 15 lifts it clear. The constant is
   * MEASURED, so this is a re-calibration rather than a taste change, and any
   * later edit to the offer cadence moves it again.
   *
   * 16 rather than the minimum that passes on purpose: 15 measured 20.0s
   * against a 20s floor, which is a pass by a hair. A bound satisfied to the
   * decimal is not satisfied, it is pending -- the next harmless content edit
   * would flip it.
   */
  growthCorrection: 16,
} as const;

/* --------------------------------------------------------------------------
   Contracts
   -------------------------------------------------------------------------- */

export const CONTRACT_DEFS: ContractDef[] = [
  {
    id: 'manual-surge',
    name: 'Manual surge',
    blurb: 'A burst of hands-on deploys. No amount of capacity buys this one.',
    icon: 'deploy',
    metric: 'clicks',
    /* NO `amount`, deliberately. The engine derives the size from `cost` at
       `referenceClicksPerSecond`, and `check:progression` FAILS a rate-sized
       metric that carries one -- an `amount` here would be silently ignored,
       which is the exact bug that let a `quick` click contract cost six seconds
       and pay for ninety.

       A derived `quick` contract is 360 clicks. That is a genuine chunk of
       hands-on work, which is the point: clicking is the only thing the game
       cannot automate, so a click contract is the one contract whose work is
       unavoidably the player's. It was previously `25`.

       The number is also the one place the band is not a fiction: 360 clicks at
       the declared four a second is ninety seconds, so `cost` is truthful here
       in a way it cannot be for a production-denominated objective. */
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'handover',
    name: 'Handover',
    blurb: 'A longer stretch of manual work, for a bigger slice of compute.',
    icon: 'clock',
    metric: 'clicks',
    /* Derived: 600 clicks against the `standard` band, twice the `quick` one
       because the band is. */
    cost: CONTRACTS.cost.standard,
  },
  /*
   * The capacity ladder: FOUR defs, one per band, each asking for a FIXED
   * number of units.
   *
   * 1 / 5 / 10 / 25, ascending with the band. The number never moves -- a
   * `quick` capacity contract is one unit when the player owns three and one
   * unit when they own three thousand -- so the card is legible at every stage
   * and the ladder is climbed by being OFFERED bigger numbers, not by the same
   * card growing.
   *
   * WHAT THE NUMBER MEANS: units ACROSS the whole fleet, and the objective is
   * satisfied by whichever rows the player likes. That is a deliberately loose
   * instruction -- a total is satisfied by the cheapest row repeatedly -- which
   * is exactly why `tierUnits` exists below to name one row specifically.
   */
  {
    id: 'provision',
    name: 'Provision',
    blurb: 'A single extra unit online, for a quick turnaround.',
    icon: 'cube',
    metric: 'services',
    amount: 1,
    cost: CONTRACTS.cost.quick,
    reward: 'compute',
  },
  {
    id: 'expansion',
    name: 'Expansion',
    blurb: 'A round of five more units across the fleet.',
    icon: 'network',
    metric: 'services',
    amount: 5,
    cost: CONTRACTS.cost.standard,
    reward: 'compute',
  },
  {
    id: 'expansion-2',
    name: 'Second site',
    blurb: 'Ten more units, with a project-sized payout to match.',
    icon: 'globe',
    metric: 'services',
    amount: 10,
    cost: CONTRACTS.cost.project,
    reward: 'compute',
  },
  {
    id: 'expansion-3',
    name: 'Estate',
    blurb: 'The largest capacity round the panel offers.',
    icon: 'crown',
    metric: 'services',
    amount: 25,
    cost: CONTRACTS.cost.epic,
    reward: 'compute',
  },
  {
    id: 'throughput-1',
    name: 'Throughput',
    blurb: 'Earn what the fleet makes in a short stretch.',
    icon: 'pulse',
    metric: 'totalEarned',
    cost: CONTRACTS.cost.quick,
    reward: 'compute',
  },
  {
    id: 'throughput-2',
    name: 'Sustained load',
    blurb: 'Hold the current rate for a while and bank the output.',
    icon: 'gauge',
    metric: 'totalEarned',
    cost: CONTRACTS.cost.standard,
    reward: 'compute',
  },
  {
    id: 'throughput-3',
    name: 'Peak season',
    blurb: 'A long window of production, for a correspondingly larger payout.',
    icon: 'flame',
    metric: 'totalEarned',
    cost: CONTRACTS.cost.project,
    reward: 'compute',
  },
  {
    id: 'throughput-4',
    name: 'Hyperscale',
    blurb: 'Everything the fleet can make for a sustained stretch.',
    icon: 'trend',
    metric: 'totalEarned',
    cost: CONTRACTS.cost.epic,
    reward: 'compute',
  },
  /*
   * WHAT A METRIC HAS TO BE for this objective shape: monotonic within a run.
   * A contract's difficulty is fixed when it is issued and its progress is
   * counted from that moment, so the counter must move forward while the
   * player plays. Every metric here qualifies -- clicks, services, lifetime
   * compute, milestones, upgrades, tier counts, ability uses.
   *
   * `cores` and `reboots` do not, and are deliberately absent. Cores move only
   * during a Reboot, which makes a contract on one a prestige-timescale
   * objective wearing a routine one's clothes: cores grow with the square root
   * of a run, so "100 more cores" is 1e13 compute in one run or a hundred
   * separate reboots. And a reboot RESETS `services`, from which `milestones`
   * and `upgrades` are derived -- so completing a prestige contract would wipe
   * the progress of seven other contract types, mid-run, with no warning.
   *
   * The cost of a bad metric here is not a hard contract, it is an impossible
   * one: an incomplete contract holds a SLOT, so it takes one of five away
   * permanently.
   */

  /* Deepening -----------------------------------------------------------
     The DEPTH counterpart to the capacity ladder above: it measures
     milestone doublings rather than unit count, so the panel is not only
     about buying more units.

     ONE DEF, AT THE TOP BAND. The other three were removed, and removing
     them cost no panel variety at all: `contractSubject()` is the metric plus
     the tier or ability, and every milestone def shares the subject
     `milestones:`, so `pickContract` could never put two of them on the panel
     at once. They were three sizes of one quest, offered one at a time, and
     the smaller two only ever appeared as a weaker version of this one.

     `amount: 1` IS NOT A SMALL ASK. One milestone step is `MILESTONE.step`
     (25) UNITS IN A SINGLE TIER, so it is the same unit burden as `expansion-3`
     at 25 units ACROSS the fleet -- just concentrated rather than spread. That
     is the whole distinction the two metrics exist to draw, and the two
     numbers landing on the same 25 is the identity being visible rather than
     a coincidence.

     The step is read from the `MILESTONE.step` CONSTANT, not from
     `stats.milestoneStep`, so a `milestoneStep` upgrade cannot quietly change
     what "one milestone" means to a contract.
     --------------------------------------------------------------------- */
  {
    id: 'deepening-3',
    name: 'Long tail',
    blurb: 'One more doubling banked, in a single tier.',
    icon: 'helix',
    metric: 'milestones',
    amount: 1,
    cost: CONTRACTS.cost.epic,
    reward: 'compute',
  },
  /*
   * The salvage pair: earn COMPUTE, paid in shards.
   *
   * The objective is the thing the fleet actually makes, and the payout is the
   * thing the ladder costs. That split is deliberate -- a contract on the SAME
   * currency it pays in asks the player to collect shards to be given shards,
   * which reads as circular and is what the shards metric is excluded from by
   * `check:ladder`.
   *
   * These share the `totalEarned` subject with the four throughput defs, so a
   * shard-paying def competes to be on the panel at all -- see the note on the
   * shard faucet in `docs/DECISIONS.md` for the measured effect.
   */
  {
    id: 'recovery-1',
    name: 'Salvage claim',
    blurb: 'Earn the compute, then invoice it out as recovered value.',
    icon: 'cable',
    metric: 'totalEarned',
    cost: CONTRACTS.cost.quick,
    reward: 'shards',
  },
  {
    id: 'recovery-2',
    name: 'Refurbishment',
    blurb:
      'A longer run of production, settled as salvage rather than as capacity.',
    icon: 'beaker',
    metric: 'totalEarned',
    cost: CONTRACTS.cost.standard,
    reward: 'shards',
  },
  /* The two UPGRADES objectives, and the only contracts that pay compute AND
     shards.

     The objective CONSUMES the currency the ladder costs, so a shards-only
     payout was a rebate: buying three upgrades costs a few hundred shards and
     the contract paid thirty back, which is the reported "buy 15 more upgrades
     for 30 shards". Paying compute as well makes it a job rather than a
     discount -- the spend buys ladder progress, and the contract pays out the
     production those upgrades produce.

     They keep the shard half, so the objective is still rewarded in the
     currency it is about. Omitting `reward` is what asks for BOTH; the
     `'compute'` and `'shards'` forms are the single-currency cases. */
  {
    id: 'inventory-1',
    name: 'Toolkit',
    blurb: 'One more purchase on the ladder, paid back in compute and shards.',
    icon: 'cube',
    metric: 'upgrades',
    amount: 1,
    /* One upgrade costs about 10 shards, which is one `quick` contract's
       payout -- so one purchase is roughly ninety seconds of earning, and
       ninety seconds is the band it should pay. It was priced as a `project`
       (300s), over three times what the purchase costs to afford. */
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'inventory-2',
    name: 'Full catalogue',
    blurb: 'A short round of upgrades, for a correspondingly larger payout.',
    icon: 'ledger',
    metric: 'upgrades',
    amount: 3,
    /* Three purchases, so three quick errands -- 270s against the `project`
       band's 300s. It was priced as an `epic` (720s) for less than half that. */
    cost: CONTRACTS.cost.project,
  },

  /* ---------------------------------------------------------------------
     Per-tier: deepen ONE named row.

     `services` above already measures the whole fleet, and a total turns out
     to be a poor objective for DIRECTING play: "bring 40 more services
     online" is satisfied by the cheapest row in the game forty times over,
     which is never how a player reads it. These name the tier, so the card
     asks for something specific and the answer is a row the player can find.

     FIXED amounts, and they DESCEND as the tier gets dearer. That is forced
     rather than stylistic: every tier shares `COST_GROWTH`, but `baseCost`
     spans 15 (Worker) to 330,000,000 (Datacenter), so a single band table
     could not serve them. Twenty-five more Workers is a first-minute purchase;
     twenty-five more Datacenters is several runs of compute. One number per
     def is the only way the same contract is a real ask on every row, and it
     is the reason this metric could not simply join the capacity ladder above.

     1 IS A VALID OBJECTIVE on the deep rows, and it is not a filler value: a
     Datacenter is the most expensive thing in the game, so "one more" is a
     genuine project. The floor is 1 rather than 0 because a contract that asks
     for nothing completes itself.

     Ordered cheapest-first so the pool reads as the fleet's own climb: the
     early defs ask about the rows a new player already owns, and the later
     ones about rows they have not reached.
     --------------------------------------------------------------------- */
  {
    id: 'tier-worker',
    name: 'Worker detail',
    blurb: 'Mobilise more of the tier doing the actual work.',
    icon: 'cog',
    metric: 'tierUnits',
    serviceId: 'worker',
    amount: 25,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'tier-cache',
    name: 'Cache detail',
    blurb: 'More capacity in front of the fleet.',
    icon: 'layers',
    metric: 'tierUnits',
    serviceId: 'cache',
    amount: 10,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'tier-queue',
    name: 'Queue detail',
    blurb: 'Widen the intake so nothing waits to be picked up.',
    icon: 'conduit',
    metric: 'tierUnits',
    serviceId: 'queue',
    amount: 5,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'tier-database',
    name: 'Database detail',
    blurb: 'A deeper store for the data that matters.',
    icon: 'disk',
    metric: 'tierUnits',
    serviceId: 'database',
    amount: 3,
    cost: CONTRACTS.cost.standard,
  },
  {
    id: 'tier-balancer',
    name: 'Balancer detail',
    blurb: 'More spread across the fleet, for a larger slice of compute.',
    icon: 'scales',
    metric: 'tierUnits',
    serviceId: 'balancer',
    amount: 2,
    cost: CONTRACTS.cost.standard,
  },
  {
    id: 'tier-replica',
    name: 'Replica detail',
    blurb: 'Another copy of the fleet, standing beside the first.',
    icon: 'cluster',
    metric: 'tierUnits',
    serviceId: 'replica',
    amount: 2,
    cost: CONTRACTS.cost.standard,
  },
  {
    id: 'tier-region',
    name: 'Region detail',
    blurb: 'One more region, serving traffic of its own.',
    icon: 'broadcast',
    metric: 'tierUnits',
    serviceId: 'region',
    amount: 1,
    cost: CONTRACTS.cost.project,
  },
  {
    id: 'tier-datacenter',
    name: 'Datacenter detail',
    blurb:
      'One more of the deepest, most expensive rows in the game -- a long climb for a correspondingly large payout.',
    icon: 'server',
    metric: 'tierUnits',
    serviceId: 'datacenter',
    amount: 1,
    cost: CONTRACTS.cost.epic,
  },

  /* ---------------------------------------------------------------------
     One-shots: open the NEXT tier.

     A fixed objective of 1, so the contract completes the moment the tier is
     bought. Owning a tier is a 0/1 fact, so these cannot be scaled.

     Offered ONLY for the cheapest tier the player owns none of -- see
     `pickContract`. Without that rule all eight are available at once, which
     turns the opening minutes into eight stacked bounties.

     `cost` is `quick` rather than the tier's real price: the payout derives
     from `cost` and the tier prices span six orders of magnitude, so there is
     no `cost` value that could express "save up for a Datacenter". Sizing
     these low keeps the bounty a bonus for opening a tier, not a reason to.
     --------------------------------------------------------------------- */
  {
    id: 'open-worker',
    name: 'First process',
    blurb: 'Stand up your first Worker.',
    icon: 'cpu',
    metric: 'tierOwned',
    serviceId: 'worker',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-cache',
    name: 'First cache',
    blurb: 'Put something in front of the fleet.',
    icon: 'layers',
    metric: 'tierOwned',
    serviceId: 'cache',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-queue',
    name: 'First queue',
    blurb: 'Give the workload somewhere to wait.',
    icon: 'conduit',
    metric: 'tierOwned',
    serviceId: 'queue',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-database',
    name: 'First database',
    blurb: 'Persist something for the first time.',
    icon: 'disk',
    metric: 'tierOwned',
    serviceId: 'database',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-balancer',
    name: 'First balancer',
    blurb: 'Spread the load across more than one Worker.',
    icon: 'scales',
    metric: 'tierOwned',
    serviceId: 'balancer',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-replica',
    name: 'First replica',
    blurb: 'Run a second copy of everything.',
    icon: 'cluster',
    metric: 'tierOwned',
    serviceId: 'replica',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-region',
    name: 'First region',
    blurb: 'Leave the building.',
    icon: 'broadcast',
    metric: 'tierOwned',
    serviceId: 'region',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'open-datacenter',
    name: 'First datacenter',
    blurb: 'Own somewhere to put all of it.',
    icon: 'server',
    metric: 'tierOwned',
    serviceId: 'datacenter',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },

  /* ---------------------------------------------------------------------
     Active skills as contract work.

     The Abilities panel had no contract presence at all, which meant a whole
     layer of the game -- three buttons on cooldowns -- was invisible to the
     objectives system. These make it a source of work.

     Measured in USES, and that is the only honest unit: an ability has a
     cooldown, so "use Surge twice" costs five minutes of wall clock whatever
     the fleet is doing. There is no production-value to convert, so these
     carry a fixed `amount` like `clicks` does -- and they are the reason
     `abilityUses` is in the bounded-headroom list: a Surge contract issued
     before `contracts-25` would be uncompletable and hold a slot forever.

     ONE USE EACH, and the BAND FOLLOWS THE COOLDOWN. That pairing is the whole
     point of these defs and it was previously wrong in both directions: `cost`
     was `quick` for all three, so Surge asked for a five-minute wait and paid a
     ninety-second band, while Overclock asked for two uses of a three-minute
     cooldown and paid the same. `cost` is not decoration here -- it selects the
     payout band in both `shardPayout` and `contractReward` -- so an ability
     contract's band IS its duration.

       overclock   120s  -> quick     (90s floor band)
       surge       180s  -> standard  (150s)
       provision   300s  -> project   (300s, exact)

     The cooldowns live on `ABILITIES` above; if one moves, the matching band
     here has to move with it.
     --------------------------------------------------------------------- */
  {
    id: 'skill-overclock',
    name: 'Redline',
    blurb: 'Push the fleet past its rated clock.',
    icon: 'bolt',
    metric: 'abilityUses',
    abilityId: 'overclock',
    amount: 1,
    cost: CONTRACTS.cost.quick,
  },
  {
    id: 'skill-surge',
    name: 'On demand',
    blurb: 'Call in the deep burst that the contract work itself unlocked.',
    icon: 'flame',
    metric: 'abilityUses',
    abilityId: 'surge',
    amount: 1,
    cost: CONTRACTS.cost.standard,
  },
  {
    id: 'skill-provision',
    name: 'Free capacity',
    blurb: 'Stand up capacity the fleet did not pay for.',
    icon: 'grid',
    metric: 'abilityUses',
    abilityId: 'provision',
    amount: 1,
    cost: CONTRACTS.cost.project,
  },
];

/* --------------------------------------------------------------------------
   Services (the generators)
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   The service cost curve

   Cost of unit `n` on a tier is `baseCost * COST_GROWTH^n`, so the fleet's pace
   is set by this EXPONENT rather than by any single price. It is the lever for
   "how long does the fleet take to build out", and it is deliberately ONE
   number shared by all eight tiers rather than eight independent values.

   UNIFORMITY IS LOAD-BEARING, not tidiness. Several rewards read a RAW unit
   count -- the per-tier own-count rows, the global per-owned rows, the
   manual-deploy row and the mature-tier threshold. Those only mean the same
   thing on every tier if a unit is the same amount of progress everywhere,
   which is exactly what a shared exponent buys. Give one tier its own curve
   and its unit count stops being comparable to its neighbours': a reward
   tuned to bind at a few hundred units becomes unreachable on the steep tier
   and trivially saturated on the shallow one, silently.

   CHANGING IT MOVES PEAK UNIT COUNTS, so it is never a one-line balance tweak.
   Every unit-derived cap is sized from the measured peak, and the mature-tier
   threshold is a unit count too -- raise this and the fleet finishes with
   fewer units on every tier, which can put a cap or that threshold out of
   reach entirely. Always re-measure with check:progression and re-derive the
   caps afterwards; the peaks it prints are the input to that.
   -------------------------------------------------------------------------- */
export const COST_GROWTH = 1.15;

export const SERVICES: ServiceDef[] = [
  {
    id: 'worker',
    name: 'Worker',
    blurb: 'A single process handling requests.',
    baseCost: 15,
    costGrowth: COST_GROWTH,
    baseOutput: 0.1,
  },
  {
    id: 'cache',
    name: 'Cache',
    blurb: 'Absorbs repeated reads before they hit the origin.',
    baseCost: 100,
    costGrowth: COST_GROWTH,
    baseOutput: 1,
  },
  {
    id: 'queue',
    name: 'Queue',
    blurb: 'Buffers work so bursts do not drop requests.',
    baseCost: 1_100,
    costGrowth: COST_GROWTH,
    baseOutput: 8,
  },
  {
    id: 'database',
    name: 'Database',
    blurb: 'Durable storage with indexed reads.',
    baseCost: 12_000,
    costGrowth: COST_GROWTH,
    baseOutput: 47,
  },
  {
    id: 'balancer',
    name: 'Load balancer',
    blurb: 'Spreads traffic across healthy instances.',
    baseCost: 130_000,
    costGrowth: COST_GROWTH,
    baseOutput: 260,
  },
  {
    id: 'replica',
    name: 'Replica',
    blurb: 'Read replicas that scale throughput linearly.',
    baseCost: 1_400_000,
    costGrowth: COST_GROWTH,
    baseOutput: 1_400,
  },
  {
    id: 'region',
    name: 'Region',
    blurb: 'A whole region serving traffic close to users.',
    baseCost: 20_000_000,
    costGrowth: COST_GROWTH,
    baseOutput: 7_800,
  },
  {
    id: 'datacenter',
    name: 'Datacenter',
    blurb: 'Bare metal at a scale the cloud cannot match.',
    baseCost: 330_000_000,
    costGrowth: COST_GROWTH,
    baseOutput: 44_000,
  },
];

export const SERVICE_BY_ID: Record<string, ServiceDef> = Object.fromEntries(
  SERVICES.map((service) => [service.id, service]),
);

/* --------------------------------------------------------------------------
   Upgrades
   One-time purchases. `reveal` gates visibility so the list grows with play
   instead of dumping everything on a new player.
   -------------------------------------------------------------------------- */

const totalOwned = (state: GameState): number =>
  SERVICES.reduce((sum, service) => sum + (state.services[service.id] ?? 0), 0);

const owned = (state: GameState, id: string): number => state.services[id] ?? 0;

/* --------------------------------------------------------------------------
   Upgrades are tuned as a single ladder.

   The tier and global rows share banded pricing, distinct reveal gates and a
   fixed 64-row structure; `check:ladder` enforces the rung, capstone and pace
   invariants rather than repeating them here.
   -------------------------------------------------------------------------- */

export const UPGRADES: UpgradeDef[] = [
  /* Worker -------------------------------------------------------------- */
  {
    id: 'worker-1',
    name: 'Fan-out',
    icon: 'fan',
    blurb:
      'Every Worker you own adds +0.5% to deploy power, up to +150% at 300 Workers. Compute buys the Workers and the Workers handle the request, so the fleet you have funded is the fleet that answers when you reach for the button yourself.',
    rung: 0,
    reveal: (state) => owned(state, 'worker') >= 10,
    /*
     * The compute-powered path to clicking.
     *
     * Every other click booster is an achievement or a shard-priced flat
     * multiplier, which meant a player sitting on a large COMPUTE balance
     * could not make their own deploy button hit harder -- clicking improved
     * only through shards. This reads a unit count instead, and units are
     * bought with compute, so the two currencies stay in their own lanes while
     * being coupled rather than tangled.
     *
     * KNOWN TENSION: worker-3 below is `globalPerOwned` on the same tier's
     * units at the same rate, so both rows count Workers and both read
     * `+0.5%`. They multiply different things -- this one the deploy button,
     * that one the whole fleet -- so they are two purchases rather than one
     * stated twice, and the badges lead with the TARGET to make that visible.
     * It is accepted rather than fixed because every genuinely free quantity
     * was checked first: `totalUnits` is database-1's, `state.clicks` was
     * removed on request, and the count-shaped ones are all spoken for. A
     * THIRD row on this counter would be a duplicate whatever its target.
     *
     * `cap: 1.5` is 300 Workers, DELIBERATELY below the measured peak (min
     * 300, median 347, max 413 across seeds) rather than at it. `probe:value`
     * measures the existing flat click row at +112.6% income for 50 shards --
     * the best value of any per-tier row -- and this one costs 10 shards on
     * rung 0, so it has to cap BEFORE the fleet outgrows it or it becomes the
     * only purchase worth making. Measured after it landed: 18.8% income for
     * 10 shards, second-best in the game and below worker-3's 25.0, and the
     * contract rate moved 65 -> 70/hr, inside tolerance.
     */
    effect: { kind: 'serviceDeployPerOwned', serviceId: 'worker', per: 0.005, cap: 1.5 },
  },
  {
    id: 'worker-2',
    name: 'Rolling standard',
    icon: 'hourglass',
    blurb:
      'Workers produce more for every tier staffed to 100 units or more, up to +200% at all eight. Keeping every layer on the same version means nothing in the fleet runs an untested build, so breadth is worth as much as depth.',
    rung: 1,
    reveal: (state) => owned(state, 'worker') >= 25,
    /* The ladder's only BREADTH reward, and the only one bounded by content
       rather than by a fleet: the quantity cannot exceed `SERVICES.length`,
       so `cap: 2` at `per: 0.25` is reached EXACTLY at all eight tiers. */
    effect: { kind: 'serviceMatureTiers', serviceId: 'worker', per: 0.25 },
  },
  {
    id: 'worker-3',
    name: 'Amdahl\'s law',
    icon: 'cpu',
    blurb:
      'Every Worker you own lifts the WHOLE fleet by 0.5% each, up to +50%. The serial part of a job sets the ceiling no matter how wide you scale, so each Worker you add buys a little less than the one before it.',
    rung: 2,
    reveal: (state) => owned(state, 'worker') >= 50,
    effect: { kind: 'globalPerOwned', serviceId: 'worker', per: 0.005, cap: 0.5 },
  },
  {
    id: 'worker-4',
    name: 'Warm pool',
    icon: 'lock',
    blurb:
      'Pre-warmed instances answer on their own: every 50 Workers adds one automatic deploy per second, up to six. A pool that is already running holds the connection open, so the request is served before you think to send it.',
    rung: 3,
    capstone: true,
    reveal: (state) => owned(state, 'worker') >= 100,
    /*
     * The ladder's only automation fed by a UNIT COUNT.
     *
     * Every other automation rate is a flat purchase, so the shop's deploys/s
     * were the only way to automate and they stop being worth buying once
     * bought. This one keeps scaling with the Worker fleet, which gives the
     * cheapest tier a second reason to be deepened late -- the first being the
     * milestone doubling, which every tier has.
     *
     * It replaced `serviceOffline` (full production while away). That mechanic
     * had exactly one user, so it is now unused; the fold and the constant are
     * kept, because a future tier may want it and nothing else expresses it.
     *
     * What it feeds is worth restating: `autoDeployRate` shards a share of
     * PRODUCTION per deploy, not `clickPower`. So 6/s at the shipped
     * `CLICK.autoDeployShare` of 0.15 is +90% production -- large, but bounded
     * by construction and independent of the click tree, which is the property
     * that keeps the two automation channels from multiplying.
     */
    effect: { kind: 'serviceAutoDeploy', serviceId: 'worker', per: 0.02, cap: 6 },
  },

  /* Cache --------------------------------------------------------------- */
  {
    id: 'cache-1',
    name: 'Balanced fleet',
    icon: 'grid',
    blurb:
      'Caches produce more for every tier held near an even share of the fleet, up to +160%. A cache is only as useful as the spread of traffic in front of it, so a fleet that is not top-heavy makes every layer work harder.',
    rung: 4,
    reveal: (state) => owned(state, 'cache') >= 10,
    effect: { kind: 'serviceParity', serviceId: 'cache', per: 0.2 },
  },
  {
    id: 'cache-2',
    name: 'Tuned stack',
    icon: 'layers',
    blurb:
      'Caches produce more with every upgrade you have bought, up to +128%. Each purchase tunes the stack a little further, and a cache sits at the point where all of those settings are felt at once.',
    rung: 5,
    reveal: (state) => owned(state, 'cache') >= 25,
    /*
     * The quantity is `state.upgrades.length`, whose maximum is the whole pool:
     * `UPGRADES.length`. The cap is that PRODUCT, not headroom above it.
     *
     * It was `1.5`, which needs 75 upgrades to bind and there are 64, so the
     * cap could never be reached -- while the badge, which prints `1 + cap`,
     * advertised `x2.5` beside a blurb stating the true `+128%`. Sizing the cap
     * to the reachable maximum makes the two surfaces agree, and changes no
     * arithmetic: a cap that never binds is not part of any multiplier.
     *
     * 64 x 0.02 = 1.28. **If the upgrade pool grows, this must be recomputed**
     * -- `check:progression` prints `state.upgrades.length`'s maximum so the
     * figure is never a guess.
     */
    effect: { kind: 'serviceUpgrades', serviceId: 'cache', per: 0.02 },
  },
  {
    id: 'cache-3',
    name: 'Shard balance',
    icon: 'helix',
    blurb:
      'Caches produce +40% output for every 1,000 shards you have ever earned, up to +150% at 3,750. There are two hard problems in computing and this is the one that is not naming things. The cache is warm; the only question is whether it is right.',
    rung: 6,
    reveal: (state) => owned(state, 'cache') >= 50,
    effect: { kind: 'serviceShardsEarned', serviceId: 'cache', per: 0.0004, cap: 1.5 },
  },
  {
    id: 'cache-4',
    name: 'Bloom filter',
    icon: 'gauge',
    blurb:
      'Every Cache milestone is 2.25x stronger, so a tier with four doublings earns 36x rather than 16x. A probabilistic filter answers "definitely not here" for free, so the expensive work only runs when it might actually pay off.',
    rung: 7,
    capstone: true,
    reveal: (state) => owned(state, 'cache') >= 100,
    effect: { kind: 'serviceMilestone', serviceId: 'cache', bonus: 1.25 },
  },

  /* Queue --------------------------------------------------------------- */
  {
    id: 'queue-1',
    name: 'SLA work',
    icon: 'ledger',
    blurb:
      'Queues produce more with every contract completed, up to +200%. Work that arrives with a deadline attached is routed to the front, and a queue that keeps its promises is the one people keep feeding.',
    rung: 8,
    reveal: (state) => owned(state, 'queue') >= 10,
    effect: { kind: 'serviceContracts', serviceId: 'queue', per: 0.01, cap: 2 },
  },
  {
    id: 'queue-2',
    name: 'Backfill',
    icon: 'helix',
    blurb:
      'Queues gain +60% output for every reboot you have performed, up to +240% at four. Work that arrives while the fleet is being rebuilt is still work, and a buffer that has already survived a teardown knows which order it comes back in.',
    rung: 9,
    reveal: (state) => owned(state, 'queue') >= 25,
    effect: { kind: 'serviceReboots', serviceId: 'queue', per: 0.6, cap: 2.4 },
  },
  {
    id: 'queue-3',
    name: 'Proof of work',
    icon: 'anchor',
    blurb:
      'Queues gain +10% output for every Bronze achievement you have unlocked, up to +150% at all fifteen. Rather than dropping work when the buffer fills, the producer is told to slow down -- correct, unpopular, and usually implemented two incidents too late.',
    rung: 10,
    reveal: (state) => owned(state, 'queue') >= 50,
    /* The rarities hold 15/13/23/13 achievements, so the cap has to be sized
       against a real count or the blurb promises a figure nothing can reach.
       Bronze is 15 and `per` is 0.1, so all fifteen lands on the cap EXACTLY:
       the stated "+150% at all fifteen" is the true ceiling, not a ceiling
       with headroom the game never uses. */
    effect: { kind: 'serviceRarity', serviceId: 'queue', per: 0.1, rarity: 'bronze' },
  },
  {
    id: 'queue-4',
    name: 'Little\'s law',
    icon: 'conduit',
    blurb:
      'Queues gain +20% output for each tier you have deployed, up to +160%. Work in progress equals arrival rate times time in system, so the queue is only ever as fast as the pipeline feeding it.',
    rung: 11,
    capstone: true,
    reveal: (state) => owned(state, 'queue') >= 100,
    /*
     * The quantity is `deployedTiers`, whose maximum is `SERVICES.length`: eight
     * tiers, so 8 x 0.2 = 1.6. See `serviceUpgrades` above -- the cap is that
     * product rather than headroom, because the badge prints `1 + cap` and an
     * unreachable cap makes the badge promise a figure the game will not pay.
     *
     * The old `2` needed ten deployed tiers to bind. The blurb was already
     * correct at `+160%`, so only the cap and the badge were wrong.
     */
    effect: { kind: 'serviceDepth', serviceId: 'queue', per: 0.2 },
  },

  /* Database ------------------------------------------------------------ */
  {
    id: 'database-1',
    name: 'Indexed scale',
    icon: 'chart',
    blurb:
      'Databases produce more for every milestone the WHOLE fleet has banked, up to +200%. Indexes only help once there is enough data to search, so a deep fleet elsewhere makes the query planner finally earn its keep.',
    rung: 12,
    reveal: (state) => owned(state, 'database') >= 10,
    effect: { kind: 'serviceFleetMilestones', serviceId: 'database', per: 0.02, cap: 2 },
  },
  {
    id: 'database-2',
    name: 'Cold storage',
    icon: 'snowflake',
    blurb:
      'Databases produce more the longer your shard reserve lasts, up to +150%. A buffer you have not spent is a buffer that keeps the expensive tier from ever needing to page something back in.',
    rung: 13,
    reveal: (state) => owned(state, 'database') >= 25,
    effect: { kind: 'serviceReserve', serviceId: 'database', per: 0.0005, cap: 1.5 },
  },
  {
    id: 'database-3',
    name: 'B-tree fanout',
    icon: 'gauge',
    blurb:
      'Databases double every 20 units instead of 25. One node holds hundreds of keys, so the tree stays four levels deep for a billion rows. The constant is the entire design.',
    rung: 14,
    reveal: (state) => owned(state, 'database') >= 50,
    effect: { kind: 'milestoneStep', serviceId: 'database', reduce: 5 },
  },
  {
    id: 'database-4',
    name: 'Connection pooling',
    icon: 'network',
    blurb:
      'Databases gain +0.2% output for every unit you own anywhere, up to x4. Reusing open connections means the whole fleet shares one pool instead of every service hoarding its own.',
    rung: 15,
    capstone: true,
    reveal: (state) => owned(state, 'database') >= 100,
    effect: { kind: 'serviceThroughput', serviceId: 'database', per: 0.002, cap: 3 },
  },

  /* Load balancer ------------------------------------------------------- */
  {
    id: 'balancer-1',
    name: 'Spot routing',
    icon: 'scales',
    blurb:
      'Each Balancer you own makes the next one up to 50% cheaper. Route around the capacity everyone else has noticed and the price of your own grows slower than the price of the tier behind it.',
    rung: 16,
    reveal: (state) => owned(state, 'balancer') >= 10,
    effect: { kind: 'serviceEconomy', serviceId: 'balancer', per: 0.002, cap: 0.5 },
  },
  {
    id: 'balancer-2',
    name: 'Hardened fleet',
    icon: 'vault',
    blurb:
      'Balancers produce more with every core you hold, up to +200%. A reboot leaves the fleet a little harder to take down, and the balancer is where that shows first.',
    rung: 17,
    reveal: (state) => owned(state, 'balancer') >= 25,
    effect: { kind: 'serviceCores', serviceId: 'balancer', per: 0.05, cap: 2 },
  },
  {
    id: 'balancer-3',
    name: 'Keep-alive',
    icon: 'bolt',
    blurb:
      'Load balancers add +150% to manual deploys. The connection is already open, so a request you send by hand skips the handshake and lands straight on a warm worker. First byte, no round trip.',
    rung: 18,
    reveal: (state) => owned(state, 'balancer') >= 50,
    effect: { kind: 'serviceClick', serviceId: 'balancer', mult: 1.5 },
  },
  {
    id: 'balancer-4',
    name: 'Failover drill',
    icon: 'globe',
    blurb:
      'Load balancers gain +4% output for every ability activation you have made this save, up to x4 at 75. Adding a node reshuffles one key in N instead of all of them, which is the predecessor to every distributed cache you have had to debug at three in the morning.',
    rung: 19,
    capstone: true,
    reveal: (state) => owned(state, 'balancer') >= 100,
    effect: { kind: 'serviceAbilityUses', serviceId: 'balancer', per: 0.04, cap: 3 },
  },

  /* Replica ------------------------------------------------------------- */
  {
    id: 'replica-1',
    name: 'Warm standby',
    icon: 'anchor',
    blurb:
      'Replicas gain +12% output for every time you have come back from being away, up to +240% at twenty. A read replica that has already served a cold start is the one that comes up instantly the next time, and the count of those mornings is what this measures.',
    rung: 20,
    reveal: (state) => owned(state, 'replica') >= 10,
    effect: { kind: 'serviceReturns', serviceId: 'replica', per: 0.12, cap: 2.4 },
  },
  {
    id: 'replica-2',
    name: 'Battle-tested',
    icon: 'ledger',
    blurb:
      'Replicas produce more with every achievement unlocked, up to +150%. Serving through the incidents is what proves a replica is worth keeping in the rotation, and the record of those incidents is what the bonus counts.',
    rung: 21,
    reveal: (state) => owned(state, 'replica') >= 25,
    effect: { kind: 'serviceAchievements', serviceId: 'replica', per: 0.03, cap: 1.5 },
  },
  {
    id: 'replica-3',
    name: 'Zero-copy',
    icon: 'helix',
    blurb:
      'Replicas gain an extra x1.05 for every 10 you run, up to x3. Data moves through the process without ever being copied, and the more of them you run the more the saving compounds.',
    rung: 22,
    reveal: (state) => owned(state, 'replica') >= 50,
    effect: { kind: 'serviceCurve', serviceId: 'replica', mult: 1.05, cap: 3 },
  },
  {
    id: 'replica-4',
    name: 'Amortised',
    icon: 'trend',
    blurb:
      'Replicas produce more the more shards the fleet has spent, up to +300% at 25,000. Every upgrade already bought has been written off its cost, and capacity that is paid for returns more on every read it serves.',
    rung: 23,
    capstone: true,
    reveal: (state) => owned(state, 'replica') >= 100,
    /* The ladder's only reward for HAVING SPENT, the mirror of
       `serviceShardsEarned`. The quantity is `shardsEarned - shards`, which is
       what is gone rather than what is held, so an idle hoard earns nothing
       and the row pays a player who actually bought out the ladder.
       25,000 is chosen against the ladder's own total, which is now
       `SHARDS.pacing.targetTotal` (30,000) and asserted by `check:ladder`:
       clearing every rung once costs that much, so 25,000 is 83% of a buy-out
       and a player who works through the ladder reaches the cap near the end
       rather than after it. A round figure ABOVE the total would be a cap
       nothing could ever reach in a run.

       The cap was NOT raised alongside the total, and that is the reading to
       keep: 25,000 was 92% of the old 27,260 and is 83% of the new 30,000, so
       it now lands slightly EARLIER in a buy-out. Both are comfortably inside
       a run, which is the property the figure exists to have, so it moved as a
       consequence of the total rather than to track it. */
    effect: { kind: 'serviceShardsSpent', serviceId: 'replica', per: 0.00012, cap: 3 },
  },

  /* Region -------------------------------------------------------------- */
  {
    id: 'region-1',
    name: 'Vertical scale',
    icon: 'broadcast',
    blurb:
      'Regions produce more the higher they sit on the ladder, up to +60%. Each step up the stack carries more of the fleet with it, so the tiers near the top scale harder than the ones below.',
    rung: 24,
    reveal: (state) => owned(state, 'region') >= 10,
    /*
     * The quantity is the tier's own INDEX, and Region sits at 6: 6 x 0.1 =
     * 0.6, which is the cap.
     *
     * The old `1` was not merely unreachable, it was unreachable by
     * CONSTRUCTION -- it would need an eleventh tier, and the target is eight.
     * The badge printed `x2` for a row worth at most `x1.6`, sitting beside a
     * blurb that said `+60%`. The cap is now the real ceiling, so both agree.
     *
     * **A deeper ladder changes this**: the cap is `index x per` for whatever
     * tier carries the row, so moving the row down a tier lowers it.
     */
    effect: { kind: 'servicePosition', serviceId: 'region', per: 0.1, cap: 0.6 },
  },
  {
    id: 'region-2',
    name: 'Lifetime traffic',
    icon: 'funnel',
    blurb:
      'Regions produce more the more compute you have earned in total, up to +200%. A region that has moved real traffic keeps the routes it learned, and routes that are already warm are the whole cost of running one.',
    rung: 25,
    reveal: (state) => owned(state, 'region') >= 25,
    effect: { kind: 'serviceLifetime', serviceId: 'region', per: 2e-12, cap: 2 },
  },
  {
    id: 'region-3',
    name: 'Metcalfe\'s law',
    icon: 'anchor',
    blurb:
      'Every Region adds +2% to its own output, up to x3. A network is worth the square of its nodes, a claim that has appeared in a slide every year since 1993.',
    rung: 26,
    reveal: (state) => owned(state, 'region') >= 50,
    effect: { kind: 'servicePerOwned', serviceId: 'region', per: 0.02, cap: 2 },
  },
  {
    id: 'region-4',
    name: 'Anycast',
    icon: 'scales',
    blurb:
      'Region output grows with its share of your fleet, up to x4. The same address answers from everywhere and the routing table simply picks the nearest.',
    rung: 27,
    capstone: true,
    reveal: (state) => owned(state, 'region') >= 100,
    effect: { kind: 'serviceShare', serviceId: 'region', mult: 3, cap: 4 },
  },

  /* Datacenter ---------------------------------------------------------- */
  {
    id: 'datacenter-1',
    name: 'Full stack',
    icon: 'layers',
    blurb:
      'Datacenters produce twice as much while every one of the eight tiers is deployed. A building only earns its footprint when the whole stack runs inside it, so the reward is for breadth as much as for the concrete.',
    rung: 28,
    reveal: (state) => owned(state, 'datacenter') >= 10,
    effect: { kind: 'serviceFullStack', serviceId: 'datacenter', mult: 2 },
  },
  {
    id: 'datacenter-2',
    name: 'Apex',
    icon: 'star',
    blurb:
      'Datacenters produce more the higher the fleet has climbed, up to +120%. The top of the stack sees every layer below it, so the highest building you have ever stood up is worth the most.',
    rung: 29,
    reveal: (state) => owned(state, 'datacenter') >= 25,
    /*
     * PRICE OVERRIDE -- the first in the game, and it exists because a tier
     * gets ONE `base` for its first three rows. Datacenter reads
     * 500 / 750 / 750 / 1000, which has three different values among rows 1-3,
     * so it cannot be expressed by the band table alone.
     *
     * `check:ladder` asserts an override must be one of the band costs, so this
     * cannot invent a price the player would not recognise; 750 is in the set.
     * Keep overrides to cases a band genuinely cannot express, and prefer moving
     * a band boundary when it can -- a table is one decision, an override is
     * one per row.
     */
    price: 750,
    /* The quantity is `apexIndex + 1` -- the HIGHEST tier deployed -- so with
       eight tiers the maximum is 8 x 0.15 = 1.2, which is now the cap. The old
       `1.5` needed ten tiers and could never bind, so the badge printed `x2.5`
       against a blurb saying `+120%`. */
    effect: { kind: 'serviceApex', serviceId: 'datacenter', per: 0.15 },
  },
  {
    id: 'datacenter-3',
    name: 'Scale-up',
    icon: 'server',
    blurb:
      'Your Datacenter share of the fleet adds to ALL output, up to +50%. Put everything in one big box and every service shares the same floor space, power and cooling -- right up until it does not.',
    rung: 30,
    reveal: (state) => owned(state, 'datacenter') >= 50,
    /* Second half of the Datacenter price override -- see `datacenter-2`. */
    price: 750,
    effect: { kind: 'serviceGlobalShare', serviceId: 'datacenter', mult: 1, cap: 0.5 },
  },
  {
    id: 'datacenter-4',
    name: 'Right-sizing',
    icon: 'shard',
    blurb:
      'Every Datacenter unit raises shard income by 0.4%, up to +100% at 250 units. Right-sizing the fleet means you stop paying for capacity you never use, and the savings come back as shards.',
    rung: 31,
    capstone: true,
    reveal: (state) => owned(state, 'datacenter') >= 100,
    /*
     * The ONLY cap here bounded by units rather than by content size, so it is
     * the only one that had to be MEASURED. `check:progression` reports the
     * peak unit count each tier reaches in a day: Datacenter peaks at 175 / 228
     * / 283 across seeds (min / median / max).
     *
     * The old `2.5` needed 625 units, so it could never bind, and the badge's
     * `x3.5` was a figure the game does not pay. The blurb said `+150%`, which
     * is the MULTIPLIER form of the same cap (`1 + 2.5`) rather than its
     * bonus -- so the two surfaces disagreed with each other as well as with
     * the game.
     *
     * 250 units is a round figure INSIDE the measured range, so the cap binds
     * near the end of a strong run and the badge is true. The cost is real and
     * small: the row's practical ceiling was 283 x 0.004 = 1.13, so a deep run
     * loses about 12% of this one row's contribution. **If the intent is the
     * original +150% ceiling, raise `per` to 0.006 rather than the cap** --
     * that would make 250 units worth +150%, at the price of a real buff.
     */
    effect: { kind: 'serviceShardGain', serviceId: 'datacenter', per: 0.004, cap: 1 },
  },

  /* ======================================================================
     GLOBAL: the shop ladder (rungs 32..63, thirty-two rows)

     ORDERED BY PRICE, and that is load-bearing rather than tidy. A global's
     price comes from its POSITION here (see `SHARDS.globalBands`), so the
     list has to ascend by price for the bands to land right. It does not
     disturb the panel, because the panel buckets rows by EFFECT KIND and
     renders each bucket in source order -- so grouping by kind happens at
     render time and grouping by price happens here, and the two do not fight.

     WHAT THAT BUYS: each KIND occupies one row in each price band, so every
     measured thing the player can invest in is a proper ladder climbing
     100 -> 250 -> 500 -> 1000. Before this, `shardGain` had six rows all in
     two bands (four of them near-identical values) while `autoDeploy` had two,
     so "investment" read as six ways to buy the same thing and one way to buy
     the two things that mattered.

     Each ladder's values are distinct steps, and totals are held near their
     old products so the pacing does not move:

       Deploys        x2   x3   x4   x5      = 120    (was 120)
       Deploy share   +0.1  +0.2            (0.2 base -> 0.5; see below)
       Output         x2   x2.5 x3.5 x5      = 87.5   (was 87.65)
       Shards         x2   x2.5 x4           = 20     (was 20.4)
       Auto-deploy    2/s  3/s  4/s  5/s     = 14     (was 14)
       Auto-buy       2/s  4/s  6/s  8/s     = 20     (was 15)
       Cost           x.90  x.85  x.80       = 0.612  (was 0.615)
       Contracts      pay x1.5, x2; +2, +4 slots

     `autoDeploy` is deliberately held at 14/s rather than allowed to climb
     with the extra rows: an automated deploy is worth `CLICK.autoDeployShare`
     of production EACH, so the full rate is +210% production. Adding rows is
     there to make the ladder legible, not to make it worth more.

     `throughputShare` is a SECOND deploy ladder and it is NOT a multiplier: it
     adds share points to `CLICK.throughputShare`, so it raises how much of
     PRODUCTION a deploy reads rather than scaling the finished click. Its two
     rows took over `synergy-1` and `offline-1`, which is why the count above
     still totals 64 and neither price band moved -- a global's price comes from
     its POSITION here, so replacing a row in place is the only way to add a
     kind without repricing the shop or disturbing `targetTotal`.
     ====================================================================== */

  /* --- Band 1 of 4: the entry step of every ladder --------------------- */
  {
    id: 'click-1',
    name: 'Manual runbook',
    icon: 'wrench',
    blurb:
      'Manual deploys are twice as effective. Write the steps down once, follow them every time, and the button stops being a guess.',
    rung: 32,
    reveal: (state) => state.clicks >= 10,
    effect: { kind: 'clickMult', mult: 2 },
  },
  {
    id: 'global-1',
    name: 'Horizontal scaling',
    icon: 'rocket',
    blurb:
      'Everything produces 150% more. Add more machines rather than bigger ones, and the growth curve stops being a wall.',
    rung: 33,
    reveal: (state) => totalOwned(state) >= 100,
    /*
     * THE ADDITIVE GLOBAL, and it is deliberately the EARLIEST one.
     *
     * The axis is `(1 + SUM additive) x PRODUCT multiplicative`, so an additive
     * bonus is worth `1 + a/(1 + SUM)` -- a factor that SHRINKS as the pool
     * grows, while a multiplicative one is worth its `m` however large the pool
     * is. Additive is therefore strongest when the pool is small, which is
     * exactly at this rung: it is the cheapest global upgrade in the game and
     * the achievement pool is only a few bronze bonuses deep when it appears.
     *
     * The pair `global-1` (additive, cheap) and `global-2` (multiplicative,
     * dearer) is the whole point of the two kinds: an early additive is the
     * better buy while the pool is thin, and a later multiplicative overtakes it
     * permanently. That is a decision the player can get wrong, which is what
     * makes it a decision.
     *
     * +150% is chosen to be worth about the x2 it replaced AT THE POINT IT IS
     * BOUGHT: `(1 + SUM + 1.5)` equals `(1 + SUM) x 2` when the pool is +50%,
     * i.e. two bronze achievements. Deeper into the run it is worth less than
     * that x2 would have been, and that is the intended trade rather than drift.
     */
    effect: { kind: 'globalAdd', value: 1.5 },
  },
  {
    id: 'shards-1',
    name: 'Salvage rights',
    icon: 'shard',
    blurb:
      'Shard income rises by half. The clause about who keeps the decommissioned hardware was four pages in, and it now says you.',
    rung: 34,
    reveal: (state) => state.contractsCompleted >= 10,
    effect: { kind: 'shardGain', mult: 1.5 },
  },
  {
    id: 'auto-1',
    name: 'Cron deploy',
    icon: 'clock',
    blurb:
      'Performs two manual deploys every second, automatically. The job was always going to run; now it runs on a schedule instead of a hunch.',
    rung: 35,
    reveal: (state) => state.clicks >= 250,
    effect: { kind: 'autoDeploy', rate: 2 },
  },
  {
    id: 'buy-1',
    name: 'Autoscaler',
    icon: 'cog',
    blurb:
      'Buys the cheapest affordable service twice per second, spending compute without asking. This is either capacity management or a subscription with no cancel button.',
    rung: 36,
    reveal: (state) => totalOwned(state) >= 200,
    effect: { kind: 'autoBuy', rate: 2 },
  },
  {
    id: 'cost-1',
    name: 'Volume discount',
    icon: 'cog',
    blurb:
      'Every service costs about 10% less. Buy enough of anything and the sales team starts returning your calls.',
    rung: 37,
    reveal: (state) => totalOwned(state) >= 200,
    effect: { kind: 'costMult', mult: 0.9 },
  },
  {
    id: 'contract-1',
    name: 'Master agreement',
    icon: 'ledger',
    blurb:
      'Contracts pay 1.5x. One signature, standing terms, no renegotiation per job; legal is delighted and delivery has stopped reading the appendix.',
    rung: 38,
    reveal: (state) => state.contractsCompleted >= 12,
    effect: { kind: 'contractReward', value: 1.5 },
  },
  {
    id: 'perOwned-1',
    name: 'Fleet gravity',
    icon: 'anchor',
    blurb:
      'Every unit you own anywhere lifts the whole fleet by 0.2% each, up to +100%. Enough mass and the small tiers stop being small: a Worker bought in the first minute is still contributing hours later.',
    rung: 39,
    reveal: (state) => totalOwned(state) >= 600,
    effect: { kind: 'globalPerOwned', per: 0.002, cap: 1 },
  },

  /* --- Band 2 of 4 ----------------------------------------------------- */
  {
    id: 'click-2',
    name: 'Batch deploys',
    icon: 'deploy',
    blurb:
      'Manual deploys are three times as effective. Ship many changes in one go; a deploy has a fixed cost and you have stopped paying it per change.',
    rung: 40,
    reveal: (state) => state.clicks >= 100,
    effect: { kind: 'clickMult', mult: 3 },
  },
  {
    id: 'global-2',
    name: 'Service mesh',
    icon: 'network',
    blurb:
      'Everything produces 2.5 times as much again. Every service talks through the same sidecar, so retries, timeouts and mTLS are configured once instead of badly in nine languages.',
    rung: 41,
    reveal: (state) => totalOwned(state) >= 400,
    effect: { kind: 'globalMult', mult: 2.5 },
  },
  {
    id: 'shards-2',
    name: 'Liquidation',
    icon: 'funnel',
    blurb:
      'Shard income triples. Everything acquires a residual value the moment somebody writes it into a spreadsheet.',
    rung: 42,
    reveal: (state) => state.contractsCompleted >= 40,
    effect: { kind: 'shardGain', mult: 3 },
  },
  {
    id: 'auto-2',
    name: 'Scheduled pipeline',
    icon: 'pulse',
    blurb:
      'Three deploys per second, unattended. The pipeline runs on a timer rather than on somebody remembering.',
    rung: 43,
    reveal: (state) => state.clicks >= 600,
    effect: { kind: 'autoDeploy', rate: 3 },
  },
  {
    id: 'buy-2',
    name: 'Capacity planner',
    icon: 'scales',
    blurb:
      'Buys four times per second. The planner has a forecast, a headroom margin and a graph that only ever points up.',
    rung: 44,
    reveal: (state) => totalOwned(state) >= 500,
    effect: { kind: 'autoBuy', rate: 4 },
  },
  {
    id: 'cost-2',
    name: 'Committed use',
    icon: 'scales',
    blurb:
      'Every service costs about 15% less again. Promise to keep spending and the rate drops; the spreadsheet only works if you never stop.',
    rung: 45,
    reveal: (state) => totalOwned(state) >= 500,
    effect: { kind: 'costMult', mult: 0.85 },
  },
  {
    id: 'contract-2',
    name: 'Framework agreement',
    icon: 'ledger',
    blurb:
      'Contracts pay 2x. The paperwork was signed once and now applies to everything; the work is identical but the invoice is not.',
    rung: 46,
    reveal: (state) => state.contractsCompleted >= 40,
    effect: { kind: 'contractReward', value: 2 },
  },
  {
    /*
     * KEEPS THE ID `synergy-1` although the row is a deploy upgrade. An upgrade
     * id is a STORAGE KEY and `sanitize()` filters `state.upgrades` against this
     * table, so renaming it would silently drop the purchase from every existing
     * save -- no error, no symptom, shards spent on nothing. The id is a key,
     * not a description; the name and blurb are the description. (The
     * achievement `playtime-50h` carries the same note for the same reason.)
     *
     * REPLACED `synergy` (Warm pathing, +0.75 to every tier's bonus). That was
     * the only place `synergy` was buyable, so the `services-500` achievement is
     * now its sole source. `mods.synergy` still has a writer, so the fold is not
     * orphaned -- but synergy can no longer be bought at all, and that is the
     * trade. It measured a few percent of income beside the multiplicative
     * globals at this price, because a tier's synergy factor saturates at +50%.
     *
     * RAISES THE SHARE OF PRODUCTION a manual deploy reads, so it is worth
     * nothing while `CLICK.base` of 1 still dominates and grows with the fleet.
     * Not `clickAdd`, which multiplies the finished click including the base.
     * 0.1 here plus 0.2 at rung 63 reach the 0.5 ceiling EXACTLY, so there is no
     * `cap` field -- a cap that cannot bind is a lie about a number.
     */
    id: 'synergy-1',
    name: 'Runbook practice',
    icon: 'wrench',
    blurb:
      'A manual deploy is worth three tenths of a second of production instead of a fifth. The steps have not changed; what changed is that the hand following them has stopped needing to think about them.',
    rung: 47,
    reveal: (state) => state.clicks >= 500,
    effect: { kind: 'throughputShare', per: 0.1 },
  },

  /* --- Band 3 of 4 ----------------------------------------------------- */
  {
    id: 'click-3',
    name: 'Blue-green deploy',
    icon: 'pulse',
    blurb:
      'Manual deploys are four times as effective again. Two identical environments, swap the traffic over, and rollback becomes a routing change rather than an incident.',
    rung: 48,
    reveal: (state) => state.clicks >= 500,
    effect: { kind: 'clickMult', mult: 4 },
  },
  {
    id: 'global-3',
    name: 'Edge fabric',
    icon: 'broadcast',
    blurb:
      'Everything produces 3.5 times as much. Push compute to the edge and most requests never reach your origin at all.',
    rung: 49,
    reveal: (state) => totalOwned(state) >= 900,
    effect: { kind: 'globalMult', mult: 3.5 },
  },
  {
    id: 'shards-3',
    name: 'Circular economy',
    icon: 'beaker',
    blurb:
      'Shard income rises four and a half times over. Nothing is ever scrapped; it is refurbished, relabelled and sold back to you.',
    rung: 50,
    reveal: (state) => state.contractsCompleted >= 90,
    effect: { kind: 'shardGain', mult: 4.5 },
  },
  {
    id: 'auto-3',
    name: 'Fleet controller',
    icon: 'cog',
    blurb:
      'Four deploys per second. At this rate the fleet is replacing itself faster than the dashboard can describe it, and the dashboard has stopped trying.',
    rung: 51,
    reveal: (state) => state.clicks >= 1_200,
    effect: { kind: 'autoDeploy', rate: 4 },
  },
  {
    id: 'buy-3',
    name: 'Spot fleet',
    icon: 'gauge',
    blurb:
      'Buys six times per second. It takes the capacity nobody else is using at the price nobody else would accept, and it is occasionally taken away again mid-thought.',
    rung: 52,
    reveal: (state) => totalOwned(state) >= 900,
    effect: { kind: 'autoBuy', rate: 6 },
  },
  {
    id: 'cost-3',
    name: 'Reserved capacity',
    icon: 'vault',
    blurb:
      'Every service costs about 20% less again. The discount is real, the commitment is real, and the exit clause is a phone call nobody wants to make.',
    rung: 53,
    reveal: (state) => totalOwned(state) >= 1_000,
    effect: { kind: 'costMult', mult: 0.8 },
  },
  {
    id: 'contract-3',
    name: 'Parallel procurement',
    icon: 'vault',
    blurb:
      'Two more contracts run at once. Separate teams, separate queues, separate incident channels, one shared sense of panic.',
    rung: 54,
    reveal: (state) => state.contractsCompleted >= 80,
    effect: { kind: 'contractSlots', slots: 2 },
  },
  {
    id: 'milestone-1',
    name: 'Exponential appetite',
    icon: 'trend',
    blurb:
      'Every milestone is worth +2x more (4x instead of 2x). The chart was already a straight line on a logarithmic axis, and someone asked what happened if it were straighter. Nobody has been able to stop it since.',
    rung: 55,
    reveal: (state) => totalOwned(state) >= 350,
    effect: { kind: 'milestone', value: 2 },
  },

  /* --- Band 4 of 4: the top of every ladder ---------------------------- */
  {
    id: 'click-4',
    name: 'Canary deploy',
    icon: 'trend',
    blurb:
      'Manual deploys are five times as effective again. Send it to one machine first and the rest follow if nothing catches fire, which is a faster way to be brave.',
    rung: 56,
    reveal: (state) => state.clicks >= 5_000,
    effect: { kind: 'clickMult', mult: 5 },
  },
  {
    id: 'global-4',
    name: 'Planetary scale',
    icon: 'trend',
    blurb:
      'Everything produces five times as much. Every region is live, every edge is warm, and the only remaining latency is the speed of light, which has so far resisted negotiation.',
    rung: 57,
    reveal: (state) => totalOwned(state) >= 1_800,
    effect: { kind: 'globalMult', mult: 5 },
  },
  {
    id: 'auto-4',
    name: 'Deploy daemon',
    icon: 'pulse',
    blurb:
      'Five deploys per second, unattended. The fleet ships changes faster than any person could author them, which stopped being a problem the moment nobody asked to see the diff.',
    rung: 58,
    reveal: (state) => totalOwned(state) >= 2_000,
    effect: { kind: 'autoDeploy', rate: 5 },
  },
  {
    id: 'buy-4',
    name: 'Demand model',
    icon: 'network',
    blurb:
      'Buys eight times per second. It knows what you need before you do, which is either forecasting or a very confident guess with a purchase button attached.',
    rung: 59,
    reveal: (state) => totalOwned(state) >= 1_800,
    effect: { kind: 'autoBuy', rate: 8 },
  },
  {
    id: 'contract-4',
    name: 'Standing capacity',
    icon: 'ledger',
    blurb:
      'Four more contracts run at once. The work arrives continuously now, and the only thing left to manage is the calendar.',
    rung: 60,
    reveal: (state) => state.contractsCompleted >= 150,
    effect: { kind: 'contractSlots', slots: 4 },
  },
  {
    id: 'reserve-1',
    name: 'Treasury',
    icon: 'vault',
    blurb:
      'Unspent shards produce four times as much. Money that is doing nothing is still money, provided somebody is keeping the books straight and nobody has discovered the discretionary line item.',
    rung: 61,
    reveal: (state) => state.shards >= 500,
    /*
     * `+0.03` on a base of `0.01` makes the upgraded rate `0.04` -- exactly
     * FOUR times the un-upgraded rate, which is what the blurb claims. It was
     * `0.05` (a five-times claim) until the two production rates were renumbered
     * to round totals; the sentence moved with the number, because a blurb and a
     * figure that disagree is a defect rather than a description.
     */
    effect: { kind: 'reserveBonus', per: 0.03 },
  },
  {
    id: 'coreAmp-1',
    name: 'Silicon lottery',
    icon: 'helix',
    blurb:
      'Every core is worth 60% more. Two dies off the same wafer, one of them happily runs at a clock the other will never see, and it turns out you can simply keep the good one.',
    rung: 62,
    /*
     * A core-only gate made this rung UNREACHABLE IN A RUN, and that is not a
     * matter of taste: cores exist only after a Reboot, and the ladder is
     * documented as ending when the FLEET ends -- one continuous run. So the
     * gate meant two of sixty-four rungs could never be bought, `check:progression`
     * could never report the run as finished, and the ladder's own pace target
     * described a game that could not be completed.
     *
     * This upgrade is `coreAmplify`, so it is worth NOTHING until the player has
     * cores -- buying it early is an investment for after the next Reboot, the
     * same shape as the reserve, which also pays nothing until there is a
     * balance for it to work on. The gate therefore only has to prove the player
     * has climbed far enough for prestige to be the next thing on their mind, and
     * lifetime shards earned says that within one run.
     */
    reveal: (state) => state.shardsEarned >= 5_000,
    effect: { kind: 'coreAmplify', per: 0.03 },
  },
  {
    /*
     * KEEPS THE ID `offline-1` although the row is a deploy upgrade -- see the
     * note on `synergy-1` at rung 47. An upgrade id is a storage key and
     * `sanitize()` is a strict allow-list, so renaming it would strip the
     * purchase from every save that already owned it.
     *
     * REPLACED `offlineCap` +40h (Warm standby), the safest row in the shop to
     * spend: eight achievements already grant cap hours summing past 90 against
     * a base of 8, so it was worth nothing to a player who had earned them, and
     * it is invisible to `check:progression`, which never goes away.
     * `mods.offlineHours` keeps those writers, so the fold is not orphaned.
     *
     * The LAST rung, priced 1000 because a global's price comes from its
     * POSITION here. That is also why the larger step is at the higher price --
     * `check:ladder` requires a kind's value to ascend with its price, and the
     * 0.1 row sits at 750. `per: 0.2` takes the axis from 0.3 to its 0.5
     * ceiling, the same mechanism as rung 47 with a bigger step.
     *
     * The gate is `shardsEarned`, the same one `coreAmp-1` above uses. An
     * offline-only gate would be unreachable for a continuous session, which is
     * what "run" means everywhere in this file and what `check:progression`
     * models.
     */
    id: 'offline-1',
    name: 'Second nature',
    icon: 'trend',
    blurb:
      'Half a second of production per deploy, up from a third. Nothing about the fleet changed; what changed is how much of it a single press reaches, and the button stops feeling like a formality.',
    rung: 63,
    reveal: (state) => state.shardsEarned >= 5_000,
    effect: { kind: 'throughputShare', per: 0.2 },
  },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(
  UPGRADES.map((upgrade) => [upgrade.id, upgrade]),
);

/* --------------------------------------------------------------------------
   Achievements
   Persist forever. Never reset by Reboot.

   Each one carries:
     rarity   - bronze / silver / gold / mythic. Drives the glyph stroke
                weight, the medallion tint, the reward size and the on-screen
                label, so rarity survives greyscale and colour-vision differences.
     group    - which section of the achievements panel it is filed under
     icon     - which reusable line glyph to draw (see icons.ts)
     progress - so a locked entry shows how close it is, not just that it is shut
     rewards  - one or more permanent bonuses. Every one applies. They range
                from flat multipliers to brand-new active abilities.
   -------------------------------------------------------------------------- */

const atLeast = (current: number, target: number) => ({ current, target });

const allTiersOwned = (state: GameState): boolean =>
  SERVICES.every((service) => (state.services[service.id] ?? 0) >= 1);

const bestOwned = (state: GameState): number =>
  Math.max(0, ...SERVICES.map((service) => state.services[service.id] ?? 0));

const abilityUses = (state: GameState, id: string): number =>
  state.abilities[id]?.uses ?? 0;

const totalAbilityUses = (state: GameState): number =>
  ABILITIES.reduce((sum, ability) => sum + abilityUses(state, ability.id), 0);

/*
 * Output reward sizes by rarity, in PERCENTAGE POINTS rather than multipliers.
 *
 * These feed the ADDITIVE achievement pool, so +25% and +50% add to +75%
 * rather than multiplying to 1.875x. Named `_BONUS` rather than being bare
 * numbers because a reader who mistook +100% for a multiplier would halve the
 * value of every gold.
 *
 * Additive because a reward has to be worth reading on its card: roughly +10%
 * is the floor, and multiplying forty-four sub-1% values only exists as a pool
 * no player can trace back to a card.
 *
 * The tiering is 2x per step (25/50/100/200), so rarity is predictable rather
 * than a per-card guess. A reward that does not match its rarity is a typing
 * error the panel cannot show.
 */
const BRONZE_BONUS = 0.25;
const SILVER_BONUS = 0.5;
const GOLD_BONUS = 1;
const MYTHIC_BONUS = 2;

export const ACHIEVEMENTS: AchievementDef[] = [
/* One chain per achievement group, authored hardest-first: the panel renders
   each group in source order, so this list IS the order the player sees. */
  {
    /* The END of the deploy chain. Four more sat above it (2,000, 7,500,
       15,000 and 40,000 clicks) and were removed rather than retuned: a
       thousand deliberate presses is already past the point where anyone
       clicks on purpose. Their power was folded into the three below, so the
       chain's total is unchanged. */
    id: 'deploys-25000',
    name: 'Machine hands',
    blurb: 'Deploy 1,000 times.',
    rarity: 'mythic',
    chain: 'deploys',
    group: 'deploys',
    icon: 'rocket',
    test: (state) => state.clicks >= 1_000,
    progress: (state) => atLeast(state.clicks, 1_000),
    rewards: [
      { kind: 'clickMult', value: 2.5 },
      { kind: 'autoRate', value: 2.5 },
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
    ],
  },
  {
    id: 'deploys-5000',
    name: 'Click engineer',
    blurb: 'Deploy 500 times.',
    rarity: 'gold',
    chain: 'deploys',
    group: 'deploys',
    icon: 'wrench',
    test: (state) => state.clicks >= 500,
    progress: (state) => atLeast(state.clicks, 500),
    /* Sustained hands-on play starts automating itself. */
    rewards: [
      { kind: 'clickMult', value: 1.75 },
      { kind: 'autoRate', value: 1 },
    ],
  },
  {
    /*
     * The id says 1000 and the threshold says 250. That is deliberate and
     * unchanged: an achievement id is a STORAGE KEY and `sanitize()` is a
     * strict allow-list, so renaming this would silently strip the unlock from
     * every save that already had it. The id is a key, not a description.
     */
    id: 'deploys-1000',
    name: 'Human cron job',
    blurb: 'Deploy 250 times.',
    rarity: 'silver',
    chain: 'deploys',
    group: 'deploys',
    icon: 'trend',
    test: (state) => state.clicks >= 250,
    progress: (state) => atLeast(state.clicks, 250),
    rewards: [
      { kind: 'clickMult', value: 1.25 },
      { kind: 'globalBonus', bonus: SILVER_BONUS },
    ],
  },
  {
    id: 'deploys-100',
    name: 'Muscle memory',
    blurb: 'Deploy 100 times.',
    rarity: 'bronze',
    chain: 'deploys',
    group: 'deploys',
    icon: 'repeat',
    test: (state) => state.clicks >= 100,
    progress: (state) => atLeast(state.clicks, 100),
    /* Rewards the clicking itself as well as the fleet. */
    rewards: [
      { kind: 'globalBonus', bonus: BRONZE_BONUS },
      { kind: 'clickMult', value: 1.05 },
    ],
  },
  {
    id: 'deploys-10',
    name: 'Getting the hang of it',
    blurb: 'Deploy 10 times.',
    rarity: 'bronze',
    chain: 'deploys',
    group: 'deploys',
    icon: 'deploy',
    test: (state) => state.clicks >= 10,
    progress: (state) => atLeast(state.clicks, 10),
    rewards: [{ kind: 'globalBonus', bonus: BRONZE_BONUS }],
  },
  {
    id: 'first-deploy',
    name: 'Hello, world',
    blurb: 'Deploy once.',
    rarity: 'bronze',
    chain: 'deploys',
    group: 'deploys',
    icon: 'deploy',
    test: (state) => state.clicks >= 1,
    progress: (state) => atLeast(state.clicks, 1),
    rewards: [{ kind: 'globalBonus', bonus: BRONZE_BONUS }],
  },

  /* --- Fleet ------------------------------------------------------------
     Authored hardest-first, like every other group. The panel renders source
     order, so this list IS the order the player sees.
     --------------------------------------------------------------------- */
  {
    id: 'services-2000',
    name: 'The fleet is the map',
    blurb: 'Own 2,000 services.',
    rarity: 'mythic',
    chain: 'services',
    group: 'fleet',
    icon: 'vault',
    test: (state) => totalOwned(state) >= 2_000,
    progress: (state) => atLeast(totalOwned(state), 2_000),
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'shardGain', value: 1.25 },
    ],
  },
  {
    id: 'services-1000',
    name: 'Four digits',
    blurb: 'Own 1,000 services.',
    rarity: 'gold',
    chain: 'services',
    group: 'fleet',
    icon: 'grid',
    test: (state) => totalOwned(state) >= 1_000,
    progress: (state) => atLeast(totalOwned(state), 1_000),
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'contractSlots', slots: 1 },
    ],
  },
  {
    id: 'services-500',
    name: 'Hyperscale fleet',
    blurb: 'Own 500 services.',
    rarity: 'gold',
    chain: 'services',
    group: 'fleet',
    icon: 'rocket',
    test: (state) => totalOwned(state) >= 500,
    progress: (state) => atLeast(totalOwned(state), 500),
    /*
     * Was MYTHIC while the two entries ABOVE it paid GOLD, so the middle of
     * the chain paid the most. Rarity has to predict the reward or it is not a
     * tier, and only the checker can catch a mismatch like that -- it renders
     * as a slightly larger number on a card.
     */
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'synergy', value: 0.5 },
    ],
  },
  {
    id: 'services-250',
    name: 'Regional presence',
    blurb: 'Own 250 services.',
    rarity: 'gold',
    chain: 'services',
    group: 'fleet',
    icon: 'cpu',
    test: (state) => totalOwned(state) >= 250,
    progress: (state) => atLeast(totalOwned(state), 250),
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'unlockAbility', abilityId: 'provision' },
    ],
  },
  {
    id: 'services-100',
    name: 'At scale',
    blurb: 'Own 100 services.',
    rarity: 'gold',
    chain: 'services',
    group: 'fleet',
    icon: 'grid',
    test: (state) => totalOwned(state) >= 100,
    progress: (state) => atLeast(totalOwned(state), 100),
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'serviceMult', serviceId: 'cache', value: 1.5 },
    ],
  },
  {
    id: 'services-50',
    name: 'Fleet operator',
    blurb: 'Own 50 services.',
    rarity: 'silver',
    chain: 'services',
    group: 'fleet',
    icon: 'grid',
    test: (state) => totalOwned(state) >= 50,
    progress: (state) => atLeast(totalOwned(state), 50),
    rewards: [
      { kind: 'globalBonus', bonus: SILVER_BONUS },
      { kind: 'serviceMult', serviceId: 'worker', value: 1.25 },
    ],
  },
  {
    id: 'services-10',
    name: 'Small fleet',
    blurb: 'Own 10 services.',
    rarity: 'bronze',
    chain: 'services',
    group: 'fleet',
    icon: 'grid',
    test: (state) => totalOwned(state) >= 10,
    progress: (state) => atLeast(totalOwned(state), 10),
    rewards: [{ kind: 'globalBonus', bonus: BRONZE_BONUS }],
  },
  {
    id: 'services-1',
    name: 'First service',
    blurb: 'Own one service.',
    rarity: 'bronze',
    chain: 'services',
    group: 'fleet',
    icon: 'cube',
    test: (state) => totalOwned(state) >= 1,
    progress: (state) => atLeast(totalOwned(state), 1),
    rewards: [{ kind: 'globalBonus', bonus: BRONZE_BONUS }],
  },

  /* ---------------------------------------------------------------------
     Per-service depth, ONE PER TIER.

     The first achievements that name a SINGLE service. The fleet-wide
     `fleet-deep-300` asked "is any tier deep"; these ask "is THIS tier deep",
     so a player who specialised is told which tier paid off. That general one
     was dropped in the 64-trim as the weaker of the pair.

     THEY ARE TIERED, and the tiers come from measurement rather than from the
     cost table. Reaching 100 units of each tier, median over 8 seeds:

       worker 0.13h   cache 0.14h   queue 0.19h   database 0.23h
       balancer 0.26h  replica 0.32h  region 0.45h  datacenter 0.52h

     A clean 4x spread in tier order, so rarity ascends with the tier, and with
     it the All output bonus: three bronze, three silver, two gold.

     THE THRESHOLD is 100 for all eight even though the difficulty differs,
     because all eight land inside the first half hour and the fleet plateaus
     a little over 300 per tier. Raising the top tiers' thresholds would not
     make them harder in any way the player would feel; it would just delay a
     reward that is already earned.

     THE TIER BUFF IS IDENTICAL FOR ALL EIGHT: +100% to that tier's own output.
     Only the "All output" bonus differs, and it follows rarity (bronze +25%,
     silver +50%, gold +100%). So the eight cards read as ONE promise -- "reach
     100 of this tier and it produces twice as much" -- with the rarity word
     carrying the only escalation.

     That uniformity is the point rather than a simplification. `serviceMult`
     multiplies the tier's own output, and base output runs from 0.1 (Worker)
     to 44,000 (Datacenter), so +100% is already worth roughly 440,000x more on
     a Datacenter than on a Worker. Escalating the multiplier as well would
     double-count that -- the previous 1.4/1.5/1.6 gradient did exactly that,
     and it also made two cards for identical effort advertise different-sized
     rewards for the same words. The rarity ladder still separates them through
     All output, which is the one axis where a difference is honest.
     --------------------------------------------------------------------- */
  {
    id: 'deep-datacenter',
    name: 'Datacenters, stacked',
    blurb: 'Reach 100 units of Datacenter.',
    rarity: 'gold',
    chain: 'deep',
    group: 'fleet',
    icon: 'server',
    test: (state) => owned(state, 'datacenter') >= 100,
    progress: (state) => atLeast(owned(state, 'datacenter'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'datacenter', value: 2 },
      { kind: 'globalBonus', bonus: GOLD_BONUS },
    ],
  },
  {
    id: 'deep-region',
    name: 'Regions, stacked',
    blurb: 'Reach 100 units of Region.',
    rarity: 'gold',
    chain: 'deep',
    group: 'fleet',
    icon: 'broadcast',
    test: (state) => owned(state, 'region') >= 100,
    progress: (state) => atLeast(owned(state, 'region'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'region', value: 2 },
      { kind: 'globalBonus', bonus: GOLD_BONUS },
    ],
  },
  {
    id: 'deep-replica',
    name: 'Replicas, stacked',
    blurb: 'Reach 100 units of Replica.',
    rarity: 'silver',
    chain: 'deep',
    group: 'fleet',
    icon: 'cluster',
    test: (state) => owned(state, 'replica') >= 100,
    progress: (state) => atLeast(owned(state, 'replica'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'replica', value: 2 },
      { kind: 'globalBonus', bonus: SILVER_BONUS },
    ],
  },
  {
    id: 'deep-balancer',
    name: 'Balancers, stacked',
    blurb: 'Reach 100 units of Load balancer.',
    rarity: 'silver',
    chain: 'deep',
    group: 'fleet',
    icon: 'scales',
    test: (state) => owned(state, 'balancer') >= 100,
    progress: (state) => atLeast(owned(state, 'balancer'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'balancer', value: 2 },
      { kind: 'globalBonus', bonus: SILVER_BONUS },
    ],
  },
  {
    id: 'deep-database',
    name: 'Databases, stacked',
    blurb: 'Reach 100 units of Database.',
    rarity: 'silver',
    chain: 'deep',
    group: 'fleet',
    icon: 'disk',
    test: (state) => owned(state, 'database') >= 100,
    progress: (state) => atLeast(owned(state, 'database'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'database', value: 2 },
      { kind: 'globalBonus', bonus: SILVER_BONUS },
    ],
  },
  {
    id: 'deep-queue',
    name: 'Queues, stacked',
    blurb: 'Reach 100 units of Queue.',
    rarity: 'bronze',
    chain: 'deep',
    group: 'fleet',
    icon: 'conduit',
    test: (state) => owned(state, 'queue') >= 100,
    progress: (state) => atLeast(owned(state, 'queue'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'queue', value: 2 },
      { kind: 'globalBonus', bonus: BRONZE_BONUS },
    ],
  },
  {
    id: 'deep-cache',
    name: 'Caches, stacked',
    blurb: 'Reach 100 units of Cache.',
    rarity: 'bronze',
    chain: 'deep',
    group: 'fleet',
    icon: 'layers',
    test: (state) => owned(state, 'cache') >= 100,
    progress: (state) => atLeast(owned(state, 'cache'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'cache', value: 2 },
      { kind: 'globalBonus', bonus: BRONZE_BONUS },
    ],
  },
  {
    id: 'deep-worker',
    name: 'Workers, stacked',
    blurb: 'Reach 100 units of Worker.',
    rarity: 'bronze',
    chain: 'deep',
    group: 'fleet',
    icon: 'cpu',
    test: (state) => owned(state, 'worker') >= 100,
    progress: (state) => atLeast(owned(state, 'worker'), 100),
    rewards: [
      { kind: 'serviceMult', serviceId: 'worker', value: 2 },
      { kind: 'globalBonus', bonus: BRONZE_BONUS },
    ],
  },
  {
    id: 'every-tier',
    name: 'Full stack',
    blurb: 'Own at least one of every service tier.',
    rarity: 'gold',
    chain: 'full-stack',
    group: 'fleet',
    icon: 'layers',
    test: allTiersOwned,
    progress: (state) => {
      const tiers = SERVICES.filter((s) => (state.services[s.id] ?? 0) >= 1).length;
      return atLeast(tiers, SERVICES.length);
    },
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'milestone', value: 0.1 },
    ],
  },

  /* --- Output -----------------------------------------------------------
     Hardest-first, and the same rule for every chain inside it.
     --------------------------------------------------------------------- */
  /*
   * LIFETIME COMPUTE. The RANGE of this chain is the thing to know before
   * touching any of the four rungs, because the range is what was wrong.
   *
   * The rungs used to be 1e3, 1e9, 1e12, 1e15 -- gaps of six decades, then
   * three, then three. The uneven gaps are the tell: they were inherited rather
   * than chosen, and they meant the chain's low end was crossed in the opening
   * minutes while its top end was the only rung carrying any information.
   *
   * They are now a UNIFORM four decades apart -- 1e3, 1e7, 1e11, 1e15 -- which
   * keeps BOTH ends where they were and moves the two middle rungs down onto an
   * even spacing. Uniform for the same reason the upgrade PRICES are banded
   * rather than curved: a step the player can predict is a step they stop
   * having to work out. Each rung now marks a quarter of the climb rather than
   * three of them landing in the same afternoon.
   *
   * The ends are fixed by design. The bottom is the floor of a chain that has to
   * start where the player starts, and the top must sit at the END OF THE GAME
   * -- `check:progression` is the authority on where a day of play lands, and
   * it is the first thing to re-read if any of these four moves again.
   */
  {
    id: 'compute-1q',
    name: 'Quadrillion club',
    blurb: 'Earn 1,000,000,000,000,000 compute in total.',
    rarity: 'mythic',
    chain: 'compute',
    group: 'output',
    icon: 'crown',
    test: (state) => state.totalEarned >= 1e15,
    progress: (state) => atLeast(state.totalEarned, 1e15),
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'coreGain', value: 1.3 },
    ],
  },
  {
    id: 'compute-1t',
    name: 'Hundred billion club',
    blurb: 'Earn 100,000,000,000 compute in total.',
    rarity: 'gold',
    chain: 'compute',
    group: 'output',
    icon: 'crown',
    test: (state) => state.totalEarned >= 1e11,
    progress: (state) => atLeast(state.totalEarned, 1e11),
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'coreGain', value: 1.15 },
    ],
  },
  {
    id: 'compute-1b',
    name: 'Ten million club',
    blurb: 'Earn 10,000,000 compute in total.',
    rarity: 'silver',
    chain: 'compute',
    group: 'output',
    icon: 'chart',
    test: (state) => state.totalEarned >= 1e7,
    progress: (state) => atLeast(state.totalEarned, 1e7),
    rewards: [
      { kind: 'globalBonus', bonus: SILVER_BONUS },
      { kind: 'contractReward', value: 1.1 },
    ],
  },
  {
    id: 'compute-1k',
    name: 'Thousand club',
    blurb: 'Earn 1,000 compute in total.',
    rarity: 'bronze',
    chain: 'compute',
    group: 'output',
    icon: 'pulse',
    test: (state) => state.totalEarned >= 1e3,
    progress: (state) => atLeast(state.totalEarned, 1e3),
    rewards: [{ kind: 'globalBonus', bonus: BRONZE_BONUS }],
  },
  {
    id: 'milestone-3',
    name: 'Silicon whisperer',
    blurb: 'Reach 250 units on any single service.',
    rarity: 'mythic',
    chain: 'milestone',
    group: 'output',
    icon: 'star',
    test: (state) => bestOwned(state) >= 250,
    progress: (state) => atLeast(bestOwned(state), 250),
    rewards: [
      { kind: 'milestone', value: 0.25 },
      /* Mythic, so it pays a mythic bonus; it was GOLD. */
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
    ],
  },
  {
    id: 'milestone-1',
    name: 'Tuned',
    blurb: 'Reach the first milestone on any service.',
    rarity: 'bronze',
    chain: 'milestone',
    group: 'output',
    icon: 'target',
    test: (state) => bestOwned(state) >= MILESTONE.step,
    progress: (state) => atLeast(bestOwned(state), MILESTONE.step),
    rewards: [{ kind: 'milestone', value: 0.1 }],
  },
  /*
   * PER SECOND, the LIVE reading rather than a lifetime total -- this is the
   * number the player watches move, which is why its rungs have to be spread
   * across the range a run actually passes through.
   *
   * Same range and same rule as the compute chain above: fixed ends at 1e3 and
   * 1e15, with the middle rung moved down so the two gaps are equal instead of
   * six decades and three. Two of the three rungs used to sit inside the first
   * few minutes of a run.
   */
  {
    id: 'rate-4',
    name: 'Petabyte a second',
    blurb: 'Reach 1,000,000,000,000,000 compute per second.',
    rarity: 'mythic',
    chain: 'rate',
    group: 'output',
    icon: 'crown',
    test: (_state, stats) => stats.perSecond >= 1e15,
    progress: (_state, stats) => atLeast(stats.perSecond, 1e15),
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'contractReward', value: 1.2 },
    ],
  },
  {
    id: 'rate-3',
    name: 'Gigabyte a second',
    blurb: 'Reach 1,000,000,000 compute per second.',
    rarity: 'gold',
    chain: 'rate',
    group: 'output',
    icon: 'chart',
    test: (_state, stats) => stats.perSecond >= 1e9,
    progress: (_state, stats) => atLeast(stats.perSecond, 1e9),
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'contractReward', value: 1.15 },
    ],
  },
  {
    id: 'rate-1',
    name: 'Steady stream',
    blurb: 'Reach 1,000 compute per second.',
    rarity: 'silver',
    chain: 'rate',
    group: 'output',
    icon: 'chart',
    test: (_state, stats) => stats.perSecond >= 1e3,
    progress: (_state, stats) => atLeast(stats.perSecond, 1e3),
    /*
     * The away-rate reward was 0.55 and could never take effect: the fold is
     * `Math.max` over every reward AND `Math.max(OFFLINE.baseEfficiency=0.5)`, 
     * and `offline-5` grants 0.6 after only five returns. So a silver
     * achievement was giving away something the player already had. Swapped
     * for away CAP, which accumulates and therefore always lands.
     */
    rewards: [
      { kind: 'globalBonus', bonus: SILVER_BONUS },
      { kind: 'offlineCap', hours: 4 },
    ],
  },
  {
    id: 'contracts-500',
    name: 'Industry standard',
    blurb: 'Complete 500 contracts.',
    rarity: 'mythic',
    chain: 'contracts',
    group: 'output',
    icon: 'medal',
    test: (state) => state.contractsCompleted >= 500,
    progress: (state) => atLeast(state.contractsCompleted, 500),
    rewards: [
      { kind: 'contractReward', value: 1.5 },
      { kind: 'contractSlots', slots: 1 },
    ],
  },
  {
    id: 'contracts-200',
    name: 'Sole supplier',
    blurb: 'Complete 200 contracts.',
    rarity: 'gold',
    chain: 'contracts',
    group: 'output',
    icon: 'medal',
    test: (state) => state.contractsCompleted >= 200,
    progress: (state) => atLeast(state.contractsCompleted, 200),
    /*
     * Demoted mythic -> gold. It was mythic alongside `contracts-500`, which
     * made the top of the chain two equal rungs and left "500 contracts"
     * with nothing above it to be rarer than. Gold also matches its reward,
     * which was already smaller than the 500 entry's.
     */
    rewards: [
      { kind: 'contractReward', value: 1.5 },
      { kind: 'globalBonus', bonus: GOLD_BONUS },
    ],
  },
  {
    id: 'contracts-50',
    name: 'Preferred supplier',
    blurb: 'Complete 50 contracts.',
    rarity: 'gold',
    chain: 'contracts',
    group: 'output',
    icon: 'medal',
    test: (state) => state.contractsCompleted >= 50,
    progress: (state) => atLeast(state.contractsCompleted, 50),
    rewards: [{ kind: 'contractReward', value: 1.25 }],
  },
  {
    id: 'contracts-25',
    name: 'Repeat business',
    blurb: 'Complete 25 contracts.',
    rarity: 'gold',
    chain: 'contracts',
    group: 'output',
    icon: 'medal',
    test: (state) => state.contractsCompleted >= 25,
    progress: (state) => atLeast(state.contractsCompleted, 25),
    /* Surge is granted HERE rather than at 50 contracts: fifty is several
       hours of active play, and Surge is the reward that makes the Contracts
       panel worth engaging with rather than the trophy for having already
       engaged with it. */
    rewards: [
      { kind: 'contractReward', value: 1.15 },
      { kind: 'unlockAbility', abilityId: 'surge' },
    ],
  },
  {
    id: 'contracts-10',
    name: 'On contract',
    blurb: 'Complete 10 contracts.',
    rarity: 'silver',
    chain: 'contracts',
    group: 'output',
    icon: 'medal',
    test: (state) => state.contractsCompleted >= 10,
    progress: (state) => atLeast(state.contractsCompleted, 10),
    rewards: [{ kind: 'contractReward', value: 1.1 }],
  },
  {
    id: 'shards-100k',
    name: 'War chest',
    blurb: 'Earn 100,000 shards in total.',
    rarity: 'gold',
    chain: 'shards',
    group: 'output',
    icon: 'shard',
    test: (state) => state.shardsEarned >= 100_000,
    progress: (state) => atLeast(state.shardsEarned, 100_000),
    rewards: [
      { kind: 'contractReward', value: 1.15 },
      { kind: 'globalBonus', bonus: GOLD_BONUS },
    ],
  },
  {
    id: 'shards-1k',
    name: 'Petty cash',
    blurb: 'Earn 1,000 shards in total.',
    rarity: 'silver',
    chain: 'shards',
    group: 'output',
    icon: 'shard',
    test: (state) => state.shardsEarned >= 1_000,
    progress: (state) => atLeast(state.shardsEarned, 1_000),
    rewards: [{ kind: 'contractReward', value: 1.1 }],
  },

  /* ---------------------------------------------------------------------
     The ladder itself, and the reserve.

     Two new types, and they are the first achievements in the game that
     measure the SHARD economy rather than production. Everything above asks
     how fast compute is being made; these ask how well the shards are being
     turned into power, which is the other half of the game and previously had
     no achievements at all.
     --------------------------------------------------------------------- */
  {
    id: 'ladder-50',
    name: 'Almost everything',
    blurb: 'Buy 50 upgrades.',
    rarity: 'mythic',
    chain: 'ladder',
    group: 'output',
    icon: 'crown',
    test: (state) => state.upgrades.length >= 50,
    progress: (state) => atLeast(state.upgrades.length, 50),
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'shardGain', value: 1.25 },
    ],
  },
  {
    id: 'ladder-10',
    name: 'Shopping',
    blurb: 'Buy 10 upgrades.',
    rarity: 'bronze',
    chain: 'ladder',
    group: 'output',
    icon: 'ledger',
    test: (state) => state.upgrades.length >= 10,
    progress: (state) => atLeast(state.upgrades.length, 10),
    rewards: [
      { kind: 'globalBonus', bonus: BRONZE_BONUS },
      { kind: 'shardGain', value: 1.1 },
    ],
  },
  {
    id: 'hoard-50000',
    name: 'The pile is the fleet',
    blurb: 'Hold 50,000 shards at once.',
    rarity: 'mythic',
    chain: 'hoard',
    group: 'output',
    icon: 'star',
    test: (state) => state.shards >= 50_000,
    progress: (state) => atLeast(state.shards, 50_000),
    rewards: [
      { kind: 'reserveBonus', per: 0.008 },
      { kind: 'coreAmplify', per: 0.01 },
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
    ],
  },
  {
    id: 'hoard-500',
    name: 'Cash on hand',
    blurb: 'Hold 500 shards at once.',
    rarity: 'bronze',
    chain: 'hoard',
    group: 'output',
    icon: 'vault',
    test: (state) => state.shards >= 500,
    progress: (state) => atLeast(state.shards, 500),
    /* Reinforces the reserve rather than paying a multiplier, so the reward
       for holding is more holding -- which is the trade the reserve exists to
       make interesting. */
    rewards: [{ kind: 'reserveBonus', per: 0.002 }],
  },

  /* --- Idle -------------------------------------------------------------
     Hardest-first, like every other group.
     --------------------------------------------------------------------- */
  {
    id: 'offline-50',
    name: 'Long weekend',
    blurb: 'Return from 50 separate absences.',
    rarity: 'gold',
    chain: 'offline',
    group: 'idle',
    icon: 'hourglass',
    test: (state) => state.offlineReturns >= 50,
    progress: (state) => atLeast(state.offlineReturns, 50),
    rewards: [
      { kind: 'offlineCap', hours: 12 },
      { kind: 'offlineEfficiency', value: 0.7 },
    ],
  },
  {
    id: 'offline-20',
    name: 'Follow the sun',
    blurb: 'Return from 20 separate absences.',
    rarity: 'gold',
    chain: 'offline',
    group: 'idle',
    icon: 'hourglass',
    test: (state) => state.offlineReturns >= 20,
    progress: (state) => atLeast(state.offlineReturns, 20),
    rewards: [
      { kind: 'offlineCap', hours: 12 },
      { kind: 'offlineEfficiency', value: 0.8 },
    ],
  },
  {
    id: 'offline-5',
    name: 'Always on',
    blurb: 'Return from 5 separate absences.',
    rarity: 'silver',
    chain: 'offline',
    group: 'idle',
    icon: 'hourglass',
    test: (state) => state.offlineReturns >= 5,
    progress: (state) => atLeast(state.offlineReturns, 5),
    rewards: [
      { kind: 'offlineCap', hours: 8 },
      { kind: 'offlineEfficiency', value: 0.6 },
    ],
  },
  {
    id: 'offline-1',
    name: 'Uptime',
    blurb: 'Come back after at least a minute away.',
    rarity: 'bronze',
    chain: 'offline',
    group: 'idle',
    icon: 'clock',
    test: (state) => state.offlineReturns >= 1,
    progress: (state) => atLeast(state.offlineReturns, 1),
    rewards: [{ kind: 'offlineCap', hours: 4 }],
  },
  {
    id: 'playtime-50h',
    name: 'Home lab',
    blurb: 'Spend 20 hours with the page open.',
    /*
     * The id says 50h and the threshold is 20. Achievement ids are storage
     * keys and `sanitize()` is a strict allow-list, so renaming this would
     * strip the unlock from every save that already had it. The id is a key,
     * not a description; the description is the blurb.
     */
    rarity: 'gold',
    chain: 'playtime',
    group: 'idle',
    icon: 'server',
    test: (state) => state.playtime >= 20 * 60 * 60 * 1000,
    progress: (state) => atLeast(state.playtime, 20 * 60 * 60 * 1000),
    rewards: [
      { kind: 'offlineCap', hours: 12 },
      { kind: 'globalBonus', bonus: GOLD_BONUS },
    ],
  },
  {
    id: 'playtime-15h',
    name: 'Living in the dashboard',
    blurb: 'Spend 15 hours with the page open.',
    rarity: 'gold',
    chain: 'playtime',
    group: 'idle',
    icon: 'server',
    test: (state) => state.playtime >= 15 * 60 * 60 * 1000,
    progress: (state) => atLeast(state.playtime, 15 * 60 * 60 * 1000),
    rewards: [
      { kind: 'offlineCap', hours: 12 },
      { kind: 'globalBonus', bonus: GOLD_BONUS },
    ],
  },
  {
    id: 'playtime-10h',
    name: 'Devoted',
    blurb: 'Spend 10 hours with the page open.',
    rarity: 'silver',
    chain: 'playtime',
    group: 'idle',
    icon: 'clock',
    test: (state) => state.playtime >= 10 * 60 * 60 * 1000,
    progress: (state) => atLeast(state.playtime, 10 * 60 * 60 * 1000),
    rewards: [{ kind: 'offlineCap', hours: 8 }],
  },
  {
    id: 'playtime-1h',
    name: 'On call',
    blurb: 'Spend an hour with the page open.',
    rarity: 'bronze',
    chain: 'playtime',
    group: 'idle',
    icon: 'clock',
    test: (state) => state.playtime >= 60 * 60 * 1000,
    progress: (state) => atLeast(state.playtime, 60 * 60 * 1000),
    rewards: [{ kind: 'offlineCap', hours: 4 }],
  },
  {
    /*
     * Away EARNINGS, a different measurement from away TIME. The `offline-*`
     * chain counts how many times the player came back; this counts how much
     * the fleet produced while they were gone, so a long absence at low output
     * scores worse than a short one at high output. The cap and the rate are
     * separate upgrades, and this is the only achievement that rewards the
     * rate at the top of its range.
     */
    id: 'away-1t',
    name: 'The fleet never sleeps',
    blurb: 'Earn 1,000,000,000,000 compute while away.',
    rarity: 'gold',
    chain: 'away',
    group: 'idle',
    icon: 'hourglass',
    test: (state) => state.totalOfflineEarned >= 1e12,
    progress: (state) => atLeast(state.totalOfflineEarned, 1e12),
    rewards: [
      { kind: 'offlineEfficiency', value: 0.9 },
      { kind: 'offlineCap', hours: 16 },
    ],
  },

  /* --- Prestige ---------------------------------------------------------
     Hardest-first, like every other group. Note that the two id prefixes
     `overclock-*` and `ability-*` measure the SAME thing (total ability uses)
     and sit in one run below, descending -- they are one chain wearing two
     names, and splitting them was what put 250 uses above 1,000.
     --------------------------------------------------------------------- */
  {
    id: 'reboot-40',
    name: 'Nothing is permanent',
    blurb: 'Reboot 40 times.',
    rarity: 'mythic',
    chain: 'reboot',
    group: 'prestige',
    icon: 'shield',
    test: (state) => state.reboots >= 40,
    progress: (state) => atLeast(state.reboots, 40),
    /*
     * This granted NOTHING but `coreGain 1.2` while `reboot-25` below it -- same
     * rarity, 15 fewer reboots -- granted a mythic bonus AND `coreGain 1.3`. So
     * the hardest entry in the chain was strictly worse than an easier one: no
     * reason to reach for it at all. Both numbers are now above reboot-25's;
     * `check:ladder` asserts that per reward kind across every chain.
     */
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'coreGain', value: 1.4 },
    ],
  },
  {
    id: 'reboot-25',
    name: 'Reboot artist',
    blurb: 'Reboot 25 times.',
    rarity: 'mythic',
    chain: 'reboot',
    group: 'prestige',
    icon: 'shield',
    test: (state) => state.reboots >= 25,
    progress: (state) => atLeast(state.reboots, 25),
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'coreGain', value: 1.3 },
    ],
  },
  {
    id: 'reboot-5',
    name: 'Serial replatformer',
    blurb: 'Reboot five times.',
    rarity: 'gold',
    chain: 'reboot',
    group: 'prestige',
    icon: 'shield',
    test: (state) => state.reboots >= 5,
    progress: (state) => atLeast(state.reboots, 5),
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'coreGain', value: 1.15 },
    ],
  },
  {
    id: 'reboot-1',
    name: 'Replatformed',
    blurb: 'Reboot once.',
    rarity: 'silver',
    chain: 'reboot',
    group: 'prestige',
    icon: 'repeat',
    test: (state) => state.reboots >= 1,
    progress: (state) => atLeast(state.reboots, 1),
    rewards: [
      { kind: 'globalBonus', bonus: SILVER_BONUS },
      { kind: 'coreGain', value: 1.1 },
    ],
  },
  {
    id: 'cores-500',
    name: 'Core reserve',
    blurb: 'Hold 500 cores at once.',
    rarity: 'mythic',
    chain: 'cores',
    group: 'prestige',
    icon: 'crown',
    test: (state) => state.cores >= 500,
    progress: (state) => atLeast(state.cores, 500),
    /*
     * Same rarity as `cores-100` and locked at five times the cores, but it
     * granted HALF the burst power. Rarity promises the harder entry is worth
     * at least as much, so the boost is raised to match rather than the
     * threshold lowered -- 500 cores is a legitimate long-horizon goal.
     */
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'boostPower', value: 2 },
      { kind: 'coreGain', value: 1.25 },
    ],
  },
  {
    id: 'cores-100',
    name: 'Core tycoon',
    blurb: 'Hold 100 cores at once.',
    rarity: 'mythic',
    chain: 'cores',
    group: 'prestige',
    icon: 'cpu',
    test: (state) => state.cores >= 100,
    progress: (state) => atLeast(state.cores, 100),
    rewards: [
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
      { kind: 'boostPower', value: 2 },
    ],
  },
  {
    id: 'cores-25',
    name: 'Core collector',
    blurb: 'Hold 25 cores at once.',
    rarity: 'gold',
    chain: 'cores',
    group: 'prestige',
    icon: 'cpu',
    test: (state) => state.cores >= 25,
    progress: (state) => atLeast(state.cores, 25),
    /* Cores and burst power reinforce each other. */
    rewards: [
      { kind: 'globalBonus', bonus: GOLD_BONUS },
      { kind: 'boostPower', value: 1 },
    ],
  },
  {
    id: 'ability-1000',
    name: 'Reflex',
    blurb: 'Use abilities 1,000 times in total.',
    rarity: 'gold',
    chain: 'ability',
    group: 'prestige',
    icon: 'sparkle',
    test: (state) => totalAbilityUses(state) >= 1_000,
    progress: (state) => atLeast(totalAbilityUses(state), 1_000),
    rewards: [
      { kind: 'boostPower', value: 1 },
      { kind: 'boostCooldown', value: 0.95 },
    ],
  },
  {
    id: 'ability-master',
    name: 'Always in burst',
    blurb: 'Use abilities 250 times in total.',
    rarity: 'gold',
    chain: 'ability',
    group: 'prestige',
    icon: 'key',
    test: (state) => totalAbilityUses(state) >= 250,
    progress: (state) => atLeast(totalAbilityUses(state), 250),
    rewards: [
      { kind: 'boostPower', value: 0.5 },
      { kind: 'boostCooldown', value: 0.95 },
    ],
  },
  {
    id: 'overclock-1',
    name: 'Overclocked',
    blurb: 'Use an ability for the first time.',
    rarity: 'bronze',
    chain: 'ability',
    group: 'prestige',
    icon: 'bolt',
    test: (state) => totalAbilityUses(state) >= 1,
    progress: (state) => atLeast(totalAbilityUses(state), 1),
    /* Makes the burst stronger and last longer, not just a flat number. */
    rewards: [
      { kind: 'clickMult', value: 1.1 },
      { kind: 'boostDuration', value: 1.25 },
    ],
  },
  /*
   * SINGLE-RUN earnings, the prestige measurement rather than the lifetime
   * one. `totalEarned` only ever grows and so says almost nothing about how
   * well the current run is going; `runEarned` resets on every Reboot, so
   * these ask "how far did THIS run get" -- the number the Reboot payout is
   * actually computed from.
   */
  {
    id: 'run-1q',
    name: 'A run worth banking',
    blurb: 'Earn 1,000,000,000,000,000 compute in a single run.',
    rarity: 'mythic',
    chain: 'run',
    group: 'prestige',
    icon: 'trend',
    test: (state) => state.runEarned >= 1e15,
    progress: (state) => atLeast(state.runEarned, 1e15),
    rewards: [
      { kind: 'coreGain', value: 1.35 },
      { kind: 'coreAmplify', per: 0.01 },
      { kind: 'globalBonus', bonus: MYTHIC_BONUS },
    ],
  },
  {
    id: 'run-1b',
    name: 'A good run',
    blurb: 'Earn 1,000,000,000 compute in a single run.',
    rarity: 'silver',
    chain: 'run',
    group: 'prestige',
    icon: 'trend',
    test: (state) => state.runEarned >= 1e9,
    progress: (state) => atLeast(state.runEarned, 1e9),
    rewards: [
      { kind: 'coreGain', value: 1.1 },
      { kind: 'globalBonus', bonus: SILVER_BONUS },
    ],
  },
];

/**
 * Rarest first. Used by the achievements PANEL to group by rarity where it
 * needs to, and by nothing else -- the panel renders each group in SOURCE
 * order, so the order of `ACHIEVEMENTS` is the order the player sees.
 */
export const ACHIEVEMENT_RARITIES: AchievementRarity[] = [
  'mythic',
  'gold',
  'silver',
  'bronze',
];

export const RARITY_LABELS: Record<AchievementRarity, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  mythic: 'Mythic',
};

/** How many achievements exist at each rarity. */
export const ACHIEVEMENT_COUNTS: Record<AchievementRarity, number> = {
  bronze: ACHIEVEMENTS.filter((a) => a.rarity === 'bronze').length,
  silver: ACHIEVEMENTS.filter((a) => a.rarity === 'silver').length,
  gold: ACHIEVEMENTS.filter((a) => a.rarity === 'gold').length,
  mythic: ACHIEVEMENTS.filter((a) => a.rarity === 'mythic').length,
};

/** Themed sections, in the order the panel shows them. */
export const ACHIEVEMENT_GROUPS: { id: AchievementGroup; label: string; blurb: string }[] = [
  { id: 'deploys', label: 'Deploys', blurb: 'Rewards for working by hand.' },
  { id: 'fleet', label: 'Fleet', blurb: 'Rewards for the size and breadth of the fleet.' },
  { id: 'output', label: 'Output', blurb: 'Rewards for throughput and contracts.' },
  { id: 'idle', label: 'Idle', blurb: 'Rewards for time spent, in and out of the tab.' },
  { id: 'prestige', label: 'Prestige', blurb: 'Rewards for cores, reboots and burst power.' },
];

export const ACHIEVEMENT_BY_ID: Record<string, AchievementDef> = Object.fromEntries(
  ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]),
);

/* --------------------------------------------------------------------------
   Active abilities

   Overclock is available from the very first tick. Surge and Provision are
   earned by unlocking the achievements that grant them, which is what gives
   the later game a new button to press rather than only a bigger number.

   TIERED BY COOLDOWN, tied to how late each one arrives:

     T1  Overclock   120s   base, from the first tick
     T2  Surge       180s   unlocked by the `contracts-25` achievement
     T3  Provision   300s   unlocked by the `services-250` achievement

   The cooldown lengthens with the tier, so the abilities read as a ladder
   rather than three buttons at one size: the one you start with is the one
   you can lean on most often, and the strongest arrives slowest.

   A NOTE ON THE BANDS: a fixed-`amount` contract's `cost` is meant to be the
   band matching how long the ask really takes, and for an ability that time IS
   its cooldown. So each `skill-*` contract's band follows the cooldown above --
   120s -> `quick`, 180s -> `standard`, 300s -> `project`. Changing a cooldown
   means revisiting the matching contract's band; see the ability defs below.

   These times are a FIRST PASS and are expected to be rebalanced again once
   they have been measured in play -- see `docs/DECISIONS.md`.
   -------------------------------------------------------------------------- */

export const ABILITIES: AbilityDef[] = [
  {
    id: 'overclock',
    name: 'Overclock',
    blurb: 'Push the whole fleet past its rated clock for a short burst.',
    icon: 'bolt',
    kind: 'boost',
    base: true,
    multiplier: 3,
    durationMs: 30_000,
    cooldownMs: 120_000,
    amount: 0,
    summary: '3x production for 30s',
  },
  {
    id: 'surge',
    name: 'Surge',
    blurb: 'A deeper, shorter burst, earned by keeping contracts flowing.',
    icon: 'flame',
    kind: 'boost',
    multiplier: 6,
    durationMs: 20_000,
    cooldownMs: 180_000,
    amount: 0,
    summary: '6x production for 20s',
  },
  {
    id: 'provision',
    name: 'Provision',
    blurb:
      'Stand up free capacity on the spot: twenty-five units, shared across every tier you already run, at no compute cost.',
    icon: 'grid',
    kind: 'freeUnits',
    multiplier: 1,
    durationMs: 0,
    cooldownMs: 300_000,
    /* The BUDGET for one use, not a per-tier floor. It is flat rather than
       scaled by the fleet on purpose: units are exponential in this game (a
       tier's output is 2^floor(owned/25) times its base), so a grant that
       grows with the fleet grows the number of milestone boundaries it
       crosses, which is how the old version reached +7.8 billion percent. See
       the note in engine.ts. */
    amount: 25,
    summary: '25 free units, shared across every tier you run',
  },
];

export const ABILITY_BY_ID: Record<string, AbilityDef> = Object.fromEntries(
  ABILITIES.map((ability) => [ability.id, ability]),
);

/* ==========================================================================
   SHARDS -- the second currency, and the one upgrades are bought with
   ==========================================================================

   The game has exactly two currencies, and they are deliberately different in
   SHAPE rather than only in source:

     compute     exponential income (`1.15^N` units), exponential sink (services)
     shards    objective-driven income, FIXED sink (upgrades)

   Before this split both currencies fed both kinds of sink, which produced a
   real defect: the upgrade ladder is a fixed ladder, so once the fleet passes
   a few hundred units per tier the entire upgrade ladder costs a rounding
   error against one tier's next hundred units -- measured, the whole ladder
   was about 1e-12 of the service spend at 300 units/tier. Upgrades stopped
   being a decision and became noise.

   Giving each currency one income shape and one sink shape makes both of them
   legible: compute is "what can I buy next", shards are "what have I earned".

  Shards are named for what they are in the fiction -- the billable value
  recovered from finished work, which is why several blurbs below talk about
  decommissioned hardware, refurbishment and residual value. They come from
  contract completion and milestone crossings, not passive production, which
  keeps the currency off the exponential curve.
   ========================================================================== */

export const SHARDS = {
  /**
   * Shards a contract pays, by how much WORK it asks for.
   *
   * Keyed on the same four bands a contract's `cost` is drawn from, so a long
   * project pays more than a quick errand. A flat rate made every contract worth
   * the same shards, so the panel had a 90-second errand and a 12-minute job
   * paying identically and no reason to read the card.
   *
   * ROUND NUMBERS is a requirement, not a nicety: the upgrade ladder already
   * prints recognisable PRICES rather than one per row, and a reward is the same
   * kind of thing. `check:ladder` asserts every value is a multiple of 10 and
   * that `soloBonus` keeps it whole.
   *
   * SCALED DOWN FROM 40/80/160/320, for a measurable reason: that set made the
   * whole ladder affordable in about TWENTY MINUTES, because a `quick` contract
   * paid 40 shards against rungs costing 10-25. Measured, the player held 69% of
   * the ladder's entire cost by minute 20 and 21x it by the end of the first
   * hour. Prices had stopped constraining anything.
   *
   * WIDENED AGAIN, 10/20/40/70 -> 10/30/60/100, WHEN CONTRACTS BECAME HONEST.
   * The difficulty fix cut the completion rate roughly in half, which is a
   * FAUCET cut, so the ladder fell outside its target band; paying more per
   * contract is the compensation. It does not undo the fix: work per contract
   * rose ~2.6x while this table rose ~1.4x, so shards-per-unit-of-work FELL by
   * roughly 1.8x.
   *
   * Multiplying this table is the clean lever precisely BECAUSE both price
   * tables are constrained -- they must stay on recognisable round numbers -- so
   * scaling them by 0.7 would produce prices no player recognises.
   *
   * Read through `shardPayout(def)`, which takes the largest band not exceeding
   * the def's cost: monotone and total, so an off-table cost still pays
   * SOMETHING rather than falling through a lookup and paying zero.
   */
  perCost: {
    quick: 10,
    standard: 30,
    project: 60,
    epic: 100,
  },

  /**
   * Shards a MILESTONE STEP pays, on top of the contract faucet.
   *
   * ONLINE-ONLY, and that is not a defect to fix. `applyOffline` credits compute
   * and never buys units, and units are the only thing that crosses a milestone,
   * so no boundary is crossed while away. Contracts remain the only offline
   * source -- which is why `totalEarned` objectives matter. **Never describe
   * this as the "away faucet"; it is the opposite of one**, and that false
   * claim is what got it removed once already.
   *
   * FLAT, and deliberately SMALLER than a `standard` contract (30). It is partly
   * ON the exponential curve, because step count follows unit count and units
   * double every 25, so it is bounded in practice (the fleet settles against the
   * 1.15 cost curve) but the coupling is real. A richer faucet is the documented
   * failure mode: it buys upgrades sooner, raises production, and makes the
   * rate-sized objectives complete in seconds against a 20s floor. Measured, 30
   * produced 7.4x the shard total of 10 rather than 3x. **Do not raise this
   * without re-running `check:progression`** -- the faucet feeds contracts which
   * feed the faucet.
   *
   * It IS multiplied by `shardMult`. Both old award sites read
   * `crossed * perMilestone` with no multiplier at all, so four upgrades
   * labelled "shard income" silently did not apply here. See
   * `milestoneShardAward()`.
   */
  perMilestone: 10,

  /**
   * Depth term: how much more a milestone step pays on a DEEPER tier, as a
   * MULTIPLIER PER TIER INDEX.
   *
   * `perMilestone x milestoneTierMult[tierIndex] x stepTerm`, so with the
   * shipped table a Datacenter step (index 7) is worth **3x** a Worker step and
   * the eight base payouts are exactly
   *
   *     10  12  15  18  21  24  27  30
   *
   * A TABLE RATHER THAN A SLOPE, and that is forced rather than stylistic. The
   * old form was `1 + milestoneTierGain x tierIndex`, which is affine in the
   * index and therefore has CONSTANT DIFFERENCES -- so it can express a ramp of
   * `10 13 16 19 ...` but not `10 12 15 18 ...`, whose first step is +2 and
   * whose remaining steps are all +3. The requested sequence is impossible with
   * a single slope; a table states it directly and is what `SHARDS.tierBands`,
   * `globalBands` and `revealAt` already do for the same reason.
   *
   * DEPTH IS THE SAFE AXIS TO SCALE ON, which is why the escalation lives here
   * and NOT in `perMilestone`. It raises the LATE game and leaves the opening
   * untouched, because no high-index tier exists until the fleet is deep:
   * Worker is identical at 10 under this change, while Datacenter moves 27.5 ->
   * 30. Raising `perMilestone` does the opposite -- it pays more in the FIRST
   * HOUR, which is exactly where the documented failure lives. At 30 the
   * `totalEarned` objectives completed in a typical 10.3s against a 20s floor,
   * because faster production beats a rate-sized objective sooner. A depth term
   * cannot do that, because the tiers it multiplies are not owned yet.
   *
   * It also gives the ladder a reason to keep climbing past the point where a
   * deep tier's output per compute has fallen behind: a deeper tier is now
   * worth more PER MILESTONE as well as per unit.
   *
   * `check:ladder` asserts the length matches `SERVICES`, that it ascends, and
   * that the FIRST entry is 1 -- a tier that paid less than the base would make
   * `perMilestone` a ceiling rather than a floor.
   */
  milestoneTierMult: [1, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3],

  /**
   * The STEP TERM, and the bound on the faucet's own feedback loop -- one
   * constant, because the term and its ceiling are one decision.
   *
   * A milestone pays `N` times the tier's base, where N is the number of the
   * milestone on that tier -- 1x for the 1st, 2x for the 2nd, and so on up to
   * this cap:
   *
   *     perMilestone x tierTerm x min(stepsBanked + 1, this)
   *
   * THE `+ 1` IS THE WHOLE DEFINITION and it is what makes this a CAP on a
   * multiplier rather than an offset into one: `stepsBanked` is the number of
   * milestones ALREADY banked, so the FIRST crossing on a tier reports 0.
   * Without the `+ 1` the opening milestone would pay NOTHING.
   *
   * This replaced `1 + 0.01 x stepsBanked`, which was nearly flat by design (a
   * 1.2x ceiling), so it read as "more as the milestone grows" only in prose.
   *
   * WHY IT MUST BE BOUNDED, AND WHY 2 IS THE SHIPPED VALUE: an `x N` term is
   * far more expensive than it looks, because a DEVELOPED tier has several
   * milestones banked already -- a tier at `MATURE_UNITS` (100) is on its 4th --
   * so `min(N + 1, cap)` sits AT the cap for most of a run's steps. The cap is
   * therefore not a rare ceiling but the EFFECTIVE multiplier on nearly every
   * step, and the faucet scales roughly with it. Measured, 8 seeds, changing
   * only this cap:
   *
   *     cap   avg shards/step   shards/day   milestone share   `totalEarned`
   *     5     79.45            483,077      54.4%             17.5s  FAIL
   *     2     35.95            141,830      49.1%             26.0s  pass
   *     (pre-change: 18.91 / 37,043 / 19.6% / 22.0s)
   *
   * At 5 the faucet ran 13x its old size, the ladder became almost free, and
   * `totalEarned` objectives fell under the 20s floor -- the documented failure
   * arriving on schedule. 2 is the largest cap that leaves every gate green.
   *
   * It also feeds ONLY the step term; the TIER table below is the other half of
   * the payout, and it is the safer one to move because it multiplies tiers that
   * do not exist yet while every tier banks its early steps immediately, Worker
   * included.
   *
   * DO NOT RAISE WITHOUT RE-MEASURING -- the ceiling is set by the CONTRACT
   * SYSTEM, not by this faucet. A generous TIER factor is the safer half; the
   * STEP term is the one to be careful with.
   *
   * **Re-measure with `check:progression` after any move** -- this faucet feeds
   * contracts which feed this faucet.
   */
  milestoneStepMax: 2,

  /**
   * The random completion bonus: a "salvage strike".
   *
   * Most contracts pay their flat rate; occasionally one pays triple. This is
   * the only randomness left in the game, and it is deliberately small and
   * positive-only -- it cannot be lost, only not won, so it is a surprise
   * rather than a gamble. It does not make the rate non-flat: the base is the
   * base, and this is a bonus on top.
   *
   * `bonusChance` is salted with the contract's own completion ordinal, so a
   * given contract pays the same bonus on every reload. Same promise the
   * seeded layer has always made: nothing is re-rolled by refreshing.
   */
  bonusChance: 0.15,
  bonusMult: 3,

  /**
   * Production a HELD shard provides, as a share per square root of the
   * balance: `reservePer * sqrt(shards)`.
   *
   * The reserve gives the balance a job: every shard you are NOT spending buys
   * production instead, which matters because the ladder is finite and a player
   * who has bought everything would otherwise hold a number with no sink.
   *
   * The SQUARE ROOT is the whole design, chosen against a linear rate. Shards
   * accumulate for the life of the save and Reboot does not clear them, so a
   * mature save holds thousands. At 1% per shard LINEAR, 10,000 held would be
   * +10,000% production -- more than every other multiplier combined -- and NOT
   * SPENDING would become strictly better than playing. That is not a bonus, it
   * is a dominant strategy that deletes the upgrade ladder. The root bends it
   * into something that pays forever without running away:
   *
   *     100 held  ->  +10%
   *     1,000     ->  +32%
   *     10,000    ->  +100%
   *     1,000,000 ->  +1,000%
   *
   * The RATE IS NOT THIS CONSTANT ALONE. It is a sum of four additive sources
   * (`Stats.reservePerRate`), and this base is the smallest -- the `reserve-1`
   * upgrade and two achievements add the rest. The HUD chip and the
   * `reserveBonus` badge both report the SUM, never the base.
   *
   * It carries NO core term: cores multiply the whole fleet instead, so the two
   * figures are independent and no longer compose into one total.
   *
   * Deliberately NOT capped. A cap would just move the endgame wall; the curve
   * IS the cap.
   */
  reservePer: 0.01,

  /**
   * PER-TIER upgrade prices, ONE ENTRY PER TIER, in fleet order.
   *
   * `base` is what a tier's first THREE upgrades cost and `capstone` what its
   * fourth does, so a tier's game-changer always out-prices the NEXT tier's
   * entry. Prices ascend with depth because a deeper tier's units cost more,
   * so a bonus to its output is worth more.
   *
   * TWO TABLES, NOT ONE: a per-tier upgrade is paced by how deep the fleet is
   * and a shop row by how far through the shop the player is, so a shared table
   * would put Worker's first upgrade and the shop's last in one sequence -- and
   * fixing the cheap end of either ladder would reprice the other.
   *
   * The tier half costs 10,000 and the shop half 20,000, summing to
   * `SHARDS.pacing.targetTotal` -- an asserted figure rather than a total this
   * file happens to produce, because "the sink is deep enough" is a design
   * claim. Per-tier sums are ascending and DISTINCT, which is the property a
   * player feels: climbing is never a discount and no two tiers share a price.
   *
   *     175  575  650  800  1050  1500  2250  3000    (worker -> datacenter)
   *
   * `base < capstone` on every row, and every capstone out-pricing the next
   * tier's first upgrade, are both asserted by `check:ladder`.
   *
   * DATACENTER IS THE ONLY TIER CARRYING PRICE OVERRIDES. A tier gets ONE
   * `base` for its first three rows, so `500 / 750 / 750 / 1000` cannot be
   * expressed here alone -- `datacenter-2` and `datacenter-3` each declare
   * `price: 750`. An override must be one of the band costs, so it cannot
   * invent a price the player would not recognise. Prefer moving a boundary:
   * one table is one decision, an override is one per row.
   *
   * 25 IS THE FLOOR. With any row priced 10 the tier subtotal is stuck on a
   * residue that cannot reach a round total, so the ladder offers SEVEN prices
   * -- 25, 50, 100, 250, 500, 750, 1000 -- and the shop opens at 100.
   *
   * **If a rung binds the per-rung pace bound, fix the rung or the pace -- do
   * not move the bound first.** Two capstones were once repriced to satisfy an
   * assertion comparing each rung against `pacing.targetHours x 10%` while the
   * run actually takes far longer, so a rung worth 7.5% of the real run failed
   * for exceeding 10% of the target. The check now measures against the run.
   */
  tierBands: [
    { base: 25, capstone: 100 },
    { base: 25, capstone: 500 },
    { base: 50, capstone: 500 },
    { base: 100, capstone: 500 },
    { base: 100, capstone: 750 },
    { base: 250, capstone: 750 },
    { base: 500, capstone: 750 },
    { base: 500, capstone: 1000 },
  ],

  /**
   * GLOBAL shop prices, by POSITION in the global list (not by rung).
   *
   * The shop reads `100, 250, 500, 750, 1000` across five bands of
   * `5 / 5 / 5 / 5 / 12` rows. Position rather than rung because the rung
   * sequence is shared with the per-tier ladder, and indexing the shop by
   * a number the other ladder also uses is what let a per-tier renumbering
   * silently reprice the shop.
   *
   * FIVE bands, not four, and the extra one exists to keep the price list to the
   * five values above. A four-band table reaching the same 20,000 total needs an
   * 850 entry somewhere, which is a price that appears nowhere else in the game
   * and reads as an invented number rather than a recognisable one. Splitting
   * the middle into 500 and 750 instead costs nothing and keeps every price a
   * figure the player has already seen on a tier row.
   *
   * THE BANDS ARE NOT EQUAL: they cover `5 / 5 / 5 / 5 / 12` rows, and that
   * follows from the total and the price list rather than from taste. With the
   * entry at 100 and the shop totalling 20,000 the row counts satisfy
   * `2n1 + 5n2 + 10n3 + 15n4 + 20n5 = 400`, so `2n1` is a multiple of 5 and `n1`
   * must be a multiple of 5 -- a 2-row entry band is simply unavailable at this
   * total with these prices.
   *
   * The original intent was for the entry band to stop BEFORE `shards-1`, the
   * first step of the income ramp, so a cheap band could not compound through
   * every shard of the run. That invariant does not hold in the shipped table:
   * `shards-1` sits at position 2, inside the first band. Measured, the effect
   * is that day-one shards moved from a median of ~41,000 to ~98,700.
   *
   * Moving `shards-1` out of the first band was tested and is the obvious
   * repair: median shards fell to ~59,600, but the model's pace went to 6.8h,
   * outside the band, because the income ramp then starts a whole band later.
   * **The two levers are opposed** -- a cheap income ramp accelerates the
   * economy and removing it from the cheap band slows the ladder past its pace
   * bound -- so any further work here is a MEASUREMENT, not a rearrangement.
   * The datum to move is the entry band count against the pace target.
   *
   * THE PACE LEVER IS WHEN THE INCOME RAMP STARTS, NOT WHAT THE LADDER TOTALS.
   * Measured revisions: an 8-row entry band at 100 cleared in 2.7h, the same at
   * 250 in 3.6h, a 2/8/8/13 split at 100/250/500/1000 in 3.1h, and the shipped
   * 5/5/5/5/12 at 100/250/500/750/1000 in 3.5h. Halving the entry price while
   * raising the middle band leaves the pace where the dearer entry left it.
   *
   * The 1000 ceiling is about the PLAYER, not the economy: the last thing on
   * the list is a price you have to be able to picture reaching, and every
   * figure above four digits reads as a wall however it is tuned. Two revisions
   * went over it (10,000, then 2,500) and both were defensible in the pace model
   * and wrong on the panel.
   *
   * `through` is inclusive, and the bands must cover every global row.
   */
  globalBands: [
    { through: 4, cost: 100 },
    { through: 9, cost: 250 },
    { through: 14, cost: 500 },
    { through: 19, cost: 750 },
    { through: 31, cost: 1000 },
  ],

  /**
   * What the ladder is supposed to cost, in HOURS.
   *
   * This replaced a `ladderBudget` ceiling, and the replacement is the point.
   * The old budget was a shard total set FROM the checker's own reported
   * figure, so it could not fail: whatever the table cost, the budget had been
   * chosen to match it. It reported a healthy ladder while the ladder was a
   * 32-hour wall -- the failure mode of any bound derived from the thing it is
   * supposed to bound.
   *
   * A target in hours cannot do that, because the conversion from shards to
   * hours needs two numbers that live here (the reference rates) and one that
   * lives in the price table. Change the prices and the hours move; the target
   * does not follow.
   *
   * The reference rate is the MEASURED day average from
   * `npm run check:progression`, which runs the real engine -- and this prose
   * deliberately does NOT restate it. It was restated once and the two drifted,
   * leaving a comment describing a rate the game had not had for two revisions.
   * The constant is the fact; a number repeated in prose is a second copy.
   *
   * The rate is far from flat -- roughly a thousand contracts an hour in the
   * opening minutes, settling to the reference figure across a full day -- which
   * makes this model a CONSISTENCY check ("is the ladder affordable at the rate
   * the game actually pays") rather than a pacing authority. `check:progression`
   * is the authority, and this number is kept in step with it.
   *
   * `targetHours` is a BAND, not a point: a run that clears in 10 hours and one
   * that clears in 12 are the same game.
   */
  pacing: {
    /**
     * Contracts completed per hour, MEASURED over a full day by
     * `check:progression` rather than assumed.
     *
     * The whole point of this number is that it is NOT a free parameter: every
     * time the economy moved, the measured rate moved and this constant moved
     * with it. Left behind, the ladder would report a pace the game no longer
     * has.
     *
     * 143 -> 77 -> 65 IS THE CONTRACT DIFFICULTY FIX LANDING, the largest move
     * this number has taken. Two changes, both closing faucets that paid for
     * work nobody did:
     *
     *   - `clicks` objectives were hand-authored (`25` and `50`) instead of
     *     derived from `cost`, so a `quick` click contract was six seconds of
     *     work paying a ninety-second band. They are now `cost x
     *     referenceClicksPerSecond`, and the realised time is EXACTLY 1.00x the
     *     band at every phase of a run.
     *   - `CONTRACTS.growthCorrection` now enlarges every rate-sized objective,
     *     where before only `totalEarned` carried a correction.
     *
     * `77` is the difficulty fix alone and `65` is after `SHARDS.perCost` was
     * raised to compensate the ladder, which is why both are recorded: the first
     * is the faucet becoming honest, the second is the ladder being re-priced
     * for it. The rate fell because the WORK per contract rose, not because any
     * reward was cut.
     */
    referenceContractsPerHour: 65,
    /**
     * Milestone STEPS crossed an hour at the same reference session, for the
     * pace model's second faucet term.
     *
     * A SECOND reference rate, and it exists for exactly the reason
     * `referenceContractsPerHour` does: `check:ladder` reads `content.ts` as
     * TEXT and cannot import the engine, so it has no way to discover a rate
     * by measurement. Without a number here its pace model would silently
     * describe an economy with one faucet, which is the class of error this
     * file has already been bitten by once.
     *
     * It has the same hazard as the contract rate and gets the same guard:
     * a constant that drifts from the rate the game actually pays produces
     * hours that mean nothing while still passing the band. `check:progression`
     * therefore asserts the MEASURED figure against this one, the same way it
     * asserts the contract rate -- see `MILESTONE_TOLERANCE` there.
     *
     * It was previously removed on the grounds that "it was a rate no faucet
     * read". That was true then and is not true now.
     */
    referenceMilestonesPerHour: 33.8,
    /**
     * Shards one milestone step pays, AVERAGED over a reference day.
     *
     * A THIRD reference rate, and it exists for the same reason as the other
     * two: `check:ladder` reads `content.ts` as TEXT and cannot import the
     * engine, so its pace model has no way to discover what a step pays. It
     * used to multiply the step rate by the flat `perMilestone`, and that
     * stopped being right the moment the faucet gained its tier and step terms.
     *
     * The value is MEASURED by `check:progression` and asserted against, the
     * same as `referenceContractsPerHour`: a constant that drifts from what the
     * game actually pays produces hours that mean nothing while still passing
     * the band, which is the one failure a reference rate is supposed to make
     * impossible.
     *
     * It is a MEAN rather than a median, because the pace model multiplies it
     * by a total step count -- every step contributes one payout, so the mean is
     * the correct summary and a median would describe a step that does not
     * exist.
     *
     * It is far above `perMilestone`, and that gap IS the depth-and-growth
     * change: the tier and step terms multiply the flat 10 by ~1.89x across a
     * day, because deeper tiers and deeper steps both pay more.
     */
    referencePerMilestoneStep: 35.95,
    /**
     * The run length the ladder is sized for, in hours.
     *
     * Sized to when the FLEET finishes, because the two tracks have to end
     * together: a ladder that outlives the fleet leaves the player with
     * nothing left to build and most of the list still unbought, and a ladder
     * that finishes first makes the last stretch of building pointless.
     * `check:progression` measures when the fleet completes, and this number
     * is kept in step with it.
     */
    targetHours: 5,
    /** How far either side of the target the checker tolerates. */
    tolerance: 0.35,
    /**
     * What the whole ladder COSTS, in shards.
     *
     * The sink's DEPTH, stated rather than reported. `check:ladder` asserts
     * that `tierBands` and `globalBands` sum to exactly this, and the reason to
     * write it down is the same reason `pacing` itself replaced `ladderBudget`:
     * a figure the checker merely PRINTS is a figure nothing depends on, so a
     * band edit moves it and the change is invisible in the diff.
     *
     * The hazard is also the same one `targetHours` carries and it is worth
     * naming, because this constant is one step closer to it. A declared total
     * is only meaningful if it is NOT set from the checker's own output -- the
     * old `ladderBudget` was, and so it agreed with any table it was compared
     * against. This one was derived from a decision about how deep the sink
     * should be, and the tables were then moved to meet it; if a future change
     * moves a band, the assertion is supposed to FAIL so the total is
     * reconsidered rather than silently redefined.
     *
     * 27,260 was the shipped figure before this. The delta was spent on the
     * per-tier BASES rather than the deep capstones -- see `tierBands`.
     */
    targetTotal: 30_000,
  },

  /**
   * Units of a tier a per-tier upgrade reveals at, by position on that tier's
   * own list. Four upgrades per tier, so four thresholds, ascending.
   *
   * Round numbers, chosen so they line up with `MILESTONE.step` (25): the
   * reveal cadence and the doubling cadence then agree, and a tier tends to
   * reveal its next upgrade on the same beat that doubles its output. A
   * threshold is most useful when it is a number the player is already
   * counting towards, which a value tuned to reach-time is not.
   *
   * The trade is that the last threshold arrives early, which is the direction
   * to err in -- an upgrade nobody reaches is content nobody sees.
   *
   * NOT read at runtime: each upgrade's own `reveal` closure states its
   * threshold (`owned(state, 'worker') >= 10` and so on), because a closure can
   * express conditions a table cannot. This array is the DECLARATION of the
   * cadence, and `npm run check:ladder` asserts that every per-tier row's
   * reveal agrees with it -- the table and the closures are checked against
   * each other rather than one deriving from the other.
   */
  revealAt: [10, 25, 50, 100],
} as const;


/* --------------------------------------------------------------------------
   Convenience re-exports for the UI
   -------------------------------------------------------------------------- */

export type {
  ServiceDef,
  UpgradeDef,
  AchievementDef,
  AchievementRarity,
  ContractDef,
  Stats,
};
