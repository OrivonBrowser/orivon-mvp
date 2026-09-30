// A SQLite VFS over the app's files (files.ts), registered through the
// package's JavaScript VFS interface. No locking, like SQLite's own
// `unix-none`: one connection uses a database file at a time. The rollback
// journal is a real file beside the database, so a commit is durable and only
// the pages a transaction changed are written.

import { orivonSqliteFiles, type SqliteFile, type SqliteOpenMode } from './files.js'
import type { Sqlite3 } from './engine.js'

export const ORIVON_VFS_NAME = 'orivon-fs'

const SECTOR_SIZE = 4096
const MAX_PATHNAME = 1024

interface OpenFile {
  readonly file: SqliteFile
  readonly path: string
  readonly deleteOnClose: boolean
}

const installed = new WeakSet<object>()

/** Registers the VFS on `sqlite3` once. A database file opens through it by name. */
export function installOrivonVfs (sqlite3: Sqlite3): void {
  if (installed.has(sqlite3)) return
  installed.add(sqlite3)
  const { capi, wasm } = sqlite3
  const open = new Map<number, OpenFile>()
  let lastError = ''

  const fail = (error: unknown, code: number): number => {
    lastError = error instanceof Error ? error.message : String(error)
    return code
  }
  const cString = (pointer: number): string => wasm.cstrToJs(pointer)

  const ioMethods = new capi.sqlite3_io_methods()
  ioMethods.$iVersion = 1
  sqlite3.vfs.installVfs({
    io: {
      struct: ioMethods,
      methods: {
        xClose (pFile: number) {
          const entry = open.get(pFile)
          if (entry === undefined) return 0
          open.delete(pFile)
          try {
            entry.file.close()
            if (entry.deleteOnClose) orivonSqliteFiles().remove(entry.path)
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_CLOSE)
          }
        },
        xRead (pFile: number, pDest: number, amount: number, offset: number | bigint) {
          try {
            const bytes = open.get(pFile)!.file.read(Number(offset), amount)
            const heap = wasm.heap8u()
            heap.set(bytes.subarray(0, amount), Number(pDest))
            if (bytes.length >= amount) return 0
            heap.fill(0, Number(pDest) + bytes.length, Number(pDest) + amount)
            return capi.SQLITE_IOERR_SHORT_READ
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_READ)
          }
        },
        xWrite (pFile: number, pSrc: number, amount: number, offset: number | bigint) {
          try {
            open.get(pFile)!.file.write(Number(offset), wasm.heap8u().slice(Number(pSrc), Number(pSrc) + amount))
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_WRITE)
          }
        },
        xTruncate (pFile: number, size: number | bigint) {
          try {
            open.get(pFile)!.file.truncate(Number(size))
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_TRUNCATE)
          }
        },
        xSync (pFile: number) {
          try {
            open.get(pFile)!.file.sync()
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_FSYNC)
          }
        },
        xFileSize (pFile: number, pSize: number) {
          try {
            wasm.poke64(pSize, BigInt(open.get(pFile)!.file.size()))
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_FSTAT)
          }
        },
        xLock: () => 0,
        xUnlock: () => 0,
        xCheckReservedLock (_pFile: number, pOut: number) {
          wasm.poke32(pOut, 0)
          return 0
        },
        xFileControl: () => capi.SQLITE_NOTFOUND,
        xSectorSize: () => SECTOR_SIZE,
        xDeviceCharacteristics: () => 0
      }
    }
  })

  const vfs = new capi.sqlite3_vfs()
  const defaultVfsPointer = capi.sqlite3_vfs_find(null as never)
  const defaultVfs = defaultVfsPointer === 0 ? undefined : new capi.sqlite3_vfs(defaultVfsPointer)
  vfs.$iVersion = 2
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof
  vfs.$mxPathname = MAX_PATHNAME
  if (defaultVfs !== undefined) {
    vfs.$xRandomness = defaultVfs.$xRandomness as never
    vfs.$xSleep = defaultVfs.$xSleep as never
    defaultVfs.dispose()
  }
  sqlite3.vfs.installVfs({
    vfs: {
      struct: vfs,
      name: ORIVON_VFS_NAME,
      methods: {
        xOpen (_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) {
          try {
            const files = orivonSqliteFiles()
            const named = zName !== 0 && wasm.peek8(zName) !== 0
            const path = named ? cString(zName) : files.temporaryPath()
            let mode: SqliteOpenMode
            if (!(flags & capi.SQLITE_OPEN_READWRITE)) mode = 'read'
            else if (!(flags & capi.SQLITE_OPEN_CREATE)) mode = 'readwrite'
            else mode = (flags & capi.SQLITE_OPEN_EXCLUSIVE) || !named ? 'create-exclusive' : 'create'
            const file = files.open(path, mode)
            open.set(pFile, { file, path, deleteOnClose: !named || (flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0 })
            const sqliteFile = new capi.sqlite3_file(pFile)
            sqliteFile.$pMethods = ioMethods.pointer
            sqliteFile.dispose()
            wasm.poke32(pOutFlags, flags)
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_CANTOPEN)
          }
        },
        xDelete (_pVfs: number, zName: number) {
          try {
            orivonSqliteFiles().remove(cString(zName))
            return 0
          } catch (error) {
            return fail(error, (error as { code?: string }).code === 'ENOENT' ? capi.SQLITE_IOERR_DELETE_NOENT : capi.SQLITE_IOERR_DELETE)
          }
        },
        xAccess (_pVfs: number, zName: number, _flags: number, pOut: number) {
          try {
            wasm.poke32(pOut, orivonSqliteFiles().exists(cString(zName)) ? 1 : 0)
            return 0
          } catch (error) {
            return fail(error, capi.SQLITE_IOERR_ACCESS)
          }
        },
        xFullPathname: (_pVfs: number, zName: number, nOut: number, zOut: number) =>
          wasm.cstrncpy(zOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN,
        xGetLastError (_pVfs: number, nOut: number, pOut: number) {
          if (lastError === '' || nOut <= 0) return 0
          const scope = wasm.scopedAllocPush()
          try {
            const [message] = wasm.scopedAllocCString(lastError, true)
            wasm.cstrncpy(pOut, message, nOut)
          } finally {
            wasm.scopedAllocPop(scope)
          }
          lastError = ''
          return capi.SQLITE_IOERR
        },
        xCurrentTime (_pVfs: number, pOut: number) {
          wasm.poke(pOut, 2440587.5 + Date.now() / 86_400_000, 'double')
          return 0
        },
        xCurrentTimeInt64 (_pVfs: number, pOut: number) {
          wasm.poke(pOut, BigInt(0xbfc83e532200) + BigInt(Date.now()), 'i64')
          return 0
        }
      }
    }
  })
}
