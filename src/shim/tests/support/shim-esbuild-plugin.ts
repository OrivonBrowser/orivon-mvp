// Bundles an e2e fixture app's own script against src/shim/ the way a real
// app's bundler would: the one implementation is bundler/esbuild-plugin.ts.

import type { Plugin } from 'esbuild'
import { orivonShimPlugin } from '../../bundler/esbuild-plugin.js'

export function shimEsbuildPlugin (): Plugin {
  return orivonShimPlugin()
}
