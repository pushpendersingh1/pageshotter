import { defineConfig } from 'vitest/config'
import { BROWSERS } from './scripts/targets.mjs'

/*
 * The build defines `__BROWSER_PROFILE__` per target (`scripts/build.mjs`); the tests run as a plain
 * `npm run build` would, which is Chrome.
 */
export default defineConfig({
  define: { __BROWSER_PROFILE__: JSON.stringify(BROWSERS.chrome) },
})
