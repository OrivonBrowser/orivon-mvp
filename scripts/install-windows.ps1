# Installs or updates Orivon on Windows with one command, and runs the installer without a SmartScreen warning
# (docs/development/packaging.md section Windows and macOS):
#
#   irm https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-windows.ps1 | iex
#
# Finds the newest release with an x64 installer, downloads it with PowerShell, checks its SHA-256 against the digest
# GitHub reports for the file and runs it silently. SmartScreen only inspects files that carry the Mark of the Web
# (a Zone.Identifier stream), which a browser adds to a download and Invoke-WebRequest does not. Runs on the
# Windows PowerShell 5.1 every Windows ships, and on PowerShell 7. Settings come from the environment:
#
#   ORIVON_REPO          the GitHub repository to read releases from (default OrivonBrowser/orivon-mvp)
#   ORIVON_INSTALLER     a local installer .exe to run instead: skips the release lookup, the download and the digest
#                        check, since the caller vouches for the file
#   ORIVON_INSTALL_DIR   where Orivon goes (default %LOCALAPPDATA%\Programs\Orivon, which needs no administrator)
#   ORIVON_NO_OPEN=1     do not start Orivon at the end
#   ORIVON_GITHUB_TOKEN  a GitHub token for the release lookup, which lifts the per-address rate limit an
#                        unauthenticated lookup shares (a CI runner's address is shared by many jobs)
#
# Everything is inside one function and failures throw: `exit` in a script run through iex would close the
# window the person pasted it into.

function Install-Orivon {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 draws its progress bar into the download and slows it a hundredfold.
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  function Say ($text) { Write-Host "[orivon] $text" }

  $repo = if ($env:ORIVON_REPO) { $env:ORIVON_REPO } else { 'OrivonBrowser/orivon-mvp' }

  if ($env:OS -ne 'Windows_NT') { throw "This installer is for Windows. Download Orivon for your system from https://github.com/$repo/releases" }
  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Orivon needs a 64-bit Windows.' }

  if (Get-Process -Name Orivon -ErrorAction SilentlyContinue) {
    throw 'Orivon is running. Quit it (so no work is lost) and run this command again.'
  }

  $work = Join-Path ([IO.Path]::GetTempPath()) ('orivon-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    if ($env:ORIVON_INSTALLER) {
      if (-not (Test-Path -LiteralPath $env:ORIVON_INSTALLER -PathType Leaf)) { throw "ORIVON_INSTALLER is not a file: $env:ORIVON_INSTALLER" }
      $installer = $env:ORIVON_INSTALLER
      $tag = 'local package'
    } else {
      Say 'Looking for the newest Orivon for Windows ...'
      $headers = @{ 'User-Agent' = 'orivon-install-windows' }
      if ($env:ORIVON_GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:ORIVON_GITHUB_TOKEN" }
      # GitHub now and then answers the release list with an empty array: asked again twice before it counts.
      for ($try = 1; ; $try++) {
        # Never inside @(): Invoke-RestMethod writes a JSON array as one object, and @() would keep it as a single
        # release whose .draft is an array of every release's, which is true, so every release would be skipped.
        try {
          $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=20" -Headers $headers
        } catch {
          throw "Could not read the releases of $repo from GitHub (offline, or its rate limit is reached). Try again later."
        }
        if (@($releases).Count -gt 0 -or $try -ge 3) { break }
        Start-Sleep -Seconds 1
      }

      # The first release that is not a pre-release and has an x64 installer with a digest, else the first such
      # release of any kind. A release published but not yet carrying its packages is skipped.
      $found = @()
      foreach ($release in $releases) {
        if ($release.draft) { continue }
        foreach ($asset in @($release.assets)) {
          if ($asset.name -notmatch '^Orivon-Setup-.*-x64\.exe$' -or -not $asset.digest) { continue }
          $found += [pscustomobject]@{ Tag = $release.tag_name; Pre = [bool]$release.prerelease; Url = $asset.browser_download_url; Digest = ([string]$asset.digest) -replace '^sha256:', '' }
          break
        }
      }
      $pick = @($found | Where-Object { -not $_.Pre })[0]
      if (-not $pick) { $pick = @($found)[0] }
      if (-not $pick) { throw "No release of $repo has an Orivon installer for Windows yet." }
      if ($pick.Digest -notmatch '^[0-9a-fA-F]{64}$') { throw "GitHub reports no SHA-256 for the $($pick.Tag) installer." }
      $tag = $pick.Tag

      Say "Downloading Orivon $tag ..."
      $installer = Join-Path $work 'Orivon-Setup.exe'
      try { Invoke-WebRequest -Uri $pick.Url -OutFile $installer -UseBasicParsing } catch { throw 'The download failed.' }
      $actual = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
      if ($actual -ne $pick.Digest.ToUpperInvariant()) {
        Remove-Item -LiteralPath $installer -Force
        throw 'The download does not match the SHA-256 GitHub reports for it. Nothing was installed.'
      }
      Say 'Checked the SHA-256.'
    }

    $installArgs = @('/S')
    # NSIS reads /D= to the end of the line, so it comes last and is not quoted.
    if ($env:ORIVON_INSTALL_DIR) { $installArgs += "/D=$env:ORIVON_INSTALL_DIR" }
    Say 'Installing ...'
    # The installer process alone: -Wait would also wait on the app it starts when it finishes.
    $process = Start-Process -FilePath $installer -ArgumentList $installArgs -PassThru
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "The installer exited with code $($process.ExitCode)." }

    $folder = if ($env:ORIVON_INSTALL_DIR) { $env:ORIVON_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Orivon' }
    $exe = Join-Path $folder 'Orivon.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "The installer put no Orivon.exe at $exe." }

    Say "Installed Orivon ($tag) at $folder"
    Say 'Run this command again at any time to update Orivon.'
    if ($env:ORIVON_NO_OPEN -ne '1' -and -not (Get-Process -Name Orivon -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $exe
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-Orivon
