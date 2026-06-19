param(
  [switch]$OpenFolder
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$workflow = "build-unsigned-ios-ipa.yml"
$repo = "HOLYAC/liquid-glass-capture"
$artifactName = "LiquidGlassCapture-unsigned-ipa"

gh auth status | Out-Null

$headSha = (git rev-parse origin/main).Trim()
Write-Host "Triggering $workflow on origin/main ($headSha)..."

$triggerOutput = gh workflow run $workflow --repo $repo --ref main 2>&1
$triggerText = $triggerOutput -join "`n"

if ($triggerText -notmatch "/runs/(\d+)") {
  Start-Sleep -Seconds 5
  $runsJson = gh run list --repo $repo --workflow $workflow --limit 10 --json databaseId,headSha,status,createdAt
  $run = $runsJson | ConvertFrom-Json | Where-Object { $_.headSha -eq $headSha } | Select-Object -First 1
  if (-not $run) {
    throw "Could not find a freshly triggered run for $headSha. gh output: $triggerText"
  }
  $runId = [string]$run.databaseId
} else {
  $runId = $Matches[1]
}

$runUrl = "https://github.com/$repo/actions/runs/$runId"
Write-Host "Run: $runUrl"
gh run watch $runId --repo $repo --interval 15 --exit-status

$runInfo = gh run view $runId --repo $repo --json conclusion,headSha,url | ConvertFrom-Json
if ($runInfo.conclusion -ne "success") {
  throw "Build failed: $($runInfo.url)"
}

$artifactRoot = Join-Path $RepoRoot "artifacts"
$targetDir = Join-Path $artifactRoot "ios-$runId"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

if (Test-Path $targetDir) {
  $resolvedTarget = Resolve-Path $targetDir
  if (-not $resolvedTarget.Path.StartsWith($artifactRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove outside artifact root: $($resolvedTarget.Path)"
  }
  Remove-Item -LiteralPath $resolvedTarget.Path -Recurse -Force
}

gh run download $runId --repo $repo --name $artifactName --dir $targetDir

$ipa = Get-ChildItem -Path $targetDir -Recurse -Filter "*.ipa" | Select-Object -First 1
if (-not $ipa) {
  throw "No IPA found in $targetDir"
}

$latestFile = Join-Path $artifactRoot "LATEST_IOS_IPA.txt"
Set-Content -Path $latestFile -Value @(
  "run=$runUrl"
  "headSha=$($runInfo.headSha)"
  "ipa=$($ipa.FullName)"
)

Write-Host "IPA: $($ipa.FullName)"
Write-Host "Wrote: $latestFile"

if ($OpenFolder) {
  Invoke-Item (Split-Path $ipa.FullName)
}
