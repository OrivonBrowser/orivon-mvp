import { describe, expect, it } from 'vitest'
import { desktopOf, kdeVersionOf, sourceOf } from '../settings-source.js'

describe('the desktop, as Chromium picks it', () => {
  it.each([
    ['GNOME', 'gnome'], ['ubuntu:GNOME', 'gnome'], ['Unity', 'gnome'], ['X-Cinnamon', 'gnome'], ['Pantheon', 'gnome'],
    ['Deepin', 'gnome'], ['UKUI', 'gnome'], ['COSMIC', 'gnome'], ['KDE', 'kde'], ['XFCE', 'other'], ['LXQt', 'other'], ['Budgie:GNOME', 'gnome'], ['unknown', 'other']
  ])('reads XDG_CURRENT_DESKTOP=%s as %s', (value, expected) => {
    expect(desktopOf({ XDG_CURRENT_DESKTOP: value })).toBe(expected)
  })

  it('takes the first name it knows when the variable lists several', () => {
    expect(desktopOf({ XDG_CURRENT_DESKTOP: 'KDE:GNOME' })).toBe('kde')
    expect(desktopOf({ XDG_CURRENT_DESKTOP: 'ubuntu : GNOME' })).toBe('gnome')
  })

  it.each([
    ['gnome', 'gnome'], ['mate', 'gnome'], ['deepin', 'gnome'], ['ukui', 'gnome'], ['kde4', 'kde'], ['kde-plasma', 'kde'], ['kde', 'kde'], ['xfce', 'other'], ['xubuntu', 'other'], ['plasma', 'other']
  ])('falls back to DESKTOP_SESSION=%s as %s', (value, expected) => {
    expect(desktopOf({ DESKTOP_SESSION: value })).toBe(expected)
  })

  it('falls back to the older variables, and to nothing at all', () => {
    expect(desktopOf({ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' })).toBe('gnome')
    expect(desktopOf({ KDE_FULL_SESSION: 'true' })).toBe('kde')
    expect(desktopOf({})).toBe('other')
  })

  it('prefers XDG_CURRENT_DESKTOP to the older variables', () => {
    expect(desktopOf({ XDG_CURRENT_DESKTOP: 'XFCE', GNOME_DESKTOP_SESSION_ID: 'x', DESKTOP_SESSION: 'gnome' })).toBe('other')
  })
})

describe('the KDE generation, as Chromium picks it', () => {
  it('is told by KDE_SESSION_VERSION when XDG_CURRENT_DESKTOP says KDE, and KDE 4 when it says nothing useful', () => {
    expect(kdeVersionOf({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '5' })).toBe(5)
    expect(kdeVersionOf({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' })).toBe(6)
    expect(kdeVersionOf({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '4' })).toBe(4)
    expect(kdeVersionOf({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '7' })).toBe(4)
    expect(kdeVersionOf({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe(4)
  })

  it('is KDE 4 or 3 from the older variables, by whether KDE_SESSION_VERSION is there, and never 5 or 6', () => {
    expect(kdeVersionOf({ DESKTOP_SESSION: 'kde4' })).toBe(4)
    expect(kdeVersionOf({ DESKTOP_SESSION: 'kde-plasma', KDE_SESSION_VERSION: '5' })).toBe(4)
    expect(kdeVersionOf({ DESKTOP_SESSION: 'kde' })).toBe(3)
    expect(kdeVersionOf({ DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '5' })).toBe(4)
    expect(kdeVersionOf({ KDE_FULL_SESSION: 'true' })).toBe(3)
    expect(kdeVersionOf({ KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '6' })).toBe(4)
  })

  it('is nothing on a desktop that is not KDE', () => {
    expect(kdeVersionOf({ XDG_CURRENT_DESKTOP: 'GNOME', KDE_SESSION_VERSION: '5' })).toBeUndefined()
    expect(kdeVersionOf({})).toBeUndefined()
  })
})

describe('where the settings are kept', () => {
  it('is the registry on Windows and the system configuration on macOS, whatever the environment says', () => {
    expect(sourceOf('win32', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('windows')
    expect(sourceOf('darwin', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('macos')
  })

  it('is the desktop\'s on Linux, and the environment where the desktop keeps none', () => {
    expect(sourceOf('linux', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('gnome')
    expect(sourceOf('linux', { XDG_CURRENT_DESKTOP: 'KDE' })).toBe('kde')
    expect(sourceOf('linux', { XDG_CURRENT_DESKTOP: 'XFCE' })).toBe('environment')
    expect(sourceOf('linux', {})).toBe('environment')
  })
})
