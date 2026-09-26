// `dns/promises` module target: the same object net/dns.ts exports as
// `dns.promises`, so `import { lookup } from 'dns/promises'` and
// `require('dns').promises.lookup` are one implementation.

import { promises } from './dns.js'

export const lookup = promises.lookup
export default promises
