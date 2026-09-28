// The renderer's `stream` is readable-stream 3 (stream-browserify), not
// node:stream; this runs the http client lifecycle suite against it.

import { vi } from 'vitest'
import { httpLifecycleSuite } from '../../tests/support/http-lifecycle-suite.js'

vi.mock('stream', async () => await import('stream-browserify'))

httpLifecycleSuite('readable-stream 3')
