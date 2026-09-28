// Bundled against the shim by ./e2e-native-addon.test.ts as /files-child.js:
// a forked child of a cross-origin isolated app, whose addon and readFileSync
// block on the page's orivon.fs.

import { readFileSync } from 'fs'
import { createRequire } from 'module'

const require = createRequire('/files-child.js')
const addon = require('./native/files.node') as { content: string, openErrno: number }
process.send?.({ openErrno: addon.openErrno, content: addon.content, readFileSync: readFileSync('data.txt', 'utf8') })
