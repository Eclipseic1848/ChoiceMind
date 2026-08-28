[CmdletBinding()]
param(
    [Alias('preflight-only')]
    [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('错误：缺少必需命令：node。请安装项目要求的 Node.js 后重试。')
    exit 1
}

$packageManifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
$requiredNodeVersion = [string]$packageManifest.engines.node
$actualNodeVersion = (& node --version).Trim().TrimStart('v')

if ($actualNodeVersion -ne $requiredNodeVersion) {
    [Console]::Error.WriteLine("错误：Node.js 版本不匹配：需要 $requiredNodeVersion，当前为 $actualNodeVersion。请使用 fnm 切换后重试。")
    exit 1
}

foreach ($commandName in @('pnpm', 'uv', 'docker')) {
    if ($null -eq (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        [Console]::Error.WriteLine("错误：缺少必需命令：$commandName。请按 README 的本地开发要求安装后重试。")
        exit 1
    }
}

$requiredPnpmVersion = ([string]$packageManifest.packageManager).Split('@')[-1]
$actualPnpmVersion = (& pnpm --version).Trim()

if ($actualPnpmVersion -ne $requiredPnpmVersion) {
    [Console]::Error.WriteLine("错误：pnpm 版本不匹配：需要 $requiredPnpmVersion，当前为 $actualPnpmVersion。请使用 Corepack 切换后重试。")
    exit 1
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('错误：Docker Engine 不可用。请启动 Docker Desktop 后重试。')
    exit 1
}

& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('错误：Docker Compose 不可用。请安装支持 compose 子命令的 Docker Desktop。')
    exit 1
}

$concurrentlyCommand = Join-Path $RepositoryRoot 'node_modules\.bin\concurrently.cmd'
if (-not (Test-Path -LiteralPath $concurrentlyCommand -PathType Leaf)) {
    [Console]::Error.WriteLine('错误：项目依赖尚未安装。请在仓库根目录执行 pnpm install 后重试。')
    exit 1
}

$servicePorts = [ordered]@{
    'Web' = 3000
    'API' = 3100
    'Orchestrator' = 3200
    'Data Worker' = 3300
    'PostgreSQL' = 5432
    'Redis' = 6379
}

foreach ($serviceName in $servicePorts.Keys) {
    $port = $servicePorts[$serviceName]
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    try {
        $listener.Start()
    }
    catch {
        [Console]::Error.WriteLine("错误：$serviceName 端口 $port 已被占用。请停止占用该端口的程序后重试。")
        exit 1
    }
    finally {
        $listener.Stop()
    }
}

Write-Output "依赖检查：Node.js $actualNodeVersion、pnpm $actualPnpmVersion、uv、Docker Compose 均可用"
Write-Output 'Web：http://127.0.0.1:3000'
Write-Output 'API：http://127.0.0.1:3100'
Write-Output 'Orchestrator：http://127.0.0.1:3200'
Write-Output 'Data Worker：http://127.0.0.1:3300'
Write-Output '退出时停止本次基础服务，PostgreSQL 与 Redis 数据卷保留。'

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    [Console]::Error.WriteLine('错误：LOCALAPPDATA 不可用，无法安全保存本地开发数据库凭据。')
    exit 1
}

if ($PreflightOnly) {
    Write-Output 'ChoiceMind 启动前检查通过。'
    exit 0
}

$developmentStateDirectory = Join-Path $env:LOCALAPPDATA 'ChoiceMind\development'
$databasePasswordPath = Join-Path $developmentStateDirectory 'postgres-password.txt'
New-Item -ItemType Directory -Path $developmentStateDirectory -Force | Out-Null

function Get-OrCreateLocalSecret {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $secret = (Get-Content -LiteralPath $Path -Raw -Encoding ascii).Trim()
    }
    else {
        $secretBytes = New-Object byte[] 24
        $randomNumberGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $randomNumberGenerator.GetBytes($secretBytes)
        }
        finally {
            $randomNumberGenerator.Dispose()
        }
        $secret = -join ($secretBytes | ForEach-Object { $_.ToString('x2') })
        Set-Content -LiteralPath $Path -Value $secret -Encoding ascii -NoNewline
    }

    if ([string]::IsNullOrWhiteSpace($secret)) {
        throw "本地开发凭据文件为空：$Path"
    }

    return $secret
}

$databasePassword = Get-OrCreateLocalSecret -Path $databasePasswordPath

$env:CHOICEMIND_POSTGRES_PASSWORD = $databasePassword
$env:CHOICEMIND_DATABASE_URL = "postgres://choicemind:$databasePassword@127.0.0.1:5432/choicemind"
$env:CHOICEMIND_REDIS_URL = 'redis://127.0.0.1:6379'
$env:CHOICEMIND_IDENTITY_MODE = 'persistent'
$composeFile = Join-Path $RepositoryRoot 'deploy\compose\compose.yaml'
$developmentComposeFile = Join-Path $RepositoryRoot 'deploy\compose\compose.dev.yaml'
$applicationPidPath = Join-Path $developmentStateDirectory "start-all-$PID.pid"

function Stop-LocalInfrastructure {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'SilentlyContinue'
        & docker compose --project-name choicemind-dev --file $composeFile --file $developmentComposeFile stop postgres redis *> $null
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

Write-Output '正在启动 PostgreSQL 与 Redis…'
& docker compose --project-name choicemind-dev --file $composeFile --file $developmentComposeFile up --detach --wait postgres redis
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('错误：PostgreSQL/Redis 基础服务启动失败。请查看上方 Docker Compose 输出。')
    Stop-LocalInfrastructure
    exit 1
}

$healthUrls = [ordered]@{
    'Web' = 'http://127.0.0.1:3000/health/live'
    'API' = 'http://127.0.0.1:3100/health/live'
    'Orchestrator' = 'http://127.0.0.1:3200/health/live'
    'Data Worker' = 'http://127.0.0.1:3300/health/live'
}
$applicationProcess = $null
$scriptExitCode = 0

try {
        Write-Output '正在启动应用服务；日志统一显示在当前窗口，并带有 contracts/conversation/identity/web/api/api-publisher/identity-lifecycle/orchestrator/orchestrator-worker/data-worker 前缀。'
    $processStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processStartInfo.FileName = $env:ComSpec
    $processStartInfo.Arguments = '/d /c "pnpm.cmd dev"'
    $processStartInfo.WorkingDirectory = $RepositoryRoot
    $processStartInfo.UseShellExecute = $false
    $processStartInfo.CreateNoWindow = $false
    $applicationProcess = [System.Diagnostics.Process]::new()
    $applicationProcess.StartInfo = $processStartInfo
    if (-not $applicationProcess.Start()) {
        throw '无法创建 pnpm dev 应用进程。'
    }
    Set-Content -LiteralPath $applicationPidPath -Value $applicationProcess.Id -Encoding ascii -NoNewline

    $cleanupScript = Join-Path $PSScriptRoot 'cleanup.ps1'
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $cleanupArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$cleanupScript`" -ParentProcessId $PID -ApplicationPidPath `"$applicationPidPath`""
    Start-Process -FilePath $windowsPowerShell -ArgumentList $cleanupArguments -WindowStyle Hidden | Out-Null

    $healthDeadline = [DateTime]::UtcNow.AddSeconds(90)
    $unhealthyServices = @($healthUrls.Keys)

    while ([DateTime]::UtcNow -lt $healthDeadline) {
        $applicationProcess.Refresh()
        if ($applicationProcess.HasExited) {
            $applicationProcess.WaitForExit()
            $childExitCode = $applicationProcess.ExitCode
            $scriptExitCode = if ($childExitCode -eq 0) { 1 } else { $childExitCode }
            throw "应用进程在健康检查完成前退出（退出码 $childExitCode）。请查看上方带服务名前缀的日志。"
        }

        $unhealthyServices = @()
        foreach ($serviceName in $healthUrls.Keys) {
            try {
                $response = Invoke-WebRequest -Uri $healthUrls[$serviceName] -UseBasicParsing -TimeoutSec 1
                if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
                    $unhealthyServices += $serviceName
                }
            }
            catch {
                $unhealthyServices += $serviceName
            }
        }

        if ($unhealthyServices.Count -eq 0) {
            break
        }

        Start-Sleep -Seconds 1
    }

    if ($unhealthyServices.Count -ne 0) {
        $scriptExitCode = 1
        throw "等待服务健康检查超时；仍未就绪：$($unhealthyServices -join '、')。"
    }

    Write-Output 'ChoiceMind Alpha 已启动，前端开发热更新已启用。按 Ctrl+C 可停止本次启动。'
    foreach ($serviceName in $healthUrls.Keys) {
        Write-Output "$serviceName 健康：$($healthUrls[$serviceName])"
    }
    Write-Output 'API Publisher 后台进程：运行中（由 pnpm dev 进程组监护）'
    Write-Output 'Identity Lifecycle Worker 后台进程：运行中（由 pnpm dev 进程组监护）'
    Write-Output 'Orchestrator Worker 后台进程：运行中（由 pnpm dev 进程组监护）'

    $applicationProcess.WaitForExit()
    $scriptExitCode = $applicationProcess.ExitCode
}
catch {
    [Console]::Error.WriteLine("错误：$($_.Exception.Message)")
    if ($scriptExitCode -eq 0) {
        $scriptExitCode = 1
    }
}
finally {
    try {
        if ($null -ne $applicationProcess) {
            $applicationProcess.Refresh()
            if (-not $applicationProcess.HasExited) {
                $previousErrorActionPreference = $ErrorActionPreference
                try {
                    $ErrorActionPreference = 'SilentlyContinue'
                    & "$env:SystemRoot\System32\taskkill.exe" /PID $applicationProcess.Id /T /F *> $null
                }
                finally {
                    $ErrorActionPreference = $previousErrorActionPreference
                }
            }
        }
    }
    catch {
        [Console]::Error.WriteLine("警告：应用子进程清理未完全成功：$($_.Exception.Message)")
    }
    finally {
        Remove-Item -LiteralPath $applicationPidPath -Force -ErrorAction SilentlyContinue
        Write-Output '正在停止本次启动的 PostgreSQL 与 Redis；数据卷继续保留…'
        Stop-LocalInfrastructure
    }
}

exit $scriptExitCode
