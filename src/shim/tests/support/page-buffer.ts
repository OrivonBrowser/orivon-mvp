// The `buffer` package the page's `Buffer` comes from (module-map.ts), not
// Node's builtin. A shim module under test returns this class, so a test
// asserting "a real Buffer" must ask this class, not the test's own global.
// The trailing slash names the package rather than the builtin.

export { Buffer as PageBuffer } from 'buffer/'
