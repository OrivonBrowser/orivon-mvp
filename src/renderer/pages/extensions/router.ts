// Which view an address names: `orivon://extensions/` the list,
// `/details?id=`, `/errors?id=` and `/shortcuts`. Pure.
export type ViewName = 'list' | 'details' | 'errors' | 'shortcuts'

export interface Place {
  readonly view: ViewName
  /** The extension a details or errors view is about. */
  readonly id: string | null
  /** The address this place should have, when the one asked for is not it. */
  readonly canonical: string | null
}

export function pathFor (view: ViewName, id?: string): string {
  switch (view) {
    case 'list': return '/'
    case 'shortcuts': return '/shortcuts'
    case 'details': return `/details?id=${encodeURIComponent(id ?? '')}`
    case 'errors': return `/errors?id=${encodeURIComponent(id ?? '')}`
  }
}

/** An unknown path, or a view that needs an extension and names none, is the list. */
export function placeFor (pathname: string, search: string): Place {
  const first = pathname.split('/').filter((part) => part !== '')[0]
  const asked = `${pathname}${search}`
  if (first === 'shortcuts') return { view: 'shortcuts', id: null, canonical: asked === '/shortcuts' ? null : '/shortcuts' }
  if (first === 'details' || first === 'errors') {
    const id = new URLSearchParams(search).get('id')
    if (id !== null && id !== '') {
      const canonical = pathFor(first, id)
      return { view: first, id, canonical: asked === canonical ? null : canonical }
    }
  }
  return { view: 'list', id: null, canonical: asked === '/' ? null : '/' }
}
