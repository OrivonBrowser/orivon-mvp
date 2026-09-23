// `dns/promises` module target: the same object node-dns.ts exports as
// `dns.promises`, so `import { lookup } from 'dns/promises'` and
// `require('dns').promises.lookup` are one implementation.

import { promises } from './node-dns.js'

export const lookup = promises.lookup
export default promises
