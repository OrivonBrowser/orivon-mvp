// What the library's renderer seam (vendor UPSTREAM.md patch 45) leaves on
// `globalThis.__crx` for an Orivon namespace to read: present while the
// namespaces are built, deleted before the page's own code runs.
export interface Crx {
  readonly extensionId: string
  readonly manifest: chrome.runtime.Manifest
  /** 'worker' in a service worker, 'page' in any extension document. */
  readonly context: 'worker' | 'page'
  /** The manifest asks for `permission`, required or optional. Whether it is
   * granted right now is main's answer, never this one. */
  readonly declares: (permission: string) => boolean
  /** One main-side handler as a function: rejects with the handler's own
   * error message, or with a trailing callback calls back `undefined`. */
  readonly call: (name: string) => (...args: unknown[]) => Promise<unknown>
  /** An event main routes to this context's listeners. */
  readonly event: (name: string) => chrome.events.Event<any>
  /** Defines `chrome.<ns>` as the library's own namespaces are defined;
   * `build` receives Electron's native object of that name, if any. */
  readonly define: (ns: string, build: (base: any) => object) => void
}
