// Bundled against the shim by ./e2e-native-addon.test.ts as /addon-child.js:
// a forked child loading a large addon synchronously, which a Worker may do.

import { createRequire } from 'module'

const require = createRequire('/addon-child.js')
const addon = require('./native/big.node') as { answer: number, greet: string }
process.send?.({ answer: addon.answer, greet: addon.greet })
