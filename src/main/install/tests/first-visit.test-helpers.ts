import { it, vi } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { baseDeps, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
import type { Manifest } from '../../../contracts/index.js'
import type { FirstBundle, FirstDeclaration, FirstManifest, Loader, PendingConsent } from '../../../loader/index.js'
import type { LiveHooks } from '../../../loader/serve/live-serve.js'
import type { InstallConsentPrompt } from '../../consent/install-consent.js'
import type { DialogCaller } from '../../consent/request-grant.js'
import { DeclinedApps } from '../declined-apps.js'
import { runFirstVisit } from '../first-visit.js'
import type { FirstVisitDeps, SetupHost, SetupSheet } from '../first-visit.js'

export const VERIFIED = 'https://abc.ipfs.orivon'
export const WEBSITE = 'https://app.example.com'
export const leaf = (character: string): string => `sha256:${character.repeat(64)}`
export const MANIFEST: Manifest = { orivonApiVersion: 0, id: 'app.test', name: 'Test App', version: '1.0.0', entry: 'index.html', capabilities: { fs: { quotaBytes: 1024 } } }
export const TREE = { root: leaf('r'), assets: [{ path: '/index.html', leaf: leaf('a') }] }
export const CONTENT = { cid: 'bafy', via: 'ipfs' as const, pointersVerified: true }
export const DECLARED = { kind: 'declared' as const, declaration: { bundleHash: TREE.root, leaves: [{ path: '/index.html', leaf: leaf('a') }] } }
export const DIFFERENT = { bundleHash: TREE.root, leaves: [{ path: '/index.html', leaf: leaf('z') }] }

export const readOf = (origin: string): FirstManifest => ({ kind: 'app', canonicalOrigin: origin, manifest: MANIFEST, bytes: new Uint8Array([1]), content: undefined })

export type Fetched = Extract<FirstBundle, { ok: true }>

export function bundle (origin: string, overrides: Partial<Fetched> = {}): Fetched {
  return { ok: true, canonicalOrigin: origin, manifest: MANIFEST, tree: TREE, entries: [], declaration: undefined, content: undefined, discard: vi.fn(async () => {}), ...overrides }
}

export interface Harness {
  readonly origin: string
  readonly url: string
  readonly broker: ReturnType<typeof createBroker>
  readonly events: string[]
  readonly host: SetupHost & { sheets: SetupSheet[] }
  readonly loader: Pick<Loader, 'readManifest' | 'readDeclaration' | 'serveLive' | 'endLive' | 'rememberConsent' | 'pendingConsents' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent: ReturnType<typeof vi.fn<InstallConsentPrompt>>
  readonly declined: DeclinedApps
  readonly blocked: ReturnType<typeof vi.fn<NonNullable<FirstVisitDeps['blocked']>>>
  readonly capabilityPrompt: ReturnType<typeof vi.fn<NonNullable<FirstVisitDeps['capabilityPrompt']>>>
  /** What the capability question answers; a function holds the question open until it resolves. */
  answerWidening: { current: boolean | (() => Promise<boolean>) }
  /** What the loader was told to call when a served file turns out bad. */
  /** What the loader was handed to be told by. */
  readonly hooks: () => LiveHooks | undefined
  readonly badData: () => ((found: { differing: readonly string[], invalid?: string }) => void) | undefined
  readonly grantsAt: Record<string, string[]>
}

export function harness (options: {
  origin?: string
  reads?: FirstManifest[]
  declarations?: FirstDeclaration[]
  declarationGate?: Promise<void>
  bundles?: FirstBundle[]
  answer?: boolean | 'dismissed'
  choices?: Array<'retry' | 'leave'>
  installed?: 'ok' | 'rejected'
  live?: boolean | 'throws'
  pending?: PendingConsent[]
} = {}): Harness {
  const origin = options.origin ?? VERIFIED
  const events: string[] = []
  const broker = createBroker(baseDeps({ ledgerStorage: memoryLedgerStorage() }))
  const reads = [...(options.reads ?? [readOf(origin)])]
  const declarations = [...(options.declarations ?? [DECLARED])]
  const bundles = [...(options.bundles ?? [bundle(origin)])]
  const choices = [...(options.choices ?? ['leave'])]
  const sheets: SetupSheet[] = []
  const grantsAt: Record<string, string[]> = {}
  let handed: LiveHooks | undefined
  const pendings: PendingConsent[] = options.pending ?? []
  const host = {
    sheets,
    sheet: async (sheet: SetupSheet) => { sheets.push(sheet); events.push(`sheet:${sheet.kind}`); return choices.shift() ?? 'leave' },
    enter: () => { events.push('enter') },
    plain: () => { events.push('plain') },
    end: () => { events.push('end') },
    tab: () => TAB
  }
  const noteGrants = async (at: string): Promise<void> => { grantsAt[at] = (await broker.app.grants(origin)).map((grant) => grant.capability) }
  const loader: Harness['loader'] = {
    pinFor: vi.fn(async () => null),
    readManifest: vi.fn(async () => { events.push('read'); return reads.length > 1 ? reads.shift() as FirstManifest : reads[0] as FirstManifest }),
    readDeclaration: vi.fn(async () => {
      events.push('declaration')
      await options.declarationGate
      return declarations.length > 1 ? declarations.shift() as FirstDeclaration : declarations[0] as FirstDeclaration
    }),
    serveLive: vi.fn(async (_read, _declaration, hooks) => {
      events.push('serve-live')
      await noteGrants('serve-live')
      handed = hooks
      if (options.live === 'throws') throw new Error('no partition')
      return options.live ?? true
    }),
    endLive: vi.fn(async () => { events.push('end-live') }),
    rememberConsent: vi.fn(async () => { events.push('remember') }),
    pendingConsents: vi.fn(async () => pendings),
    fetchForInstall: vi.fn(async () => {
      events.push('fetch')
      return bundles.shift() ?? bundle(origin)
    }),
    installFetched: vi.fn(async (installOrigin, manifest, tree) => {
      events.push('install')
      if (options.installed === 'rejected') return { outcome: 'rejected' as const, reason: 'disk' }
      return { outcome: 'installed' as const, canonicalOrigin: installOrigin, manifest, pin: { schema: 1 as const, origin: installOrigin, bundleHash: tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    })
  }
  const consent = vi.fn<InstallConsentPrompt>(async () => { events.push('ask'); await noteGrants('ask'); return options.answer ?? true })
  const answerWidening: Harness['answerWidening'] = { current: true }
  const capabilityPrompt = vi.fn<NonNullable<FirstVisitDeps['capabilityPrompt']>>(async () => { events.push('widening-question'); return typeof answerWidening.current === 'function' ? await answerWidening.current() : answerWidening.current })
  const blocked = vi.fn<NonNullable<FirstVisitDeps['blocked']>>(() => { events.push('blocked-tabs'); return { emptied: Promise.resolve(), dismissed: Promise.resolve() } })
  return { origin, url: `${origin}/`, broker, events, host, loader, consent, declined: new DeclinedApps(), blocked, capabilityPrompt, answerWidening, hooks: () => handed, badData: () => handed?.onBadData, grantsAt }
}

export const TAB = { id: 'the-tab' }

export const present: DialogCaller = { window: () => undefined, stillOn: () => true }

export function depsOf (h: Harness, backgroundDelayMs = SOON): FirstVisitDeps {
  return { broker: h.broker, loader: h.loader as Loader, consent: h.consent, declined: h.declined, blocked: h.blocked, capabilityPrompt: h.capabilityPrompt, backgroundDelayMs }
}

/** The caching begins a moment after the question is asked, so by default the answer comes before it ends. */
export const SOON = 30

export async function run (h: Harness, caller: DialogCaller | undefined = present, signal?: AbortSignal, backgroundDelayMs = SOON): ReturnType<typeof runFirstVisit> {
  return await runFirstVisit({ ...depsOf(h), backgroundDelayMs }, h.origin, h.url, caller, h.host, signal)
}

/** The background pin waits long enough for a test to act before it begins. */
export const LATE = 200

export async function settled (result: Awaited<ReturnType<typeof run>>): Promise<string> {
  if (result.outcome !== 'entered') throw new Error(`not entered: ${result.outcome}`)
  return await result.background
}

export const grantsOf = async (h: Harness): Promise<string[]> => (await h.broker.app.grants(h.origin)).map((grant) => grant.capability)

