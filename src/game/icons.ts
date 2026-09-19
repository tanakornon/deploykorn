/* ==========================================================================
   Game iconography.

   Two families of thin-stroke line glyphs: a 24px grid, square caps and
   joins, no fills, colour inherited from `currentColor`.

   Kept out of content.ts so the balance tables stay free of presentation.
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

/*
 * The concept, achievement and contract glyphs. Service tiers have their own
 * record below, because they are drawn by a different builder with different
 * stroke and class conventions.
 *
 * Keyed by `IconKey`, so adding content means picking an existing key rather
 * than authoring new artwork.
 */

/**
 * Every glyph, keyed by name. Exported because the static markup in
 * `index.astro` needs raw path data while `ui.ts` needs a built element, and
 * both must read this one record or a concept is drawn two ways.
 */
export const GLYPH_MARKUP: Record<string, string> = {
  /* Arrow rising into a tray: a deploy. */
  deploy: `
    <path d="M12 16V4" />
    <path d="M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
  `,
  /* Two arrows chasing each other: a repeatable or recurring action. */
  repeat: `
    <path d="M4 9a6 6 0 0 1 6-5h8" />
    <path d="M15 1.5 18.5 4 15 6.5" />
    <path d="M20 15a6 6 0 0 1-6 5H6" />
    <path d="M9 22.5 5.5 20 9 17.5" />
  `,
  /* Stacked planes. */
  layers: `
    <path d="M12 3 3.5 7.5 12 12l8.5-4.5z" />
    <path d="M3.5 12 12 16.5 20.5 12" />
  `,
  /* Four cells: a fleet or a grid of services. */
  grid: `
    <rect x="3.5" y="3.5" width="7" height="7" />
    <rect x="13.5" y="3.5" width="7" height="7" />
    <rect x="3.5" y="13.5" width="7" height="7" />
    <rect x="13.5" y="13.5" width="7" height="7" />
  `,
  /* Clock face: time spent, or time away. */
  clock: `
    <circle cx="12" cy="12" r="9" />
    <path d="M12 6.5V12l4 2.5" />
  `,
  /* Wireframe globe: reach. */
  globe: `
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9c2.5-2.6 3.8-5.6 3.8-9s-1.3-6.4-3.8-9z" />
  `,
  /* Shield: survival, durability, repeated reboots. */
  shield: `
    <path d="M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
  `,
  /* Flame: peak load. */
  flame: `
    <path d="M12 21c3.9 0 6.5-2.5 6.5-6 0-4-3-5.5-3.5-9-2 2-3 3.5-3 5.5-1 0-2-1-2-2.5-2 2-4.5 4-4.5 7 0 3.5 2.6 5 6.5 5z" />
  `,
  /* Lightning: power, cores, overclock. */
  bolt: `
    <path d="M13.5 2.5 5.5 13.5h5l-1 8 8-11h-5z" />
  `,
  /* Rising bars: throughput or earnings. */
  chart: `
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="M8.5 20v-6M13 20V9.5M17.5 20v-9" />
  `,
  /* Box: a single unit or service. */
  cube: `
    <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
    <path d="M4 7.5 12 12l8-4.5" />
    <path d="M12 12v9" />
  `,
  /* Concentric rings: a goal. */
  target: `
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" />
  `,
  /* Crown: the top tier of achievement. */
  crown: `
    <path d="M3.5 8 7 12l5-7 5 7 3.5-4v10.5h-17z" />
  `,
  /* Rack: infrastructure at scale. */
  server: `
    <rect x="4.5" y="3" width="15" height="18" />
    <path d="M4.5 9h15M4.5 15h15" />
    <path d="M7 6h2.5M7 12h2.5M7 18h2.5" />
  `,
  /* Gear: tuning, automation, configuration. */
  cog: `
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    <path d="M5.4 5.4l2.1 2.1M16.5 16.5l2.1 2.1M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1" />
  `,
  /* Processor package: a core. */
  cpu: `
    <rect x="7" y="7" width="10" height="10" />
    <rect x="10.5" y="10.5" width="3" height="3" />
    <path d="M12 2.5V7M12 17v4.5M2.5 12H7M17 12h4.5" />
  `,
  /* Storage cylinder: durable data. */
  disk: `
    <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" />
    <path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" />
  `,
  hourglass: `
    <path d="M6.5 3h11M6.5 21h11" />
    <path d="M7.5 3v2.5c0 2.5 4.5 4.2 4.5 6.5s-4.5 4-4.5 6.5V21" />
    <path d="M16.5 3v2.5c0 2.5-4.5 4.2-4.5 6.5s4.5 4 4.5 6.5V21" />
  `,
  /* Medal: a ranked, repeatable accomplishment. */
  medal: `
    <circle cx="12" cy="14.5" r="6" />
    <path d="M9 2.5h6l-1.6 6.6M15 2.5l-1.4 6.6" />
    <path d="M12 11.6l1.2 2.4 2.7.4-2 1.9.5 2.7-2.4-1.3-2.4 1.3.5-2.7-2-1.9 2.7-.4z" />
  `,
  /* Connected nodes: a mesh of services. */
  network: `
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M10.5 7 6.5 15.7M13.5 7l4 8.7M7.5 18h9" />
  `,
  /* Rocket: a step change in scale. */
  rocket: `
    <path d="M12 2.5c3 3 4.5 6.5 4.5 10.5l-2 3h-5l-2-3c0-4 1.5-7.5 4.5-10.5z" />
    <circle cx="12" cy="9.5" r="1.8" />
    <path d="M9.5 16v5l2.5-2 2.5 2v-5" />
  `,
  /* Sparkle: an exceptional, flashy unlock. */
  sparkle: `
    <path d="M11 3l1.7 4.8L17.5 9.5l-4.8 1.7L11 16l-1.7-4.8L4.5 9.5l4.8-1.7z" />
    <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  `,
  /* Star: top-tier excellence. */
  star: `
    <path d="M12 3.5l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.9l6-.8z" />
  `,
  /* Wrench: hands-on craft. */
  wrench: `
    <path d="M15.5 3.5a4.5 4.5 0 0 0-4 6.6L4 17.6 6.4 20l7.5-7.5a4.5 4.5 0 0 0 6.6-4 4.5 4.5 0 0 1-5.9-5.9z" />
  `,
  /* Cable with a plug: salvage, patch jobs, recovered value. */
  cable: `
    <path d="M4 20c0-4.5 2.5-7 6-7h4" />
    <path d="M14 13c2.2 0 4-1.8 4-4V4" />
    <path d="M18 2.5v3M14.5 2.5v3" />
    <path d="M10 13v3.5" />
  `,
  /* Fan blades: cooling, and the failure of it. */
  fan: `
    <circle cx="12" cy="12" r="2.2" />
    <path d="M12 9.8V3.5c0-1-1.4-1.6-2.2-.9L6 5.7c-.7.6-.7 1.7 0 2.3L12 12z" />
    <path d="M14.2 12h6.3c1 0 1.6-1.4.9-2.2L18.3 6c-.6-.7-1.7-.7-2.3 0L12 12z" />
    <path d="M9.8 12H3.5c-1 0-1.6 1.4-.9 2.2L5.7 18c.6.7 1.7.7 2.3 0L12 12z" />
  `,
  /* Label with a corner turned: notes, records, paperwork. */
  note: `
    <path d="M5 3.5h9.5L19 8v12.5H5z" />
    <path d="M14.5 3.5V8H19" />
    <path d="M8 12.5h8M8 16h5" />
  `,
  /* Needle gauge: a tuned, attended fleet. */
  gauge: `
    <path d="M3.5 18a9 9 0 1 1 17 0z" />
    <path d="M12 18l4.5-5.5" />
  `,
  /* Shared glyphs are kept semantically distinct: the name of each mark
     should describe the meaning, not just resemble another icon in the set. */
  /* Heartbeat trace: a live rate, measured rather than accumulated. */
  pulse: `
    <path d="M2.5 12h4l2.5-6.5L12.5 18l3-6h6" />
  `,
  /* Closed ledger: standing terms and paperwork. */
  ledger: `
    <path d="M4.5 5A1.5 1.5 0 0 1 6 3.5h13V20H6a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M4.5 18.5A1.5 1.5 0 0 1 6 17h13" />
    <path d="M8 7.5h7M8 11h7" />
  `,
  /* Anchor: mass that holds something in place and pulls it along. */
  anchor: `
    <circle cx="12" cy="4.5" r="2" />
    <path d="M12 6.5V21" />
    <path d="M8 9.5h8" />
    <path d="M4 14a8 8 0 0 0 16 0" />
  `,
  /* Snowflake: cold storage. */
  snowflake: `
    <path d="M12 2.5v19" />
    <path d="M3.8 7.2 20.2 16.8M20.2 7.2 3.8 16.8" />
    <path d="M12 6.5 9.5 4M12 6.5 14.5 4M12 17.5 9.5 20M12 17.5 14.5 20" />
  `,
  /* Padlock: something held open, or kept alive. */
  lock: `
    <rect x="5" y="10.5" width="14" height="10" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    <path d="M12 14.5v2.5" />
  `,
  /* Balance scales: an even fleet, or load spread evenly. */
  scales: `
    <path d="M12 3.5v17M8.5 20.5h7" />
    <path d="M4.5 6.5h15" />
    <path d="M4.5 6.5 2 12.5h5z" />
    <path d="M19.5 6.5 17 12.5h5z" />
  `,
  /* Six nodes in a ring: a cluster rather than a mesh. */
  cluster: `
    <circle cx="12" cy="4" r="2.2" />
    <circle cx="18.9" cy="8" r="2.2" />
    <circle cx="18.9" cy="16" r="2.2" />
    <circle cx="12" cy="20" r="2.2" />
    <circle cx="5.1" cy="16" r="2.2" />
    <circle cx="5.1" cy="8" r="2.2" />
  `,
  /* Broadcast tower: a region serving traffic locally. */
  broadcast: `
    <path d="M12 21v-9" />
    <circle cx="12" cy="9.5" r="1.5" />
    <path d="M8 6.5a5.5 5.5 0 0 1 8 0" />
    <path d="M5 3.5a10 10 0 0 1 14 0" />
  `,
  /* Beaker: an experiment, or a part put back into service. */
  beaker: `
    <path d="M9 3h6" />
    <path d="M10 3v6.5L5.8 18a2 2 0 0 0 1.8 3h8.8a2 2 0 0 0 1.8-3L14 9.5V3" />
    <path d="M7.6 15h8.8" />
  `,
  /* Conduit: flow through a channel. */
  conduit: `
    <path d="M3 12h13" />
    <path d="M12.5 8.5 16 12l-3.5 3.5" />
    <path d="M3 8v8M20.5 8v8" />
  `,
  /* Double helix: a quantity that feeds itself. */
  helix: `
    <path d="M7.5 3c0 4.5 9 4.5 9 9s-9 4.5-9 9" />
    <path d="M16.5 3c0 4.5-9 4.5-9 9s9 4.5 9 9" />
    <path d="M8.4 7.5h7.2M8.4 16.5h7.2" />
  `,
  /* Battery: stored charge. */
  battery: `
    <rect x="2.5" y="7" width="16" height="10" />
    <path d="M21 10.5v3" />
    <path d="M6 10.5v3M9.5 10.5v3" />
  `,
  /* Vault door: something held on purpose. */
  vault: `
    <rect x="3.5" y="3.5" width="17" height="17" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 8V6M12 18v-2M8 12H6M18 12h-2" />
  `,
  /* Upward trend: growth that keeps accelerating. */
  trend: `
    <path d="M3.5 17.5 9 12l3.5 3.5L20.5 7.5" />
    <path d="M15 7.5h5.5V13" />
  `,
  /* Funnel: many in, one out. */
  funnel: `
    <path d="M3.5 4h17l-6.5 8v8l-4 2v-10z" />
  `,
  /*
     Strongbox with a lid seam and a clasp: value held on purpose.

     Deliberately not a box with a dial, which is `vault` -- that marks the
     Treasury upgrade row, and both would appear in the same shop section.
  */
  reserve: `
    <rect x="3.5" y="7.5" width="17" height="12" />
    <path d="M3.5 11h17" />
    <path d="M10 11v3.5h4V11" />
  `,
  /* A faceted crystal: the shards currency. A cut stone reads as money and as
     a shard, a piece broken off something larger. */
  shard: `
    <path d="M12 2.5 4.5 9 12 21.5 19.5 9z" />
    <path d="M4.5 9h15" />
    <path d="M12 2.5 9 9l3 12.5M12 2.5 15 9l-3 12.5" />
  `,
};

const ACHIEVEMENT_FALLBACK = `<circle cx="12" cy="12" r="8.5" />`;

/**
 * Build an achievement or contract glyph.
 *
 * `strokeWidth` is passed in by the caller so a tier can be distinguished by
 * weight as well as colour, which keeps it legible in greyscale and for
 * colour-blind players.
 */
export function createAchievementIcon(key: string, strokeWidth = 1.5): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'square');
  svg.setAttribute('stroke-linejoin', 'miter');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('glyph');

  svg.innerHTML = GLYPH_MARKUP[key] ?? ACHIEVEMENT_FALLBACK;

  return svg;
}

/**
 * Stroke weight per rarity so the label stays legible in greyscale.
 */
export const RARITY_STROKE: Record<string, number> = {
  bronze: 1.2,
  silver: 1.45,
  gold: 1.7,
  mythic: 2,
};


/**
 * Inner markup per service tier, plus a fallback for a tier added later without
 * an icon. Fill is inherited as `none` from the root <svg> below.
 */
const ICON_MARKUP: Record<string, string> = {
  /* A processor: package, die, and pins on all four sides. */
  worker: `
    <rect x="7" y="7" width="10" height="10" />
    <rect x="10.5" y="10.5" width="3" height="3" />
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
  `,

  /* Stacked layers: repeated reads served from closer to the caller. */
  cache: `
    <path d="M12 3 3.5 7.5 12 12l8.5-4.5z" />
    <path d="M3.5 12 12 16.5 20.5 12" />
    <path d="M3.5 16.5 12 21l8.5-4.5" />
  `,

  /* Items held against a rail, waiting to be drained. */
  queue: `
    <path d="M4 6.5h13M4 12h13M4 17.5h13" />
    <path d="M20 4.5v15" />
  `,

  /* A storage cylinder. */
  database: `
    <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  `,

  /* One inbound connection fanning out to three downstream targets. */
  balancer: `
    <path d="M12 2v5" />
    <path d="M4 11 12 7l8 4" />
    <path d="M4 11v4M12 7v8M20 11v4" />
  `,

  replica: `
    <rect x="3.5" y="3.5" width="11" height="11" />
    <rect x="9.5" y="9.5" width="11" height="11" />
  `,

  /* A wireframe globe: a region serving traffic close to users. */
  region: `
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9c2.5-2.6 3.8-5.6 3.8-9s-1.3-6.4-3.8-9z" />
  `,

  /* A rack: chassis, dividers, and a unit marker per row. */
  datacenter: `
    <rect x="4.5" y="3" width="15" height="18" />
    <path d="M4.5 9h15M4.5 15h15" />
    <path d="M7 6h2.5M7 12h2.5M7 18h2.5" />
  `,

  fallback: `<rect x="4" y="4" width="16" height="16" />`,
};

/**
 * Build the icon element for a service tier.
 *
 * The markup above is a compile-time constant authored in this repository and
 * no user-supplied value reaches it, so innerHTML adds no injection surface.
 */
export function createServiceIcon(serviceId: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'square');
  svg.setAttribute('stroke-linejoin', 'miter');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('service__icon');

  svg.innerHTML = ICON_MARKUP[serviceId] ?? ICON_MARKUP.fallback;

  return svg;
}
