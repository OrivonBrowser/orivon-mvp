// asPage's (e2e-helpers.ts) own dynamic-script requirement for
// test/apps/fixture/ -- shared by every e2e file that fixture's own
// serve.mjs serves for (e2e-capability-boundary.test.ts and its siblings).
//
// serve.mjs is a plain static file server rooted at test/apps/fixture/, the
// same shape as test/apps/freetube/serve.mjs (freetube-fixture.ts's own
// setFreetubeAsPageScript, the pattern this mirrors) -- so asPage's own
// requirement (a same-origin URL that returns whatever text it was last
// given) is met by writing straight to a file under that root, never by
// teaching serve.mjs a new route: it stays a file server that executes no
// logic of its own.
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const AS_PAGE_SCRIPT_PATH = join(process.cwd(), 'test', 'apps', 'fixture', '__as-page-script.js')

/** The path component every e2e file using this fixture serves the script at, relative to `FIXTURE_ORIGIN`. */
export const AS_PAGE_SCRIPT_URL = '__as-page-script.js'

export function setFixtureAsPageScript (js: string): void { writeFileSync(AS_PAGE_SCRIPT_PATH, js, 'utf8') }

/** Best-effort: never written yet, or an earlier run already cleaned it up. */
export function clearFixtureAsPageScript (): void { try { unlinkSync(AS_PAGE_SCRIPT_PATH) } catch { /* nothing to remove */ } }
