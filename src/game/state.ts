/* --------------------------------------------------------------------------
   Persistence.

   localStorage only: no backend, nothing leaves the browser. Every storage
   call is guarded, because localStorage throws outright in some privacy modes
   and can throw on quota rather than returning null.
   -------------------------------------------------------------------------- */

import {
  ABILITY_BY_ID,
  ACHIEVEMENT_BY_ID,
  CONTRACT_DEFS,
  CONTRACTS,
  SERVICE_BY_ID,
  UPGRADE_BY_ID,
} from './content';
import type {
  AbilityState,
  ContractState,
  GameState,
  LoadResult,
} from './types';

/** Versioned key, so a future schema change can coexist with old saves. */
export const SAVE_KEY = 'cv.idle.save.v1';
/**
 * Schema version of the save format. Bump it and add a `migrate()` step only
 * when the shape changes in a way `sanitize()` cannot handle -- a change that
 * TRANSFORMS a value rather than defaulting it. Renames and rescales qualify;
 * added and removed fields do not, because `sanitize()` defaults anything
 * missing and drops anything unknown.
 */
export const SAVE_VERSION = 1;
export const SAVE_INTERVAL_MS = 5000;

/**
 * The panels a save may resume on, in tablist order. Kept here as well as in
 * the markup so a hand-edited save cannot persist a tab that does not exist.
 */
export const TAB_IDS = [
  'services',
  'upgrades',
  'contracts',
  'achievements',
  'reboot',
] as const;

export type TabId = (typeof TAB_IDS)[number];

/** Where a fresh save opens. */
export const DEFAULT_TAB: TabId = 'services';

/** Guards against two tabs overwriting each other's progress. */
export const TAB_KEY = 'cv.idle.tab';

/** Unique per page load, so a tab can tell its own marker from another tab's. */
export const TAB_ID = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

/**
 * Create a seed for a brand-new game -- the only place that reads real entropy.
 * The timestamp keeps two saves created in the same millisecond apart.
 */
function newSeed(now: number): number {
  const random = Math.floor(Math.random() * 0xffffffff);
  const stamp = Math.floor(now) & 0xffffffff;
  /* >>> 0 keeps it an unsigned 32-bit integer, matching rng.ts, and the `|| 1`
     makes a zero seed impossible: zero would make the hash a fixed constant
     with no seed contribution at all. */
  return ((random ^ stamp) >>> 0) || 1;
}

export function initialState(now: number): GameState {
  return {
    v: SAVE_VERSION,
    activeTab: DEFAULT_TAB,
    compute: 0,
    runEarned: 0,
    totalEarned: 0,
    clicks: 0,
    services: {},
    upgrades: [],
    achievements: [],
    cores: 0,
    reboots: 0,
    abilities: {},
    contracts: [],
    contractsCompleted: 0,
    contractsIssued: 0,
    seed: newSeed(now),
    shards: 0,
    shardsEarned: 0,
    startedAt: now,
    lastSavedAt: now,
    playtime: 0,
    offlineReturns: 0,
    totalOfflineEarned: 0,
  };
}

/* --------------------------------------------------------------------------
   Storage access
   -------------------------------------------------------------------------- */

/**
 * Whether localStorage can actually be written to. Probed rather than
 * feature-detected, because Safari in private mode exposes localStorage and
 * then throws on setItem.
 */
export function isStorageAvailable(): boolean {
  try {
    const probe = '__cv_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Validation
   -------------------------------------------------------------------------- */

/** Finite, non-negative number, else the fallback. */
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function int(value: unknown, fallback = 0): number {
  return Math.floor(num(value, fallback));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** Coerce one ability's stored cooldown bookkeeping. */
function parseAbility(value: unknown): AbilityState {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    until: num(raw.until),
    readyAt: num(raw.readyAt),
    uses: int(raw.uses),
  };
}

/**
 * Coerce the ability map, dropping ids no longer in ABILITIES so removing an
 * ability from content.ts cannot leave a ghost entry behind.
 */
function abilityMap(value: unknown): Record<string, AbilityState> {
  const out: Record<string, AbilityState> = {};
  if (typeof value !== 'object' || value === null) return out;

  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(id in ABILITY_BY_ID)) continue;
    out[id] = parseAbility(entry);
  }

  return out;
}

/**
 * Coerce arbitrary parsed JSON into a valid state.
 *
 * Unknown ids are dropped rather than trusted, so editing the content tables
 * can never resurrect an upgrade or achievement that no longer exists.
 */
function sanitize(raw: unknown): GameState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;

  /* Read once, at the top: it fills in any missing timestamp so a save with
     no clock of its own cannot produce a negative offline interval. */
  const now = Date.now();

  const services: Record<string, number> = {};
  const rawServices = data.services;
  if (typeof rawServices === 'object' && rawServices !== null) {
    for (const [id, count] of Object.entries(rawServices as Record<string, unknown>)) {
      if (!(id in SERVICE_BY_ID)) continue;
      const owned = int(count, 0);
      if (owned > 0) services[id] = owned;
    }
  }

  const upgrades = stringArray(data.upgrades).filter((id) => id in UPGRADE_BY_ID);
  const achievements = stringArray(data.achievements).filter(
    (id) => id in ACHIEVEMENT_BY_ID,
  );

  /* Contracts are validated field by field and PRESERVED, not dropped: a
     contract is a promise already made, so re-issuing would hand the player a
     different target for work already partly done. Only a contract whose id no
     longer exists is dropped. */
  const contracts: ContractState[] = [];
  if (Array.isArray(data.contracts)) {
    for (const entry of data.contracts) {
      if (typeof entry !== 'object' || entry === null) continue;
      const slot = entry as Record<string, unknown>;
      const id = slot.id;
      if (typeof id !== 'string') continue;

      const def = CONTRACT_DEFS.find((c) => c.id === id);
      if (def === undefined) continue;
      if (contracts.some((c) => c.id === id)) continue;

      /*
       * The stored `amount` is the truth and has NO FALLBACK: the objective was
       * sized against the state at issue, which is not recorded, so nothing can
       * reconstruct it. A corrupt amount gets 1 rather than a guess -- silently
       * enlarging a goal on a corrupted save is the worse failure.
       */
      const amount = int(slot.amount, 1);

      contracts.push({
        id,
        baseline: num(slot.baseline),
        amount: Math.max(1, amount),
      });
    }
  }

  /* The ability map, dropping ids no longer in ABILITIES. */
  const abilities = abilityMap(data.abilities);

  /*
     `prestige` was this tab's id before it was renamed to match the heading on
     the panel it opens. Tab ids are PERSISTED, so without this bridge an
     existing save would silently resume on Services. It lives here rather than
     in `migrate()` because it is not a version change: no field was added,
     removed or reshaped.
  */
  const rawTab = data.activeTab === 'prestige' ? 'reboot' : data.activeTab;
  const activeTab: TabId = TAB_IDS.includes(rawTab as TabId)
    ? (rawTab as TabId)
    : DEFAULT_TAB;

  return {
    v: SAVE_VERSION,
    activeTab,
    compute: num(data.compute),
    runEarned: num(data.runEarned),
    totalEarned: num(data.totalEarned),
    clicks: int(data.clicks),
    services,
    upgrades: [...new Set(upgrades)],
    achievements: [...new Set(achievements)],
    cores: int(data.cores),
    reboots: int(data.reboots),
    abilities,
    contracts,
    contractsCompleted: int(data.contractsCompleted),
    /*
     * The offer budget's counter, defaulted from `playtime` rather than to zero.
     *
     * Zero would be the wrong default and badly so: the allowance is
     * `active + playtime / offerMs`, so a save with ten hours on it would
     * arrive holding ~650 unspent issues and dump them all on the panel in one
     * tick. Deriving the default from the same `playtime` the allowance is
     * computed from resumes the budget the save had actually accrued.
     *
     * `||` and not `??` deliberately: a stored zero is indistinguishable from a
     * missing field, and both mean "predates the budget", for which the derived
     * value is correct.
     */
    contractsIssued:
      int(data.contractsIssued) ||
      Math.floor(num(data.playtime) / CONTRACTS.offerMs),
    /* A zero seed would make every roll identical, so it is treated as
       missing and regenerated from the start time. */
    seed: int(data.seed) || newSeed(num(data.startedAt, now)),
    shards: int(data.shards),
    shardsEarned: int(data.shardsEarned),
    startedAt: num(data.startedAt, now),
    /* Never trust a future timestamp, or the first offline calculation goes
       negative and is silently discarded. */
    lastSavedAt: Math.min(num(data.lastSavedAt, now), now),
    playtime: num(data.playtime),
    offlineReturns: int(data.offlineReturns),
    totalOfflineEarned: num(data.totalOfflineEarned),
  };
}

/**
 * Upgrade a save written by an older schema, keyed on the `v` it was written
 * with. Mutates and returns the state.
 *
 * Most shape changes need no step here: `sanitize()` reads field by field,
 * defaults anything missing and filters id arrays against the content tables.
 *
 * A step IS needed for a change that must TRANSFORM a value rather than
 * default it -- a rename or a rescale -- because `sanitize()` has already
 * dropped the old field by the time this runs. A rename therefore needs the
 * raw parsed object as well as the sanitized state.
 */
function migrate(state: GameState, fromVersion: number): GameState {
  if (fromVersion === SAVE_VERSION) return state;

  /* Add steps here, in ascending order, each guarded `fromVersion < N`. */

  state.v = SAVE_VERSION;
  return state;
}

/* --------------------------------------------------------------------------
   Load and save
   -------------------------------------------------------------------------- */

export function loadState(now = Date.now()): LoadResult {
  if (!isStorageAvailable()) {
    return { state: initialState(now), status: 'unavailable' };
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SAVE_KEY);
  } catch {
    return { state: initialState(now), status: 'unavailable' };
  }

  if (raw === null) {
    return { state: initialState(now), status: 'fresh' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* Corrupt JSON must not brick the page: start clean instead. */
    return { state: initialState(now), status: 'corrupt' };
  }

  const sanitized = sanitize(parsed);
  if (sanitized === null) {
    return { state: initialState(now), status: 'corrupt' };
  }

  const fromVersion =
    typeof (parsed as { v?: unknown }).v === 'number'
      ? ((parsed as { v: number }).v as number)
      : 0;

  return {
    state: migrate(sanitized, fromVersion),
    status: 'loaded',
  };
}

/** Returns false when the write failed, so the UI can say so. */
export function saveState(state: GameState, now = Date.now()): boolean {
  state.lastSavedAt = now;
  state.v = SAVE_VERSION;

  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Cross-tab protection

   Two tabs share one localStorage key, so an idle background tab can silently
   overwrite a newer save from the tab the player is actually using. The tab
   marker plus the save's timestamp lets a tab detect that someone else wrote
   more recently, and refuse to clobber it.
   -------------------------------------------------------------------------- */

/** Record this tab as the active writer. */
export function claimTab(): void {
  try {
    window.localStorage.setItem(TAB_KEY, TAB_ID);
  } catch {
    /* Non-fatal: without the marker we simply lose the conflict warning. */
  }
}

export function currentTabOwner(): string | null {
  try {
    return window.localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

/**
 * When the stored save is newer than the state this tab is running, another
 * tab has progressed further. Reading it back is the least destructive
 * option: it means a background tab adopts the active tab's progress rather
 * than overwriting it.
 */
export function loadIfNewer(state: GameState): GameState | null {
  if (!isStorageAvailable()) return null;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const stored = sanitize(parsed);
  if (stored === null) return null;

  /* Allow a small skew so ordinary autosaves do not trigger constant reloads. */
  if (stored.lastSavedAt <= state.lastSavedAt + 1000) return null;
  return stored;
}

export function clearSave(): boolean {
  try {
    window.localStorage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}
