// Scaffold smoke check: does the app launch, and does the preload's
// contextBridge surface actually reach the page under contextIsolation?
//
// Throwaway. Replaced by the real Playwright _electron e2e in build step 2,
// which additionally asserts that a capability OUTSIDE the manifest is
// REJECTED -- the highest-value assertion in build-plan.md SS Testing.
import { launchElectron } from './launch.mjs'

const app = await launchElectron()
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const result = await page.evaluate(() => ({
  title: document.title,
  apiVersion: globalThis.orivon?.version ?? null,
  // Must be undefined: contextIsolation is what keeps Node out of the page.
  leakedRequire: typeof globalThis.require,
  leakedProcess: typeof globalThis.process
}))

await app.close()

const failures = []
if (result.title !== 'Orivon') failures.push(`title was ${JSON.stringify(result.title)}`)
if (result.apiVersion !== 0) failures.push(`orivon.version was ${String(result.apiVersion)}`)
if (result.leakedRequire !== 'undefined') failures.push('require() is reachable from the page')
if (result.leakedProcess !== 'undefined') failures.push('process is reachable from the page')

console.log(JSON.stringify(result, null, 2))

if (failures.length > 0) {
  console.error('\nSmoke check FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\nSmoke check passed: window opened, orivon.* exposed, no Node leaked into the page.')
