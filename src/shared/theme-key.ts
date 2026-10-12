/**
 * Where the palette choice is mirrored for a synchronous, pre-paint read.
 *
 * Its own module so that `theme-boot.ts` -- which runs from `<head>` in front of every page's first
 * paint -- can share the constant with `theme.ts` without importing it, and with it the settings
 * database, the capture stores and everything else behind that import. Nothing may be added here
 * that pulls in a dependency.
 */
export const THEME_MIRROR_KEY = 'pageshotter-theme'
