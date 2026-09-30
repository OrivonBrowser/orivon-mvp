// A full garbage collection on demand, for tests of what a collected object leaves behind.

import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const turn = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }

/**
 * Collects, yielding first so a `WeakRef` made in the current turn is no longer held by it, and
 * after each pass so finalization callbacks run; twice, so an object freed by the first pass's
 * callbacks goes in the second.
 */
export async function collectGarbage (): Promise<void> {
  await turn()
  for (let pass = 0; pass < 2; pass++) {
    collect()
    await turn()
  }
}
