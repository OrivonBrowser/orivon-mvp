// The real-Node half of the express and socket.io app: the app's files (a
// temporary directory, served through orivon.fs) and the loopback listener,
// both built on the real builtins. The bundling test lets only this file, and
// the two support files it imports, see Node's own modules; everything else
// in the bundle sees the shim's.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRealDiskFs } from '../real-disk-fs.ts'
import { listenViaRealSocket } from '../real-tcp-listen.ts'

export async function prepareOrivon () {
  const disk = await createRealDiskFs()
  mkdirSync(join(disk.root, 'public'), { recursive: true })
  writeFileSync(join(disk.root, 'public', 'hello.txt'), 'hello from the app files, served by express.static')
  writeFileSync(join(disk.root, 'public', 'index.html'), '<!doctype html><title>lounge</title>')
  return { fs: disk.orivon.fs, net: { listen: (options) => listenViaRealSocket()(options) } }
}
