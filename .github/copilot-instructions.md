# Deploykorn — agent context

This file is read automatically by Copilot/agent tooling in this repo. It
captures the decisions and constraints that are not obvious from the code.

Canonical deeper notes: [`docs/DECISIONS.md`](../docs/DECISIONS.md).

---

## What this is

An idle/incremental game about deploying services, scaling a fleet and
rebooting for permanent cores. Static Astro 7 + TypeScript + plain CSS.

It is a standalone project, split out of a combined CV + portfolio site so it
could be developed and deployed independently. It deploys to
`https://tanakornon.github.io/deploykorn/`, and **the game is the root
route** (`src/pages/index.astro`).

---

## Architecture: the one rule that matters

```
src/game/engine.ts    PURE rules. No DOM, no globals, no storage.
src/game/rng.ts       Seeded randomness. Stateless and salted.
src/game/content.ts   ALL balance numbers and definitions.
src/game/state.ts     Persistence, validation, migration, cross-tab guard.
src/game/format.ts    Number/rate/duration formatting + reward labels.
src/game/concepts.ts  The identity of every named quantity: glyph + hue.
src/game/icons.ts     Line glyphs, built as SVG DOM. Owns GLYPH_MARKUP.
src/game/ui.ts        ALL DOM access. Owns the loop, tabs and rendering.
src/styles/game.css   Game styling — a PLAIN GLOBAL stylesheet.
```

**Keep `game.css` a plain global stylesheet. Do not convert it to a scoped
Astro `<style>` block.** Astro rewrites scoped selectors to
`.cls[data-astro-cid-*]`, and the game's rows are created by TypeScript, so
scoped rules would never match and the game would render unstyled. This is the
single most likely way to break this project.

**Keep `engine.ts` free of DOM.** Balance is reasoned about and tested through
this file alone. Anything that reads or writes the document belongs in `ui.ts`.

**Put every tunable number in `content.ts`.** Never hard-code a cost, rate or
threshold in the engine or the UI. Abilities and achievements are content too.

---

## Deliberate deviation: the game palette

The game uses rarity, tier and stat hues on top of the single accent. This
is intentional and was agreed with the project owner. `tokens.css` is still a
verbatim copy of the CV's, so re-merging stays a file move plus a route.

- The extra hues live in a `:root` block at the top of **`game.css`**, not in
  `tokens.css`. Do not move them into `tokens.css` — that would break the
  shared-file promise with `../cv`.
- Rarity (`--r-bronze/-silver/-gold/-mythic`), the semantic pair
  (`--ok` for ready, `--danger` for a *destructive action* such as Remove or
  Reset), the tier ramp (`--tier-1` … `--tier-8`) and the stat hues
  (`--stat-compute/-rate/-click/-cores/-mult/-achv/-fleet/-shards`) are all
  paired with text, a glyph, or a spelled-out label. **Never convey state by
  colour alone.**
- **Set these hues by class, never as an inline custom property.** A chip
  carries `game-stat--click`; a service row carries `service--tier-3`; a
  service fact carries `service__fact--share`. CSS maps the class to the
  token. An inline `style="--stat: var(--stat-click)"` looks equivalent but
  is not: an inline custom property that *references another custom
  property* does not reliably recompute when a media query changes the
  token it points at, so the print stylesheet cannot collapse those values
  and they print in their screen colours. Keeping the mapping in CSS also
  means markup names the readout, not the colour.
- **Every screen-only hue must also be collapsed in `print.css`.** Adding a
  new colour token means adding an override to the print `:root` block, or it
  prints as-is (a yellow or green figure on white paper). Three were missed and
  each failed differently, so check all three patterns for a new token:
  - **A `--stat-*` hue is not the only binding.** `--shard` is declared first
    class AND aliased by `--stat-shards`, and `.contract__reward-shards` reads
    `--shard` directly. Collapsing the stat hue alone left contract payouts
    printing cyan.
  - **A foreground paired with a collapsing background needs its own rule.**
    `--ink` is the text colour on a filled accent chip; with `--ok` collapsing
    to black the Reboot panel's ready chip became black-on-black.
  - **A wash must go `transparent`, not black.** Any `-soft` token that fills a
    block (and any `color-mix` fill, such as
    `.achievement__reward--concept`) has to be reset in the print block, or the
    fill prints as a grey box behind every unlocked row.
- **Two kinds of "on", and they are deliberately different colours.**
  - **Green (`--ok`) = ready to use right now.** A ready ability, a completed
    contract. It is a transient state that will end.
  - **Own colour = permanently held.** An owned upgrade lights up in its
    category hue (or the service's tier hue when nested); an unlocked
    achievement lights up in its rarity colour. The colour is the thing's
    identity, so owning it switches that colour *on* rather than replacing it.
  - **Dark and neutral = not held yet.** A locked achievement and an unowned
    upgrade have no fill, a faint name/state/glyph, and a muted effect badge.

  Do not use green for ownership, and do not use an own-colour for transient
  readiness. The distinction is what makes "what have I got" and "what can I
  do right now" readable without reading any text.
- An owned/unlocked thing signals it through **five** things at once: border
  (rail included), background wash, medallion, text, and its badges. Keep them
  consistent — if the rail keeps one colour while the rest of the border
  changes, it reads as a rendering bug.
- **Watch specificity when a component sets a colour for a shared class.** A
  nested selector like `.service__upgrades .upgrade` (two classes) outranks
  `.upgrade--owned` (one class), so it silently wins on whichever property it
  sets. That is why the nested rule sets only padding and font sizes, and lets
  `.upgrade` own the border colours.
- Achievement rarity washes (`--r-*-soft`) and the tinted ability chip are
  screen-only. Their fills must be dropped for print, or every unlocked row
  prints as a coloured block.

---

## Sizing: keep repeated elements identical

The UI has many small elements that repeat (badges, chips, medallions, tracks).
They must measure the same as each other, or the result reads as sloppy without
anyone being able to name what is wrong. Rules learned the hard way:

- **Never let a single-line element inherit `--lh-body`.** That is a *paragraph*
  line-height (1.65) and it adds ~8px of dead space above and below one line of
  text. Use `--lh-chip` for badges, labels, state words, timers and costs, and
  `--lh-value` for numbers. `--lh-snug` is for component names/headings.
- **One geometry per role, in one place.** All badges (achievement rarity,
  achievement reward, upgrade effect) share a single rule in the chips section;
  each component's own section sets only its colour. Two copies of a padding
  value will drift.
- **`--progress-h` for every progress rule**, so the bars cannot drift apart.
- **A glyph inside a chip must fit the chip's line box.** The icon builder
  defaults to 20px; a text-only chip is 21.8px tall, so a 20px glyph made its
  chip 26.4px. Size the glyph to the chip (`width`/`height` in CSS beats the
  SVG attributes).
- **Watch `align-content`/`align-items` defaults.** `normal` behaves as
  `stretch` in grid *and* flex, so:
  - a card in a 2–3 column grid stretches to its tallest neighbour (wanted),
  - but its **internal rows** then absorb the surplus (not wanted) — an
    achievement chip's height depended on the next card along. `align-content:
    start` on the card fixes it; `align-items: flex-start` on a wrapping flex
    row keeps chips at their own height.
- **An empty element collapses to 0 height.** The unlocked achievement hides its
  numeric label, which made its progress row 15.4px shorter than a locked
  card's. Give such a row a `min-height` derived from the label tokens.
- **The achievement card is two zones separated by space alone** — what it is
  (head + description) and what it gives (reward badges + progress). Do not add
  a hairline between them: it reads as an underline on the description, and the
  card already has a border, a rarity rail and a progress rule. The separation
  is `margin-top` on `.achievement__rewards`, which compounds with the card's
  uniform row gap.

If you change any of these, re-measure *every* instance of that role rather than
the one you were looking at.
- Do not reintroduce a blanket `.glyph { color: var(--accent) }` style rule.
  Glyphs inside a medallion inherit the medallion hue, and a rule like that
  outranks `.medal svg`, flattening every rarity tint.
- A one-shot effect (the achievement unlock flash) is a *transition*, so it is
  marked by a class added in JS and cleared on a timer, not derived from
  state. It animates an overlay's `opacity` only — never the card itself — so
  nothing moves or can overflow, and the reduced-motion block disables it
  outright rather than shortening it.

---

## Tabs

Five panels, shown **core-loop first**: Services, Upgrades, Contracts,
Achievements, Reboot.

- **The order is deliberate.** Services then Upgrades are what the player
  touches every minute; Contracts is the recurring objective; Achievements and
  Reboot are retrospective and rare. `TAB_IDS` in `state.ts` and the markup
  order must agree, and so must `.game__panel` DOM order, because print reveals
  panels in document order. A reorder is therefore a three-place edit.

- **A tab is named for the ACTION it opens, not for the pillar it belongs to.**
  The last tab is `reboot` because that is the word on the panel heading and the
  button inside it. It was called `prestige` — the genre term for the whole
  cross-run pillar — which meant clicking a tab labelled "Prestige" landed on a
  panel titled "Reboot". The pillar word still names the `prestige` ACHIEVEMENT
  group, which is a broader bucket (reboots, cores, abilities, run milestones)
  that "Reboot" would misdescribe, and the engine's `PRESTIGE` constant.
  `sanitize()` maps the old persisted `prestige` id to `reboot` so an existing
  save does not silently resume on Services.

- **Every panel stays in the DOM** and is toggled with the `hidden`
  attribute. `ui.ts` holds element references and updates rows in place, so
  removing panels from the DOM would break rendering. The one exception is
  `.game__panels` being toggled wholesale.
- `TAB_IDS` in `state.ts` is the single source of truth for the tab list;
  `sanitize()` validates `activeTab` against it.
- The pattern is a proper tablist: `role="tab"`/`role="tabpanel"`,
  `aria-selected`, `aria-controls`, roving `tabindex`, and Arrow/Home/End
  keys. Only the selected tab is in the tab order, so **do not** give every
  tab `tabindex="0"`.
- The HUD (stats, Deploy, abilities, buy quantity) sits **above** the tablist
  and is visible from every tab. Do not move it into a panel.
- **The HUD stats grid is a 2x2 pair grid plus a wallet row.** The pair grid
  holds the RATES (Per deploy, Auto-deploy, Multiplier, From achievements); the
  wallet row spans both columns below a divider and holds the two CURRENCIES
  (Shards and Cores) side by side. The split is the seam between "what you are
  producing" and "what you are holding" — a stock you spend is not a rate that
  drifts, and cores multiply what held shards produce, so the two currencies
  are one fact to compare rather than two to reconcile. Adding a chip means
  deciding which half it belongs to, not just which cell is free. The total
  fleet figure lives on the Services panel (`#services-total`) instead; it is a
  stock, not a rate.
- Save controls live inside the Reboot panel. The header's "Save" link
  (`a[href="#save-note"]`) is intercepted in `ui.ts` to switch to that tab
  first, because the anchor target is otherwise hidden.
- **The tablist scrolls horizontally; it must never wrap.** The tabs do
  not all fit at 320px. `.game__tabs` has `overflow-x: auto` and
  `.game-tab { flex: none }` for exactly this reason. Do not "fix" the
  narrow-width case by adding `flex-wrap`: wrapping makes the active tab
  jump between lines as the badge counts change, which is worse than
  scrolling. A `game-tab` may legitimately extend past the viewport edge —
  it is inside the scroller, and the document itself must still not overflow.
- `print.css` reveals every panel and hides the tablist, so a printout shows
  everything rather than only the open tab. It also hides the **controls** that
  a sheet of paper cannot use — the Deploy button, the buy-quantity selector,
  the save bar, ability buttons and every upgrade's Buy control — while KEEPING
  the reference information: the stat readouts, the service tiers, the upgrade
  lists and their shard prices. When adding a control, hide it for print; when
  adding a readout, do not. A shard price is a readout, so it stays visible.

---

## The shard economy

Two currencies, deliberately different in SHAPE rather than only in source.
Compute's income is exponential and so is its sink (services); shards' income
is objective-driven and its sink (upgrades) is a fixed ladder. Giving each
currency one income shape and one sink shape is what keeps both legible:

- **Compute buys services.** It is the run's throughput and the only thing the
  service ladder costs.
- **Shards buy upgrades.** All 64 upgrades are one-time shard purchases.
  There are **two** shard faucets, and they are deliberately different in shape:
  - **Contracts**, banded by the contract's declared cost (`SHARDS.perCost`,
    read through `shardPayout()`), so more work pays more.
  - **Milestones**, paid per step crossed from BOTH unit-grant sites
    (`buyService` and Provision) through `awardMilestoneSteps()`, and priced by
    `milestoneStepPayout()`.
  - **The milestone payout has THREE factors, not one:**

        payout = perMilestone x milestoneTierMult[tierIndex]
                            x min(stepsBanked + 1, milestoneStepMax)

    The base is `SHARDS.perMilestone` (10). The tier factor is a per-tier
    MULTIPLIER TABLE giving the eight base payouts `10 12 15 18 21 24 27 30`;
    the step factor is `x N` where N is which milestone this is on that tier, so
    the 1st pays 1x, the 2nd 2x and so on up to the cap. Both exist because a
    flat rate gave the player no reason to climb or to deepen beyond what the
    tier's own output already justified.
  - **The tier factor must be a TABLE, not a slope.** The original form was
    `1 + milestoneTierGain x tierIndex`, which is affine in the index and so has
    CONSTANT DIFFERENCES — it can express `10 13 16 19` but not `10 12 15 18`,
    whose first step is +2. `milestoneTierGain` is gone; do not reintroduce it.
  - **The `+ 1` on the step factor is the whole definition.** `stepsBanked`
    counts milestones ALREADY banked, so the first crossing on a tier arrives at
    0 — without the `+ 1` the opening milestone pays nothing.
  - **The depth term is the SAFE axis to scale on; the STEP term is the risky
    one.** Depth multiplies tiers that do not exist yet in the opening hour, so
    it cannot touch the early game — which is where the documented failure lives
    (a richer faucet buys upgrades sooner, raising production, which beats a
    rate-sized objective sooner). The step term applies to EVERY tier
    immediately, including Worker, so it is the one that moves the early game.
  - **`milestoneStepMax` is a REAL bound, not tidiness, and it is the EFFECTIVE
    multiplier rather than a rare ceiling.** A developed tier has several
    milestones banked already (one at `MATURE_UNITS` is on its 4th), so
    `min(N + 1, cap)` sits AT the cap for most of a run's steps and the faucet
    scales roughly with it. Measured, 8 seeds, changing only this cap:

        cap   avg shards/step   shards/day   milestone share   `totalEarned`
        5     79.45            483,077      54.4%             17.5s  FAIL
        2     35.95            141,830      49.1%             26.0s  pass
        (pre-change: 18.91 / 37,043 / 19.6% / 22.0s)

    At 5 the faucet ran 13x its old size, the ladder became almost free, and
    `totalEarned` fell under the 20s floor — the `perMilestone: 30` loop wearing
    a new hat. **2 is the largest cap that leaves every gate green.**
    `check:ladder` FAILS above 10 rather than trusting a comment.
  - **`awardMilestoneSteps` sums steps SEQUENTIALLY, not `crossed x payout`.**
    The step factor rises with each step, so paying against `stepsBefore` would
    underpay every boundary after the first and paying against `stepsAfter`
    would overpay the early ones.
  - **`milestoneStepsByTier()` exists because Provision grants to EVERY tier at
    once.** A fleet-wide step total cannot say which tier a boundary was crossed
    on, and the payout differs by tier, so the award needs the vector.
  - **Both faucets are multiplied by `shardMult`.** The pre-removal milestone
    faucet read `crossed * perMilestone` with no multiplier, so four upgrades
    labelled "shard income" silently did not reach it. `awardMilestoneSteps()`
    takes `shardMult` as a REQUIRED argument so a new award site cannot forget
    it.
  - **`perMilestone` is still 10 — the base, which is also what the FIRST
    Worker milestone pays.** The faucet got richer through the tier table and
    the step factor instead, and it must stay a round multiple of 10 (asserted),
    which is why the requested `10 12 15 18` ramp cannot be produced by lowering
    it to 9 for a cleaner slope. Measured, an unguarded flat 30 broke the
    contract system.
  - **The milestone faucet is ONLINE-ONLY, and that is not a bug to fix.**
    `applyOffline` credits compute and never buys units, so no boundary is
    crossed while away. Contracts remain the only offline source, which is why
    `totalEarned` objectives matter. **Never describe this as the "away
    faucet"** — that claim is what justified the original removal, and it was
    never true.
  - **The faucet feeds itself, so a buff is a change to the CONTRACT SYSTEM.**
    It pays for milestones, milestones come from units, units come from compute,
    and compute comes from upgrades that shards buy. Measured, a flat 30
    produced **7.4x** the shard total of 10, not 3x.
  - **THREE reference rates now, all with the same drift guard.**
    `referenceContractsPerHour`, `referenceMilestonesPerHour`, and
    `referencePerMilestoneStep` (the AVERAGE base payout per step, measured).
    The third exists because `check:ladder` reads `content.ts` as TEXT and
    cannot import the engine, so it cannot derive what a step pays now that the
    payout varies by tier and step. It is a MEAN, not a median, because the pace
    model multiplies it by a total step count. Its tolerance is TIGHTER (10%)
    than the two rate tolerances, because it is the mean of a deterministic
    schedule rather than a simulated rate.
  - `check:ladder` asserts `perMilestone` EXISTS, is positive and is a round
    multiple of 10, and its pace model carries both faucets. It previously
    asserted the constant was ABSENT — a "this must not exist" check has to be
    rewritten when the thing comes back. It ALSO asserts the tier table's LENGTH
    against `SERVICES`, that its first entry is 1 (or `perMilestone` is a ceiling
    rather than a floor), that it is non-decreasing, and that it is not flat.
    Both new assertions are negative-tested.
  - **`check:progression` no longer duplicates the payout formula.** It
    accumulates through the engine's own `milestoneStepPayout`, per tier. A
    second copy of a reward calculation is how a report starts disagreeing with
    the game it reports on, and this file has been bitten by that once already.
- **Shards you do NOT spend produce.** The reserve
  (`reservePerRate * sqrt(shards)`) is what stops the currency going dead
  once the finite ladder is bought out. Five rules hold it together:
  - **It is a SQUARE ROOT, and that is load-bearing.** Shards accumulate for the
    life of the save and Reboot does not clear them, so a mature balance is in
    the thousands. A linear rate would make 10,000 held worth +10,000%
    production -- more than every other multiplier combined -- which makes NEVER
    SPENDING the dominant strategy and deletes the upgrade ladder. The root is
    the cap; do not "simplify" it to a linear rate, and do not add a `cap`
    instead, because a ceiling just moves the endgame wall rather than bending
    the curve. **The linear argument was re-checked at "1% -> 0.1%"; even at a
    tenth of the rate, linear at a day-one balance (~40k shards) is +4,057%,
    which is 20x the root and still dominant against a 30,000-shard ladder.**
  - **The RATE IS NOT `SHARDS.reservePer`.** The base is only ONE of four
    additive sources, and it is the SMALLEST of them:

        reservePer 0.01  +  reserve-1 upgrade 0.03
                         +  hoard-50000 (mythic) 0.008
                         +  hoard-500  (bronze)  0.002   =  0.050

    `Stats.reservePerRate` is that sum, and the HUD chip and the `reserveBonus`
    badge BOTH report it. They used to print `SHARDS.reservePer`, which was
    wrong by several times and got worse as the player bought the bonuses — the
    same "a card must state the figure the engine applies" rule the concept and
    cost-multiplier chips follow. **Never reintroduce a card that reads the base
    rate.** The same applies to cores: `Stats.coreAmplifyPer` is the sum of
    `PRESTIGE.bonusPerCore` plus the upgrade plus two achievements, and the
    cores chip reads THAT.
  - **The two totals are now round: 0.05 (reserve) and 0.10 (core).** Both
    BASES were left alone (`reservePer` 0.01, `bonusPerCore` 0.05) at the
    project owner's request, so the rebalance was taken out of the additive
    sources. The three states a player passes through:
    | state | reserve | core |
    | fresh save | 0.01 | 0.05 |
    | rebooted, achievements only | 0.02 | 0.07 |
    | everything | 0.05 | 0.10 |
    `reserve-1` is `+0.03` on a `0.01` base, so its blurb says "four times"; it
    said "five times" until this pass, and `coreAmp-1` said "twice as much
    again" and now says "60% more" (`0.05 -> 0.08`). **A blurb states the
    multiple its numbers actually produce** — these two had to move with the
    values, and a future rename of either number needs the sentence checked.
  - **The reserve is the SHARDS' own contribution alone.** `stats.reserveBonus`
    is `rate * sqrt(shards)` with NO core term, and the HUD reports it as the
    production the shards alone grant. Cores are a separate, final multiplier
    (`coreMult`) applied to the whole fleet — see the cores section below. The
    two HUD chips therefore no longer multiply to one figure, and that is
    deliberate rather than a rounding artefact.
  - **Spending has an opportunity cost, which is the point.** P is not free:
    it costs `rate * (sqrt(S) - sqrt(S-P))`. At 100,000 held, a 10,000 purchase
    forfeits roughly +38% permanently. Any late upgrade must be worth more than
    the reserve it consumes or the top of the ladder is a trap. This is the main
    balance constraint on the late globals.
  - **Zero shards is the safe default.** `sqrt(0)` is 0, so a fresh save is
    unaffected and no special case is needed.
- **Shard income is FLAT per contract, and RAMPS through upgrades.** A
  contract's payout depends only on its `cost` band: it does not vary by the
  rarity the contract rolled, and it does not grow as more contracts are
  completed. **Do not reintroduce a rate that grows with progress** — it is a
  feedback loop (income buys output, output earns completions, completions buy
  income) and it makes the number on the contract card a lie. The ramp the
  ladder has instead is the `shardGain` upgrade line, which is a visible
  purchase with a price and a reveal gate, and reaches ×20.25 with
  `serviceShardGain` on top.
- **Upgrade prices are BANDED, from TWO tables** (`SHARDS.tierBands` for the
  per-tier ladder, keyed on the tier's depth; `SHARDS.globalBands` for the shop
  ladder, keyed on the row's position within it). Between them the list shows
  eight prices — 10, 25, 50, 100, 250, 500, 750, 1000 — so a price is something
  the player RECOGNISES rather than recomputes. Being banded rather than derived
  per row is why the flat income above does not need a growth ramp to keep up.
  Pacing ALSO comes from the REVEAL gates: an upgrade appears when the fleet has
  earned it. **Changing a band boundary reprices every row that falls into it**,
  which is why the tables are the unit of tuning rather than a single row;
  `check:ladder` asserts the capstone-vs-next-tier comparison for exactly this
  reason. `UpgradeDef.price` is the narrow escape hatch for repricing ONE row
  without moving a boundary. Do not restate either table's values from memory —
  `check:ladder` prints both.
- **The ladder is paced in HOURS, not in shards** (`SHARDS.pacing`).
  `check:ladder` converts the whole price table into hours at
  `SHARDS.pacing.referenceContractsPerHour` and fails if the run leaves its
  target band or if any single upgrade exceeds 10% of the run.
  **Never derive a bound from the thing it bounds**: an earlier `ladderBudget`
  ceiling had been set from the checker's own reported total, so it could not
  fail. **The reference rate is the same hazard one step removed**: if it drifts
  from the rate the game actually pays, the hours it produces are meaningless
  and the band passes regardless. That is why `check:progression` now FAILS
  when the measured median is more than `RATE_TOLERANCE` away from the constant
  — `check:ladder` cannot measure a contract rate at all, so the two scripts
  have to agree across the seam. `check:progression` is the pacing authority;
  this model is a consistency check.
- **`serviceShardGain` and the `shardGain` upgrades still multiply income** —
  those are purchases the player chooses, not an automatic curve, so they do
  not make the rate "non-flat".
- **The salvage strike is the ONLY randomness left in the game.** A contract
  occasionally pays triple, decided by `rollChance(state.seed,
  \`salvage:<ordinal>\`, SHARDS.bonusChance)`. It cannot be lost, only not won —
  a surprise, not a gamble — and because the salt is the contract's own
  completion ordinal, a reload cannot re-roll it. It is a bonus on top of a
  flat rate, not a variation of it.
- **Contracts pay compute derived from the DEPLOY value, and MOST objectives
  are AUTHORED, not computed.** `contractReward(stats, def)` is
  `stats.clickPower x CONTRACTS.deployMult[band] x stats.contractRewardMult`,
  so a contract pays a whole number of deploys — 10 for a quick errand, 100 for
  an epic. The OBJECTIVE is a fixed `amount` on the def and `cost` selects the
  band, so a harder contract still pays more and a card cannot be a bad deal.
  **The objective used to be computed at issue from the player's rate, and that
  was replaced because the numbers it produced were illegible.** `services` was
  sized as `unitsAffordable(cost) x growthCorrection`, which priced every unit
  at the CURRENT marginal price and so ignored the `1.15^n` cost curve —
  reported as *"contract quest still growth too fast 75 service at early game"*,
  i.e. the card asked for a number that grew while the work did not. Now
  `services` asks 1 / 5 / 10 / 25 units by band, `milestones` asks 1 step, and
  `tierUnits` takes a per-tier amount descending 25 (Worker) to 1 (Datacenter) —
  a single band table cannot serve that metric, because every tier shares
  `COST_GROWTH` while `baseCost` spans 15 to 330,000,000.
  `totalEarned` is the ONE metric still sized from the rate, because compute
  scales without limit; it is the only reader of `CONTRACTS.growthCorrection`.
  `clicks`, `upgrades`, `tierOwned` and `abilityUses` also declare `amount`.
  **Every definition needs `cost` regardless**, since BOTH payout bands
  (compute and shards) are resolved from it; a def with only an `amount` pays
  zero in both currencies, which is invisible on the card, so `check:ladder`
  asserts it.
- **A fixed objective makes the OFFER RATE the faucet, so the rate is rationed.**
  A fixed ask does not grow with the fleet, so once production is large the work
  finishes in seconds while the payout still scales — measured with no gate,
  **305 contracts an hour against the 65 the shard ladder is priced for**, with
  daily shard income up 61%. `CONTRACTS.offerMs` (55s of `playtime` per issued
  contract, plus `CONTRACTS.active` up front) bounds the rate instead of growing
  the objective, because the objective is the thing that had to stop growing.
  **The consequence to expect: late in a run the Contracts panel legitimately
  shows FEWER cards than it has slots.** That is not a bug, and the panel
  explains it — `msUntilNextContract()` drives a countdown in the readout.
  Negative-tested: `offerMs: 1` measures 265/hr and `check:progression` FAILS.
  The budget lives in `fillContracts` and the counter is `state.contractsIssued`,
  which `applyReboot` refunds by `CONTRACTS.active` (the amount `ui.ts`
  re-fills with) so a Reboot cannot farm contracts but also does not leave the
  panel empty.
- **`METRIC_RULES[metric].ready` is what makes a fixed ask make sense, and it is
  NOT `headroom`.** `headroom` asks whether the counter CAN advance; `ready`
  asks whether the def should be asked YET. For `services`, `milestones` and
  `tierUnits` the rule is `value(state, def) >= def.amount`: a contract asking
  for N more of something is offered once the player already HAS N of it. So the
  ask is always about roughly a doubling, and the deep bands surface as the
  fleet reaches them — which is what stops a fresh save being told to bring 25
  more services online while running three. `ready` returns `true` for
  `totalEarned` (rate-sized, so appropriate by construction) and for
  `clicks`/`upgrades`/`tierOwned`/`abilityUses` (amounts that do not scale with
  the fleet). **`tierOwned` is the exception that proves the rule**: it is the
  one def that asks for a tier the player does NOT have, so `ready` must NOT be
  `value >= amount` there or it could never be offered.
  Measured: this gate does NOT bound the rate on its own — the fleet plateaus
  (~2,000 units) while production compounds, so `owned >= amount` is satisfied
  long before buying the ask becomes slow. The offer cadence is what bounds it.
- **Three milestone defs became ONE, and it cost no panel variety.**
  `contractSubject()` is the metric plus the tier or ability, and every
  milestone def shares the subject `milestones:` — so `pickContract` could never
  put two of them on the panel at once. They were three sizes of one quest. The
  survivor is `deepening-3` at the `epic` band, where `amount: 1` is NOT a small
  ask: a step is `MILESTONE.step` (25) units in ONE tier, the same unit burden
  as `expansion-3`'s 25 units across the fleet.
  **Removing two compute-reward defs and adding two MATTERED to `check:ladder`**,
  because its pace model divides by the count of ALL defs while skipping
  compute-reward ones — so the count and the compute-reward count both had to
  stay equal for the pace to be unchanged. They were kept equal deliberately.
- **`clicks` is NOT a fixed-amount metric any more, and `amount` on one is now
  a bug.** Its objective is `cost x CONTRACTS.referenceClicksPerSecond`, so it
  is the one contract kind whose card is literally honest about its band (both
  sides are seconds of the same real-time activity) and its realised time
  measures 1.00x at every phase. It used to be hand-authored (`25` against a
  90-second band, i.e. six seconds of work paying for ninety), which is what let
  a run clear approaching ten contracts on ten clicks.
  **`referenceClicksPerSecond` was declared, documented and UNREAD while that
  was true** — a constant nothing reads is worse than no constant, because the
  gap it was meant to expose was itself invisible. `check:progression` derives
  the fixed-amount set from the engine's own table, so it fails a rate-sized
  metric that carries an `amount`; `check:ladder` carries a hard-coded copy of
  that same list for an earlier, better-named failure.
- **`cost` selects the PAYOUT BAND, the ASK's size, and when a def is eligible.
  It is NOT a promise of seconds.** For the fixed metrics it names the band the
  `amount` was authored against. For `totalEarned` it sizes the objective as
  `perSecond x cost x growthCorrection`, which delivers the rectangle in a small
  fraction of the band, because production compounds inside the window. No value
  of `growthCorrection` makes the realised time equal the band at every phase —
  the required factor moves by two orders of magnitude inside one run — so the
  game does not claim it does. The card shows the objective in its own units via
  `contractObjective()`, which is truthful at every scale. **Never restate `cost`
  as a duration in prose or a label.**
  `growthCorrection` was **RE-MEASURED when it became `totalEarned`'s sole
  reader**: at its old value of 12 a typical `totalEarned` contract completed in
  16.0s, under the checker's 20s floor, because the throttled contract rate had
  flattened the production curve it was calibrated against. It is 16 now, chosen
  with margin rather than at the minimum that passes (15 measured 20.0s against
  a 20s floor, which is a pass by a hair). Any later edit to `offerMs` moves it
  again — re-run `check:progression`.
  **A per-metric TABLE was the obvious next step and it was WRONG — tried three
  times, the third with a working harness.** The metrics were coupled through ONE
  loop (a contract pays compute, the shard faucet *is* the completion rate,
  shards buy the ladder, the ladder drives production, and production sized every
  objective), so changing one metric's factor moved the AGGREGATE rate, which
  moved every ratio — including the one that was changed, in the OPPOSITE
  direction. Measured: making `services` 2.3x harder (18 → 42) moved its realised
  time from 0.239 to 0.117 of its band, i.e. **cheaper**, because the change also
  pushed the rate from 84 to 159 contracts/hr. That coupling is now BROKEN for
  the three unit metrics by fixing them outright, so `growthCorrection` serves
  `totalEarned` alone.
  - **Two measurement traps were found here, and both are now fixed in
    `check:progression` — do not reintroduce them.**
    - **A completion-weighted median over a rate-terminated run is
      self-referential.** The run used to stop when `contractsCompleted` hit its
      target, so making contracts harder lowered the rate, extended the run, and
      pushed completions into later phases — feeding the tuned quantity back into
      its own unit of measurement, which made the response non-monotone
      (doubling a factor measured as *reducing* it). It now reports a
      **phase-normalised** median (`medianOfGroups`: the median of the per-phase
      medians, every phase weighted equally) and the response is monotone —
      verified by doubling the shared value, which moved all four ratios up and
      left the real-time `clicks` metric untouched at 1.0000. The
      completion-weighted figure is still printed beside it as a coherence test.
    - **`clicks` must not be a `fixedAmount` metric.** It is sized as
      `cost x CONTRACTS.referenceClicksPerSecond`, so it is a THIRD category:
      real time, but derived from `cost`. It is therefore neither exempt-by-
      `fixedAmount` nor growth-corrected, which is why the rule table carries an
      explicit `growthCorrected` flag rather than inferring it. Applying the
      correction to it would INTRODUCE the error it removes.
- **`credit()` distinguishes PRODUCED compute from compute the game handed the
  player**, and only produced compute reaches `totalEarned`. This is not tidiness:
  a contract pays compute, the payout went through `credit()`, and
  `state.totalEarned` is what the `totalEarned` metric counts — so collecting ANY
  contract advanced every open `totalEarned` contract, including itself.
  Measured, 38% of them completed in under five seconds against a band naming
  ninety. `runEarned` deliberately KEEPS the payout, because `prestigeCores`
  measures it and the engine already collects contracts before a Reboot so the
  cores are not lost; a payout is part of what the run earned, but it is not
  PRODUCTION, and `totalEarned` is a claim about production.
  The same loop still exists for the unit-denominated metrics (`services`,
  `tierUnits`, `milestones`), because compute from a payout is spent on units by
  auto-buy and units are what those metrics count. It is now bounded by the
  OFFER CADENCE rather than by `growthCorrection` (which those metrics no longer
  read at all): fewer contracts issued means less handed-out compute, which is
  what the rate limit on `CONTRACTS.offerMs` is actually throttling.
- **Do not answer an exponential quantity with a fixed number, and do not size
  an objective as a share of a STOCK.** The first rule is why exactly one metric
  is still rate-sized: unit counts PLATEAU (2,000-2,500 at 24h across seeds)
  while production compounds without bound, so a fixed unit ask stays fair all
  run and a fixed compute ask would not. The second is why "bring 20% more units
  online" was rejected: auto-buy converts compute into units continuously, so
  20% of a fleet arrives in SECONDS while the card still pays `cost` seconds for
  it. `services`, `milestones` and `tierUnits` are FIXED `amount`s now;
  `totalEarned` alone goes through production as `perSecond x cost x
  growthCorrection`.
- **`CONTRACTS.deployMult` is CALIBRATED BY SIMULATION, not derived.** The
  measured effect of the four values (10/25/50/100) is a fleet that finishes in
  **0.43h against 0.81h** on the old payback formula, with units at 24h up
  **2.6%** and upgrades at 24h flat — so it is an early-game buff that does not
  move the end state, which is the shape to want from a faucet change.
  **If contracts feel wrong, re-run `check:progression` before touching
  anything**, and re-measure after any change to service costs, milestone
  doublings, the buy rate or the CLICK tree.
- **Nothing costs both currencies.** Compute buys services; shards buy
  upgrades. If you find yourself threading a second currency through a
  purchase, stop — the split *is* the design.

### The RNG rule still applies

**A random result must be rolled once and STORED, never re-derived per tick.**
`computeStats()` runs at 10Hz and its contract is that nothing is cached across
ticks, so anything random *derived* there would re-roll ten times a second. The
salvage strike satisfies this by construction: it is a pure function of
`state.seed` and the contract's stored completion ordinal, evaluated at the one
moment the contract completes and folded into that single payout.

- `rng.ts` is **stateless and salted**: `rollChance(seed, 'salvage:7', p)` is a
  pure function of a stored integer plus a string naming what is being rolled.
  There is no PRNG cursor to persist or desync, and a reload cannot re-roll it.
- **The engine never calls `Math.random`.** One seed is generated in
  `state.ts` when a game is created — the only place allowed to touch real
  entropy — and every later seed is derived from it.
- A consequence worth keeping: **reloading cannot be used to fish for a better
  payout.** Verify after any change to the strike by completing a contract,
  reloading three times, and comparing.

### Persistence and the sanitize contract

**`sanitize()` must PRESERVE contracts, not drop them.** Now that a contract
carries a computed target, dropping one would re-issue it — and since the size
depends on the production the player had when it was drawn, the replacement
would be a different, easier goal for work already partly done. It validates
field by field and only drops a contract whose id no longer exists.

A contract also **stores** its baseline, so progress is measured from issue
rather than from zero: wording contracts as absolutes ("Bring 60 services
online") shows `0 / 60` to a player already holding 125, which reads as a bug.

`sanitize()` drops unknown ids from `services`, `upgrades`, `achievements`,
`contracts` and `abilities`, so removing a definition from `content.ts` cannot
leave a ghost entry the engine would then try to fold. A field that is no longer
read simply disappears on the next save.

### A long effect badge may wrap

`.upgrade__effect` shares its chip geometry with `.achievement__reward`
and the price chips, and that shared rule sets `white-space:
nowrap`. An effect badge can be a whole phrase ("Worker doubles every 20 · was
25"), and nowrap pushed its row past the viewport at 320px, so
`.upgrade__effect` alone overrides it to `normal`. If you add another chip
that carries a sentence, give it the same override — a chip is single-line by
default, not by necessity.

### Two labels that must not drift

- `costMult` is **not** inverted. The multiplier applies to the price, so
  1.6 IS a 60% increase and 0.75 is a 25% discount. Inverting it in the
  label turns a surcharge into a displayed discount — the worst possible
  direction for that mistake. Whatever tints a cost chip reads the same
  non-inverted value.
- `autoRate` is labelled **`X/s deploys`**, matching the shop row that grants
  the same thing (see the automation section below).
- `synergy` is a MULTIPLIER on a tier's finished synergy factor, not an
  addition to its pre-cap rate, so the percentage on the card is the actual
  gain. The additive form cannot pay for itself: a tier's synergy factor
  saturates at +50% (100 units of the tier above), so even a large additive
  bonus moved total income by a few percent.

### Automation splits into two channels, and only one may spend

`computeStats()` exposes `autoDeployRate` and `autoBuyRate`, and they are fed
from **different** sources on purpose.

Auto-**deploy** only *creates* compute, so it is fed by `autoRate` — the
generous, shareable rate granted by achievements. An achievement that says
`Auto-deploys +1.5/s` makes the game play itself, which is exactly what it
promises.

Auto-**buy** *spends* compute. Spending on the player's behalf is a different
act from earning it, so `autoBuyRate = 0` and it is raised **only** by an
explicit `autoBuy` effect — today the `auto-2`, `auto-4` and `auto-5`
upgrades. It must never be folded into `autoRate`. Doing so would mean every
achievement labelled with a deploy rate silently bought services: it would
override a player who was deliberately saving.

Corollaries:

- The label for `autoRate` is **`X/s deploys`**, matching the shop row. The
  vague word "Automation" invited exactly the reading the design forbids.
- **Auto-buy is capped at `CLICK.autoBuyBudget` of production per second.** It
  buys the cheapest affordable unit, so with no ceiling it spends compute the
  instant it arrives and the balance never rises above one cheap unit's price —
  leaving the tiers worth saving for permanently unreachable. The cap is on the
  SPEND RATE rather than the unit price, because the drain is `rate x price`.
- Automation only runs **while the tab is open** (`runAutomation()` is
  tick-driven); offline income is a separate path in `applyOffline()`.

### A deploy is not a click, and must not inherit the click tree

`computeStats()` returns **three** related but distinct numbers:

```ts
clickPower   = (CLICK.base + perSecond * (CLICK.throughputShare + clickShareAdd))
               * (1 + clickAdd) * clickMult * mods.click * clickFromTiers
autoDeployValue = perSecond * CLICK.autoDeployShare
```

An automated deploy is worth a *fixed slice of production* per second
(`autoDeployShare`), **not** `clickPower`. This is deliberate.

The click multiplier tree is **four rows totalling 120x** (x2, x3, x4, x5)
before achievements. Multiplying that tree by an `autoDeployRate` would make
the automation channel worth ~83x total production, and worse, grow with
*click* upgrades the player bought for a different reason. Two consequences:

- The auto-deploy rate (achievements) and the click multiplier (upgrades)
  are **independent axes**. Buffing one cannot silently buff the other.
- `autoDeployValue` is credited per deploy in `runAutomation()`; a deploy must
  never increment the stored `clicks` counter, which is a lifetime *manual*
  stat that achievements read.

Corollaries:

- **The share is an upgradeable axis, not a constant, and that is a fourth
  effect kind.** `throughputShare` (0.2) is the BASE; two shop rows add share
  points (+0.1 at rung 47, +0.2 at rung 63), reaching a 0.5 ceiling that the
  content hits EXACTLY — so there is no `cap` field, because a cap that cannot
  bind is a lie about a number. Those two rows are why `clickPower` reads
  `CLICK.throughputShare + clickShareAdd`.
- **`throughputShare` is NOT a second `clickAdd`, and the difference decides
  which to reach for.** `clickAdd` multiplies the finished `clickPower`,
  `CLICK.base` included, so it lifts everything the button already does.
  A share point changes the part that SCALES with the fleet, so it is worth
  almost nothing while `CLICK.base` of 1 still dominates and is a large gain
  late. Rows that want to be felt from the first minute are `clickAdd`; rows
  meant to pay off as the fleet grows are `throughputShare`.
- **A share row's badge states SECONDS, and it must.** 0.1 means a deploy is
  worth a tenth of a second of production, so 1.0 of share *is* one second —
  the unit is not a convention. It renders as `Deploys +0.1s production`.
  The click tree is what turns that into a big number, and the card
deliberately does not restate it.
- **Do not claim these are the most click-rate-sensitive rows; they are the
  least, measured.** Across 1 -> 8 clicks/s `click-1` moves 6.53 -> 9.38 per
  shard while the share pair moves 0.59 -> 0.66. A share point's gain is
  bounded by its RATIO to the share it joins (0.1 onto 0.2 is +33% of that
  term, and the ratio falls as the ladder is bought), whereas a `clickMult`
  of 2 is worth 100% of the whole click at any rate.
- Manual deploy survives late because the share tracks production. Uninvested
  it is worth `0.2 s` per click; at the 0.5 ceiling *before* the tree, `0.5 s` —
  and the tree and achievement pools multiply that into the figure actually
  shown. Do not quote a single "seconds per click" figure: it depends on the
  tree, the achievement pool and both per-tier channels.
- The `autoDeploy` upgrade label states the production share
  (`3/s deploys · +45% production`) so the value is legible without mental
  arithmetic.

---

## Achievements and abilities

- Achievements have four rarities (`bronze`/`silver`/`gold`/`mythic`), a
  theme `group`, and **an array of rewards**. Every reward applies.
- `AchievementReward` is a discriminated union. Adding a kind means adding a
  `case` in `computeModifiers()` (engine.ts), a label in
  `describeReward()` (format.ts), and nothing else.
- **A reward is ADDITIVE when a single instance is too small to read.** ~+10% is
  the floor of perception; a `globalMult` of +0.8% is not a reward, it is a
  rounding error. `AchievementReward.globalBonus` therefore carries percentage
  points and `Modifiers.globalBonus` is a **SUM** whose identity is 0, not 1 —
  do not "fix" it to 1. It becomes a multiplier in exactly one place,
  `computeStats()` (`1 + mods.globalBonus`). Every OTHER reward kind already
  pays >= +10% per instance, so it stays multiplicative; this is the one channel
  where the floor bites. `serviceMult` stays multiplicative on purpose: it
  multiplies one tier, and base output already spans x440,000 across tiers.
- **Rarity must predict the reward.** bronze +25% / silver +50% / gold +100% /
  mythic +200%, i.e. the `*_BONUS` constants. `check:ladder` asserts every
  `globalBonus` matches its rarity, that a harder entry in a chain never grants
  LESS of a reward kind than an easier one already granted, and that no
  `offlineEfficiency` value is granted twice (that fold is `Math.max`, so a
  duplicate is inert). All three are negative-tested.
- **`globalMult` exists on `UpgradeEffect` too**, with a different payload
  (`mult`). The two types are separate, so the achievement side can use
  `globalBonus` without touching upgrades.
- **`ACHIEVEMENTS` array order IS display order.** `ui.ts` does not sort the
  panel any more, so where an entry sits in `content.ts` is where the player
  sees it. Within a `group`, every `chain` must occupy **one contiguous run**,
  ordered hardest-first (rarity non-increasing). `chain` is a required field
  and is not derivable from the id prefix — `overclock-*` and `ability-*` are
  the same measurement under two stems. `scripts/check-upgrade-ladder.mjs`
  asserts the count, unique ids, run contiguity and descending rarity; if you
  add an achievement to the middle of a chain, that check will fail.
- Rarity is carried three ways: the medallion tint, the glyph stroke weight
  (`RARITY_STROKE` in icons.ts) and a spelled-out label. Keep all three.
- **Ability availability is derived, never stored.** An ability is unlocked
  when a `unlockAbility` reward is in the unlocked set, or it is `base`.
  `state.abilities` only holds cooldown bookkeeping, which is why adding an
  ability needs no save migration.
- **An ability must do something the interface CANNOT.** `AbilityKind` has two
  members and the rule applies to both: `boost` multiplies production for a
  window, and `freeUnits` grants units outright at no compute cost. Do not add
  an ability that merely automates a click — if it can be reproduced by hand,
  it is not a verb. The two boost abilities are distinguished by depth-vs-width
  (3x for 30s vs 6x for 20s), not by a different mechanic.
- **`freeUnits` grants a FLAT BUDGET, spread across every tier the player
  runs.** `def.amount` units, shared out in proportion to each tier's size with
  a floor of one unit.
  **Do not make the grant scale with the fleet.** Units are not a linear
  resource here: a tier's output is `2^floor(owned/25)` times its base, so a
  grant proportional to the fleet crosses a proportional number of milestone
  doublings. A grant of `max(25, 10% of fleet)` aimed at the cheapest tier
  would measure +122% production at 250 services, +119,367% at 2,500 and
  **+7,801,405,340%** at 6,505.
  The obvious fix is also a trap: spreading MORE units across MORE tiers
  crosses MORE boundaries, so the intuitive aim and the safe bound point in
  opposite directions. The floor of one unit is not a small grant either — on a
  tier the player owns one of, it is a whole doubling of that tier's output.
- **A contract that cannot complete must never be issued.** `metricHeadroom()`
  bounds every metric that has a ceiling (`upgrades` is the only one), and the
  size is clamped to it in `objectiveSize()`. An uncompletable
  contract does not merely sit there: it holds one of five SLOTS, and slots are
  the shard faucet.
- **A contract metric MUST advance on its own.** The objective shape captures a
  baseline at issue and counts from there, so it only means anything for a
  counter that moves while the player plays. `cores` and `reboots` are absent
  from `MetricKey` for failing exactly this: they move only during a Reboot, so
  a contract on one is a prestige-timescale objective holding a slot for a
  hundred reboots, and completing it would reset `services` — from which
  `milestones` and `upgrades` are derived — wiping the progress of seven other
  contract types mid-run. `check:ladder` asserts no metric is prestige-only.
  Note the trade for the three metrics a Reboot DOES reset (`services`,
  `milestones`, `upgrades`): those are a fresh run rather than a broken
  contract, and that is why completed work is cashed in before the reset — see
  the next bullet.
- **`applyReboot` cashes in completed contracts BEFORE measuring cores.** The
  payout is `max(600 x production, 250)` evaluated at CLAIM, so anything that
  empties production first cuts the reward to the floor — and a Reboot is
  exactly that. The compute is discarded either way (`state.compute = 0`);
  what would be lost is the CORES, since `credit()` is what feeds `runEarned`
  and `prestigeCores` measures it. Never compute `prestigeCores` before
  collecting.
- **`pickContract` has no difficulty bias.** It draws uniformly among eligible
  definitions, and that is correct rather than lazy: sizing the objective at
  issue time makes every definition the same difficulty by construction, so
  there is nothing to bias away from. A bias would have to compare raw amounts
  across metrics — which is how "1 reboot" and "10 cores" would outrank "150
  clicks".
  The salt carries the slot count (`contract-pick:<completed>:<slots>`) and that
  is load-bearing: `contractsCompleted` does not change between the slots of
  one fill, so a salt without the count reuses the SAME roll for every slot.
- `activateAbility()` takes no `stats`: free units have nothing to afford.
- Achievement reward labels are generated from the reward by
  `describeReward()`. Do not author a label next to a reward: the two drift.
- `serviceMult`, `synergy`, `milestone`, `contractReward`, `boostPower`,
  `boostDuration`, `boostCooldown`, `autoRate` and `coreGain` rewards feed
  `Stats` fields of the same purpose. If you add a reward kind, thread it
  through `computeStats()` or it will silently do nothing.

---

## Upgrades: two destinations, one reconcile

- A **tier** upgrade renders inside its own service card, in the Services
  tab. Everything else is filed into a themed group in the Upgrades tab.
  `describeEffect()` in `format.ts` derives the group, so `content.ts` never
  names one — adding an upgrade files it automatically.
- **Tier-ness is DERIVED, never listed.** An upgrade is a tier upgrade exactly
  when `describeEffect(upgrade).group === 'services'` — the same source that
  buckets shop rows. There is no `TIER_KINDS` array. *A mechanism that returns
  group `'services'` but is declared nowhere renders nowhere* — the shop has no
  `services` group, so the row is dropped silently. When adding a per-tier
  mechanism, add its group in `describeEffect()` (`format.ts`); `ui.ts` needs no
  change, and `check:ladder` asserts every group the formatter can return is one
  the UI renders. The failure mode was silent, so it needs a check, not just a
  fix.
- **`globalPerOwned` bonuses SUM, they do not multiply.**
  `perOwnedMultiplier()` adds each individually-capped bonus
  (`bonus += min(spec.cap, owned * spec.per)`). Multiplying capped bonuses makes
  a second source of the same kind worthless the moment the first saturates.
  `worker-3` (Amdahl's law) is the per-tier one at `per: 0.005`, `cap: 0.5`;
  `perOwned-1` (Fleet gravity) is the fleet-wide "every unit of every tier" one
  at a deliberately smaller rate and larger cap, and it is the only
  `globalPerOwned` that files under group `'global'` rather than `'services'`.
  Both keep the reasoning the per-tier table needs: unit counts are
  comparable between tiers (every tier shares `costGrowth: 1.15`), so a
  tier-scaled per-unit rate would make the cheap tiers' bonuses literally
  unreachable.
- **Upgrade prices come from BAND TABLES, never a per-upgrade number.**
  `upgradeCost(def)` picks the table from whether the row belongs to a tier:
  a per-tier row takes `SHARDS.tierBands[tierDepth]` (`capstone` entry if it is
  a capstone, otherwise `base`), and a shop row takes the
  `SHARDS.globalBands` entry whose `through` covers its POSITION in the shop
  ladder. Between them the list shows eight prices (10 … 1000) instead of one
  per row. `globalBands` must ascend in BOTH `through` and `cost`, and the last
  band must reach the highest shop position — otherwise the top of the list is
  silently unpriced. `npm run check:ladder` asserts all of that, plus the pace
  against `SHARDS.pacing`. Run it after touching either table, a rung, or the
  upgrade count.
  `UpgradeDef.price` overrides the bands for a single row; `check:ladder`
  asserts any override is one of the band costs, so the escape hatch cannot
  invent a price the player would not recognise.
- **The FOURTH upgrade of each tier is a CAPSTONE**, marked `capstone: true`,
  and it is why the capstone price exists. A tier's four upgrades are
  consecutive rungs, so without it they share the row's `base` price and the
  game-changer costs the same as the first purchase — and cannot out-price the
  NEXT service's opening upgrade, which is the comparison a player actually
  makes. Two things to
  preserve:
  - **The flag is explicit, not `rung % 4 === 3`.** The price rule keys off it,
    so a rung reshuffle must not silently move which upgrades are capstones.
    `check:ladder` asserts exactly eight, one per tier, each on the fourth slot
    — and that each costs more than the next tier's first upgrade. That last
    one is a comparison across two bands, so it depends on where the boundaries
    fall; do not assume it follows from the bump size.
  - **Capstone effects stay capped.** Anything count-driven that is uncapped
    inverts the ladder once a cheap tier is owned in the thousands. Worker's
    capstone is exempt: it grants full output while away, which is binary and
    has no magnitude to raise.
- **Every tier gets FOUR upgrades, and all 32 are a DISTINCT mechanism.** No
  kind repeats within a tier or across tiers, because a kind used on eight
  tiers is one purchase wearing eight names. There is no shared pair — if two
  rows would read alike, they are the same row whatever the code calls them.
  Reveals come from `SHARDS.revealAt` (10/25/50/100), one per upgrade.
- **A per-tier mechanism must scale by a UNIQUE quantity.** This is the actual
  invariant; "distinct kinds" is just how it is enforced. The rows read as
  different purchases only because one counts deployed tiers, another
  fleet-wide units, another total units owned, another contracts completed, and
  so on. Swap one for a mechanism that counts what its neighbour counts and the
  rows collapse back into duplicates even though the code differs. Every
  count-driven one is bounded by `cap` — an unbounded count-driven multiplier
  inverts the ladder once a cheap tier is owned in the thousands, and
  `serviceCurve` is the dangerous one because two exponential curves multiply.
- **A per-tier mechanism must NOT read a NEIGHBOURING tier.** Its quantity is
  this tier's own, or the whole fleet's. Nothing else.
  - **Why, and it is not tidiness.** A row scaling by "the tier above" prices
    one card from another card the player may not own yet, and it turns the
    ladder into a chain of obligations ("buy Region so Replica improves")
    rather than thirty-two independent purchases.
  - **It also costs real machinery.** A tier reading a neighbour's *result*
    cannot be folded in one pass, because the neighbour has not been computed
    yet. `serviceFloor` ("never below `per` of the tier above") was the only
    such mechanism, and it forced the whole fleet to be evaluated into
    `rawOutput` first and summed afterwards. Deleting it deleted that phase:
    `perSecond` is now built in a SINGLE loop.
  - **`check:ladder` enforces it twice.** It fails on any per-tier row using
    one of the seven retired kinds, and it fails on any per-tier *blurb* that
    names another tier. The blurb phrases are deliberately narrow ("the tier
    above", not a bare "above it") because a broad phrase flagged
    `datacenter-2`'s "sees every layer below it", which describes the ladder
    the player is standing on. A check that fails on a true statement gets
    weakened by whoever hits it next.
  - **`queue-3` is why the rule is stated as "must not" rather than "does
    not".** It counts unlocked achievements of ONE rarity, so the cap has to be
    sized against a real count — 15/13/23/13 for bronze/silver/gold/mythic — or
    the blurb promises a figure nothing can reach. It is `per: 0.1, cap: 1.5`
    on bronze, so all fifteen lands on the cap EXACTLY.
- **The count-driven mechanisms share one helper, not one record each.** Most
  have the shape "1 + min(per x quantity, cap)", so they use `tierChannel()` /
  `addTierRate()` / `scaleBy()` and differ only in the quantity passed at fold
  time. Three are NOT count-driven and keep their own channel:
  `serviceFullStack` (flat while all eight stand), and the two that act on
  something other than output — `serviceCurve` (a compounding second curve) and
  `serviceEconomy` (the cost curve).
- **`serviceAutoDeploy` is the ONE count-driven row that is not a tier
  multiplier.** It uses `tierChannel()` / `addTierRate()` like the rest, but its
  fold goes to `autoDeployRate` — a fleet-wide scalar — rather than into
  `serviceMult`. So it must be accumulated AFTER the tier loop, next to the
  `serviceShardGain` fold, and not inside it; the loop there builds a per-service
  multiplier, and adding a scalar to it silently does nothing to the rate.
  It is Worker's fourth row (+1/s deploy per 50 Workers, max 6/s) and it feeds
  automation a share of PRODUCTION via `CLICK.autoDeployShare`, never
  `clickPower` — see the automation section. Every other automation rate in the
  game is a flat purchase, so this is the only one that scales with what the
  player has built.
- **`serviceOffline` currently has NO USER.** Worker's "Warm pool" granted it
  until that row became `serviceAutoDeploy`, so nothing runs a tier at full rate
  while away and offline production is the base efficiency on every tier. The
  kind and its fold are kept because nothing else expresses the mechanic; do not
  describe offline full-rate production as a feature of the game while this is
  true.
- **`serviceEconomy` is safe by construction, not by cap discipline.** Its
  `cap` is a FLOOR on the multiplier, so a discount can never make a tier free.
  Do not "optimise" it into a plain multiplier.
- **Do not answer an exponential quantity with a linear rate.** `serviceLifetime`
  and `serviceReserve` get away with it only because their exponents are tiny
  (2e-12 and 5e-4) and their caps sit at a known total. A compute-denominated
  quantity with a NORMAL rate saturates on the tick it is bought, and with a
  rate small enough to ramp it renders as `+0.00%` in the badge, which reads as
  doing nothing. `region-2` solves this by wording the rate out entirely
  ("grows with all compute ever earned"); `queue-2` was briefly written on
  `totalOfflineEarned` and moved to `serviceReboots` — a COUNT — instead.
- **A per-tier quantity that is TIME, or a total that spans orders of magnitude,
  is the same defect wearing a different hat, and the whole vocabulary was
  removed for it.** `serviceAge` (hours since the save began), `serviceTenure`
  (hours this run) and `serviceRunEarned` (compute this run) are gone, and with
  them the engine stopped reading `state.startedAt` at all. `serviceRunEarned`
  was not a time mechanic and went anyway: a compute total spans orders of
  magnitude inside ONE run, so a linear rate against it has only two readable
  settings and neither is good.
  **The tell is a formatter that has to hide a number.** That row's badge had
  been worded around its rate ("grows with this run's earnings") so no figure
  appeared at all — a formatter engineering its way out of a mismatch is
  reporting the mismatch, not solving it. If a badge wants to avoid printing a
  rate, the quantity and the rate do not suit each other.
- **A rate can also be made legible by changing its UNIT rather than its
  quantity.** `serviceShardsSpent`'s real rate is `0.00012`, i.e. `0.012%`,
  which `ratePercent` rounds to `+0.01%` — a figure that reads as nothing. The
  badge states it per **1,000** shards instead, which puts it back in the range
  the formatter is built for. Reach for this before rewording, and never
  reword a badge to hide a number.

### A cap is a ceiling, and the soft alternative is measured but NOT enabled

`min(per x q, cap)` has EXACTLY zero marginal value once `q` passes `cap / per`.
For a row whose quantity is unbounded that is a real property to know about: the
next unit of that tier buys nothing from THIS ROW, ever.

**It does not mean the tier stops being worth buying.** A capped row is one
reason among several, and the biggest one is uncapped: every 25 units doubles
the tier's output (`2^floor(units / 25)`) with no ceiling at all. So the
original worry — "the player stops buying the tier once the row caps out" — is
mostly unfounded, and that is why the hard cap is the shipped behaviour rather
than a defect to be engineered away.

**`soft: true` exists on `UpgradeEffect` and is currently used by NO ROW.** It
replaces the clamp with `cap x raw / (cap + raw)` — same slope at zero, same
`cap` as the LIMIT, never flat. The machinery is kept, tested and documented
because the measurement below is the useful part, and because a future
"cap that rises with the tier" idea would want it. **If you enable it, re-measure
— do not assume.**

**The measurement, and it is the reason it is off.** A soft cap reaches only
HALF its value where the hard cap was reached, and 90% only at `raw = 9 x cap`.
It can never reach its own ceiling — that is the shape, not a tuning error — so
the "up to +N%" on the card becomes an asymptote the player cannot touch:

```
worker-1   card says "+150% at 300 Workers"  ->  delivers +86%
queue-2    card says "+240% at four reboots" ->  delivers +144%
replica-4  card says "+300% at 25,000"       ->  delivers +180%
```

Measured at a fixed state, sweeping the cap multiplier:

```
x1.0 (unchanged caps)  -33% production   x2.0  +47%   no cap  Infinity @ hour 4
x1.5                    +5%   <- matches the old payoff, but the cards still lie
x4.0                   +220%
```

So softening is a choice between the card lying and the row being weaker. The
hard cap delivers exactly what it promises, which is why it is what ships. Two
further lessons from the same pass, both counter-intuitive:

- **A run-level timing cannot confirm a row-level change.** With `soft` enabled
  the simulated run got FASTER (−8% on the fleet-completion hour) while the
  same rows measured 33% WEAKER at a fixed state. The speedup is a coupling
  artefact — the simulated buyer is greedy, so weakening some rows changes
  which upgrade it buys next. Measure the row at a fixed state before believing
  the run.
- **Removing the caps entirely is not an option.** Production reaches `Infinity`
  by hour 4 and eight gates fail: the rows feed each other and the uncapped
  milestone doubling, so the feedback loop runs away. Any of these quantities
  needs SOME bound.

**A cap that can never bind is not harmless — it is a lie about a number.**
Six per-tier caps were deleted for binding only at or beyond their content
maximum (`worker-2`, `cache-1`, `cache-2`, `queue-3`, `queue-4`,
`datacenter-2`). Deleting them is a PROVABLE no-op: with the caps removed the
full simulated run reproduced the previous figures exactly.

**`serviceShare` and `serviceCurve` keep a hard `Math.min`, and for a
different reason.** Their clamp is *load-bearing* rather than a ceiling: the
share code multiplies by `Math.min(cap, …)`, so a cap of 0 would zero the
tier's output, and a curve's cap bounds a compound total rather than a per-unit
rate. Do not delete those caps assuming they are the same kind of thing.

**The badge rule for a missing cap.** `describeEffect()` is a wrapper that
strips the trailing ` · max xN` clause when `cap` is undefined, because the
templates fall back to `1 + (cap ?? 0)` and would otherwise print **`max x1`** —
false, since those rows reach +200%. A row with a real cap keeps a ceiling
that is genuine.

- **`serviceDeployPerOwned` is the only COMPUTE-fed row**, and the split is
  deliberate: it scales by a unit count (units are bought with compute) but it
  is still priced in shards like every other upgrade. **Nothing costs both
  currencies**; only the quantity comes from compute. Its purpose is to give a
  player holding a large compute balance a purchase that makes their own deploy
  button hit harder, because every other click booster is an achievement or a
  shard-priced flat multiplier. Its `cap` is set from the MEASURED peak unit
  count, below the real maximum rather than at it.
  - **It shares its quantity with `worker-3` on the same card, and that is a
    known, accepted tension rather than an oversight.** `worker-3` is
    `globalPerOwned` on the same tier's units at the same `per: 0.005`, so both
    rows count Workers and both read `+0.5%` — but they multiply DIFFERENT
    things (deploy power against all output), so the rows do not collapse into
    one purchase. Two rules keep it honest and both are load-bearing:
    - **The badge leads with the TARGET, not the counter.** "Deploy power
      +0.5% per Worker" against worker-3's "+0.5% all output per Worker" is a
      pair; "Each Worker adds +0.5% to ..." twice is a duplicate.
    - **Do not extend the pattern.** Every genuinely free quantity was checked
      before accepting the overlap: `totalUnits` is `database-1`'s,
      `state.clicks` was removed on request, and the count-shaped ones are all
      spoken for. A THIRD row on this counter would be a duplicate whatever its
      target.
- **`serviceMatureTiers` is the ladder's only BREADTH reward.** It counts tiers
  holding at least `MATURE_UNITS` (100) units, so it pays a spread fleet rather
  than a deep one, and its cap is bounded by `SERVICES.length` rather than by a
  fleet size. `MATURE_UNITS` is its own constant, **not** a read of
  `SHARDS.revealAt`'s last threshold: a deeper reveal gate must not silently
  move what counts as mature. It is measured as near-worthless for TOTAL income
  (a cheap tier's output is four orders of magnitude below the deepest tier's),
  which is a property of the whole per-tier ladder and not of this row.
- **`serviceShardsEarned` and `serviceShardsSpent` are a pair, and they must
  stay distinct.** The first counts `shardsEarned`, the second
  `shardsEarned - shards` — what is GONE. An idle hoard earns the first and not
  the second, which is what makes them two purchases instead of one row on two
  tiers. `serviceShardsSpent`'s cap is chosen against the ladder's own declared
  total (`SHARDS.pacing.targetTotal`, which `check:ladder` asserts and prints):
  clearing every rung once costs 30,000, so a round figure above that would be a
  cap nothing could reach in a run.
- **`serviceShardGain` is the only per-tier kind that feeds shard income.** It
  lives on the top tier (`datacenter-4`) and is a flat per-unit rate with a
  hard cap, not a curve: letting shard income inherit compute's exponential
  shape is exactly what the currency split exists to prevent.
- **Per-tier upgrade NAMES say what the mechanism counts.** A row is only
  legible if its name identifies the quantity it scales by, because that is
  the only thing distinguishing it from the other thirty-one. **IDs are never
  renamed to match** — ids are save keys, so `worker-1` stays `worker-1`
  whatever it is called.
- **`globalPerOwned` with no `serviceId` means "every unit of every tier".**
  `perOwnedMultiplier()` takes a third argument for it. It is also the one
  `globalPerOwned` that files under group `'global'` rather than `'services'` —
  a fleet-wide effect inside one service's card reads as a tier upgrade that is
  not one.
- **`milestoneStep` is bounded, because the effect is non-linear.**
  Reducing the milestone step from 25 to 20 turns a 1000-unit tier from
  2^40 into 2^50. `milestoneMultiplier()` therefore grants at most
  `MILESTONE.stepBonusMax` (3) *extra* steps when the reduced step yields a
  span under one full step. That caps the benefit at 2^3 = 8x. Never raise
  the reduction without re-measuring this bound.
- **Synergy flows DOWNWARD: the tier above lifts the tier below.** So the
  bonus applying to tier *i* is the one authored on tier *i+1*, which is why
  the lookup is `above.id`. The exception is the **bottom tier** (index 0):
  its synergy would buff a tier that does not exist, so it lifts *itself*.
  Without that, one of the signature mechanisms is dead content on the most
  important tier in the game.

  **This is `SYNERGY` in `content.ts`, not an upgrade mechanism.** It is the
  ladder's own coupling, authored on `SERVICES`. The three per-tier upgrades
  that used to widen it from either end — `serviceSynergy` (better donor),
  `serviceIntake` (better recipient) and `serviceReverseSynergy` (pushing
  upward) — are gone with the cross-tier rule above, so `synergyBonus` is now
  just `mods.synergy` plus nothing. Do not reintroduce a per-tier row that
  widens synergy: it is a neighbour dependency by definition, and the fold
  would have to grow the three terms back.
  **The `synergy` SHOP row is gone too** (it was `synergy-1` "Warm pathing"),
  replaced in place by a `throughputShare` row — see the deploy section. So the
  `synergy` achievement reward on `services-500` is now the ONLY way to widen
  synergy, and no upgrade grants it at all. `mods.synergy` still has a writer,
  so the fold is not orphaned.
- **`offlineCap` is no longer buyable as an upgrade either.** `offline-1`
  "Warm standby" (+40h) was the only shop row granting it and now carries a
  `throughputShare` effect instead. Eight achievements still grant cap hours
  (the `offline-*` and `playtime-*` chains, summing past 90h against an 8h
  base), so `mods.offlineHours` is well fed and the row was worth nothing to a
  player who had those. Do not "restore" either row without first checking
  what the replacement bought — every figure here is measured.
- `rebuildUpgrades()` fills **both** destinations from one signature. If you
  add a third destination, extend that function rather than adding a second
  reconcile, or the two will disagree about when to rebuild.
- The signature covers ids **and** owned-ness. A row is built either as a Buy
  control or an Owned label, so any change to a row's *state* must invalidate
  it — see the reconcile invariant above.
- `handleUpgradeClick` is bound to both list roots. A third root needs
  binding too, or its buttons will silently do nothing.
- The Upgrades tab badge counts **shop upgrades only**. A badge must not count
  something the tab does not list, or it sends the player looking for it.
- Tier upgrades take the service's `--tier` hue rather than a category colour,
  which is what ties the nested row to the tier above it.
- **A concept is drawn one way, and `concepts.ts` is where that is decided.**
  Every named quantity in the game — the currencies (compute, shards, cores),
  the rates (production, per deploy), the stats (multiplier, achievements,
  reboots) and the fleet size — has exactly one glyph and one hue, and EVERY
  mention carries both. `CONCEPTS` pairs each id with its `GLYPH_MARKUP` key;
  the hue comes from the `.concept--<id>` classes, which read the `--stat-*`
  tokens rather than duplicating the colours.

  This has to be centralised because a per-call-site judgement fails: cores end
  up a bolt in one place, a target in another and a processor in a third, while
  a shard price is cyan text with no glyph next to a HUD shard balance that has
  one. Then nothing is recognisable as anything.

  The rule: **if a NUMBER is attributed to a concept, the mention carries its
  glyph and hue.** Markup uses `Concept.astro`; anything built in `ui.ts` uses
  `createConcept()`. A badge whose subject is a concept (an upgrade effect, an
  achievement reward) declares it via `EffectSummary.concept` or
  `rewardConcept()` in `format.ts` and renders the glyph inline.

  **Both, not one.** Giving the hue to the glyph while the text keeps the
  card's rarity colour produces a violet cores glyph on gold text, which is
  half a concept and the half that reads at a glance. A reward chip therefore
  takes `--concept` for text, border and glyph alike; the locked/unlocked
  signal for a chip is its OPACITY, so the hue is free to mean what the reward
  is about. A reward that names no concept (contract pay, synergy, offline)
  keeps the rarity tint.

  Two boundaries worth keeping:
  - **Prose is exempt.** A blurb sentence is not a figure, and glyphs inside
    it make it unreadable rather than scannable.
  - **An upgrade that merely *uses* a currency keeps its own identity glyph.**
    The rule is about the concept being the *subject*, not about every icon
    that happens to sit near one.

  A section HEADING that names a quantity takes the concept too, and that is
  the same rule rather than a decoration: the Upgrades panel's groups are
  headed "Deploys", "Global", "Reserve", "Automation" and "Offline",
  and a player scanning for the deploy group should find the same amber arrow
  they see on the button and the badge.
  `UPGRADE_GROUPS` carries a `concept` per group; the Services heading
  carries `fleet`. A heading concept is a static-class case (the `concept--<id>`
  class on the glyph, no `createConcept()`), because the heading is markup
  rather than a figure that updates.
- **Two currencies must be distinguishable as WORDS, not just as icons.** This
  game has two (compute, shards) plus a prestige stock (cores), and they are
  all things the player accumulates. A currency name must not sit one letter
  from another — same initial, same shape, neighbouring visual family — or the
  glyph ends up being designed around the name. When a glyph is working around
  a *name*, the name is the problem.
- **A rename is a migration, not a cleanup.** Renaming a field or an id costs a
  save migration, a glyph, and every label and doc, so reserve it for a change
  that fixes something broken rather than a taste disagreement. If you do rename:
  - **A rename reaches identifiers, not just field names.** Stored arrays of id
    strings (`upgrades`, `achievements`, `contracts`) are filtered by id in
    `sanitize()`, so renaming an id silently drops it from a returning player's
    save with no error and no visible symptom.
  - **`sanitize()` runs BEFORE `migrate()`**, so a renamed field is already gone
    by the time `migrate()` sees the state. Recover it from the raw parsed
    object — which means widening `migrate()`'s signature, since it currently
    takes only the sanitized state.
- **Cores are the FINAL multiplier, and every figure is stated in the
  MULTIPLIER form.** A core adds no flat production — it multiplies the whole
  fleet, everything else already applied: `coreMult = 1 + coreAmplifyPer *
  cores`. So:
  - **It is applied to `perSecond`, NOT folded into `globalMult`.** Both would
    give the same arithmetic, but `globalMult` is what the HUD's "Multiplier"
    chip reports, so folding cores in would double-count them against the cores
    chip. `perService` is scaled by the same factor inside the tier loop, so the
    per-tier figures still sum to `perSecond`.
  - **Cores used to nest inside the reserve bonus, and that was the bug.**
    `reserveBonus = rate * sqrt(shards) * coreAmplify` meant a core multiplied a
    bonus that is ADDED TO 1, so it was diluted by every other factor; and at
    zero shards it was worth literally nothing, because `sqrt(0)` collapsed the
    term. Both are gone. The `needs shards` chip state is gone with them.
  - **`reserveBonus` is the shards' own contribution alone** — `rate *
    sqrt(shards)`, no core term. The shards chip reports `shardFactor()` and the
    cores chip reports `coreMult`; the two are INDEPENDENT figures and no longer
    multiply to one total. Do not "fix" that by re-coupling them.
  - **Use `formatMultiplier()` (`3.00x production`) for the shards and cores
    chips**, which is also the convention of the `Multiplier` chip beside them,
    so those three read as factors.
  - **The `Achievements` chip is a PERCENTAGE (`+24%`), and it is the one
    exception.** It reports `stats.achievementMult`, which is `1 +
    mods.globalBonus` — the total of an ADDITIVE pool, exactly like the `+25%`
    chips on the achievement cards that feed it. A factor put the total in a
    different MODE from the numbers that produced it, and worse, a factor reads
    badly near 1: `1.24x` scans as "basically nothing" when the truth is a +24%
    gain, so the factor form **undersold every achievement the player had
    earned**.
  - **The rule behind both: percentages read better NEAR 1, factors read better
    FAR from it.** Judge each chip on where its values actually live. The
    achievement pool stays in the low range; `coreMult` and `shardFactor` grow
    without bound (cores reach the billions), and `globalMult` is the mixed
    product `(1 + additives) × multiplicatives`. `+299021022900%` is far less
    readable than `2990210x`, which is why those three stay factors. **Do not
    "unify" them all into one form** — they are not the same kind of number.
    This supersedes an earlier note that called for factors everywhere on the
    grounds of sitting together; the near-1 readability failure outranks it.
  - **An additive SOURCE still shows a percentage and a multiplicative one still
    shows a factor** (`All output +150%` vs `×2 all output`). That rule is
    about how the player COMBINES a bonus; the chip rule above is about how they
    READ a total. Both apply, at different sites.
  - **`+N%` and `Nx` differ by exactly 1x, and the `+` is what carries that.**
    `+300%` is a bonus ON TOP of the base (factor 4), while `3x` is three times
    it (which is `+200%`). The two are adjacent-looking and a whole factor
    apart, so the form is not cosmetic — the Overclock ability card says
    `3x production` and the achievements pool says `+300%`, and the pool is the
    larger bonus. **`formatPercent` does NOT add the `+`** — the caller does —
    so an `N%` written without one reads as "N% OF" (i.e. a factor) and would be
    silently wrong for a bonus. Every bonus site supplies the `+`; keep it.
  - **The ADDITIVE AXIS is shown as TWO rows, so the first can be called
    `Achievements` and carry the chip's own number.** The axis is one sum fed by
    the achievement `globalBonus` rewards and by the single additive shop
    upgrade (`globalAdd`), and a sum is one factor of `globalMult`, so merging
    them is the natural presentation — but it forces the row to be named for the
    mechanism (`Additive pool`) rather than for anything the player owns, and it
    means the row disagrees with the Achievements chip the moment that upgrade
    is bought. Split as `Achievements` (`achievementMult`) and
    `Additive upgrades` (`additiveMult / achievementMult`), the arithmetic is
    exact — the product is `additiveMult` by construction — the first row
    matches the chip, and the second is omitted at zero rather than printing
    `1.00x`.
    **The cost is that `Additive upgrades` states a RATIO, not a bonus**:
    because additive sources sum into ONE factor, the second one's marginal
    effect depends on how big the first already is, so `1.38x` means "the shop
    multiplies the pool above", not "the shop gives +38%". The chip on the
    upgrade itself still says `+150%`, which is its size against the base. That
    is a subtler claim than any other row makes, and it is the price of naming a
    row after an achievement.
  - **A row states ONE form. Do not print a factor and its percentage on the
    same line.** `4.00x` beside `+300%` invites working out which is the real
    figure, and the HUD chip one row up already gives the other form to anyone
    who wants it. The chip rule above (which form a TOTAL is read in) and this
    one (one form per row) are different rules at different sites.
  - The shards and cores chips DO switch form — `+1% per shard` at zero, then
    `1.05x production` once held. That is deliberate: the two states make
    different claims (a rate you do not have yet vs a total you do), and each
    uses the form that suits its magnitude.
  - The Reboot panel's "on reboot" note is a RATIO, not a difference — the
    extra multiplier the new cores would add (`→ 7.77x production`). It goes
    through `stats.coreAmplifyPer`, the per-core RATE, which is the only term
    that works at zero cores: `coreMult` is a constant 1 there whatever a core
    is actually worth.
  - Never `toFixed(2)` for a multiplier: a late Reboot can bank billions of
    cores and `2990210229.95` is not a number anybody can read. Use
    `formatMultiplier()`.
  - **The per-core rate is NOT yet tuned for this model.** `PRESTIGE.bonusPerCore`
    is still `0.05`, which as a *final* multiplier is ×2.25 at 25 cores and
    ×16.8 at 316. That is very strong, and it cannot be measured by
    `check:progression`, which models no Reboots and so always runs at zero
    cores. Treat the rate as an open item needing a reboot-aware measurement.
- **Reboot resets services and upgrades together**, so both the service tiers
  and their nested upgrade lists empty out on reboot. That is expected, and it
  is why the nested area is hidden rather than shown empty.
- **The Reboot panel's progress measures the NEXT core, not
  `PRESTIGE.threshold`.** Cores scale with the square root of the run, so the
  2nd core needs 4x the threshold, the 3rd 9x and the 10th 100x. A bar pinned
  to the threshold reads 100% from the first core onwards and can never move
  again. `prestigeWindow()` in the engine solves the real boundaries; the UI
  must read `prevAt`/`nextAt` from it rather than dividing `runEarned` by a
  constant. Anything that renders "progress to the next core" must go through
  that helper, or it will reintroduce a bar that is either pinned or wrong.
- Readiness for a Reboot is carried by the `reboot__ready` **chip** as well as
  the accent tint and the tab badge, so the state never rests on colour alone.
  The chip and the tab badge read the same `prestigeCores()` value and must
  never disagree about it.

### Every production axis has TWO modes, additive and multiplicative

An axis is folded as

```
axis = (1 + SUM additive) x PRODUCT multiplicative
```

and **that order is not negotiable**. Writing it as `axis += add; axis *= mult`
gives a DIFFERENT total depending on which bonus the player unlocks first, which
is a bug rather than a flavour: sources unlock in arbitrary order, and the same
set of bonuses has to be worth the same thing however it was assembled.

The modes exist on two levels, and each level has one kind per mode:

| level | additive | multiplicative |
| --- | --- | --- |
| fleet-wide | `globalAdd` (`value`) | `globalMult` (`mult`) |
| one tier | `serviceAdd` (`value`) | `serviceMult` (`mult`) |

Achievements write to the **same** pools: `globalBonus` joins the fleet-wide
additive sum and `serviceMult` multiplies one tier. One axis per level, fed by
both sources — that is what makes an additive upgrade and an additive
achievement comparable rather than two things that merely look alike.

**Why the two modes are a real decision rather than decoration.** Adding `a` is
worth a factor of `1 + a/(1 + SUM)`, which SHRINKS as the pool grows; multiplying
is worth exactly its `m` however large the pool is. So **additive is worth most
early and multiplicative is worth most late**, and a shop offering both makes
"when do I buy this" a question whose answer changes over the run. A consequence
to expect when tuning: an additive row is a NERF relative to the multiplier it
replaced once the pool is deep, and that is the shape working rather than drift.
Measured once already — converting the cheapest global from `mult: 2` to
`add: 1.5` took the sustained contract rate from 335/hr to 204/hr.

Rules that keep the two modes honest:

- **An additive row states a PERCENTAGE on its card, never a factor.** Additive
  cards SUM, so a `x2` reading invites the player to multiply them together and
  overstate the total. `globalAdd`/`serviceAdd` therefore render `+150%`, the
  same convention the achievement `globalBonus` chip already used.
- **A row declares one mode, not both.** The kinds are separate (`globalAdd` vs
  `globalMult`), so the choice is visible in the type rather than in a branch;
  `check:ladder` asserts an additive row's value is positive and that each mode
  forms its own distinct, price-ascending ladder.
- **An additive channel's identity is 0, not 1.** `serviceAddPool[id]` starts at
  `0`; starting it at `1` would hand every tier a free +100%. This is the same
  reason `Modifiers.globalBonus` is a sum with identity 0.
- **The modes are NOT interchangeable in tuning.** If a row feels wrong, decide
  which side of the trade it belongs on before changing its number: raising an
  additive value helps only while the pool is thin, and raising a multiplier
  helps always but compounds with the others.


---

## Invariants

- **Only `opacity`/`transform`/`width` are animated**, and only where
  `prefers-reduced-motion` is handled. Content must never depend on motion or
  on JavaScript to become visible.
- **Never scale an element *up* in an entrance animation** if it can be
  viewport-wide; it causes transient horizontal overflow.
- **Every single-column grid needs `minmax(0, 1fr)`**, and every grid/flex
  child holding content needs `min-width: 0`. Without these, a long service
  name blows out the layout at 320px.
- **Zero horizontal overflow from 320px up.** Verify at 320/360/375/414/480/
  640/768/900/1024/1280/1440/1920, sampling *repeatedly* — a transform can
  overflow only mid-animation, so one measurement is not enough.
- **The built CSS must stay pure ASCII.** The stylesheet is served as
  `text/css` with no charset, so a literal non-ASCII character in a CSS
  `content` string is decoded as Latin-1 (`·` renders as `Â·`). A CSS escape
  gets re-expanded by the minifier and `@charset` gets stripped — so any such
  glyph must come from **markup**, where the document charset governs it.
- **`print.css` overrides need `!important`** when they override a component's
  scoped `<style>`, because `.cls[data-astro-cid-x]` outranks a plain `.cls`
  regardless of order. Rules overriding `tokens.css`/`global.css` do not.
- **Aria-live is for discrete events only** (offline summary, prestige,
  achievement unlocks, shard gains, save errors). Never announce per-tick
  numbers; the stat readouts are `aria-hidden` and mirrored by a throttled
  summary.
- **Automated deploys must not increment `clicks`**, or they would unlock
  click achievements without the player clicking.
- **Every currency mention carries the currency glyph AND its hue.** See the
  concept rule further up; the hue alone is not enough at small sizes and the
  glyph alone is not enough in greyscale.
- **A concept's hue has one binding.** `.concept--<id>` reads a `--stat-*`
  token; a component must not re-declare the same colour, or the two drift. If
  a chip needs to know its concept, read `--concept`.
- **Reconcile-in-place lists key on a signature covering everything the row
  renders.** The upgrades list builds either a "Buy" button or an "Owned"
  label, so its signature must include owned-ness and not just the visible
  ids — otherwise buying an upgrade leaves its row unchanged and the click
  looks like it did nothing. Check any row whose *state*, not just its
  presence, is decided at build time.
- **A signature sentinel must be a value a signature cannot take.** The
  contract and upgrade signatures use `null` for "force a rebuild", because
  `''` is a legitimate signature for an empty list; using `''` as the
  sentinel makes a post-reset rebuild silently skip and leave stale rows.
- **Setting `display` on a component gives it its own `[hidden]` duty.** The
  UA's `[hidden] { display: none }` and a component rule like
  `.game__breakdown { display: grid }` have EQUAL specificity (one class each),
  so whichever sheet comes later wins — and `game.css` is loaded after the UA
  sheet, so the component's `display` won and `hidden` did nothing. The stat
  breakdown shipped with 168px of empty box above the Deploy button, showing
  whatever the last hover had left there, from page load. It needs
  `.game__breakdown[hidden] { display: none }` — which is why every other
  `[hidden]` in `game.css` has one too (`.game__banner`, `.game__panel`,
  `.reboot__ready`, `.service__upgrades`, `.game-tab__badge`). **When you add a
  component that sets `display` and can also be hidden, add the pair.**
- **The stat breakdown appears on the COMPUTE chip only, and it is one shared
  panel spanning the stats grid.** Hovering the hero compute chip reveals what
  the production number is made of: the three terms that multiply the tier
  total (`Tiers` × `Multiplier` × `Cores`), with the multiplier's own factors
  indented UNDER its row as `sub` rows rather than given a hover target of their
  own. That is deliberate — the compute figure is the FINAL result, so it is the
  one place a player asks "where does this come from", and nesting keeps that a
  single answer rather than several panels to reconcile. The Multiplier and
  Achievements chips have NO breakdown: each is already explained by the panel
  it belongs to.
  - **The sub-rows are nested rather than promoted because they do not multiply
    the same thing.** `× Multiplier` multiplies the TIER total; the six factors
    multiply INTO it. At the top level they would read as five more terms of the
    same chain and overstate what is being multiplied together.
  - **A row is `<div class="game__breakdown-row">` wrapping its own `dt`/`dd`,
    and the row is `display: flex`.** A `<div>` around the pair is valid inside a
    `<dl>` (HTML 5.2), and it is what makes a row ONE line rather than two grid
    cells that only look paired. The difference is the label: as a grid cell it
    occupied a fixed track and wrapped against a boundary it could not negotiate
    — measured at 320px, 5 of 9 terms wrapped to two lines, putting a term and
    its figure on different lines.
    - **The value is pushed by `margin-inline-start: auto`, not by
      `justify-content: space-between`.** `space-between` would also force them
      apart when the label already fills the row; an auto margin only adds space
      that is genuinely spare.
    - **`dt { flex: 0 1 auto }` and `dd { flex: none }`.** A term is prose and may
      wrap; a value must stay on one line to be read as a number.
    - Two grid attempts failed first and are worth not repeating: an `auto` value
      track **collapsed the label to 0px** (every term one character per line,
      1389px of rows), and `minmax(0, 8rem)` does **not** shrink to content — a
      non-flexible track grows to its limit, wasting 69px of a 230px row.
  - **`align-items: center`, not `baseline`.** A baseline lines up text of ONE
    size; the term is `--fs-label` (11px) and a top-level value is `--fs-small`
    (14px), so on a baseline the larger figure extends only upward — measured,
    its ink sat 4px above the label's and the ink centres were 1.2px apart, which
    reads as the right column floating high. The sub rows were fine (0) only
    because both are 11px there. Centring makes the ink centres coincide at every
    size.
  - **The `concept--<id>` class goes on the ROW, not on the `dt` and `dd`.** Custom
    properties inherit, so one declaration covers the glyph, the label, the value
    and the row's guide rail. The rail lives on the row, so a class on the cells
    alone would leave it neutral grey while everything beside it was tinted.
  - **Verified geometry, 320px to 1920px:** icon starts take exactly two values
    (one per nesting level), the value's right edge is a SINGLE value across all
    rows and flush with the panel's content box, term/value ink centres coincide
    within `0.1px`, the glyph's centre sits within 0.03px of the label's cap
    centre, and no label or value ever wraps. Two measurement traps, both hit
    here: `Range.getBoundingClientRect()` returns the LINE BOX, not the baseline
    (use a zero-size inline probe, whose own rect bottom IS the baseline), and
    centring an icon should target the label's CAP centre, not the line box's
    midpoint — uppercase text has no descender.
  - **The panel spans the grid (`grid-column: 1 / -1`),** so its width is the
    grid's width, which is already viewport-safe at every breakpoint. A popover
    anchored to a 140px chip would have to overhang its own track to be
    readable, and at 320px that is horizontal overflow. It also sits in normal
    flow BELOW the stats, so revealing it can never cover the tablist.
  - **The rows are the engine's real terms, never a residual.** `Stats` exposes
    `additiveMult` and `concentrationMult` specifically so the breakdown can
    name all six factors of `globalMult`. Deriving them as
    `globalMult / the other five` would give the same number and would report
    every error in the other five as an error in the term the player is
    checking. Derive the total FROM the rows, not the rows from the total. The
    tier subtotal IS a division (`perSecond / globalMult / coreMult`), and that
    is safe because both divisors are single exposed figures the engine itself
    applies to the sum.
  - **It is POINTER-only, and that is deliberate.** The whole stats block is
    `aria-hidden` and mirrored by the throttled live summary, so adding
    `tabindex` to the chip would put focusable content inside a hidden subtree —
    a worse accessibility fault than the one it fixed. Screen readers get the
    totals from the summary. Correspondingly it is hidden for print: a hover
    affordance is not information on paper, and the panel is written on hover,
    so a printout would show whatever the cursor last touched.
  - **The closing `= total` row must not set `color` on its `dd`.** A rule like
    `.game__breakdown-rows dd[data-total]` outranks `.concept--<id>`'s
    `--concept`, so setting a colour there flattens the concept hue on the one
    value that matters most. The total keeps whatever concept it was given.

---

## Save data

- Key `cv.idle.save.v1`, current `SAVE_VERSION` in `state.ts` (1). Bump it and
  add a `migrate()` step whenever the shape changes in a way `sanitize()`
  cannot handle on its own.
- **The migration ladder is empty at 1.0, because there is no older schema
  yet.** Most shape changes need no step at all: `sanitize()` reads the state
  **field by field and supplies a default for anything missing**, and filters
  id arrays against the content tables, so a save loads with every current
  field present and every retired one dropped.
- **`sanitize()` runs BEFORE `migrate()`, and `migrate()` receives only the
  sanitized state.** That is the constraint to plan around: a change that must
  TRANSFORM a value rather than default it — a field rename, or a rescale —
  cannot be done from the sanitized state, because `sanitize()` has already
  dropped the old field by the time `migrate()` sees it. Such a rename needs
  `migrate()` widened to take the raw parsed object again; do that rather than
  assume the old field is still reachable.
- **A zero seed is treated as missing** and regenerated. Zero would collapse
  the hash to a constant with no seed contribution, making every roll in the
  save identical.
- Contracts are **preserved** by `sanitize()`, not dropped — see the sanitize
  contract section for why that is load-bearing.
- Ability ids that no longer exist in `ABILITIES` are dropped on load, exactly
  like unknown service/upgrade/achievement ids.
- All storage access is wrapped in try/catch: `localStorage` throws outright
  in some privacy modes. Corrupt or malformed JSON must fall back to a fresh
  start, never break the page.
- `sanitize()` drops unknown ids, so editing `content.ts` cannot resurrect a
  service, upgrade, achievement, contract or ability that no longer exists.
- `lastSavedAt` is clamped so a future timestamp cannot inject a huge offline
  reward. Do not remove that clamp; it is a real safety property.
- **Cross-tab guard.** Two tabs share one key. Before writing, a tab checks
  whether another tab saved more recently and adopts that save instead of
  clobbering it. Do not remove this — an idle background tab silently
destroying progress is a real failure it prevents.
- Note when testing by hand: `pagehide` persists on reload, so injecting a
  test save into `localStorage` and reloading overwrites it again. Stub
  `Storage.prototype.setItem` before reloading, or the change you are trying
  to test never runs.
- **Order the injection: BACK UP, WRITE, then STUB — and never stubbing
  first.** The stub is `function () {}`, so a `setItem` *after* it is a silent
  no-op and the save you thought you wrote never lands. Doing it in the other
  order once destroyed the only copy of a save being used for testing.
  The full sequence that works:
  1. `localStorage.setItem('__devsave_backup', localStorage.getItem(KEY))` —
     with the real `setItem`.
  2. Write the modified save to `KEY`.
  3. `Storage.prototype.setItem = function () {}` so the unload handler cannot
     clobber it.
  4. `page.reload()`. A **fresh document gets the native `setItem` back**, so
     the stub does not leak into the loaded page.
  5. To restore: reload once (to escape the stub), then in that document write
     the backup back to `KEY` and remove the backup key — **and stub again
     before the next reload**, or the outgoing page writes its stale in-memory
     state over your restore. `delete Storage.prototype.setItem` does NOT
     restore the native function; it removes it entirely, so the next call
     throws. Reloading is the only way back to a clean prototype.

---

## Verification checklist

Run before considering a change done:

```bash
npm run check            # 0 errors, 0 warnings, 0 hints
npm run check:ladder     # 64 upgrades on a contiguous rung ladder, paced in hours
npm run check:progression # a full 24h simulated run: units, upgrades, offer mix
npm run build            # emits index.html
```

`check:progression` also FAILS on two things, and both are constraints on the
content rather than restatements of its own output: every seed must finish
inside `BUDGET_HOURS`, and the measured contract rate must be within
`RATE_TOLERANCE` of `SHARDS.pacing.referenceContractsPerHour`. If the second
one trips, update `content.ts` so the constant and the measurement agree and
then re-run `check:ladder` — the ladder's reported pace is computed from that
constant, so it moves too.

**`check:ladder` parses `content.ts` as TEXT, and a comment can break it.** It
slices the upgrade list out of the file, and it used to find the slice with a
bare `indexOf('export const UPGRADES')`. Any comment in `content.ts` that
NAMES that declaration is then found before the real one, the slice collapses
to nothing, and the checker reports `parsed 0 upgrades`. This was not
hypothetical: a comment added beside `MATURE_UNITS`, explaining that the
constant must sit above the array, broke it exactly that way. The search is now
anchored to the start of a line (`^export const <name>`), so indented prose
cannot match — **write any further note about the checker the same way, and
prefer anchoring over a plain `indexOf` for every other slice in that script.**
The general rule: a note explaining a rule must not be able to trip the rule.


Then in a browser:
1. Fresh load with cleared storage: deploy, buy, confirm passive income.
2. Confirm milestone/x synergy multipliers by hand against `content.ts`.
3. Reload twice: progress survives, **and the open tab survives**.
4. Offline: set `lastSavedAt` two hours back in `localStorage`, reload,
   confirm the capped amount and the banner.
5. Corrupt the save, reload: clean start, no uncaught error.
6. Save round-trip: load, change something, `Save now`, reload — the change
   survives and the file carries `v: 1` with no unknown keys.
7. Tabs: reachable by click, Arrow/Home/End, correct ARIA, panels swap,
   badges count the right things.
8. Achievements: unlock one of each rarity; confirm each reward kind moves
   the `Stats` value it claims to, and that an `unlockAbility` reward makes
   the ability appear as engagable.
9. Overflow sweep 320px+, reduced motion, print (all panels shown).
   **Include the Services tab: each service card carries four nested
   upgrade rows**, which is exactly where the `.upgrade__effect` overflow bug
   appears. Register a long effect chip like "Database +2% per milestone
   banked fleet-wide" as a label when checking — the chip row has its own wrap
   override. To reach all 32 rows you need a save with **100+ units in every
   tier**; the whole set is only rendered once every tier has revealed its
   four. See the save-injection note in the browser quirks below.
10. Per-tier upgrades: each revealed tier shows **exactly four**, and **none**
    of them appears in the Upgrades tab. **Read the 32 badge texts and confirm
    all differ** — that, not the kind list, is the property the player
    experiences. Also confirm **no badge names a different service** and that
    no badge prints `+0.00%`: the first is the cross-tier rule and the second
    means a rate is too small for its own unit. `check:ladder` asserts the
    counts, the 32 distinct mechanisms, the no-neighbour rule and the rungs;
    scripts/check-upgrade-ladder.mjs reads `content.ts` as TEXT and cannot see
    the badge, so the badge half of this check is manual.
11. Abilities: clicking a card's **name, blurb, timer or medallion** must do
    nothing; only the button activates. The id used to sit on the card root, so
    `closest('[data-ability]')` matched the whole row.
12. Print: every **shard price is visible** on the upgrade rows and on the
    Services tier cards (they live inside the action cells, so hiding the cell
    hid them), no contract payout prints in cyan, and the Reboot panel's ready
    chip is legible rather than black-on-black. Verify statically against the
    built CSS as well — see the browser-tool quirks below.
13. Reboot with a `contractSlots` upgrade owned: the contract panel must show
    no more than `CONTRACTS.active` cards. `contractSlots` is derived from the
    upgrades the reset clears, so it has to be recomputed AFTER `applyReboot()`.

The economy checks below cover the rest; they are the ones that need a live
game rather than a screenshot.

### Verifying the shard economy

1. **One currency per job.** Buying an upgrade moves `state.shards` by exactly
   `upgradeCost(def)` and leaves `state.compute` untouched; buying a service
   moves `state.compute` and **moves `state.shards` by the milestone crossings
   it bought** — 25 units of a fresh tier is one step, so it pays
   `milestoneStepPayout(0, 0) * shardMult` (10 at the shipped gains), and
   `50` units is two steps, priced at the RISING step rate. Provision pays the
   same way for the boundaries its grant crosses, per tier, and pays nothing
   when it crosses none. A row is disabled when shards are short, and the cost
   chip reads in the shard colour.
2. **The upgrade shape** is asserted by `npm run check:ladder`: 32 per-tier
   (4 x 8) + 32 global, **a distinct mechanism for every per-tier row** (no
   kind repeated within a tier or across tiers), rungs unique and contiguous
   `0..63`, well-formed price bands, **eight capstones** each costing more than
   the next tier's first upgrade, the run length inside `SHARDS.pacing`'s
   target band with no single upgrade over 10% of it, and **no contract
   measured on a prestige-only metric**.
3. **No orphaned card.** Every upgrade's `describeEffect().group` must be one
   `UPGRADE_GROUPS` declares (or `'services'`). `check:ladder` guards this; the
   runtime check is that all 64 rows render somewhere and none is silently
   dropped.
4. **Prices are banded, capstones are dearer, and income is flat.** Confirm the
   upgrade list shows only the seven band prices, and that a buy charges exactly
   the price shown. Then confirm each tier's FOURTH upgrade costs more than the
   next tier's first — the capstone rule. Then complete several contracts and
   confirm the shard payout on the card is the SAME number every time — no
   variation by the rarity rolled, no growth with `contractsCompleted`.
5. **A Reboot cashes in completed contracts.** Complete a contract, do not
   claim it, and Reboot: `state.shards` must still rise by the contract's
   payout and the cores gained must reflect the compute it was worth. The
   compute itself is zeroed by the reset, which is expected — it is the cores
   that must not be lost.
6. **`serviceShardGain` moves only `shardMult`.** Buying the datacenter shard
   upgrade must raise `stats.shardMult` and leave `perSecond` unchanged — it is
   an income upgrade, not an output one.
7. **Contracts pay both currencies.** Completing a contract moves
   `state.compute` by the computed reward AND `state.shards` by
   `shardPayout(def) * stats.shardMult`, and increments `state.shardsEarned`.
8. **The salvage strike is deterministic.** Complete a contract, record the
   payout, reload three times, and confirm the SAME payout — it is salted on
   the contract's stored completion ordinal, so a reload cannot re-roll it.
9. **`shardsEarned` is a lifetime total, separate from `shards`.** Spending
   shards on an upgrade must not reduce `shardsEarned`, or the `shards`
   contract metric becomes un-completable. **Both faucets must go through
   `awardShards()`**, or the two drift and the metric under-counts.
10. **The offer mix is sane.** Fill contracts repeatedly across many saves and
    confirm no metric is wildly over- or under-offered relative to its share of
    definitions, and that no contract id is ever issued that cannot complete.
11. **Nothing negative, nothing random on tick.** Confirm no shipped effect can
    reduce `perSecond`, and that the only randomness is the salvage strike
    (evaluated once per completion, never per tick).
12. **The milestone faucet pays once per boundary, and the rate RISES with
    depth.** Buy 24 units of a tier, then 2 — the second purchase crosses a
    boundary and pays `milestoneStepPayout(tierIndex, steps) * shardMult`, the
    first does not. Confirm a `max` buy that crosses three boundaries pays for
    three, and that the three are priced at the RISING step rate rather than
    three times the first. Confirm the printed `+N per step` on a service card
    equals `milestoneStepPayout(tierIndexForThatCard, stepsSoFar) * shardMult`
    — it is **not** `SHARDS.perMilestone * shardMult` any more, and a card that
    prints the flat base understates every tier except Worker. Check a DATACENTER
    card against a WORKER card: the deeper tier must show a larger figure for the
    same step count.

### Testing gotcha

`formatRate` **floors** values ≥ 10, so a service displaying `24/s` may
actually be 24.84/s. Do not treat displayed rates as exact when checking
balance by hand — read the underlying state instead.

### Known browser-tool quirks

- After a long session of scripted interaction, a Playwright tab can start
  failing every `click` with an "element is not stable" timeout even though
  the element's box never moves and a dispatched click works. Open a **fresh
  page** to confirm whether it is a product bug or a stale-tab artifact
  before changing any code.
- The game repaints at 10 Hz, which also defeats element screenshots and
  scroll-into-view (same stability timeout). Dispatch clicks from inside the
  page (`el.click()` in `evaluate`) rather than using locator actions.
- **Do not trust `getComputedStyle` readings taken right after
  `emulateMedia`.** In this embedded browser the same property has been read
  correctly in one pass and incorrectly in the next, in *both* directions
  (screen values during print emulation and vice versa). Two causes:
  transitions report their pre-change value when the media query flips, and
  style resolution is intermittently stale. To check print or reduced-motion
  styling, either combine `emulateMedia({ media: 'print', reducedMotion:
  'reduce' })` so no transition is mid-flight, **or verify statically
  against the built CSS**, which is deterministic. Do not "fix" a colour
  from a single emulated reading.
- **Long-lived elements can report a stale computed style indefinitely after
  a media switch.** `:root` custom properties update correctly, but an
  element created during screen rendering may keep reporting its screen
  colour under print emulation — a descendant queried at the same moment
  reports the correct value. The decisive test is to **create a fresh element
  with the same classes after switching media and measure that**; a
  newly-created element cannot have a stale cache. Doing so confirmed the
  print rules were correct while the pre-existing nodes still read as
  coloured.
- **`emulateMedia` does not survive a reload**, so injecting state and
  reloading to test print will silently test screen styling instead. Check
  `window.matchMedia('print').matches` in the same evaluate before trusting
  the result.
- **A backgrounded page never ticks.** The loop is `requestAnimationFrame`,
  which the browser pauses for a hidden tab, and this embedded browser
  reports the page as `hidden` even after `bringToFront()`. Any tick-driven
  behaviour therefore cannot be observed live here. Test the engine functions
  directly, and test rendering by injecting a save that already holds the
  state to be drawn.

---

## Relationship to `../cv`

`src/styles/tokens.css` is shared verbatim with the CV in `../cv`, so the two
look like one product and re-merging later is a file move plus a route. **Do not
put game-specific tokens in `tokens.css`** — the game's extra hues live in a
`:root` block at the top of `game.css` for exactly this reason.

---

## Environment

- Node on Windows. **Node is not installed in WSL**, so use PowerShell rather
  than `wsl ...` for npm commands here. `package.json` declares
  `engines.node: ">=22"` and CI pins Node 22, so treat **22** as the floor you
  are targeting rather than whatever local version happens to be installed.
  (`@types/node` was resolved against a newer major than the runtime; if you
  touch it, bring it back in line with the CI version.)
- The PowerShell terminal only reliably runs the **first line** of a
  multi-line paste; put each command on one line separated by `;`.
- `npx` can block on an "Ok to proceed? (y)" prompt.
- Write git commit messages to a file and use `git commit -F` — heredocs
  mangle backticks.
