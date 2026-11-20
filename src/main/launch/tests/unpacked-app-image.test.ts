import { describe, expect, it } from 'vitest'
import { unpackedAppRun } from '../unpacked-app-image.js'

describe('unpackedAppRun', () => {
  it('is the AppRun beside the executable, when there is one', () => {
    const seen: string[] = []
    const found = unpackedAppRun('/home/ada/.local/lib/orivon/app/orivon', (path) => { seen.push(path); return true })
    expect(found).toBe('/home/ada/.local/lib/orivon/app/AppRun')
    expect(seen).toEqual(['/home/ada/.local/lib/orivon/app/AppRun'])
  })

  it('is undefined for a program with no AppRun beside it: a .deb, a run from source, another system', () => {
    expect(unpackedAppRun('/opt/Orivon/orivon', () => false)).toBeUndefined()
    expect(unpackedAppRun('C:\\Users\\ada\\AppData\\Local\\Programs\\Orivon\\Orivon.exe', () => false)).toBeUndefined()
  })

  it('asks the disk by default and finds nothing beside a path that does not exist', () => {
    expect(unpackedAppRun('/no/such/folder/orivon')).toBeUndefined()
  })
})
