/* ==========================================================================
   URL helpers.

   GitHub Pages can serve the site from a subpath, so any hand-written link
   to a file in `public/` must be prefixed with the configured base path.
   ========================================================================== */

const BASE = import.meta.env.BASE_URL;

function basePrefix(): string {
  return BASE.endsWith('/') ? BASE : `${BASE}/`;
}

/** True for absolute URLs and non-navigational schemes (mailto:, tel:, #). */
export function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href.startsWith('#');
}

/**
 * Prefix a root-relative path with the deployment base path.
 * External URLs, anchors and mailto:/tel: links are returned unchanged.
 */
export function withBase(path: string): string {
  if (!path) return basePrefix();
  if (isExternalHref(path)) return path;
  return `${basePrefix()}${path.replace(/^\/+/, '')}`;
}
