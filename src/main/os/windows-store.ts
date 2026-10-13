// What a Microsoft Store install of Orivon is, and how it is told from the web-link handler Windows keeps. The
// package is the same app as the installer's, run from a folder Windows owns, so the program's path alone says which
// package it is. No `electron` import: the process and the registry's text come in.

/** The package's `Application Id` (`appx.applicationId` in electron-builder.yml), the part of its AUMID after the `!`. */
export const STORE_APPLICATION_ID = 'Orivon'

/** True inside an MSIX package: Electron sets `windowsStore` when the process has a package identity. */
export function isStoreInstall (proc: { readonly windowsStore?: boolean } = process): boolean {
  return proc.windowsStore === true
}

// Windows installs a package into `...\WindowsApps\<Name>_<Version>_<Architecture>_<ResourceId>_<PublisherId>`, with the
// resource id empty for an app's own files, so the folder reads `Name_1.0.0.0_x64__8wekyb3d8bbwe`.
const PACKAGE_FOLDER = /[\\/]WindowsApps[\\/]([^\\/_]+)_[^\\/_]+_[^\\/_]+_[^\\/_]*_([a-z0-9]+)[\\/]/i

/**
 * The AppUserModelID of the package `execPath` runs from: its family name (the name and the publisher id, the two
 * parts of the folder that stay the same from one version to the next), `!`, and the application id. Undefined when
 * the path is not inside a package folder.
 */
export function storeAumid (execPath: string, applicationId: string = STORE_APPLICATION_ID): string | undefined {
  const found = PACKAGE_FOLDER.exec(execPath)
  return found === null ? undefined : `${found[1] ?? ''}_${found[2] ?? ''}!${applicationId}`
}

/** A program id is one registry key name; anything else could make the next read name another key. */
const PROG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The value `name` in the text `reg query` prints (`    Name    REG_SZ    data`). */
function registryValue (output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const found = /^\s+(\S+)\s+REG_SZ\s+(.*?)\s*$/.exec(line)
    if (found !== null && found[1]?.toLowerCase() === name.toLowerCase()) return found[2]
  }
  return undefined
}

/** The program id of the handler the person chose for a web protocol, from `reg query` on its `UserChoice` key. */
export function progIdOf (output: string): string | undefined {
  const value = registryValue(output, 'ProgId')
  return value !== undefined && PROG_ID.test(value) ? value : undefined
}

/** The AUMID a packaged handler's program id names, from `reg query` on that program id's `Application` key. */
export function aumidOfHandler (output: string): string | undefined {
  const value = registryValue(output, 'AppUserModelID')
  return value === undefined || value === '' ? undefined : value
}

/** Whether the handler Windows runs for a web link is this package: a packaged app has no path of its own to compare. */
export function isSameStoreApp (handlerAumid: string | undefined, ownAumid: string | undefined): boolean {
  return handlerAumid !== undefined && ownAumid !== undefined && handlerAumid.toLowerCase() === ownAumid.toLowerCase()
}
