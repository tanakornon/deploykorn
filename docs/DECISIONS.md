# Decision log

Why this project is shaped the way it is. Written after the game was built and
split out of a combined CV + portfolio site, so that the reasoning survives
without having to re-derive it.

---

## Why the project was split

The game originally lived at `/game/` inside a personal CV site. The CV's whole
point was restraint: mostly-static, typography-first, no framework. The game
needs substantial JavaScript and a completely different density of interface.

Splitting was chosen over keeping both in one repo because:

- The two have genuinely different release cadences. The CV is finished; the
  game is still being designed.
- Deploying the game should never risk the CV, and vice versa.
- The CV's dev and build story stays clean: no game bundle, no extra route.

It was done *before* the game grew further, because a later split would have
been more entangled.

**The split is designed to be reversible.** Both projects share
`src/styles/tokens.css` verbatim, so re-merging is a file move plus a route,
with no re-theming. The CV README records the same thing from its side.

---

## Architecture decisions

### Pure engine, separate from the UI

`engine.ts` has no DOM, no globals and no storage. All derived values are
recomputed from state each tick rather than cached, which costs a few dozen
multiplications and removes an entire class of desync bug between the rules and
what is on screen.

The practical benefit: balance can be reasoned about, and argued about, without
running a browser. Every multiplier can be checked by hand against
`content.ts`.

### One content file

All balance lives in `content.ts`. Nothing in the engine or the UI hard-codes a
cost, rate or threshold. Retuning the game means editing one file.

### Vanilla TypeScript, no framework

Preserves the zero-dependency approach of the original project and keeps the
bundle small. The interface is a list that updates in place; a framework would
be overhead for no gain.

### Game CSS is a plain global stylesheet

Not a scoped Astro `<style>` block. Astro rewrites scoped selectors to
`.cls[data-astro-cid-*]` and the game's rows are created by TypeScript, so
scoped rules would silently never match — the game would render unstyled with
no error to explain why. This is called out in the agent context because it is
the most likely way to break the project.

### The game gets its own palette

The CV's design language is "exactly one accent", and that is right for a
resume. It is wrong for a game: rarity has to be readable at a glance across a
long list of achievements, and status (ready / cooling / complete) has to be
visible without reading every label.

So the game adds rarity, status and tier hues. Two rules keep this from
becoming a second design system:

- The hues live in `game.css`, **not** in `tokens.css`. `tokens.css` stays a
  verbatim copy of the CV's, so re-merging the two projects is still a file
  move plus a route with no re-theming.
- Colour is never the only signal. Rarity also changes the glyph stroke
  weight and is spelled out as a word; a live tier says "Active"; a cooldown
  prints its remaining time. The palette makes the game quicker to read, it
  does not carry meaning on its own.

### One-page sections became tabs

The interface had grown to five stacked sections, which meant a player who
wanted the upgrade list scrolled past services and contracts every time. Tabs
put each list a single click away and give the header somewhere to show
counts. A sixth (the Lab) was added with the run-anomaly layer.

> **Superseded.** The Lab was removed with the gacha/module layer (see "The
> gacha and the Lab were removed…"), so the game is back to **five** tabs:
> Services, Upgrades, Contracts, Achievements, Reboot. `TAB_IDS` in `state.ts`
> is the current list. The paragraph below about six tabs not fitting is still
> the reason the tablist scrolls rather than wraps — five tabs do not fit at
> 320px either.

At six tabs the row no longer fits at 320px. It scrolls horizontally rather
than wrapping, because wrapping makes the active tab jump between lines as
the badge counts change — a small amount of scrolling is the better trade.

The important detail is that **no panel is ever removed from the DOM**: the
rendering code holds references to rows and updates them in place, and
rebuilding those rows on every tab switch would be wasted work and a source
of bugs. Switching a tab flips `hidden` and `aria-selected` and nothing else.

A standard ARIA tablist pattern is used — roving `tabindex`, arrow keys along
with Home/End — because a row of look-alike buttons with no keyboard model is
worse than no tabs at all.

The HUD (stats, Deploy, abilities, buy quantity) deliberately sits above the
tablist rather than in a panel: those controls are used from every tab.

### The active tab is remembered, which forced a save version bump

Resuming on the last tab is a small quality-of-life win, and it costs a new
field in the save. That is what made `SAVE_VERSION` 3 rather than a silent
shape change.

> **Historical.** That was the version in the pre-split project. This repo was
> split out as a standalone game and its `SAVE_VERSION` restarted at **1**
> (`state.ts`), with an empty `migrate()` ladder, because there is no older
> schema here to migrate from. The v3…v12 history below describes the lineage,
> not the current key.

### One requestAnimationFrame loop

A single accumulator steps the simulation at 10 Hz and renders at 10 Hz, from
timestamps rather than frame counts. Simulation is decoupled from frame pacing
so a slow or fast frame cannot change the outcome, and a throttled or
backgrounded tab stays correct. The frame delta is clamped at 250 ms so a
sleeping tab cannot spike production when it wakes.

Rows are built once and updated in place; text is only written when it actually
changed. This is why the tabs keep panels in the DOM rather than rebuilding
them — the whole rendering strategy depends on those references staying valid.

---

## Game design decisions

### Milestones exist to make the mid-game a decision

Without them, an idle game is a straight line: always buy the newest tier.
Every 25 units of a tier doubling *that tier's* output makes deepening an old
tier compete with broadening into a new one, which is where the interesting
choices are.

### Synergy is capped

Each tier gives +0.5% to the tier below it, capped at +50%. The cap matters:
uncapped, a deep top tier compounds into the whole economy and the lower tiers
stop mattering.

### Abilities replaced the single active button

Overclock — 3× for 30 s on a 180 s cooldown — was the one thing a player had to
decide to do. One button is a thin kind of agency once a run lasts hours.

Abilities are now a table. Overclock is available from the first tick; the
others are earned by achievements, so the later game keeps handing over new
verbs instead of only bigger numbers. A second boost stacks multiplicatively
with the first, which makes an unlock feel like a change in kind rather than a
change in degree.

Two reward kinds exist specifically to keep an old ability relevant:
`boostDuration` and `boostCooldown`. An ability the player stopped pressing
becomes worth pressing again without a line of new code.

**An ability must do something the interface cannot.** The first version of
Provision failed that test: it was a `bulkBuy` that spent the player's compute
on the cheapest affordable service, one unit at a time, through the same path
as the Buy button. It was the Buy button on a two-minute cooldown — it could
not produce a single thing the player could not produce by clicking, and it
was strictly worse than clicking because clicking is free and immediate.

It is now `freeUnits`: tiers the player already runs gain units outright, at
**no compute cost**. That is the line. Everything an ability does has to be
something the player cannot already do by hand, or it is a convenience
pretending to be a verb.

The grant is a flat budget of 25 units, shared across every tier the player
runs. This paragraph used to say the amount was `max(25, 10% of the fleet)` and
that the proportion was the important half — **that was wrong, and measurably
so.** Units are exponential in this game, so a grant that grows with the fleet
grows the number of milestone doublings it crosses: the scaled version paid
+122% production at 250 services, +119,367% at 2,500 and +7,801,405,340% at
6,505. See *Provision was aimed, by construction, at the one tier it could not
help* for the measurements. The budget is flat now, and the lesson is that "make
it scale so it stays relevant" is not a neutral instruction.

> **Superseded.** "Crossing a milestone on the way still pays shards" is no
> longer true and must not be restored. **Contracts are the only source of
> shards.** The milestone faucet was removed because a milestone is crossed by
> buying units, and `applyOffline` credits compute without ever buying any — so
> that reward could not be earned while away. `SHARDS.perMilestone` does not
> exist, and `check:ladder` asserts it stays gone.

### Achievements are the progression spine, not a checklist

Every achievement grants at least one permanent bonus, and the rewards are a
discriminated union rather than a spreadsheet of multipliers. Alongside the flat
multipliers there are rewards that change *how the game plays*: wider tier
synergy, better milestones, richer contracts, faster automation, cheaper
cooldowns, more cores per reboot — and entirely new abilities.

The point is that a mid-game unlock should have a chance of being a new toy
rather than another 2%.

### Rarity and layout are legible without colour

Four rarities (bronze / silver / gold / mythic) drive the medallion tint, the
glyph stroke weight **and** a spelled-out label. Locked cards still show numeric
progress and the exact rewards they will pay out, so nothing on the list is a
mystery box, and a player in greyscale or with a colour-vision difference loses
no information. The palette is a reading aid, not the message.

Cards are grouped by theme (Deploys, Fleet, Output, Idle, Prestige) with a
per-group count. A flat list of forty was unreadable, and themed groups make
"what should I work on next" answerable at a glance. Every reward gets its own
chip, labelled by `describeReward()` from the reward itself, so a renamed
service or a new reward kind cannot leave a stale label behind on screen.

### A service's upgrades live in that service's card

An upgrade like "Keep-alive pool" only means something next to the Worker
count and output it modifies. Pooled into one flat list in a separate tab, the
player had to hold two places in their head to compare "2× Worker for 60K"
against "2× Cache for 700K" — and the tier being modified was not on screen at
all.

So tier upgrades render inside their own service card, in the tier's colour,
with the effect as a badge rather than buried in a sentence. The Upgrades tab
keeps what is genuinely global: deploys, global multipliers, automation and
offline.

Two consequences worth knowing:

- The Upgrades tab badge counts shop upgrades only. A badge that counts
  something its tab does not list sends the player hunting for it.
- Reboot resets services and upgrades together, so both the tiers and their
  nested upgrade lists empty out at once. Rather than showing eight empty
  sections, the nested area is hidden when it has nothing to show.

### Ability availability is derived, never stored

`state.abilities` holds only cooldown bookkeeping. Whether an ability is
unlocked is recomputed from the unlocked achievement set every tick.

The practical consequence is that adding an ability, or moving one to a
different achievement, needs no save migration at all — and a save edited by
hand cannot leave an ability unlocked that nothing grants.

### Contracts are measured from when they are issued

Contracts capture a baseline of their metric on issue and count progress from
there. This lets the same contract recur and remain meaningful at any scale.

An earlier version worded them as absolutes ("Bring 60 services online"), which
showed `0 / 60` to a player already holding 125 — it read as a bug. All contract
copy is now explicitly incremental ("Bring 60 **more** services online").

Contracts used to rotate on a fixed cycle keyed to the completion count, which
meant the same contract could never recur until the pool had been exhausted.
They are now drawn with a seeded weighted pick: cheaper goals are weighted up
for a new player and that bias eases off over the first fifty completions. The
draw is salted with the completion count, so it is still fully reproducible.

> **Superseded.** There is no weighting and there has not been for some time:
> `pickContract` draws UNIFORMLY over the eligible pool, and the salt is
> `contract-pick:<completed>:<slots>`. The bias was removed because a weighting
> has to be kept in step with the content by hand and this one was wrong twice
> (it offered 22% prestige contracts while starving clicks to 4.5%). Sizing the
> objective at ISSUE time already makes every definition the same difficulty, so
> there is nothing to bias away from. See "The RNG stays, and the comment about
> it was a lie" below.

### Automation intentionally does not count as clicking

Automated deploys grant the same compute but do not increment `clicks`, so they
cannot unlock click achievements. Otherwise the achievement list would be
taken over by late-game automation rather than reflecting play.

This predates the drop-rate layer, and it is the reason that layer has no
per-click roll on top of it. The mechanism that stops automation unlocking
click achievements also keeps manual deploys from being a second income
stream — a player who automates is trading clicks for throughput, not
farming the click rewards twice over.

---

## Drop-rate decisions

> **Superseded.** Everything from here to the end of "The Lab was rebuilt
> around placement…" describes the gacha and module layer, which were removed
> in v9. It is kept as the reasoning trail; see **"The gacha and the Lab were
> removed, and shards became the upgrade currency"** below for where it landed.

The user first asked for "RNG / roguelike" and then revised it: **"no need
roguelike but be drop rate / gacha instead"**. That change is the reason the
final design has no per-run build choice. The five candidate systems were
narrowed as follows:

| Asked for first | Final decision |
| --- | --- |
| Per-run mutation chosen from three | **Removed.** Mutations became pullable modules you place. |
| Relic loot on the rarity table | **Removed in v8** — a relic could not be placed anywhere, so the placement rebuild left it with no home. See below. |
| Randomised contracts | Kept: rarity and target are rolled per contract. |
| Timed events | **Removed**, along with the curses and boons they granted — see below. |
| Crits on deploy | **Removed** outright — see below. |

### Why crits were removed

Crits were the one system that was neither a drop nor a pull: a per-click
random roll with no decision attached. Under a gacha framing they were
incoherent — they produced no item, could not be collected, and their only
interaction with the new layer was that five items granted crit chance. Those
five were retuned onto effects the rest of the game already understands
(automation, offline rate, output, cost), so nothing was orphaned.

### Why mutations became placeable rather than staying a choice

Most mutations are trade-offs — `Overclocked` is +80% output and +60% costs.
As a *choice* that is interesting: you weigh the cost. As a *random pull* it
would be punishing, because you would be handed a downside you did not pick
and could not refuse.

Placing solves that without discarding the content: a module does nothing
until you choose to put it somewhere, so a bad roll costs you nothing. It also
gives the collection a second dimension — pulling is "what can I get", placing
is "which tier am I committing it to" — which is what makes the slot limit
meaningful rather than decorative.

Slots bought with shards, because a slot is a spending decision, not a
milestone.

The first design derived slots from reboot count — one free slot, then
another every few reboots. It read as elegant: slots were "a pure function of
permanent state", the same rule ability availability already followed. It was
also wrong, for two reasons.

Reboots already pay out cores and a global multiplier. Adding slots to the
same event gives one action three rewards and makes the *module* system
irrelevant until a player has rebooted several times — the collection, the
pulls and the whole placement layer sit inert for the first hours of play. And a
reboot-gated slot is not a decision, it is an arrival: the player does
nothing to earn it beyond the thing they were already doing.

Buying with shards fixes both. A slot costs the same currency as a pull
(25 / 50 / 100 / 200, `RUN.slotBaseCost` and `slotCostGrowth`), so it is
always a live *choice* against more pulls, and the ceiling of five is
reachable early enough that the module layer becomes the point rather than a
late unlock. It also gives shards a second sink, which a single-purpose
currency never has.

The trade is that `slotCount()` is no longer derived: `slotsBought` is now
stored and sanitized like every other counter. That is the correct trade —
the "derive it" rule exists for values that are a *function* of other state,
and "how many slots did the player buy" is not.

### Why the Lab's flow line was cut, and the tier upgrades multiplied

The pull controls used to carry a line reading "Spend on pulls in the Lab ·
contracts, milestones, events" — a sentence naming the sink and then listing
the sources, both of which were already visible: the sink was the buttons
directly above it, and the sources were a table directly below it. It was
deleted rather than restyled. A line that restates the two things around it
teaches the player to skip lines in that area, which is the opposite of what
a currency row is for.

The slot limit then needed to be findable, so the *sources* were compressed
to one line and the slot note was promoted to a currency-hued status line.
The rule: state a fact once, in the place where it raises a question, in the
form that answers it.

### The slot note answers the player's situation, not a fixed question

The line under "Equipped" had one job in practice — it quoted the price of the
next slot — and it quoted it unconditionally. On a fresh save that meant the
block said "Next slot: 25 shards (25 more needed)" to a player who owned no
modules at all, because relics apply on pickup and need no slot. The number was
correct and the question was wrong: nothing on screen said what a slot was
*for*, so the only thing a new player could conclude was that they were being
asked to spend shards on an empty box.

The fix was to stop treating the note as a price display and let it react to
state, in priority order:

1. **A module is idle and there is room** → "N modules idle — place one
   below." The next move is free, so the note points at it rather than at a
   purchase.
2. **Every slot is full and something is still idle** → "All N slots full — 25
   shards for another." This is the single situation where buying a slot is
   genuinely the next move, and it previously looked identical to every other
   state.
3. **At the ceiling** → report the split ("5 of 6 modules placed") as a fact
   rather than a warning, because choosing five of sixteen is the slot limit
   working as intended, not a problem to solve.
4. **Otherwise** → the price, as before.

The prices still come from `nextSlotCost()` and `slotCount()`, so nothing here
can drift from what is charged. The static hint above it was rewritten to
answer the question the note can no longer always answer — what a slot *is* —
with the price ladder derived from `RUN.slotCostGrowth` rather than the words
"each one doubles", which would have been a second place to update.

Each service also gained upgrades sharing four new mechanisms
(`globalPerOwned`, `milestoneStep`, `serviceSynergy`, `serviceCost`), on top
of the existing doubling. The reason is that a tier's upgrade list used to be
a row of identical `x2`s: the fifth upgrade in a list was the same purchase
as the first, and a low-tier service had nothing worth buying once its
doublings were saturated. (The doubling itself was eventually removed too —
see "The doublings were filler" below.)

### Giving every tier all four mechanisms was a mistake, and it was invisible

The first version of the above gave **every** tier all four mechanisms. That
is 8 x 4 = 32 upgrades, and it produced a Services tab where each tier's list
was the same five rows with a different tier name in the text — the player's
complaint was exactly right: *"I just see all of them are the same upgraded
mechanism with difference name."*

The failure is worth naming because the reasoning that produced it was sound
in isolation. "Every tier should have a tool for every situation" is a
reasonable principle. But a list is read as a *list*: variety that is spread
evenly across every row is indistinguishable from no variety at all, because
there is nothing to compare against. Four mechanisms x eight identical
distributions reads as one mechanism x thirty-two rows.

This paragraph is kept because the *second* fix below fell into the same
trap, and the trap is the useful content: the question is never "how many
did I keep?" but "how many does the player see?"

The first fix was to let each tier have a **signature** — one mechanism that
says something about what that tier is for — and to share the four existing
mechanisms across the eight tiers, two each. That is 16 upgrades instead of
32:

| Mechanism | Signature of | Because |
| --- | --- | --- |
| `globalPerOwned` | worker, cache | the cheap tiers, owned in volume |
| `serviceSynergy` | queue, replica | mid tiers that feed the tier below |
| `milestoneStep` | database, region | the deep tiers you keep scaling |
| `serviceCost` | balancer, datacenter | the pricey tiers, where cost growth is the real limit |

It did not work, and the second failure is the more interesting one. The row
count halved and every mechanism was still covered, so *both* of the metrics I
was tracking passed — 16 upgrades, all four mechanisms represented. The player
reported the same bug again, because the thing they were looking at had not
changed: two tiers that shared a mechanism rendered **identical rows**, so the
list still showed only four distinct shapes, each repeated once. **Counting
mechanisms is not counting distinct mechanisms.** Halving a symmetric
repetition leaves a symmetric repetition.

The real fix was to stop sharing. There are now **eight distinct signature
mechanisms, one per tier**, so no two tiers can render the same row:

| Tier | Signature | Effect |
| --- | --- | --- |
| worker | `globalPerOwned` | every Worker lifts the whole fleet |
| cache | `serviceSynergy` | Cache boosts the tier below harder |
| queue | `serviceIntake` | Queue takes more from the tier above |
| database | `milestoneStep` | Database doubles every 20 instead of 25 |
| balancer | `serviceClick` | Load balancer multiplies manual deploys |
| replica | `serviceMilestone` | Replica milestones are worth more |
| region | `serviceOffline` | Region runs at full rate while away |
| datacenter | `serviceCost` | Datacenter units cost less |

Four of those mechanisms did not exist before and had to be added to
`UpgradeEffect`, `computeStats()` and `format.ts`. The lesson generalises:
**the metric is how many distinct things the player sees, not how many items
exist.**

> **SUPERSEDED.** The table above records the state at the time of that fix and
> is kept as the narrative record only. Roughly half of it no longer ships:
> `serviceSynergy`, `serviceIntake` and `serviceReverseSynergy` were deleted when
> the cross-tier rule landed (a per-tier mechanism must not read a neighbouring
> tier), `serviceOffline` has no user since Worker's row became
> `serviceAutoDeploy`, and `serviceCost` is now one row among thirty-two rather
> than a tier's signature. The shipped design is **four DISTINCT mechanisms per
> tier, 32 in total, all of them scalars or curves that need no cross-tier fold**
> — do not read the mechanisms named here as the current set.

### The doublings were filler, so both slots became signatures

The pass above got the *mechanisms* right and left the *ladder* wrong. Each
tier still carried a plain `serviceMult x2` beside its signature, and a
doubling is a doubling: eight rows reading "x2 Worker", "x2 Cache", "x2 Queue"
are one purchase wearing eight names. Half of every tier's card was still
filler, which is what the player meant by *"all service contains doubling does
not make sense"*.

Worth noting how this was missed twice. The previous two passes both measured
the thing they had just changed — first "how many mechanisms are covered",
then "how many distinct kinds are there" — and both passed while eight rows
were still identical to each other, because neither question was about the
doubling. **A metric that only inspects the defect you just fixed will keep
missing the defect next to it.** The check now asserts that every one of the
sixteen slots uses a *distinct kind*, which is a property of the whole list
rather than of any one row.

**Both slots on every tier are now signatures.** The eight new mechanisms:

| Tier | New mechanism | Scales with |
| --- | --- | --- |
| worker | `serviceCurve` | a second, finer curve (x1.05 per 10 units) |
| cache | `servicePerOwned` | its own unit count |
| queue | `serviceThroughput` | total units owned fleet-wide |
| database | `serviceDepth` | how many tiers are deployed |
| balancer | `serviceCascade` | the unit count of the tier below |
| replica | `serviceGlobalShare` | its share of the fleet, paid to everything |
| region | `serviceAbove` | the unit count of the tier above |
| datacenter | `serviceShare` | its share of the fleet |

The design constraint that matters is in the third column: **each scales by a
different quantity.** They are all "output goes up", and that is fine — the
rows do not read alike because the axis in the text differs ("per deployed
tier", "fleet-wide", "of the fleet", "the tier beneath it"). If you ever swap
one for a mechanism that counts the same thing as its neighbour, the rows
collapse into duplicates again even though the code is different. That is why
the two mirrored mechanisms (`serviceCascade` and `serviceAbove`) sit on
adjacent tiers and form a chain rather than a pair.

Every one of the eight is **bounded** by `cap`. An unbounded multiplier that
grows with a count is the one shape here that runs away badly: the cheap tiers
are owned in the thousands, so a linear rate with no ceiling would invert the
whole ladder. `serviceCurve` is the subtle one — two exponential curves
multiplied together is exactly the runaway this file guards against, so its
multiplier is 1.05 against the milestone's 2, and it is capped at x3.

**What it cost.** Removing eight flat `x2`s is not free. Measured against the
doublings they replaced:

| Fleet shape | New / old output |
| --- | --- |
| every tier at 10 units (the reveal point) | 0.74x |
| every tier at 100 units | 0.83x |
| every tier at 300 units | 0.79x |
| concentrated in the cheap tiers | 1.51x |

So an evenly-spread fleet is about 20% slower and a concentrated one is about
50% faster. That is the intended trade — a flat doubling rewards owning
everything equally, while these reward going deep — but the early-game dip is
real, and it lands exactly where a purchase needs to feel like a purchase. If
the opening wants to be quicker the fix is in `SERVICES.baseOutput`, not in
inflating these rates.

### The neighbour reads were removed, and the tables above are superseded

The two tables above are kept as a record of how the set was *derived*, not as
a description of the game. Seven of the mechanisms they list no longer exist,
because the player's next complaint was about the same thing one level down:
*"not depend on only next services"*.

The rows in question and what was wrong with them:

| Row | Mechanism | Read |
| --- | --- | --- |
| `worker-1` | `servicePair` | its own units **and Cache's** |
| `cache-3` | `serviceSynergy` | how many the tier **below** has |
| `queue-2` | `serviceReverseSynergy` | pushed synergy to the tier **above** |
| `queue-3` | `serviceIntake` | how much the tier **above** gives |
| `balancer-4` | `serviceCascade` | **Database's** unit count |
| `replica-1` | `serviceFloor` | a share of **Region's** output |
| `replica-4` | `serviceAbove` | **Region's** unit count |

**Two costs, and the second is the one that decided it.** The legible one is
that a card's value depended on a card the player might not own, so the ladder
read as a chain of obligations ("buy Region so Replica improves") rather than
as thirty-two independent purchases.

The structural one is that `serviceFloor` read a neighbour's **result**, and a
result is not known until the neighbour has been computed. That single
mechanism forced the whole fleet to be evaluated into a scratch `rawOutput`
record first and summed afterwards — a second loop over every tier that
existed for one row out of sixty-four. Deleting it deleted the phase:
`perSecond` is now built in one pass.

Both `serviceSynergy` and `serviceIntake` were also how a per-tier upgrade
widened the ladder's base synergy, and `serviceReverseSynergy` was how it
pushed the other way. Removing them collapsed `synergyBonus` from five summed
terms to one (`mods.synergy`), so **the tier-above-lifts-the-tier-below
coupling is now purely a content constant** (`SYNERGY`), not something an
upgrade can move. That is the deliberate reading of the request: synergy is
the ladder's own shape, and an upgrade must not reach across it.

The seven replacements all count something the player owns or has done, never
a neighbour:

| Row | New mechanism | Counts | Cap reached at |
| --- | --- | --- | --- |
| `worker-1` | `serviceDeployPerOwned` | this tier's own unit count | 300 Workers |
| `cache-3` | `serviceShardsEarned` | shards ever earned | 3,750 |
| `queue-2` | `serviceReboots` | reboots performed | 4 |
| `queue-3` | `serviceRarity` | unlocked Bronze achievements | 15 (all of them) |
| `balancer-4` | `serviceAbilityUses` | ability activations | 75 |
| `replica-1` | `serviceReturns` | returns from being away | 20 |
| `replica-4` | `serviceShardsSpent` | shards ever spent | 25,000 |

**Two of those seven happened twice, and the second round is worth its own
paragraphs — see "The time-denominated rows were replaced" below.** The first
draft of `worker-1` was `serviceRunEarned` and of `replica-4` was `serviceAge`,
and both were retired along with `serviceTenure` when the time-shaped
quantities came out.

`worker-1` has carried three mechanisms now — `serviceClicks` (hand deploys),
then `serviceRunEarned`, then `serviceDeployPerOwned` — and the first swap
still has something to say:

- **The badge was the real defect.** At `per: 0.0005` it read `+0.05% per
deploy you make`, a figure small enough to read as nothing at all. A rate that
needs four decimal places to be non-zero is a sign the quantity and the rate do
not suit each other, and no re-wording fixes that.
- **`runEarned` was the run-scoped twin of `serviceLifetime`**, so the two rows
made a matched pair on opposite ends of the ladder: one rewarded how far THIS
run had come and reset on Reboot, the other rewarded the whole save. In a FIRST
run the two quantities are identical, which was acceptable because they sat on
tiers eight rungs apart.
- **`runEarned` went for the same reason `serviceAge` did** — see the next
section. It is a compute total, so the rate against it either saturates
instantly or rounds to `+0.00%`.

The measurement moved, and it is reported rather than buried: the contract rate
went **53 -> 69 contracts/hr** (median of 8 seeds) and the milestone rate
**19.9 -> 23.2 steps/hr**. Both remain inside their tolerances, and
`referenceMilestonesPerHour` was moved 20 -> 23 to follow the measurement, as
the seam between the two checkers requires.

Two choices in that table are worth the words.

**`cache-3` counts shards *earned*, not shards *held*.** `serviceReserve`
(`database-2`) already scales with the balance, so reading the balance here
would have made two rows on different tiers move with the same number. The
lifetime total separates them, and only ever goes up.

**`queue-3`'s cap is sized against the real rarity counts (15/13/23/13), and
lands on it exactly.** This is the one requirement that is not about
neighbours at all: `per: 0.1` with `cap: 1.5` on Bronze means all fifteen
Bronze achievements reach +150%, so the blurb states a figure the game can
actually deliver. An earlier draft used `per: 0.01` on Silver, whose thirteen
entries reach only +13% — a badge promising "+200%" next to a row worth a
seventh of that. **A cap that cannot be reached is how a blurb becomes a
lie**, and four rows elsewhere still carry that defect (see below).

**`queue-2` was first written on `totalOfflineEarned` and moved.** The
quantity is compute, so it is exponential, and a linear per-unit rate against
an exponential quantity has only two settings: large enough to saturate on the
tick it is bought, or small enough to print `+0.00%`, which reads as doing
nothing. `serviceLifetime` and `serviceReserve` live with tiny exponents
(2e-12, 5e-4) because the quantity behind them is bounded by a known total;
offline earnings are not. `state.reboots` is a count, ramps honestly, and gave
the prestige axis a second presence beside `serviceCores`.

**What enforces it.** `check:ladder` now fails on any per-tier row using one
of the seven retired kinds, and on any per-tier blurb that names another tier.
The blurb phrases are deliberately narrow — "the tier above", never a bare
"above it" — because the broad version flagged `datacenter-2`'s "the top of
the stack sees every layer below it", which describes the ladder rather than a
dependency. A check that fails on a true statement gets weakened by whoever
hits it next.

### The time-denominated rows were replaced, and so was the run-earned one

Asked for in one line — *"remove runEarned and Time related add something
else"* — and it turned out to be three rows plus the whole vocabulary they
shared. `serviceAge` (hours since the save began), `serviceTenure` (hours this
run) and `serviceRunEarned` (compute this run) all went, and with them
`state.startedAt` stopped being read by the engine at all.

**`serviceRunEarned` was not a time mechanic, and it went anyway.** The request
named it, but the reason it deserved to go is the reason `serviceAge` did: a
compute total spans orders of magnitude inside ONE run, so a linear per-unit
rate against it has exactly two readable settings, and neither is good. Large
enough to ramp in the opening minutes is large enough to saturate on the tick
it is bought; small enough to keep ramping all run is small enough to print
`+0.00%` in the badge, which reads as a purchase that did nothing. The badge had
been worded around the rate to hide that ("grows with this run's earnings"),
which is the tell: **a formatter that has to hide a number is reporting a
mismatch between the quantity and the rate.**

The three replacements:

| Row | Was | Now | Counts |
| --- | --- | --- | --- |
| `worker-1` | `serviceRunEarned` | `serviceDeployPerOwned` | this tier's units |
| `worker-2` | `serviceTenure` | `serviceMatureTiers` | tiers at `MATURE_UNITS`+ |
| `replica-4` | `serviceAge` | `serviceShardsSpent` | shards ever spent |

**`worker-1` became the game's only COMPUTE-powered upgrade.** Every other
click booster is an achievement or a shard-priced flat multiplier, so a player
sitting on a huge compute balance had no way to make their own deploy button
hit harder: clicking improved only through shards. `serviceDeployPerOwned`
reads a unit count instead, and units are bought with compute, so the two
currencies stay in their own lanes while being coupled rather than tangled.
Nothing costs both currencies; the upgrade is still priced in the shard that
buys every other upgrade, and only the QUANTITY it scales by comes from
compute. It is the compute purchase with a shard-priced receipt.

Two things about it were sized against measurement rather than judgement:

- **`cap: 1.5` is 300 Workers, deliberately BELOW the real peak.** Peak units
  per tier in a simulated day are worker **300 / 347 / 413** (min / median /
  max across seeds), so 300 is reachable on the worst seed and comfortable on a
  typical one. It is not set at 413 because the row must stop paying before the
  fleet outgrows it, not after.
- **`probe:value` puts it at 18.8% income for 10 shards (18.77 per shard).**
  That is joint-best in the game with `balancer-3` (18.96 per shard at 50), and
  better than every other 10-shard tier row except `worker-3` (25.00). Rung 0
  being the second-best purchase is a real property of the ladder, not a
  mistake in it: a lower rung is bought earlier, so a good rate there is the
  reward for buying it at all. It was checked against `check:progression`
  after the numbers landed — see below.

**It shares its counter with `worker-3`, and that is accepted rather than
missed.** `worker-3` is `globalPerOwned` on the same tier's units at the same
`per: 0.005`, so the two rows on the Worker card count the same thing and
advertise the same rate. The per-tier rule says each row must scale by a unique
quantity, so this needed a decision rather than a shrug. Two considerations
settled it:

- **They do not collapse into one purchase.** One multiplies the deploy button
  and the other multiplies the whole fleet, so the rows are two different
  things that happen to share a counter. The rule's stated purpose is that
  "rows read as different purchases", and these do — but only if the badges
  make the target the first thing on the line. They do: **"Deploy power +0.5%
  per Worker"** against **"+0.5% all output per Worker"**. Leading with the
  counter on both would have been the duplicate.
- **Every genuinely free quantity was checked first.** `totalUnits` is
  `database-1`'s, `balancedTiers` is `cache-1`'s, `state.clicks` was removed on
  request in the previous round, and the rest of the count-shaped ones are all
  spoken for across the thirty-two rows. The alternative was a row with no
  honest quantity left to read.

**The guard against repeating this is the wording rule, not the counter.** A
THIRD row on this counter would be a duplicate whatever its target, so the next
person to add one has to find a genuinely unused quantity — and the list of
those is short enough that they should check before designing.

**`worker-2` counts BREADTH, which the ladder had no reward for at all.**
`serviceMatureTiers` counts how many tiers hold at least `MATURE_UNITS` (100)
units, so it pays a player who spread the fleet rather than one who poured
everything into the deepest tier. `MATURE_UNITS` is its own constant rather
than a read of `SHARDS.revealAt`'s last threshold, so a deeper reveal gate
cannot silently move what counts as mature. In a simulated day every tier
passes 100 units (medians 235–347), so `cap: 2` at `per: 0.25` is reached
EXACTLY at all eight tiers and the blurb's "+200%" is deliverable.

It is also, measured, a row that does almost nothing for total income — it
buffed a cheap tier's output and the deepest tier outweighs it by four orders
of magnitude. `probe:value` lists it under "output rows below the floor here".
That is a known property of the whole tier ladder (see the probe's own note),
not something this swap introduced, and it is worth stating plainly rather
than discovering later.

**`replica-4` is the mirror of `cache-3`.** `serviceShardsEarned` counts shards
ever earned; `serviceShardsSpent` counts `shardsEarned - shards`, which is what
is GONE. So an idle hoard earns the one and not the other, and the pair rewards
both halves of the reserve decision the shard economy is built on. Its
`cap: 3` is reached at 25,000 spent, chosen against a figure `check:ladder`
prints rather than a guess: clearing every rung once costs **30,000** (held as
`SHARDS.pacing.targetTotal`), so a player who buys out the ladder reaches the cap
near the end. A round figure above that total would have been a cap nothing could
reach in a run — the same defect the five rows above were fixed for.

The badge states the rate per **1,000** shards, not per shard. The real rate is
`0.00012`, which is `0.012%` and rounds to `+0.01%` — exactly the
"reads as nothing" defect that got the hand-deploy row removed. Scaling the
unit up puts the figure back in the range `ratePercent` is built for, and the
threshold beside it is stated as a count instead of a rate for the same reason.

**The measurement did not move much, and that is the point.** `check:progression`
reports a contract rate of **70/hr** against the reference **65** (drift 8%,
tolerance 50%) and a milestone rate of **25.0/hr** against **23** (drift 9%,
tolerance 75%), so no constant needed to follow the content this time. That is
the outcome to want from a swap whose purpose was legibility rather than power:
three rows changed what they count, and the economy's shape did not notice.

### Five per-tier caps were unreachable, and the badges overstated them

> **FIXED.** Every row below now caps at a figure the game can actually
> deliver, and the badge prints `1 + cap`. The header used to read "Four
> per-tier caps are unreachable, and the badges overstate them ... *not* fixed
> with them"; the table is kept as the record of what was wrong, with the
> resolved value in a fourth column.

Found while measuring the replacements above, and *not* fixed with them
because it is a separate decision about four rows that were not touched:

| Row | Badge said | Reachable was | Now |
| --- | --- | --- | --- |
| `cache-2` | max x2.5 | x2.28 | `cap: 1.28` on 64 upgrades — x2.28 |
| `queue-4` | max x3 | x2.6 | `cap: 1.6` on 8 deployed tiers — x2.6 |
| `region-1` | max x2 | x1.6 | `cap: 0.6` on 6 ladder steps — x1.6 |
| `datacenter-2` | max x2.5 | x2.2 | `cap: 1.2` on 8 deployed tiers — x2.2 |
| `datacenter-4` | max x3.5 | x2.5 | `cap: 1` — x2, and the BLURB was the wrong one |

Each one's *blurb* states the reachable figure correctly ("up to +128%",
"+160%", "+60%", "+120%"), so the two surfaces disagreed: the sentence was
honest and the badge beside it was not. The badge prints `1 + cap`, which is
the ceiling the arithmetic allows rather than the ceiling the game allows.

`datacenter-4` was the same disagreement with the opposite cause: its cap WAS
reachable, so the blurb was wrong and the cap was right. The fix there was to
correct the sentence.

**The rule the fix settles: size `cap` from the content's own maximum, not
from headroom.** `deployedTiers` cannot exceed `SERVICES.length`, the upgrade
pool is `UPGRADES.length`, the ladder has eight steps — so the honest cap is
that product, and it lands the badge exactly on the figure the blurb already
promised. This is the same reasoning `queue-3` was sized by, and the same
reason an unreachable cap is worse than a weak one: a badge is a promise about
a number, and in this game the badge is often the only thing a player reads.

### The Lab was rebuilt around placement, and relics did not survive it

The last overhaul moved the Lab from "equip a bonus" to "place a module on the
tier it belongs to". The driving complaint was that the Lab's whole output was
a list of passive numbers with no position to them: a module was either on or
off, and *where* it was on meant nothing because it was nowhere in particular.

Four decisions, in the order they mattered.

**Every module is bound to one tier, and is placed into that tier's socket
row.** `ModuleDef.serviceId` is required, and `npm run check:lab` asserts that
every service-bound effect on a module names the same tier the module does.
*(`check:lab` no longer exists — it went with the Lab and the module layer.
`scripts/check-upgrade-ladder.mjs` and `scripts/check-progression.ts` are the
two checkers in this repo.)* A
mismatch would be invisible from the UI — the row would read "Worker" while the
numbers moved on Cache — which is the same class of silent failure as the
hardcoded kind list above, so it gets the same treatment: a check, not just a
fix. The binding is also why `state.placed` can be a flat list of ids rather
than (module, tier) pairs; a module that could go anywhere would need the pair,
and the point of the design is that it cannot.

**Relics were deleted.** A relic applied permanently the moment you owned it and
needed no slot. That was a reasonable second axis when the Lab was a list of
passives, and it is *incoherent* once the Lab is about position: a relic could
not be placed anywhere, so it had no socket, no row, and nothing to say about
which tier it belonged to. Keeping them would have meant two item kinds with
contradictory rules and a pool of 40 where 24 of the items were exempt from the
new mechanic. The pool went 40 → 16, which also made the odds table simpler:
one kind, one rarity roll, no "which kind did I get" second question.

Deleting them was bigger than it looked — roughly 194 references across 11
files, including a contract drop path, a luck stat and two contract objectives.
Worth recording: **`LOOT.milestoneChance` and `LOOT.dropWeights` were defined
and never read.** Dead config that looks live is worse than no config, because
editing it appears to do something.

**All 16 modules were re-authored to be service-bound, because none of them
could be placed.** This is the part that was easy to miss. Every existing
module was fleet-generic — `globalMult`, `costMult`, `clickMult`, `offlineCap`,
`autoRate`, `contractReward`, `relicLuck`, `milestone`. Not one used
`RunEffect.serviceMult`, which was the only service-targeted kind that existed
and which folded into `mods.runService`. So "attach modules to services" was
never a wiring change; the content had no tier to attach to.

The rebuild therefore added five service-bound `RunEffect` kinds, deliberately
named after the `UpgradeEffect` kinds of the same name, and made
`computeStats()` **seed** its per-tier channels from the placed modules before
folding upgrades on top:

```ts
costPerService[service.id] = mods.runCostPerService[service.id] ?? 1;
```

That one line is why the naming matters. Seeding rather than adding a second
parallel channel means a `serviceCost` module and a `serviceCost` upgrade write
to the same number and compose, without either source knowing the other exists.
It also means a module is charged for correctly by `costOfWith()`, which reads
`stats.costPerService` at every call site — anything not in that table at that
point would have been free.

**The 16 modules are still trade-offs, and that is not the same thing as the
removed curses.** Modules may carry a penalty (a `serviceCost` above 1, a
`clickMult` below 1). The distinction that matters is *consent*: a curse was
inflicted at random and could not be refused, while a module does nothing until
the player places it and stops doing anything the moment they remove it. An
opt-in trade-off is a decision; an inflicted one is a punishment. `check:lab`
*(removed with the Lab)* enforces that every module has both a downside and an
upside, so a module can never be a free upgrade wearing a rarity.

One thing this deliberately does *not* gate: placing a module for a tier you
have not deployed. A player can pull a Datacenter module on their third pull,
and it should sit in that socket waiting rather than being hidden. Hiding it
would take back the reward the pull just granted.

### The Lab dead-ended at completion, so duplicates level modules up

With a 16-item pool and a flat duplicate refund, the Lab **finished and turned
hostile**. Measured over 400 batches: the collection completes at about **200
pulls**, and from that point the expected return on a pull is

$$0.70(3) + 0.24(8) + 0.054(30) + 0.01(120) = 6.84 \text{ shards}$$

against a cost of 10. So the gacha becomes expected-value *negative* while the
player is still playing, and shards keep arriving from contracts and milestones
with nothing to spend them on. That is not a content gap, it is a trap: the
button stays live and quietly takes currency for nothing.

Duplicates now **level the module up** instead (`PULL.levelStep`, capped at
`PULL.maxLevel`). A level multiplies the module's *benefit* magnitudes and
never its penalties, so a duplicate is always a win. Measured after the change:
~200 pulls to complete, ~**490 pulls to max every module**.

Two details are load-bearing:

- `levelScaledEffect()` is the single place a level is applied, and **the UI
  calls it too.** A level-5 module whose card still printed the authored
  "+150%" would be understating its real effect by 40% — the same
  interface-disagrees-with-the-simulation bug as the badge overflow and the
  relic-drop payout, so the rule is shared rather than reimplemented.
- The refund path still exists and fires only once a module is already at
  `maxLevel`. That keeps shards worth something at the very end of the track
  instead of deleting the machinery.

At full max there is genuinely nothing left to gain, so `rebuildLab()` disables
the pull buttons and says the collection is complete. That is the honest
version of the endpoint: a finished system is fine, a finished system that
still accepts payment is not.

### A hardcoded kind list made four upgrades render nowhere

Adding those four mechanisms then exposed a second, worse bug. `ui.ts` kept a
hand-maintained `TIER_KINDS` array to decide which upgrades belong in a service
card rather than the shop. The four new kinds were not in it, so they were
classified as shop rows — but the shop buckets rows by group, and its group
list has no `services` entry, so **a row in an undeclared group is dropped on
the floor.**

The result: four upgrades, on four tiers, that existed in `content.ts`, were
correctly priced, revealed on cue, and affected the simulation — and could not
be seen or bought. `check:ladder` passed the whole time: it asserted that the
signatures used distinct kinds, and they did. Nothing in the pipeline was
looking at whether the rows reached the DOM.

The fix is to delete the duplication rather than extend the list. `ui.ts` now
asks the formatter, which is the same source the shop uses to bucket:

```ts
function isTierUpgrade(upgrade: UpgradeDef): boolean {
  return describeEffect(upgrade).group === 'services';
}
```

A kind is a tier upgrade exactly when the formatter files it under
`services`, so a ninth mechanism needs no change in `ui.ts` at all.
`check:ladder` additionally asserts that every group the formatter can return
is one the UI renders — the check that would have caught this.

The broader lesson: **a hand-maintained list that mirrors a derived fact is a
correctness bug waiting for the next addition.** The failure mode is silent —
no error, no crash, content simply stops reaching the player — so it also has
to be *checked*, not merely fixed.

The names carry the same intent. Each is a well-known engineering keyword —
Zero-copy, Bloom filter, Little's law, Write-ahead log, Consistent hashing,
Raft quorum, Anycast, Bare metal; Amdahl's law, Cache invalidation,
Backpressure, B-tree fanout, Keep-alive, Metcalfe's law, Follow-the-sun,
Moore's law — so the mechanism is legible *before* the numbers are. A player
who knows what a write-ahead log is knows what the upgrade does. Ids were
deliberately left alone: they are save keys and `check:ladder` anchors on
them, so `worker-1` stays `worker-1` no matter what the row is called.

Two consequences of the original split had to be handled. `globalPerOwned`
went from eight tiers to one, so at the old cap it would have fallen from
+200% to +50%, which is a large silent nerf; its cap is therefore raised to
0.5 (reached at 100 units), with the global shop upgrades covering the rest.
And the level count dropping meant the shop needed more to do, so eight global
upgrades were added — including the two that act on contracts, which is the
only path from that panel into the Lab that does not go through compute.

Two of those mechanisms needed bounds that are worth stating, because both
are non-linear and were unbounded in the first draft:

`milestoneStep` reduces the milestone step, and milestone rewards are
exponential. Cutting the step from 25 to 20 over 1000 units turns 2^40 into
2^50. It is therefore capped at `MILESTONE.stepBonusMax` extra steps (3),
bounding the benefit at 8x. `globalPerOwned` *sums* its individually-capped
bonuses rather than multiplying them, so a second copy is never worthless
once the first saturates.

### Contracts were paying shards nobody could see

The heading said the reward was compute. It was not: `collectContracts()` has
always awarded `PULL.shardsPerContract` as well, scaled by rarity. So the
complaint ("the contract reward is only compute") was a genuine bug with an
unusual shape — the economy was correct and the *interface* was lying by
omission. The card now reads `N compute + M shards`, computed from the same
`shardMult` the engine charges with, so the figure shown is the figure paid.

Two structural changes went with it. Concurrent contracts went from 3 to 5,
because the panel is the recurring-obligation screen and three made it feel
like a side errand. And the objective list went from 11 to 18, adding three
metrics — `milestones`, `pulls` and `modules` — so that contracts can ask about
the Lab and about depth rather than only about compute and clicks. `milestones`
is derived from the unit counts rather than stored, for the same reason
`slotCount()` is: it is a pure function of state, and a stored copy would need
invalidating on every purchase.

### The per-tier mechanisms had to be recalibrated from the cost curve

The per-tier mechanisms above shipped with numbers that looked reasonable per
tier and were wrong in two places. Both had the same root cause, and it is
worth stating because it will bite again: **costs are exponential in unit
count (`1.15^N`) while the prices and rates were authored on a linear
assumption.**

**`globalPerOwned` was scaled per tier, which made most of it unreachable.**
The original rates ran from 0.0001 per unit on Worker to 0.02 on Datacenter,
on the theory that a cheap tier holds more units than an expensive one. It
does not: every tier shares `costGrowth: 1.15`, so

$$N_w - N_d = \frac{\ln(\text{baseCost}_d / \text{baseCost}_w)}{\ln 1.15} \approx 121$$

a Worker holds only about 121 more units than a Datacenter, not 200x more.
The consequence was that the advertised "+50% max" was reachable on three of
eight tiers. Worker needed **5,000 units** for its own bonus and delivered
**+1.5%** — on the tier the mechanism was specifically introduced to rescue.
The realistic total was ~3.15x global, concentrated in the top three tiers,
which is the inverse of the intent.

The fix is a single uniform rate: `per: 0.005`, `cap: 0.25` on all eight, so
every tier caps at **50 units** and the whole set is worth +200%. Cheap units
being worth as much as expensive ones is only true if the rate is uniform, so
tier-flavoured rates are not a missed opportunity to be restored later.

**`serviceCost` was ~46x too cheap on every tier.** The mechanisms were gated
at 10 / 25 / 50 / 100 units while the prices were hand-set, and between 50 and
100 units the compute a player must have spent grows by 1.15^50 = **1084x**
while the authored prices grew about 13x. So `worker-cost` cost 2,000,000 when
100 Workers already implied ~117,000,000 of spending — the fourth upgrade of
every tier was a rounding error with no decision attached.

Both are now *derived* from the tier's own curve rather than authored:
buying N units costs about `6.67 * baseCost * 1.15^N`, so an upgrade revealed
at N units is priced at roughly 2.5x that. Every mechanism is therefore the
same relative decision at every tier, which is what the reveal ladder was
supposed to express all along. `scripts/check-upgrade-ladder.mjs` enforces it
over all 32 upgrades and fails outside a 1.5–4x band; the current spread is
2.49x to 3.31x (the reveal-10 entries read high only because the asymptotic
spend estimate overstates the exact sum at small N).

The reveal *order* also had to change, because it was value-inverted — the
weakest effect (`serviceCost`, worth about +4%) was gated last and priced
lowest while the strongest (`globalPerOwned`, a global multiplier) was gated
first. It now runs weakest-and-cheapest first: cost (10), synergy (25), global
(40), milestone (60).

One deliberate non-change: the Lab's two sinks are still wildly different in
scale — all five placement slots cost 375 shards, about **0.8 hours**, while
completing the 40-item collection is a coupon-collector problem worth roughly
**2,180 pulls, or ~46 hours**. A 60x spread means every slot decision resolves
in the first hour and then the Lab is one long grind with no second goal. That
is left alone for now because the collection is meant to be the long-term
goal, but it is the most likely place the Lab runs out of road.

### Randomness is seeded, stateless and salted

Every random outcome comes from `roll(seed, salt)` — a pure function of one
stored integer plus a string naming what is being rolled.

The alternative was a conventional PRNG with a cursor: seed it once, then
draw from it in order. That was rejected for two reasons. The cursor has to be
persisted, so a save taken mid-sequence resumes one draw out of step and
silently changes every subsequent outcome. And a cursor makes an outcome
depend on *history*: whether the fourth pull is good would depend on how many
unrelated rolls happened before it.

Salting removes both. There is nothing to persist, and "the fourth pull" is
the same item regardless of what else happened. It also means
`computeStats()` — which runs ten times a second and caches nothing across
ticks — cannot re-roll anything, because a value derived from `(seed, salt)`
is stable by construction.

The cost is that the game is reproducible, so a determined player could in
principle compute future pulls from their save. That was judged acceptable:
it requires reverse-engineering the hash, and the alternative — a server —
is out of scope by design. It also enforces the anti-save-scumming property
the user asked for, for free.

### Rolled results are stored; derived facts are not

This looks like it contradicts the rule that ability availability is derived
rather than stored. It is the same rule applied correctly in each case.

Ability availability is a function of permanently stored data (achievements),
so storing it too would create two sources of truth. A rolled result is not a
function of anything in the save — it is an *input*. A contract's rolled
rarity and target are therefore stored, because re-deriving them on each load
is exactly the re-roll the design exists to prevent.

### Pity is stated rather than hidden in the weights

The odds shown in the Lab are the real rates, and the pity guarantee is a
separate, visible promise applied on top by `rollPullRarity()`.

The tempting alternative is soft pity — quietly raising the gold chance as the
counter climbs. That was rejected because it makes the displayed table
untrue. A player reading "Gold 5.4%" and receiving a gold is entitled to
believe both numbers mean what they say. A guarantee they can *see* is a
promise; a rate they cannot verify silently changing is a lie.

### Duplicates refund rather than being prevented

The pool is finite, so a pull landing on something already owned is
inevitable, and the refund is what keeps a late pull from being worth nothing.

Excluding owned items from the roll was rejected: the displayed odds describe
the pool, and rolling within owned-only would make the last item of a rarity a
certainty that the table never promised. The refund keeps the arithmetic
honest instead.

Measured shape of the curve (40-trial simulation of the configured weights):
first mythic around pull 90, half the collection by pull 50, 30 of 40 by pull
210, the whole set around pull 2 800. That long tail is characteristic of a
gacha and is the reason the refund exists. Shard income is sized so a pull
costs roughly one contract, which is what decides whether the tail is a
long-term goal or an impossible one — the first draft was about a third of the
current rate and put completion out of reach.

### One effect vocabulary

Built naively, four systems means four effect systems that drift apart at
different rates. Instead everything is expressed as `RunEffect[]`, so there is
one fold in the engine and one label generator in `format.ts`.

### The RNG half of the multiplier is clamped

Placed modules, achievements, cores and upgrades all multiply into
the same total. Five of those the player earns deliberately; the RNG half is
the one they do not control. Stacking everything reaches roughly 50x raw.

Rather than trusting each table's numbers to stay modest — which is how the
milestone bonus got out of hand before — the RNG component is clamped in one
documented place. A good pull stays exciting; it cannot redefine the curve.
Tier-specific bonuses are exempt because they are authored small and touch a
single tier.

### The collection is visible, including what you do not have

Every item is listed from the start, grouped by rarity, with unowned entries
dimmed and their effect hidden. Fog-of-war is the gacha convention, but this
project already has a "never a mystery" rule for achievements, and revealing
an item's effect is part of the reward for pulling it.

### Randomised contracts keep their scale, not just their worth

Contract rewards are scaled to current output, so a contract is always worth
roughly the same amount of progress. Rarity therefore varies the *scale* of
the objective and the payout together rather than making a rare contract a
better deal — a gold contract asks for 1.8x and pays 2.2x, so it is a bigger
commitment with a better return, not free money.

The deterministic rotation this replaced could not recur, which made the pool
feel like a fixed cycle. A seeded weighted draw lets the same contract come
round again while still being reproducible.

> **Superseded, on both points.** Contracts no longer roll a rarity at all:
> difficulty is sized at ISSUE time from the player's production, so there is
> nothing left for a rarity to vary, and the payout derives from the declared
> `cost` band rather than from a per-draw roll. And the draw is UNIFORM over the
> eligible pool, not weighted — see "The RNG stays, and the comment about it was
> a lie". The section title is still the right instinct; the mechanism that
> delivers it changed.

### Events were removed entirely, not fixed

The timed-event layer was the game's biggest source of *moments* — a banner,
a countdown, a decision, a payout — and it was removed anyway, because the
player asked for the design to be optimised for one thing: giving them
dopamine.

Read against that goal, the layer failed in four ways.

**The choice was decorative.** In all ten events the "safe" branch was
strictly dominated. Traffic spike paid 30s safe versus an expected 195s (65%
of 300s) for gambling; Whale contract paid 50s versus an expected 240s. The
mean safe payout across the table was about 34 seconds of production, while
the mean curse it avoided was worth about 54–63 seconds. Taking the safe
option was therefore *worse* than accepting the punishment it dodged, so
"always gamble" was strictly optimal and the player never actually decided
anything.

**It was the only negative system in the game.** Every other mechanic only
ever adds. A random `0.4x for 90 seconds` is the one thing that breaks the
central promise of the genre — that the number goes up and stays up — and it
broke it on the exact readout the player watches.

**Its escape hatch punished the wrong resource.** Removing a curse cost
*cores*, which are permanent progression. The only way to undo a punishment
was to burn the thing the whole prestige loop exists to accumulate.

**It throttled the reward engine.** `DDoS` halved contract payouts, and
contracts are the shard faucet — so a curse directly slowed the gacha, which
is the largest reward beat in the build. The negative system was eating the
positive one.

The usual defence of a curse — that tension followed by relief is itself a
reward — does not apply here, because tension requires the bad outcome to be
avoidable by skill or choice. These were unavoidable, unchosen, and escapable
only at a loss.

Because `addStatus()` had exactly one caller, `resolveEvent()`, deleting
events also deleted **curses, boons, the status HUD and the purge** in one
move — five systems from one decision. That cascade is the reason this was
worth doing rather than merely rebalancing: the alternative was to keep four
systems alive to serve a fifth that was not fun.

The relic-drop path was left intact at the time (`LOOT.contractChance`,
`LOOT.milestoneChance`), so the surprise-loot beat that events used to
provide still existed — arriving from contracts and milestones instead of from
events. Both of those, and the relic path itself, were later removed by the
placement rebuild; `LOOT` no longer exists.

#### Paying for it: the shard faucet had to be re-homed

Events paid a flat 12 shards each on a ~240s cadence, which made them roughly
a third of all shard income. Deleting them without compensating would have
quietly slowed the gacha by that much, which is exactly the kind of silent
nerf that makes a change feel bad.

Rather than guess, a reference session was fixed and both tables evaluated
against it: **12 contracts of mixed rarity, 20 milestones and 15 events per
hour.** With contract rarities drawn at the configured weights, the old tables
paid 12 × 16.31 + 20 × 6 + 15 × 12 ≈ **496 shards/hr**. Raising
`shardsPerMilestone` from 6 to 9 and `shardsPerContract` from 8/16/34/75 to
12/24/50/110 gives 12 × 24.24 + 20 × 9 ≈ **471 shards/hr** — a 5% shortfall,
or about 47.1 pulls per hour against the old 49.6. Close enough that the pull
rate is unchanged in practice, and the numbers are documented in `content.ts`
so the next person can re-derive them rather than trusting them.

---

## Persistence decisions

### localStorage only

No backend, no accounts, works unchanged on GitHub Pages. Progress is per
browser and per origin.

### Versioned with validation

Every save carries a version and passes through `migrate()`. All values are
sanitised on load and unknown ids are dropped, so editing the content tables
cannot resurrect something that no longer exists.

A corrupt save falls back to a fresh start rather than breaking the page. All
storage access is wrapped in try/catch, because `localStorage` throws outright
in some privacy modes rather than returning null.

Version 3 replaced the three flat Overclock fields with an ability map and
added the remembered tab. Rather than discard a burst that was mid-flight when
the player last closed the tab, `sanitize()` reads the old fields and rebuilds
`abilities.overclock` from them. The general lesson: when a field is replaced
by a richer structure, translate it on load instead of resetting it — losing
progress to a schema change is the kind of bug players never forgive.

Version 5 applied the same lesson twice. Mutations became pulled equipment, so
a v4 save's single `mutation` is carried across as **owned and equipped** —
the closest equivalent, and it means a bonus the player was relying on is not
silently switched off. That required `migrate()` to receive the raw parsed
object as well as the sanitized state, because `sanitize()` had already
dropped the old field name.

Version 8 leaned on that same mechanism for a *rename*. `mutations` became
`modules` and `equipped` became `placed`, and `sanitize()` only reads the new
names — so without a bridge the player's entire collection would have
vanished. `migrate()` copies the v7 fields across under the new names, and then
`sanitize()` keeps only the ids that still exist, which is the correct filter:
every module was re-authored around a tier binding, so an id that survived the
re-authoring (`overclocked`, `night-shift`, `liquid-cooling`) is genuinely the
same module, and anything else genuinely is not. `relics`, `relicRolls` and
`relicDrops` disappear with no transform at all — a relic was permanent passive
loot with no equivalent once placement was the mechanic.

After three versions of this, the rule is settled: **a rename is a migration,
not a cleanup.** `sanitize()` is a strict allow-list by design, which means it
silently discards anything it does not recognise — including a field that was
merely renamed.

It also forced a fix to `sanitize()`'s handling of contracts. That function
used to discard every contract on load, which was safe when a contract was
fully described by its definition. Once a contract carried a rolled rarity and
target, discarding it meant re-issuing and re-rolling it — quietly breaking
the one promise the seeded randomness makes. A rule that is correct for
derived data is wrong for stored input, and the two had been conflated.

### `lastSavedAt` is clamped

A save carrying a future timestamp would otherwise produce a negative or absurd
offline reward. Clamping is a safety property, not defensive noise.

### Cross-tab protection

Two tabs share one key. Before writing, a tab checks whether another tab saved
more recently and adopts that save instead of overwriting it.

This was added after finding a real bug: an idle background tab silently
overwrote a newer save from the tab being actively played. Verified by having a
tab running on 111 compute adopt a 9,999,999 save written by "another tab"
rather than destroying it.

---

## Accessibility decisions

- Controls are real `<button>`/`<a>` elements, keyboard reachable in a logical
  order. No click-only or hover-only affordances.
- `aria-live="polite"` is used **only** for discrete events. Per-tick numbers
  would flood a screen reader faster than speech can be delivered, so the stat
  readouts are `aria-hidden` and mirrored by a summary that refreshes on a slow
  timer and yields to any recent announcement.
- The tablist follows the standard pattern: `role="tab"`/`role="tabpanel"`,
  `aria-selected`, `aria-controls`, roving `tabindex` and Arrow/Home/End keys.
  A tab strip that looks like tabs but only responds to clicks is a trap for
  keyboard users.
- Each tab badge is a bare number, so the tab's accessible name spells out what
  it counts ("Contracts. 2 contracts complete.").
- Locked and unaffordable state is conveyed by text, not colour. This holds for
  everything the palette touches: rarity is a word as well as a tint, an active
  ability says "Active", a cooldown prints its remaining time.
- Ability cards for abilities that are still locked stay on screen, disabled,
  with the reason stated. Hiding them would make the unlock invisible.
- Disabled controls use the real `disabled` attribute, so they are correctly
  reported and skipped by keyboard navigation.
- A `<noscript>` notice: the game cannot run without JavaScript, and a grid of
  dead zeros reads as broken rather than as "disabled".

---

## The gacha and the Lab were removed, and shards became the upgrade currency

**One currency per job.** The game now has exactly two: **compute** buys
services, **shards** buy upgrades. Nothing else costs anything.

Before this, shards bought pulls and slots, the Lab's modules buffed the run,
and upgrades cost compute. That meant a player tracking two economies that
looked the same and were spent in the same tab strip, with no rule for which
one to reach for. Worse, the Lab sat *beside* the service ladder: it produced
passive multipliers and a list of numbers, so the only decision in it was
"how much", and the answer was always "yes".

The restructure deletes the middle layer entirely. Shards from contracts and
milestones now buy the 58 upgrades directly, and every upgrade is a permanent,
visible, one-time purchase on a single ladder. The question "compute or
shards?" is now structural rather than a labelling problem: one builds the
fleet, the other deepens it.

### Why the gacha went, not just the module layer

A pull is a random reward with no decision attached. The module system tried to
add one by making placement matter — bind a module to a tier and choose where
it lives — and that was genuinely a decision, but it was a decision *about
which of sixteen pooled things you happened to have*, gated behind a random
draw. Moving content behind randomness did not make playing with it better; it
made the content arrive on a schedule the player did not choose.

Removing the gacha also removed the last source of negative randomness. What
survives is the **salvage strike**: a contract occasionally pays triple, rolled
from the contract's own completion ordinal. It cannot be lost, only not won, so
it is a surprise rather than a gamble — and because the salt is the ordinal, a
reload cannot re-roll it.

### The `RunEffect` cascade

Deleting the module layer deleted a whole type. `RunEffect` existed only
because a run had temporary modifiers, and `Modifiers` carried `run*` fields
that only placed modules could write. With the Lab gone they all lost their
only producer, so they were removed rather than left as dead channels:

- `RunEffect`, `ModuleDef`, `PoolEntry`, `PullOutcome`, `PullBatch` deleted;
- `Modifiers.run*` fields and `baseModifiers` run-fold deleted;
- `engine.ts` lost `levelScaledEffect`, `levelScale`, `moduleLevel`,
  `ownedModules`, `slotCount`, `buySlot`, `placeModule`, `removeModule`,
  `refundFor`, `rollPullRarity`, `resolvePull`, `pull` and the placement model;
- `format.ts` lost `describeRunEffect` entirely;
- `GameState` lost `modules`, `placed`, `moduleLevels`, `pulls`, `pity`,
  `shardsRefunded`, `slotsBought`.

`Stats.costMult` nearly went with them — modules were its only writer — so it
was instead **promoted to a first-class upgrade kind** (`costMult`, on
`cost-1`/`cost-2`). A global unit discount is a natural purchase; it was only
ever a module effect because that is where global modifiers happened to live.

### The new ladder: 58 upgrades on one rung-derived price track

`check:ladder` used to assert *sixteen distinct mechanisms*, one per tier. That
guarantee was about distinctness and it worked, but it produced a ladder where
each tier had only two upgrades, both unusual, and no tier had an obvious
"more of this" purchase. The new shape restores the obvious purchases without
reintroducing filler:

- **Four upgrades per tier (32 total), and all thirty-two are a DIFFERENT
  mechanism.** No kind repeats within a tier or across tiers. An intermediate
  revision had a shared "common pair" (more capacity, cheaper units) on every
  tier, on the theory that a shared shape is what makes the differing half
  legible — but a kind used on eight tiers is one purchase wearing eight names,
  so the shared pair *was* the sameness it was meant to frame. There is no
  common pair any more.
- **Twenty-six global upgrades** covering clicking, fleet multipliers, cost,
  synergy, milestones, contracts, shard income, automation and offline.
- **Upgrade prices are BANDED, and shard income is flat.** The price table is
  seven bands — `10, 25, 50, 100, 250, 500, 1000` — and an upgrade's price is
  whichever band its `rung` falls into. This replaced a geometric ladder
  (`base × growth^rung`, 20 rising to ~1,300) paired with an income ramp
  (`1 + 0.01 × contractsCompleted`, capped 5×). Those two existed together on
  purpose: a price that grows sixtyfold needs an income that grows with it or
  the late game is impassable. Changing one without the other is the trap — a
  flat income against a geometric price is a hard grind, and a geometric income
  against a cheap price is a runaway.

### Why the exponent went, and then why the smooth line did too

The geometric pair was coherent, and it worked — but it made the *card*
dishonest. The number printed on a contract's reward badge was
`perContract[rarity] × shardMult`, where `shardMult` folded a ramp the player
could not see and did not choose. Two contracts showing different shard figures
looked like two different contracts; in fact one was simply later in the run.
The same went for price: every row showed a different cost, and the reason for
the difference was a curve rather than anything the upgrade did.

Removing the curves was right. The first two attempts at a replacement were
both about *how the number moves*, and both got it wrong in the same way:

- **Flat** (every upgrade 300) removed the curve and took the shape with it.
  With no price difference at all, the 58-entry list read as one purchase
  repeated, and there was no reason to buy in any particular order. Flat threw
  away the one thing a price is good for, which is telling the player where to
  start.
- **Linear** (`50 + 10 × rung`) restored the shape but printed **58 distinct
  prices** — 50, 60, 70 … 620. Every row still showed a unique number, so the
  player still had to *read* each one. The complaint that produced this was
  simply "I didn't expect each one to differ by 10".

The lesson is that the problem was never the *shape* of the curve — it was the
**cardinality**. A smooth curve, however gently it rises, gives one number per
row. What a price needs to be is *recognisable*: a small set of values the
player learns once and then knows.

**Bands are that.** Seven prices, so "this one is a 100" is a fact the player
already has, and the difference between the cheapest and dearest is visible at
a glance rather than reconstructed from memory. The bands step by roughly 2×,
which is the fastest growth that still reads as a ladder rather than a cliff.

> **Still true in shape, changed in detail.** The cardinality argument is the
> whole point and it survives. The current tables offer EIGHT distinct prices
> (10, 25, 50, 100, 250, 500, 750, 1000) across TWO tables rather than one, and
> they are keyed on tier depth and shop position rather than on `rung` — see the
> note on `capstoneBandBump` below. Do not quote a price count from this
> paragraph; `check:ladder` prints both tables.

Derived from `rung` rather than authored per upgrade, for the same reason the
ladder is: a hand-written price beside each of 58 entries is 58 chances to
drift from the list order. The band an upgrade lands in also happens to track
"how late this matters", because the rung order already runs cheap tiers first
— 10–25 for Worker and Cache, 250 for Datacenter and the first globals, 1000
for automation and offline.

### A tier's fourth upgrade is its capstone, and it has to cost like one

The band table, on its own, could not express the thing the tiers most needed.
A service's four upgrades occupy four **consecutive rungs**, so they all land in
the same band and cost the same number. The fourth upgrade — the tier's
signature mechanism, the one revealed last and worth the most — was
indistinguishable in price from the first.

Worse, the natural comparison was lost with it. A player looking at Worker's
row and Cache's row could not see that Worker's capstone matters more than
Cache's opening purchase, because Worker's capstone cost 10 and so did
everything else.

`capstone: true` on the fourth upgrade of each tier, priced
`SHARDS.capstoneBandBump` bands higher, fixes both. Two bands rather than one,
deliberately: one is not always enough to clear the next tier's entry upgrade at
the tier boundaries, which is the exact comparison the bump exists to win.

> **Mechanism superseded, reasoning intact.** `SHARDS.priceBands` and
> `capstoneBandBump` no longer exist. Pricing is now TWO tables —
> `SHARDS.tierBands` (a `base`/`capstone` pair per tier depth) and
> `SHARDS.globalBands` (a `through`/`cost` ladder over shop positions) — so a
> capstone takes its own tier row's `capstone` entry rather than a band-index
> bump. The point being made above still holds exactly: a capstone must out-price
> the NEXT tier's entry upgrade, and that is still a comparison across two
> different parts of the tables, which is why it is asserted directly.

The flag is explicit rather than inferred from `rung % 4 === 3`, because the
price rule now depends on it — a rung reshuffle must not silently change which
upgrades are capstones. `check:ladder` asserts there are exactly eight, one per
tier, each on the fourth slot, and that each one costs more than the next
tier's first upgrade. That last check is the important one: it is a *comparison
between two entries in different bands*, so it depends on where the boundaries
fall and cannot be assumed from the bump size alone.

The effects were raised at the same time, since a game-changer that costs two
bands more and does the same thing is just a more expensive row. Every raised
value stays **capped**, which is the rule for anything count-driven: caps moved
from roughly +150% to +200%–300% on the seven upgrades that have a magnitude.
Worker's capstone is the exception — it grants full output while away, which is
binary, so there is no number to raise.

Pacing still comes from **the reveal gates** as much as from price: an upgrade
appears when the fleet has earned it, so the list unfolds over a run — and the
reason it is not yet on screen is legible, where the reason a price was 1,300
rather than 20 was not.

Note what stayed: **the compute payout still scales with output and rarity.**
It has to — a contract paying a fixed amount of compute would be worthless once
the fleet grew, and the whole point of a contract is that it stays worth doing.
The flat side is the shard side, which is the currency the ladder is priced in.

`check:ladder` asserts the bands ascend in both `through` and `cost`, and that
the last band reaches the highest rung — because a lookup past the end of the
table misses *silently*, which would leave the most expensive upgrades in the
list unpriced with nothing to show for it.

### Thirty-two mechanisms is a hard ceiling

Sixteen of the thirty-two are new, and finding sixteen genuinely different
quantities to scale by is close to the limit of what a game this size can
distinguish. The quantities had to be varied in KIND, not just in coefficient:
some count what the player owns (units, cores, upgrades, achievements), some
count progress (contracts, fleet milestones, playtime, lifetime compute), some
count the shape of the fleet (evenly-sized tiers, position on the ladder, the
apex of the deployment), and one acts on the cost curve rather than on output.

Three of them are structurally different from the rest and did not fit the
shared "1 + min(per × count, cap)" shape, so they keep their own channel:

- `serviceFullStack` is flat while all eight tiers stand — a breadth reward.
- `serviceReverseSynergy` pushes a tier's synergy UPWARD, the one mechanism
  that lifts a higher tier from a lower one.
- `serviceFloor` raises a tier toward a share of the tier above it. It reads a
  neighbour's *result* rather than a count, so it is applied after every tier's
  raw output is known, and it is bounded by construction — a floor cannot run
  away the way a count-driven multiplier can.

`serviceEconomy` is the other direction-shifted one: it acts on the cost curve,
and its `cap` is a **floor** on the multiplier so a discount can never make a
tier free. Both of those are safe by construction rather than by cap
discipline, which is the distinction worth preserving if either is ever
retuned.

`serviceShardGain` remains the one per-tier purchase that raises shard *income*
rather than output, closing the loop between the two economies without letting
shard income inherit compute's exponential curve (it is a flat per-unit rate
with a hard cap).

### Save v9

The migration deletes the module/placement/pull fields and renames the contract
metrics. It also seeds `shardsEarned` from the existing `shards` balance if the
counter is zero, because `shardsEarned` is a **lifetime** total kept separate
from the spendable balance: a contract metric that read the balance would be
un-completable by construction, since spending shards on upgrades would undo
the progress it was measuring.

---

## Manual deploy and automation are separate channels

Manual deploy had become decorative. Measured in the browser, a click was
worth **0.05 seconds** of production on a mid-game fleet that had bought
nothing for it — thirteen clicks were worth one tick. The flat base (`CLICK.base`
= 1) is invisible once passive output reaches thousands per second.

The obvious fix was to raise `CLICK.throughputShare`, and that is what shipped
(0.05 → 0.2). But raising it exposed a second bug: `runAutomation()` credited
`stats.clickPower` per automated deploy.

```ts
// before
credit(state, stats.clickPower * whole);
// after
credit(state, stats.autoDeployValue * whole);
```

That single line coupled two systems that had no business being coupled. The
click multiplier tree is ~195× wide: `click-1/2/3` alone are ×18, four
achievements add ~×4.3, and `balancer-3` another ×1.5. Multiply that by an
`autoDeployRate` of 8.5/s and the automation channel was producing roughly
**83× the entire fleet's output**, and — the worse half — it grew whenever the
player bought a *click* upgrade for a different reason. Buffing clicks buffed
automation by the same factor, so any manual-deploy tuning would have been
amplified into game-breaking automation.

So a deploy is now a **fixed slice of production**, independent of the click
tree:

```ts
clickPower      = (CLICK.base + perSecond * CLICK.throughputShare)
                  * clickMult * mods.click * clickFromTiers
autoDeployValue = perSecond * CLICK.autoDeployShare   // 0.15
```

The two axes are now orthogonal: achievements control *how often* a deploy
happens (`autoDeployRate`), upgrades control *how much a manual click is
worth* (`clickMult`), and nothing lets one silently inflate the other.

A second, subtler rule falls out of this: **an automated deploy must never
increment the stored `clicks` counter.** That counter is a lifetime manual
stat, and achievements read it (`deploys-100`, `deploys-25000`). Crediting
automated deploys to it would have let the automation achievements unlock
themselves.

The resulting curve, verified in the browser:

| Stage | per second | per click | seconds of production per click |
| --- | --- | --- | --- |
| Opening (1 Worker) | 0.1/s | 1 | 10 s |
| Mid, nothing invested | 8.61K/s | 1.72K | 0.2 s |
| Mid + `click-1/2/3` | 8.61K/s | 77.5K | 9 s |
| Mid + all click sources | 9.31K/s | 363K | 39 s |

The uninvested floor is low on purpose — clicking should not out-earn a fleet
you have not built. What makes it worth doing is that the click tree multiplies
itself ~195×, so a player who commits to it gets 39 seconds of production per
click, roughly 200× the uninvested value. That is the reward for a specialised
build, and it is now a *choice* rather than something automation collects for
free.

---

## Every named quantity has one glyph and one hue

Two problems, reported together, and they turned out to have the same root.

**Cores were drawn four different ways.** The HUD chip drew a processor. Both
core achievements drew a bolt — the same glyph as Overclock, Surge and the
reboot achievements. One core contract drew a target and the other a crown.
Every one of those was a reasonable local choice, and together they meant a
player had no visual handle for the currency at all: nothing on the
*Core collector* card said it was the same thing as the number in the HUD.

**And it was not just cores.** A shard price was cyan text with no glyph,
sitting on the same screen as a HUD shard balance that had one. A service's
compute price was a bare number. A contract's payout was two coloured figures
with no glyphs at all. Each of those had been decided locally, at a different
time, by a different hand — and the sum of those local decisions was a UI where
no mention of anything was actually recognisable.

The fix is one module, `concepts.ts`, holding the identity of every quantity
the game can name: its glyph (`GLYPH_MARKUP` in `icons.ts`) and its hue (the
`.concept--<id>` classes, which read the existing `--stat-*` tokens rather than
declaring new colours). Markup renders it through `Concept.astro`, TypeScript
through `createConcept()`, and both read the same registry — which is the point,
because the previous failure was precisely that two renderers disagreed.
Shards had already ended up consistent by accident, a single `shard` glyph
used everywhere, which is the outcome to copy rather than the process.

The rule is stated in `concepts.ts` and worth repeating: **if a number is
attributed to a concept, the mention carries that concept's glyph and hue.**
Prose is exempt — a blurb is a sentence, and glyphs inside it make it
unreadable rather than scannable. So is an entity that merely *uses* a
currency: `Amdahl's law` is a Worker upgrade and keeps the Worker glyph even
though it is bought with shards. The rule is about the concept being the
subject, not about every icon that happens to sit near one.

The generated result, verified in the browser:

| Mention | Before | Now |
| --- | --- | --- |
| Contract payout | `250 compute + 24 shards` (two coloured figures) | bolt + shard glyphs, matching the HUD |
| Service price | `Cost 39336Dc` (grey) | bolt + teal, the compute hue |
| Upgrade price | `Cost 250 shards` (cyan text) | shard glyph + cyan, the same pair as the balance |
| Panel shard line | `500 shards` (faint grey) | shard glyph + cyan |
| Deploy button | `+9 compute` (muted grey) | bolt + teal |
| Achievement reward | `Cores x1.15` | cpu glyph + violet |
| Upgrade effect | `+0.05% per shard held` | shard glyph + cyan |
| Reboot fact | `Next core at 106B` | bolt, because the NUMBER is compute |

**Follow-up: the achievement chip had the glyph but not the hue.** Reported as
*"the color of achievement reward badge should be same as reward"*, and it was a
violation of the rule this very section states. The chip gave `--concept` to its
glyph and kept its own text and border in the card's rarity colour, so a
`Cores x1.15` reward rendered as a **violet glyph on gold text** — half a
concept, and the half that reads at a glance. A `sparkle` glyph in the corner is
not what makes a figure recognisable; the figure's own colour is.

The comment above that code argued the split was deliberate, on the grounds that
the chip's colour was its rarity band and the two must not fight. It is a
reasonable-sounding argument that produced a worse result than the problem it
avoided: **the chip's locked/unlocked signal is its OPACITY**
(`.achievement--locked .achievement__rewards`), so the hue was never carrying
that meaning and was free to carry the other one all along.

Now the chip takes `--concept` for text, border and glyph together, and already
does so for both locked and unlocked cards — verified in the browser on a mythic
card, whose `Deploys +100%` chip renders amber rather than mythic violet, and on
the unlocked `reboot-1`, whose `Cores +10%` chip renders violet. Rewards that
name no concept (contract pay, tier synergy, offline cap) keep the rarity tint,
which is what that tint is actually for.

The specificity detail worth keeping: `.achievement__reward--concept` alone
loses to `.achievement:not(.achievement--locked) .achievement__reward`, because
the rarity rule has three classes to the modifier's one. The concept rule is
written with both selectors and placed after the rarity rules, so it wins on the
tie rather than on `!important`.

**The recurring shape of these bugs, now that there are four of them:** a value
is decided in two places, and the second place wins. `.cost--shard` vs
`--concept`, the shard inline SVG vs `GLYPH_MARKUP`, `stats.coreAmplify` vs the
projected ratio, and now a chip's rarity colour vs its reward's hue. Worth
grep-ing for the pattern before adding a second declaration of anything.

One detail worth recording because it was the subtle trap: `.cost--shard` used
to declare `color: var(--shard)` independently of the concept, and
`.upgrade--affordable .upgrade__cost` declared `color: var(--fg)`. Both would
have overridden the concept hue — one leaving the glyph cyan over grey text,
the other leaving it cyan over white. Both now read `var(--concept)`, so the
glyph and the figure cannot disagree. A hue declared in two places is a hue
that will drift.

**Nothing said what a core was worth.** `PRESTIGE.bonusPerCore` was mentioned
in exactly one place: a sentence in the Reboot panel's paragraph. The HUD chip
showed a bare count, and the panel showed a bare count, and the number the
player actually wanted — *how much production is this?* — was never on screen.
Both now carry it: the HUD chip and the "Cores held" fact state the aggregate
(`+50% production`), and "On reboot" states the delta the action would add
(`+60% from this reboot`), which is the figure that actually answers "should I
press the button". With no cores held the aggregate is a meaningless zero, so
that case falls back to the per-core rate (`+5% each`) — the mechanic is taught
before it can be felt.

**And cores were too weak.** They cost a whole run each time and paid +2%, so
25 cores — which requires `runEarned ≥ 625 × threshold` — bought +50%, less
than a single tier's first milestone. `bonusPerCore` is now **0.05**: 10 cores
= +50%, 25 = +125%, 100 = +500%.

It stays linear on purpose. Cores survive every reset, so a compounding term
here would eventually outgrow every in-run multiplier and collapse the game
into "reboot until the number is big enough". The straight line keeps a run and
its accumulated prestige comparable in weight, and it is a shape the player can
predict — which is the same reasoning that rejected smooth shard price curves
elsewhere in this document.

---

## The upgrade currency: `shards` → `circuits` → `credits` → `shards`

The currency upgrades are bought with was renamed twice and then put back. It
started as **shards**, was briefly **circuits**, then **credits**, and is
**shards** again. Nothing about the economy changed at any step — same faucets,
same sink, same numbers — because every step was a naming decision rather than
a balance one.

**Rename 1: shards → circuits.** The name had outlived its justification.
Shards were conceived as *flakes of salvage*, but the game is a catalogue of
cloud infrastructure — workers, caches, queues, balancers, regions — and a
currency named after fantasy salvage sat oddly beside it.

**Rename 2: circuits → credits.** *Circuits* is a fine word, but it sits one
letter and one concept away from **cores** — the prestige currency — in a game
where both are things you accumulate. The two were genuinely confusable, and
the glyph work had already exposed it: the circuit mark had to be designed
specifically to avoid looking like the cores processor, which is a sign the
*name* was the problem and the artwork was doing make-up.

**Revert: credits → shards.** Credits was a sound word and a sound glyph, and
it was still the wrong call, because the first rename was answering a question
nobody had asked. Shards-vs-infrastructure was a *thematic* mismatch — the
fiction around the currency was already salvage, and the blurbs already talked
about decommissioned hardware — while circuits-vs-cores was a genuine *clarity*
problem. Trading a working name for a new one to fix a stylistic preference cost
two migrations, three glyphs and a day of churn, and the original name was
never actually broken. The revert is the cheapest outcome available: the
economy is back where it started and only the version number remembers.

**The lesson is about which problems are worth paying for.** A rename is one of
the most expensive changes you can make to a shipped game — it touches save
fields, stored id arrays, glyphs, every label, and the docs — so it should be
reserved for a problem that *breaks* something. "Circuits confuses players with
cores" qualified. "Shards is a salvage word in an infrastructure game" did not;
it was a taste disagreement with a cost of three migrations.

**A rename is a migration, not a cleanup.** `sanitize()` is a strict allow-list
read by field *name*, so a save carrying `circuits` or `credits` looks up
`shards`, finds nothing, and silently zeroes the player's entire balance. The
rule has now been learned three times (version 8 taught it first, when
`mutations` became `modules`). Save v12 bridges both interim names. Note that
the bridge still has to exist **even though the currency is back where it
started** — v10 and v11 saves are in the wild with the interim names in them,
and "the name is the same as it was" is not a reason to skip the translation.

**Two traps, both found by writing the bridge rather than by playing:**

1. *Ordering.* The v8 → v9 step seeds `shardsEarned` from the balance, because
   a v8 save has no lifetime counter and starting it at zero would make an
   "earn N" contract instantly complete. A save arriving from v10 or v11 has
   neither `shardsEarned` *nor* `shards` — `sanitize()` has already zeroed both
   — so the seeding would have seeded from zero. The rename bridge therefore
   runs **before** the v9 step.

2. *Identifiers, not just fields.* Four upgrade ids are literally `shards-1`
   through `shards-4`, and `upgrades` is a stored array that `sanitize()`
   filters by id. The interim names produced `circuits-1` and `credits-1`, so a
   returning player's four income upgrades were dropped on sight, silently, and
   **no amount of balance-field bridging would have caught it**. The bridge
   rewrites those ids as well. A rename reaches every identifier derived from
   the name, and stored arrays of ids are the ones that do not announce
   themselves.

All four carry-over paths were verified by hand — v8, v9, v10 and v11 saves,
each re-saved as `v: 12` with no legacy keys left behind and their bought
upgrades intact.

**The glyph was redrawn three times**, and every redraw was forced by a rename
rather than by the artwork. Faceted gem ("shards" — a cut stone reads as money
and as a piece broken off something), a routed trace with solder pads
("circuits" — hardware), a payment card with a magstripe ("credits" — money),
and now the gem again. The trace is the interesting failure: the most
*technically* apt drawing of the three and the worst choice, because it sits in
the same visual family as `cpu`, the cores glyph, so the icon reinforced the
exact confusion the rename existed to remove. **The mark has to agree with the
word, not with the setting.**

**Note for readers:** sections of this document written between the renames use
whichever name was current at the time — some say "circuits", most say "shards".
The passages are historically accurate as written; only the noun has moved, and
it has moved back.

---

## Unspent shards now produce, and cores amplify that

The upgrade currency had a problem that only shows up at the end of a run.
There are a finite number of upgrades. Once a player has bought them all, shards
keep arriving from contracts and milestones and there is nothing left to spend
them on — the currency becomes a number that goes up and does nothing. It was
reported exactly that way: *"in the end keeping shard is do nothing just useless
currency."*

The fix gives the balance a job: **every shard you are not spending is buying
production.** The interesting part is the curve, because the obvious version of
this is a trap.

**Linear was rejected, and the numbers are why.** Shard income is flat, but it
is multiplied by `shardMult` and it accumulates for the life of the save, and
`applyReboot()` deliberately does not clear it. So a mature save holds
thousands. At 1% per shard linear, 10,000 held is **+10,000% production** — more
than every other multiplier in the game combined. That does not read as a bonus;
it reads as the correct way to play, and it makes *never spending* strictly
better than engaging with the ladder. A mechanic whose optimum is "stop using
the other mechanic" is a bug wearing a reward's clothes.

**The square root is the whole design.** `reservePer * sqrt(shards)` pays
forever without running away:

| Shards held | Bonus |
| --- | --- |
| 100 | +10% |
| 1,000 | +32% |
| 10,000 | +100% |
| 1,000,000 | +1,000% |

It is deliberately **not capped**. A cap would only move the wall: the reserve
would stop mattering the moment the player reached the ceiling, which is the
original complaint one tier up. The curve does the capping, and it keeps paying
at every scale.

**The reserve also fixes a second thing nobody asked about.** Once holding has
value, spending has an *opportunity cost*, and the currency stops being
frictionless. P shards spent costs `rate * (sqrt(S) - sqrt(S-P)) * amplify` in
permanent production. At 100,000 held, a 10,000 purchase forfeits roughly +38%
forever. That turns "hold or spend" into an actual decision, which the ladder
never had — previously, buying an upgrade was strictly correct whenever you
could afford it.

It does create a balance constraint worth stating: **every late upgrade must be
worth more than the reserve it consumes**, or the top of the ladder is a trap
that punishes the player for engaging with it. This is the rule the twelve new
globals were sized against, and the number to check if any of them is ever
retuned.

**Cores were repurposed rather than retuned.** They used to be a flat global
multiplier (`1 + 0.05 * cores` folded into `globalMult`). They are now a
multiplier on the reserve bonus instead:

```ts
reserveBonus = SHARDS.reservePer * sqrt(shards) * (1 + PRESTIGE.bonusPerCore * cores)
```

Two reasons. A flat bonus is the least interesting shape a prestige currency can
have — it becomes a constant the player stops thinking about — and with both
terms additive, cores and shards were independent levers that never interacted.
Multiplying them makes prestige and saving *synergise*, which is the point of
having two long-horizon resources at all.

The cost is real and was accepted knowingly: **a core is worth nothing to a
player holding no shards.** That survives only because shards are kept across
Reboot, so the reserve is already standing when the first core is banked — a
Reboot never returns to a state where its own reward is inert. If shards were
ever made run-scoped, this mechanic would break and the core bonus would have to
go back to being additive.

**Two UI bugs were found by testing the numbers rather than the pixels.** Both
were silent, and both would have made the new mechanic look wrong without ever
failing a type check:

1. `stats.reserveBonus` was initially the *pre-amplifier* bonus, while the HUD
   labelled it "production". At 200,000 shards and 40 cores that displayed
   `+447%` when the true bonus was `+1342%` — a lie that grows with prestige,
   which is the worst direction for it to be wrong. Fixed by folding the
   amplifier into `reserveBonus` so the reported figure is the one production
   actually receives.
2. `ratePercent()` rounded anything at or above 1% to whole percent, so the new
   `+1.5%` upgrade displayed as `+2%` — overstating the purchase by a third. It
   now keeps one decimal above 1% and trims a trailing `.0`, so `5%` still
   reads as `5%`.

A third was caught in the same pass: the core-amplifier note used `toFixed(2)`,
which renders a large banked core count as `×2990210229.95`. It now goes through
`formatMultiplier()`, the same formatter the HUD uses for the global multiplier.

**The ladder grew to match.** Seventy-two upgrades (32 per-tier + 40 global),
over eleven price bands. The first seven bands were left byte-identical so that
every pre-existing upgrade kept its exact price — including capstones, whose
price is their own band plus a bump, so moving a single boundary would silently
reprice eight upgrades. `check:ladder` enforces the shape and reports the band
table.

The bands *above* 1000 were then retuned a second time, and the retune is its
own section below, because the first version of them was wrong in a way the
checker of the day was structurally unable to catch.

**One label was reworded to avoid a collision.** A per-tier upgrade already read
*"Database +0.05% per shard held"*. Now that shards held also produce globally,
an unqualified "per shard held" reads as the reserve rather than as the tier
bonus it is. It now says *"Database output +0.05% per shard held"* — the tier is
the subject, and the reserve is the thing that makes everything better.

**No save migration was needed.** `Stats` is derived and no persisted field
changed, so `SAVE_VERSION` stayed at 12 at the time. Worth stating, because the
previous four changes to this currency all required one. It has since been
reset to 1 as a fresh start under the shipped schema; see the note on the
constant in `state.ts`.

**Follow-up: the labels were still wrong, and one was lying.** A review of what
the player actually sees turned up a gap between the mechanic and the copy. The
mechanic is a *multiplier on production*; the copy said `reserve`.

Only one surface explained itself: the shards chip read `+100% production`,
which is clear and correct. Everything else said `x3.00 reserve` — a multiplier
on a noun the player is never given a definition of outside the Upgrades group
blurb, several screens away. And in one case it was not merely vague but false:

| State | Cores chip said | Reality |
| --- | --- | --- |
| 0 shards, 40 cores | `x3.00 reserve` | reserve contributes **+0%** |
| 10k shards, 40 cores | `x3.00 reserve` | +300% |

The first row is the worst kind of UI bug: a player holding forty cores and no
shards was told they had a 3× bonus that did not exist, on a mechanic whose
entire design is that cores depend on shards. The code was right; the label
invented a benefit.

Every surface now speaks **production**, and the two HUD notes are built to add
up rather than to each restate the total:

- **Shards chip** — the BASE: what the shards alone give (`+200% production`).
- **Cores chip** — the cores' MARGINAL contribution (`+180% production`), which
  is *not* `stats.reserveBonus`; that figure already includes the cores, so
  showing it next to the cores' own share would count them twice. The base is
  recovered by dividing the amplifier back out (`shardBaseBonus()`) rather than
  recomputing `reservePer * sqrt(shards)`, so the engine owns the formula and
  the UI cannot drift from it.
- **No shards** — `needs shards`, which is the honest answer and the one that
  teaches the dependency the mechanic is built on.
- **Reboot "on reboot"** — the production the new cores *would add*, a delta,
  because the cores already held are already in the production figure. Stating
  the total after rebooting would overstate the gain by everything the player
  already has.

The general lesson, which is the same one the milestone display taught earlier
in this document: **a derived value has to be labelled with the quantity the
player can act on, not with the name the code uses for it.** "Reserve" is a
perfectly good internal name; it was a bad player-facing one, because it named
the mechanism instead of its effect.

**Second follow-up: the notation, and a trap in it.** The percentages above were
the right *quantity* and the wrong *form*. The reserve is one factor in
`globalMult`, sitting beside `Multiplier 5.94x` and `From achievements 1.237x`
on the HUD, so all four now use the multiplier form:

```
shards  3.00x production
cores   1.60x production
```

The obvious implementation of that is wrong, and it is worth writing down
because it looks correct. The shard factor is `1 + bonus` = `3.00x`, so the
temptation is to show the core amplifier beside it — `x1.90` — and let the
player multiply. But **the amplifier multiplies the shard BONUS, not the final
multiplier**:

```
3.00 x 1.90 = 5.70      <- wrong
1 + 2.00 x 1.90 = 4.80  <- the actual factor
```

So the cores chip shows `reserveMult / shardFactor` — an *incremental* factor of
`4.80 / 3.00 = 1.60x`, which is the only decomposition that composes. The two
chips then multiply to the real figure: `3.00 × 1.60 = 4.80`.

Two consequences worth keeping:

- The two factors match to display rounding, not exactly — `11.00 × 5.55 =
  61.05` against a true `60.99`. That is the cost of two 2-decimal chips, not a
  bug, and the fix is not to give one chip more precision than the other.
- The Reboot panel's projection had to go through a new `stats.coreAmplifyPer`
  (the per-core *rate*) rather than the existing `stats.coreAmplify`. The latter
  is a product with the current core count, so it is a constant `1` at zero
  cores and cannot be projected forward from — the UI would have had to rebuild
  the formula from `content.ts` to answer "what is one more core worth". Exposing
  the rate keeps that arithmetic in the engine.

And one case kept its old form deliberately: **a per-unit RATE stays a
percentage.** The chips read `+1% per shard` and `+5% per core` when there is
nothing to multiply yet, because `x1.01 per shard` is not a multiplier anybody
would write down. Rates are `+%`; totals are `xN`.

---

## The ladder was 2.4x too long, and the check meant to catch that could not

Reported as *"current shard is really hard to acquired"*. It was, and the reason
turned out to be two separate mistakes pulling the same way — plus a third that
had been sitting in the shard economy unnoticed since contracts were made flat.

### A budget derived from the thing it bounds

`SHARDS.ladderBudget` was a ceiling on the total cost of the upgrade list, set
at 180,000 when the ladder grew to 72. It never failed, and it could not have:
the number was **taken from this script's own reported total**. A bound that is
chosen by measuring the thing it is supposed to bound agrees with whatever that
thing costs, which makes it a rubber stamp with a comment attached.

It reported a healthy ladder through the release that made the last twelve
upgrades 86% of the entire climb. That is the failure mode to remember: the
assertion passed, the shape was wrong, and the two facts were never connected
because the assertion was about a *total* and the problem was about a
*distribution*.

It has been replaced by `SHARDS.pacing`, which states the run length in
**hours** and the reference session it is measured at. Hours cannot rubber-stamp
anything, because the conversion needs three numbers that live in different
places to agree — the two reference rates, the contract and milestone payouts,
and every price in the table. Move one and the hours move; the target does not
follow.

`check:ladder` now converts the whole price table into hours and asserts the
total lands inside a band, **and** that no single upgrade exceeds 10% of the
run. The second assertion is the one the old budget was missing: 86% of the cost
in the last twelve rungs sailed past a total check comfortably.

### The 40-hour figure was wrong, and the arithmetic is worth keeping

The first estimate of the original run length divided the old ladder's 18,900 by
**471 shards an hour**. 471 was correct once. It was measured before contracts
were made flat, when they paid 24.24 on average *by rarity* — and when that
changed to a flat 50 with a salvage strike, the real rate became

```
12 contracts/hr x 50 x 1.30 salvage  +  20 milestones/hr x 9  =  960 shards/hr
```

more than double. Nobody re-derived the run length afterwards, so the number
went on describing an economy that no longer existed.

| Ladder | Cost | Run at 960/hr |
| --- | --- | --- |
| Original, 58 upgrades | 21,050 | **14.6 h** |
| Extended, 70 upgrades | 148,550 | **29.4 h** |

So the extension had doubled the game, not quintupled it — and the reason it
* felt like more than a doubling is in the shape, not the total. A single 25,000
upgrade at the end of the ladder was a 2.9-hour purchase standing next to
1,000-shard rows, and the last twelve upgrades were 86% of the climb.

**The general lesson: a derived design figure has to be re-derived whenever the
inputs move.** The income rate changed for a good reason — flat payouts make the
reward badge honest — and it silently invalidated a pacing estimate nobody
thought to recheck. The number was not wrong when it was written; it was wrong
for two releases and nothing was watching it. This is the same class of bug as
`ladderBudget`, one level up: a constant that stopped describing the system and
had no mechanism to notice.

### The retune

Reported as *"max shard is 1000 re-scale"*, so the ceiling is now a design rule
rather than a preference and the table was rebuilt against it.

**Why 1000 is the ceiling.** Not an economy argument — a legibility one. The last
thing on the list has to be a number the player can picture themselves reaching.
Every figure past four digits reads as a wall however it is tuned, because the
player is not comparing it to their income in a spreadsheet; they are glancing at
a row and deciding whether it is for them. Two revisions went over the line —
first to 10,000, then to 2,500 — and both were **defensible in the pace model and
wrong on the panel.** That gap between "the arithmetic says this is affordable"
and "this looks affordable" is what the ceiling encodes.

So the seven prices that used to cover the first 58 rungs now cover all 72: ten
rungs each, twelve in the last band. Total **22,455**.

**The trade, stated plainly.** Every boundary moved, and that reprices eight
capstones at once, because a capstone's price is its own band *index* plus
`capstoneBandBump` *(both since replaced — see the note above; a capstone now
reads its tier row's `capstone` entry)*. `check:ladder` asserts the capstone
ordering directly rather than inferring it from the bump size, which is what made
the change safe.

The pace consequence is bigger than the price change suggests:

| | Before | After |
| --- | --- | --- |
| Bands | 10, topping at 2,500 | **7, topping at 1,000** |
| Ladder total | 47,350 | **22,455** |
| Ladder completes | 11.3h | **4.9h** (sim: 3.2h) |
| Fleet completes | 5.2h | **1.9h** |

The game is roughly **half as long**, and that should be known rather than
discovered. It is also the same instruction applied consistently: a ladder whose
maximum is reachable is a ladder that gets finished.

**And the shape inverted an earlier finding.** Under the old table the top of the
ladder was the slow part. Now:

```
   250 shards  rungs 40-49  (10 upgrades)  1.8h   <- 37% of the run
   500 shards  rungs 50-59  (10 upgrades)  0.6h
  1000 shards  rungs 60-71  (12 upgrades)  0.5h
```

The *cheapest* of the three expensive bands is the slowest, and the most
expensive is one of the fastest. The reason is the ramp: by rung 60 the player
owns all six income upgrades and is earning ×20.25, so a 1,000-shard row costs
about as much time as a 50-shard row did at the start. **A price tells you
nothing about how long it takes unless you know what the income is when you
reach it** — the same lesson as the fleet-versus-ladder mismatch, one level down.

**The income ramp was rebuilt at the same time, and this is the half that fixed
the original complaint.** Two things were wrong with it:

1. **Milestones never scaled.** Both award sites read
   `awardShards(state, crossed * SHARDS.perMilestone)` — no `shardMult` at all.
   The four income upgrades said *"contracts yield more shards"* and were
   telling the truth: the milestone faucet was frozen at 180 an hour forever
   while prices climbed. That is the faucet that pays **while the player is
   away**, which made the hole worse rather than better — the one income that
   needs no attention was the one that never grew. Both sites now scale and the
   copy says *"shard income"*.

2. **The ramp arrived after most of the ladder it was meant to pay for.** The
   gates were 25 / 60 / 120 / **200** completed contracts, so the last income
   upgrade unlocked roughly where the run ends. They are now 10 / 30 / 60 / 100.

Two more were added at rungs 58 and 62, taking the ramp from x9 to **x20.25**.

The result, measured by the checker rather than estimated:

```
price: 7 bands, 10 .. 1000  |  total 22455
    10 shards  rungs 0-9   (10 upgrades)  0.1h
    25 shards  rungs 10-19 (10 upgrades)  0.3h
    50 shards  rungs 20-29 (10 upgrades)  0.7h
   100 shards  rungs 30-39 (10 upgrades)  1.0h
   250 shards  rungs 40-49 (10 upgrades)  1.8h
   500 shards  rungs 50-59 (10 upgrades)  0.6h
  1000 shards  rungs 60-71 (12 upgrades)  0.5h
pace: 4.9h to clear at 1380 shards/hr (target 5h), final income x20.25
```

4.9 hours for 72 upgrades, against a fleet that finishes at 1.9 — see the note
above on the shape, and the next subsection on why the target is a measured
number rather than a round one.

Note what the band table shows that a total never could: the middle of the run is
where the time goes. Bands 250 and 500 hold twenty upgrades and half the hours,
because that is the stretch where the ramp is still arriving. That is visible
now, and it was not before.

### Contract slots could die permanently

Found while auditing the shard faucet, since slots are the faucet.

`inventory-1` and `inventory-2` ask the player to buy 6 and 20 upgrades. There
are 72 upgrades in the game, and once a player owns all of them **those two
contracts can never complete again** — and an uncompletable contract does not
merely sit there. It holds a slot, and there are five. A finished player was
permanently down 40% of their shard income, silently, with no message and no way
to clear the row. There is no abandon action in the game to escape it with.

The fix has two halves, because the rarity roll happens *after* the definition
is chosen:

- `pickContract` will not offer a definition whose metric has less remaining
  headroom than the objective asks for.
- `contractAmount()` clamps whatever size the roll then requests, so a mythic
  `inventory-2` asking for 70 purchases cannot be issued to a player who has
  three left.

`metricHeadroom()` returns `Infinity` for every metric except `upgrades`, and
the reason is the right one rather than laziness: clicks, services, compute,
cores, reboots, milestones and shards all keep arriving, so a contract on one of
those is always completable given time. `upgrades` is the only bounded metric in
the game. Verified by simulating a save with all 72 owned — no inventory
contract is issued, and one with three left is likewise skipped.

### Provision was aimed, by construction, at the one tier it could not help

Reported as *"bug in provision it only allocate worker"*. Correct, and the line
that did it was one reduce:

```ts
const cheapest = SERVICES.reduce((best, s) => s.baseCost < best.baseCost ? s : best);
```

`ServiceDef` has no unlock of its own, so the cheapest tier by `baseCost` is
Worker, permanently. Not a crash — a hard-coded target wearing a lookup's
clothes. Worker's output is 0.1 a second; a Datacenter's is 44,000. The ability
paid its whole grant into the one row where a unit is worth least, and the
announcement (`provisioned N free services`) never named the tier, which is how
it survived: the player found it by watching a counter, which is exactly the
kind of detection a UI should not require.

**But measuring the fix found something much worse, and it is the reason this
section is longer than the bug deserves.** The grant was
`max(25, 10% of the fleet)` — and the *scaling* half of that was the dangerous
half, for a reason specific to this game: a tier's output is
`2^floor(owned/25)` times its base, so what a grant is worth depends on how many
milestone boundaries it crosses, and a grant proportional to the fleet crosses a
proportional number of them. Units are not a linear resource here.

Measured against the real engine:

| Fleet | Old behaviour | | Proportional 10% | | Flat 25, spread |
| --- | --- | --- | --- | --- | --- |
| @250 | +25 Worker | **+122%** | +24 across 4 tiers | +9.9% | +26 across 4 | **+10.6%** |
| @2,500 | +250 Worker | **+119,367%** | +249 across 6 | +101% | +26 across 6 | **+1.0%** |
| @6,505 | +650 Worker | **+7,801,405,340%** | +649 across 8 | +2.7 million% | +27 across 8 | **+0.4%** |

So the reported bug was real, and behind it was a button on a 120-second
cooldown that could multiply production by seven billion percent. **Fixing the
aim made it worse**, because spreading the same units across more tiers crosses
more milestone boundaries — the intuitive fix and the safe fix pointed in
opposite directions, and only the numbers showed that.

The shipped version is the last column: a **flat budget of 25 units**, shared
across every tier the player runs in proportion to its size, floored at one unit
so no row is left out. `PROVISION_SHARE` is deleted rather than reduced, and
that is the point — a smaller unbounded number is still unbounded. The
production swing is now bounded at every scale, between +0.4% and +10.6%.

Two consequences, stated plainly rather than buried:

- **The ability is a modest top-up, not a burst.** At 6,505 services it is
  +0.4%. That is not satisfying, and it is the honest price of the bound. A
  grant that stays relevant at every fleet size needs a different mechanism —
  one that does not route through milestone doublings — and that is a redesign
  rather than a retune. Flagged, not attempted.
- **The self-extinguishing floor idea was abandoned.** An earlier revision gave
  every tier 10% of itself with a floor of one unit, on the theory that a
  minimum keeps small rows visible. A single unit is not small: on a tier the
  player owns one of, it is a whole doubling of that tier's output, and at 250
  services one free Database was worth more than the rest of the grant
  combined. **The floor was removed because the smallest possible grant on an
  expensive tier is not a small grant.**

The general lesson is the one this whole document keeps arriving at: **units are
exponential here, so "scale it with the fleet" is not a neutral way to make an
ability stay relevant.** Whether a quantity can be scaled is a property of the
quantity, and for units in a game with milestone doublings the answer is no.

### Verification

`check` 0/0/0 · `check:ladder` 72 upgrades, 7 bands, total 22,455, 4.9h inside the
5h ± 35% band, slowest rung 7.4% of the run · build clean, 0 non-ASCII bytes in
the CSS. The end-to-end progression simulation finishes the fleet at 1.9h and
the ladder at 3.2h — faster than the checker's 4.9h, because the model applies
the shard-income ramp in rung order while a real player buys those upgrades as
soon as they can afford them. The checker's figure is therefore a conservative
upper bound. Provision and the contract guard were verified by importing the
real engine and simulating fleets at 250 / 2,500 / 6,505 services and saves
owning all 72 upgrades. The per-tier reveal ladder was verified in the browser
at 24 / 25 / 50 / 100 units of one tier: 1, 2, 3 and 4 upgrades shown, and the
price list renders exactly seven values with none above 1000.

---

## The fleet finished ten hours before the ladder did

Reported as *"when data center reach level 100 ... it almost endgame but the
progress of upgrade isn't"*. That is a pacing mismatch between two ladders, and
it is the best diagnosis in this document, because the numbers that had been
used to tune the upgrade side said nothing about it.

### What was measured, and why nothing had caught it

Every pace figure up to this point converted `total cost / income rate` into
hours, which answers "how long does the ladder take". Nobody had asked **when
the fleet finishes**. Those are different questions and only the second one
matters to a player.

So a progression simulation was written: a player who clicks at a steady rate,
pushes up the tiers (buying the most advanced tier they can afford, not the
cheapest — greedy-cheapest never leaves Worker, because Worker is always the
cheapest thing in the game), collects shards at the reference rate, and buys the
cheapest upgrade they can afford. Against the ladder *before* this change:

| Fleet milestone | Time | Upgrades owned | Revealed | Affordable now |
| --- | --- | --- | --- | --- |
| Datacenter 10 | 3.45h | 32 / 72 | 48 | **0** |
| Datacenter 25 | 3.79h | 34 / 72 | 49 | **0** |
| Datacenter 50 | 4.47h | 35 / 72 | 52 | **0** |
| Datacenter 100 | 8.21h | 43 / 72 | 59 | **0** |

Two things fall out. The fleet reaches its final tier at **8.2 hours** while the
ladder ran to **18.4** — ten hours of play with nothing left to build and two
fifths of the list unbought. And the player owns 60% of the upgrades having
spent 9.5% of the ladder's total cost, because the upgrades they own are the
cheap ones; the remaining 29 cost about 90% of the money.

The `affordable now: 0` column is the important one. It rules out the obvious
suspect: this was never a **visibility** problem. 59 of 72 rows were already on
screen. It is a **supply** problem, and the visible-but-unaffordable rows were
what made the panel feel stuck.

### The fix is in the faucet that tracks the fleet

Contracts pay on a clock. Milestones are crossed *by units owned*, so they are
the only faucet whose rate follows how fast the player is actually building —
which is exactly the property the ladder needed. `SHARDS.perMilestone` went from
**9 to 30**, making it 43% of income where it had been 19%.

The compressed bands stayed, and were then capped outright at 1000 in the next
change — see *The retune* above. **This paragraph's conclusion is the durable
part:** trimming the top of a ladder barely moves the clock, because the
expensive rungs were never the slow ones. A total-cost check cannot see that,
which is why pace has to be measured per rung.

| | Before | After the faucet fix | After the 1000 cap |
| --- | --- | --- | --- |
| Ladder total | 87,050 | 47,350 | **22,455** |
| Top band | 25,000 | 2,500 | **1,000** |
| `perMilestone` | 9 | 30 | 30 |
| Base income | 960/hr | 1,380/hr | 1,380/hr |
| Ladder completes | 18.4h | 11.3h | **4.9h** (sim 3.2h) |
| Fleet completes | 8.2h | 5.2h | **1.9h** |

The gap went from 10.2 hours to 6.1, and then to about 2 with the cap. It is
**not closed**, and saying so matters more than rounding the claim up: the ladder
always outlives the fleet, because the fleet has a final tier and the ladder has
72 rungs. What changed across all three passes is how much of the run the player
spends looking at a list they cannot act on.

### What would close it, and why it was not done

The honest options are to slow the fleet (a services rebalance, which touches
every early-game figure), to add fleet content past Datacenter (a content
project, not a tuning one), or to accept the tail. The last was chosen, because
a tail of unbought upgrades is a *goal* rather than a stall provided the next
one is affordable — and the measurement now says it is.

The general lesson, and it is the third time this document has arrived at it:
**a derived figure is only as good as the question it answers.** `18.4h` was
arithmetically correct and useless, because it answered "how long is the ladder"
when the player was asking "will I still be building when it ends". The
simulation is kept as a script because the next person to retune either ladder
will need to ask the second question, and the first one will not warn them.

---

### Surge was gated behind four hours of the thing it rewards

Reported as *"I never unlock surge"*, and nothing was broken. The unlock chain
was verified end to end: `contracts-50` fires, `computeModifiers` adds the
ability, `isAbilityAvailable` returns true, the card flips to Ready.

What was wrong is the GATE. Surge sat behind **50 completed contracts**, which
is roughly four hours of active play at the reference rate — so the second
burst ability was the trophy for having already engaged with the Contracts
panel, rather than the thing that makes the panel worth engaging with. A reward
nobody reaches is content nobody sees, which is the same argument that lowered
the per-tier reveal gates.

It now unlocks at **25 contracts**, on a new `contracts-25` achievement.
`contracts-50` keeps its pay bump.

**A new achievement rather than renaming the existing one**, and that detail
matters: achievement ids are storage keys and `sanitize()` is a strict
allow-list, so renaming `contracts-50` would silently strip the unlock from
every save that already had it. Adding one means a save already past 25
contracts collects Surge on its next tick instead of losing it. Same rule the
currency rename taught, applied before it could bite this time.

Worth noting what this one was NOT: the first three explanations I tested —
the predicate, the modifier loop, and save sanitising — were all correct, and
the fault was a design number rather than a code path. **A report of "X never
happens" can mean the mechanism is broken or that its threshold is wrong**, and
they look identical from the player's side.

---

## The contract panel was rebuilt: scaled objectives, no dice, one reward rule

Reported as *"contract still seem over. I think we should redesign the contract
not random it. fix it with scaling."* All three complaints were correct and they
had one root cause.

### What was wrong

`contractReward` was `max(perSecond x 600, 250) x rewardScale[rarity]`. With the
configured weights and scales the expected rarity multiplier is
`0.52(0.5) + 0.30(1) + 0.15(2.2) + 0.03(5) = 1.04`, so **every contract paid
~624 seconds of production — 10.4 minutes — regardless of what it asked for.**
At the reference rate of 12 contracts an hour that is 7,488 seconds of
production per 3,600-second hour: **+208% income**, before the achievement bonus.

And the objectives were absolute numbers authored for the early game. Measured:

| contract | objective | real time at a developed fleet |
| --- | --- | --- |
| `provision` | bring 60 more services online | seconds |
| `salvage-1` | earn 500 more shards | ~1.5 min |
| `salvage-2` | earn 5,000 more shards | ~15 min |

**All of them paid the same.** The payout scaled with production and the
objective did not, so the reward was ignorant of the cost — and the cost
collapsed to nothing as the fleet grew. On top of that the rarity roll moved
both the objective (x0.6-3.5) and the payout (x0.5-5) on a hidden dice throw, so
the same contract was a 5-minute job or a 17-minute one and paid anywhere from 5
to 50 minutes for it.

### The redesign

- **Objectives are computed at issue against the player's own rate.** A
  definition declares `cost` in seconds of production; the objective is that
  many seconds' worth of whatever the metric measures. Same contract, same
  effort, at any point in the run.
- **The reward is derived from the same number**: `perSecond x cost x payback`.
  A card cannot be a bad deal because there is no separate figure to get wrong.
- **The rarity roll is deleted** — `rarityWeights`, `rarityScale`,
  `rewardScale`, `rollRarity`, the stored `ContractState.rarity`, the rarity
  chip. No save migration was needed: the stored `amount` was always the real
  target, so dropping a field nothing reads loses nothing.
- **The difficulty bias in `pickContract` is deleted too.** It existed to stop a
  new player being handed a late-game objective, which sizing-at-issue solves by
  construction. It had also become a source of skew: comparing raw amounts
  across metrics is what made it over-offer prestige contracts at 22%.

Verified: the reward-to-cost ratio is **exactly 1.000 for every contract at
every stage**, and the card shows real numbers ("Earn 58 more shards", "Buy 5
more upgrades", "Cross 129 more milestones") with no rarity anywhere.

### Two mistakes the simulation caught, and they are the lesson

**One: `clicks` and `upgrades` paid ZERO.** Their objectives are fixed amounts
rather than cost-derived, so the first version gave them no `cost` at all — and
since the payout is `perSecond x cost`, they were worth nothing. A definition
that asks for 200 manual deploys and pays zero is invisible on the card and
invisible to a type check. `check:ladder` now asserts every definition declares
a cost.

**Two: the analytic model was wrong by a factor of 140.** The intent was that
`payback: 1` would mean "a contract pays what it cost", giving +100% income.
That treats `cost` as wall clock. **In an exponential game it is not**: an
objective of "earn 150 seconds of production" is reached in far fewer than 150
seconds, because production rises while the player waits. Measured, contracts at
`payback: 1` completed at ~1,200 an hour and supplied **99% of all income** — a
139x multiplier.

The first attempt at a fix was also wrong in an instructive way. `services` and
`milestones` were sized as a *share of the current stock* ("bring 20% more units
online"), which sounds equivalent to a rate and is not: auto-buying turns
compute into units continuously, so 20% of a fleet arrives in **seconds** while
the card still pays 150 seconds for it — the original "reward ignores cost" bug,
moved rather than fixed. Those two metrics are now sized by how many units
`cost` seconds of production can actually buy, which is the only formulation
that tracks the faucet.

So `payback` is **calibrated by simulation, not derived**: 0.0095, measured to
land contracts at 1.7x-2.0x total income. The constant swings with how fast the
fleet happens to be growing during the window, so it is a tuned number rather
than an exchange rate, and the method is recorded here because that is the only
way the next person can re-derive it.

**The pattern worth naming, because it is now the third instance in this
document:** a value that *looks* like it can be reasoned about, that must
actually be measured. The 40-hour pacing figure was derived once and never
re-derived. The `milestone` reward added to the base of an exponent, so +1 was
worth 431,000x. And here, `cost` is not wall clock. In each case the arithmetic
was sound and the model of the system was wrong, and in each case the failure
was invisible to every check that existed at the time.

---

## Three contracts could never be completed, and the picker preferred them

Reported as *"contract mostly not make sense core will never make contract
complete because you need reboot"*. The phrasing names the cause exactly, and
four faults came out of it — one of which was hiding behind the other three.

### The reward is paid at the one instant it is guaranteed to be zero

`contractReward()` is `max(600 x production, 250)` and it is evaluated at
**claim**. A core contract can only be completed by rebooting, and a reboot sets
production to zero. Measured on a mid-run save:

| | Productive | One instant after the reboot it required |
| --- | --- | --- |
| Production | 9.0e19 /s | 0 |
| Bronze core contract pays | 2.7e22 | **125** |
| Mythic pays | 2.7e23 | 1,250 |

The hardest objective in the game paid 125 compute. But the compute was not the
real loss, because `applyReboot` zeroes `compute` anyway — **what the player
actually forfeited was the cores**, since `prestigeCores` measures `runEarned`
and `credit()` is what adds a contract's payout to it. Claiming before a reboot
was worth hundreds of cores; claiming after was worth none, and nothing on
screen said so. An ordering puzzle with no instructions.

### `bank-cores-2` was unreachable and held a slot forever

Cores grow with the square root of a run, so acquiring N more of them costs
`N^2 x threshold` — or N separate reboots:

| Contract | Target (mythic) | Run earnings required |
| --- | --- | --- |
| `bank-cores` | 10 (35) | 1e11 – 1.2e12 |
| `bank-cores-2` | 100 (350) | **1e13 – 1.2e14** |

One hundred cores is a thousand times the threshold in a single run. Rarity
scaling (x3.5) applied to cores exactly as it applies to clicks, so a mythic
draw asked for 350. And an incomplete contract **holds one of five slots**, so
this was a permanent 20% cut to the shard faucet, silently — the same defect
class as `inventory-*`, arrived at from the opposite direction.

### Completing one wiped seven other contract types

`applyReboot` keeps contracts and baselines, but it resets `services`, and
`milestones` and `upgrades` are derived from resets:

| metric | before | after Reboot |
| --- | --- | --- |
| clicks, totalEarned, shards | — | survive (lifetime counters) |
| **services** | 635 | **0** |
| **milestones** | 25 | **0** |
| **upgrades** | 40 | **0** |

Seven of the eighteen definitions were measured on those. So the act of
completing a prestige contract set the player's other four contracts back to
zero, mid-run, with no warning.

### The picker compared numbers that count different things

## Same price, different value: the global upgrades

Prices are banded by `rung`, and a band spans ten rungs. So every global in a
band costs the same number of shards, and nothing in the design stopped one of
them being worth fifty times another. This section is the measurement, not the
argument for it.

### The measurement

A one-time probe imported the real engine and measured each upgrade by
applying it to a reference state and diffing `computeStats()`, rather than
reading the effect kind and reasoning about it. Three things about that method
are load-bearing:

- The reference is "every rung BELOW this one", not an empty upgrade list.
  Count-driven effects (`serviceUpgrades` scales by upgrades owned) measure as
  worthless against zero, which is a property of the ruler, not the row.
- Three fleet SHAPES are measured (even / spread / deep). `perSecond` is
  dominated by the highest tier, so on a top-heavy fleet a low-tier row reads
  ~0% however large it is for its own tier. The even fleet is the fair one.
- Non-production kinds (click, offline, shard, cost, automation, slots) are
  reported in their own unit and excluded from the comparison. Measuring a
  click upgrade by production says "worthless" about every one of them.

### What it found

Within the three bands that contain more than one production global:

| Price | Row | Was worth | Band-mates |
| --- | --- | --- | --- |
| 100 | `global-1` … `global-5` | +50% / +50% / +100% / +200% / +300% | each other |
| 250 | `synergy-1` | **+2.8%** | `milestone-1` +100%, `perOwned-1` +74% |
| 500 | `shards-5` | **x1.5** | `shards-3`/`shards-4` x2 |
| 500 | `auto-1` | **1/s** | `auto-3` 5/s (same price) |
| 1000 | `milestone-2` | +50% | `global-6` +300%, `global-7` +400% |

`global-1` … `global-5` was the clearest: five upgrades, one price, a **167%
spread** between the best and the worst. A player who could afford two of them
was being told by the shop that some of the five are not worth buying.

### The fixes, and the rule behind them

The rule: **within a price band, a global should be worth the same as its
band-mates; escalating a group's power means escalating its price, and the
price is set by the rung, so the values move instead.** Where the band's total
power could be held constant, it was — the ladder's pacing is untouched
(`check:ladder` measures only SHARD income, which the global multipliers never
touched, so this was always safe to retune).

- **`global-1` … `global-5` → x2.1, x2.2, x2.2, x2.3, x2.3.** The product is
  held at 54 (was 54), so total power is identical; the spread falls from 167%
  to 14%. `global-6`/`global-7` stay at x4/x5 because they are the only globals
  in their own band and have no band-mate to be unfair against.
- **`shards-3`, `shards-4`, `shards-5` → x1.82 each.** The product is held at 6
  (was 6), so shard income and ladder pacing are identical.
- **`auto-1`/`auto-3` → 3/s each; `auto-2`/`auto-4` → 3.5/s each.** Rates are
  ADDITIVE, so each pair keeps its sum (6/s deploy, 7/s buy) while the two rows
  in each pair stop differing five-fold at one price.
- **`synergy-1` → +75%, and the mechanic changed.** This one could not be fixed
  by value. A tier's synergy factor is ONE factor of its service multiplier and
  it SATURATES (the +50% cap is reached at 100 units of the tier above), so even
  a large additive bonus moved total income by a few percent: measured +2.8% on
  a fresh fleet and +0.7% on a developed one. The shop upgrade now multiplies
  the tier's FINISHED synergy factor instead of widening its pre-cap rate, which
  makes the number on the card the actual gain and stays bounded because the
  factor it multiplies is bounded. The achievement reward and the per-service
  synergy upgrades keep the additive form, so the blast radius is one row.
  `+75%` was chosen to sit beside `perOwned-1` (+74%) rather than match
  `milestone-1` (+100%), since synergy also compounds with later synergy.

### Left alone, on purpose

- **`global-6` (`x4`) and `global-7` (`x5`)** are the terminal spikes and the
  only globals in the 1000 band. A 25% gap between two rows is not the defect
  this section is about.
- **The 1000 band is otherwise mixed-axis.** `reserve-2`/`reserve-3` scale with
  SHARDS HELD (so their value depends on the balance, and is zero at zero
  shards), `milestone-2` scales with milestone STEPS, `contract-4` is slots,
  `offline-3` is away time. Comparing those to a global multiplier by income is
  not apples to apples, and `milestone-2`'s +50% sits in the range of
  `reserve-2`/`reserve-3` (+65%/+59%) once that is accounted for.

### The lesson, again

Every number here was measured, and the measurement contradicted the reading in
the way this session has repeatedly taught: `synergy-1` reads "every tier pushes
25% harder" and is worth **2.8%**, and the fix was not to raise that number —
raising it to `+300%` moved total income to only about a third of what the two
rows beside it give for the same price. The card was describing the mechanism.
The mechanism was the problem.


`pickContract` ranked difficulty by raw `def.amount` **across the whole table**,
so "1 reboot" and "10 cores" normalised as cheaper than "150 manual deploys" and
were weighted up. Measured over 3,600 draws:

| metric | share of offers | share of definitions |
| --- | --- | --- |
| cores | 14.9% | 11.1% |
| reboots | 6.9% | 5.6% |
| clicks | **4.5%** | 11.1% |
| upgrades | **4.6%** | 11.1% |

Prestige contracts were 22% of all offers. **The game preferentially handed out
the two objectives it could not complete**, and starved the two it could.

### What changed

- **All three prestige contracts are deleted**, not retuned. `cores` and
  `reboots` are gone from `MetricKey` entirely, and `metricValue` no longer
  handles them. Retuning could not have worked: the problem is the objective
  *shape*, which counts from a baseline and only means anything for a counter
  that advances on its own. 15 objectives across 6 metrics remain, every one of
  which moves while the player plays.
- **`pickContract` normalises difficulty within each metric**, not across the
  table, so amounts are only ever compared against numbers that count the same
  thing. The bias and its easing-off curve are unchanged; only the comparison
  was fixed. It is not a true time-to-complete model — 600 clicks and 5,000
  shards are not equally hard just for being the larger half of their metric —
  but it makes the ordering honest, and it needs no difficulty number authored
  per contract.
- **`applyReboot` cashes in completed contracts before measuring cores.** The
  compute was always going to be discarded; collecting first is what carries it
  into `runEarned`, so the cores the player earned are the cores they get.
  Verified: a gold contract left unclaimed through a Reboot now contributes
  **994 cores** where it previously contributed **0**.

The fourth fault is the one worth keeping. It was invisible while the first
three were being fixed — the picker's bug does not mention cores, and the
reward's bug does not mention contracts — and it would have survived a fix that
only addressed the complaint. **A plausible diagnostic should still be chased to
its numbers**, because the loudest symptom is not always the one with the most
consequences: the user reported one contract that never completes, and the
picker was steering players onto it every fifth offer.

`check:ladder` now asserts that no contract is measured on a prestige-only
metric, with the list hardcoded for the same reason the global-upgrade count is
— a list derived from the content would agree with whatever the content says,
which is the one thing the check exists to falsify.

---

## The milestone shard faucet was removed, and it was never the faucet it claimed to be

> **SUPERSEDED, then partly restored — see "The milestone faucet came back, and
> the rate it came back at" below this section.** The faucet is live again at
> `SHARDS.perMilestone: 10`. Everything in this section about the REASONING
> stands and is worth reading: claim 1 below was never true, claim 2 was false
> by a factor of thirty, and the visibility point was the real argument. What
> changed is that the visibility point is now ADDRESSED rather than accepted —
> the service card states the reward beside the threshold that pays it — and
> the plateau claim turned out to be a property of the measuring harness
> rather than of the game.

Reported as *"remove shard reward from milestones all from contract"*, with the
reason given plainly: *"so player can see it explicitly and contract can be
achieved in offline"*. Both halves of that reason turned out to be correct, and
the second one is the more interesting of the two.

### What the faucet was supposed to be

`SHARDS.perMilestone` paid 30 shards for every milestone step crossed, on top of
the 50 a contract paid. The comment above it made two claims:

1. It was **"the faucet that pays while the player is AWAY"** — because a fleet
   left running keeps buying units, and units are what cross a milestone.
2. It carried **"most of the income"** — and the arithmetic supported this. At
   the reference session it paid `20 x 30 = 600` shards an hour against the
   contract faucet's `12 x 50 x 1.30 = 780`, so **43%** of income.

Everything downstream was built on that. A section of this document credits
`perMilestone` — raised 9 → 30 — with closing the fleet-versus-ladder gap from
10.2 hours to about 2, and `SHARDS.pacing` was derived from the same 43%.

### Claim 1 was false, and it was false in a way that mattered

`applyOffline` credits **compute**. It does not buy units, and it does not run
automation. `runAutomation` — which is the only thing that buys units — says so
in its own comment: *"Automation deliberately only runs while the tab is open."*

Units are what cross a milestone. So the milestone faucet paid a player who left
the tab open and **paid nothing at all to a player who closed it**. The one
faucet described as the away faucet was the only one that required presence.

### Claim 2 was false by a factor of thirty

`npm run check:progression` was written to settle this, and it imports the real
engine rather than a model of it. Across a full day it measured:

| | claimed (reference rates) | measured (real engine) |
| --- | --- | --- |
| Contracts per hour | 12 | **80** (about 1,100 in the opening minutes) |
| Shards per hour | 1,380 | **184,392** |
| Milestone share of income | 43% | **1.5%** |

The reason is structural and it is the same one that, in an earlier section,
made `services` and `milestones` contracts complete fifty times too fast: **the
fleet plateaus.** Unit costs grow by `1.15` a unit, so the fleet settles around
300 units a tier and stops crossing milestone boundaries at all. Ninety-four
steps were crossed in a whole day, against 1,928 contracts.

So the faucet was worth 66,058 shards in a day. The contract faucet paid 4.4
million. **The reference rates are not the game**, and a faucet's share cannot
be computed from them.

### The change

- `perMilestone` is **deleted**, not zeroed, and `check:ladder` now asserts its
  absence. A leftover at 0 would pass every arithmetic check here while leaving
  a dead constant for the next reader to misread as a live faucet.
- `milestoneShards()` is deleted, along with the award in `buyService` and the
  crossing arithmetic inside the Provision ability.
- `perContract` went **50 → 51**, and that is not a round number: it is the
  measured equivalent. The simulation reports that 50.8 holds total income
  exactly level, so the most a player can feel from this change is the
  difference between 50 and 51.
- `referenceMilestonesPerHour` is removed from `SHARDS.pacing`. It was a rate no
  faucet read, and a rate nothing reads gets misread as a live one.

Two comments elsewhere in the content still described the old economy and were
corrected: the `reservePer` note ("50 per contract, 9 per milestone") and the
`shardGain` upgrade block ("one multiplier over both faucets").

### Why moving it to contracts is genuinely better, not just simpler

The stated reason — *"contract can be achieved in offline"* — is exactly right,
and it is the opposite of what the old design achieved. `totalEarned` is the one
metric that `applyOffline` **does** advance, so a `totalEarned` contract is
completed *by* the away credit and collected the moment the player returns. The
game already worked this way and the milestone faucet was the part that did not.

And the visibility point stands on its own: a milestone crossing paid shards
from a rule the player could only infer from a purchase, and it landed in a
counter with nothing on screen connecting the two. Now the reward has a card, an
objective and a payout line.

### The measurement harness, and the trap it avoided

`check:progression` is the first script here that imports the **engine** instead
of reading the content. `check:ladder` cannot: it inspects source shape (rungs,
literal objects, band coverage) and has no idea whether a number is reachable.
That gap is why an 18.4-hour ladder survived alongside an 8.2-hour fleet.

Two things about the harness are worth keeping:

- **It is seeded.** `initialState` draws from `Math.random()`, and the seed
  reaches the contract draw and the salvage roll. An early version reported
  between **63 and 502 contracts an hour on identical content**, which is
  useless as a baseline — a checker that answers differently each run cannot
  tell a change from noise.
- **The faucet share was measured by counting, not by ablation.** Silencing
  `perMilestone` and diffing produced a **negative** share, because the two runs
  share a seed and not a trajectory: fewer shards means fewer upgrades, which
  means different income, which moves every later contract. The difference
  measured divergence. Counting crossings and the shards they pay, inside one
  run, is the only version that means anything.

### Verification

`check` 0/0/0 · build clean · `check:ladder` reports `perMilestone` gone and no
longer has a second term in its pace model · `check:progression` runs two passes
in about 4 seconds and reports the table above.

The 43% figure lived in this document, in `content.ts` and in the pace model,
and all three said the same thing. **Agreement between three copies of one
assumption is not evidence**, and the only thing that caught it was running the
engine.

---

## The milestone faucet came back, and the rate it came back at

Asked for plainly: *"bring back the shard reward on complete milestone"*. The
section above is the record of why it was removed, and the honest summary is
that **two of its three grounds did not survive contact with the harness it had
just been given** — one was falsified outright, and one was never true.

| Ground for removal | Status now |
| --- | --- |
| "the fleet plateaus, so it is worth 1.5%" | **Falsified.** The plateau was a property of the player MODEL, which never pressed an ability. The same harness now reports 86–108 steps in a day. |
| "it is the faucet that pays while away" | **Never true.** `applyOffline` credits compute and never buys units. It was the one faucet that *required* presence. |
| "a reward with a card and an objective beats one inferred from a purchase" | **Stands**, and is now addressed rather than accepted — see below. |

### The rate had to be measured, not chosen

The natural move was to restore `perMilestone: 30`, the value it was removed at.
The harness rejected it, and the shape of the rejection is the interesting part.

| `perMilestone` | Faucet share | Contract rate | Gates |
| --- | --- | --- | --- |
| 30 | 11.0% | 96/hr (from 57) | **2 failures** |
| 10 | 8.8% | 53/hr | all pass |

At 30 the extra income did not merely add up — it **accelerated the whole run**,
because shards buy the upgrades that drive production, and production is what
every objective is sized from. The contract rate went from 57 to 96 an hour, and
two progression assertions failed for a reason that has nothing to do with
shards: `totalEarned` and `services` objectives were completing in a typical
**10.3s against a 20s floor**. Contracts had become near-free.

So the response was not linear either: 30 produced **7.4x** the shard total of
10 rather than the 3x the arithmetic suggests. A faucet that pays for
milestones, where milestones come from units, where units come from compute,
where compute comes from the upgrades shards buy, is a loop — and a loop has no
linear response to a change in one of its constants.

## The milestone payout gained two terms, and the ceiling came from the CONTRACT SYSTEM

Asked for as *"increase shard reward from milestone more when milestone growth
and more on higher tier"* — two clauses, and they were read literally. The
payout per step became

```
perMilestone x (1 + milestoneTierGain x tierIndex)
             x (1 + milestoneStepGain x min(stepsBanked, milestoneStepMax))
```

`perMilestone` stayed at **10**, the value the faucet was removed at. The richer
faucet comes entirely from the two multiplying terms.

### Depth is the safe axis to scale; the step term is not

The two clauses are not equally risky, and that asymmetry is the whole design.
**Depth multiplies tiers that do not exist yet in the opening hour**, so it
cannot touch the early game — and the early game is where the documented failure
lives, because a richer faucet buys upgrades sooner, which raises production,
which beats a rate-sized objective sooner. **The step term applies to every tier
immediately, including Worker**, so it is the one that moves the opening.

That prediction was then tested by getting it wrong. The first draft was written
at `0.35 / 0.05`, which is what the requested "~3.5x across the ladder" implies,
and it broke on its first run:

| tier / step gains | avg shards/step | `services` objectives | Gates |
| --- | --- | --- | --- |
| 0.35 / 0.05 | 25.33 | **12.0s against a 20s floor** | **FAIL** |
| 0.25 / 0.01 | 18.44 | 27.8% of band | pass |
| 0.10 / 0.01 | 13.63 | 57.8% of band | pass |

The first row is the **exact repeat** of the `perMilestone: 30` failure, arrived
at through two constants instead of one — which is the useful part: adding a
mechanism did not change the constraint, it only gave the constraint a second
way in. Measured, the shipped `0.25 / 0.01` puts the faucet at **13.9%** of shard
income against the 8.8% a flat 10 produced, so the ask was delivered within a
ceiling it does not control.

**`milestoneStepMax` is what makes the step term safe to have at all.** Step
count follows the unit count and units double every 25, so an unbounded step
term compounds through the same loop the `perMilestone` table above describes.

### Three structural consequences

**Steps are summed SEQUENTIALLY, not multiplied by their count.** The step term
rises with each step, so `crossed x payout(stepsBefore)` would underpay every
boundary after the first and `crossed x payout(stepsAfter)` would overpay the
early ones.

**`milestoneStepsByTier()` had to be introduced, because Provision grants to
every tier at once.** A fleet-wide total cannot say which tier a boundary was
crossed on, and the payout now differs by tier — so the award needs the vector
rather than the sum.

**A third reference rate was needed, and it is a MEAN rather than a median.**
`check:ladder` reads `content.ts` as TEXT and cannot import the engine, so once
the payout varies by tier and step it had no way to derive what a step pays. It
multiplied the step rate by the flat `perMilestone`, which is now only the BASE
of the payout. `SHARDS.pacing.referencePerMilestoneStep` carries the measured
average (`18.4` at the shipped gains), `check:ladder` reads it, and
`check:progression` asserts the measurement against it. The tolerance is
**tighter** (10%) than the two rate tolerances because it is the mean of a
deterministic schedule rather than a simulated rate. It is a mean because the
pace model multiplies it by a total step count, so a median would describe a step
that does not exist.

`check:progression` also stopped duplicating the formula: it accumulates through
the engine's own `milestoneStepPayout`, per tier. A second copy of a reward
calculation is how a report starts disagreeing with the game it reports on, and
this file has been bitten by that once already.

## The two production rates were renumbered to round totals

Asked for as *"I expect total shard to be 0.05 and core 0.1"*, then constrained
twice — *"keep 1% and sqrt no need to change"* and *"without remove anything just
re-number"*. Both constraints matter, and together they fixed the shape of the
change.

**The totals were not the base rates.** This is the finding, and it was invisible
from every card in the game:

| | base | additive sources | effective |
| --- | --- | --- | --- |
| reserve | `reservePer` 0.01 | 0.05 + 0.01 + 0.002 | **0.072** |
| core | `bonusPerCore` 0.05 | 0.05 + 0.01 + 0.02 | **0.13** |

So a request to "change the rate" could not be served by touching the base: the
base was 14% of the reserve rate, and lowering it would have moved the total by
12% rather than the 10x the phrasing implies. The bonuses were the rate.

The rebalance was therefore taken out of the additive sources, leaving both bases
exactly where they were:

| reserve source | was | now | | core source | was | now |
| --- | --- | --- | --- | --- | --- | --- |
| `reservePer` | 0.01 | **0.01** | | `bonusPerCore` | 0.05 | **0.05** |
| `reserve-1` | 0.05 | 0.03 | | `coreAmp-1` | 0.05 | 0.03 |
| `hoard-50000` | 0.01 | 0.008 | | `hoard-50000` | 0.01 | 0.01 |
| `hoard-500` | 0.002 | 0.002 | | `run-1q` | 0.02 | 0.01 |
| | **0.072** | **0.05** | | | **0.13** | **0.10** |

Nothing was removed. The three states a player now passes through:

| state | reserve | core |
| --- | --- | --- |
| fresh save | 0.01 | 0.05 |
| rebooted, achievements only | 0.02 | 0.07 |
| everything | 0.05 | 0.10 |

`reserve-1` and `coreAmp-1` are the reboot-cleared sources, so the middle row is
what a returning player sees — and it is why the base values had to stay: they
are the floor that row is built from.

### Two blurbs had to move with their numbers

`reserve-1` said *"five times as much"* and now says **"four times"** (0.01 ->
0.04). `coreAmp-1` said *"twice as much again"* and now says **"60% more"**
(0.05 -> 0.08). **A blurb states the multiple its numbers actually produce** —
the sentences are derived from the values, so a value change is a text change,
and leaving the text alone would have been the same defect as the `+1% per
shard` card this pass started from.

### And the cards were reporting the base rate

Both rate chips printed the base:

| site | printed | should have printed |
| --- | --- | --- |
| shards chip | `SHARDS.reservePer` (0.01) | `stats.reservePerRate` (0.05) |
| cores chip | `PRESTIGE.bonusPerCore` (0.05) | `stats.coreAmplifyPer` (0.10) |

The shards chip claimed **`+1% per shard`** while the engine applied a rate
**7.2x** larger. `Stats.coreAmplifyPer` already existed and was simply not read,
so the cores chip was the same bug with the fix already in the codebase.

This is the rule the cost-multiplier and concept chips already follow — **a card
states the figure the engine applies** — and it is the reason the whole
renumbering is legible to the player at all: `0.05` and `0.10` are numbers they
can now see and verify, rather than two round figures in a source file.


**That is why the value is 10.** At 10 the faucet is a real 8.8% of shard income
and every gate passes; at 30 it is a change to the contract system wearing a
faucet's clothes. **A buff to `perMilestone` must be re-measured, not computed.**

### Three things the implementation deliberately does differently

**It multiplies by `shardMult`.** Both pre-removal award sites read
`crossed * perMilestone` with no multiplier at all, so the four upgrades labelled
"shard income" did not reach this faucet while the copy claimed they did.
`milestoneShardAward()` takes `shardMult` as a **required** argument, so a new
award site cannot reintroduce that by forgetting, and a site with no `Stats` has
to say so out loud rather than inherit a silent 1.

**It pays from ONE helper, by step count.** The old code had the crossing
arithmetic duplicated at both unit-grant sites, which is exactly how the missing
`shardMult` survived in two places at once. Neither site can now skip a
boundary: a `max` buy, an automation tick and the Provision grant are all paid
per crossing, and the helper is the only thing that computes a payout.

**It shows the figure.** The standing objection was visibility — the shards
arrived from a rule the player could only infer. The service card's milestone
line now reads `4 steps · next 24x at 100 · ◈ +10 per step`, with the reward in
the shard concept's own glyph and hue, and the figure is the **effective** one
(`perMilestone * shardMult`) rather than the base rate, because `shardMult` moves
it by more than an order of magnitude over a run and the base rate would be a
promise the game does not keep.

### What is still owed, and what it costs

**It cannot be earned while away**, and that is now a documented property rather
than a bug to fix. `applyOffline` credits compute and never buys units, so no
boundary is crossed; contracts remain the only offline source. The game's
"finishable in a day" promise now depends on the offline half being contracts,
which it already was.

**It puts part of shard income back on the exponential compute curve.** The
contract faucet is deliberately flat so the currency stays off the curve, and a
step count follows a unit count that doubles every 25 units. It is bounded in
practice because the fleet settles against a x1.15 cost curve, and that bound is
the reason this is a modest flat rate and not a share of production.

### Verification

`check` 0/0/0 · build clean · `check:ladder` reports `perMilestone` present, a
multiple of 10, and its pace model carries **both** faucets (5.1h at 1,766
shards/hr, inside the target band) · `check:progression` exit 0, reporting the
faucet share, both rates and **both** drift figures.

Two seams got a guard as part of this, because the change made them
load-bearing:

- `SHARDS.pacing.referenceMilestonesPerHour` is a second reference rate, and
  `check:progression` now asserts the MEASURED milestone rate against it, the
  same way it asserts the contract rate. `check:ladder` turns that constant into
  hours and cannot measure anything, so without the assertion the pace figure
  would silently describe a game nobody plays.
- The duplicate milestone counter is gone. `check:progression` had its own
  `milestoneStepsTotal` that ignored `milestoneStep` upgrades while the engine's
  paid against them — harmless as a diagnostic, a balance bug the moment it pays
  per crossing. The engine exports one and the harness reads it.

---

## Two cards showed one quest, and the picker was reusing a single roll

Reported as *"I got 2 contract with same quest — I think the contract should look
unique"*, with the two cards quoted:

```
Depth of field    Cross 1 more milestones
Long tail         Cross 1 more milestones
```

Both are `milestones` defs — `deepening-2` and `deepening-3` — and there were
**three** separate causes stacked on top of each other.

### 1. A contract's subject was not unique

`pickContract` excluded a def **id** that was already active, but nothing stopped
two defs sharing a *metric* from running together. Four `throughput` defs all
render "Earn N more compute", two `salvage` defs both render "Earn N more
shards", `provision` and `expansion` both render "Bring N more services online",
and `manual-surge` and `handover` both render "Perform N manual deploys".

The fix keys on a **subject** — the metric plus whichever subject field that
metric uses — rather than on the def id:

```
clicks, services, totalEarned, milestones, shards, upgrades  ->  the metric IS
                                                                  the subject
tierUnits    ->  subject = the tier   (8 defs, 8 distinct subjects)
tierOwned    ->  subject = the tier
abilityUses  ->  subject = the ability
```

So `manual-surge` and `handover` **deliberately collide**: they are different
defs but the same work at a different size, which is exactly the repetition the
report is about. `tierUnits` defs do *not* collide, because "buy more Caches"
and "buy more Replicas" are genuinely different jobs.

### 2. Every slot in one fill used the same roll — the actual bug

This is the one worth remembering, because it is not about content at all.

`fillContracts` loops five times over `pickContract`, and `pickContract` salts
its draw with `contract-pick:${state.contractsCompleted}`. **`contractsCompleted`
does not change between the five slots of a single fill**, and `weightedPick` is
a pure function of `(seed, salt, items)`. So all five slots drew the *same*
number, mapped onto a candidate list that shrank as each def was taken.

That explains the rest of the file. It is why `fillContracts` carried a
"fallback issues the same contract without the duplicate check" branch — without
it, the loop would spin forever, because the same roll kept landing on a def
that was already active. And it is why duplicates could appear at all.

The salt now carries `state.contracts.length` as well. That is still persisted
state, so the draw remains reproducible across a reload — the promise the seeded
layer has always made — but it is no longer the same roll choosing all five
cards.

### 3. The fallback produced the very bug it was hiding

The old fallback issued the duplicate anyway "so a picker bug cannot leave a slot
permanently empty". That put two identical cards on the panel: the safety net
*was* the reported symptom.

It now **stops**, leaving the slot visibly empty. A visible gap that fills on the
next tick is a smaller lie than a wrong card, and it is the same trade
`metricHeadroom` already makes — prefer an honest vacancy to a broken row.

### 4. Pluralisation

Separately, `contractObjective` had singular forms for `clicks` and `upgrades`
but not for `milestones` or `services`, so a size of 1 read "Cross 1 more
milestone**s**". Both now have them.

### The check, and proof that it can fail

`check:progression` gained a **behavioural** invariant: fill every slot across 40
seeds × 4 player states (fresh, early, mid, all-tiers-owned, at 5 and 7 slots) and
assert no two active contracts share a subject, no two rendered objectives are
identical strings, and no slot is left empty.

Behavioural rather than a content assertion, because the cause was in the picker:
a check of the definitions would have passed while the panel showed duplicates.
That is the same shape as the inventory dead-slot bug — the guard existed and the
caller was not consulting it.

**And it was verified to FAIL first.** With the filter and the salt reverted, it
reports duplicates in **25–32 of 40 seeds** per case, with examples matching the
report exactly (`milestones: | milestones:`). A check that has never failed is
the `ladderBudget` problem again, so the negative test is recorded here rather
than assumed.

### What is NOT fixed: the milestone metric is coarse

Uniqueness hides this but does not cure it. A milestone is `MILESTONE.step` = 25
units, so `unitsAffordable(cost) / 25` rounds to **1** for both the `quick` (90s)
and `standard` (150s) deepening defs whenever production is modest. Only one is
offered at a time now, but the three deepening defs still compute nearly the same
objective.

Deliberately left alone until it is **measured** — how often it rounds to 1 across
the progression sim, and what the three defs actually pay. Re-costing on a hunch
is how `perCost` came out at half its intended value earlier in the same session.

### Verification

`check` 0/0/0 · `check:progression` uniqueness ok on all 160 fills · the live
panel at the reported state shows five distinct objectives with no empty slot ·
`playing` in a real browser: `Cross 2 more milestones`, `Buy 5 more upgrades`,
`Earn 133 more shards`, `Use Overclock 2 times`, `Perform 200 manual deploys`.

---

## Shard rewards were unreadable, and the round numbers turned out to be fairer

Reported as *"why shard reward is not % 5 number, ex. 10 20 50 100 ..."* — and
the answer was that they were not chosen at all. They were **derived by
dividing** to preserve total income, which optimised the meter and produced
figures no player can read at a glance:

```
47 / 74 / 136 / 243
```

The upgrade ladder had already solved this exact problem for PRICES: seven
recognisable bands instead of seventy-two arbitrary ones, on the reasoning that
**a number you recognise is a number you do not have to read.** A reward is the
same kind of thing, so it gets the same rule. That the ladder's rule did not get
applied to the other half of the same loop is the actual mistake here.

### Measuring the candidates found a second, worse problem

A one-time probe tested candidate tables against the real content and reported
the realised expected payout — the only constraint that matters, since a round
set that shifts income 15% is a different economy wearing nicer numbers.

| candidate | quick | std | proj | epic | expected | vs 51 |
| --- | --- | --- | --- | --- | --- | --- |
| derived (47…) | 47 | 74 | 136 | 243 | 51.29 | +0.6% |
| **doubling x40** | **40** | **80** | **160** | **320** | **51.76** | **+1.5%** |
| doubling, epic clipped | 40 | 80 | 160 | 280 | 50.59 | −0.8% |
| multiples of 25 | 50 | 75 | 125 | 175 | 50.76 | −0.5% |
| multiples of 50 | 50 | 100 | 150 | 250 | 58.82 | **+15.3%** |
| price-family values | 50 | 100 | 250 | 500 | 69.12 | **+35.5%** |

The +15% and +35% rows are why this was measured rather than eyeballed: the
intuitive answer — "use the same numbers as the price bands" — nearly breaks the
economy, because the price family spans 10 to 1,000 while shard income is about
50 a contract.

**And the derived set was paying the wrong shape.** Shards per second of work:

| band | cost | derived | doubling |
| --- | --- | --- | --- |
| quick | 90 | 0.522 | 0.444 |
| standard | 150 | 0.493 | 0.533 |
| project | 300 | 0.453 | 0.533 |
| epic | 720 | **0.338** | 0.444 |

A long project paid **0.338 shards a second** against a quick errand's 0.522 — so
the hardest work was the worst deal. That was never intended and was invisible
while the numbers were treated as a spreadsheet to be balanced. The round set
flattens the band to 0.44–0.53.

So the legible table is also the fair one, which is the outcome to want and not
one to assume.

### The change

`perCost` is now **40 / 80 / 160 / 320** — a doubling series, multiples of 40, so
`shardsOnly` contracts show 60 / 120 / 240 / 480 rather than a rounded fraction.

The cost is **+1.5% on total shard income** (expected payout per draw 51.0 →
51.8, ladder pace 5,332 → 5,384/hr). That is noise beside the legibility gain
and it is recorded rather than smoothed away, because a table that quietly
shifts income to buy nicer numbers is how an economy drifts without anyone
deciding to change it.

### Asserted, because it was already wrong once

`check:ladder` now asserts every band is a multiple of 10, and that
`band x soloBonus` is a whole number for every band. Verified to fail: setting
`quick: 47` reports *"SHARDS.perCost.quick is 47, which is not a round multiple
of 10"*.

### Verification

`check` 0/0/0. Live panel at 7 slots:

```
Salvage run        60 shards        (40 x 1.5)
Prospecting        120 shards       (80 x 1.5)
Cache detail       34 compute + 40 shards
Region detail      114 compute + 160 shards
Datacenter detail  274 compute + 320 shards
Throughput         51 compute       (compute-only: no shard half at all)
```

Note that the COMPUTE figures are not round, and cannot be: compute scales with
live production, so it is `perSecond x cost x payback` and its value depends on
when it is read. Shards are the fixed-price currency, which is exactly why they
can be round and should be.

---

## The contract pool offered work for tiers the player had never seen

Reported as *"it okay to rng but the pool should only base current unlocked —
ex. it should not give task to get the service from higher 2 tier only unlocked"*.

The report is precise and the pool really was doing it. A one-time probe
measured a **fresh save being offered `tier-database`, `tier-region` and
`tier-replica`** — "buy 12 more Datacenters" to a player who owns no Datacenter
and has never had one on screen. The word "more" has nothing to attach to, and
the objective names a row that is not in the game yet.

### The fix is one clause, in the right place

`tierUnits` headroom went from `Infinity` to *"the tier is owned"*:

```ts
headroom: (state, def) => {
  if (def.serviceId === undefined) return 0;
  return (state.services[def.serviceId] ?? 0) > 0 ? Infinity : 0;
},
```

In `METRIC_RULES` rather than in `pickContract`, because headroom is already the
gate the picker consults *and* the clamp `objectiveSize` applies. One rule, both
callers, and the metric table from the previous refactor is what made it a
one-line change.

The two tier metrics now describe the same ladder from opposite ends, and between
them they cover it without either asking for a row that is not there:

| metric | offers | widens with |
| --- | --- | --- |
| `tierUnits` | a tier you already run | each tier you open |
| `tierOwned` | the next tier you have not opened | the frontier moving |

Measured, the pool widens exactly as the fleet does:

```
nothing owned   0 buy-more + 1 first-time
worker only     1 buy-more + 1 first-time
worker+cache    2 buy-more + 1 first-time
first four      4 buy-more + 1 first-time
all eight       8 buy-more + 0 first-time
```

### The RNG stays, and the comment about it was a lie

The draw is still seeded and still random — it is uniform over the **eligible**
pool. The design is that the pool shrinks to fit the player rather than a
weighting trying to guess what fits, because **a bias has to be kept in step with
the content by hand**, and this one was wrong twice: it offered 22% prestige
contracts while starving clicks to 4.5%, because it compared `def.amount` across
metrics that do not measure the same thing.

Worth recording: the docstring above `pickContract` claimed *"cheaper definitions
are weighted up early"* while the call site passed `() => 1`. It had been uniform
for some time. **A comment describing a behaviour the code does not have is worse
than no comment**, because it is the thing a reader trusts instead of reading the
call site. That comment is gone.

### Asserted, and proven to fail

`check:progression` gained an eligibility sweep: 40 seeds × 5 fleet states, fill
every slot, and assert that no offer names a tier the player does not own, that
`tierOwned` only ever names the frontier, that `abilityUses` only names an
unlocked ability, and that the def set WIDENS with the fleet.

Two details make it a real check rather than a tautology:

- It reads the **engine** for its answers — `abilityStatuses()` supplies ability
  availability, service counts supply tier ownership. A copy of the rule in the
  checker would pass while the engine disagreed, which is the failure mode the
  whole section exists to catch.
- It was run with the gate reverted. It reproduces the report exactly:

  ```
  FAIL  nothing owned   owned 0 -> 8 buy-more + 1 first-time
        tierUnits 'tier-replica' for an unowned tier 'replica'
        tierUnits 'tier-cache' for an unowned tier 'cache'
  ```

  and the widening assertion catches the opposite failure — a gate so tight the
  pool never grows.

**A bug in this check was found by running it.** The first version counted
`tierUnits` and `tierOwned` defs into one total, so every case reported "one too
many". The engine was right and the check was wrong, which is the outcome that is
easy to misread as an engine bug when the first thing you do is go looking in the
engine.

### Verification

`check` 0/0/0 · ladder pace unchanged at 5,384 shards/hr · expected shards/draw
unchanged at 51.8 · uniqueness 160/160 · eligibility 5/5 · build clean.

---

## A contract that paid in the currency it asked you to collect

Reported as *"contract that collect shard to reward shard is weird, it should not
have this contract — only get n compute to reward shard is make more sense"*.

The salvage pair asked for **shards** and paid **shards**:

```
Salvage run    Earn 500 more shards    →  80 shards
Prospecting    Earn 1,200 more shards  →  300 shards
```

The objective and the payout were the same currency, so the contract was partly
paying for itself: some of the "earn N shards" progress came from the reward for
finishing it. It is also the one place in the game where a reward does not come
from a different activity than its objective — every other contract asks the
player to do something and pays them for it.

### The replacement reads better too

| | objective | payout |
| --- | --- | --- |
| **before** | Earn 500 more shards | 80 shards |
| **after** | Earn 5.0M more compute | 80 shards |

The objective is now the thing the fleet actually makes, and the payout is the
thing the ladder costs. Same costs as the defs they replace (`quick` and
`standard`), so the per-contract payout is byte-identical — only what the card
asks for changed.

### The `shards` metric is deleted, not left unused

With those two defs gone, nothing measured `shardsEarned` any more. An unused
`MetricKey` member means an unused rule in `METRIC_RULES`, an unreachable case
in `format.ts`, and — as the earlier refactor found — a metric that still
compiles while doing nothing. So the member is gone from `MetricKey`, the rule
from `METRIC_RULES`, the label case from `contractObjective`, and the sizing
helper `shardIncomePerSecond()` with them.

`state.shardsEarned` **stays**: two upgrade reveal gates read it, so it is live
state rather than a leftover.

The checker now enforces the general rule rather than this one instance. It reads
a `CURRENCY_METRICS` map of metrics that measure a currency, and fails any def
whose `reward` equals the currency its metric measures:

> `FAIL: salvage-1 measures 'shards' and pays 'shards' -- a contract must not pay
> in the currency it asks the player to collect`

That is what keeps the circularity from being reintroduced by a future def, which
is the only reason to write a rule down.

### Measured: the faucet barely moves, and my estimate was 20x too big

The two defs moved from a private `shards` subject to sharing `totalEarned` with
the four throughput defs, and a subject hosts exactly one contract. So the
salvage pair now has to compete to be on the panel at all.

I estimated a **33% drop** in shard income from subject arithmetic. Measured, by
patching `serviceId` in memory to give the salvage defs a private subject again
(a one-time probe — safe here in a way an earlier ablation was not, because the
probe refills from a fixed state so there is no trajectory to diverge):

| state | private subject | shared subject | change |
| --- | --- | --- | --- |
| fresh | 37.3 | 35.1 | −5.8% |
| early | 37.6 | 36.1 | −3.8% |

---

## The objectives became fixed numbers, and the pacing moved to the faucet's rate

Reported as *"contract quest still growth too fast 75 service at early game?"*,
and then, once the shape was discussed, as *"the number of services already
scaled by price — the quest should fix number of service"*. Both halves of that
are the same complaint: the card was showing a number that got bigger the richer
the player became, and it was doing it while the WORK stayed the same size.

### What was wrong, and it was measurable

`services` was sized as `unitsAffordable(cost) x growthCorrection`, where
`unitsAffordable` is

```
perSecond x seconds / priceOfTheNEXTUnit
```

That prices **every** unit at the marginal price of the next one. But a tier's
`n`th unit costs `baseCost x 1.15^n`, so the 75th unit is ~1.15^74 ≈ 37,000x the
first. The objective was therefore asking for far more units than `cost` seconds
can buy, and the ratio grew without bound as production grew. Measured on the
baseline before any change:

| metric | typical completion | share of its declared band |
| --- | --- | --- |
| `totalEarned` | 24.5s | 13.8% |
| `services` | 30.0s | 29.9% |
| **`milestones`** | **300.0s** | **194.7%** |
| **`tierUnits`** | **219.5s** | **145.2%** |

So `milestones` took **twice** its declared band and `tierUnits` half again.
"Takes too long to finish" is not an impression about those two metrics, it is
the arithmetic.

### The change

- **`services`, `milestones` and `tierUnits` carry a fixed `amount`.** 1 / 5 /
  10 / 25 units by band for `services`; 1 step for `milestones`; a per-tier
  amount from 25 (Worker) to 1 (Datacenter) for `tierUnits`.
- **`totalEarned` keeps its rate-derived objective**, and is now the only metric
  sized from production. Compute scales without limit, so "earn 90 seconds of
  production" is a fair ask at any point in a run — the rule that made a fixed
  ask right for units makes it wrong for compute.
- **`unitsAffordable` is deleted**, and with it the linear extrapolation that
  ignored the cost curve. It had no other caller.
- **`CONTRACTS.growthCorrection` survives with one reader** (`totalEarned`),
  re-measured from 12 to 16 — see below.
- The three milestone defs became **one**, at the `epic` band. That cost no panel
  variety at all: `contractSubject()` is the metric plus the tier or ability, and
  all three shared the subject `milestones:`, so the picker could never put two
  of them on the panel at once. They were three sizes of one quest.

`milestones: 1` at epic is not a small ask. A step is `MILESTONE.step` (25)
units in **one** tier — the same unit burden as `expansion-3`'s 25 units across
the fleet, and concentrated rather than spread. That identity is the distinction
`tierUnits` exists to draw, and it is why the two numbers land on the same 25.

### The eligibility rule, and the belief it disproved

A fixed ask needs something to stop a fresh save being handed an epic-sized job,
so `METRIC_RULES[metric].ready` was added: for the three unit metrics it is
`value(state, def) >= def.amount` — a contract asking for N more of something is
offered once the player already HAS N of it.

**I expected that rule to bound the completion rate on its own**, and the
reasoning was that the ask is then always about a *doubling*, which costs roughly
the same time at every scale because unit costs grow geometrically. That
reasoning is wrong, and the measurement said so immediately.

Measured with the eligibility rule and no rate limit: **305 contracts an hour**
against the 65 the ladder is priced for, with daily shard income up 61%
(69,258 → 111,451) and the ladder clearing at 0.84h instead of 2.9h.

The flaw in the reasoning: **unit counts plateau while production does not.**
The fleet settles around 2,000 units and stays there, so `owned >= amount` is
satisfied long before buying the ask becomes slow, and "25 more units" is a
few seconds of production late in a run however the fleet is shaped. The
per-tier numbers bear it out — `services` completed in a typical **3.5s**
(1.5% of its band) and `milestones` in **4.3s** (0.6%).

This is the fourth instance in this file of a value that *looks* like it can be
reasoned about and must actually be measured, and the second where the model of
the system (not the arithmetic) was wrong.

### So the pacing is a rate limit, and the panel is allowed to be short

`CONTRACTS.offerMs` = 55 seconds of `playtime` per issued contract, plus
`CONTRACTS.active` issues up front so the opening panel is always full.

The rate is bounded here rather than by growing the objective, because **the
objective is exactly the thing that had to stop growing** — that was the report.
This leaves every card a round, readable number and puts the pacing in one
constant that `check:progression` measures.

Verified: the rate lands at **68/hr** against a reference of 65. Negative-tested
by setting `offerMs: 1`, which measures **265/hr** and makes the checker FAIL —
so the gate is load-bearing and the check can actually fail.

**The cost, stated plainly.** A slot's work finishes in seconds while its refill
takes about a minute, so late in a run the panel legitimately holds fewer cards
than it has slots. Panel pace and faucet rate cannot both be held at 65/hr with a
fixed objective and a production-scaled payout; the faucet is the one the ladder
depends on. The panel says so instead of leaving a gap: `msUntilNextContract()`
drives a countdown in the readout, replacing "each pays what it costs", which had
become a false claim about the payout the moment the sizes were fixed.

Three plumbing details that are load-bearing:

- **`state.contractsIssued` is a persisted counter**, not derived from the
  panel. `ui.ts` empties `state.contracts` on a Reboot, so deriving it would
  hand back a full budget of issues on every prestige.
- **`applyReboot` refunds exactly what it clears** (`CONTRACTS.active`), so the
  panel is not left empty for minutes after a prestige, and a Reboot cannot farm
  contracts because it returns the same number it removes.
- **`sanitize()` defaults the counter from `playtime`**, not to zero. Zero would
  be badly wrong: the allowance is `active + playtime / offerMs`, so a save with
  ten hours on it would arrive holding ~650 unspent issues and dump them in one
  tick. Deriving the default from the same `playtime` the allowance is computed
  from means a returning save resumes with exactly the budget it had accrued.

### `growthCorrection` had to be re-measured

It was 12 while four metrics shared it. With `totalEarned` as its only reader it
produced a typical completion of **16.0s**, under `check:progression`'s 20s
"near-free payouts" floor — because the throttled contract rate had flattened the
production curve the correction was calibrated against. It is **16** now, which
measures 22.0s.

15 was tried first and measured 20.0s against a 20s floor: a pass by a hair. A
bound satisfied to the decimal is not satisfied, it is pending. Any later edit to
`offerMs` moves this number again.

### What the checkers had to be told

Both encoded the old design as an invariant.

- `check:upgrade-ladder.mjs` carried a hardcoded list of fixed-amount metrics and
  **failed** a fixed `amount` on any other metric, with the message *"a fixed
  objective is the bug this redesign removed"*. The list grew by three.
- `check:progression.ts` listed the three metrics as `rateSized` /
  `magnitudeSized`, and asserted a realised-seconds floor and a band ratio that a
  fixed objective cannot meet — and should not: "bring 25 more services online"
  is *supposed* to be quick once the fleet is large. Those metrics left the list;
  the property that replaced the per-metric time check is the offer rate, which
  the existing `referenceContractsPerHour` tolerance assertion now guards.

The pace model in `check:ladder` divides by the count of ALL defs while skipping
compute-reward ones, so removing two compute-reward defs and adding two more kept
the pace **bit-for-bit unchanged at 6.7h** — they were kept equal deliberately.
Moving `deepening-3` from `project` to `epic` is invisible to that model,
because a compute-reward def is skipped before its band is read.

### Verification

`check` 0/0/0 · `check:ladder` 64 upgrades, 34 defs, pace 6.7h unchanged ·
`check:progression` 8/8 seeds, 68/hr, all assertions pass, negative-tested at
`offerMs: 1` (265/hr, FAIL) · live: fresh save shows fixed objectives and no
services quest until a unit is owned; a 90-unit save shows `Buy 25 more Workers`,
`Buy 10 more Caches`, `Bring 5 more services online`; an emptied panel reads
`next contract in 33s` and refills one card per 55s.

---

## The milestone payout became 10 … 30 across the tiers, and the step factor capped at x2

Requested as *"increase the shard reward in milestones … from 10 to 30 per tier,
each stepup milestones increased the shard reward"*, then narrowed to
*"start worker at 10 data center at 30"* with the sequence `10 / 12 / 15 / 18 /
21 / 24 / 27 / 30`.

### The requested sequence cannot be produced by the old formula

The payout was

```
perMilestone x (1 + milestoneTierGain x tierIndex) x (1 + milestoneStepGain x steps)
```

and the tier term is **affine in the index, so its differences are constant**.
That can express `10 13 16 19` but not `10 12 15 18`, whose first step is +2 and
whose remaining steps are all +3. No `(perMilestone, milestoneTierGain)` pair
fits, and `milestoneTierGain: 0.25 -> 2/7` only gives the right endpoints with
fractions in between.

The one exact fit — `perMilestone: 9, milestoneTierGain: 1/3` — is blocked
because `check:ladder` asserts `perMilestone` is a round multiple of 10.

So the tier term became a **table**, which the codebase already does for the same
reason in `SHARDS.tierBands`, `globalBands` and `revealAt`:

```ts
milestoneTierMult: [1, 1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3],   // 10 12 15 18 21 24 27 30
```

`milestoneTierGain` is deleted rather than left behind at 0.25 — a dead constant
beside a live table is how the next reader misreads which one pays.

The step term became `x N` (`min(stepsBanked + 1, milestoneStepMax)`), replacing
`1 + 0.01 x stepsBanked`, which was a 1.2x ceiling that read as "more as the
milestone grows" only in prose — the 4th milestone paid 4% more than the 1st.
The `+ 1` is the whole definition: `stepsBanked` counts milestones ALREADY
banked, so the first crossing on a tier arrives at 0.

### The cap is the entire story, and 5 was catastrophic

**An `x N` cap is the EFFECTIVE multiplier, not a rare ceiling.** A developed
tier has several milestones banked already — a tier at `MATURE_UNITS` (100) is on
its 4th — so `min(N + 1, cap)` sits AT the cap for most of a run's steps. The
faucet therefore scales roughly with the cap rather than with the step count,
which is the opposite of what `x N` suggests.

Measured over 8 seeds, changing only the cap:

| cap | avg shards/step | shards/day | milestone share | `totalEarned` | gates |
| --- | --- | --- | --- | --- | --- |
| 5 | 79.45 | 483,077 | 54.4% | 17.5s | **FAIL** |
| 2 | 35.95 | 141,830 | 49.1% | 26.0s | pass |
| (before) | 18.91 | 37,043 | 19.6% | 22.0s | — |

At 5 the faucet ran **13x** its previous size, the ladder became almost free, and
`totalEarned` fell under the checker's 20s floor — the documented
`perMilestone: 30` failure arriving on schedule, from a different direction.
**2 is the largest cap that leaves every gate green.**

This is the third time in this file that a milestone-faucet buff has hit the same
wall, and the mechanism is identical each time: the faucet pays for milestones,
milestones come from units, units come from compute, and compute comes from the
upgrades that shards buy.

### Two reference constants had to follow, and the ladder got FASTER

`check:progression` asserts every reference rate against its measurement, so both
moved:

| constant | before | after |
| --- | --- | --- |
| `referencePerMilestoneStep` | 18.4 | **35.95** |
| `referenceMilestonesPerHour` | 23 | **33.8** |

The milestone *rate* rising 23 -> 33.8/hr is the feedback loop, not a rounding
artefact: richer shards buy upgrades sooner, which crosses more boundaries.

`check:ladder` converts the price table into hours using both, so the pace moved
**6.7h -> 4.8h** — still inside the 3.25–6.75h band and now closer to the 5h
target it had been drifting past. `growthCorrection` did **not** need to move
(this time), because the cap that keeps every other gate green also keeps
`totalEarned` clear of its floor at 26.0s.

### New assertions, negative-tested

`check:ladder` gained two, both of which were verified to FAIL before shipping:

- the tier table's **length matches `SERVICES`** (a short table silently pays the
  base rate past its end), its **first entry is 1** (otherwise `perMilestone` is
  a ceiling rather than a floor and every doc is wrong), it is **non-decreasing**,
  and it is **not flat** (a flattened table makes the term dead content);
- `milestoneStepMax` is **at least 2** and **at most 10** — above that the
  faucet compounds with itself, which is exactly what cap 5 measured.

### Verification

`check` 0/0/0 · `check:ladder` OK, pace 4.8h in band, both new assertions
negative-tested (cap 20 -> FAIL, flat table -> FAIL) · `check:progression` 8/8
seeds, all assertions pass, `referencePerMilestoneStep` 18.4 -> 35.95 measured
and matched, `totalEarned` 26.0s clear of its floor · `build` clean.
| mid | 39.0 | 37.7 | −3.4% |
| late | 44.1 | 43.8 | −0.6% |
| mature | 64.8 | 66.7 | **+2.9%** |
| **mean** | **44.6** | **43.9** | **−1.5%** |

**−1.5%, not −33%.** The reason is visible in the same table: the share of panel
slots that pay shards barely changes (54% → 55%), because when the `totalEarned`
subject draws a compute-payer, another subject fills in behind it. Subject
arithmetic counts which subject is chosen; it does not account for the fact that
the panel has five of them.

No compensation was applied, because none is warranted. The estimate was written
down before it was measured and it was wrong by more than twenty times, which is
the reason the measurement exists.

### Verification

`check` 0/0/0 · ladder pace unchanged at 5,384 shards/hr · expected shards/draw
unchanged at 51.8 · uniqueness 160/160 · eligibility 5/5 · build clean, CSS 0
non-ASCII. Live panel:

```
Salvage claim    Earn 1.00Qa more compute   60 shards
Refurbishment    Earn 1.00Qa more compute   120 shards
Throughput       Earn 1.00Qa more compute   51 compute
```

---

## Things deliberately not built

- No sound, leaderboards, accounts or server-side saves.
- No save export/import (considered, deferred — local autosave covers the
  common case).
- No framework, no state-management library, no animation library.
- Real technology brand logos were considered and rejected for the CV's
  design language; the game's icons are monochrome thin-stroke glyphs instead.

---

## Environment notes

- Node is not installed in WSL, so npm commands run in PowerShell.
- The PowerShell terminal only reliably executes the first line of a
  multi-line paste.
- Write git commit messages to a file and use `git commit -F`; heredocs mangle
  backticks, which silently strips code identifiers from the message.

---

## Rename: Deploy Services is now Deploykorn

The game's identity changed from **Deploy Services** to **Deploykorn**. The name
is a coinage: `deploy` fused with *korn*, the etymological root of **kernel**
(Old English *cyrnel*), so the word reads as "the kernel of deploys" rather than
two dictionary words joined by a hyphen. It had to be a single word, readable as
a title (`Deploykorn — an idle simulation`) and as a URL path, and it had to
collide with nothing already named in the game -- `korn`/`kernel` appears
nowhere in the content.

This is an identity change only. The game's verb is still *deploy*, the balance
is untouched, and the save key `cv.idle.save.v1` is not derived from the title,
so **no save migration was needed** and existing saves load unchanged.

Changed: the page title, the `<h1>`, the header wordmark (`DS` -> `DK`), the
footer, the `package.json` name, and the default `BASE_PATH`
(`/deploy-services` -> `/deploykorn`). The GitHub workflow derives the base path
from the repository name, so renaming the repository is the whole deployment
side of the change. `public/favicon.svg` is an abstract monogram with no letters
and needed no redraw.

The checks are the proof that this stayed identity-only: `check` 0/0/0, the
ladder pace unchanged, and `check:progression` reporting the same units,
upgrades and reward mix as before the rename.

---

## The global ladder was trimmed from 42 to 32

The shop-wide upgrades were cut from forty-two to thirty-two, taking the ladder
from 74 rungs to 64. The ten removed were chosen to be *same-kind repeats*
rather than distinct mechanics, so the shop keeps every idea it had:

| Removed | Was a repeat of |
| --- | --- |
| `auto-3`, `auto-4` | `auto-1` (3/s deploys) and `auto-2` (3.5/s buys) |
| `cost-3` | a third identical 15% cost cut |
| `milestone-2` | `milestone-1`, same +1x |
| `click-5` | `click-4`, same x5 |
| `contract-4` | `contract-2`, same +2 slots |
| `reserve-2`, `reserve-3` | two more reserve-rate steps |
| `offline-3` | a second offline-cap step |

### The power was folded, not deleted

This is the part that matters. A first attempt simply deleted the ten rows and
measured the result: `check:progression` fell from **75 contracts/hr to 38**,
and units at 24h from 2,597 to 2,187. Deleting an upgrade deletes its *value*,
so the trim had quietly made the game much harder.

The fix was to look up how each effect accumulates in the engine and fold the
removed value into a surviving upgrade **of the same kind**:

| Survivor | Was | Now | Preserves |
| --- | --- | --- | --- |
| `auto-1` | 3/s | 6/s | `autoDeploy` is summed: 3+3+8 = 6+8 |
| `auto-2` | 3.5/s | 7/s | `autoBuy` is summed: 3.5+3.5+8 = 7+8 |
| `cost-1`, `cost-2` | 0.85 each | 0.784 each | `costMult` multiplies: 0.85^3 = 0.784^2 |
| `milestone-1` | +1 | +2 | `milestone` is summed |
| `click-4` | x4 | x20 | `clickMult` multiplies: 2x3x4x4x5 = 2x3x4x20 |
| `contract-2` | +2 | +4 | `contractSlots` is summed |
| `reserve-1` | 0.005 | 0.03 | `reserveBonus` is summed |
| `offline-1` | 8h | 32h | `offlineCap` is summed |

`cost-1` and `cost-2` were set *equal* rather than stacked, because they share a
price band and two same-price rows with different values is the shop telling the
player one of them is not worth buying -- the same fault the global multipliers
were flattened to fix.

**One removal could not be folded.** `offline-2` raises away-efficiency to full,
and `offlineEfficiency` takes a `max` rather than a sum, so there is no other
row to carry it. Away production therefore stays at the base 50% permanently.
That is a deliberate, documented nerf rather than an oversight.

### Prices were re-based, and that is what the pace is now measured against

With 64 rungs the band table could not keep its old boundaries -- the last band
must still reach the highest rung. The first attempt used eight rungs per band,
which put `shards-1` (the first shard-income upgrade) into the 1000 band, before
the ramp it begins. `check:ladder` caught it:

```
FAIL: shards-1 alone takes 0.5h, more than 10% of the run
```

The bands were moved to **8, 8, 8, 8, 10, 10, 12** rungs, which keeps the shard
upgrades in the 500 band where they arrive in time to matter. Measured after the
change:

```
upgrades: 64 (8 tiers x 4 = 32, 32 global)   total 22160
pace: 5.6h to clear (target 5h +/- 35%)
slowest rung: region-4 at 0.26h (4.6% of the run)
```

`check:progression` reports the economy back at **72 contracts/hr**, 2,539 units
and 62 upgrades at 24h, against 75 / 2,597 / 70 before. The remaining gap is the
removed `offline-2` and the re-based prices; the early fleet ramp is slower
(100 Datacenters at 2.2h against 0.79h) because the mid-ladder upgrades now sit
in dearer bands.

### The lesson

This is the session's recurring one, restated: **an upgrade is a quantity, not a
row.** Removing rows from a balance table is a balance change whether or not the
maths was intended, and the only way to know how much is to run
`check:progression` before and after. The first trim looked tidy and halved the
contract rate.

---

## Achievements grew from 41 to 64

Twenty-three achievements were added to fill gaps in the existing chains, giving
**64** in total. No id is reused, which matters because achievement ids are
storage keys and `sanitize()` is a strict allow-list -- a duplicate or a rename
would silently strip an unlock from an existing save.

| Group | Before | Added | After |
| --- | --- | --- | --- |
| Deploys | 6 | 4 | 10 |
| Fleet | 7 | 5 | 12 |
| Output | 13 | 5 | 18 |
| Idle | 6 | 4 | 10 |
| Prestige | 9 | 5 | 14 |

By rarity: 11 bronze, 16 silver, 24 gold, 13 mythic.

The additions extend chains that already existed rather than inventing new
verbs: deploy counts continue past 1,000, fleet size past 500, output past a
trillion compute and a billion per second, absences past 20, cores past 100. Two
are worth calling out separately:

- **`shards-1k` / `shards-100k`** reward lifetime *shard income*, which nothing
  previously acknowledged. Shards are the upgrade currency and the only thing
  contracts pay, so a milestone on `shardsEarned` is the one obvious axis the
  set was missing.
- **`fleet-deep-300`** rewards a single tier reaching 300 units. The fleet
  plateaus "a little over 300" per the milestone note, so this sits at the
  ceiling of what a tier can reach -- deliberately, because depth is the strategy
  the milestone rule is built to encourage.

### Measured impact

| | Before | After |
| --- | --- | --- |
| Contracts/hr (median) | 72 | 69 |
| Units at 24h | 2,539 | 2,815 |
| Milestone steps | 101 | 109 |

A modest increase: about +8% units, with the contract rate flat within noise.
Twenty-three rewards sound like a lot, but most are `globalMult` at silver or
gold (1.01 / 1.025) and they *multiply* against an existing total, so they add a
few percent rather than compounding into a new tier of power. `check:ladder` is
unaffected -- its pace model reads a fixed reference rate, not achievement power,
so it still reports the same 5.6h.

### A reporting bug this surfaced

`check:progression` printed

```
SHARDS.pacing.referenceContractsPerHour = 12 (assumed)
```

while `content.ts` declared **80**. The line was a hardcoded local constant
(`REFERENCE_CONTRACTS_PER_HOUR = 12`) wearing the *name* of a content field, so
the report had been comparing the measured rate against a stale number that no
longer existed anywhere in the game -- and disagreeing with the field it claimed
to print. It now reads `SHARDS.pacing.referenceContractsPerHour` directly, so the
two cannot drift:

```
SHARDS.pacing.referenceContractsPerHour = 80 (assumed)
measured median                          = 69 contracts/hr
```

The remaining gap (80 assumed against 69 measured) is real rather than a bug,
and is the honest version of the comparison the line was always trying to make.
`SHARDS.pacing` documents that the reference is "kept in step with"
`check:progression`, so 80 is now a candidate for reconciliation if the ladder's
hour figure is ever retuned.

The general lesson is the one already recorded twice in this file: **a label that
names a derived fact must read that fact.** A constant that merely sits under a
matching label will drift, and will do so invisibly, because the output still
looks authoritative.

---

## The glyph set stopped repeating itself (15 new icons)

Fifteen line glyphs were added and roughly sixty `icon:` assignments were
re-pointed, because the icon set had stopped carrying information.

**The measurement, not the impression.** Across the 165 `icon:` slots in
`content.ts`:

| Glyph | Before | After |
| --- | --- | --- |
| `chart` | 14 | 6 |
| `target` | 14 | 3 |
| `grid` | 11 | 7 |
| `repeat` | 10 | 3 |
| `layers` | 9 | 7 |
| `bolt` | 7 | 5 |
| **busiest glyph** | **14** | **7** |
| **distinct glyphs in play** | **30** | **44** |

The worst case was not a busy generic icon but a specific one: **eight of the
fourteen `target` uses were the eight `open-*` contracts.** Every "stand up your
first <tier>" card drew the identical mark, so the eight rows were visually
interchangeable at exactly the point the player is learning to tell the tiers
apart. Each now carries its own tier's glyph — `cpu`, `layers`, `conduit`,
`disk`, `scales`, `cluster`, `broadcast`, `server` — which also means the
contract, the service card and the HUD agree on what a Queue looks like.

### The rule the new marks follow

Every glyph is chosen for what the **word** says, not for a passing resemblance.
`worker-1` is named Fan-out, so it gets the fan. `balancer-4` is Consistent
hashing, so it gets the ring. `queue-1` is SLA work, so it gets the ledger.
`shards-2` is Liquidation and `shards-6` is Asset recovery, so both get the
funnel and the beaker rather than another chart.

That is the same rule the shard glyph arrived at after four names and three
redraws, recorded above: **the mark has to agree with the word.** The corollary
is that a batch of new icons is really a vocabulary exercise — most of the work
was deciding which word deserved its own mark, not drawing it.

### Two things this deliberately did NOT do

- **Reuse is not itself the fault.** A shared glyph for a shared idea is the
  whole point of the set; `deploy` on the deploy button and the deploy
  achievements is correct. The fault was a glyph whose meaning had spread to
  cover unrelated ideas.
- **No glyph was deleted.** Several are now used less, but a mark that is right
  somewhere is worth keeping defined — the alternative is redrawing it later
  from memory.

### Verification

`npm run check` is the guard, because `IconKey` is a closed union: a mistyped
name fails the build. But the union does **not** prove the name has artwork —
`GLYPH_MARKUP` is typed `Record<string, string>`, so a declared key with no entry
renders the fallback circle *silently*. That gap was closed by audit rather than
by assumption, and by a browser check:

- **every one of the 45 declared `IconKey`s has markup** — none can fall back;
- **163 glyphs rendered in the browser with 0 resolving to the fallback**;
- `check:ladder` and `check:progression` unchanged (icons are presentation, so
  any movement in those numbers would have meant a content edit had gone wrong).

The general lesson, which is the third time this file has recorded a variant of
it: **a declaration is not an implementation.** A type that says a name is valid
says nothing about whether the thing behind the name exists.

---

## Achievements rebalanced: 64 -> 78, and four new reward kinds

The achievement set was reworked for four reasons, all of them reported from
play rather than found by inspection:

1. rewards were too small to notice;
2. the deploy chain ran to 40,000 clicks, long past the point anyone clicks on
   purpose;
3. rarities did not ascend with their thresholds, so the panel -- which orders
   by rarity -- showed easier achievements above harder ones;
4. the set was mostly MORE STEPS of the same few measurements, not new kinds.

### The rarity inversion, which was the visible bug

`services-750` was **silver** while `services-250` was **gold**. Since
`ui.ts` sorts each group by `RARITY_ORDER`, the panel drew "own 250" above
"own 750". Rarity is not decoration here: it drives the glyph stroke weight,
the reward size, and the sort. A rarity that does not ascend with its threshold
is not a tier, it is a typo the player can see.

The whole fleet chain was re-checked for monotonicity and two entries fixed:
`services-750` silver -> gold, `services-1500` gold -> mythic.

### The deploy chain now ends at 1,000

Four achievements were **deleted** -- 2,000 / 7,500 / 15,000 / 40,000 clicks --
rather than retuned, and their power was folded into the survivors so the
chain's total is unchanged. A thousand deliberate presses is already far past
the point where anyone is clicking on purpose, so the extra rungs were content
nobody would see. The deploy group is now six, ending at 1,000.

### Four new reward kinds, all of them completing existing plumbing

`Modifiers` already declared and initialised `contractSlots`, `shards`,
`reservePer` and `coreAmplify`, and `shardMult` already read `mods.shards` --
but **no achievement ever wrote any of them**, so three fields were dead and the
reward set could not touch the shard economy at all.

| Reward | Effect | Wired by |
| --- | --- | --- |
| `shardGain` | Shards per contract x N | already consumed (`shardMult = mods.shards`) |
| `contractSlots` | +N concurrent contracts | `CONTRACTS.active + mods.contractSlots` |
| `reserveBonus` | +X% per shard held | seed `reservePerBonus` from `mods.reservePer` |
| `coreAmplify` | Cores multiply the reserve harder | seed `coreAmplifyBonus` from `mods.coreAmplify` |

This is the cheap kind of feature: the intent was already in the code and only
the content was missing. It is worth noting because the *dead fields were the
tell* -- three initialised-but-unread members is not a style problem, it is a
half-finished design.

### Five new TYPES, not more steps

| Type | Measures | Count | Why it is new |
| --- | --- | --- | --- |
| **Per-service depth** | 100 units of ONE named tier | 8 | The first achievements that name a single service; reward is that tier's own `serviceMult` |
| **Ladder** | `upgrades.length` | 3 | Nothing previously measured how much of the shop was bought |
| **Hoarding** | `shards` held at once | 3 | The first reward for the RESERVE rather than for output |
| **Away earnings** | `totalOfflineEarned` | 2 | The `offline-*` chain counts returns, not what was earned away |
| **Run earnings** | `runEarned` | 2 | `totalEarned` only grows; `runEarned` is what a Reboot pays on |

`serviceMult` rewards went from 2 uses to 12, because the per-service set points
each reward at the row that earned it.

### Rewards raised across the board

| Rarity | Before | After |
| --- | --- | --- |
| bronze | x1.005 | x1.008 |
| silver | x1.01 | x1.015 |
| gold | x1.025 | x1.035 |
| mythic | x1.05 | x1.07 |

A mythic worth five percent read as a rounding error beside the upgrade that
unlocked it. Global multipliers compound, so these stay single-digit
percentages while still being most of the reward.

### Measured outcome

| | Before | After |
| --- | --- | --- |
| Achievements | 64 | 78 |
| Contracts/hr | 69 | 105 |
| Shards in 24h | 1.17M | 3.47M |
| Units at 24h | 2,815 | 2,801 |
| Upgrades at 24h | 62 | 62 |
| Hours to 100 Datacenter | 1.15 | 0.57 |

The shard economy roughly tripled and the contract rate rose by half, which is
the intended effect of adding shard, slot and contract-pay rewards. **The fleet
is flat** -- units and upgrades at 24h are unchanged -- so the extra power went
into the LADDER rather than into runaway production, which is the healthier of
the two places for it to land.

### The reference rate had to move with it

`SHARDS.pacing.referenceContractsPerHour` went **80 -> 105**. This is not a
tuning knob being nudged to make a check pass: the constant's own documentation
says it is "the MEASURED day average, taken from `check:progression`... and this
number is kept in step with it". The measured rate moved, so the constant has to
move with it or the ladder reports a pace the game no longer has. That drift was
already flagged in the previous entry as outstanding; this is it being closed.

With the corrected rate the ladder reports **4.2h** (target 5h +/- 35%), so the
change is inside the band rather than papering over a failure.

### Lesson

Three of the four faults were *presentation of difficulty* rather than
difficulty itself: a rarity that contradicted its threshold, four rungs nobody
would reach, and a reward too small to feel. None of them would fail a type
check or a balance assertion -- the rarity inversion in particular survived
every existing test because rarity was never checked for monotonicity. What
caught it was someone reading the panel and noticing the order was wrong.

The checks assert that content is *well-formed*. They cannot assert that it is
*sensible*, and the difference between those two is where all four of these
lived.

## Achievements trimmed back to 64 and put in a real order

The rebalance above opened with the complaint that the set was mostly MORE STEPS
of the same measurements. Adding ten more entries did not fix that on its own:
it left 78 entries whose ORDER still came from somewhere other than meaning.

### The panel was not showing source order

`ui.ts` sorted every group by `RARITY_ORDER` and then relied on a stable sort to
break ties, so the display order was *rarity, then declaration order*. That is
why the inversion of `services-250`/`services-750` was visible at all -- and it
is also why fixing that one inversion did not stop the panel from interleaving
chains. `overclock-50` (silver) and `ability-master` (gold) are the same
measurement expressed twice; sorted by rarity they were drawn in different parts
of the group, with eight unrelated entries between them.

The sort is **deleted**. The panel now renders `ACHIEVEMENTS.filter(...)` in
source order, which makes the source file the single source of truth for what
the player sees. Ordering is now an authoring concern, and so it is *checked*
rather than inferred.

### `chain` is a required field, not a naming convention

Ordering rules need to know which achievements belong together. The obvious
shortcut -- group by the id prefix before the first `-` -- is wrong, and there
was already an entry proving it: `overclock-50` and `ability-master` measure the
same thing under two different id stems. `deploys-first-deploy` is a third shape.

So `AchievementDef.chain: string` was added and made **required**. Making it
required was itself useful: it immediately failed on `every-tier`, which had
never had one, because the field was optional and the omission was invisible.

### The rule, and how the check enforces it

Within a group, each chain must occupy **one contiguous run**, and rarity must be
**non-increasing** along that run (hardest first).

`scripts/check-upgrade-ladder.mjs` now asserts all of it:

- the parsed count equals a hardcoded `EXPECTED_ACHIEVEMENTS = 64`;
- ids are unique;
- every `chain` occupies exactly one contiguous run per group;
- rarity never increases within a run.

The parser slices the file between `^    id: '...',$` lines rather than matching
whole entries. This matters: three entries carry a comment block above `id`, and
a `{`-anchored regex silently skipped them, reporting "61 parsed" for a file of
64. A parser that under-counts is a parser whose assertions can all pass.

Both halves were **negative-tested** before being trusted -- setting
`deep-worker` to `gold` produced `deep-worker (gold) is rarer than deep-cache
(bronze)`, and renaming `deep-queue`'s chain produced `fleet: chain(s) split
into non-adjacent runs: deep`. Then both were reverted.

### Fifteen entries deleted, not reordered

The trim dropped `deploys-2000`, `deploys-7500`, `deploys-15000`,
`deploys-40000`, `fleet-deep-300`, `services-750`, `services-1500`,
`milestone-2`, `rate-2`, `ladder-25`, `hoard-5000`, `offline-10`, `playtime-2h`,
`overclock-50`, `cores-10`, `reboot-10` and `away-1b` -- the mid-steps of chains
whose ends already made the point. Reordering alone would have left the panel
readable but twice as long.

### Per-service depth is tiered by measured difficulty

The objection to the per-service set was that the same threshold ("100 units")
was bronze for `worker` and also bronze for `datacenter`, which are not the same
task. Reasoning about it is not good enough, so it was measured -- a throwaway
probe mirroring `check:progression` exactly, 8 seeds, hours to reach 100 units:

| Tier | Median hours | Band |
| --- | --- | --- |
| worker | 0.13 | bronze |
| cache | 0.14 | bronze |
| queue | 0.19 | bronze |
| database | 0.23 | silver |
| balancer | 0.26 | silver |
| replica | 0.32 | silver |
| region | 0.45 | gold |
| datacenter | 0.52 | gold |

A clean 4x spread that happens to fall in tier order, so the bands are
`worker/cache/queue` bronze, `database/balancer/replica` silver,
`region/datacenter` gold. The reward numbers only move 1.4 / 1.5 / 1.6 because
`serviceMult` is *already* tiered by value -- base output per unit runs from 0.1
to 44,000, so a flat multiplier paid far more for the harder tier already.

### Measured outcome

| | Before | After |
| --- | --- | --- |
| Achievements | 78 | 64 |
| Contracts/hr | 105 | 111 |
| Units at 24h | 2,801 | 2,759 |
| Upgrades at 24h | 62 | 62 |
| Hours to 100 Datacenter | 0.57 | 0.56 |

Cutting fourteen entries *raised* the contract rate, which is the useful result:
the deleted rungs were mostly low-value mid-steps, and the surviving mythics are
worth more than the sum of what they replaced.

`SHARDS.pacing.referenceContractsPerHour` moved again, **105 -> 111**, for the
same reason as last time and by the same rule: it is documented as the measured
rate, and the measured rate changed. Ladder pace is 4.0h against a 5h +/- 35%
target.

### What this cost, and the lesson repeated

Every previous entry in this file ends with "a value must be measured". This one
adds a second: **display order is behaviour**. Sorting by rarity looked like
presentation and was actually a second, contradictory ordering rule living in
`ui.ts`, invisible to every content check because it lived in the view. Two
sources of order will disagree eventually; the fix is to delete one of them and
check the one that remains.

## Achievement rewards are additive, and the shop's globals were scaled to match

The question this started from was "check the balance of reward from achievement
and upgrade". The answer was not a balance at all.

### What the audit found

Both tables wrote to the same line of `computeStats()`, so they were directly
comparable for the first time:

| Source | Entries | Product |
| --- | --- | --- |
| `ACHIEVEMENTS` with an output reward | 44 | **x3.87** |
| `UPGRADES` with a `globalMult` | 7 | **x1075.35** |

**The shop outweighed the entire achievement set by 278x**, on the one channel
they share. Achievement output was 0.36% of it.

The per-reward view is worse, and it is the reason the totals came out that way.
Every achievement bonus was between +0.8% and +7%. The design note in
`content.ts` justified those sizes with "sixty-odd small multipliers multiplied
together is a large number". It was forty-four, not sixty-odd, and the product
was not large: x3.87 against the shop's x1075.

So both statements in that note were wrong in the same direction, and the
conclusion drawn from them -- keep the values tiny because they compound -- was
wrong too. They compounded into something 0.36% of the thing they were meant to
compete with.

### The rule

> A reward has to be worth reading on the card it appears on. Roughly **+10% is
> the floor of that.** Below it a player sees a number and feels nothing.
> Contributions below the floor are summed within their source; pools from
> different sources multiply.

The floor is what makes this a rule rather than a preference, and it is why only
ONE channel changed shape. Every other reward kind already pays at least +10%
per instance -- `clickMult` from x1.05 to x2.5, `contractReward` from x1.1 to
x1.5, `shardGain` from x1.1 to x1.25 -- so the floor does not bite for them and
there was nothing to fix. `globalMult` was the only channel where no single
reward reached it. `serviceMult` sits at x1.25-1.6 and is multiplicative on
purpose: it multiplies one TIER, and the tier already carries a x440,000 spread
in base output, so a mythic-per-tier would double-count a difference the content
already expresses.

### The change

| | before | after |
| --- | --- | --- |
| achievement `globalMult` | x3.87 (product of 44) | `globalBonus` **x47.0** (sum of 46) |
| upgrade `globalMult` | x1075.35 | **x87.65** |
| **product of both** | **x4161** | **x4120 (-1.0%)** |
| **gap between them** | **278x** | **1.87x** |

`AchievementReward.globalMult` became `{ kind: 'globalBonus'; bonus }`, carrying
percentage points. `Modifiers.global` became `Modifiers.globalBonus`, a **sum**
with 0 as its identity rather than 1 -- a field whose name says "multiplier"
while holding a sum, sitting among fourteen genuinely multiplicative siblings,
is a bug waiting for the next reader.

Rarity now predicts the reward exactly, at 2x per step: bronze +25%, silver
+50%, gold +100%, mythic +200%. Counting the set gives 10 bronze, 9 silver, 15
gold and 12 mythic bonuses, so:

$$1 + 10(0.25) + 9(0.50) + 15(1.00) + 12(2.00) = 47.0$$

The seven shop globals came down to **x1.5, x1.55, x1.6, x1.65, x1.7, x2.8,
x3.0** to hold the product roughly constant. Total power moved **-1.0%**, which
is well inside what the game can feel, and the ladder's pace is driven by SHARD
income, which neither side of this touches.

### What the reshuffle did NOT conserve

Power is not the same thing as shape, and this is the part worth remembering:

| | before | after |
| --- | --- | --- |
| contracts/hr | 111 | **103 (-7.2%)** |
| units at 24h | 2,759 | 2,751 (-0.3%) |
| upgrades at 24h | 62 | 62 |
| hours to 100 Datacenter | 0.56 | 0.54 |
| ladder pace | 4.0h | **4.3h** |

The fleet barely moved; the contract rate fell 7%. A product of forty-four small
multipliers has almost nothing to show until dozens are unlocked, while a sum
ramps **linearly from the very first achievement**. Production therefore arrives
earlier, and a contract's objective -- which is sized from current production --
is met at a different point on the curve. The day average lands lower. That was
not predicted, it was measured.

`SHARDS.pacing.referenceContractsPerHour` moved 111 -> 103 for the same reason
as always: it is documented as the measured rate, so it follows the measurement.
Ladder pace 4.3h against 5h +/- 35%.

### Four content defects found by reading, three now found by a check

Writing the reward tables by hand, over several passes, produced mismatches that
every existing test passed, because each one renders as a slightly larger number
on a card rather than as a broken layout:

1. `services-500` was **gold** but paid a **mythic** bonus, while the harder
   `services-1000` (also gold) paid a gold one. The middle of the chain was the
   best pick.
2. `milestone-3` was **mythic** and paid a **gold** bonus.
3. `reboot-40` (mythic, 40 reboots) granted **no bonus at all** and a smaller
   core gain than `reboot-25` (mythic, 25 reboots). The hardest entry in the
   chain was strictly worse than an easier one.
4. `cores-500` (mythic, five times the cores required) granted **half** the
   burst power of `cores-100` (mythic).

Two of those were already found and fixed by hand in the ordering pass. The
other two were found *by the new assertions*, which is the point: `check:ladder`
now verifies

- every `globalBonus` matches its achievement's rarity;
- within a chain, an easier entry never grants MORE of a reward kind than a
  harder one already granted;
- no `offlineEfficiency` value is granted twice, since that fold is `Math.max`
  and a duplicate can never take effect.

All three were negative-tested by breaking one of each and confirming three
distinct failure messages, then reverting.

### Two comments that were false, and one that was both

- The `content.ts` note claiming "sixty-odd ... is a large number" (above).
- A note about the price bands claiming `global-6` and `global-7` were "the only
  globals in their own band, so they have no band-mate to be unfair against".
  **They are band-mates**: rungs 52-63 all cost 1000 shards, so the two hardest
  globals cost the same and paid x4 and x5 -- a 25% gap for identical money,
  which is exactly the unfairness the comment said did not exist. The rescale
  narrowed it to 7.1%, in line with the first five's ramp.
- The `SHARDS.pacing` prose still said "about **80** contracts an hour" while
  the constant beside it read 111. The previous revision updated the inline
  comment and not the prose. The prose no longer states a figure at all: a
  number repeated in prose is a second copy of a fact that already has an
  owner, and this is the second time the copy drifted.

### The label that made achievements look worthless

`computeStats()` set `achievementMult: mods.global`, and the HUD printed that
beside the total multiplier under the label **"From achievements"**. It was not
lying -- it was the achievement share of the global multiplier -- but the
achievement set's power lived mostly in channels the stat never displayed
(contract pay x6.8, core gain x5.5, eight per-tier multipliers). A player read
`From achievements 1.237x` beside a total in the thousands and concluded the
achievement list was decoration.

Now that the pool is a real multiplier of the same order as the shop's, the
number is the pool that production actually receives. It also goes through
`formatMultiplier()` like everything beside it; it was the only stat using a
hand-rolled `toFixed(3)`, which printed `1.237x` into a column of `1.00x` and
made the honest figure look like the odd one out.

**The label was briefly "From awards", and that was reverted.** The reasoning
was that "achievements" named the LIST while the bonus was a *pool* of awards,
so a stat about the bonus should not use the list's name. It is a defensible
distinction and a distinction the player does not make: the tab, the panel
heading, the unlock notice and `ACHIEVEMENTS` all say achievement, and a stat
that alone said something else was a second name for one thing -- which this
document already warns about twice under the concept work. It reads **"From
achievements"** again.

**The same rule was later applied to "award" as a noun everywhere else.** It
had survived in the multiplier breakdown (`+300% awards`) and in prose about
what an achievement is worth, which is the identical mistake one step smaller:
the noun named a bonus, the rest of the game named the list, and a player
reading both would have had to work out that they were the same thing. Every
such mention now says **achievement**.

The word is kept where it is a VERB meaning "to grant" -- `awardShards`, "the
cores a Reboot awards", "compute awarded for completing a contract". Those coin
no synonym: there is no achievement in sight, and "grant" would be the same
word-for-word substitution with no gain.

### Two shop sections became one, and picked up a name each on the way

The Upgrades panel had grown a section per effect KIND, and two pairs of them
were halves of one idea. `Automation`/`Auto-buy` merged first, then
`Shards`/`Reserve`.

**Merging the sections does not merge the mechanics.** Auto-deploy and auto-buy
still file under separate effect kinds fed from separate sources in the engine,
so the merge is a heading and nothing else. The reason it is safe is the one
already written above under "Automation splits into two channels": the two
channels were separated because one may SPEND and the other may not, and that
constraint lives in `computeStats()`, not in the shop's grouping. A shared
heading cannot reintroduce it.

**The merged section is headed "Reserve"**, and that is a deliberate allowance
rather than a contradiction of the naming work recorded further up. That work
established that *`reserve` must never label a FIGURE* — `x3.00 reserve` was
shown to a player holding no shards and was false, because the mechanic is a
multiplier on production and cores contribute nothing without a balance. A
section heading is not a figure: it is a category, it says what the rows inside
it act on, and the rows themselves state their effect in production. The other
candidate words were worse. "Shards" left `+5% production per core` under a
heading about a different currency. "Prestige" would have put a second
"Prestige" in the UI meaning something narrower than the tab of that name, which
is precisely the drift the concept work exists to prevent.

**So the reserve got a concept and a glyph of its own.** It is a *stock* — the
balance you have NOT spent — while `shards` is the currency you earn and spend,
and the two are now distinguishable at a glance without reading. The glyph is a
strongbox with a lid seam and a clasp. It is deliberately **not** a box with a
dial: that is `vault`, which marks the Treasury row, and the two would appear in
the same section. The hue is the shard hue, because the reserve is the shard
economy seen from the holding side and a seventh blue-green would claim a
distinction that does not exist.

The rows inside the section are ordered by effect kind rather than by price, so
the three income rows read first and the two held-value rows after them. That is
the natural reading order for the pair of questions the section answers: how do I
get more shards, and what do the ones I am holding do.

### The last tab was called Prestige and its panel was called Reboot

Clicking a tab labelled **Prestige** opened a panel titled **Reboot**, whose
button says Reboot and whose four figures are cores, cores-on-reboot, the
compute threshold and the reboot count. The tab was named for the *pillar* and
the panel for the *action*, and the player only ever does the action.

The tab is now `reboot`, and it is named for the action everywhere.

- **Three ids moved together**, because `ui.ts` derives them from the `TabId`:
  `tab-reboot`, `panel-reboot` and `tab-badge-reboot`. `TAB_IDS` in `state.ts`,
  the markup and the CSS selectors all follow, and `values: Record<TabId, ...>`
  made the badge table fail to compile until it was renamed too — which is the
  right way for that class of change to surface.
- **The persisted tab id is bridged, not migrated.** `activeTab` is stored in
  the save, so an existing save holding `prestige` would have failed
  `TAB_IDS.includes()` and silently resumed on Services. `sanitize()` maps the
  old id rather than `migrate()`, because nothing about the schema changed:
  no field was added, removed or reshaped, and `SAVE_VERSION` describes the
  schema. Spending a version bump on a tab rename would also make every future
  reader assume the shape moved.
- **The glyph changed from the bolt to the shield**, read from `GLYPH_MARKUP`
  like the Contracts tab rather than inlined. The shield is the `reboots`
  concept, and it is already the glyph on the panel's own "Reboots" figure, so
  the tab and the figure now agree. The bolt was the compute concept — a glyph
  the tab had no business wearing, since compute is what a reboot RESETS.
- **The tab keeps the core hue.** The label says what the player DOES there and
  the hue says what it PAYS, which is the same division the Deploys tab uses:
  amber for the click stat, "Deploys" for the action.
- **Two orphaned rules went with it.** `.prestige__cores` and `.prestige__medal`
  had no remaining callers — the panel has used `reboot__*` classes since before
  this change — so the section that held them was retitled rather than left to
  imply a block that does not exist.

**The `prestige` ACHIEVEMENT group is unchanged, and that is a judgement rather
than an oversight.** Its id would have been renamed alongside the tab for
consistency, but its four chains are reboots, cores, ability uses and
single-run earnings, and its blurb already reads "Rewards for cores, reboots and
burst power". Naming that bucket "Reboot" would misdescribe three of its four
chains. `Prestige` is the correct umbrella term for the cross-run pillar; it was
only ever the wrong name for a tab that opens one action. The engine's
`PRESTIGE` constant keeps its name for the same reason.

---

## The manual deploy's throughput share became an upgradeable axis

`CLICK.throughputShare` was a constant (0.2). It is now the BASE of an axis that
two shop rows raise to 0.5, via a new `UpgradeEffect` kind, `throughputShare`.

**Why a new kind rather than the existing `clickAdd`.** `clickAdd` already
existed, was already folded in `computeStats()` and already had a `format.ts`
case, and no upgrade used it. It would have been the cheap move and it is the
wrong one. `clickAdd` multiplies the finished `clickPower`, `CLICK.base`
included, so it lifts everything the button already does equally and is worth
most EARLY (while the base dominates). A share point changes the term that
SCALES with the fleet -- `(CLICK.base + perSecond x share)` -- so it is worth
almost nothing early and is the whole click late. Those are different purchases
wearing similar names, which is the same distinction that separates
`serviceAdd` from `serviceMult`.

The two rows REPLACED two others rather than being added, and that is forced
rather than tidy: `check:ladder` asserts the ladder totals `targetTotal` (30,000)
exactly on a contiguous 0..63 rung ladder, and `cache-2`'s cap is the documented
product `64 x 0.02 = 1.28`. A 65th row breaks all three figures at once.

- `synergy-1` (rung 47, 750) now grants +0.1 share. Its `synergy` effect measured
  a few percent of total income beside the four multiplicative globals at the
  same price, because a tier's synergy factor saturates at +50%. `mods.synergy`
  keeps a writer -- the `services-500` achievement -- so the fold is not
  orphaned, but `synergy` is no longer buyable.
- `offline-1` (rung 63, 1000) now grants +0.2 share. Its `offlineCap` +40h was
  the safest row in the shop to spend: eight achievements already grant cap
  hours summing past 90h against an 8h base, so it was worth nothing to a player
  who had earned them, and it is invisible to `check:progression`, which never
  goes away.

**Both ids were kept even though the names now lie.** An upgrade id is a storage
key and `sanitize()` filters `state.upgrades` against this table, so renaming one
silently strips the purchase from every returning save -- no error, no symptom,
shards spent on nothing. This is the rule already recorded for achievement ids,
and the same pattern the achievement `playtime-50h` carries (its id says 50h, its
gate says 20h).

**No `cap` field.** The two rows reach 0.5 exactly, so a cap could never bind,
and a cap that cannot bind is a lie about a number.

Both gates are deliberately ones already proven reachable inside a run
(`state.clicks >= 500`, the same gate `click-3` uses; `state.shardsEarned >=
5000`, the same gate `coreAmp-1` uses). The obvious-looking `clicks >= 10,000` is
unusable: the achievements documentation states 1,000 deliberate clicks is
already past the point anyone clicks on purpose, and the deploy chain tops out
there, so a 10,000-click gate would be unreachable content.

**The contract payout was expected to move 2.5x and did not, measured.**
`contractReward = clickPower x deployMult x contractRewardMult`, so a 2.5x
`clickPower` looked certain to drag the contract rate with it. Measured over 8
seeds it held at 65 contracts/hr (drift 1% against a 50% tolerance), the
milestone rate held at 24.0/hr (4%), and Datacenter 100 and the ladder both
landed on their baseline hours exactly. The reason is the coupling the file
already documents from the other direction: a rate-sized objective is sized as
`perSecond x cost x growthCorrection`, so when production rises the OBJECTIVE
grows with it, and a compute-paying contract's payout is `clickPower`-
proportional -- both sides of the loop scale together and the rate is
self-normalising. No re-baselining of `referenceContractsPerHour` was needed.
`probe:value` ranks the two rows at 48.5% and 66.6% income for 750 and 1000,
against `click-3`'s 293.7% at the same 750 -- strong, ascending with price, and
not dominant.

**One thing not to claim about them.** They are the LEAST click-rate-sensitive
rows in the click group, not the most: across 1 -> 8 clicks/s `click-1` moves
6.53 -> 9.38 per shard while the share pair moves 0.59 -> 0.66, because a share
point's gain is bounded by its ratio to the share it joins (0.1 onto 0.2) while a
`clickMult` of 2 is worth 100% of the whole click at any rate. The badge states
SECONDS (`Deploys +0.1s production`) because the share IS a duration; the click
tree that turns it into a large figure is deliberately not restated on the card.

