// The grant icons live under `pages/shared/` so the Settings page can draw them (an internal page's dev-mode request
// may only come from that prefix, `src/main/pages/route.ts`); the site-info popup and the first-visit question reach them from here.
export { grantIcon, isGrantIconKind } from './pages/shared/grant-icons.js'
export type { GrantIconKind } from './pages/shared/grant-icons.js'
