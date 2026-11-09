// Wires the carry into the browser: the first page of a moved app, in the session websites run in, waits at the web-request
// owner until the app's old storage has been carried (`carry-gate.ts`), every other moved app is carried in the background
// soon after launch, and the outcome of each is recorded in the profile (`marker.ts`).

import { randomBytes } from 'node:crypto'
import { session, MessageChannelMain } from 'electron'
import type { Session } from 'electron'
import { join } from 'node:path'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { onServingChange, servedOrigins } from '../../loader/electron/app-partitions.js'
import type { Subsystem } from '../registry.js'
import { ensureSiteSession, sitePartitionForOrigin } from '../route/site-routes.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { forEachWebsiteSession } from '../sessions/website-sessions.js'
import { runsAsWebsite } from '../shell/app-session.js'
import { CarryGate } from './carry-gate.js'
import type { CarryDue, CarryEnd } from './carry-gate.js'
import { cookieJarOf, openCarryPage } from './carry-pages.js'
import { carryStorage } from './carry-runner.js'
import type { CarryOutcome } from './carry-runner.js'
import { holdsRequest } from './hold-rule.js'
import { MARKER_FILE, needsCarry, readMarker, withFinal, withOutcome, writeMarker } from './marker.js'
import type { CarryMarker } from './marker.js'
import { newReport } from './report.js'
import { oldPartitionDirectory, storageKindsOnDisk, storageNotCarried } from './old-data.js'

/** The longest one origin's carry may take in all, however many pages wait on it. Provisional: a profile with a database of several gigabytes would settle it. */
export const CARRY_DEADLINE_MS = 10 * 60_000

/** How long after launch the carries of the apps nobody has opened begin: the start of the browser comes first. Provisional. */
export const EAGER_DELAY_MS = 4_000

/** How often the background carries look again for an origin that did not run in the website session yet, and how many times. */
const LATER_RETRY_MS = 30_000
const LATER_RETRIES = 20

/** The storage a carry clears in the website session before it copies: everything the carry itself moves, and the worker and caches the app would otherwise be answered from. */
const CLEARED_STORAGES = ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] as const

export interface StorageCarryOptions {
  readonly userDataPath: string
  /** False in a private session: nothing is written to the profile, and the record lives as long as the process. */
  readonly keepRecord: boolean
  readonly deadlineMs?: number
  readonly eagerDelayMs?: number
}

/** The session a website at `origin` runs in by its own entry, which is where the app's storage goes: the shared one, or the profile of the tunnel the origin has an entry for. */
function websiteSessionFor (origin: string): Session {
  const partition = sitePartitionForOrigin(origin)
  if (partition === undefined) return session.defaultSession
  ensureSiteSession(partition, false)
  return session.fromPartition(partition)
}

export function installStorageCarry (options: StorageCarryOptions): CarryGate {
  const markerPath = join(options.userDataPath, MARKER_FILE)
  let marker: CarryMarker | undefined = options.keepRecord ? readMarker(markerPath) : {}
  if (marker === undefined) console.warn(`[carry] ${MARKER_FILE} exists and cannot be read; no app's storage is carried until it can, so nothing the website session holds is replaced by mistake`)

  const waiting = new Set<string>()
  const due = (origin: string): CarryDue => {
    if (marker === undefined) return 'no'
    if (!runsAsWebsite(origin)) {
      waiting.add(origin)
      return 'later'
    }
    waiting.delete(origin)
    if (!needsCarry(marker, origin)) return 'no'
    return storageKindsOnDisk(oldPartitionDirectory(options.userDataPath, origin)).length > 0 ? 'yes' : 'no'
  }

  const record = (update: (current: CarryMarker) => CarryMarker): void => {
    if (marker === undefined) return
    marker = update(marker)
    if (!options.keepRecord) return
    try {
      writeMarker(markerPath, marker)
    } catch (error) {
      console.error(`[carry] the record of carried apps could not be written to ${MARKER_FILE}:`, error)
    }
  }

  const carry = async (origin: string, signal: AbortSignal): Promise<CarryEnd> => {
    const target = websiteSessionFor(origin)
    const oldSession = session.fromPartition(partitionFor(origin))
    const directory = oldPartitionDirectory(options.userDataPath, origin)
    console.log(`[carry] ${origin}: carrying what the app kept in its own partition (${storageKindsOnDisk(directory).join(', ')}) into the session websites run in`)
    let outcome: CarryOutcome
    try {
      outcome = await carryStorage({
        origin,
        source: { cookies: cookieJarOf(oldSession), open: async (nonce) => await openCarryPage(oldSession, origin, nonce) },
        target: { cookies: cookieJarOf(target), open: async (nonce) => await openCarryPage(target, origin, nonce) },
        clearTarget: async () => { await target.clearStorageData({ origin, storages: [...CLEARED_STORAGES] }) },
        channel: () => { const { port1, port2 } = new MessageChannelMain(); return { first: port1, second: port2 } },
        nonce: () => randomBytes(16).toString('hex'),
        signal,
        notCarried: storageNotCarried(directory),
        nowSeconds: () => Date.now() / 1000,
        log: { info: (text) => { console.log(text) }, warn: (text) => { console.warn(text) } }
      })
    } catch (error) {
      console.error(`[carry] ${origin}: the carry stopped:`, error)
      outcome = { status: 'failed', reason: error instanceof Error ? error.message : String(error), report: newReport() }
    }
    try { await target.cookies.flushStore() } catch { /* the store is flushed on exit as well */ }
    record((current) => withOutcome(current, origin, outcome, new Date()))
    return outcome.status
  }

  const gate = new CarryGate({
    due,
    carry,
    released: (origin) => {
      console.warn(`[carry] ${origin}: its page loaded although the carry failed; the failure is final, since the page may write and a later carry would replace that`)
      record((current) => withFinal(current, origin))
    },
    deadlineMs: options.deadlineMs ?? CARRY_DEADLINE_MS,
    onDeadline: (origin) => { console.warn(`[carry] ${origin}: the carry has not finished in ${String((options.deadlineMs ?? CARRY_DEADLINE_MS) / 60_000)} minutes; it is stopped and clears what it wrote`) }
  })

  const served = isOriginServedFromCacheSync
  // A page of the app waits in whichever website session it runs in: the shared one, or a tunnel profile's.
  forEachWebsiteSession((website) => {
    webRequestOwnerFor(website).onBeforeRequest(1, { urls: ['https://*/*'], types: ['mainFrame'] }, (url) => holdsRequest({ url, resourceType: 'mainFrame' }, served), async (details, current) => {
      if (!holdsRequest(details, served)) return current
      const origin = originFromUrl(details.url)
      if (origin !== null) await gate.ready(origin)
      return current
    })
  })

  let passes = 0
  const eagerPass = (): void => {
    gate.enqueue(servedOrigins())
    void gate.idle().then(() => {
      // An origin the website session does not serve yet is looked at again; one that never is stays with its partition.
      if (waiting.size > 0 && ++passes < LATER_RETRIES) setTimeout(eagerPass, LATER_RETRY_MS).unref()
    }).catch((error: unknown) => { console.error('[carry] the background carries stopped:', error) })
  }
  setTimeout(() => { eagerPass(); onServingChange(eagerPass) }, options.eagerDelayMs ?? EAGER_DELAY_MS).unref()
  return gate
}

export const storageCarrySubsystem: Subsystem = {
  name: 'storage-carry',
  afterReady: (ctx) => {
    installStorageCarry({ userDataPath: ctx.app.getPath('userData'), keepRecord: !ctx.privateSession })
  }
}
