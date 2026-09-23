// The `buffer` package as the page's `Buffer` global, the way Node code ported
// to an app tab reads it: bare, never imported. ./expose-shim-globals.ts hands
// installPageBuffer to contextBridge.executeInMainWorld, which serialises it
// alone, so it may not name an import. The preload build inlines the package
// into its body instead (electron.vite.config.ts's pageBufferPackage); see
// README.md's Design notes for why this route and not webFrame.executeJavaScript.

/** The `buffer` package's exports; the preload build replaces this name with the package itself, and fails if it cannot. */
declare const __ORIVON_BUFFER_PACKAGE__: { Buffer: unknown }

export function installPageBuffer (target: object = window): void {
  const { Buffer } = __ORIVON_BUFFER_PACKAGE__
  // Node's own descriptor for its Buffer global (ADR-0021).
  Object.defineProperty(target, 'Buffer', { value: Buffer, writable: true, configurable: true, enumerable: false })
}
