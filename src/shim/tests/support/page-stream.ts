// stream-browserify, the page's `stream` (module-map.ts), for a test that
// must build streams of the same implementation a shim module uses. It ships
// no types; it is typed as Node's own module, which it stands in for.

import { createRequire } from 'node:module'

export const pageStream = createRequire(import.meta.url)('stream-browserify') as typeof import('node:stream')
