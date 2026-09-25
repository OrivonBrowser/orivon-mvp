/**
 * Developer mode is an explicit opt-in that only `scripts/dev.mjs` (`npm run
 * dev`) sets. It turns on the fake-name path (eth-resolver.ts), granting those
 * names without installing (../install/grant-without-install.ts; a loopback
 * origin needs no developer mode for that) and developer affordances such as
 * Inspect Element. NOT `!app.isPackaged`: Windows and macOS ship
 * run-from-source, so an end user on `npm start` is unpackaged too. Read per
 * call, not at module scope, so a test can set it per case.
 */
export function devModeEnabled (): boolean {
  return process.env['ORIVON_DEV_ORIGINS'] === '1'
}
