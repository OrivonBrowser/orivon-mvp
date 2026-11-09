// Wires the carry into the browser: the first page of a moved app, in the session websites run in, waits at the web-request
// owner until the app's old storage has been carried (`carry-gate.ts`), and the outcome is recorded in the profile so that a carry
// that finished is not made again (`marker.ts`).

import { session } from 'electron'
import { join } from 'node:path'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { Subsystem } from '../registry.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { runsAsWebsite } from '../shell/app-session.js'
import { CarryGate } from './carry-gate.js'
import type { CarryDue } from './carry-gate.js'
import { cookieJarOf, openCarryPage } from './carry-pages.js'
import { carryStorage } from './carry-runner.js'
import { holdsRequest } from './hold-rule.js'
import { MARKER_FILE, needsCarry, readMarker, withOutcome, writeMarker } from './marker.js'
import type { CarryMarker } from './marker.js'
import { oldPartitionDirectory, storageKindsOnDisk, storageNotCarried } from './old-data.js'

/** The longest a page waits for the carry. Long enough for a database of tens of megabytes; past it the page loads, and the carry goes on. */
export const CARRY_HOLD_MS = 45_000

export interface StorageCarryOptions {
  readonly userDataPath: string
  /** False in a private session: nothing is written to the profile, and the record lives as long as the process. */
  readonly keepRecord: boolean
  readonly holdMs?: number
}

export function installStorageCarry (options: StorageCarryOptions): CarryGate {
  const markerPath = join(options.userDataPath, MARKER_FILE)
  let marker: CarryMarker = options.keepRecord ? readMarker(markerPath) : {}
  const target = session.defaultSession

  const due = (origin: string): CarryDue => {
    if (!runsAsWebsite(origin)) return 'later'
    if (!needsCarry(marker, origin)) return 'no'
    return storageKindsOnDisk(oldPartitionDirectory(options.userDataPath, origin)).length > 0 ? 'yes' : 'no'
  }

  const carry = async (origin: string): Promise<void> => {
    const oldSession = session.fromPartition(partitionFor(origin))
    const kinds = storageKindsOnDisk(oldPartitionDirectory(options.userDataPath, origin))
    console.log(`[carry] ${origin}: carrying what the app kept in its own partition (${kinds.join(', ')}) into the session websites run in`)
    try {
      const outcome = await carryStorage({
        origin,
        source: { cookies: cookieJarOf(oldSession), open: async () => await openCarryPage(oldSession, origin) },
        target: { cookies: cookieJarOf(target), open: async () => await openCarryPage(target, origin) },
        notCarried: storageNotCarried(oldPartitionDirectory(options.userDataPath, origin)),
        nowSeconds: () => Date.now() / 1000,
        log: { info: (text) => { console.log(text) }, warn: (text) => { console.warn(text) } }
      })
      await target.cookies.flushStore()
      marker = withOutcome(marker, origin, outcome, new Date())
      if (options.keepRecord) writeMarker(markerPath, marker)
    } catch (error) {
      console.error(`[carry] ${origin}: the carry stopped:`, error)
    }
  }

  const gate = new CarryGate({
    due,
    carry,
    boundMs: options.holdMs ?? CARRY_HOLD_MS,
    onBound: (origin) => { console.warn(`[carry] ${origin}: its page loads before the carry has ended; nothing it makes meanwhile is replaced`) }
  })

  const served = isOriginServedFromCacheSync
  webRequestOwnerFor(target).onBeforeRequest(1, { urls: ['https://*/*'], types: ['mainFrame'] }, (url) => holdsRequest({ url, resourceType: 'mainFrame' }, served), async (details, current) => {
    if (!holdsRequest(details, served)) return current
    const origin = originFromUrl(details.url)
    if (origin !== null) await gate.ready(origin)
    return current
  })
  return gate
}

export const storageCarrySubsystem: Subsystem = {
  name: 'storage-carry',
  afterReady: (ctx) => {
    installStorageCarry({ userDataPath: ctx.app.getPath('userData'), keepRecord: !ctx.privateSession })
  }
}
