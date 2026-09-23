// `dns/promises` module target (module-map.ts): node-dns.ts's own `promises`
// object, as default export and as its one built member.

import { promises } from './node-dns.js'

export const lookup = promises.lookup
export default promises
