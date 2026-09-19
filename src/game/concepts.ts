/* --------------------------------------------------------------------------
   Concepts

   Anything the game can NAME as a quantity -- a currency, a rate, a stat --
   gets one identity: a glyph from `icons.ts` and a hue from the `.concept--*`
   classes in `game.css`.

   THE RULE: if a NUMBER is attributed to a concept, that mention carries the
   concept's glyph and hue. Prose does not. The `label` states the concept in a
   chip's accessible name, so the glyph is never the only signal.

   Centralised because the identity was previously decided per call site, so no
   mention was recognisable as anything.
   -------------------------------------------------------------------------- */

export type ConceptId =
  | 'compute'
  | 'production'
  | 'deploy'
  | 'cores'
  | 'multiplier'
  | 'achievements'
  | 'shards'
  /**
   * What shards you are HOLDING produce. A stock rather than a flow, which is
   * why it is its own concept: `shards` means the currency you earn and spend,
   * this means the balance you have NOT spent.
   */
  | 'reserve'
  | 'reboots'
  | 'fleet'
  | 'contract'
  | 'away';

export interface ConceptDef {
  /** Key into `GLYPH_MARKUP` in icons.ts. */
  icon: string;
  /** Singular noun, for building an accessible name. */
  label: string;
}

export const CONCEPTS: Record<ConceptId, ConceptDef> = {
  /** Spent on services. A bolt, matching the compute stat chip. */
  compute: { icon: 'bolt', label: 'compute' },
  /** The passive rate itself. Rising bars. */
  production: { icon: 'chart', label: 'production' },
  /** A manual click. The deploy arrow. */
  deploy: { icon: 'deploy', label: 'deploy' },
  /** Earned by rebooting, permanent. A processor package. */
  cores: { icon: 'cpu', label: 'cores' },
  /** The global output multiplier. Stacked planes. */
  multiplier: { icon: 'layers', label: 'multiplier' },
  /** The achievement bonus line. A crown. */
  achievements: { icon: 'crown', label: 'achievements' },
  /** Spent on upgrades. A payment card. */
  shards: { icon: 'shard', label: 'shards' },
  /**
   * The held-shard balance. A strongbox.
   *
   * Shares the shard hue rather than getting one of its own: the reserve IS
   * the shard economy from the holding side, so a seventh blue-green would
   * claim a distinction that does not exist. The glyph tells the two apart.
   */
  reserve: { icon: 'reserve', label: 'reserve' },
  /** The prestige action count. A shield. */
  reboots: { icon: 'shield', label: 'reboots' },
  /**
   * Units deployed across every tier. A rack.
   *
   * Its own concept, not a caption on the compute chip: it is the number every
   * reveal gate is measured against (the per-tier upgrades at 10/25/50/100
   * units, and the late globals), so the player ACTS on it.
   */
  fleet: { icon: 'server', label: 'fleet' },
  /**
   * A contract: the work, what it pays, and how many run at once. A ledger.
   *
   * The closed book, not the concentric rings -- rings mean "a goal", which is
   * what `target` draws for the milestone achievements.
   */
  contract: { icon: 'ledger', label: 'contract' },
  /**
   * Time away from the tab, and what is earned during it. A clock.
   *
   * Distinct from `production` even though away earnings arrive as compute: the
   * input the player controls is TIME, and every away figure is stated in hours
   * or in returns. Sharing the production glyph made a cap row read as an
   * output row.
   */
  away: { icon: 'clock', label: 'away time' },
};
