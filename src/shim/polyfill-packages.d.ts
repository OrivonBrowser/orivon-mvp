// Types for the polyfill packages' own files, which ship none. Each borrows
// Node's declaration of the module it stands in for, narrowed to what the
// package really exports.

declare module 'os-browserify/browser.js' {
  import type * as os from 'node:os'
  const browserOs: Pick<typeof os,
    'EOL' | 'arch' | 'cpus' | 'endianness' | 'freemem' | 'homedir' | 'hostname' | 'loadavg' |
    'networkInterfaces' | 'platform' | 'release' | 'tmpdir' | 'totalmem' | 'type' | 'uptime'>
  export default browserOs
}
