// Installs and updates an extension from the Chrome Web Store: CRX bytes
// checked for both proofs, held back when an update asks for more than the
// person approved, then handed to `finishInstall` like every other install.

import {
  describeExtensionInstall, readExtensionManifest, updateRequiresConsent, type ExtensionManifestFacts
} from '../../broker/policy/extension-manifest.js'
import { verifyCrx3 } from './crx.js'
import { peekManifest, unpackZip, writeManifestOver } from './unpack-runner.js'
import { patchStoreUpdater, readRegistry } from './registry-runner.js'
import { finishInstall, type InstallContext, type InstallOutcome } from './install-runner.js'
import { downloadCrxBytes } from '../../../vendor/electron-chrome-web-store/src/browser/installer.js'
import { refusePrivateInstall } from './install-private.js'
import { storeCrxDownloadUrl, storeTestPublisherKeyHash } from './store-download-seam.js'

/** The lines `describeExtensionInstall(next, 'store').detail` has that
 * `describeExtensionInstall(previous, 'store').detail` does not -- reuses
 * the install prompt's own wording rather than inventing a second way to
 * describe a permission, so a held-back update's registered reason and a
 * store install's prompt never disagree about what a given permission
 * means. */
function describeWhatIsNew (previous: ExtensionManifestFacts, next: ExtensionManifestFacts): string {
  const before = new Set(describeExtensionInstall(previous, 'store').detail.split('\n'))
  const added = describeExtensionInstall(next, 'store').detail.split('\n').filter((line) => line !== '' && !before.has(line))
  return added.length > 0 ? added.join('; ') : 'more access'
}

export interface InstallFromStoreOptions {
  /** Skip this function's own install prompt -- see PendingInstall's own doc
   * on `preApproved` for who may set this and why. */
  readonly skipPrompt?: boolean
  /** The CRX's own download URL, recorded as `updater.pendingUpdate` when
   * this call holds an update back for consent, so `updateFromStore` can
   * re-fetch the exact bytes without another Omaha check. */
  readonly downloadUrl?: string
  /** Test-only seam, threaded straight to crx.ts's `verifyCrx3` -- see its
   * own doc. Falls back to store-download-seam.ts's env-driven override
   * (e2e builds only), then to crx.ts's real Chrome Web Store key hash. */
  readonly publisherKeyHash?: Buffer
}

/**
 * Installs or updates a Chrome Web Store extension from already-downloaded
 * CRX bytes: `verifyCrx3` with `requirePublisherProof: true` (every store CRX
 * needs both the developer's proof and the store's own), refuses when the
 * CRX's own id differs from `expectedId`,
 * and -- when `approvedManifest` names what is currently installed -- holds
 * the update back instead of installing it if it asks for more than that
 * (T19's subset rule, `updateRequiresConsent`): nothing is written, and the
 * registry's `updater.lastResult` records why, in the person's own words,
 * so the extensions page can show it without a further check.
 *
 * `approvedManifest` is what tells this function whether it is being asked
 * for a FRESH install (undefined: nothing to compare against, so nothing
 * can need consent) or an UPDATE (the currently loaded manifest): a fresh
 * store install is always `options.skipPrompt: true` (the store page's own
 * `beforeInstall` hook already showed the prompt, from the same manifest,
 * before download -- showing this function's own prompt too would be a
 * second dialog for one decision) and a silent background update is too
 * (skipPrompt, AND held back rather than prompted, if it widens anything);
 * the "Update" button (`updateFromStore` below) is the one caller that
 * wants this function's own prompt: it passes no `approvedManifest` at all,
 * so nothing is held back, and no `skipPrompt`, so the ordinary store
 * install prompt -- built from the update's own, current permissions --
 * shows before it lands.
 */
export async function installFromStoreCrx (
  ctx: InstallContext,
  crxBytes: Buffer,
  expectedId: string,
  approvedManifest?: string,
  options: InstallFromStoreOptions = {}
): Promise<InstallOutcome> {
  const refused = refusePrivateInstall(ctx)
  if (refused !== undefined) return refused
  const publisherKeyHash = options.publisherKeyHash ?? storeTestPublisherKeyHash()
  const crx = verifyCrx3(crxBytes, { requirePublisherProof: true, ...(publisherKeyHash === undefined ? {} : { publisherKeyHash }) })
  if (crx.id !== expectedId) {
    throw new Error(`downloaded CRX id ${crx.id} does not match the requested extension ${expectedId}`)
  }
  const rawManifest = peekManifest(crx.archive)

  // No prompt here means the person approved a manifest elsewhere (the store page, or the
  // version already installed); without it, or with one that does not parse, refuse.
  if (options.skipPrompt === true && approvedManifest === undefined) {
    return { installed: false, reason: 'a store install arrived without the manifest the person approved' }
  }
  if (approvedManifest !== undefined) {
    const approved = readExtensionManifest(JSON.parse(approvedManifest))
    const next = readExtensionManifest(rawManifest)
    if (!approved.ok || !next.ok) return { installed: false, reason: 'the approved or downloaded manifest could not be read' }
    if (updateRequiresConsent(approved.facts, next.facts)) {
      const reason = `needs your approval: ${describeWhatIsNew(approved.facts, next.facts)}`
      await patchStoreUpdater(ctx.userDataPath, expectedId, {
        lastCheckedAt: Date.now(),
        lastResult: reason,
        ...(options.downloadUrl === undefined ? {} : { pendingUpdate: { url: options.downloadUrl, version: next.facts.version } })
      })
      return { installed: false, reason }
    }
  }

  return await finishInstall(ctx, {
    rawManifest,
    source: { kind: 'store', storeId: expectedId },
    updater: { kind: 'store', lastCheckedAt: Date.now(), lastResult: approvedManifest === undefined ? 'installed' : 'updated' },
    slot: expectedId,
    developerPublicKey: crx.developerPublicKey,
    preApproved: options.skipPrompt === true,
    write: (targetDir, manifestJson) => { unpackZip(crx.archive, targetDir); writeManifestOver(targetDir, manifestJson) }
  })
}

/**
 * The e2e-only entry point `test/e2e-extensions-store.test.ts` drives
 * (through `store-test-hook.ts`'s dev-only `globalThis` hook -- no
 * `chrome.webstorePrivate` page exists in that suite to trigger the real
 * flow from) and the seam that lets it point at a fixture server instead of
 * the real store: `storeCrxDownloadUrl` returns the real store's URL unless
 * store-download-seam.ts's env-driven override is compiled in and set.
 */
export async function installFromStore (ctx: InstallContext, expectedId: string): Promise<InstallOutcome> {
  const refused = refusePrivateInstall(ctx)
  if (refused !== undefined) return refused
  const { bytes } = await downloadCrxBytes(storeCrxDownloadUrl(expectedId))
  return await installFromStoreCrx(ctx, bytes, expectedId)
}

/**
 * The "Update" button's own action: re-downloads exactly the update a held-
 * back check found (`entry.updater.pendingUpdate`, set by
 * `installFromStoreCrx` above) and installs it with no `approvedManifest`,
 * so nothing is held back a second time -- the person clicking this button
 * IS the consent -- and no `skipPrompt`, so the ordinary store install
 * prompt still shows, built from the update's own permissions, before it
 * lands.
 */
export async function updateFromStore (ctx: InstallContext, id: string): Promise<InstallOutcome> {
  const refused = refusePrivateInstall(ctx)
  if (refused !== undefined) return refused
  const entry = readRegistry(ctx.userDataPath).find((candidate) => candidate.id === id)
  const pending = entry?.updater.kind === 'store' ? entry.updater.pendingUpdate : undefined
  if (pending === undefined) return { installed: false, reason: 'no update is pending' }
  const { bytes } = await downloadCrxBytes(pending.url)
  return await installFromStoreCrx(ctx, bytes, id)
}
