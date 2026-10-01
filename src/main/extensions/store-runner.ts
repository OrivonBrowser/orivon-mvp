// Wires the vendored Chrome Web Store integration (electron-chrome-web-
// store) into Orivon: registers its store-page preload on the default
// session, shows the install prompt from the store page's own manifest
// before any download, and routes every install, update and uninstall it
// drives through the install-runner.ts family's own functions -- Orivon writes every
// loaded extension copy itself; the library never touches the filesystem or
// calls `loadExtension` once the host below is installed (UPSTREAM.md
// patch 4).
import {
  installChromeWebStore, updateExtensions
} from '../../../vendor/electron-chrome-web-store/src/browser/index.js'
import type { UpdateCheckResult, VerifyCrx, WebStoreHost } from '../../../vendor/electron-chrome-web-store/src/browser/types.js'
import {
  describeExtensionInstall, readExtensionManifest, type ExtensionInstallDescription
} from '../../broker/policy/extension-manifest.js'
import { verifyCrx3 } from './crx.js'
import { patchStoreUpdater, readRegistry } from './registry-runner.js'
import type { InstallContext, InstallOutcome } from './install-runner.js'
import { installFromStore, installFromStoreCrx, updateFromStore } from './install-store-runner.js'
import { uninstall } from './install-lifecycle.js'

export interface StoreApi {
  readonly installFromStore: (id: string) => Promise<InstallOutcome>
  readonly checkForUpdates: () => Promise<void>
  readonly updateFromStore: (id: string) => Promise<InstallOutcome>
}

/** Every download this library makes, host or no host, is checked against
 * this -- see installer.ts's own doc on why `host.installCrx` still gets a
 * second, stricter check (`requirePublisherProof: true`) on top of this
 * one's plain developer-proof check. */
const verifyCrx: VerifyCrx = (crx, expectedId) => {
  const result = verifyCrx3(crx, { requirePublisherProof: false })
  if (result.id !== expectedId) {
    throw new Error(`downloaded CRX id ${result.id} does not match the requested extension ${expectedId}`)
  }
}

/**
 * The vendored library's own write path (`WebStoreHost`): every actual
 * install and uninstall still goes through the install-runner.ts family's own
 * functions (this file's own header). `installCrx` throws when
 * `installFromStoreCrx` refuses the install (a download that asks for more
 * than what was approved, or no approved manifest at all) -- the library's
 * `beginInstall` (vendor/.../src/browser/api.ts) catches exactly this and
 * turns it into an `INSTALL_ERROR` result the store page shows as a failed
 * install; without the throw, a refused install silently reports success.
 *
 * `installCrx` also refuses outright when `expectedId` already names an
 * entry that is not `updater.kind === 'store'`: this is the ONE place every
 * download this library makes lands (a fresh store install, the "Update"
 * button, and the vendored updater's own background/on-focus checks, which
 * decide "store extension" from the loaded manifest's own `key` and
 * `update_url` alone -- UPSTREAM.md patch 4's own doc), so it is the one
 * place that can refuse a download from silently taking over a `.crx`
 * installed from a local file into the very same slot (same id) and
 * flipping its `source`/`updater` to store. A fresh store install (no entry
 * yet for `expectedId`) is unaffected.
 *
 * `uninstall` acts only on a `source.kind === 'store'` entry -- a folder or
 * file install is never removable through `chrome.management.uninstall`,
 * which this file's `beginInstall` sibling and the store page can both
 * reach -- and only once the person confirms, through the same
 * `ctx.prompt` seam an install itself uses (install-runner.ts's own
 * `InstallPrompt`), so a real removal always shows something on screen.
 */
export function buildWebStoreHost (ctx: InstallContext): WebStoreHost {
  return {
    installCrx: async (crx, expectedId, approvedManifest, downloadUrl) => {
      const existing = readRegistry(ctx.userDataPath).find((entry) => entry.id === expectedId)
      if (existing !== undefined && existing.updater.kind !== 'store') {
        throw new Error(`${expectedId} is not managed by the Chrome Web Store; refusing to install over it`)
      }
      const outcome = await installFromStoreCrx(ctx, crx, expectedId, approvedManifest, {
        skipPrompt: true,
        ...(downloadUrl === undefined ? {} : { downloadUrl })
      })
      if (!outcome.installed) throw new Error(outcome.reason)
    },
    uninstall: async (id) => {
      const entry = readRegistry(ctx.userDataPath).find((candidate) => candidate.id === id)
      if (entry === undefined || entry.source.kind !== 'store') return
      const description: ExtensionInstallDescription = {
        title: 'Remove extension',
        message: `Remove ${entry.name}?`,
        detail: '',
        warning: false
      }
      const confirmed = await ctx.prompt(description)
      if (!confirmed) return
      await uninstall(ctx, id)
    }
  }
}

/** `state.session` is the default session for both the store's own IPC and
 * every extension Orivon loads, so an update check's
 * `session.extensions.getAllExtensions()` already sees what Orivon
 * installed with no bookkeeping of its own. */
export async function startWebStore (ctx: InstallContext, preloadPath: string): Promise<StoreApi> {
  const host = buildWebStoreHost(ctx)

  const onUpdateCheck = (result: UpdateCheckResult): void => {
    const lastResult = result.error !== undefined
      ? `check failed: ${result.error}`
      : result.to !== undefined ? `update to ${result.to} available` : 'up to date'
    void patchStoreUpdater(ctx.userDataPath, result.extensionId, { lastCheckedAt: result.checkedAt, lastResult })
  }

  await installChromeWebStore({
    session: ctx.session,
    loadExtensions: false,
    autoUpdate: true,
    preloadPath,
    verifyCrx,
    beforeInstall: async ({ manifest }) => {
      const parsed = readExtensionManifest(manifest)
      if (!parsed.ok) return { action: 'deny' }
      const allowed = await ctx.prompt(describeExtensionInstall(parsed.facts, 'store'))
      return { action: allowed ? 'allow' : 'deny' }
    },
    onUpdateCheck,
    host
  })

  return {
    installFromStore: async (id) => await installFromStore(ctx, id),
    checkForUpdates: async () => { await updateExtensions(ctx.session, verifyCrx, onUpdateCheck, host) },
    updateFromStore: async (id) => await updateFromStore(ctx, id)
  }
}
