[CmdletBinding()]
param(
  [string]$ProjectName = "choicemind-p004-accept"
)

$ErrorActionPreference = "Stop"
$composeFile = "deploy/compose/compose.yaml"
$composeArgs = @("-p", $ProjectName, "-f", $composeFile)
$acceptancePassword = [guid]::NewGuid().ToString("N")
$env:CHOICEMIND_POSTGRES_PASSWORD = $acceptancePassword
$env:CHOICEMIND_DATABASE_URL =
  "postgresql://choicemind:$acceptancePassword@postgres:5432/choicemind"
$env:CHOICEMIND_SYNTHETIC_USER_TOKEN = [guid]::NewGuid().ToString("N")
$env:CHOICEMIND_SYNTHETIC_OTHER_USER_TOKEN = [guid]::NewGuid().ToString("N")
$apiHeaders = @{ Authorization = "Bearer $env:CHOICEMIND_SYNTHETIC_USER_TOKEN" }
$started = $false
$acceptanceFailed = $false

function Wait-Api {
  param([int]$TimeoutSeconds = 120)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  do {
    try {
      $response = Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "http://127.0.0.1:3100/health/live" `
        -TimeoutSec 3

      if ($response.StatusCode -eq 200) {
        return
      }
    }
    catch {
      # 服务启动期间的连接失败由超时统一处理。
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  throw "API 健康检查超时"
}

function New-CommandBody {
  param(
    [string]$Suffix,
    [string]$SubmittedText
  )

  return @{
    contractType = "execute-decision-task-command"
    contractVersion = "1.0"
    executionRequestId = "exec-compose-$Suffix"
    requirementRevision = @{
      contractType = "requirement-revision"
      contractVersion = "1.0"
      requirementRevisionId = "req-compose-$Suffix-r1"
      decisionTaskId = "task-compose-$Suffix"
      revision = 1
      submittedText = $SubmittedText
      market = @{ country = "CN"; currency = "CNY"; locale = "zh-CN" }
      intendedUses = @("Compose 持久任务验收")
      mustHaves = @()
      niceToHaves = @()
      mustNotHaves = @()
      unknowns = @("budget.maxAmountMinor")
    }
  }
}

function Submit-Task {
  param(
    [string]$Suffix,
    [string]$SubmittedText
  )

  $body = New-CommandBody -Suffix $Suffix -SubmittedText $SubmittedText
  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -Method Post `
    -Uri "http://127.0.0.1:3100/api/v1/decision-tasks:execute" `
    -Headers $apiHeaders `
    -ContentType "application/json; charset=utf-8" `
    -Body ($body | ConvertTo-Json -Depth 10 -Compress) `
    -TimeoutSec 10

  if ($response.StatusCode -ne 202) {
    throw "任务 $Suffix 未返回 202"
  }

  $snapshot = $response.Content | ConvertFrom-Json

  if (
    $snapshot.contractType -ne "decision-task-snapshot" -or
    $snapshot.state -ne "ACCEPTED" -or
    $snapshot.terminal -ne $false
  ) {
    throw "任务 $Suffix 未返回非终态 ACCEPTED 快照"
  }

  return $snapshot
}

function Read-Task {
  param([string]$DecisionTaskId)

  return Invoke-RestMethod `
    -Method Get `
    -Uri "http://127.0.0.1:3100/api/v1/decision-tasks/$DecisionTaskId" `
    -Headers $apiHeaders `
    -TimeoutSec 10
}

function Get-TaskState {
  param($Payload)

  if (
    $Payload.contractType -eq "decision-task-result" -and
    $null -ne $Payload.taskStatus
  ) {
    return [string]$Payload.taskStatus.state
  }

  return [string]$Payload.state
}

function Wait-Completed {
  param(
    [string]$DecisionTaskId,
    [int]$TimeoutSeconds = 120
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  do {
    $payload = Read-Task -DecisionTaskId $DecisionTaskId
    $state = Get-TaskState -Payload $payload

    if ($state -eq "COMPLETED") {
      return $payload
    }

    if ($state -in @("FAILED_FINAL", "PARTIAL")) {
      throw "任务 $DecisionTaskId 进入非预期终态 $state"
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  throw "任务 $DecisionTaskId 等待 COMPLETED 超时"
}

try {
  $existingVolumes = & docker volume ls `
    --filter "label=com.docker.compose.project=$ProjectName" `
    -q

  if ($LASTEXITCODE -ne 0) {
    throw "无法读取 Compose 项目卷状态"
  }

  if ($existingVolumes) {
    throw "Compose 项目 $ProjectName 已有保留卷；请使用新的 -ProjectName 运行验收"
  }

  $existingContainers = & docker compose @composeArgs ps -a -q

  if ($LASTEXITCODE -ne 0) {
    throw "无法读取 Compose 项目状态"
  }

  if ($existingContainers) {
    throw "Compose 项目 $ProjectName 已有容器，拒绝覆盖"
  }

  $apiListeners = Get-NetTCPConnection `
    -State Listen `
    -LocalPort 3100 `
    -ErrorAction SilentlyContinue

  if ($apiListeners) {
    throw "端口 3100 已被占用"
  }

  Write-Output "ACCEPTANCE_PHASE=compose_up"
  & docker compose @composeArgs up `
    -d `
    postgres `
    redis `
    api `
    outbox-publisher `
    orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Compose 启动失败"
  }

  $started = $true
  Wait-Api
  & docker compose @composeArgs ps

  if ($LASTEXITCODE -ne 0) {
    throw "Compose 状态读取失败"
  }

  $runId = [guid]::NewGuid().ToString("N").Substring(0, 12)

  Write-Output "ACCEPTANCE_PHASE=normal_flow"
  $normal = Submit-Task `
    -Suffix "$runId-normal" `
    -SubmittedText "Compose 正常执行链路"
  $null = Wait-Completed -DecisionTaskId $normal.decisionTaskId
  Write-Output "NORMAL_FLOW=COMPLETED:$($normal.decisionTaskId)"

  Write-Output "ACCEPTANCE_PHASE=worker_and_api_restart"
  & docker compose @composeArgs stop orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Worker 失败"
  }

  $restart = Submit-Task `
    -Suffix "$runId-restart" `
    -SubmittedText "Worker 与 API 重启恢复"
  & docker compose @composeArgs restart api

  if ($LASTEXITCODE -ne 0) {
    throw "重启 API 失败"
  }

  Wait-Api
  $persisted = Read-Task -DecisionTaskId $restart.decisionTaskId
  $persistedState = Get-TaskState -Payload $persisted

  if ($persistedState -ne "ACCEPTED") {
    throw "API 重启后任务状态不是 ACCEPTED，而是 $persistedState"
  }

  Write-Output "API_RESTART_PERSISTED=${persistedState}:$($restart.decisionTaskId)"
  & docker compose @composeArgs start orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Worker 失败"
  }

  $null = Wait-Completed -DecisionTaskId $restart.decisionTaskId
  Write-Output "WORKER_RESTART_RECOVERY=COMPLETED:$($restart.decisionTaskId)"

  Write-Output "ACCEPTANCE_PHASE=publisher_restart"
  & docker compose @composeArgs stop outbox-publisher

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Publisher 失败"
  }

  $publisherRestart = Submit-Task `
    -Suffix "$runId-publisher" `
    -SubmittedText "Publisher 重启恢复"
  Start-Sleep -Seconds 2
  $publisherPending = Read-Task -DecisionTaskId $publisherRestart.decisionTaskId
  $publisherPendingState = Get-TaskState -Payload $publisherPending

  if ($publisherPendingState -ne "ACCEPTED") {
    throw "Publisher 停止期间任务状态不是 ACCEPTED，而是 $publisherPendingState"
  }

  & docker compose @composeArgs start outbox-publisher

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Publisher 失败"
  }

  $null = Wait-Completed -DecisionTaskId $publisherRestart.decisionTaskId
  Write-Output "PUBLISHER_RESTART_RECOVERY=COMPLETED:$($publisherRestart.decisionTaskId)"

  Write-Output "ACCEPTANCE_PHASE=redis_stream_loss"
  & docker compose @composeArgs stop orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Redis Stream 丢失前停止 Worker 失败"
  }

  $streamLoss = Submit-Task `
    -Suffix "$runId-stream-loss" `
    -SubmittedText "Redis Stream 丢失后的 Postgres 重投"
  $publishedDeadline = (Get-Date).AddSeconds(30)
  $publishedAt = $null

  do {
    $sql = @"
SELECT o.published_at IS NOT NULL
FROM outbox_messages o
JOIN agent_run_operations a ON a.operation_id = o.operation_id
WHERE a.execution_request_id = 'exec-compose-$runId-stream-loss';
"@
    $queryOutput = & docker compose @composeArgs exec `
      -T `
      postgres `
      psql `
      -U choicemind `
      -d choicemind `
      -Atc $sql

    if ($LASTEXITCODE -ne 0) {
      throw "读取已发布 Outbox 状态失败"
    }

    $publishedAt = $queryOutput | Where-Object { $_ -in @("t", "f") } | Select-Object -Last 1

    if ($publishedAt -eq "t") {
      break
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $publishedDeadline)

  if ($publishedAt -ne "t") {
    throw "任务未在 30 秒内形成已发布 Outbox"
  }

  $flushResult = & docker compose @composeArgs exec -T redis redis-cli FLUSHALL

  if ($LASTEXITCODE -ne 0 -or $flushResult -notcontains "OK") {
    throw "清空隔离 Redis Stream 失败"
  }

  & docker compose @composeArgs start orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Redis Stream 丢失后启动 Worker 失败"
  }

  $null = Wait-Completed `
    -DecisionTaskId $streamLoss.decisionTaskId `
    -TimeoutSeconds 180
  Write-Output "REDIS_STREAM_LOSS_RECOVERY=COMPLETED:$($streamLoss.decisionTaskId)"

  Write-Output "ACCEPTANCE_PHASE=redis_outage"
  & docker compose @composeArgs stop orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Redis 中断前停止 Worker 失败"
  }

  & docker compose @composeArgs stop redis

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Redis 失败"
  }

  $redisOutage = Submit-Task `
    -Suffix "$runId-redis" `
    -SubmittedText "Redis 中断后的 Outbox 恢复"
  $redisSnapshot = Read-Task -DecisionTaskId $redisOutage.decisionTaskId
  $redisState = Get-TaskState -Payload $redisSnapshot

  if ($redisState -ne "ACCEPTED") {
    throw "Redis 中断期间任务状态不是 ACCEPTED，而是 $redisState"
  }

  $attempts = 0
  $attemptDeadline = (Get-Date).AddSeconds(20)

  do {
    $sql = @"
SELECT o.attempts
FROM outbox_messages o
JOIN agent_run_operations a ON a.operation_id = o.operation_id
WHERE a.execution_request_id = 'exec-compose-$runId-redis';
"@
    $queryOutput = & docker compose @composeArgs exec `
      -T `
      postgres `
      psql `
      -U choicemind `
      -d choicemind `
      -Atc $sql

    if ($LASTEXITCODE -ne 0) {
      throw "读取 Outbox 重试次数失败"
    }

    $numericLine = $queryOutput |
      Where-Object { $_ -match '^\d+$' } |
      Select-Object -Last 1

    if ($null -ne $numericLine) {
      $attempts = [int]$numericLine
    }

    if ($attempts -ge 1) {
      break
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $attemptDeadline)

  if ($attempts -lt 1) {
    throw "Redis 中断期间未观察到 Outbox 重试"
  }

  Write-Output `
    "REDIS_OUTAGE_OUTBOX_ATTEMPTS=${attempts}:$($redisOutage.decisionTaskId)"
  & docker compose @composeArgs start redis

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Redis 失败"
  }

  $redisDeadline = (Get-Date).AddSeconds(60)
  $redisPing = $null

  do {
    $redisPing = & docker compose @composeArgs exec `
      -T `
      redis `
      redis-cli ping `
      2>$null

    if ($LASTEXITCODE -eq 0 -and $redisPing -contains "PONG") {
      break
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $redisDeadline)

  if ($redisPing -notcontains "PONG") {
    throw "Redis 恢复健康超时"
  }

  & docker compose @composeArgs start orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Redis 恢复后启动 Worker 失败"
  }

  $null = Wait-Completed `
    -DecisionTaskId $redisOutage.decisionTaskId `
    -TimeoutSeconds 150
  Write-Output "REDIS_OUTAGE_RECOVERY=COMPLETED:$($redisOutage.decisionTaskId)"

  Write-Output "ACCEPTANCE_PHASE=postgres_outage"
  $publisherContainerId = & docker compose @composeArgs ps -q outbox-publisher

  if ($LASTEXITCODE -ne 0 -or -not $publisherContainerId) {
    throw "无法读取 Publisher 容器身份"
  }

  $publisherRestartCountBefore = [int](& docker inspect `
      --format '{{.RestartCount}}' `
      $publisherContainerId)

  if ($LASTEXITCODE -ne 0) {
    throw "无法读取 Publisher 初始重启次数"
  }

  & docker compose @composeArgs stop postgres

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Postgres 失败"
  }

  $postgresOutageBody = New-CommandBody `
    -Suffix "$runId-postgres" `
    -SubmittedText "Postgres 中断期间失败关闭"
  $postgresSubmitResponse = Invoke-WebRequest `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -Method Post `
    -Uri "http://127.0.0.1:3100/api/v1/decision-tasks:execute" `
    -Headers $apiHeaders `
    -ContentType "application/json; charset=utf-8" `
    -Body ($postgresOutageBody | ConvertTo-Json -Depth 10 -Compress) `
    -TimeoutSec 15
  $postgresSubmitPayload = $postgresSubmitResponse.Content | ConvertFrom-Json

  if (
    $postgresSubmitResponse.StatusCode -ne 503 -or
    $postgresSubmitPayload.error.code -ne "PERSISTENCE_UNAVAILABLE"
  ) {
    throw "Postgres 中断期间提交未以 PERSISTENCE_UNAVAILABLE 失败关闭"
  }

  $postgresReadResponse = Invoke-WebRequest `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -Uri "http://127.0.0.1:3100/api/v1/decision-tasks/$($normal.decisionTaskId)" `
    -Headers $apiHeaders `
    -TimeoutSec 15

  if ($postgresReadResponse.StatusCode -ne 503) {
    throw "Postgres 中断期间读取未返回 503"
  }

  $publisherRestartDeadline = (Get-Date).AddSeconds(20)
  $publisherRestartCount = $publisherRestartCountBefore

  do {
    $publisherRestartCount = [int](& docker inspect `
        --format '{{.RestartCount}}' `
        $publisherContainerId)

    if (
      $LASTEXITCODE -eq 0 -and
      $publisherRestartCount -gt $publisherRestartCountBefore
    ) {
      break
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $publisherRestartDeadline)

  if ($publisherRestartCount -le $publisherRestartCountBefore) {
    throw "Postgres 中断期间未观察到 Publisher 失败并由 Compose 重启"
  }

  Write-Output "POSTGRES_OUTAGE_FAIL_CLOSED=503:PERSISTENCE_UNAVAILABLE"
  Write-Output "POSTGRES_OUTAGE_PUBLISHER_RESTARTS=$publisherRestartCount"
  & docker compose @composeArgs start postgres

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Postgres 失败"
  }

  $postgresDeadline = (Get-Date).AddSeconds(60)
  $postgresReady = $null

  do {
    $postgresReady = & docker compose @composeArgs exec `
      -T `
      postgres `
      pg_isready `
      -U choicemind `
      -d choicemind `
      2>$null

    if ($LASTEXITCODE -eq 0 -and $postgresReady -match "accepting connections") {
      break
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $postgresDeadline)

  if ($postgresReady -notmatch "accepting connections") {
    throw "Postgres 恢复健康超时"
  }

  & docker compose @composeArgs start outbox-publisher orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Postgres 恢复后启动后台消费者失败"
  }

  $postgresRecovery = Submit-Task `
    -Suffix "$runId-postgres-recovery" `
    -SubmittedText "Postgres 恢复后的完整执行"
  $null = Wait-Completed `
    -DecisionTaskId $postgresRecovery.decisionTaskId `
    -TimeoutSeconds 150
  $normalAfterPostgresRecovery = Read-Task -DecisionTaskId $normal.decisionTaskId

  if ((Get-TaskState -Payload $normalAfterPostgresRecovery) -ne "COMPLETED") {
    throw "Postgres 恢复后既有完成事实不可读"
  }

  Write-Output `
    "POSTGRES_OUTAGE_RECOVERY=COMPLETED:$($postgresRecovery.decisionTaskId)"

  & docker compose @composeArgs ps

  if ($LASTEXITCODE -ne 0) {
    throw "最终 Compose 状态读取失败"
  }

  Write-Output "COMPOSE_ACCEPTANCE=PASS"
}
catch {
  $acceptanceFailed = $true
  Write-Output "COMPOSE_ACCEPTANCE=FAIL:$($_.Exception.Message)"

  if ($started) {
    & docker compose @composeArgs logs `
      --no-color `
      --tail 120 `
      api `
      outbox-publisher `
      orchestrator-worker `
      postgres `
      redis
  }

  throw
}
finally {
  if ($started) {
    Write-Output "ACCEPTANCE_PHASE=compose_down_keep_volumes"
    & docker compose @composeArgs down
    $downExit = $LASTEXITCODE

    if ($downExit -ne 0 -and -not $acceptanceFailed) {
      throw "Compose 清理容器和网络失败"
    }
  }

  $env:CHOICEMIND_POSTGRES_PASSWORD = $null
  $env:CHOICEMIND_DATABASE_URL = $null
  $env:CHOICEMIND_SYNTHETIC_USER_TOKEN = $null
  $env:CHOICEMIND_SYNTHETIC_OTHER_USER_TOKEN = $null
}
