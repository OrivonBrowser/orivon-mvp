// The entries of "Orivon Featured" on the new tab, in the order they show. Each opens as any address typed in the
// bar does. The icons are in `featured/`, with their sources in that folder's README.
export interface FeaturedEntry {
  readonly title: string
  readonly url: string
  readonly icon: string
}

export const FEATURED: readonly FeaturedEntry[] = [
  { title: 'Explore', url: 'ipfs://explore.orivonstack.eth', icon: new URL('./featured/explore.svg', import.meta.url).href },
  { title: 'The Lounge', url: 'ipfs://thelounge.orivonstack.eth', icon: new URL('./featured/thelounge.png', import.meta.url).href },
  { title: 'FreeTube', url: 'ipfs://freetube.orivonstack.eth', icon: new URL('./featured/freetube.png', import.meta.url).href },
  { title: 'ASGARDEX', url: 'ipfs://asgardex.orivonstack.eth', icon: new URL('./featured/asgardex.png', import.meta.url).href },
  { title: 'Element', url: 'ipfs://element.orivonstack.eth', icon: new URL('./featured/element.png', import.meta.url).href }
]
