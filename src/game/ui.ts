/* ==========================================================================
   Game interface.

   Owns all DOM access. Rules live in engine.ts; this file only translates
   between the state object and the document.

   - One requestAnimationFrame loop drives everything. Simulation is stepped
     at a fixed 10Hz from an accumulator and rendering is capped at 10Hz, so
     neither a slow nor a fast frame rate changes either.
   - Rows are built once and updated in place. Nothing is rebuilt per tick,
     and text is only written when it actually changed.
   ========================================================================== */

import {
  ABILITIES,
  ACHIEVEMENTS,
  ACHIEVEMENT_COUNTS,
  ACHIEVEMENT_GROUPS,
  ACHIEVEMENT_RARITIES,
  CONTRACTS,
  MILESTONE,
  PRESTIGE,
  RARITY_LABELS,
  SERVICE_BY_ID,
  SERVICES,
  UPGRADES,
} from './content';
import {
  activateAbility,
  advance,
  applyOffline,
  applyReboot,
  buyService,
  buyUpgrade,
  canAffordUpgrade,
  checkAchievements,
  collectContracts,
  computeStats,
  contractReward,
  contractViews,
  fillContracts,
  manualDeploy,
  msUntilNextContract,
  prestigeCores,
  prestigeWindow,
  quoteBuyWith,
  runAutomation,
  scaledCost,
  shardPayout,
  milestoneMultiplier,
  milestoneStepPayout,
  milestoneWindow,
  upgradeCost,
  visibleUpgrades,
} from './engine';
import type { AutomationCarry } from './engine';
import {
  contractObjective,
  describeEffect,
  describeReward,
  formatDuration,
  formatMultiplier,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRate,
  rewardConcept,
} from './format';
import type { UpgradeGroup } from './format';
import { createAchievementIcon, createServiceIcon, RARITY_STROKE } from './icons';
import { CONCEPTS } from './concepts';
import type { ConceptId } from './concepts';
import {
  DEFAULT_TAB,
  SAVE_INTERVAL_MS,
  TAB_IDS,
  TAB_ID,
  claimTab,
  clearSave,
  currentTabOwner,
  initialState,
  isStorageAvailable,
  loadIfNewer,
  loadState,
  saveState,
} from './state';
import type { TabId } from './state';
import type {
  AbilityDef,
  AbilityStatus,
  AchievementDef,
  BuyQuantity,
  GameState,
  ServiceDef,
  Stats,
  UpgradeDef,
} from './types';

const TICK_HZ = 10;
const TICK_MS = 1000 / TICK_HZ;
/** Render at most this often, in ms. Simulation is unaffected. */
const RENDER_MS = 100;
/** How often the screen-reader summary refreshes, in ms. */
const SUMMARY_MS = 10_000;
/** Clamp for a single frame delta, so a sleeping tab cannot spike the sim. */
const MAX_FRAME_MS = 250;
/**
 * Below this away-time earnings are still credited, but no "while you were
 * away" banner is shown: an ordinary refresh would otherwise report "away
 * for 0s".
 */
const OFFLINE_BANNER_MIN_MS = 60_000;
/** Must be at least as long as the `achievement-unlock` animation, or the
 * class is removed before the animation finishes. */
const FLASH_MS = 1600;
/** Matches the `shard-gain` animation, so the class outlives it. */
const SHARD_GAIN_MS = 1400;
/**
 * Matches the `deploy-float` animation, so the node is removed with the
 * animation rather than before or long after it.
 */
const DEPLOY_FLOAT_MS = 900;
/**
 * How far from the button's edge a floating number may be centred.
 *
 * The number is centred on the point clicked, so at the extreme right of a
 * 320px button half of it would hang past the border -- horizontal overflow
 * from a decorative element, which is the worst kind. Clamping the centre
 * keeps every float inside the button instead.
 */
const DEPLOY_FLOAT_MARGIN = 28;
/**
 * Concurrent floating numbers. A player clicking rapidly would otherwise add a
 * node per click for the life of the animation; the oldest is retired early so
 * the newest -- the one under the cursor -- is always the one that survives.
 */
const MAX_DEPLOY_FLOATS = 6;

/* --------------------------------------------------------------------------
   DOM helpers
   -------------------------------------------------------------------------- */

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Game markup is missing #${id}`);
  return node as T;
}

/** Write only on change: avoids needless layout invalidation every tick. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * One row of a breakdown: a term, and the factor it contributes.
 *
 * `concept` is optional and, when present, tints the VALUE with that concept's
 * hue through the class rather than an inline custom property -- the same rule
 * the stat chips follow, for the same reason (an inline property referencing
 * another one does not reliably recompute under a media query, so the print
 * stylesheet cannot collapse it).
 */
interface BreakdownRow {
  label: string;
  value: string;
  concept?: ConceptId;
  /**
   * An INDENTED detail row, expanding the row above it.
   *
   * Used for the multiplier's six terms sitting under the `x Multiplier` row.
   * They are indented rather than promoted to top-level rows because they do
   * not multiply the TIER total the way `x Multiplier` does -- they multiply
   * INTO it, so at the top level they would read as five more factors in the
   * same chain and overstate what is being multiplied together.
   */
  sub?: boolean;
  /** Marks the closing `= total` row, which is ruled off from the terms. */
  total?: boolean;
}

interface Breakdown {
  title: string;
  rows: BreakdownRow[];
}

/**
 * A named quantity, with its concept glyph and hue. The DOM-side twin of
 * `Concept.astro`, reading the same `CONCEPTS` registry so a figure built here
 * and one written in markup cannot be drawn differently.
 */
function createConcept(id: ConceptId, text = ''): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `concept concept--${id}`;

  const glyph = createAchievementIcon(CONCEPTS[id].icon, 1.5);
  glyph.classList.add('concept__icon');

  const label_ = document.createElement('span');
  label_.className = 'concept__text';
  label_.textContent = text;

  wrap.append(glyph, label_);
  return wrap;
}

function conceptText(node: HTMLElement): HTMLElement {
  return node.querySelector<HTMLElement>('.concept__text') as HTMLElement;
}

/**
 * The production multiplier the shards provide.
 *
 * `stats.reserveBonus` IS that figure now -- cores no longer nest inside it, so
 * there is no amplifier to divide back out. The division this used to perform
 * was itself the tell that the two were tangled together.
 */
function shardBase(stats: Stats): number {
  return stats.reserveBonus;
}

function shardFactor(stats: Stats): number {
  return 1 + shardBase(stats);
}

/**
 * The production multiplier the cores provide.
 *
 * Simply `stats.coreMult`, the same figure the production chain applies. It
 * used to be a RATIO of two totals (`reserveMult / shardFactor`), because the
 * core amplifier nested inside the reserve bonus and the chip had to back the
 * shard half out to avoid double-counting it. Cores are their own final
 * multiplier now and the shards chip reports only the shards, so the two chips
 * are INDEPENDENT figures rather than two halves of one number.
 */
function coresFactor(stats: Stats): number {
  return stats.coreMult;
}

/**
 * The production multiplier the cores add.
 *
 * No cores: state the per-core rate, so the mechanic is taught before it is
 * felt.
 *
 * The "needs shards" case is GONE, and its removal is the point of the change:
 * a core used to multiply the reserve bonus, so holding no shards made it worth
 * nothing and the chip had to say so. As a final multiplier it applies to the
 * whole fleet whatever is in the bank.
 */
function heldCoresNote(state: GameState, stats: Stats): string {
  /*
   * `stats.coreAmplifyPer`, NOT `PRESTIGE.bonusPerCore`.
   *
   * The base is only the first of four sources -- the `coreAmp-1` upgrade and
   * two achievements add to it -- so printing the base understated what a core
   * pays by more than 2x at full build. The chip reads the same figure the
   * engine applies, which is the only version of this number that cannot drift.
   */
  if (state.cores <= 0) return `+${formatPercent(stats.coreAmplifyPer)} per core`;
  return `${formatMultiplier(coresFactor(stats))} production`;
}

/**
 * The production multiplier the held shards provide, as a multiplier rather
 * than a percentage: the reserve is one factor in `globalMult`, alongside the
 * achievement bonus and the purchased upgrades.
 *
 * INDEPENDENT of the cores chip now -- the two no longer multiply to anything,
 * because cores left the reserve. Zero shards falls back to the per-shard rate,
 * which keeps the percentage form.
 */
function heldShardsNote(state: GameState, stats: Stats): string {
  /* `stats.reservePerRate`, not `SHARDS.reservePer` -- same reason as
     `heldCoresNote`: the base is under half the effective rate. */
  if (state.shards <= 0) return `+${formatPercent(stats.reservePerRate)} per shard`;
  return `${formatMultiplier(shardFactor(stats))} production`;
}

/* --------------------------------------------------------------------------
   Breakdowns: what a total is MADE OF

   A total like `Multiplier 5.94x` is the product of six terms, and there is
   nowhere on screen to read them, so the number is a fact with no explanation.
   Each entry here returns the terms for one chip.

   Every row is a REAL term of the engine's own fold, not a restatement of the
   total. That is why `Stats` exposes `additiveMult` and `concentrationMult`:
   the alternative was to derive them as a residual
   (`globalMult / the other five`), which reports any error in the other five
   as an error in whichever term the player is checking. Deriving the total
   from the rows rather than the rows from the total keeps the panel a genuine
   account of the arithmetic.

   Kept as pure functions of `(state, stats)` so they hold no DOM and could be
   asserted on directly.
   -------------------------------------------------------------------------- */

/**
 * The six terms `globalMult` multiplies together, in fold order.
 *
 * The ADDITIVE AXIS appears as TWO rows rather than one `Additive pool`, which
 * is what lets the first be called `Achievements` and show the same figure the
 * HUD chip does. The axis is one sum with two sources (the achievement
 * `globalBonus` rewards and the single additive shop upgrade), so leaving them
 * merged is natural -- but it forces the row to be named for the MECHANISM and
 * makes it disagree with the Achievements chip the moment the upgrade is bought.
 *
 * Splitting keeps the arithmetic exact -- `achievementMult x (additiveMult /
 * achievementMult)` is `additiveMult` by construction -- while giving the first
 * row the chip's number and name.
 *
 * The cost is that the second row states a RATIO, not a bonus: because additive
 * sources SUM into one factor, the second one's marginal effect depends on how
 * big the first already is. `Additive upgrades 1.38x` means "the shop
 * multiplies the pool above by 1.38", not "+38%" -- the chip on the upgrade
 * itself still says `+150%`, its size against the base.
 */
function multiplierRows(stats: Stats): BreakdownRow[] {
  const rows: BreakdownRow[] = [
    {
      label: 'Shards held',
      value: formatMultiplier(stats.reserveMult),
      concept: 'reserve',
    },
    {
      /*
       * The ACHIEVEMENTS factor, not the whole additive pool: this is the same
       * number the HUD chip reports, in the factor form the rows here need.
       *
       * It is the factor alone with NO percentage beside it, even though the
       * chip states one. Two forms of one number on one line is a clarification
       * the player asked to be spared -- `4.00x` beside `+300%` invites working
       * out which is the real figure, when the chip one row up already gives the
       * other form to anyone who wants it.
       */
      label: 'Achievements',
      value: formatMultiplier(stats.achievementMult),
      concept: 'achievements',
    },
  ];

  /*
   * The OTHER additive source, shown as the factor it contributes on top of the
   * row above. Omitted entirely at zero rather than printed as `1.00x`, so an
   * un-bought upgrade is not a permanent line of noise.
   */
  const shopFactor = stats.additiveMult / stats.achievementMult;
  if (shopFactor > 1) {
    rows.push({
      label: 'Additive upgrades',
      value: formatMultiplier(shopFactor),
      concept: 'multiplier',
    });
  }

  rows.push(
    {
      label: 'Upgrades',
      value: formatMultiplier(stats.upgradeMult),
      concept: 'multiplier',
    },
    /*
     * The two fleet-driven terms share the fleet hue, which is what they have
     * in common -- one counts what you own, the other how evenly it is spread.
     */
    {
      label: 'Per unit owned',
      value: formatMultiplier(stats.perOwnedMult),
      concept: 'fleet',
    },
    {
      label: 'Concentration',
      value: formatMultiplier(stats.concentrationMult),
      concept: 'fleet',
    },
  );
  /*
   * The boost row appears only while a boost is RUNNING, rather than sitting
   * at `1.00x` the rest of the time. A permanent row that is almost always
   * inert is noise in a panel this short, and leaving it out entirely would
   * hide the one term that moves on its own.
   */
  if (stats.boostMult !== 1) {
    rows.push({
      label: 'Boost',
      value: formatMultiplier(stats.boostMult),
      concept: 'production',
    });
  }
  return rows;
}

/**
 * The full production chain: the number the game is ABOUT, and every term
 * behind it.
 *
 * `perSecond` is the summed tier output times `globalMult` times `coreMult`,
 * and the tier subtotal is recovered by dividing those two back out. That
 * division is safe in a way a term-by-residual would not be: both divisors are
 * single exposed figures the engine itself applies to the sum, so the subtotal
 * is what the fleet produces BEFORE any global scaling -- a real quantity, not
 * a residual of five unknowns.
 *
 * The multiplier's own terms are listed UNDER it as indented rows, and there is
 * no second hover target. The compute figure is the FINAL RESULT, so it is the
 * one place a player looks to ask "where does this come from"; nesting the
 * detail here is what makes that one answer rather than three panels to
 * reconcile -- and the multiplier and achievement chips are each already
 * explained by the panel they belong to.
 */
function productionRows(stats: Stats): BreakdownRow[] {
  const tiers = stats.perSecond / (stats.globalMult * stats.coreMult);
  return [
    { label: 'Tiers', value: `${formatRate(tiers)}/s`, concept: 'fleet' },
    {
      label: '\u00d7 Multiplier',
      value: formatMultiplier(stats.globalMult),
      concept: 'multiplier',
    },
    /* The six factors `globalMult` is the product of, indented under it. */
    ...multiplierRows(stats).map((row) => ({ ...row, sub: true })),
    {
      label: '\u00d7 Cores',
      value: formatMultiplier(stats.coreMult),
      concept: 'cores',
    },
  ];
}

const BREAKDOWNS: Record<
  string,
  {
    title: string;
    rows: (state: GameState, stats: Stats) => BreakdownRow[];
    total: (state: GameState, stats: Stats) => BreakdownRow;
  }
> = {
  production: {
    title: 'Production',
    rows: (_state, stats) => productionRows(stats),
    total: (_state, stats) => ({
      label: '= Per second',
      value: `${formatRate(stats.perSecond)}/s`,
      concept: 'compute',
      total: true,
    }),
  },
};

function label(text: string): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = 'label';
  el.textContent = text;
  return el;
}

function paragraph(className: string, text: string): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = className;
  el.textContent = text;
  return el;
}

/* --------------------------------------------------------------------------
   Row bookkeeping
   -------------------------------------------------------------------------- */

interface ServiceRow {
  def: ServiceDef;
  /** The row element, so its active state can be toggled. */
  root: HTMLElement;
  icon: SVGSVGElement;
  medal: HTMLElement;
  owned: HTMLElement;
  ownedBadge: HTMLElement;
  /** The headline output element, in the tier's own hue. */
  output: HTMLElement;
  share: HTMLElement;
  milestone: HTMLElement;
  /**
   * Plain-language milestone line: steps banked, the next threshold, and what
   * a crossing pays.
   *
   * The line is three parts rather than one string, because the reward is a
   * FIGURE attributed to the shard concept and so has to carry that concept's
   * glyph and hue -- which is the rule every other currency figure in the game
   * follows. `setText` on the whole paragraph could not express that.
   */
  milestoneNote: HTMLElement;
  /** The steps/threshold half of the note, rewritten each render. */
  milestoneSteps: HTMLElement;
  /** The reward half, inside a shard concept: `+30 per step`. */
  milestoneShard: HTMLElement,
  /** Five pips, each a fifth of the way to the next milestone. */
  pips: HTMLElement[];
  /** The compute cost chip; `costText` is the label inside its glyph. */
  cost: HTMLElement;
  costText: HTMLElement;
  button: HTMLButtonElement;
  /** Wrapper for this tier's own upgrades, hidden when none are revealed. */
  upgradesWrap: HTMLElement;
  upgradesList: HTMLElement;
}

interface AbilityRow {
  def: AbilityDef;
  root: HTMLElement;
  icon: HTMLElement;
  stateEl: HTMLElement;
  timer: HTMLElement;
  bar: HTMLElement;
  button: HTMLButtonElement;
}

interface AchievementRow {
  id: string;
  root: HTMLElement;
  stateEl: HTMLElement;
  progressText: HTMLElement;
  progressBar: HTMLElement;
}

/* --------------------------------------------------------------------------
   Entry point
   -------------------------------------------------------------------------- */

export function initGame(): void {
  const container = document.querySelector<HTMLElement>('.game');
  if (container === null) return;

  try {
    start(container);
  } catch (error) {
    /* A failure here must not leave a blank page behind the navigation. */
    console.error('[game] failed to start', error);
    const status = document.getElementById('game-status');
    if (status !== null) {
      status.hidden = false;
      status.textContent =
        'The game could not start in this browser. Everything else on the site still works.';
    }
  }
}

function start(container: HTMLElement): void {
  /* ------------------------------------------------------------------
     Element cache
     ------------------------------------------------------------------ */

  const statusEl = must('game-status');
  const liveEl = must('live-summary');
  const toastsEl = must('toasts');
  const deployFloats = must('deploy-floats');
  const offlineBanner = must('offline-banner');
  const offlineText = must('offline-text');
  const offlineDismiss = must<HTMLButtonElement>('offline-dismiss');

  const computeEl = must('stat-compute');
  const perSecondEl = must('stat-per-second');
  const perClickEl = must('stat-per-click');
  const coresEl = must('stat-cores');
  const coresNoteEl = must('stat-cores-note');
  const multEl = must('stat-multiplier');
  /** The achievement pool's share of the global multiplier, shown beside the total. */
  const achievementMultEl = must('stat-achievement-mult');
  /** Automated deploys per second, from upgrades and achievements. */
  const autoDeployEl = must('stat-auto-deploy');
  const shardsEl = must('stat-shards');
  const shardsGainEl = must('stat-shards-gain');
  const shardsNoteEl = must('stat-shards-note');

  const breakdownEl = must('stat-breakdown');
  const breakdownTitle = must('stat-breakdown-title');
  const breakdownRows = must('stat-breakdown-rows');

  const deployBtn = must<HTMLButtonElement>('deploy');
  const deployValue = must('deploy-value');
  const abilitiesList = must('abilities');

  const servicesList = must('services');
  const servicesTotal = must('services-total');
  const upgradesList = must('upgrades');
  const upgradesCount = must('upgrades-count');
  const upgradesShards = must('upgrades-shards');
  const upgradesEmpty = must('upgrades-empty');

  const contractsList = must('contracts');
  const contractsCount = must('contracts-count');

  const rebootPanel = must('reboot-panel');
  const rebootCurrent = must('reboot-current');
  const rebootCurrentNote = must('reboot-current-note');
  const rebootGain = must('reboot-gain');
  const rebootGainNote = must('reboot-gain-note');
  const rebootNext = must('reboot-next');
  const rebootCount = must('reboot-count');
  const rebootReady = must('reboot-ready');
  const rebootButton = must<HTMLButtonElement>('reboot-button');
  const rebootBar = must('reboot-bar');
  const rebootProgress = must('reboot-progress');

  const achievementsList = must('achievements');
  const achievementsCount = must('achievements-count');
  const achievementsTiers = must('achievements-tiers');

  /* ------------------------------------------------------------------
     Tabs

     Every panel stays in the DOM; switching a tab only flips `hidden` on
     the panels and `aria-selected` on the buttons. Nothing is rebuilt and
     nothing is destroyed, so the row references above stay valid.
     ------------------------------------------------------------------ */

  interface TabEntry {
    id: TabId;
    button: HTMLButtonElement;
    panel: HTMLElement;
    badge: HTMLElement;
    /** The visible label, reused for the accessible name. */
    label: string;
  }

  const tabEntries: TabEntry[] = TAB_IDS.map((id) => {
    const button = must<HTMLButtonElement>(`tab-${id}`);
    return {
      id,
      button,
      panel: must(`panel-${id}`),
      badge: must(`tab-badge-${id}`),
      label: button.querySelector('.game-tab__label')?.textContent?.trim() ?? id,
    };
  });

  /* Applied once the save has been read, below. */
  let activeTab: TabId = DEFAULT_TAB;

  const saveNote = must('save-note');
  const saveNowBtn = must<HTMLButtonElement>('save-now');
  const resetBtn = must<HTMLButtonElement>('reset');

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */

  const storageAvailable = isStorageAvailable();
  const loaded = loadState();

  let state: GameState = loaded.state;
  let stats: Stats = computeStats(state);
  let quantity: BuyQuantity = 1;

  /* Resume on the saved tab when it still exists, otherwise the default. */
  activeTab = tabEntries.some((tab) => tab.id === state.activeTab)
    ? (state.activeTab as TabId)
    : DEFAULT_TAB;

  /* Fractional carry for automation, so a rate of 2/s is independent of how
     often the tick happens to land. */
  const carry: AutomationCarry = { deploy: 0, buy: 0 };

  /* Last painted shard balance, for the gain badge. Seeded from the loaded
     save so a returning player does not see an enormous "+N" on start-up. */
  let lastShards = state.shards;
  let shardsGainTimer = 0;

  /* Loop timing. Declared here because the visibility handler below resets
     them when the tab is foregrounded again. */
  let lastFrame = performance.now();
  let accum = 0;
  let lastRender = 0;
  let lastSummary = 0;
  let lastAnnounce = 0;

  /* This tab claims ownership so other tabs can detect a newer writer. */
  if (storageAvailable) claimTab();

  /* Issue the opening contracts before the first paint. The slot count comes
     from the freshly computed stats so a save with a `contractSlots` upgrade
     opens with the right number rather than the base count. */
  fillContracts(state, stats.contractSlots);

  /* ------------------------------------------------------------------
     Stat breakdowns

     Hovering a total shows what it is made of. POINTER-ONLY, and that is a
     deliberate constraint rather than an oversight: the whole stats block is
     `aria-hidden` and mirrored by the throttled live summary, so giving these
     chips `tabindex` would put focusable content inside a hidden subtree --
     an accessibility fault worse than the one it would fix. Screen readers get
     the totals from the summary instead.

     The rows are rebuilt on every show rather than kept live, because the panel
     is invisible except while the pointer is on a chip, so there is nothing to
     keep in step and a rebuild is a handful of nodes.
     ------------------------------------------------------------------ */

  /** Which breakdown is showing, or null. */
  let shownBreakdown: string | null = null;

  /**
   * Build one flex row per term, each holding its own `<dt>`/`<dd>` pair.
   *
   * A `<div>` wrapping the pair is valid inside a `<dl>` (HTML 5.2), and it is
   * what makes each row a single flex line rather than two independent grid
   * cells that only LOOK paired. The difference matters for the label: as a grid
   * cell it was a fixed-width column, so a long term wrapped against a boundary
   * it could not negotiate; as a flex item it takes what it needs and the value
   * is pushed to the end by `margin-inline-start: auto`.
   *
   * The concept class goes on the ROW, not on the `dt` and `dd` separately.
   * Custom properties inherit, so one declaration covers the glyph, the label,
   * the value AND the row's guide rail -- and the rail is on the row, so it
   * would otherwise fall back to a neutral grey while everything beside it was
   * tinted. The class only sets `--concept`; nothing else is inherited.
   */
  function buildBreakdownRows(rows: BreakdownRow[]): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    for (const row of rows) {
      const line = document.createElement('div');
      line.className =
        row.concept === undefined
          ? 'game__breakdown-row'
          : `game__breakdown-row concept--${row.concept}`;
      if (row.sub === true) line.dataset.sub = '';
      if (row.total === true) line.dataset.total = '';

      const term = document.createElement('dt');
      if (row.concept !== undefined) {
        const glyph = createAchievementIcon(CONCEPTS[row.concept].icon, 1.5);
        glyph.classList.add('game__breakdown-icon');
        term.append(glyph);
      }
      /* The label is its own element so the term can be a flex row without the
         text becoming an anonymous item that cannot be word-broken. */
      const label_ = document.createElement('span');
      label_.className = 'game__breakdown-term';
      label_.textContent = row.label;
      term.append(label_);

      const value = document.createElement('dd');
      value.textContent = row.value;

      line.append(term, value);
      nodes.push(line);
    }
    return nodes;
  }

  function showBreakdown(key: string): void {
    const spec = BREAKDOWNS[key];
    if (spec === undefined) return;
    const breakdown: Breakdown = {
      title: spec.title,
      rows: [...spec.rows(state, stats), spec.total(state, stats)],
    };
    shownBreakdown = key;
    breakdownTitle.textContent = breakdown.title;
    breakdownRows.replaceChildren(...buildBreakdownRows(breakdown.rows));
    breakdownEl.hidden = false;
  }

  /**
   * Re-fill the open panel, so its numbers track the ones beside it.
   *
   * Without this the panel is a SNAPSHOT taken when the pointer arrived, and
   * the production breakdown would freeze its rate while the HUD's own
   * per-second figure ticks on a few rows above -- a frozen copy of a live
   * number reads as a bug. Cheap: it runs only while a chip is hovered, and
   * only from the 10Hz render pass.
   */
  function refreshBreakdown(): void {
    if (shownBreakdown !== null) showBreakdown(shownBreakdown);
  }

  function hideBreakdown(): void {
    if (shownBreakdown === null) return;
    shownBreakdown = null;
    breakdownEl.hidden = true;
  }

  for (const chip of container.querySelectorAll<HTMLElement>('[data-breakdown]')) {
    const key = chip.dataset.breakdown ?? '';
    chip.addEventListener('pointerenter', () => showBreakdown(key));
    chip.addEventListener('pointerleave', hideBreakdown);
    /*
     * A pointer that lands on a chip and never leaves it -- because the tab was
     * switched away, or an ability was engaged from the keyboard -- would leave
     * the panel up over stale numbers. Resetting on any engagement path is
     * cheaper than tracking why the pointer went away.
     */
  }
  /* Scroll and touch move are the two ways a pointer leaves without a
     `pointerleave`: a scrolling page slides the chip out from under it, and a
     touch drag is not a pointerleave on every engine. */
  window.addEventListener('scroll', hideBreakdown, { passive: true });
  document.addEventListener('pointercancel', hideBreakdown);

  /* ------------------------------------------------------------------
     Save status messaging
     ------------------------------------------------------------------ */

  function showStatus(message: string): void {
    statusEl.hidden = false;
    setText(statusEl, message);
  }

  if (!storageAvailable) {
    showStatus(
      'Saving is unavailable in this browser (private mode or storage is blocked), so progress will be lost when you close the tab. The game is otherwise fully playable.',
    );
    saveNowBtn.disabled = true;
    resetBtn.disabled = true;
    setText(saveNote, 'Saving is unavailable in this browser.');
  } else if (loaded.status === 'corrupt') {
    showStatus(
      'The existing save could not be read and was discarded, so this is a fresh start. Your previous progress could not be recovered.',
    );
    saveState(state);
  }

  /* ------------------------------------------------------------------
     Announcements

     Only discrete events are announced. Per-tick numbers would flood a
     screen reader, so they are summarised on a slow timer instead.
     ------------------------------------------------------------------ */

  function announce(message: string): void {
    /* Clearing first guarantees repeat announcements are still spoken. */
    liveEl.textContent = '';
    lastAnnounce = performance.now();
    window.setTimeout(() => {
      liveEl.textContent = message;
    }, 30);
  }

  /**
   * Announce at most once every `gapMs`.
   * Used for actions that fire rapidly, such as repeated manual deploys,
   * where announcing each one would queue up speech faster than it is read.
   */
  function announceThrottled(message: string, gapMs = 3000): void {
    if (performance.now() - lastAnnounce < gapMs) return;
    announce(message);
  }

  /* ------------------------------------------------------------------
     Toasts

     The live region above is the accessible channel, and it is invisible:
     a sighted player was therefore told nothing when a contract finished or
     an achievement unlocked, because the only record of it was a node that
     is deliberately read aloud and never shown.

     Same events, second channel. The toast region is `aria-hidden`, so the
     two never both speak.
     ------------------------------------------------------------------ */

  /** Older toasts are dropped rather than queued; the newest always shows. */
  const MAX_TOASTS = 3;
  /** Long enough to read a reward line, short enough not to linger. */
  const TOAST_MS = 4200;
  /** Fallback removal in case `transitionend` never fires (reduced motion). */
  const TOAST_EXIT_MS = 600;

  /**
   * `content` is a string for a plain message, or a NODE when the message names
   * a quantity that has to carry its concept glyph and hue. Two channels, two
   * forms -- see `notify()`.
   */
  function showToast(content: string | Node): void {
    const toast = document.createElement('p');
    toast.className = 'toast';
    if (typeof content === 'string') toast.textContent = content;
    else toast.append(content);
    toastsEl.append(toast);

    /* Trim from the FRONT, so the toast just added is never the one dropped. */
    while (toastsEl.childElementCount > MAX_TOASTS) {
      toastsEl.firstElementChild?.remove();
    }

    /* Add the enter class a frame later, or the element is inserted with the
       final styles already applied and the transition never runs. */
    window.requestAnimationFrame(() => toast.classList.add('toast--in'));

    window.setTimeout(() => {
      toast.classList.remove('toast--in');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      /* Belt and braces: under `prefers-reduced-motion` there is no
         transition, so `transitionend` would never arrive. */
      window.setTimeout(() => toast.remove(), TOAST_EXIT_MS);
    }, TOAST_MS);
  }

  /**
   * Announce on both channels: spoken for a screen reader, shown for eyes.
   *
   * The two get DIFFERENT content when the message names a quantity, and the
   * difference is not cosmetic. The live region is read aloud, so it wants
   * plain words: an SVG glyph is `aria-hidden` and contributes nothing to
   * speech, so a figure with no noun beside it is heard as a bare number. The
   * toast is looked at, and there a figure must carry the same glyph and hue it
   * carries on the HUD, in a cost line and on an achievement chip -- otherwise
   * "13" in a reward line is a number with no identity, which is exactly the
   * complaint that produced `concepts.ts` in the first place.
   *
   * `shown` is built by the caller from the SAME values as `message`, so the
   * two forms can differ in presentation but never in the figure.
   */
  function notify(message: string, shown?: Node): void {
    announce(message);
    showToast(shown ?? message);
  }

  /* ------------------------------------------------------------------
     Build: services (once)
     ------------------------------------------------------------------ */

  const serviceRows: ServiceRow[] = SERVICES.map((def, index) => {
    const li = document.createElement('li');
    li.className = 'service';
    /*
     * One hue per tier, applied by class so every descendant inherits it:
     * the medallion, the output number, the milestone pips.
     *
     * A class rather than an inline `--tier: var(--tier-N)`.
     * Indirection through an inline custom property does not reliably
     * recompute when a media query changes the ramp at :root, so the print
     * stylesheet could not collapse it to black. Keeping the mapping in CSS
     * also means this file states *which* tier, not *what colour*.
     */
    li.classList.add(`service--tier-${Math.min(index + 1, 8)}`);

    const main = document.createElement('div');
    main.className = 'service__main';

    /* Medal, name and state share a row so the name never wraps under the
       glyph. */
    const head = document.createElement('div');
    head.className = 'service__head';

    const medal = document.createElement('span');
    medal.className = 'medal service__medal';

    const icon = createServiceIcon(def.id);
    medal.append(icon);

    const name = paragraph('service__name', def.name);

    /* Says "not yet deployed" in words, so the muted medal is not the only
       signal that a tier is idle. */
    const ownedBadge = paragraph('service__owned', 'Not deployed');

    head.append(medal, name, ownedBadge);

    const blurb = paragraph('service__blurb', def.blurb);

    /* Five pips toward the next milestone. The exact figure is printed in the
       facts row as "N to go", so the pips are reinforcement, not the source. */
    const pips = document.createElement('span');
    pips.className = 'service__pips';
    const pipEls: HTMLElement[] = [];
    for (let i = 0; i < 5; i++) {
      const pip = document.createElement('span');
      pip.className = 'service__pip';
      pips.append(pip);
      pipEls.push(pip);
    }

    /*
     * The plain-language explanation of the multiplier beside it: how many
     * milestone steps are banked, and what the next one is worth. A milestone
     * multiplier is a POWER, so a tier with a fractional bonus shows a value
     * like 25.63x that no amount of wording makes intuitive on its own. The
     * step count is the intuitive half -- "4 steps" -- and stating the next
     * threshold turns an abstract curve into a concrete reward for deepening.
     */
    const milestoneNote = paragraph('service__milestone-note', '');
    /*
     * The note is built once and its two halves are updated in place.
     *
     * The reward half exists so a milestone crossing is not an invisible
     * payout: the shards used to arrive from a rule the player could only
     * infer from a purchase, landing in a HUD counter with nothing on screen
     * connecting the two. Naming the figure BESIDE the threshold that pays it
     * is the whole point.
     *
     * The concept wrapper is what makes it read as currency rather than as one
     * more number in a line that already contains three.
     */
    const milestoneSteps = document.createElement('span');
    const milestoneShardWrap = createConcept('shards');
    const milestoneShard = conceptText(milestoneShardWrap);
    milestoneNote.append(milestoneSteps, ' · ', milestoneShardWrap);
    const milestoneTrack = document.createElement('div');
    milestoneTrack.className = 'service__milestone-track';
    milestoneTrack.append(pips, milestoneNote);

    main.append(head, blurb);

    /* Supporting numbers, each with its own hue, so a value can be picked out
       before its caption is read. */
    const facts = document.createElement('div');
    facts.className = 'service__facts';

    const makeFact = (labelText: string, variant: string) => {
      const wrap = document.createElement('span');
      wrap.className = `service__fact service__fact--${variant}`;
      const caption = label(labelText);
      caption.classList.add('service__fact-label');
      const value = document.createElement('span');
      value.className = 'service__fact-value';
      value.textContent = '0';
      wrap.append(caption, value);
      return { wrap, value };
    };

    const ownedStat = makeFact('Owned', 'owned');
    const shareStat = makeFact('Share', 'share');
    const milestoneStat = makeFact('Milestone', 'milestone');
    facts.append(ownedStat.wrap, shareStat.wrap, milestoneStat.wrap);

    main.append(facts, milestoneTrack);

    /*
     * The tier's headline number: what this service actually produces, in the
     * tier's own hue. It is the one value worth reading at a glance, so it
     * gets its own column instead of sitting inline with everything else.
     */
    const output = document.createElement('div');
    output.className = 'service__output';

    const outputLabel = label('Output');
    outputLabel.classList.add('service__output-label');

    const outputValue = document.createElement('span');
    outputValue.className = 'service__output-value';
    outputValue.textContent = '0/s';

    output.append(outputLabel, outputValue);

    const action = document.createElement('div');
    action.className = 'service__action';

    /* A service price is paid in compute, so it carries the compute glyph and
       hue rather than being a bare number beside a Buy button. */
    const cost = createConcept('compute');
    cost.classList.add('service__cost');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-btn game-btn--accent service__buy';
    button.dataset.service = def.id;
    button.textContent = 'Buy';

    action.append(cost, button);

    /*
     * This tier's own upgrades, nested in its card.
     *
     * They are filed here rather than in the Upgrades tab because they are
     * only meaningful next to the tier they modify: "Keep-alive pool" means
     * nothing without the Worker count and output on the same row.
     */
    const upgradesWrap = document.createElement('div');
    upgradesWrap.className = 'service__upgrades';
    upgradesWrap.hidden = true;

    const upgradesLabel = paragraph('service__upgrades-label', 'Upgrades');

    const upgradesList = document.createElement('ul');
    upgradesList.className = 'service-upgrades';

    upgradesWrap.append(upgradesLabel, upgradesList);

    li.append(main, output, action, upgradesWrap);
    servicesList.append(li);

    return {
      def,
      root: li,
      icon,
      medal,
      owned: ownedStat.value,
      ownedBadge,
      output: outputValue,
      share: shareStat.value,
      milestone: milestoneStat.value,
      milestoneNote,
      milestoneSteps,
      milestoneShard,
      pips: pipEls,
      cost,
      costText: conceptText(cost),
      button,
      upgradesWrap,
      upgradesList,
    };
  });

  /* ------------------------------------------------------------------
     Build: abilities (once)

     Built from the ABILITIES table rather than authored in the markup, so
     an ability unlocked mid-run is already on screen and only needs its
     state repainted. Locked ones stay visible: knowing what exists and how
     it is earned is the point.
     ------------------------------------------------------------------ */

  const abilityRows: AbilityRow[] = ABILITIES.map((def) => {
    const root = document.createElement('div');
    root.className = 'ability ability--locked';

    const icon = document.createElement('span');
    icon.className = 'medal ability__icon';
    icon.append(createAchievementIcon(def.icon, 1.6));

    const body = document.createElement('div');
    body.className = 'ability__body';

    const name = paragraph('ability__name', def.name);
    const stateEl = paragraph('ability__state', 'Locked');
    const timer = paragraph('ability__timer', def.summary);

    const track = document.createElement('span');
    track.className = 'ability__track';
    const bar = document.createElement('span');
    bar.className = 'ability__bar';
    track.append(bar);

    body.append(name, stateEl, timer, track);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-btn game-btn--accent ability__button';
    button.dataset.ability = def.id;
    button.textContent = 'Locked';
    button.disabled = true;

    root.append(icon, body, button);
    abilitiesList.append(root);

    return { def, root, icon, stateEl, timer, bar, button };
  });

  /* ------------------------------------------------------------------
     Build: achievements (once)

     Filed under themed headings, in AUTHORED order within a heading --
     hardest first, each family kept contiguous, so a group reads as a set of
     progressions rather than an arbitrary list. Every
     reward an unlock grants gets its own chip, so a multi-reward card
     advertises everything it gives.
     ------------------------------------------------------------------ */

  function buildRewardChip(reward: AchievementDef['rewards'][number]): HTMLElement {
    const chip = document.createElement('span');
    chip.className =
      reward.kind === 'unlockAbility'
        ? 'achievement__reward achievement__reward--ability'
        : 'achievement__reward';

    /* An unlocked ability is the flashiest thing a card can give, so it is
       marked with both a key glyph and its own border colour. */
    if (reward.kind === 'unlockAbility') {
      const glyph = createAchievementIcon('key', 1.5);
      glyph.classList.add('achievement__reward-icon');
      chip.append(glyph);
    } else {
      /* A reward that names a currency or a stat carries that concept's glyph
         AND its hue, so "Cores x1.15" and the cores figure in the HUD read as
         the same thing.

         The chip used to keep the card's rarity colour and give the hue to the
         glyph alone, on the theory that the chip's colour was its rarity band
         and the two must not fight. What that actually produced was a violet
         cores glyph sitting on gold text -- the mention carried the glyph but
         not the hue, which is half a concept, and the half that reads at a
         glance. The locked/unlocked signal for a chip is its OPACITY (see
         `.achievement--locked .achievement__rewards`), so the hue is free to
         mean the thing the reward is about. */
      const concept = rewardConcept(reward);
      if (concept !== null) {
        chip.classList.add('achievement__reward--concept', `concept--${concept}`);
        const glyph = createAchievementIcon(CONCEPTS[concept].icon, 1.5);
        /* Size and hue come from CSS (`achievement__reward .concept__icon`),
           so a chip glyph cannot end up a different size from its neighbours. */
        glyph.classList.add('achievement__reward-icon', 'concept__icon', `concept--${concept}`);
        chip.append(glyph);
      }
    }

    const text = document.createElement('span');
    text.textContent = describeReward(reward);
    chip.append(text);

    return chip;
  }

  function buildAchievementCard(def: AchievementDef): AchievementRow {
    const li = document.createElement('li');
    li.className = `achievement achievement--locked achievement--${def.rarity}`;
    li.dataset.achievement = def.id;

    const head = document.createElement('div');
    head.className = 'achievement__head';

    const medal = document.createElement('span');
    medal.className = 'medal achievement__medal';
    medal.append(createAchievementIcon(def.icon, RARITY_STROKE[def.rarity] ?? 1.5));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'achievement__title';

    const name = paragraph('achievement__name', def.name);

    /* Rarity is spelled out, so it never depends on colour alone. The
       medallion tint and the glyph stroke weight carry it redundantly. */
    const rarity = document.createElement('span');
    rarity.className = `achievement__tier achievement__tier--${def.rarity}`;
    rarity.textContent = RARITY_LABELS[def.rarity];

    titleWrap.append(name, rarity);
    head.append(medal, titleWrap);

    const blurb = paragraph('achievement__blurb', def.blurb);

    const rewards = document.createElement('div');
    rewards.className = 'achievement__rewards';
    for (const reward of def.rewards) rewards.append(buildRewardChip(reward));

    /* Progress is shown as text plus a rule, never as colour alone. */
    const progress = document.createElement('div');
    progress.className = 'achievement__progress';

    const track = document.createElement('span');
    track.className = 'achievement__track';
    const bar = document.createElement('span');
    bar.className = 'achievement__bar';
    track.append(bar);

    const progressText = document.createElement('span');
    progressText.className = 'achievement__progress-text';

    progress.append(track, progressText);

    const stateEl = paragraph('achievement__state', 'Locked');

    li.append(head, blurb, rewards, progress, stateEl);

    return { id: def.id, root: li, stateEl, progressText, progressBar: bar };
  }

  interface AchievementGroupRow {
    ids: string[];
    countEl: HTMLElement;
  }

  const achievementRows: AchievementRow[] = [];
  const achievementGroups: AchievementGroupRow[] = [];

  /*
   * Achievements already known to be unlocked. Seeded from the loaded save, so
   * opening the page does not flash every card the player already had. Only a
   * card that flips from locked to unlocked while playing gets the pulse.
   */
  const seenUnlocked = new Set<string>(state.achievements);

  /**
   * Flash a card once when it unlocks.
   *
   * Called once per render, not per row. The class is added here and cleared
   * on a timer rather than being derived from state, because it marks a
   * *transition* rather than a condition. The `is-new` rule only animates an
   * overlay's opacity, so nothing moves and a repeated render mid-flight
   * cannot restart or stack the flash.
   *
   * A row that is still locked is deliberately not recorded: it has to stay
   * eligible so it can flash on the render where it actually unlocks.
   */
  function flagNewUnlocks(unlockedSet: Set<string>): void {
    for (const row of achievementRows) {
      if (seenUnlocked.has(row.id)) continue;
      if (!unlockedSet.has(row.id)) continue;

      seenUnlocked.add(row.id);
      row.root.classList.add('is-new');
      window.setTimeout(() => row.root.classList.remove('is-new'), FLASH_MS);
    }
  }

  for (const group of ACHIEVEMENT_GROUPS) {
    const members = ACHIEVEMENTS.filter((def) => def.group === group.id);
    if (members.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'achievement-group';

    const head = document.createElement('div');
    head.className = 'achievement-group__head';

    const title = document.createElement('h3');
    title.className = 'achievement-group__title';
    title.textContent = group.label;

    const countEl = paragraph('achievement-group__count mono', '');

    head.append(title, countEl, paragraph('achievement-group__blurb', group.blurb));

    const list = document.createElement('ul');
    list.className = 'achievements';

    for (const def of members) {
      const row = buildAchievementCard(def);
      list.append(row.root);
      achievementRows.push(row);
    }

    section.append(head, list);
    achievementsList.append(section);
    achievementGroups.push({ ids: members.map((def) => def.id), countEl });
  }

  /* ------------------------------------------------------------------
     Build: contracts (rebuilt only when the offered set changes)
     ------------------------------------------------------------------ */

  /*
   * null means "force a rebuild". An empty string is a legitimate signature
   * (nothing visible), so it cannot double as the sentinel: after a full
   * reset the new signature is empty, and an empty sentinel would make the
   * comparison match and leave the old rows on screen.
   */
  let contractSignature: string | null = null;

  function rebuildContracts(): void {
    const views = contractViews(state);
    const signature = views.map((v) => v.def.id).join(',');

    if (signature === contractSignature) return;
    contractSignature = signature;

    contractsList.replaceChildren();

    for (const view of views) {
      const li = document.createElement('li');
      li.className = 'contract';

      const head = document.createElement('div');
      head.className = 'contract__head';

      const medal = document.createElement('span');
      medal.className = 'medal contract__medal';
      medal.append(createAchievementIcon(view.def.icon, 1.5));

      const name = paragraph('contract__name', view.def.name);
      head.append(medal, name);

      /* The OBJECTIVE, rendered from the stored target rather than authored.
         A contract's size is computed when it is drawn, so a hand-written
         "Earn 5,000 shards" would be wrong at every other scale -- and the
         whole redesign exists to make this number real. Updated in render(),
         because it does not change while the contract lives but must survive
         a rebuild. */
      const objective = paragraph('contract__objective', '');

      const blurb = paragraph('contract__blurb', view.def.blurb);

      /* Payout is a badge rather than a footnote, so the reward is visible
         while the contract is still in progress, not only after.

         The two currencies are separate spans so each carries its own hue
         (compute = the HUD's compute colour, shards = the shard colour),
         while the "Reward" word and the diamond stay in the contract's own
         state colour. Each figure is still labelled with its currency, so
         the hue is a reading aid and never the only signal. */
      const reward = paragraph('contract__reward', '');
      const rewardLabel = document.createElement('span');
      rewardLabel.textContent = 'Reward';

      /* Each payout carries its concept glyph and hue, so the two currencies a
         contract pays are recognisable before the figures are read. The hues
         alone were doing that job, which is not enough: "250 compute +24
         shards" in two colours is still two bare numbers, and the glyph is
         what links them to the HUD chips that name them. */
      const rewardComputeWrap = createConcept('compute');
      const rewardCompute = conceptText(rewardComputeWrap);
      rewardCompute.classList.add('contract__reward-compute');

      const rewardPlus = document.createElement('span');
      rewardPlus.className = 'contract__reward-plus';
      rewardPlus.textContent = '+';

      const rewardShardsWrap = createConcept('shards');
      const rewardShards = conceptText(rewardShardsWrap);
      rewardShards.classList.add('contract__reward-shards');

      /* Spaces are real text nodes, not a flex `gap`: the badge is a flex/grid
         item that blockifies, so its children would otherwise sit flush and
         the whole line would read and copy as "Reward250 compute+24 shards".
         Inline flow keeps the words separable for screen readers and for a
         text selection. */
      reward.append(
        rewardLabel,
        ' ',
        rewardComputeWrap,
        ' ',
        rewardPlus,
        ' ',
        rewardShardsWrap,
      );

      /* The spaces above are real text nodes, and hiding an element leaves them
         behind -- so a compute-only card renders "Reward" then several
         collapsed spaces before its single figure. HTML collapses runs of
         whitespace, so nothing shows; only a text selection sees the gap, and
         that is a smaller cost than dropping to a layout that cannot wrap. */

      const progress = document.createElement('div');
      progress.className = 'contract__progress';

      const track = document.createElement('span');
      track.className = 'contract__track';
      const bar = document.createElement('span');
      bar.className = 'contract__bar';
      track.append(bar);

      const text = document.createElement('span');
      text.className = 'contract__progress-text';

      progress.append(track, text);

      li.dataset.contract = view.def.id;
      li.append(head, objective, blurb, reward, progress);

      /* Stash the live nodes so render() can update without a rebuild. The
         separators are stashed too, because a contract that pays only ONE
         currency has to hide the other half of the line -- "0 shards" beside a
         compute payout is not variety, it is a bug the player can see. */
      contractNodes.set(view.def.id, {
        bar,
        text,
        objective,
        rewardCompute,
        rewardComputeWrap,
        rewardPlus,
        rewardShards,
        rewardShardsWrap,
      });

      contractsList.append(li);
    }
  }

  const contractNodes = new Map<
    string,
    {
      bar: HTMLElement;
      text: HTMLElement;
      objective: HTMLElement;
      rewardCompute: HTMLElement;
      rewardComputeWrap: HTMLElement;
      rewardPlus: HTMLElement;
      rewardShards: HTMLElement;
      rewardShardsWrap: HTMLElement;
    }
  >();

  /* ------------------------------------------------------------------
     Build: upgrades

     Two destinations, one reconcile:
       - a TIER upgrade renders inside its own service card, in the Services
         tab. Tier-ness is not a kind list: a row is a tier upgrade exactly
         when `describeEffect()` files it under the `'services'` group;
       - everything else is filed into themed groups in the Upgrades tab.

     The group is derived from the upgrade's effect (see describeEffect), so
     adding an upgrade in content.ts files it automatically and no second
     list can drift out of step.
     ------------------------------------------------------------------ */

  /* 'services' is absent on purpose: those upgrades live in the Services tab. */
  const UPGRADE_GROUPS: {
    id: UpgradeGroup;
    label: string;
    blurb: string;
    /* The named quantity the section is about, so the heading carries the same
       glyph and hue as the HUD figure and every badge inside it. Deploys reads
       with the deploy arrow, Global with the multiplier planes, Automation and
       Offline with production. */
    concept: ConceptId;
  }[] = [
    {
      id: 'deploys',
      label: 'Deploys',
      blurb: 'Improves the deploy button itself.',
      concept: 'deploy',
    },
    {
      id: 'global',
      label: 'Global',
      blurb: 'Lifts every tier at once.',
      concept: 'multiplier',
    },
    {
      id: 'reserve',
      label: 'Reserve',
      blurb:
        'Multiplies what every contract pays out, then raises what the shards you are holding produce. Saving and spending are a real trade, because the balance you hold is itself a multiplier.',
      concept: 'reserve',
    },
    {
      id: 'automation',
      label: 'Automation',
      blurb:
        'Deploys on a schedule and spends compute on capacity for you, up to half of what the fleet makes. Auto-buy is the half that commits your balance to purchases you did not choose.',
      concept: 'production',
    },
    {
      id: 'offline',
      label: 'Offline',
      blurb: 'Improves what you earn while away.',
      concept: 'production',
    },
  ];


  /**
   * True for an upgrade that belongs to a single service tier.
   *
   * Derived from `describeEffect().group`, which is the SAME source the shop
   * buckets rows by. A hand-maintained list of kinds lived here and drifted:
   * four mechanisms were missing from it, so they were classified as shop rows
   * -- but the shop's group list has no 'services' entry, so they rendered
   * NOWHERE and were silent dead content on four tiers.
   *
   * Deriving the predicate from the formatter makes that class of bug
   * impossible: a kind is a tier upgrade exactly when the formatter files it
   * under 'services', so a new mechanism needs no change here at all.
   */
  function isTierUpgrade(upgrade: UpgradeDef): boolean {
    return describeEffect(upgrade).group === 'services';
  }

  /**
   * Effect kind -> the order its ladder is shown in.
   *
   * Built once from `UPGRADES` by first appearance, so it is derived from the
   * content rather than hand-listed: a new effect kind is ranked the moment it
   * exists, instead of sorting as `undefined` and landing at the top of every
   * group it appears in.
   */
  const kindRank = new Map<string, number>();
  for (const upgrade of UPGRADES) {
    if (!kindRank.has(upgrade.effect.kind)) {
      kindRank.set(upgrade.effect.kind, kindRank.size);
    }
  }

  /* null forces a rebuild; see the note on contractSignature above. */
  let upgradeSignature: string | null = null;  /* Retained so render() and the tab badges can reuse the same list rather
     than re-evaluating every upgrade's reveal predicate more than once. */
  let visibleUpgradeList: UpgradeDef[] = [];
  /* Per-group owned counts, so a long shop reports progress per section. */
  const upgradeGroupCounts: { ids: string[]; countEl: HTMLElement }[] = [];

  /**
   * Build one upgrade row.
   *
   * Shared by the shop and the nested tier lists, so the two cannot drift.
   * Only the root class differs: `.upgrade` for a shop card, `.service-upgrade`
   * for one nested under its service. The inner class names are reused, which
   * keeps the styling in one place.
   */
  function buildUpgradeRow(upgrade: UpgradeDef, owned: boolean): HTMLElement {
    const effect = describeEffect(upgrade);

    const li = document.createElement('li');
    li.className = `upgrade upgrade--${effect.group}`;
    if (owned) li.classList.add('upgrade--owned');

    const medal = document.createElement('span');
    medal.className = 'medal upgrade__medal';
    medal.append(createAchievementIcon(upgrade.icon, 1.5));

    const main = document.createElement('div');
    main.className = 'upgrade__main';

    /*
     * Name and effect share a row so the actual gain is readable at a glance.
     * It used to be buried in the blurb sentence ("Workers produce twice as
     * much"), which made comparing two upgrades a reading exercise.
     */
    const nameRow = document.createElement('div');
    nameRow.className = 'upgrade__name-row';

    const name = paragraph('upgrade__name', upgrade.name);

    /* The badge states a quantity; when that quantity is a currency or a
       named stat it carries the concept's glyph and hue, so "shards per unit"
       here reads as the same currency as the price tag below it. The glyph
       goes INSIDE the badge ahead of the text, so the chip stays one object
       rather than becoming a glyph plus a chip. */
    const effectEl = document.createElement('span');
    effectEl.className = 'upgrade__effect';
    if (effect.concept !== undefined) {
      const glyph = createAchievementIcon(CONCEPTS[effect.concept].icon, 1.5);
      glyph.classList.add('concept__icon', `concept--${effect.concept}`);
      effectEl.append(glyph);
    }
    effectEl.append(document.createTextNode(effect.text));

    nameRow.append(name, effectEl);

    const blurb = paragraph('upgrade__blurb', upgrade.blurb);
    main.append(nameRow, blurb);

    const action = document.createElement('div');
    action.className = 'upgrade__action';

    if (owned) {
      action.append(paragraph('upgrade__owned', 'Owned'));
    } else {
      /* An upgrade is bought with shards, so its price carries the shard
         glyph and hue -- the same pair the HUD balance and a contract reward
         use, which is what makes the two ends of the economy recognisable as
         the same currency. */
      const cost = createConcept('shards', `Cost ${formatPrice(upgradeCost(upgrade))} shards`);
      cost.classList.add('upgrade__cost', 'mono', 'cost--shard');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'game-btn game-btn--accent';
      button.dataset.upgrade = upgrade.id;
      button.textContent = 'Buy';
      button.setAttribute(
        'aria-label',
        `Buy ${upgrade.name} for ${formatPrice(upgradeCost(upgrade))} shards`,
      );

      action.append(cost, button);
    }

    li.append(medal, main, action);
    return li;
  }

  function rebuildUpgrades(): void {
    const visible = visibleUpgrades(state, stats);
    visibleUpgradeList = visible;

    /*
     * The signature includes owned-ness, not just the set of ids. A row is
     * built either as a "Buy" control or as an "Owned" label, so purchasing
     * an upgrade has to rebuild its row -- keying on the ids alone left a
     * bought upgrade still showing a Buy button, which read as the click
     * having done nothing.
     */
    const signature = visible
      .map((upgrade) => `${upgrade.id}:${state.upgrades.includes(upgrade.id) ? 1 : 0}`)
      .join(',');

    if (signature === upgradeSignature) return;
    upgradeSignature = signature;

    /* Nested tier upgrades, one list per service card. Uses `isTierUpgrade`
       rather than matching a single effect kind, so a new per-tier mechanism
       files itself here automatically instead of vanishing. */
    for (const row of serviceRows) {
      const mine = visible.filter(
        (upgrade) =>
          isTierUpgrade(upgrade) && upgrade.effect.serviceId === row.def.id,
      );
      row.upgradesList.replaceChildren();
      row.upgradesWrap.hidden = mine.length === 0;

      for (const upgrade of mine) {
        row.upgradesList.append(
          buildUpgradeRow(upgrade, state.upgrades.includes(upgrade.id)),
        );
      }
    }

    /* The shop: everything that is not tied to one tier. */
    const shop = visible.filter((upgrade) => !isTierUpgrade(upgrade));

    upgradesList.replaceChildren();
    upgradeGroupCounts.length = 0;

    /* Bucket once, rather than re-deriving the group per panel section. */
    const grouped = new Map<UpgradeGroup, UpgradeDef[]>();
    for (const upgrade of shop) {
      const group = describeEffect(upgrade).group;
      const bucket = grouped.get(group);
      if (bucket === undefined) grouped.set(group, [upgrade]);
      else bucket.push(upgrade);
    }

    for (const group of UPGRADE_GROUPS) {
      const members = grouped.get(group.id);
      if (members === undefined || members.length === 0) continue;

      /*
       * Within a group, sort by EFFECT and then by price.
       *
       * The shop's SOURCE order is by price, because that is what the band
       * table needs in order to land each ladder one step per band. That
       * interleaves the ladders, so the Global group read "Horizontal scaling,
       * Volume discount, Master agreement, Fleet gravity, Service mesh..." --
       * the four steps of one investment scattered among three others, and
       * working out which purchase continues which a scanning exercise.
       *
       * Sorting here rather than reordering the content keeps both: the band
       * table still reads the list it needs, and the panel shows ladders.
       *
       * Kind order is by FIRST APPEARANCE in `UPGRADES` rather than
       * alphabetically, so the ladders come out in the order the content
       * introduces them instead of the order their effect names happen to
       * sort in.
       */
      const ordered = [...members].sort((a, b) => {
        const ka = kindRank.get(a.effect.kind) ?? 0;
        const kb = kindRank.get(b.effect.kind) ?? 0;
        if (ka !== kb) return ka - kb;
        return upgradeCost(a) - upgradeCost(b);
      });

      const section = document.createElement('section');
      section.className = 'upgrade-group';

      const head = document.createElement('div');
      head.className = 'upgrade-group__head';

      const title = document.createElement('h3');
      title.className = 'upgrade-group__title';
      title.textContent = group.label;

      /* The heading names a quantity, so it carries that concept's glyph and
         hue -- the same pair the badges inside it and the HUD chip use. It is
         decorative (the label beside it is the text), so it is aria-hidden by
         `createAchievementIcon` already. */
      const groupIcon = createAchievementIcon(CONCEPTS[group.concept].icon, 1.5);
      groupIcon.classList.add('upgrade-group__icon', `concept--${group.concept}`);

      const countEl = paragraph('upgrade-group__count mono', '');

      head.append(groupIcon, title, countEl, paragraph('upgrade-group__blurb', group.blurb));

      const list = document.createElement('ul');
      list.className = 'upgrades';

      for (const upgrade of ordered) {
        list.append(buildUpgradeRow(upgrade, state.upgrades.includes(upgrade.id)));
      }

      section.append(head, list);
      upgradesList.append(section);
      upgradeGroupCounts.push({ ids: ordered.map((u) => u.id), countEl });
    }

    upgradesEmpty.hidden = shop.length > 0;
  }

  /* ------------------------------------------------------------------
     Purchase quantity
     ------------------------------------------------------------------ */

  const qtyButtons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-qty]'),
  );

  for (const button of qtyButtons) {
    button.addEventListener('click', () => {
      const raw = button.dataset.qty;
      quantity = raw === 'max' ? 'max' : raw === '10' ? 10 : 1;

      for (const other of qtyButtons) {
        setAttr(other, 'aria-pressed', String(other === button));
      }

      render();
    });
  }

  /* ------------------------------------------------------------------
     Tabs

     Switching only flips `hidden` on the panels and `aria-selected` on the
     buttons; nothing is rebuilt. Roving tabindex plus arrow keys is the
     standard tab pattern: only the selected tab is in the tab order, and
     the arrow keys move between them.
     ------------------------------------------------------------------ */

  function selectTab(id: TabId, focus = false, save = true): void {
    activeTab = id;
    state.activeTab = id;

    for (const tab of tabEntries) {
      const selected = tab.id === id;
      setAttr(tab.button, 'aria-selected', String(selected));
      setAttr(tab.button, 'tabindex', selected ? '0' : '-1');
      tab.panel.hidden = !selected;
      if (selected && focus) tab.button.focus();
    }

    if (save) persist();
  }

  for (const tab of tabEntries) {
    tab.button.addEventListener('click', () => selectTab(tab.id));
    tab.button.addEventListener('keydown', (event) => {
      const index = tabEntries.indexOf(tab);
      const last = tabEntries.length - 1;

      let next: number;
      switch (event.key) {
        case 'ArrowRight':
          next = index === last ? 0 : index + 1;
          break;
        case 'ArrowLeft':
          next = index === 0 ? last : index - 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = last;
          break;
        default:
          return;
      }

      event.preventDefault();
      const target = tabEntries[next];
      if (target !== undefined) selectTab(target.id, true);
    });
  }

  /*
   * The site header links to the save controls, which now live inside the
   * Reboot panel and are therefore hidden most of the time. Intercept the
   * click so the link still lands somewhere useful instead of scrolling to a
   * hidden element. Left as a real anchor so it degrades to nothing harmful.
   */
  const saveLink = document.querySelector<HTMLAnchorElement>('a[href="#save-note"]');
  saveLink?.addEventListener('click', (event) => {
    event.preventDefault();
    selectTab('reboot');
    document.getElementById('save-note')?.scrollIntoView({ block: 'center' });
    saveNowBtn.focus();
  });

  /* ------------------------------------------------------------------
     Actions
     ------------------------------------------------------------------ */

  /**
   * Spawn the "+N" that rises from a deploy.
   *
   * Follows the toast's shape rather than inventing a second one: cap the
   * child count, then remove on `animationend` with a `setTimeout` fallback,
   * because under `prefers-reduced-motion` the animation is disabled and the
   * event would never arrive.
   *
   * `x` and `y` are already relative to the button, and `width` is passed in
   * because the caller has the box in hand -- re-measuring here would force a
   * second layout read on a click path.
   */
  function spawnDeployFloat(
    amount: number,
    x: number,
    y: number,
    width: number,
  ): void {
    /*
     * Trim from the FRONT, so the float just added is never the one dropped.
     * Bounded because the animation is ~0.9s and a player can click faster
     * than that; without a cap this adds a node per click for as long as the
     * animation runs.
     */
    while (deployFloats.childElementCount >= MAX_DEPLOY_FLOATS) {
      deployFloats.firstElementChild?.remove();
    }

    const float = document.createElement('span');
    float.className = 'game__deploy-float';
    float.textContent = `+${formatNumber(amount)}`;
    /* Centred on the cursor, so the same rule works wherever the click landed,
       and clamped so a click at the very edge cannot push it outside. */
    float.style.left = `${Math.min(
      Math.max(x, DEPLOY_FLOAT_MARGIN),
      Math.max(DEPLOY_FLOAT_MARGIN, width - DEPLOY_FLOAT_MARGIN),
    )}px`;
    float.style.top = `${y}px`;

    deployFloats.append(float);

    float.addEventListener('animationend', () => float.remove(), { once: true });
    /* Belt and braces: reduced motion disables the animation, so
       `animationend` would never fire and the node would leak. */
    window.setTimeout(() => float.remove(), DEPLOY_FLOAT_MS);
  }

  deployBtn.addEventListener('click', (event) => {
    const gained = manualDeploy(state, stats);
    refresh();

    /* A short class pulse acknowledges the click without a layout change. */
    deployBtn.classList.add('is-fired');
    window.setTimeout(() => deployBtn.classList.remove('is-fired'), 90);

    /*
     * And a number at the point of action.
     *
     * `manualDeploy()` has always returned the compute it granted, and that
     * value was previously used ONLY for the announcement below -- so the most
     * frequent action in the game changed a readout somewhere else on the page
     * and nothing at the place it happened. This is the feedback the core loop
     * was missing.
     *
     * The coordinates are taken from the POINTER when there is one, and from
     * the button's centre when there is not: a keyboard activation reports
     * `detail === 0` and `clientX/Y === 0`, which would otherwise stack every
     * float in the button's top-left corner.
     */
    const box = deployBtn.getBoundingClientRect();
    const fromPointer = event.detail > 0;
    spawnDeployFloat(
      gained,
      fromPointer ? event.clientX - box.left : box.width / 2,
      fromPointer ? event.clientY - box.top : box.height / 2,
      box.width,
    );

    /* Throttled: a player clicking rapidly would otherwise flood the live
       region with announcements faster than they can be read. */
    announceThrottled(`Deployed. Gained ${formatNumber(gained)} compute.`);
  });

  /* One delegated handler covers every ability, including ones that are
     still locked: the engine decides whether the activation is legal.

     Scoped to the BUTTON, not the card. The id used to sit on the card root as
     well, so `closest('[data-ability]')` matched the whole row and clicking a
     blurb, a timer or the medallion fired the ability. */
  abilitiesList.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest<HTMLButtonElement>('button[data-ability]');
    if (button === null) return;

    const id = button.dataset.ability;
    if (id === undefined) return;

    const def = ABILITIES.find((ability) => ability.id === id);
    const result = activateAbility(state, id, Date.now(), stats);
    if (!result.ok || def === undefined) return;

    refresh();

    if (def.kind === 'boost') {
      announce(`${def.name} engaged.`);
    } else {
      announce(
        `${def.name}: ${result.granted} free ${
          result.granted === 1 ? 'service' : 'services'
        } across every tier you own.`,
      );
    }
  });

  servicesList.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest<HTMLButtonElement>('[data-service]');
    if (button === null) return;

    const id = button.dataset.service;
    if (id === undefined) return;

    const before = state.services[id] ?? 0;
    if (!buyService(state, id, quantity, stats)) return;

    const bought = (state.services[id] ?? 0) - before;
    const def = SERVICE_BY_ID[id];
    refresh();
    if (def) announce(`Bought ${bought} ${def.name}.`);
  });

  /*
   * Upgrades are bought from two places now: the Upgrades shop and the
   * nested list inside each service card. One named handler is bound to both
   * roots rather than hoisting a listener onto the whole container.
   */
  function handleUpgradeClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest<HTMLButtonElement>('[data-upgrade]');
    if (button === null) return;

    const id = button.dataset.upgrade;
    if (id === undefined) return;

    const def = UPGRADES.find((upgrade) => upgrade.id === id);
    if (!buyUpgrade(state, id)) return;

    refresh();
    if (def) announce(`Upgrade purchased: ${def.name}.`);
  }

  upgradesList.addEventListener('click', handleUpgradeClick);
  servicesList.addEventListener('click', handleUpgradeClick);

  rebootButton.addEventListener('click', () => {
    /* Recompute first so a core-gain bonus unlocked since the last paint is
       applied to this reboot rather than the next one. */
    stats = computeStats(state);
    const gain = applyReboot(state, stats.coreGainMult);
    if (gain < 1) return;

    /* Recompute AFTER the reset, before filling slots. `applyReboot` clears
       `state.upgrades`, and `contractSlots` is derived from those upgrades, so
       the pre-reboot stats would fill one slot too many -- more contracts than
       the new run can hold, until the next recompute. The core-gain figure
       above is the one term that has to come from the OLD stats. */
    stats = computeStats(state);

    /* Contracts were measured against counters that have now reset in part,
       so reissue them rather than showing a stale baseline. */
    state.contracts = [];
    fillContracts(state, stats.contractSlots);
    contractSignature = null;
    upgradeSignature = null;
    carry.deploy = 0;
    carry.buy = 0;

    refresh();
    announce(
      `Rebooted. Gained ${gain} ${gain === 1 ? 'core' : 'cores'}, ${
        state.cores
      } in total.`,
    );
  });

  /* ------------------------------------------------------------------
     Offline summary
     ------------------------------------------------------------------ */

  offlineDismiss.addEventListener('click', () => {
    offlineBanner.hidden = true;
  });

  function checkOffline(): boolean {
    const result = applyOffline(state, stats, Date.now());
    if (result === null) return false;

    /* Short gaps are credited silently: the player just refreshed the page
       and does not need to be told about a fraction of a second. */
    if (result.elapsedMs < OFFLINE_BANNER_MIN_MS) return false;

    const efficiency = formatPercent(stats.offlineEfficiency);
    offlineText.replaceChildren();

    /* Built as data first, so the visible banner and the announcement cannot
       say different things. Only mention the cap or the efficiency when they
       actually reduced the credit. */
    const durationText = formatDuration(result.elapsedMs);
    const wasCapped = result.creditedMs < result.elapsedMs;
    const noteText =
      wasCapped || stats.offlineEfficiency < 1
        ? wasCapped
          ? ` (credited ${formatDuration(result.creditedMs)} at ${efficiency} efficiency)`
          : ` (at ${efficiency} efficiency)`
        : '';

    const lead = document.createTextNode('While you were away for ');
    const duration = document.createElement('strong');
    duration.textContent = durationText;
    const middle = document.createTextNode(
      `, your fleet produced ${formatNumber(result.earned)} compute`,
    );

    offlineText.append(lead, duration, middle);

    if (noteText !== '') {
      const note = document.createElement('span');
      note.textContent = noteText;
      offlineText.append(note);
    }

    offlineText.append(document.createTextNode('.'));

    offlineBanner.hidden = false;

    /*
     * The banner is NOT the accessible channel. It is unhidden rather than
     * inserted, and it carries no live region, so nothing about it is spoken --
     * a player using a screen reader would never learn they had been away, and
     * away income is not a per-tick figure the throttled summary covers. The
     * offline summary is one of the discrete events the live-region contract
     * names, so it is announced explicitly.
     */
    announce(
      `While you were away for ${durationText}, your fleet produced ` +
        `${formatNumber(result.earned)} compute${noteText}.`,
    );

    return true;
  }

  /* ------------------------------------------------------------------
     Persistence
     ------------------------------------------------------------------ */

  let saveFailed = false;

  function persist(announceSuccess = false): void {
    if (!storageAvailable) return;

    /* Before writing, check whether another tab has moved further ahead and
       adopt its save instead of overwriting it. */
    const newer = loadIfNewer(state);
    if (newer !== null && newer.lastSavedAt > state.lastSavedAt) {
      state = newer;
      stats = computeStats(state);
      contractSignature = null;
      upgradeSignature = null;
      announce('Loaded newer progress saved by another tab.');
      render();
      return;
    }

    const ok = saveState(state);
    if (ok) {
      if (saveFailed) {
        saveFailed = false;
        statusEl.hidden = true;
      }
      if (announceSuccess) announce('Progress saved.');
    } else if (!saveFailed) {
      /* Only warn once, not on every autosave. */
      saveFailed = true;
      showStatus(
        'Progress could not be saved — browser storage is full or blocked. The game is still playable, but progress may be lost when this tab closes.',
      );
      announce('Warning: progress could not be saved.');
    }
  }

  saveNowBtn.addEventListener('click', () => persist(true));

  /* Two-step confirm instead of window.confirm, so the consequence is stated
     in the page and the control stays keyboard- and screen-reader-friendly. */
  let resetArmed = false;
  let resetTimer = 0;

  function disarmReset(): void {
    resetArmed = false;
    window.clearTimeout(resetTimer);
    resetBtn.textContent = 'Reset progress';
    setAttr(resetBtn, 'aria-label', 'Reset all progress');
  }

  resetBtn.addEventListener('click', () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = 'Confirm reset';
      setAttr(
        resetBtn,
        'aria-label',
        'Confirm reset. This permanently deletes all progress.',
      );
      announce('Press again to confirm resetting all progress.');
      resetTimer = window.setTimeout(disarmReset, 6000);
      return;
    }

    disarmReset();
    clearSave();
    state = initialState(Date.now());
    fillContracts(state, CONTRACTS.active);
    stats = computeStats(state);
    carry.deploy = 0;
    carry.buy = 0;
    contractSignature = null;
    upgradeSignature = null;
    /* Everything is locked again, so forget the seen set and drop any flash
       still attached to a card. */
    seenUnlocked.clear();
    for (const row of achievementRows) row.root.classList.remove('is-new');
    offlineBanner.hidden = true;
    statusEl.hidden = true;
    refresh();
    announce('All progress has been reset.');
  });

  window.setInterval(() => persist(), SAVE_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persist();
    } else {
      /* Returning to the tab is treated exactly like returning to the site:
         credit the away time from the last save. The frame clock is reset so
         the loop does not see a huge delta. */
      lastFrame = performance.now();
      accum = 0;
      carry.deploy = 0;
      carry.buy = 0;
      checkOffline();
      refresh();
    }
  });

  window.addEventListener('pagehide', () => persist());

  /* Another tab writing a newer save means this tab is behind. Warn rather
     than silently continuing on a stale branch. */
  if (storageAvailable) {
    window.addEventListener('storage', (event) => {
      if (event.key === 'cv.idle.save.v1' && event.newValue !== null) {
        const owner = currentTabOwner();
        if (owner !== null && owner !== TAB_ID) {
          showStatus(
            'Another tab is also playing and has saved more recent progress. Reload this tab to continue from there, or your progress here may be overwritten.',
          );
        }
      }
    });
  }

  /* ------------------------------------------------------------------
     Render
     ------------------------------------------------------------------ */

  /** Repaint every ability card from its derived status. */
  function renderAbilities(): void {
    for (const row of abilityRows) {
      const status: AbilityStatus | undefined = stats.abilities[row.def.id];
      if (status === undefined) continue;

      row.root.classList.toggle('ability--locked', !status.available);
      row.root.classList.toggle('ability--ready', status.ready);
      row.root.classList.toggle('is-active', status.active);

      if (!status.available) {
        setText(row.stateEl, 'Locked');
        setText(row.timer, 'Unlocked by an achievement');
        row.bar.style.width = '0%';
      } else if (status.active) {
        const total = Math.max(1, status.durationMs);
        setText(row.stateEl, 'Active');
        setText(
          row.timer,
          `${formatDuration(status.activeMs)} left at ${formatNumber(
            status.multiplier,
          )}x`,
        );
        row.bar.style.width = `${((status.activeMs / total) * 100).toFixed(1)}%`;
      } else if (status.ready) {
        setText(row.stateEl, 'Ready');
        setText(row.timer, row.def.summary);
        row.bar.style.width = '100%';
      } else {
        const total = Math.max(1, status.cooldownTotalMs);
        setText(row.stateEl, 'Cooling');
        setText(row.timer, `Ready in ${formatDuration(status.cooldownMs)}`);
        /* Fills as the cooldown elapses, so "nearly ready" is visible. */
        row.bar.style.width = `${(
          (1 - status.cooldownMs / total) *
          100
        ).toFixed(1)}%`;
      }

      row.button.disabled = !status.ready;
      setText(
        row.button,
        !status.available ? 'Locked' : status.active ? 'Running' : 'Engage',
      );
      setAttr(
        row.button,
        'aria-label',
        !status.available
          ? `${row.def.name} is locked, unlocked by an achievement`
          : status.active
            ? `${row.def.name} active, ${formatDuration(status.activeMs)} remaining`
            : status.ready
              ? `Activate ${row.def.name}. ${row.def.summary}`
              : `${row.def.name} cooling down, ready in ${formatDuration(
                  status.cooldownMs,
                )}`,
      );
    }
  }

  /**
   * Refresh the per-tab badges.
   *
   * Only counts that the player can act on get an alert tint: a completed
   * contract, an affordable upgrade, a ready ability. Each badge also names
   * itself in the tab's accessible name, so the number is never the only
   * way to learn what is waiting.
   */
  function renderTabBadges(): void {
    const claimable = contractViews(state).filter((view) => view.complete).length;
    /*
     * Only the shop's own upgrades are counted. Tier upgrades live in the
     * Services tab, so including them would show a badge pointing at a tab
     * where the thing it counts is not listed.
     *
     * Affordability is asked of `canAffordUpgrade` rather than compared by
     * hand, so the badge and the button can never disagree about the price or
     * the balance.
     */
    const affordable = visibleUpgradeList.filter(
      (upgrade) => !isTierUpgrade(upgrade) && canAffordUpgrade(state, upgrade.id),
    ).length;
    const cores = prestigeCores(state, stats.coreGainMult);

    const values: Record<TabId, { badge: string; label: string; alert: boolean }> = {
      services: {
        badge: formatNumber(stats.totalServices),
        label: `${formatNumber(stats.totalServices)} services deployed`,
        alert: false,
      },
      contracts: {
        badge: claimable > 0 ? String(claimable) : '',
        label: `${claimable} contract${claimable === 1 ? '' : 's'} complete`,
        alert: true,
      },
      upgrades: {
        badge: affordable > 0 ? String(affordable) : '',
        label: `${affordable} upgrade${affordable === 1 ? '' : 's'} affordable`,
        alert: true,
      },
      achievements: {
        badge: `${state.achievements.length}/${ACHIEVEMENTS.length}`,
        label: `${state.achievements.length} of ${ACHIEVEMENTS.length} unlocked`,
        alert: false,
      },
      reboot: {
        badge: cores >= 1 ? 'Ready' : '',
        label:
          cores >= 1
            ? `Reboot for ${formatNumber(cores)} ${cores === 1 ? 'core' : 'cores'}`
            : 'Not ready to reboot',
        alert: true,
      },
    };

    for (const tab of tabEntries) {
      const value = values[tab.id];
      const show = value.badge !== '';

      tab.badge.hidden = !show;
      setText(tab.badge, value.badge);
      tab.badge.classList.toggle('game-tab__badge--alert', show && value.alert);
      /* The badge is a bare number, so the tab's accessible name states what
         it counts. Abilities are not included: they live in the HUD, which
         is visible from every tab. */
      setAttr(tab.button, 'aria-label', `${tab.label}. ${value.label}.`);
    }
  }

  /**
   * Paint the shard balance, and flash a badge whenever it rises.
   *
   * The flash is driven by comparing against the last painted value rather
   * than by each source announcing itself: shards arrive from contracts and
   * milestones, and threading a callback through both would mean two chances
   * to forget one. Watching the stock catches every source including any
   * added later.
   */
  function renderShards(): void {
    setText(shardsEl, formatNumber(state.shards));
    /* What the balance is PRODUCING, stated beside it. The reserve is the one
       bonus the player cannot read off the number it comes from, and it is
       the whole reason holding shards is now a choice rather than a leftover. */
    setText(shardsNoteEl, heldShardsNote(state, stats));

    const delta = state.shards - lastShards;
    lastShards = state.shards;
    if (delta <= 0) return;

    setText(shardsGainEl, `+${formatNumber(delta)}`);
    /* Removing the class first restarts the animation on a second gain that
       lands before the first has finished, so rapid unlocks still read. */
    shardsGainEl.classList.remove('is-gained');
    void shardsGainEl.offsetWidth;
    shardsGainEl.classList.add('is-gained');

    window.clearTimeout(shardsGainTimer);
    shardsGainTimer = window.setTimeout(() => {
      shardsGainEl.classList.remove('is-gained');
    }, SHARD_GAIN_MS);
  }

  function render(): void {
    /* Reconciled here rather than only on explicit refresh: upgrades are
       revealed by crossing thresholds, which can happen from passive
       progress alone, so the list must be checked on every paint. The
       signature comparison inside makes this a no-op when nothing changed. */
    rebuildUpgrades();
    rebuildContracts();
    refreshBreakdown();

    const perSecond = stats.perSecond;

    setText(computeEl, formatNumber(state.compute));
    setText(perSecondEl, `${formatRate(perSecond)}/s`);
    setText(perClickEl, formatNumber(stats.clickPower));
    setText(coresEl, formatNumber(state.cores));
    setText(coresNoteEl, heldCoresNote(state, stats));
    setText(multEl, formatMultiplier(stats.globalMult));
    /*
     * A PERCENTAGE, not a factor, and this is the ONE chip where that is right.
     *
     * `achievementMult` is `1 + mods.globalBonus` -- the total of an ADDITIVE
     * pool, exactly like the `+25%` chips on the achievement cards that feed it.
     * Showing it as `1.24x` put the total in a different MODE from the numbers
     * that produced it, and a factor reads badly near 1: `1.24x` scans as
     * "basically nothing" when the truth is +24%, so the factor form UNDERSELLS
     * every achievement earned.
     *
     * The other chips stay factors because the rule runs the other way:
     * percentages read better near 1, factors read better FAR from it, and each
     * chip is judged on where its values live. `coreMult` and `shardFactor`
     * grow without bound and `globalMult` is the mixed product
     * `(1 + additives) x multiplicatives`; `+299021022900%` is far less readable
     * than `2990210x`. Do NOT unify them into one form.
     *
     * This was a hand-rolled `toFixed(3)` once, which printed "1.237x" into a
     * column of "1.00x": a different PRECISION reads as a different kind of
     * number.
     */
    setText(achievementMultEl, `+${formatPercent(stats.achievementMult - 1)}`);
    setText(autoDeployEl, `${formatRate(stats.autoDeployRate)}/s`);
    renderShards();
    /* The shard balance is repainted every render rather than inside
       rebuildUpgrades(), because it moves on every tick while the upgrade
       list only changes when the visible set does. No income multiplier is
       shown: income is flat, so there is no rate to report. */
    setText(upgradesShards, `${formatNumber(state.shards)} shards`);

    setText(deployValue, `+${formatNumber(stats.clickPower)} compute`);
    setText(servicesTotal, `${formatNumber(stats.totalServices)} deployed`);

    /* Abilities ------------------------------------------------------ */
    renderAbilities();
    renderTabBadges();

    /* Services ------------------------------------------------------- */
    for (const row of serviceRows) {
      const ownedCount = state.services[row.def.id] ?? 0;
      const output = stats.perService[row.def.id] ?? 0;
      const inService = ownedCount > 0;

      /* The row rail, medallion and output all use the tier hue. The badge
         beside the name says the same thing in words, so nothing depends on
         colour.

         There is deliberately no `service__icon--active` toggle: the glyph is
         inside `.medal`, and `.medal svg { color: inherit }` outranks a bare
         icon class, so such a class could never paint. `medal--quiet` is the
         idle/active switch for the glyph, in one place. */
      row.medal.classList.toggle('medal--quiet', !inService);
      row.ownedBadge.classList.toggle('service__owned--active', inService);
      row.root.classList.toggle('service--active', inService);
      /* An idle tier must not show its zero in the tier's hue, which would
         read as though it were producing. */
      row.output.classList.toggle('service__output-value--idle', !inService);
      setText(row.ownedBadge, inService ? 'Active' : 'Not deployed');

      setText(row.owned, formatNumber(ownedCount));
      setText(row.output, inService ? `${formatRate(output)}/s` : '0/s');
      setText(
        row.share,
        perSecond > 0 ? formatPercent(output / perSecond) : '0%',
      );

      /*
       * Milestones, stated concretely.
       *
       * The multiplier is shown ALWAYS, not only on the exact unit where a
       * step lands. It used to be hidden behind "N to go" for 24 of every 25
       * units, so the one number that explains the tier's output appeared
       * never and looked like it came from nowhere when it did.
       *
       * Beside it: how many steps are banked, and the multiplier the NEXT
       * threshold buys. Steps are the intuitive figure -- the multiplier is a
       * power of 2 scaled by `1 + bonus`, so a bonus makes it 36x, which is
       * correct and unreadable. "4 steps" needs no maths, and "next 57.67x at
       * 50" says exactly what deepening earns.
       *
       * `milestoneWindow` reports the real next boundary rather than the next
       * multiple of 25, which matters once a `milestoneStep` upgrade has
       * made the cadence uneven.
       */
      const step = stats.milestoneStep[row.def.id] ?? MILESTONE.step;
      const bonus = stats.milestoneBonusPerService[row.def.id] ?? 0;
      const window = milestoneWindow(ownedCount, step);
      const nextMult = milestoneMultiplier(window.nextAt, bonus, step);

      setText(row.milestone, formatMultiplier(stats.milestoneMult[row.def.id]));
      setText(
        row.milestoneSteps,
        `${window.steps} ${window.steps === 1 ? 'step' : 'steps'} · next ${formatMultiplier(
          nextMult,
        )} at ${formatNumber(window.nextAt)}`,
      );
      /*
       * The reward the NEXT crossing pays, at the player's CURRENT multiplier.
       *
       * The effective figure rather than the base one, because `shardMult`
       * moves this by more than an order of magnitude over a run and the base
       * rate would be a promise the game does not keep. It is the same number
       * the award actually pays, read from the same two inputs.
       *
       * The payout is TIER-AWARE now -- a deeper tier and a deeper step both
       * pay more -- so the figure comes from `milestoneStepPayout` rather than
       * from `SHARDS.perMilestone`. Printing the flat rate would understate
       * every tier except Worker, and would understate them by more the further
       * the player has climbed, which is the direction that reads as a bug.
       * `window.steps` is the next crossing's step ordinal, so this states what
       * THAT boundary pays rather than what the last one did.
       */
      const tierIndex = SERVICES.findIndex((s) => s.id === row.def.id);
      setText(
        row.milestoneShard,
        `+${formatNumber(
          milestoneStepPayout(tierIndex, window.steps) * stats.shardMult,
        )} per step`,
      );

      /* The pips fill between the two real boundaries, so they cannot
         disagree with the figures printed beside them. */
      const span = Math.max(1, window.nextAt - window.prevAt);
      const into = Math.max(0, Math.min(span, ownedCount - window.prevAt));
      const filled = Math.min(5, Math.ceil((into / span) * 5));
      row.pips.forEach((pip, index) => {
        pip.classList.toggle('service__pip--on', inService && index < filled);
      });

      const { count, cost } = quoteBuyWith(
        row.def,
        ownedCount,
        quantity,
        state.compute,
        stats,
      );
      const affordable = count > 0 && cost <= state.compute;

      if (quantity === 'max') {
        setText(row.button, count > 0 ? `Buy ${formatNumber(count)}` : 'Buy max');
        setText(
          row.costText,
          count > 0
            ? `Cost ${formatNumber(cost)}`
            : `Cost ${formatNumber(
                scaledCost(
                  row.def.baseCost * Math.pow(row.def.costGrowth, ownedCount),
                  stats,
                ),
              )}`,
        );
      } else {
        setText(row.button, `Buy ${quantity}`);
        setText(row.costText, `Cost ${formatNumber(cost)}`);
      }

      /* Real `disabled` rather than a visual-only state, so the control is
         correctly reported and skipped by keyboard navigation. */
      row.button.disabled = !affordable;
      setAttr(
        row.button,
        'aria-label',
        `Buy ${count > 0 ? count : quantity} ${row.def.name}${
          count > 0 ? ` for ${formatNumber(cost)} compute` : ''
        }`,
      );
    }

    /* Contracts ------------------------------------------------------ */
    const views = contractViews(state);
    /*
     * The readout explains an EMPTY SLOT.
     *
     * Objectives are fixed numbers now, so how fast the panel pays is bounded
     * by the offer cadence (`CONTRACTS.offerMs`) rather than by the work -- see
     * that constant. The visible consequence is a panel holding fewer cards
     * than it has slots, and a player who is not told why reads that as the
     * feature being broken. So while a slot is open and the budget is spent,
     * the line counts down to the next arrival instead of stating capacity.
     *
     * It replaces "each pays what it costs", which was TRUE when the objective
     * was sized from the work and became a false claim about the payout the
     * moment the sizes were fixed.
     */
    const nextIn = msUntilNextContract(state, stats.contractSlots);
    const cadence =
      views.length < stats.contractSlots && nextIn > 0
        ? `next contract in ${formatDuration(nextIn)}`
        : `${stats.contractSlots} at a time`;
    setText(contractsCount, `${state.contractsCompleted} completed · ${cadence}`);

    for (const view of views) {
      const nodes = contractNodes.get(view.def.id);
      if (nodes === undefined) continue;

      const ratio = view.target > 0 ? Math.min(1, view.current / view.target) : 0;
      nodes.bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      setText(nodes.objective, contractObjective(view.target, view.def));
      setText(
        nodes.text,
        view.complete
          ? 'Complete'
          : `${formatNumber(view.current)} / ${formatNumber(view.target)}`,
      );
      /* Shown up front, so the payout is known before committing to it.
         Scaled by the CONTRACT's own cost, not a flat figure -- a longer
         objective is a bigger payout, and the card states which it is.

         The shard payout is stated alongside the compute, because it is the
         only part of the reward the player cannot see anywhere else: compute
         lands in the HUD, but shards from a contract were being paid silently.
         It is scaled by the same `shardMult` the engine charges with, so the
         figure shown is the figure paid. Each figure is written into its own
         currency-hued span. */
      setText(
        nodes.rewardCompute,
        `${formatNumber(contractReward(stats, view.def))} compute`,
      );
      setText(
        nodes.rewardShards,
        `${formatNumber(Math.round(shardPayout(view.def) * stats.shardMult))} shards`,
      );

      /*
       * Show only the currencies this contract actually pays.
       *
       * The reward kind is a property of the DEFINITION, so it is read from
       * `shardPayout`/`contractReward` rather than from `def.reward` directly:
       * those are the functions that decide, and a second reading of the same
       * rule is how the card and the engine come to disagree.
       */
      const paysCompute = contractReward(stats, view.def) > 0;
      const paysShards = shardPayout(view.def) > 0;
      nodes.rewardComputeWrap.hidden = !paysCompute;
      nodes.rewardShardsWrap.hidden = !paysShards;
      /* The "+" only belongs between two things. */
      nodes.rewardPlus.hidden = !(paysCompute && paysShards);

      const li = nodes.bar.closest('.contract');
      if (li !== null) {
        li.classList.toggle('contract--complete', view.complete);
      }
    }

    /* Upgrades ------------------------------------------------------- */
    const ownedUpgrades = new Set(state.upgrades);
    /*
     * Global upgrades ONLY, and the label SAYS SO.
     *
     * The other 32 upgrades live inside the service cards, so this counter
     * cannot count them -- and the denominator comes from the content rather
     * than from the rendered list, because a progress counter is against the
     * whole ladder while "revealed" is only what the player can SEE.
     *
     * Two earlier versions were wrong in opposite directions: `x / 64` against
     * a panel that shows only the 32 shop rows (so a player who had bought
     * every global saw "32 / 64 owned" on an empty list), and a denominator
     * counted from the RENDERED ids, which made it "how many are revealed right
     * now" -- a number that grows on its own.
     *
     * Scoping the label is also what keeps it consistent with `ladder-50`,
     * which asks for all 64: a panel reading "32 / 32 owned" beside it would
     * tell the player the achievement was broken.
     */
    const globalIds = UPGRADES.filter(
      (upgrade) => upgrade.effect.serviceId === undefined,
    );
    setText(
      upgradesCount,
      `${globalIds.filter((upgrade) => ownedUpgrades.has(upgrade.id)).length} / ${globalIds.length} global owned`,
    );

    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-upgrade]')) {
      const id = button.dataset.upgrade;
      const def = UPGRADES.find((upgrade) => upgrade.id === id);
      if (def === undefined) continue;

      const affordable = canAffordUpgrade(state, def.id);
      button.disabled = !affordable;
      /* Affordability is a visual hint only: `disabled` above is what
         actually conveys it, so colour is never the sole signal. */
      button.closest('.upgrade')?.classList.toggle('upgrade--affordable', affordable);
    }

    for (const group of upgradeGroupCounts) {
      const ownedInGroup = group.ids.filter((id) => ownedUpgrades.has(id)).length;
      setText(group.countEl, `${ownedInGroup} / ${group.ids.length}`);
    }

    /* Reboot --------------------------------------------------------- */
    const rebootWindow = prestigeWindow(state, stats.coreGainMult);
    const gain = rebootWindow.gain;

    setText(rebootCurrent, formatNumber(state.cores));
    setText(rebootCurrentNote, heldCoresNote(state, stats));
    /* A leading sign because this is a DELTA, not a total. Sitting beside
       "Cores held", two bare numbers read as two balances. */
    setText(rebootGain, gain >= 1 ? `+${formatNumber(gain)}` : '0');
    /* What the Reboot would DO, not just what it pays. Stated as the extra
       production multiplier the new cores would add, because that is the
       figure that answers "should I press this" -- "325 cores" says how much
       of the currency arrives, not what the currency is worth.

       A RATIO of the multipliers before and after rather than a difference,
       because everything composes multiplicatively. Since cores are the FINAL
       multiplier this is simply `coreMult` before and after -- no shard term,
       and no dependence on the shard balance, which is why the old
       "needs shards" branch is gone. */
    const coreMultAfter = 1 + stats.coreAmplifyPer * (state.cores + gain);
    const gainFactor = stats.coreMult > 0 ? coreMultAfter / stats.coreMult : 1;
    setText(
      rebootGainNote,
      gain >= 1
        ? `→ ${formatMultiplier(gainFactor)} production`
        : `+${formatPercent(PRESTIGE.bonusPerCore)} per core`,
    );
    setText(rebootCount, formatNumber(state.reboots));
    setText(rebootNext, formatPrice(rebootWindow.nextAt));

    /* How far this run is towards the NEXT core, not towards a fixed
       threshold. Cores scale with the square root of the run, so the span
       between boundaries widens sharply -- the 2nd core needs 4x the
       threshold and the 10th needs 100x. Measuring against the threshold
       itself left the bar pinned at 100% from the first core onwards. */
    const span = rebootWindow.nextAt - rebootWindow.prevAt;
    const runRatio =
      span > 0
        ? Math.max(0, Math.min(1, (state.runEarned - rebootWindow.prevAt) / span))
        : 0;
    rebootBar.style.width = `${(runRatio * 100).toFixed(1)}%`;

    const nextCores = gain + 1;
    setText(
      rebootProgress,
      gain >= 1
        ? `${formatPercent(runRatio)} of the way to ${nextCores} cores`
        : `${formatPercent(runRatio)} of the way to the first core`,
    );

    /* Readiness is carried by a text chip as well as the accent tint, so the
       state is never signalled by colour alone. */
    rebootReady.hidden = gain < 1;
    rebootPanel.classList.toggle('reboot--ready', gain >= 1);

    rebootButton.disabled = gain < 1;
    setAttr(
      rebootButton,
      'aria-label',
      gain < 1
        ? `Reboot unavailable, ${formatPercent(runRatio)} of the way to the first core`
        : `Reboot for ${formatNumber(gain)} ${gain === 1 ? 'core' : 'cores'}`,
    );
    setText(
      rebootButton,
      gain < 1 ? 'Reboot' : `Reboot for ${formatNumber(gain)} ${gain === 1 ? 'core' : 'cores'}`,
    );

    /* Achievements --------------------------------------------------- */
    const unlockedSet = new Set(state.achievements);

    for (const row of achievementRows) {
      const def = ACHIEVEMENTS.find((a) => a.id === row.id);
      if (def === undefined) continue;

      const unlocked = unlockedSet.has(row.id);
      row.root.classList.toggle('achievement--locked', !unlocked);
      setText(row.stateEl, unlocked ? 'Unlocked' : 'Locked');

      if (unlocked) {
        setText(row.progressText, '');
        row.progressBar.style.width = '100%';
      } else {
        let current = 0;
        let target = 1;
        try {
          const p = def.progress(state, stats);
          current = p.current;
          target = p.target;
        } catch {
          /* A broken progress fn must not break the render loop. */
        }
        const ratio = target > 0 ? Math.min(1, current / target) : 0;
        row.progressBar.style.width = `${(ratio * 100).toFixed(1)}%`;
        setText(
          row.progressText,
          `${formatNumber(current)} / ${formatNumber(target)}`,
        );
      }
    }

    /* Per-theme counts, so a long list still reports progress per section. */
    for (const group of achievementGroups) {
      const unlocked = group.ids.filter((id) => unlockedSet.has(id)).length;
      setText(group.countEl, `${unlocked} / ${group.ids.length}`);
    }

    /* Once, after the rows are in their final state. */
    flagNewUnlocks(unlockedSet);

    setText(
      achievementsCount,
      `${state.achievements.length} / ${ACHIEVEMENTS.length}`,
    );
    setText(
      achievementsTiers,
      ACHIEVEMENT_RARITIES.map(
        (rarity) =>
          `${ACHIEVEMENT_COUNTS[rarity]} ${RARITY_LABELS[rarity].toLowerCase()}`,
      ).join(' · '),
    );
  }

  /** Recompute derived values, reconcile rows, then paint. */
  function refresh(): void {
    stats = computeStats(state);
    render();
  }

  /* ------------------------------------------------------------------
     Throttled screen-reader summary
     ------------------------------------------------------------------ */

  function updateSummary(): void {
    /* Never overwrite a message that was just announced: the player would
       lose it mid-sentence. */
    if (performance.now() - lastAnnounce < 4000) return;

    const parts = [
      `${formatNumber(state.compute)} compute`,
      `${formatRate(stats.perSecond)}/s`,
      `${formatNumber(stats.totalServices)} services`,
      `${state.achievements.length}/${ACHIEVEMENTS.length} achievements`,
    ];
    if (state.cores > 0) parts.push(`${formatNumber(state.cores)} cores`);

    /* Name whichever abilities are running or waiting, rather than assuming
       Overclock: the list is data-driven and grows with unlocks. */
    const active = ABILITIES.filter((def) => stats.abilities[def.id]?.active);
    const ready = ABILITIES.filter((def) => stats.abilities[def.id]?.ready);
    if (active.length > 0) {
      parts.push(`${active.map((def) => def.name).join(' and ')} active`);
    } else if (ready.length > 0) {
      parts.push(`${ready.map((def) => def.name).join(' and ')} ready`);
    }

    /* Keep the live summary short and factual: it is announced repeatedly, so
     * only the essential state stays in the sentence. */
    liveEl.textContent = `Status: ${parts.join(', ')}.`;
  }

  /* ------------------------------------------------------------------
     Main loop
     ------------------------------------------------------------------ */

  function frame(now: number): void {
    window.requestAnimationFrame(frame);

    let dt = now - lastFrame;
    lastFrame = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > MAX_FRAME_MS) dt = MAX_FRAME_MS;

    accum += dt;

    let ticked = false;
    while (accum >= TICK_MS) {
      stats = computeStats(state);
      advance(state, TICK_MS, stats);
      runAutomation(state, stats, TICK_MS, carry);
      accum -= TICK_MS;
      ticked = true;
    }

    if (ticked) {
      const unlocked = checkAchievements(state, stats);
      for (const id of unlocked) {
        const def = ACHIEVEMENTS.find((achievement) => achievement.id === id);
        if (def === undefined) continue;

        /* Call out a newly granted ability: it is the most actionable of
           the rewards and it changes what the player can do. */
        const granted: string[] = [];
        for (const reward of def.rewards) {
          if (reward.kind !== 'unlockAbility') continue;
          const ability = ABILITIES.find((a) => a.id === reward.abilityId);
          if (ability !== undefined) granted.push(ability.name);
        }

        /*
         * The toast shows the achievement's OWN icon in its OWN rarity hue,
         * because that is what the card in the panel looks like. A player who
         * is told "Achievement unlocked: Reflex" in plain text has to go and
         * find out which card that was; a gold crown glyph next to it is the
         * same mark sitting on the card they are about to scroll to.
         *
         * The rarity WORD is carried as well as the tint, and that is not
         * decoration: `content.ts` states the rule that rarity is a word as
         * well as a colour, so that it survives greyscale and colour-blind
         * reading. A notice that signalled gold by hue alone would be the one
         * place in the game that broke it.
         */
        const shownAchv = document.createElement('span');
        shownAchv.className = `toast__achv achievement--${def.rarity}`;
        const achvGlyph = createAchievementIcon(def.icon, RARITY_STROKE[def.rarity] ?? 1.5);
        achvGlyph.classList.add('toast__achv-icon');
        const achvName = document.createElement('span');
        achvName.className = 'toast__achv-name';
        achvName.textContent = def.name;
        const achvRarity = document.createElement('span');
        achvRarity.className = 'toast__achv-rarity';
        achvRarity.textContent = RARITY_LABELS[def.rarity];
        shownAchv.append(achvGlyph, achvName, achvRarity);

        const shownParts = document.createDocumentFragment();
        shownParts.append(document.createTextNode('Achievement unlocked: '));
        shownParts.append(shownAchv);
        if (granted.length > 0) {
          shownParts.append(
            document.createTextNode(` New ability: ${granted.join(', ')}.`),
          );
        }

        /* A toast, not just an announcement: this happens on its own while
           the player is looking elsewhere, so it has to be visible. */
        notify(
          granted.length > 0
            ? `Achievement unlocked: ${def.name}. New ability: ${granted.join(
                ', ',
              )}.`
            : `Achievement unlocked: ${def.name}.`,
          shownParts,
        );
      }

      /* Contracts are settled inside the tick so a completed one is paid
         promptly rather than waiting for the next user action. */
      const collected = collectContracts(state, stats);
      if (collected.count > 0) {
        const contractsWord = `${collected.count} contract${
          collected.count === 1 ? '' : 's'
        }`;
        /*
         * A currency that pays NOTHING is not mentioned at all -- neither
         * written nor spoken.
         *
         * Both halves are gated, and the gate is on zero rather than on the
         * definition's `reward` kind, because zero is the thing the player must
         * not be shown: "0 compute + 33 shards" is a sentence that spends half
         * its length saying nothing happened. The compute half used to be
         * printed unconditionally, so a shards-only contract -- where
         * `contractReward()` returns 0 by design -- read "[bolt] 0 [gem] 33".
         * The card had always hidden the zero; the toast did not, which is the
         * same rule applied in one place out of two.
         */
        const computeText = collected.reward > 0 ? formatNumber(collected.reward) : null;
        const shardText = collected.shards > 0 ? formatNumber(collected.shards) : null;
        /* A salvage strike triples one contract's shards. It is worth naming
           because it is the only randomness left in the game, and the larger
           number alone would not explain itself. */
        const strikeText =
          collected.bonuses > 0
            ? `${collected.bonuses} salvage strike${
                collected.bonuses === 1 ? '' : 's'
              }!`
            : null;

        /*
         * Spoken: plain words, with each currency NAMED. A glyph cannot be
         * heard, so dropping the noun here would leave "earning 250.3Qa 13".
         * `join(' and ')` on however many currencies remain, so one, the other
         * or both all read as a sentence -- and the degenerate case where
         * neither pays still says something rather than trailing off.
         */
        const earned = [
          computeText === null ? null : `${computeText} compute`,
          shardText === null ? null : `${shardText} shards`,
        ].filter((part): part is string => part !== null);
        const spokenParts = [
          earned.length === 0
            ? `${contractsWord} complete.`
            : `${contractsWord} complete, earning ${earned.join(' and ')}.`,
        ];
        if (strikeText !== null) spokenParts.push(strikeText);

        /*
         * Shown: the figures carry the compute bolt and the shard gem, the same
         * pair the HUD chips use, so the numbers are recognisable without being
         * read -- which is the whole point of the concept. The noun is dropped
         * here because the glyph IS the noun.
         */
        const shown = document.createDocumentFragment();
        shown.append(document.createTextNode(`${contractsWord} complete: `));
        let firstFigure = true;
        for (const [concept, text] of [
          ['compute', computeText],
          ['shards', shardText],
        ] as const) {
          if (text === null) continue;
          if (!firstFigure) shown.append(document.createTextNode(' '));
          shown.append(createConcept(concept, text));
          firstFigure = false;
        }
        if (firstFigure) {
          /* Neither currency paid: drop the colon that introduced nothing. */
          shown.textContent = `${contractsWord} complete.`;
        }
        if (strikeText !== null) {
          shown.append(document.createTextNode(` ${strikeText}`));
        }

        /* Also on its own schedule: a contract settles mid-tick, between
           two of the player's actions. */
        notify(spokenParts.join(' '), shown);
      }

      /*
       * Refill, on its own beat, for the case `collectContracts` does not
       * cover.
       *
       * Collection already calls this via `replaceContract`, so in the common
       * case the panel is topped up the moment a slot empties. But a slot is
       * ALSO left empty on purpose when the offer budget (`CONTRACTS.offerMs`)
       * is spent, and the budget refills with PLAY TIME rather than with a
       * collection -- so with nothing completing there would be no one to ask
       * for the next contract and the slot would sit empty forever, long after
       * it had been earned.
       *
       * Cheap and idempotent: it returns immediately when the panel is full or
       * the budget is spent, and it is given the tick's own `stats` so it
       * cannot disagree with the rest of the frame about the slot count.
       */
      fillContracts(state, stats.contractSlots, stats);
    }

    if (now - lastRender >= RENDER_MS) {
      lastRender = now;
      render();
    }

    if (now - lastSummary >= SUMMARY_MS) {
      lastSummary = now;
      updateSummary();
    }
  }

  /* ------------------------------------------------------------------
     Go
     ------------------------------------------------------------------ */

  /* Apply the saved tab without writing a save: opening the page is not a
     user action and must not look like one to the cross-tab guard. */
  selectTab(activeTab, false, false);

  /* Credit away-time from the previous session before the first paint, so
     the player never briefly sees a stale total. */
  checkOffline();
  refresh();
  updateSummary();
  window.requestAnimationFrame(frame);
}
