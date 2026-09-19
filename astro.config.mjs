// @ts-check
import { defineConfig } from 'astro/config';

/**
 * Deployment configuration.
 *
 * Two supported GitHub Pages shapes:
 *
 *   1. Repository site  ->  https://<user>.github.io/deploykorn/
 *      SITE_URL=https://<user>.github.io   BASE_PATH=/deploykorn
 *
 *   2. User/org site    ->  https://<user>.github.io/
 *      SITE_URL=https://<user>.github.io   BASE_PATH=/
 *
 * Both can be overridden without editing this file by setting SITE_URL and
 * BASE_PATH as environment variables; the GitHub Actions workflow does this
 * automatically from the repository it runs in.
 *
 * `||` rather than `??` is deliberate: CI passes these as empty strings when
 * no override is configured, and an empty value must fall back to the default.
 */
const SITE_URL = process.env.SITE_URL || 'https://tanakornon.github.io';
const BASE_PATH = process.env.BASE_PATH || '/deploykorn';

export default defineConfig({
  site: SITE_URL,
  base: BASE_PATH,
  output: 'static',
  trailingSlash: 'ignore',
  compressHTML: true,
  devToolbar: { enabled: false },
  build: {
    assets: '_assets',
  },
});
