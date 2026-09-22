// Builds the ONE script ft-electron-bridge.js actually ships as, by
// splicing ft-electron-bridge-db.js into the shell's own `// #include`
// marker. Shared by prepare.mjs (the real build) and
// ft-electron-bridge.test.ts (so a test failure here means the real build
// would have broken too, not a divergent test-only path) -- see
// ft-electron-bridge.js's own marker comment for why this split exists
// (code-guidelines.md Rule 2) rather than a second <script> tag.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = '  // #include ft-electron-bridge-db.js'

export function buildBridgeSource () {
  const shell = readFileSync(join(HERE, 'ft-electron-bridge.js'), 'utf8')
  const db = readFileSync(join(HERE, 'ft-electron-bridge-db.js'), 'utf8')
  const markerLine = shell.split('\n').find((line) => line.startsWith(MARKER))
  if (markerLine === undefined) {
    throw new Error(`ft-electron-bridge.js has no line starting with '${MARKER}' -- ft-electron-bridge-db.js has nowhere to splice into`)
  }
  return shell.replace(markerLine, db)
}
