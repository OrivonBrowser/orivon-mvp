// Shared constants for the fixture's two standalone servers.
//
// A plain data module with no side effects -- importing it starts nothing.
// That is what lets manifest.test.ts check .well-known/orivon.json against
// these values without spinning up echo-server.mjs or serve.mjs as a side
// effect of running the test suite.
//
// ECHO_PORT is duplicated once, unavoidably: .well-known/orivon.json is a
// static JSON file and cannot import this module. If ECHO_PORT changes here,
// the manifest's capabilities.net.tcp.connect pattern must change to match --
// manifest.test.ts asserts the two agree, so a missed update fails loudly.

export const HOST = '127.0.0.1'
export const ECHO_PORT = 8873
export const STATIC_PORT = 8872
