# Deploykorn

**An idle game about deploying services, scaling a fleet, and rebooting for
permanent cores.**

### ▶ [Play it now](https://tanakornon.github.io/deploykorn/)

No install, no account, no sign-up — progress saves in your browser.

---

## How to play

1. **Deploy by hand** to earn compute: a flat amount plus a share of production,
   so clicking always matters.
2. **Buy services** — 8 tiers that produce on their own.
3. **Cross milestones.** Every **25 units** doubles *that service's* output.
4. **Take contracts.** They are the **only** source of shards.
5. **Buy upgrades.** 64 permanent ones, 32 tied to a service and 32 global.
6. **Reboot** when a run stalls. You keep **Cores**, which make unspent shards
   produce more. Each run reaches further than the last.

---

## Good to know

- **Spending shards costs you.** Unspent shards produce through the **Reserve**,
  on a rising curve (+10% at 100 held, +100% at 10,000), so hoarding and
  spending are a real trade.
- **Abilities**: Overclock, Surge (25 contracts) and Provision (250 services) —
  bursts on their own cooldowns.
- **Go deep, not wide.** A milestone doubles one service, so concentration
  compounds faster than spreading compute evenly.
- **It keeps running while you are away**, and finished contracts are collected
  when you return. Leave the tab open.
- **64 achievements** grant permanent bonuses. They are ordered hardest-first,
  and related ones sit together: per-service depth, the upgrade ladder, shard
  hoarding, away earnings and single-run earnings each form their own run.
  Their output bonuses are **additive** — a bronze is +25% and a mythic is
  +200%, and they add up rather than multiplying — so a single achievement is
  worth reading on its own, and the shop and the achievement list stay
  comparable halves of your multiplier instead of one drowning the other.

---

## Run it yourself

```bash
npm install
npm run dev
```

Static site built with Astro + TypeScript. No backend, no database, no accounts.

### Verifying a change

```bash
npm run check             # type-check (0 errors, 0 warnings, 0 hints)
npm run check:ladder      # upgrade ladder: shape, both price tables, pace in hours
npm run check:progression # full 24h simulated run: units, upgrades, offer mix
npm run build             # emits index.html
```

`check:ladder` is deterministic and runs in CI on every push. `check:progression`
runs eight simulated days and is run by hand — it is the authority on pacing, and
it fails if the measured contract rate drifts too far from the reference rate the
ladder's pace is computed against. There is also `npm run probe:value`, which
prints a per-shard value table for the upgrade list; it is advisory and asserts
nothing.
