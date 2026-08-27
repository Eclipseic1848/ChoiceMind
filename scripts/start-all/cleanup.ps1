[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ParentProcessId,

    [Parameter(Mandatory = $true)]
    [string]$ApplicationPidPath
)

$ErrorActionPreference = 'SilentlyContinue'
$parentProcess = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
if ($null -ne $parentProcess) {
    Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $ApplicationPidPath -PathType Leaf) {
    $applicationProcessId = 0
    $applicationProcessIdText = (Get-Content -LiteralPath $ApplicationPidPath -Raw -Encoding ascii).Trim()
    if ([int]::TryParse($applicationProcessIdText, [ref]$applicationProcessId) -and $applicationProcessId -gt 0) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $applicationProcessId /T /F *> $null
    }
    Remove-Item -LiteralPath $ApplicationPidPath -Force -ErrorAction SilentlyContinue
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $repositoryRoot 'deploy\compose\compose.yaml'
$developmentComposeFile = Join-Path $repositoryRoot 'deploy\compose\compose.dev.yaml'

& docker compose --project-name choicemind-dev --file $composeFile --file $developmentComposeFile stop postgres redis *> $null
exit 0
