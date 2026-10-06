// A file on this computer is let use Orivon permissions: its manifest is read from beside it, the file is registered
// against it, and the person is asked once with a double press (`../consent/local-file-consent.ts`). A Yes records the
// file (`../local-files/local-file-apps.ts`), which is what moves it to a session of its own and lets it hold grants.
//
// Nothing here trusts the file: its manifest is read only from under the folder it lies in, through links that stay in
// that folder, no larger than a manifest may be; and grants live under the file's exact path, so a different file saved
// at that path would inherit them. The consent says so, which is why a path nobody recorded has its old grants dropped
// before it is asked, not hydrated.

import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Broker } from '../../broker/broker-contracts.js'
import { isLocalFileKey, localFileKey } from '../../broker/policy/origin.js'
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import { patternSetFromGrants } from '../../broker/policy/update.js'
import type { CapabilityKind } from '../../contracts/index.js'
import { MAX_MANIFEST_BYTES, parseManifest } from '../../loader/manifest/manifest.js'
import { grantChangedCapabilities } from '../consent/grant-changed-capabilities.js'
import type { InstallConsentPrompt } from '../consent/install-consent.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { GrantWithoutInstallOutcome } from './grant-without-install.js'
import { widensHeldGrants } from './grant-without-install.js'

export interface LocalFileGrantDeps {
  readonly broker: Broker
  /** The record of the files let use Orivon permissions (`LocalFileApps`): `add` is false when it could not be written. */
  readonly records: { readonly has: (key: string) => boolean, readonly add: (key: string) => boolean }
  readonly consent: InstallConsentPrompt
}

type FolderManifest = { readonly ok: true, readonly text: string } | { readonly ok: false, readonly reason: string }

const reject = (reason: string): { readonly ok: false, readonly reason: string } => ({ ok: false, reason })

/** Where `child` lies: inside `parent`, or the same place. Both already resolved through links. */
function isUnder (parent: string, child: string): boolean {
  const from = relative(parent, child)
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from))
}

/**
 * The text of the manifest `hintedUrl` names, only when it is a file under the folder the document at `key` lies in. A
 * link that leads out of the folder, a path with `..` that leaves it, anything but a plain file and a file over
 * `MAX_MANIFEST_BYTES` are refused; no more than that many bytes are read.
 */
export async function readFolderManifest (key: string, hintedUrl: string): Promise<FolderManifest> {
  let documentPath: string
  let manifestPath: string
  try {
    if (localFileKey(hintedUrl) === null || !isLocalFileKey(key)) return reject('the manifest is not a file on this computer')
    documentPath = fileURLToPath(key)
    manifestPath = fileURLToPath(hintedUrl)
  } catch {
    return reject('the manifest address is not a local file')
  }
  try {
    const folder = await realpath(dirname(documentPath))
    const real = await realpath(manifestPath)
    if (!isUnder(folder, real)) return reject('the manifest is outside the folder of the file')
    const info = await stat(real)
    if (!info.isFile()) return reject('the manifest is not a file')
    if (info.size > MAX_MANIFEST_BYTES) return reject(`manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes`)
    const handle = await open(real, 'r')
    try {
      const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_MANIFEST_BYTES) return reject(`manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes`)
      return { ok: true, text: buffer.toString('utf8', 0, bytesRead) }
    } finally {
      await handle.close()
    }
  } catch {
    return reject('the manifest could not be read')
  }
}

/**
 * Revokes every grant and picked path the ledger keeps for `key`, and forgets a declined question, so that a path nobody
 * recorded starts with nothing. Revoking a persisted grant drops the live one and its handles too.
 */
export async function dropLocalFileGrants (broker: Broker, key: string): Promise<void> {
  const persisted = broker.app.persistedAppsSync().find((app) => app.origin === key)
  for (const capability of Object.keys(persisted?.grants ?? {})) await broker.revokePersisted(key, capability as CapabilityKind)
  for (const pickId of Object.keys(persisted?.pickedPaths ?? {})) await broker.revokeUserSelectedPath(key, pickId)
  await broker.clearDeclinedConsent(key)
}

/**
 * Registers the local file `key` against the manifest `hintedUrl` names and asks about whatever it declares and does not
 * yet hold. `newlyRegistered` says the tab must reload: it has to become the file's own app tab, in the file's own session.
 */
export async function grantLocalFile (deps: LocalFileGrantDeps, key: string, hintedUrl: string, caller?: DialogCaller): Promise<GrantWithoutInstallOutcome> {
  if (!isLocalFileKey(key)) return { outcome: 'rejected', reason: 'not a local file' }
  const read = await readFolderManifest(key, hintedUrl)
  if (!read.ok) return { outcome: 'rejected', reason: read.reason }
  const parsed = parseManifest(read.text)
  if (!parsed.ok) return { outcome: 'rejected', reason: `manifest rejected: ${parsed.reason}` }
  const { manifest } = parsed

  const { broker, records } = deps
  const recorded = records.has(key)
  if (!recorded) await dropLocalFileGrants(broker, key)
  const alreadyRegistered = broker.app.isRegisteredSync(key)

  // Held and declined: the tab counts as the file's own from here, so the page is held where it is until the answer.
  const release = caller?.hold?.()
  try {
    await broker.registerApp(key, manifest)
    const declared = patternSetFromCapabilities(manifest.capabilities)
    const capabilities = Object.keys(declared) as CapabilityKind[]
    const held = await broker.app.grants(key)
    const heldKinds = held.map((grant) => grant.capability)
    const asks = capabilities.length > 0 && (capabilities.some((capability) => !heldKinds.includes(capability)) || widensHeldGrants(patternSetFromGrants(held), declared))
    if (!asks) return { outcome: 'granted-without-install', canonicalOrigin: key, newlyRegistered: !alreadyRegistered }

    const accepted = await deps.consent(key, manifest, capabilities, heldKinds.filter((kind) => capabilities.includes(kind)), caller)
    if (caller !== undefined && !caller.stillOn(key)) return { outcome: 'granted-without-install', canonicalOrigin: key, newlyRegistered: false }
    if (!accepted) return { outcome: 'granted-without-install', canonicalOrigin: key, newlyRegistered: false }
    // The record first: a grant a restart could not find the session of would be a grant nobody could take back.
    if (!records.add(key)) return { outcome: 'rejected', reason: 'the file could not be recorded' }
    await broker.clearDeclinedConsent(key)
    await grantChangedCapabilities(broker, key, manifest, capabilities)
    return { outcome: 'granted-without-install', canonicalOrigin: key, newlyRegistered: true }
  } finally {
    release?.()
  }
}
