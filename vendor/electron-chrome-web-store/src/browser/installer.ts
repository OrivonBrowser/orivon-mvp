// Orivon patch: see types.ts's own doc on this reference (UPSTREAM.md patch 6).
/// <reference types="chrome" />
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { session as electronSession } from 'electron'

import AdmZip from 'adm-zip'
import debug from 'debug'
import Pbf from 'pbf'

import { readCrxFileHeader, readSignedData } from './crx3'
import { convertHexadecimalToIDAlphabet, generateId } from './id'
import { fetch, getChromeVersion, getDefaultExtensionsPath } from './utils'
import { findExtensionInstall } from './loader'
import type { ExtensionId, VerifyCrx, WebStoreHost } from './types'

const d = debug('electron-chrome-web-store:installer')

function getExtensionCrxURL(extensionId: ExtensionId) {
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.append('response', 'redirect')
  url.searchParams.append('acceptformat', ['crx2', 'crx3'].join(','))

  const x = new URLSearchParams()
  x.append('id', extensionId)
  x.append('uc', '')

  url.searchParams.append('x', x.toString())
  url.searchParams.append('prodversion', getChromeVersion())

  return url.toString()
}

// Orivon patch: exported so downloadCrxBytes below can return it to a
// caller that needs the parsed header (installer.ts's own host branch,
// and src/main/extensions/install-runner.ts's store-driven installs).
export interface CrxInfo {
  extensionId: string
  version: number
  header: Buffer
  contents: Buffer
  publicKey: Buffer
}

// Parse CRX header and extract contents
function parseCrx(buffer: Buffer): CrxInfo {
  // CRX3 magic number: 'Cr24'
  const magicNumber = buffer.toString('utf8', 0, 4)
  if (magicNumber !== 'Cr24') {
    throw new Error('Invalid CRX format')
  }

  // CRX3 format has version = 3 and header size at bytes 8-12
  const version = buffer.readUInt32LE(4)
  const headerSize = buffer.readUInt32LE(8)

  // Extract header and contents
  const header = buffer.subarray(12, 12 + headerSize)
  const contents = buffer.subarray(12 + headerSize)

  let extensionId: string
  let publicKey: Buffer

  // For CRX2 format
  if (version === 2) {
    const pubKeyLength = buffer.readUInt32LE(8)
    const sigLength = buffer.readUInt32LE(12)
    publicKey = buffer.subarray(16, 16 + pubKeyLength)
    extensionId = generateId(publicKey.toString('base64'))
  } else {
    // For CRX3, extract public key from header
    // CRX3 header contains a protocol buffer message
    const crxFileHeader = readCrxFileHeader(new Pbf(header))
    const crxSignedData = readSignedData(new Pbf(crxFileHeader.signed_header_data))
    const declaredCrxId = crxSignedData.crx_id
      ? convertHexadecimalToIDAlphabet(crxSignedData.crx_id.toString('hex'))
      : null

    if (!declaredCrxId) {
      throw new Error('Invalid CRX signed data')
    }

    // Need to find store key proof which matches the declared ID
    const keyProof = crxFileHeader.sha256_with_rsa.find((proof) => {
      const crxId = proof.public_key ? generateId(proof.public_key.toString('base64')) : null
      return crxId === declaredCrxId
    })

    if (!keyProof) {
      throw new Error('Invalid CRX key')
    }

    extensionId = declaredCrxId
    publicKey = keyProof.public_key
  }

  return {
    extensionId,
    version,
    header,
    contents,
    publicKey,
  }
}

// Extract CRX contents and update manifest
async function unpackCrx(crx: CrxInfo, destPath: string): Promise<chrome.runtime.Manifest> {
  // Create zip file from contents
  const zip = new AdmZip(crx.contents)

  // Extract zip to destination
  zip.extractAllTo(destPath, true)

  // Read manifest.json
  const manifestPath = path.join(destPath, 'manifest.json')
  const manifestContent = await fs.promises.readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestContent) as chrome.runtime.Manifest

  // Add public key to manifest
  manifest.key = crx.publicKey.toString('base64')

  // Write updated manifest back
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  return manifest
}

async function downloadCrx(url: string, dest: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('Failed to download extension')
  }

  const fileStream = fs.createWriteStream(dest)
  const downloadStream = Readable.fromWeb(response.body as any)
  await pipeline(downloadStream, fileStream)
}

// Orivon patch: the download-and-parse-header half of
// downloadExtensionFromURL, factored out so a caller that only wants the raw
// bytes (the host branch below, and install-runner.ts's own store installs)
// does not have to duplicate it.
export async function downloadCrxBytes(url: string): Promise<{ bytes: Buffer; crx: CrxInfo }> {
  d('downloading %s', url)
  const crxPath = path.join(os.tmpdir(), `electron-cws-download_${crypto.randomUUID()}.crx`)
  try {
    await downloadCrx(url, crxPath)
    const bytes = await fs.promises.readFile(crxPath)
    return { bytes, crx: parseCrx(bytes) }
  } finally {
    await fs.promises.rm(crxPath, { force: true })
  }
}

export async function downloadExtensionFromURL(
  url: string,
  extensionsDir: string,
  verifyCrx: VerifyCrx,
  expectedExtensionId?: string,
  host?: WebStoreHost,
  approvedManifest?: string,
): Promise<string> {
  const { bytes: crxBuffer, crx } = await downloadCrxBytes(url)

  if (expectedExtensionId && expectedExtensionId !== crx.extensionId) {
    throw new Error(
      `CRX mismatches expected extension ID: ${expectedExtensionId} !== ${crx.extensionId}`,
    )
  }

  // Orivon patch: verify the CRX3 signature on the raw downloaded bytes
  // before anything is unzipped to disk. A throw here leaves nothing
  // written, either below or in host.installCrx (its own doc says it does
  // its own, stricter verification too -- this call stays regardless, so
  // every download is checked whether or not a host is installed).
  await verifyCrx(crxBuffer, crx.extensionId)

  // Orivon patch: a host present means Orivon owns writing and loading the
  // extension copy -- it does its own unpack, not this file's. The path
  // this function normally returns is meaningless here; nothing that calls
  // it with a host reads the result.
  if (host) {
    await host.installCrx(crxBuffer, crx.extensionId, approvedManifest, url)
    return ''
  }

  const installUuid = crypto.randomUUID()
  const unpackedPath = path.join(extensionsDir, crx.extensionId, installUuid)
  await fs.promises.mkdir(unpackedPath, { recursive: true })
  const manifest = await unpackCrx(crx, unpackedPath)

  if (!manifest.version) {
    throw new Error('Installed extension is missing manifest version')
  }

  const versionedPath = path.join(extensionsDir, crx.extensionId, `${manifest.version}_0`)
  await fs.promises.rename(unpackedPath, versionedPath)

  return versionedPath
}

/**
 * Download and unpack extension to the given extensions directory.
 */
export async function downloadExtension(
  extensionId: string,
  extensionsDir: string,
  verifyCrx: VerifyCrx,
): Promise<string> {
  const url = getExtensionCrxURL(extensionId)
  return await downloadExtensionFromURL(url, extensionsDir, verifyCrx, extensionId)
}

interface CommonExtensionOptions {
  /** Session to load extensions into. */
  session?: Electron.Session

  /**
   * Directory where web store extensions will be installed.
   * Defaults to `Extensions` under the app's `userData` directory.
   */
  extensionsPath?: string
}

interface InstallExtensionOptions extends CommonExtensionOptions {
  /** Options for loading the extension. */
  loadExtensionOptions?: Electron.LoadExtensionOptions

  /** Orivon patch: required, see types.ts's VerifyCrx. */
  verifyCrx: VerifyCrx

  /** Orivon patch: see types.ts's WebStoreHost. `?: T | undefined`, not
   * plain `?: T`: api.ts passes a whole `WebStoreState` (whose own `host` is
   * `T | undefined`, always present) as this options object, and the root
   * tsconfig's exactOptionalPropertyTypes only accepts that into an optional
   * property whose own type already spells out `| undefined`. */
  host?: WebStoreHost | undefined

  /** Orivon patch 7: the manifest the store page showed the person, passed
   * on to the host with the downloaded bytes. */
  approvedManifest?: string | undefined
}

interface UninstallExtensionOptions extends CommonExtensionOptions {
  /** Orivon patch: see InstallExtensionOptions.host's own doc just above. */
  host?: WebStoreHost | undefined
}

/**
 * Install extension from the web store.
 */
export async function installExtension(
  extensionId: string,
  opts: InstallExtensionOptions,
): Promise<Electron.Extension | undefined> {
  d('installing %s', extensionId)

  // Orivon patch: a host owns every install -- it writes and loads its own
  // copy (session.extensions.getExtension already reflects that once
  // host.installCrx resolves, since Orivon loads into this SAME session).
  // The "already loaded"/"already installed" shortcuts below are the
  // library's own filesystem bookkeeping, which a host makes moot.
  if (opts.host) {
    const extensionsPath = opts.extensionsPath || getDefaultExtensionsPath()
    await downloadExtensionFromURL(
      opts.host.crxUrl?.(extensionId) ?? getExtensionCrxURL(extensionId),
      extensionsPath,
      opts.verifyCrx,
      extensionId,
      opts.host,
      opts.approvedManifest,
    )
    return undefined
  }

  const session = opts.session || electronSession.defaultSession
  const sessionExtensions = session.extensions || session
  const extensionsPath = opts.extensionsPath || getDefaultExtensionsPath()

  // Check if already loaded
  const existingExtension = sessionExtensions.getExtension(extensionId)
  if (existingExtension) {
    d('%s already loaded', extensionId)
    return existingExtension
  }

  // Check if already installed
  const existingExtensionInfo = await findExtensionInstall(extensionId, extensionsPath)
  if (existingExtensionInfo && existingExtensionInfo.type === 'store') {
    d('%s already installed', extensionId)
    return await sessionExtensions.loadExtension(
      existingExtensionInfo.path,
      opts.loadExtensionOptions,
    )
  }

  // Download and load new extension
  const extensionPath = await downloadExtension(extensionId, extensionsPath, opts.verifyCrx)
  const extension = await sessionExtensions.loadExtension(extensionPath, opts.loadExtensionOptions)
  d('installed %s', extensionId)

  return extension
}

/**
 * Uninstall extension from the web store.
 */
export async function uninstallExtension(
  extensionId: string,
  opts: UninstallExtensionOptions = {},
) {
  d('uninstalling %s', extensionId)

  if (opts.host) {
    await opts.host.uninstall(extensionId)
    return
  }

  const session = opts.session || electronSession.defaultSession
  const sessionExtensions = session.extensions || session
  const extensionsPath = opts.extensionsPath || getDefaultExtensionsPath()

  const extensions = sessionExtensions.getAllExtensions()
  const existingExt = extensions.find((ext) => ext.id === extensionId)
  if (existingExt) {
    sessionExtensions.removeExtension(extensionId)
  }

  const extensionDir = path.join(extensionsPath, extensionId)
  try {
    const stat = await fs.promises.stat(extensionDir)
    if (stat.isDirectory()) {
      await fs.promises.rm(extensionDir, { recursive: true, force: true })
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error
    }
  }
}
