[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$Target = Join-Path $ReleaseRoot 'FPA-Portable'
$AppTarget = Join-Path $Target 'app'
$RuntimeTarget = Join-Path $Target 'runtime'
$DataTarget = Join-Path $Target 'data'
$ProjectData = Join-Path $ProjectRoot 'data'

Write-Host '[1/5] Building frontend...'
Push-Location $ProjectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally {
  Pop-Location
}

Write-Host '[2/5] Preparing portable directory (preserving data)...'
$MigrateData = -not (Test-Path -LiteralPath $DataTarget) -or -not (Get-ChildItem -LiteralPath $DataTarget -Force -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $MigrateData) {
  $ExistingFiles = @(Get-ChildItem -LiteralPath $DataTarget -File -Recurse -Force)
  if ($ExistingFiles.Count -eq 1 -and $ExistingFiles[0].Name -eq 'studio.json') {
    try {
      $ExistingDatabase = Get-Content -LiteralPath $ExistingFiles[0].FullName -Raw | ConvertFrom-Json
      $MigrateData = @($ExistingDatabase.assets).Count -eq 0 -and @($ExistingDatabase.jobs).Count -eq 0
    } catch {
      $MigrateData = $false
    }
  }
}
New-Item -ItemType Directory -Force -Path $ReleaseRoot, $Target | Out-Null
foreach ($managed in @($AppTarget, $RuntimeTarget)) {
  if (Test-Path -LiteralPath $managed) { Remove-Item -LiteralPath $managed -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $AppTarget, $RuntimeTarget, $DataTarget | Out-Null
if ($MigrateData -and (Test-Path -LiteralPath $ProjectData)) {
  foreach ($item in Get-ChildItem -LiteralPath $ProjectData -Force) {
    if ($item.Name -eq 'studio') {
      $StudioTarget = Join-Path $DataTarget 'studio'
      New-Item -ItemType Directory -Force -Path $StudioTarget | Out-Null
      Get-ChildItem -LiteralPath $item.FullName -Force |
        Where-Object { $_.Name -notin @('settings.json', 'design-settings.json', 'design-generation-settings.json', 'quiver-settings.json', 'typesafe-settings.json') } |
        Copy-Item -Destination $StudioTarget -Recurse -Force
    } else {
      Copy-Item -LiteralPath $item.FullName -Destination $DataTarget -Recurse
    }
  }
  Write-Host 'Existing library and history migrated; API settings were excluded.'
}

Write-Host '[3/5] Copying application files...'
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'dist') -Destination $AppTarget -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $AppTarget 'scripts'), (Join-Path $AppTarget 'src'), (Join-Path $AppTarget 'node_modules'), (Join-Path $AppTarget 'node_modules\@img') | Out-Null
foreach ($file in @('portable-server.mjs', 'studio-api.mjs', 'import-job-api.mjs', 'image-input.mjs', 'design-api.mjs', 'design-generation-api.mjs', 'design-output-settings.mjs', 'quiver-api.mjs', 'typesafe-search.mjs', 'asset-labels.mjs')) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "scripts\$file") -Destination (Join-Path $AppTarget 'scripts')
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src\output-settings.mjs') -Destination (Join-Path $AppTarget 'src')
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src\image-limits.mjs') -Destination (Join-Path $AppTarget 'src')
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src\asset-search.mjs') -Destination (Join-Path $AppTarget 'src')

$RuntimeModules = @(
  'sharp',
  'detect-libc',
  'semver'
)
foreach ($module in $RuntimeModules) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "node_modules\$module") -Destination (Join-Path $AppTarget 'node_modules') -Recurse
}
foreach ($module in @('colour', 'sharp-win32-x64')) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot "node_modules\@img\$module") -Destination (Join-Path $AppTarget 'node_modules\@img') -Recurse
}

Write-Host '[4/5] Copying Node runtime and documentation...'
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $RuntimeTarget 'node.exe')
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'portable\Start FPA Portable.bat') -Destination $Target
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'portable\README-portable.md') -Destination $Target
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'portable\portable-version.txt') -Destination $Target
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'LICENSE') -Destination $Target

Write-Host '[5/5] Verifying portable runtime...'
Push-Location $Target
try {
  & (Join-Path $RuntimeTarget 'node.exe') --input-type=module -e "import('./app/scripts/studio-api.mjs').then(() => console.log('FPA runtime OK'))"
  if ($LASTEXITCODE -ne 0) { throw 'Portable runtime verification failed.' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host "Portable package created: $Target"
Write-Host 'Existing data directory was preserved.'
