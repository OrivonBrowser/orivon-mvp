// The renderer's `stream` is readable-stream 3 (stream-browserify), not
// node:stream; this runs the lifecycle suite against it.

import { vi } from 'vitest'
import { socketLifecycleSuite } from './support/socket-lifecycle-suite.js'

vi.mock('stream', async () => await import('stream-browserify'))

socketLifecycleSuite('readable-stream 3')
