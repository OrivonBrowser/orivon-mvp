// The app the app-update specs install at a `.eth` name and then move the name away from, built as
// the files an IPFS site holds. Each build says which it is on the page and in its service worker,
// so a spec can tell which version a tab, or the worker controlling it, is running.

/**
 * @param {{ version: string, build: string, domain?: string, net?: boolean, extra?: string }} options
 *   `build` names the build on the page; `net` declares one `https.connect` capability; `extra` makes two
 *   builds of one version hold different files.
 * @returns {Record<string, string>} path -> content, ready for `startFixtureGateway`
 */
export function updateApp ({ version, build, domain, net = false, extra = '' }) {
  const manifest = {
    orivonApiVersion: 0,
    id: 'eth.orivon.update',
    name: 'Update fixture',
    version,
    entry: 'index.html',
    assets: ['app.js', 'sw.js'],
    capabilities: net ? { net: { https: { connect: ['api.example.com:443'] } } } : {},
    ...(domain === undefined ? {} : { domain })
  }
  return {
    'index.html': `<!doctype html><meta charset="utf-8"><title>update fixture ${build}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body data-build="${build}">update fixture ${build}<script src="app.js"></script></body>`,
    'app.js': `document.body.dataset.ran = ${JSON.stringify(build)}
window.askWorkerBuild = async () => {
  const registration = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const worker = navigator.serviceWorker.controller ?? registration.active
  const channel = new MessageChannel()
  const answer = new Promise((resolve) => { channel.port1.onmessage = (event) => { resolve(event.data) } })
  worker.postMessage('build', [channel.port2])
  return await answer
}
window.updateWorker = async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); return true }
${extra}`,
    'sw.js': `const BUILD = ${JSON.stringify(build)}
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })
self.addEventListener('message', (event) => { event.ports[0].postMessage(BUILD) })`,
    '.well-known/orivon.json': JSON.stringify(manifest)
  }
}
