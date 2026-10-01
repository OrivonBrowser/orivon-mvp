import { describe, expect, it } from 'vitest'
import { isDangerousFile } from '../dangerous-file.js'

describe('isDangerousFile', () => {
  it.each(['setup.exe', 'SETUP.EXE', 'run.sh', 'a.AppImage', 'x.msi', 'y.ps1', 'z.jar', 'app.apk', 'f.desktop', 'p.js', 'k.dmg'])('says %s is dangerous', (name) => {
    expect(isDangerousFile(name, '')).toBe(true)
  })

  it.each([
    'a.vbe', 'a.wsh', 'a.ws', 'a.cpl', 'a.msc', 'a.msp', 'a.mst', 'a.chm', 'a.scf', 'a.url', 'a.website', 'a.inf', 'a.gadget',
    'a.application', 'a.appref-ms', 'a.settingcontent-ms', 'a.xbap', 'a.iso', 'a.img', 'a.vhd', 'a.vhdx', 'a.psm1', 'a.psd1',
    'a.ps1xml', 'a.terminal', 'a.workflow', 'a.scpt', 'a.applescript', 'a.mpkg', 'a.webloc', 'a.inetloc', 'a.fileloc', 'a.py', 'a.pl'
  ])('says %s is dangerous too', (name) => {
    expect(isDangerousFile(name, '')).toBe(true)
  })

  it('goes by the last extension, so a double extension does not hide one', () => {
    expect(isDangerousFile('photo.jpg.exe', 'image/jpeg')).toBe(true)
    expect(isDangerousFile('setup.exe.txt', 'text/plain')).toBe(false)
  })

  it('catches an executable content type whatever the name says', () => {
    expect(isDangerousFile('download.bin', 'application/x-msdownload')).toBe(true)
    expect(isDangerousFile('download.bin', 'application/x-sh; charset=utf-8')).toBe(true)
  })

  it('leaves ordinary files alone', () => {
    expect(isDangerousFile('report.pdf', 'application/pdf')).toBe(false)
    expect(isDangerousFile('file.bin', 'application/octet-stream')).toBe(false)
    expect(isDangerousFile('noextension', '')).toBe(false)
    expect(isDangerousFile('endsindot.', '')).toBe(false)
  })
})
