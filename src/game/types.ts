/* --------------------------------------------------------------------------
   Idle game types. Kept separate from the CV types: nothing here is shared.
   -------------------------------------------------------------------------- */

/** Persisted game state. */
export interface GameState {
  /** Save schema version. Bump when the shape changes, and add a migration. */
  v: number;

  /** Tab the player last had open, so a reload resumes where they were. */
  activeTab: string;

  compute: number;
  /** Earned during the current run. Drives the Reboot payout. */
  runEarned: number;
  /** Earned across all runs, including this one. */
  totalEarned: number;

  clicks: number;

  /** service id -> number owned. */
  services: Record<string, number>;
  /** Purchased upgrade ids. */
  upgrades: string[];
  /** Unlocked achievement ids. Never reset, not even by Reboot. */
  achievements: string[];
  /** Reboot awards: permanent global multiplier. */
  cores: number;
  reboots: number;

  /* --- Abilities: keyed by id so an ability can be added without a save
     migration. Availability is DERIVED from achievements, never stored. --- */
  abilities: Record<string, AbilityState>;

  /* --- Contracts ------------------------------------------------------ */
  /** Offered contracts, at most `CONTRACTS.active` slots plus the upgrade. */
  contracts: ContractState[];
  contractsCompleted: number;
  /**
   * Contracts issued this save, against the offer budget.
   *
   * The counter `CONTRACTS.offerMs` rations. Objectives are FIXED numbers now,
   * so the completion RATE is the faucet -- measured ungated at 305/hr against
   * the 65 the ladder is priced for.
   *
   * Separate from `contractsCompleted` because `ui.ts` EMPTIES `contracts` on a
   * Reboot, so deriving it from the panel would refund a full budget per
   * prestige; `applyReboot` refunds exactly what it clears instead.
   */
  contractsIssued: number;

  /* --- Seeded randomness: every roll derives from `seed`, so a reload cannot
     re-roll anything. See rng.ts. ------------------------------------- */
  /** Root RNG seed, generated once and never changed. */
  seed: number;

  /* --- Shards --------------------------------------------------------- */
  /** Upgrade currency, from contracts and milestone boundaries. Kept separate
   *  from compute: one income shape per sink is what makes the ladder a real
   *  decision late. */
  shards: number;
  /** Lifetime shards earned. Drives the `shards` contract metric. Separate from
   *  `shards`, which falls when an upgrade is bought. */
  shardsEarned: number;

  /** First session's timestamp. Only a fallback seed source; not shown. */
  startedAt: number;
  /** Written on every save. The basis for offline progress. */
  lastSavedAt: number;
  /** Milliseconds of time spent with the tab visible. */
  playtime: number;

  offlineReturns: number;
  totalOfflineEarned: number;
}

export interface ServiceDef {
  id: string;
  name: string;
  /** One-line description shown under the name. */
  blurb: string;
  baseCost: number;
  /** Multiplicative cost growth per unit owned. */
  costGrowth: number;
  /** Compute per second per unit owned, before multipliers. */
  baseOutput: number;
}

export interface UpgradeEffect {
  kind:
    /*
     * THE ADDITIVE PAIR: every multiplicative kind has an additive twin. Both
     * fold into `(1 + SUM additive) x PRODUCT mult`, so additive is worth most
     * EARLY (its factor shrinks as the pool grows) and multiplicative most
     * LATE. That is why both exist.
     *
     * Two conventions: an additive card states a PERCENTAGE (`+150%`), since
     * additive values SUM; and an additive pool's identity is 0, not 1.
     */
    /** Multiplies ONE tier's output. */
    | 'serviceMult'
    /** Adds to ONE tier's additive pool, in percentage points (0.5 = +50%). */
    | 'serviceAdd'
    /** Multiplies the whole fleet. */
    | 'globalMult'
    /** Adds to the FLEET-WIDE additive pool (0.2 = +20%) -- the same pool the
     *  achievements' `globalBonus` writes to, so the two are one axis. */
    | 'globalAdd'
    /** Multiplies manual deploy output. */
    | 'clickMult'
    /** Adds to the click additive pool, in percentage points. */
    | 'clickAdd'
    /**
     * Adds share points to `CLICK.throughputShare` -- the share of production a
     * manual deploy reads. NOT a second `clickAdd`: that multiplies the
     * finished `clickPower` (base included), while this changes the term that
     * SCALES with the fleet, so it pays late rather than early.
     *
     * Uncapped: the two content rows reach 0.5 exactly.
     */
    | 'throughputShare'
    /** Multiplies the shards a contract pays -- the whole faucet. */
    | 'shardGain'
    /** Adds to the shard additive pool, in percentage points. */
    | 'shardAdd'
    /** Multiplies the compute a contract pays. */
    | 'contractReward'
    /** Adds to the contract-reward pool, in percentage points. */
    | 'contractRewardAdd'
    /** Multiplies every tier's unit price. Below 1 is a discount. */
    | 'costMult'
    /**
     * Subtracts from the unit-price pool, in percentage points (0.2 = -20%).
     *
     * The one place ADDITIVE is unambiguously safer: compounded discounts
     * (`0.8^4 = 0.41`) make four "-20%" rows deliver -59% while reading as -80%.
     */
    | 'costAdd'
    /** Extends the cap on credited away time, in hours. */
    | 'offlineCap'
    /** Raises the share of production credited while away. Best value wins. */
    | 'offlineEfficiency'
    /** A multiplier that grows with units owned of ONE tier. Capped: the only
     *  per-unit global shape that can run away. */
    | 'globalPerOwned'
    /** Reduces the units per milestone doubling for one tier. */
    | 'milestoneStep'
    /** UNUSED since `serviceEconomy` replaced it. Fold and label kept. */
    | 'serviceCost'
    /** Multiplies a tier's OWN milestone factor: `2^steps x (1 + bonus)`. A
     *  factor on the RESULT -- `(2 + bonus)` would change an exponent's growth. */
    | 'serviceMilestone'
    /** Multiplies manual deploy output by this tier's presence. */
    | 'serviceClick'
    /** UNUSED since Worker's "Warm pool" became `serviceAutoDeploy`. Nothing
     *  else expresses "this tier runs at full rate while away". */
    | 'serviceOffline'
    /**
     * AUTOMATED deploys per unit of ONE tier, capped.
     *
     * Feeds `Stats.autoDeployRate`, which credits a share of PRODUCTION per
     * deploy (`CLICK.autoDeployShare`) and NOT `clickPower` -- load-bearing,
     * since the click tree multiplies to 120x and automation inheriting it
     * would out-earn the fleet.
     */
    | 'serviceAutoDeploy'
    /*
     * THE SECOND SIGNATURE on each tier: each scales a tier by a DIFFERENT
     * quantity, and that difference is the point -- two rows both reading "x2"
     * are one row to a player whatever the code calls them. All are `cap`-bounded,
     * because a multiplier on an unbounded count inverts the ladder once a cheap
     * tier is owned in the thousands. `check:ladder` asserts all 32 are distinct.
     */
    /** Output rises on a second, finer curve: `mult` per 10 units. */
    | 'serviceCurve'
    /** Output rises with THIS tier's own unit count. */
    | 'servicePerOwned'
    /** Output rises with TOTAL units owned across every tier. */
    | 'serviceThroughput'
    /** Output rises with how many tiers are actually deployed. */
    | 'serviceDepth'
    /** Output rises with this tier's SHARE of the fleet. */
    | 'serviceShare'
    /** This tier's share of the fleet becomes a GLOBAL multiplier. */
    | 'serviceGlobalShare'
    /** Widens EVERY tier's synergy bonus. Also an achievement reward. */
    | 'synergy'
    /** Raises the multiplier earned per milestone step, for every tier. */
    | 'milestone'
    /* Automation: acts automatically while the tab is open. */
    | 'autoDeploy'
    | 'autoBuy'
    /** Concurrent contract slots -- the only upgrade changing a STRUCTURE. */
    | 'contractSlots'
    /**
     * Raises the rate at which a HELD shard produces: `per` is added to
     * `SHARDS.reservePer`, so the bonus is `(reservePer + sum(per)) * sqrt(shards)`.
     * Additive onto the RATE, not multiplicative onto the bonus -- a multiplier
     * on a square root buys back the runaway the root exists to prevent.
     */
    | 'reserveBonus'
    /** Raises the fleet-wide multiplier a core grants, added to
     *  `PRESTIGE.bonusPerCore` and applied to `perSecond` (not the reserve). */
    | 'coreAmplify'
    /** A tier's unit count raises shard income, capped -- the one per-tier kind
     *  paying in the OTHER currency. */
    | 'serviceShardGain'
    /*
     * THE PER-TIER COUNT MECHANISMS. No shared kinds: a common pair would make
     * half the per-tier rows one row wearing eight names.
     *
     * NONE READS A NEIGHBOURING TIER. A row scaling by "the tier above" prices
     * one card from another the player may not own -- and it costs machinery,
     * since a tier reading a neighbour's RESULT cannot be folded in one pass
     * (the deleted `serviceFloor` forced a second loop over every tier).
     */
    /**
     * This tier's units raise MANUAL DEPLOY power, capped.
     *
     * The compute-powered path to clicking: every other click booster is an
     * achievement or a shard-priced multiplier, so a large COMPUTE balance
     * bought nothing for the button. Distinct from `serviceClick` by SHAPE --
     * that is flat, this scales with a count and is capped.
     */
    | 'serviceDeployPerOwned'
    /** Rises with how EVENLY the fleet is spread across the eight tiers. */
    | 'serviceParity'
    /** Rises with how many upgrades have been bought. */
    | 'serviceUpgrades'
    /** Rises with contracts completed. */
    | 'serviceContracts'
    /** Rises with milestone steps banked across the WHOLE fleet. */
    | 'serviceFleetMilestones'
    /** Rises with the shard balance currently held. */
    | 'serviceReserve'
    /** This tier's units get cheaper as you own more. The one kind acting on
     *  the COST curve; `cap` is the FLOOR, so it can never make a tier free. */
    | 'serviceEconomy'
    /** Rises with cores held, so prestige pays a per-tier dividend. */
    | 'serviceCores'
    /** Rises with achievements unlocked. */
    | 'serviceAchievements'
    /** Rises with this tier's POSITION on the ladder. */
    | 'servicePosition'
    /** Rises with all compute ever earned this save. */
    | 'serviceLifetime'
    /** A flat bonus while every one of the eight tiers is deployed. */
    | 'serviceFullStack'
    /** Rises with the HIGHEST tier you have deployed. */
    | 'serviceApex'
    /** Rises with tiers staffed to `MATURE_UNITS` or more -- the ladder's only
     *  BREADTH reward, bounded by construction at the tier count. */
    | 'serviceMatureTiers'
    /** Rises with LIFETIME shards earned (not held -- `serviceReserve` reads the
     *  balance). Spending is what separates the two rows. */
    | 'serviceShardsEarned'
    /** Rises with how many times you have come back from being away. */
    | 'serviceReturns'
    /** Rises with reboots performed -- a COUNT, since `serviceCores` already
     *  reads what the reboots banked. */
    | 'serviceReboots'
    /** Rises with how many UNLOCKED achievements are of one rarity. */
    | 'serviceRarity'
    /** Rises with ability activations. */
    | 'serviceAbilityUses'
    /**
     * Rises with shards SPENT -- earned minus held, the third reading of the
     * shard economy (`serviceReserve` holds, `serviceShardsEarned` totals, this
     * is what was converted into upgrades).
     *
     * Clamped at zero: a save restored through a migration could hold more than
     * it earned, and a negative quantity would SUBTRACT output.
     */
    | 'serviceShardsSpent';
  /** Only for the per-service kinds. */
  serviceId?: string;
  /** Multiplier for the `*Mult` kinds; the per-step factor for 'serviceCurve',
   *  'serviceShare' and 'serviceGlobalShare'. */
  mult?: number;
  /** Additional hours for 'offlineCap'. */
  hours?: number;
  /** Absolute efficiency for 'offlineEfficiency', and the ADDITIVE amount for
   *  'globalAdd'/'serviceAdd' (percentage points: 0.2 = +20%). */
  value?: number;
  /** Extra contract slots for 'contractSlots'. */
  slots?: number;
  /** Actions/s for 'autoDeploy', buys/s for 'autoBuy'. */
  rate?: number;
  /** The per-unit rate for every count-scaling kind, always with `cap`. Also the
   *  ADDITIVE rate for 'reserveBonus'/'coreAmplify' (no cap -- the reserve's
   *  square root already bounds them) and the SHARE POINTS for
   *  'throughputShare' (uncapped: the content reaches 0.5 exactly). */
  per?: number;
  /** Ceiling on a `per`-driven bonus, or on a curve's total multiplier. */
  cap?: number;
  /**
   * Whether `cap` is a LIMIT (asymptote) or a WALL (hard clamp).
   *
   * A hard cap has EXACTLY zero marginal value past `cap / per`, so the next
   * unit of that tier buys nothing from the row ever -- and a row that dies
   * stops being a reason to keep buying its tier. Soft uses
   * `cap x raw / (cap + raw)`: same slope at zero, same limit, never flat. The
   * card's "up to +N%" stays true, at the cost of the maximum being approached
   * rather than touched. **No row uses it today.**
   *
   * NOT for a CONTENT-BOUNDED quantity: if the game itself stops the count
   * (eight tiers, 64 upgrades), a hard cap sized to that maximum IS reached by
   * playing, so softening only cuts the payoff the blurb promises.
   */
  soft?: boolean;
  /** For 'milestoneStep': units to remove. */
  reduce?: number;
  /** For 'serviceMilestone': a FACTOR on the finished milestone multiplier
   *  (`2^steps x (1 + bonus)`), not an addition to the base. */
  bonus?: number;
  /** For 'serviceRarity': which rarity's unlocked count is the quantity. A
   *  payload field rather than a number, because the quantity is a CATEGORY. */
  rarity?: Rarity;
}

export interface UpgradeDef {
  id: string;
  name: string;
  blurb: string;
  /** Reusable line glyph shown on the upgrade card. See icons.ts. */
  icon: IconKey;
  /**
   * Position in the upgrade list, and the input to the price.
   *
   * The price is BANDED, from TWO tables: `SHARDS.tierBands` (keyed on the
   * tier's depth) for a per-tier row, and `SHARDS.globalBands` (keyed on the
   * row's position within the shop ladder) for everything else. So the list
   * shows a handful of recognisable prices rather than one per row. The rung
   * is also the canonical order the list is presented in, and `check:ladder`
   * validates that the rungs are unique and contiguous -- which is what catches
   * a duplicated or accidentally dropped entry.
   */
  rung: number;
  /**
   * The last upgrade of a service tier: its game-changer.
   *
   * Marked rather than inferred from `rung % 4 === 3`, because the price rule
   * below depends on it and a rung reshuffle must not silently move which
   * upgrades are capstones. `check:ladder` asserts there are exactly eight,
   * one per tier, each on the fourth slot.
   *
   * It costs more than the rest of its tier: a capstone takes its tier's
   * `capstone` entry from `SHARDS.tierBands` instead of that row's `base`,
   * which is what makes it out-price the NEXT service's entry upgrade. Without
   * that a tier's four upgrades are consecutive rungs and would all share the
   * base price, so the capstone could never cost more than the first.
   */
  capstone?: true;
  /**
   * An explicit price, bypassing both band tables.
   *
   * The tables are the rule and this is the exception, which is why it is
   * optional and rare: it exists so ONE row can be repriced without
   * renumbering the whole ladder. A band boundary cannot do that -- moving one
   * reprices every row that falls into the band.
   *
   * It must be one of the values the band tables offer, and `check:ladder`
   * asserts that. The tables exist so a price is a number the player
   * RECOGNISES rather than one they have to read; allowing an arbitrary value
   * here would put the one price nobody recognises on the one row that opted
   * out.
   */
  price?: number;
  /** Revealed once this returns true. Never hidden again once shown. */
  reveal: (state: GameState, stats: Stats) => boolean;
  effect: UpgradeEffect;
}

/* --------------------------------------------------------------------------
   Achievement presentation and rewards
   -------------------------------------------------------------------------- */

/**
 * Shared rarity scale for achievement presentation.
 * Contracts no longer carry a rarity: difficulty is sized at issue time.
 */
export type Rarity = 'bronze' | 'silver' | 'gold' | 'mythic';

export type AchievementRarity = Rarity;

/** Which reusable line glyph to draw. See icons.ts. */
export type IconKey =
  | 'deploy'
  | 'repeat'
  | 'layers'
  | 'grid'
  | 'clock'
  | 'globe'
  | 'shield'
  | 'flame'
  | 'bolt'
  | 'chart'
  | 'cube'
  | 'target'
  | 'crown'
  | 'server'
  | 'cog'
  | 'cpu'
  | 'disk'
  | 'hourglass'
  | 'key'
  | 'medal'
  | 'network'
  | 'rocket'
  | 'sparkle'
  | 'star'
  | 'wrench'
  | 'cable'
  | 'fan'
  | 'note'
  | 'gauge'
  | 'shard'
  | 'pulse'
  | 'ledger'
  | 'anchor'
  | 'snowflake'
  | 'lock'
  | 'scales'
  | 'cluster'
  | 'broadcast'
  | 'beaker'
  | 'conduit'
  | 'helix'
  | 'battery'
  | 'vault'
  | 'trend'
  | 'funnel';

/** Progress toward a goal, so locked entries can show how close they are. */
export interface Progress {
  current: number;
  target: number;
}

/** One permanent bonus granted when an achievement unlocks. A discriminated
 *  union so content.ts cannot author a reward the engine would ignore. */
export type AchievementReward =
  /**
   * Adds to the achievement OUTPUT pool, in percentage points (0.25 = +25%).
   *
   * ADDITIVE because a single instance is too small to read: every other kind
   * here pays >= +10%, while the largest `globalMult` was +7%, so forty-four of
   * them had to be multiplied together to be felt and the result traced back to
   * no single achievement. Pooled, one mythic reads as "+200% All output".
   * Contribution size decides the shape. `Modifiers.globalBonus` is therefore a
   * SUM whose identity is 0, not 1.
   */
  | { kind: 'globalBonus'; bonus: number }
  /** Multiplies manual deploy output only. */
  | { kind: 'clickMult'; value: number }
  /** Multiplies one service tier's output. */
  | { kind: 'serviceMult'; serviceId: string; value: number }
  /** Extends the offline cap by whole hours. */
  | { kind: 'offlineCap'; hours: number }
  /** Raises offline efficiency (0..1). The best value wins; never compounds. */
  | { kind: 'offlineEfficiency'; value: number }
  /** Adds to the multiplier of every boost ability. */
  | { kind: 'boostPower'; value: number }
  /** Multiplies boost duration (1.25 = +25%). */
  | { kind: 'boostDuration'; value: number }
  /** Multiplies boost cooldown, so a value below 1 shortens the wait. */
  | { kind: 'boostCooldown'; value: number }
  /** Widens the per-unit synergy bonus a tier gives the tier below it. */
  | { kind: 'synergy'; value: number }
  /** Raises the multiplier earned per milestone step. */
  | { kind: 'milestone'; value: number }
  /** Multiplies the compute paid by a completed contract. */
  | { kind: 'contractReward'; value: number }
  /** Adds to the auto-DEPLOY rate ONLY -- auto-buy spends the player's compute,
   *  so it must never be granted by an effect that reads as harmless. */
  | { kind: 'autoRate'; value: number }
  /** Multiplies cores awarded by a Reboot. */
  | { kind: 'coreGain'; value: number }
  /* The four below let an achievement touch the SHARD economy rather than only
     output -- the one axis the reward set could not reach, since every reward
     before them made numbers bigger and none made the ladder cheaper. */
  /** Multiplies shards paid per completed contract. */
  | { kind: 'shardGain'; value: number }
  /** Adds concurrent contracts on top of `CONTRACTS.active`. */
  | { kind: 'contractSlots'; slots: number }
  /** Adds to `SHARDS.reservePer`, the rate a held shard produces at. */
  | { kind: 'reserveBonus'; per: number }
  /** Adds to `PRESTIGE.bonusPerCore`, the final production multiplier per core. */
  | { kind: 'coreAmplify'; per: number }
  /** Grants an active ability from ABILITIES. */
  | { kind: 'unlockAbility'; abilityId: string };

/** Themed section a card is filed under in the achievements panel. */
export type AchievementGroup =
  | 'deploys'
  | 'fleet'
  | 'output'
  | 'idle'
  | 'prestige';

export interface AchievementDef {
  id: string;
  name: string;
  blurb: string;
  rarity: AchievementRarity;
  group: AchievementGroup;
  /**
   * Family this achievement belongs to, e.g. 'deploys', 'services', 'ability'.
   *
   * Required and ordered by: a chain must occupy ONE contiguous run,
   * hardest-first, and the panel renders source order. Deriving the family from
   * the id prefix misses two prefixes measuring the SAME thing (`overclock-*`
   * and `ability-*` are both ability uses) and drifted out of order.
   */
  chain: string;
  icon: IconKey;
  test: (state: GameState, stats: Stats) => boolean;
  /** Shown on locked entries so the goal is discoverable, not a mystery. */
  progress: (state: GameState, stats: Stats) => Progress;
  /** Every bonus this unlock grants. All of them apply. */
  rewards: AchievementReward[];
}

/* --------------------------------------------------------------------------
   Active abilities
   -------------------------------------------------------------------------- */

export type AbilityKind =
  /** Multiplies production for a fixed window. */
  | 'boost'
  /**
   * Instantly grants free units, at NO compute cost.
   *
   * The line an ability must clear: it has to do something the interface
   * CANNOT. An ability that spends compute on the cheapest affordable service
   * is the Buy button on a cooldown, so it is not a verb.
   */
  | 'freeUnits';

export interface AbilityDef {
  id: string;
  name: string;
  blurb: string;
  icon: IconKey;
  kind: AbilityKind;
  /** Always available. Otherwise granted by an `unlockAbility` reward. */
  base?: boolean;
  /** Output multiplier for 'boost'. Unused by 'freeUnits'. */
  multiplier: number;
  durationMs: number;
  cooldownMs: number;
  /**
   * The 'freeUnits' grant. A FLAT budget, never a share of the fleet.
   *
   * Spread across every tier the player runs, proportional to each tier's size
   * with a floor of one unit, so it cannot cross a proportional number of
   * milestone doublings -- which is what a fleet-proportional grant does
   * (measured at +7.8e9% production for a 10%-of-fleet grant at 6,505 units).
   */
  amount: number;
  /** Short line shown on the ability card, e.g. "3x for 30s". */
  summary: string;
}

/** Stored cooldown bookkeeping for one ability. */
export interface AbilityState {
  /** Timestamp the active effect ends. 0 when idle. */
  until: number;
  /** Timestamp the ability is usable again. 0 means ready now. */
  readyAt: number;
  uses: number;
}

/** Live, derived status of one ability. Never stored. */
export interface AbilityStatus {
  id: string;
  /** False while the unlocking achievement is still locked. */
  available: boolean;
  active: boolean;
  activeMs: number;
  ready: boolean;
  cooldownMs: number;
  /** Effective multiplier for 'boost', after achievement bonuses. */
  multiplier: number;
  /** Effective duration, after achievement bonuses. */
  durationMs: number;
  /** Effective cooldown after bonuses, so the UI can draw a full ring. */
  cooldownTotalMs: number;
}

/* --------------------------------------------------------------------------
   Contracts. Repeatable objectives, each measured from a baseline captured at
   issue so the same contract can recur and still be a fresh challenge.
   -------------------------------------------------------------------------- */

/**
 * State counters a contract can be measured against.
 *
 * Every one advances ON ITS OWN while the player plays, which is a requirement
 * rather than a coincidence: a contract captures a baseline at issue and counts
 * from there, which only means anything for a moving counter. `cores` and
 * `reboots` were removed for failing it -- they move only during a Reboot, so a
 * contract on one was a prestige-timescale objective holding a routine slot.
 */
export type MetricKey =
  | 'clicks'
  | 'services'
  | 'totalEarned'
  /** Milestone doublings crossed, summed over every tier. DERIVED rather than
   *  stored: a pure function of the unit counts. */
  | 'milestones'
  /** Upgrades bought, so the ladder is also a source of contract work. */
  | 'upgrades'
  /** Units of ONE named tier, so a contract can point at a specific row.
   *
   *  `services` already measures the whole fleet, and a fleet total is a poor
   *  objective for DIRECTING play -- "bring 40 more services online" is
   *  satisfied by the cheapest row forty times over. Needs `serviceId`. */
  | 'tierUnits'
  /** Whether ONE named tier is owned at all, as a 0/1 objective: a one-shot
   *  "open the next tier". Owning a tier cannot un-happen, so this has finite
   *  HEADROOM -- `metricHeadroom` must refuse it against a tier already run. */
  | 'tierOwned'
  /** Uses of ONE named active ability, so the skills panel is contract work.
   *
   *  REAL TIME, not production: an ability has a cooldown, so "use Surge twice"
   *  costs five minutes whatever the fleet is doing -- which is why it carries a
   *  fixed `amount`. An ability the player has not UNLOCKED has zero headroom,
   *  and that guard is load-bearing: Surge does not exist until `contracts-25`,
   *  so a Surge contract issued before it would hold a slot forever. */
  | 'abilityUses';

export interface ContractDef {
  id: string;
  name: string;
  blurb: string;
  icon: IconKey;
  metric: MetricKey;
  /**
   * The contract's BAND. It does THREE jobs, all resolved from this one number
   * so they cannot drift: the SHARD payout band (`shardPayout()`), the COMPUTE
   * payout (`contractReward()`), and the SIZE of the ask (the def's `amount`
   * plus when it becomes eligible).
   *
   * **Every def declares it**: without one the contract pays zero in BOTH
   * currencies, invisibly to the card and to a type check, so `check:ladder`
   * asserts it. For `totalEarned` it also SIZES the objective.
   */
  cost: number;
  /**
   * The objective size, for every metric EXCEPT `totalEarned`.
   *
   * The normal case: a fixed ask is what makes a card legible and repeatable --
   * "bring 1 more service online" reads the same to a player with three units
   * and one with three thousand. `cost` sets the size and the eligibility.
   *
   * `totalEarned` deliberately has none: compute scales without limit, so its
   * ask stays sized from the live rate. Both directions are asserted against
   * `METRIC_RULES`, since a missing `amount` silently sizes to 1 and a present
   * one on `totalEarned` is silently ignored.
   */
  amount?: number;
  /** The tier a per-tier metric is measured against. Required by `tierUnits`
   *  and `tierOwned`, and by nothing else. */
  serviceId?: string;
  /** The ability an `abilityUses` metric is measured against. Required by that
   *  metric and nothing else. */
  abilityId?: string;
  /**
   * Which currency this contract pays. Defaults to `'both'`.
   *
   * The objective says what the job is ABOUT, so the payout follows: earning
   * compute pays compute, recovering value pays shards, and anything neither
   * (clicking, opening a tier, buying upgrades, using a skill) pays both.
   * `upgrades` is the case that argued for `both` -- its objective SPENDS the
   * currency the ladder costs, so a shards-only payout was a rebate smaller
   * than the purchase.
   *
   * One learnable sentence rather than 34 authored payouts, which would be 34
   * chances to make the panel arbitrary. A single-currency contract pays
   * `soloBonus` of it, since concentrating must be worth something.
   */
  reward?: ContractRewardKind;
}

export type ContractRewardKind = 'compute' | 'shards' | 'both';

export interface ContractState {
  id: string;
  /** Value of the metric when the contract was issued. */
  baseline: number;
  /** The objective size, computed at issue and then fixed. STORED rather than
   *  re-derived: re-deriving would let a reload change the goal, and change it
   *  in whichever direction the fleet had moved since. */
  amount: number;
}

/** Derived values, recomputed from state. Never stored. */
export interface Stats {
  /** Total compute per second across all services, after every multiplier. */
  perSecond: number;
  /** Per-service output per second, for the share readout. */
  perService: Record<string, number>;
  /** Per-service multiplier from upgrades, milestones and synergies. */
  serviceMult: Record<string, number>;
  /** Per-service multiplier from the 25/50/100-unit milestones alone. */
  milestoneMult: Record<string, number>;
  /** Per-service multiplier from neighbouring tiers alone. */
  synergyMult: Record<string, number>;
  totalServices: number;
  /** Compute granted by ONE manual deploy. */
  clickPower: number;
  /**
   * Compute granted by ONE automated deploy.
   *
   * Deliberately NOT `clickPower`: crediting the click amount would make
   * automation inherit the click tree's multipliers, turning it into a multiple
   * of the whole fleet's production and coupling the two rates. A share of
   * production bounds automation on its own terms.
   */
  autoDeployValue: number;
  /** Includes cores, global upgrades, achievements and any running boost. */
  globalMult: number;
  /**
   * The ADDITIVE pool as a factor (`1 + globalBonus + additive upgrades`).
   *
   * One of the six terms `globalMult` is the product of, exposed so the HUD can
   * show the breakdown as REAL terms -- a residual would report every error in
   * the other five as an error in this one.
   */
  additiveMult: number;
  /**
   * The fleet-concentration factor (`1 + globalShareBonus`), the sixth term of
   * `globalMult`. Exposed for the same reason as `additiveMult`.
   */
  concentrationMult: number;
  /** Just the achievement contribution, so the UI can show where it comes from. */
  achievementMult: number;
  /**
   * The shard-reserve bonus as a fraction of output (0.32 is +32%).
   *
   * The SHARDS' own contribution alone -- no core term, since cores are their
   * own final multiplier (`coreMult`). Kept beside the multiplier form because
   * the UI states it as a percentage.
   */
  reserveBonus: number;
  /**
   * The same bonus as a multiplier (1 + `reserveBonus`), which is what the
   * production chain consumes.
   */
  reserveMult: number;
  /**
   * The RATE one held shard adds to `reserveBonus` (`SHARDS.reservePer` plus
   * every `reserveBonus` upgrade and achievement).
   *
   * The sum, not the base: the bonuses are larger than `reservePer`, so a chip
   * showing the base would understate what a shard pays by several times. The
   * HUD reports THIS, so the figure printed is the figure applied.
   */
  reservePerRate: number;
  /**
   * The FINAL production multiplier cores provide (1 + `coreAmplifyPer` *
   * cores), applied to the whole fleet after every other multiplier.
   *
   * Not folded into `globalMult`: the HUD reports each source as its own
   * factor, so including cores there would double-count against the cores chip.
   */
  coreMult: number;
  /**
   * The RATE one core adds to `coreMult` (`PRESTIGE.bonusPerCore` plus any
   * `coreAmplify` upgrade).
   *
   * Separate from `coreMult` because that is rate x CURRENT cores and so cannot
   * be inverted at zero -- and the Reboot panel needs the rate to project what a
   * newly banked core would be worth.
   */
  coreAmplifyPer: number;
  /** Purchased global upgrades alone. */
  upgradeMult: number;
  offlineCapMs: number;
  offlineEfficiency: number;
  /** Combined multiplier of every active boost ability (1 when none run). */
  boostMult: number;
  boostActive: boolean;
  /** Live status of every ability in ABILITIES, keyed by id. */
  abilities: Record<string, AbilityStatus>;
  /** Auto-deploy clicks per second, including achievement automation. */
  autoDeployRate: number;
  /** Auto-buy purchases per second from explicit auto-buy upgrades. */
  autoBuyRate: number;
  /** Multiplier on the compute a completed contract pays. */
  contractRewardMult: number;
  /** Extra fraction added to the per-unit synergy bonus. */
  synergyBonus: number;
  /** Factor applied to the milestone multiplier (`2^steps` becomes `2^steps x (1 + bonus)`). */
  milestoneBonus: number;
  /** Multiplier on cores awarded by a Reboot. */
  coreGainMult: number;
  /** Concurrent contracts, including `contractSlots` upgrades. */
  contractSlots: number;
  /**
   * Multiplier on the shards a contract pays: the MULTIPLICATIVE chain only
   * (`shardGain`, `serviceShardGain`); the additive pool multiplies it after.
   *
   * Income is otherwise FLAT per contract -- no term grows with progress, which
   * is what keeps the number on a card honest.
   */
  shardMult: number;

  /* --- Per-service upgrade channels ------------------------------------- */
  /**
   * Extra global multiplier earned from units owned, from `globalPerOwned`.
   * Already folded into `globalMult`; exposed so the UI can show the source.
   */
  perOwnedMult: number;
  /** Per-tier cost multiplier from `serviceCost` upgrades. 1 when none. */
  costPerService: Record<string, number>;
  /** Per-tier milestone step from `milestoneStep` upgrades, in units. */
  milestoneStep: Record<string, number>;
  /**
   * EFFECTIVE milestone bonus per tier: the global bonus folded with any
   * per-tier `serviceMilestone` bonus. A FACTOR on the result, so a tier's
   * multiplier is `2^steps * (1 + this)`. Exposed so the UI can state what the
   * NEXT milestone is worth without re-deriving the fold.
   */
  milestoneBonusPerService: Record<string, number>;
  /** Offline rate per tier. Normally the global `offlineEfficiency` for every
   *  tier; only the unused `serviceOffline` kind would raise one to 1. */
  offlineEfficiencyPerService: Record<string, number>;

  /* --- Run anomalies --------------------------------------------------- */
  /** Multiplier on the cost of every service. Above 1 makes things dearer. */
  costMult: number;
}

export type LoadStatus = 'fresh' | 'loaded' | 'corrupt' | 'unavailable';

export interface LoadResult {
  state: GameState;
  status: LoadStatus;
}

export type BuyQuantity = 1 | 10 | 'max';


