/* --------------------------------------------------------------------------
   Seeded randomness. Every random outcome in the game comes through here.

   Stateless and salted: `roll(seed, salt)` is a pure function of a stored seed
   plus a salt, so there is no PRNG cursor to persist or desync, and a reload
   cannot re-roll anything.

   Nothing here calls Math.random. The one real seed is generated in state.ts;
   every later seed comes from `deriveSeed()`.
   -------------------------------------------------------------------------- */

/** FNV-1a. Chosen for being short, fast and dependency-free. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 2^32, the width of the hash output. */
const UINT32 = 0x100000000;

/**
 * Avalanche a 32-bit integer so neighbouring inputs produce unrelated outputs.
 * Without it, a one-character salt change would differ by a single bit.
 */
function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash a seed and salt into an unsigned 32-bit integer. The seed is mixed
 * first so seed 0 is not a degenerate case. */
export function hash32(seed: number, salt: string): number {
  let h = mix32(Math.floor(seed) | 0) ^ FNV_OFFSET;

  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }

  return mix32(h);
}

/** A value in [0, 1). The base primitive every other helper builds on. */
export function roll(seed: number, salt: string): number {
  return hash32(seed, salt) / UINT32;
}

/**
 * An integer in [min, max], inclusive. `Math.round` is deliberately avoided:
 * it would make the two end values half as likely as the middle ones.
 */
export function rollInt(
  seed: number,
  salt: string,
  min: number,
  max: number,
): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi < lo) return lo;

  const span = hi - lo + 1;
  return lo + Math.min(span - 1, Math.floor(roll(seed, salt) * span));
}

/** True with probability `chance`, clamped to [0, 1]. */
export function rollChance(seed: number, salt: string, chance: number): boolean {
  if (!Number.isFinite(chance) || chance <= 0) return false;
  if (chance >= 1) return true;
  return roll(seed, salt) < chance;
}

/**
 * One element, chosen in proportion to `weight`. Non-finite or non-positive
 * weights are skipped, so a mis-authored table degrades to "less likely"
 * rather than NaN. Null when nothing is eligible.
 */
export function weightedPick<T>(
  seed: number,
  salt: string,
  items: readonly T[],
  weight: (item: T) => number,
): T | null {
  let total = 0;
  for (const item of items) {
    const w = weight(item);
    if (Number.isFinite(w) && w > 0) total += w;
  }
  if (total <= 0) return null;

  let target = roll(seed, salt) * total;
  for (const item of items) {
    const w = weight(item);
    if (!Number.isFinite(w) || w <= 0) continue;
    target -= w;
    if (target < 0) return item;
  }

  /* Only reachable through floating-point drift: fall back to the last
     eligible entry rather than returning null for a non-empty list. */
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    const w = weight(item);
    if (Number.isFinite(w) && w > 0) return item;
  }

  return null;
}
