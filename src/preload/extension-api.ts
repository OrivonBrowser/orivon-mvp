// Orivon's own entry point for the extension-page/service-worker preload,
// wrapping vendor/electron-chrome-extensions/src/preload.ts (unmodified)
// with one addition that runs immediately after it, in the SAME preload
// script: a health check for the service-worker injection
// extension-sw-preload-recovery.ts's own header describes
// (docs/open-questions.md A289). A second, SEPARATE
// session.registerPreloadScript({ type: 'service-worker' }) registration on
// one session never runs at all for the same worker start (not "sometimes
// doesn't", never), so the check rides inside this one file instead of a
// second registration -- true regardless of A289's own finding, and would
// still matter once that one is resolved.
//
// electron.vite.config.ts's preload build points its 'extension-api' entry
// here, not at the vendor file directly; extension-host.ts registers the
// single bundled output (out/preload/extension-api.js) for both 'frame'
// and 'service-worker' preload types, exactly as
// vendor/.../src/browser/index.ts's own prependPreload would have pointed
// at its own file.
import '../../vendor/electron-chrome-extensions/src/preload.js'
import { installServiceWorkerPreloadHealthCheck } from './extension-sw-verify.js'

installServiceWorkerPreloadHealthCheck()
