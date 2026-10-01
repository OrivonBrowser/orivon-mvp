// The site engines a profile starts with. They are the person's to edit or remove; a removal is remembered
// (search-engine-store.ts) so it stays removed. Pure data.

export interface SiteEngineSeed {
  readonly id: string
  readonly name: string
  readonly keyword: string
  readonly template: string
}

export const SEED_PREFIX = 'seed-'

export const SITE_ENGINE_SEEDS: readonly SiteEngineSeed[] = [
  { id: 'seed-wikipedia', name: 'Wikipedia', keyword: 'w', template: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { id: 'seed-youtube', name: 'YouTube', keyword: 'yt', template: 'https://www.youtube.com/results?search_query=%s' },
  { id: 'seed-github', name: 'GitHub', keyword: 'gh', template: 'https://github.com/search?q=%s' },
  { id: 'seed-openstreetmap', name: 'OpenStreetMap', keyword: 'map', template: 'https://www.openstreetmap.org/search?query=%s' }
]
