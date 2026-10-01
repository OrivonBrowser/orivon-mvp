// Generated (A287): a named export per Node `fs` member this shim does
// not export itself, each throwing the refusal this module's own default export already
// throws for the same name -- so a bundler's CommonJS require() interop, which hands the
// ESM namespace rather than the default, still names the gap instead of `undefined`. An
// explicit export in fs.js shadows one of these, so a member this shim later
// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with
// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { refusingExport } from '../../generated-refusal.js'
import { otherFsMember } from '../fs.js'

const classify = otherFsMember

export const Dir = refusingExport('Dir', classify)
export const Dirent = refusingExport('Dirent', classify)
export const FileReadStream = refusingExport('FileReadStream', classify)
export const FileWriteStream = refusingExport('FileWriteStream', classify)
export const ReadStream = refusingExport('ReadStream', classify)
export const Stats = refusingExport('Stats', classify)
export const Utf8Stream = refusingExport('Utf8Stream', classify)
export const WriteStream = refusingExport('WriteStream', classify)
export const _toUnixTimestamp = refusingExport('_toUnixTimestamp', classify)
export const chown = refusingExport('chown', classify)
export const chownSync = refusingExport('chownSync', classify)
export const copyFile = refusingExport('copyFile', classify)
export const cp = refusingExport('cp', classify)
export const cpSync = refusingExport('cpSync', classify)
export const exists = refusingExport('exists', classify)
export const fchown = refusingExport('fchown', classify)
export const fchownSync = refusingExport('fchownSync', classify)
export const fdatasync = refusingExport('fdatasync', classify)
export const fdatasyncSync = refusingExport('fdatasyncSync', classify)
export const fsyncSync = refusingExport('fsyncSync', classify)
export const ftruncateSync = refusingExport('ftruncateSync', classify)
export const futimes = refusingExport('futimes', classify)
export const futimesSync = refusingExport('futimesSync', classify)
export const glob = refusingExport('glob', classify)
export const globSync = refusingExport('globSync', classify)
export const lchown = refusingExport('lchown', classify)
export const lchownSync = refusingExport('lchownSync', classify)
export const link = refusingExport('link', classify)
export const linkSync = refusingExport('linkSync', classify)
export const lutimes = refusingExport('lutimes', classify)
export const lutimesSync = refusingExport('lutimesSync', classify)
export const mkdtemp = refusingExport('mkdtemp', classify)
export const mkdtempDisposableSync = refusingExport('mkdtempDisposableSync', classify)
export const openAsBlob = refusingExport('openAsBlob', classify)
export const opendir = refusingExport('opendir', classify)
export const opendirSync = refusingExport('opendirSync', classify)
export const readlink = refusingExport('readlink', classify)
export const readlinkSync = refusingExport('readlinkSync', classify)
export const readv = refusingExport('readv', classify)
export const readvSync = refusingExport('readvSync', classify)
export const statfs = refusingExport('statfs', classify)
export const statfsSync = refusingExport('statfsSync', classify)
export const symlink = refusingExport('symlink', classify)
export const symlinkSync = refusingExport('symlinkSync', classify)
export const truncate = refusingExport('truncate', classify)
export const truncateSync = refusingExport('truncateSync', classify)
export const unwatchFile = refusingExport('unwatchFile', classify)
export const utimes = refusingExport('utimes', classify)
export const utimesSync = refusingExport('utimesSync', classify)
export const watchFile = refusingExport('watchFile', classify)
export const writev = refusingExport('writev', classify)
export const writevSync = refusingExport('writevSync', classify)

/**
 * Node `fs` members this file has no stand-in for: real Node exposes each
 * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).
 * Checked by the freshness test above, so a member that changes shape is still seen.
 */
export const DATA_GAPS: readonly string[] = []
