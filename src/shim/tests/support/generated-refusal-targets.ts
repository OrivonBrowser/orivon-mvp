// The local module targets generated-refusals.test.ts (A287) generates a
// named-export stand-in file for, and how to build each one's `classify`
// (the same refusal its own default export already throws for the name).
//
// NOT every 'local' module-map.ts row: excluded, and left for the owner or
// a later pass --
//  - the subpath rows (path/posix, fs/promises, stream/promises, util/types,
//    dns/promises, timers/promises): each names a Node module distinct from
//    its sibling (node:fs/promises's own export list is not node:fs's), so
//    reusing the sibling's gap analysis would be wrong and a correct one is
//    unbuilt.
//  - child_process, module, vm, worker_threads, wasi: process/thread/module-
//    system surfaces with narrower CommonJS-`require()` exposure than
//    os/net/fs/crypto (webtorrent's own dependency graph, README.md
//    requirement 1) and their own unusual semantics; not covered by this pass.
//  - dgram (net/dgram.ts): its default export is a bare object, not yet
//    wrapped in refusingProxy at all -- so it does not meet this list's own
//    precondition ("already refuses through the default export") and adding
//    a namespace stand-in without first fixing that would be misleading.

export interface RefusalTarget {
  /** module-map.ts's specifier, and node-builtin-exports.generated.json's key. */
  readonly specifier: string
  /** The hand-written module, relative to src/shim/ -- its default export's OWN keys mark what NOT to generate a stand-in for. */
  readonly sourceModule: string
  /** The generated file this target owns, relative to src/shim/. */
  readonly generatedFile: string
  /** Where `classifyImportName` is imported from, relative to src/shim/. */
  readonly classifyModule: string
  readonly classifyImportName: string
  /** Literal source for `const classify = <expr>` in the generated file, using `classifyImportName`. */
  readonly classifyExpr: string
}

function generic (specifier: string, sourceModule: string, generatedFile: string): RefusalTarget {
  return {
    specifier,
    sourceModule,
    generatedFile,
    classifyModule: 'polyfills/module-proxy.js',
    classifyImportName: 'nodeModuleRefusal',
    classifyExpr: `(prop: string) => nodeModuleRefusal('${specifier}', prop)`
  }
}

export const REFUSAL_TARGETS: readonly RefusalTarget[] = [
  generic('util', 'polyfills/util.js', 'polyfills/generated/util.ts'),
  generic('buffer', 'polyfills/buffer.js', 'polyfills/generated/buffer.ts'),
  generic('crypto', 'polyfills/crypto.js', 'polyfills/generated/crypto.ts'),
  generic('path', 'polyfills/path.js', 'polyfills/generated/path.ts'),
  generic('zlib', 'polyfills/zlib.js', 'polyfills/generated/zlib.ts'),
  generic('timers', 'polyfills/timers.js', 'polyfills/generated/timers.ts'),
  generic('url', 'polyfills/url.js', 'polyfills/generated/url.ts'),
  generic('querystring', 'polyfills/querystring.js', 'polyfills/generated/querystring.ts'),
  generic('string_decoder', 'polyfills/string-decoder.js', 'polyfills/generated/string-decoder.ts'),
  generic('assert', 'polyfills/assert.js', 'polyfills/generated/assert.ts'),
  generic('os', 'polyfills/os.js', 'polyfills/generated/os.ts'),
  {
    specifier: 'net',
    sourceModule: 'net/net.js',
    generatedFile: 'net/generated/net.ts',
    classifyModule: 'net/net.js',
    classifyImportName: 'otherNetMember',
    classifyExpr: 'otherNetMember'
  },
  {
    specifier: 'dns',
    sourceModule: 'net/dns.js',
    generatedFile: 'net/generated/dns.ts',
    classifyModule: 'net/dns.js',
    classifyImportName: 'otherDnsMember',
    classifyExpr: 'otherDnsMember'
  },
  {
    specifier: 'tls',
    sourceModule: 'net/tls.js',
    generatedFile: 'net/generated/tls.ts',
    classifyModule: 'net/tls.js',
    classifyImportName: 'otherTlsMember',
    classifyExpr: 'otherTlsMember'
  },
  {
    specifier: 'fs',
    sourceModule: 'fs/fs.js',
    generatedFile: 'fs/generated/fs.ts',
    classifyModule: 'fs/fs.js',
    classifyImportName: 'otherFsMember',
    classifyExpr: 'otherFsMember'
  },
  {
    specifier: 'http',
    sourceModule: 'http/http.js',
    generatedFile: 'http/generated/http.ts',
    classifyModule: 'http/unsupported.js',
    classifyImportName: 'otherHttpMember',
    classifyExpr: "otherHttpMember('http')"
  },
  {
    specifier: 'https',
    sourceModule: 'http/https.js',
    generatedFile: 'http/generated/https.ts',
    classifyModule: 'http/unsupported.js',
    classifyImportName: 'otherHttpMember',
    classifyExpr: "otherHttpMember('https')"
  }
]
