[CmdletBinding()]
param(
  [string]$ProjectName = "choicemind-p005-accept"
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
$otherApiHeaders = @{ Authorization = "Bearer $env:CHOICEMIND_SYNTHETIC_OTHER_USER_TOKEN" }
$started = $false
$acceptanceFailed = $false
$webBaseUrl = "http://127.0.0.1:3000"
$apiBaseUrl = "http://127.0.0.1:3100"

function Wait-HttpOk {
  param(
    [string]$Uri,
    [string]$Name,
    [int]$TimeoutSeconds = 120
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3

      if ($response.StatusCode -eq 200) {
        return
      }
    }
    catch {
      # 容器启动期间的连接失败由总超时统一处理。
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  throw "$Name 健康检查超时"
}

function New-CommandBody {
  param(
    [string]$Suffix,
    [string]$SubmittedText
  )

  return @{
    contractType = "execute-decision-task-command"
    contractVersion = "1.0"
    executionRequestId = "exec-p005-compose-$Suffix"
    requirementRevision = @{
      contractType = "requirement-revision"
      contractVersion = "1.0"
      requirementRevisionId = "req-p005-compose-$Suffix-r1"
      decisionTaskId = "task-p005-compose-$Suffix"
      revision = 1
      submittedText = $SubmittedText
      market = @{ country = "CN"; currency = "CNY"; locale = "zh-CN" }
      intendedUses = @("P0-05 Compose 事件验收")
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
    [string]$SubmittedText,
    [string]$BaseUrl = $webBaseUrl
  )

  $body = New-CommandBody -Suffix $Suffix -SubmittedText $SubmittedText
  $path = if ($BaseUrl -eq $webBaseUrl) {
    "/api/decision-tasks/execute"
  } else {
    "/api/v1/decision-tasks:execute"
  }
  $response = Invoke-WebRequest `
    -UseBasicParsing `
    -Method Post `
    -Uri "$BaseUrl$path" `
    -Headers $apiHeaders `
    -ContentType "application/json; charset=utf-8" `
    -Body ($body | ConvertTo-Json -Depth 10 -Compress) `
    -TimeoutSec 15

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
    -Uri "$webBaseUrl/api/decision-tasks/$DecisionTaskId" `
    -TimeoutSec 15
}

function Get-TaskState {
  param($Payload)

  if ($Payload.contractType -eq "decision-task-result" -and $null -ne $Payload.taskStatus) {
    return [string]$Payload.taskStatus.state
  }

  return [string]$Payload.state
}

function Wait-Completed {
  param(
    [string]$DecisionTaskId,
    [int]$TimeoutSeconds = 150
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

function Read-SseEvents {
  param(
    [string]$DecisionTaskId,
    [string]$AfterCursor = ""
  )

  $curlArgs = @(
    "-sS",
    "-N",
    "--max-time",
    "3",
    "-H",
    "Accept: text/event-stream"
  )

  if ($AfterCursor.Length -gt 0) {
    $curlArgs += @("-H", "Last-Event-ID: $AfterCursor")
  }

  $curlArgs += "$webBaseUrl/api/decision-tasks/$DecisionTaskId/events"
  $output = & curl.exe @curlArgs 2>$null
  $curlExit = $LASTEXITCODE

  if ($curlExit -notin @(0, 28)) {
    throw "读取 SSE 失败，curl exit=$curlExit"
  }

  return @(
    $output |
      Where-Object { $_ -like "data: *" } |
      ForEach-Object { $_.Substring(6) | ConvertFrom-Json }
  )
}

function Assert-EventHistory {
  param(
    [object[]]$Events,
    [string]$DecisionTaskId
  )

  if ($Events.Count -lt 3) {
    throw "任务 $DecisionTaskId 的持久事件少于 3 条"
  }

  $previousCursor = [System.Numerics.BigInteger]::Zero

  for ($index = 0; $index -lt $Events.Count; $index += 1) {
    $persistedEvent = $Events[$index]
    $cursor = [System.Numerics.BigInteger]::Parse([string]$persistedEvent.cursor)

    if ($cursor -le $previousCursor) {
      throw "任务 $DecisionTaskId 的 Postgres 游标不严格递增"
    }

    if (
      $persistedEvent.contractType -ne "persisted-run-event" -or
      $persistedEvent.contractVersion -ne "1.0" -or
      $persistedEvent.event.decisionTaskId -ne $DecisionTaskId -or
      $persistedEvent.event.sequence -ne ($index + 1)
    ) {
      throw "任务 $DecisionTaskId 的持久事件合同或关联身份无效"
    }

    $eventFields = @($persistedEvent.event.PSObject.Properties.Name | Sort-Object)
    $allowedFields = @(
      "agentRunId",
      "contractType",
      "contractVersion",
      "decisionTaskId",
      "eventId",
      "eventType",
      "occurredAt",
      "sequence",
      "summary",
      "synthetic",
      "taskState"
    ) | Sort-Object

    if ((Compare-Object $eventFields $allowedFields).Count -ne 0) {
      throw "任务 $DecisionTaskId 的公开事件包含合同外字段"
    }

    $previousCursor = $cursor
  }
}

function Wait-Redis {
  $deadline = (Get-Date).AddSeconds(60)

  do {
    $ping = & docker compose @composeArgs exec -T redis redis-cli ping 2>$null

    if ($LASTEXITCODE -eq 0 -and $ping -contains "PONG") {
      return
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  throw "Redis 恢复健康超时"
}

function Wait-Postgres {
  $deadline = (Get-Date).AddSeconds(60)

  do {
    $ready = & docker compose @composeArgs exec `
      -T postgres pg_isready -U choicemind -d choicemind 2>$null

    if ($LASTEXITCODE -eq 0 -and $ready -match "accepting connections") {
      return
    }

    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  throw "Postgres 恢复健康超时"
}

try {
  $existingVolumes = & docker volume ls --filter "label=com.docker.compose.project=$ProjectName" -q

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

  foreach ($port in @(3000, 3100)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
      throw "端口 $port 已被占用"
    }
  }

  Write-Output "ACCEPTANCE_PHASE=compose_up"
  & docker compose @composeArgs up `
    -d `
    --build `
    postgres `
    redis `
    api `
    outbox-publisher `
    orchestrator-worker `
    web

  if ($LASTEXITCODE -ne 0) {
    throw "Compose 启动失败"
  }

  $started = $true
  Wait-HttpOk -Uri "$apiBaseUrl/health/live" -Name "API"
  Wait-HttpOk -Uri "$webBaseUrl/health/live" -Name "Web"
  $root = Invoke-WebRequest -UseBasicParsing -Uri $webBaseUrl -TimeoutSec 10

  if ($root.Content -notmatch "智能消费决策") {
    throw "Web 首页未渲染 P0 决策入口"
  }

  $runId = [guid]::NewGuid().ToString("N").Substring(0, 12)

  Write-Output "ACCEPTANCE_PHASE=normal_web_api_worker_flow"
  $normal = Submit-Task -Suffix "$runId-normal" -SubmittedText "P0-05 正常 Web API Worker 流"
  $normalResult = Wait-Completed -DecisionTaskId $normal.decisionTaskId
  $events = @(Read-SseEvents -DecisionTaskId $normal.decisionTaskId)
  Assert-EventHistory -Events $events -DecisionTaskId $normal.decisionTaskId

  $otherTaskRead = Invoke-WebRequest `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -Uri "$apiBaseUrl/api/v1/decision-tasks/$($normal.decisionTaskId)" `
    -Headers $otherApiHeaders `
    -TimeoutSec 15
  $otherEventRead = Invoke-WebRequest `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -Uri "$apiBaseUrl/api/v1/decision-tasks/$($normal.decisionTaskId)/events" `
    -Headers $otherApiHeaders `
    -TimeoutSec 15

  if ($otherTaskRead.StatusCode -ne 404 -or $otherEventRead.StatusCode -ne 404) {
    throw "第二个测试用户能够读取第一个用户的任务或事件"
  }

  Write-Output "USER_ISOLATION=PASS:TASK=404:EVENTS=404"

  if ($normalResult.runEvents.Count -ne $events.Count) {
    throw "终态结果与持久 SSE 事件数量不一致"
  }

  Write-Output "NORMAL_FLOW=COMPLETED:$($normal.decisionTaskId):EVENTS=$($events.Count)"

  Write-Output "ACCEPTANCE_PHASE=last_event_id_replay"
  $afterCursor = [string]$events[1].cursor
  $replayed = @(Read-SseEvents -DecisionTaskId $normal.decisionTaskId -AfterCursor $afterCursor)

  if ($replayed.Count -ne ($events.Count - 2)) {
    throw "Last-Event-ID 未只补发游标之后的事件"
  }

  if ([string]$replayed[0].cursor -ne [string]$events[2].cursor) {
    throw "Last-Event-ID 补发起点不正确"
  }

  Write-Output "LAST_EVENT_ID_REPLAY=PASS:AFTER=${afterCursor}:COUNT=$($replayed.Count)"

  Write-Output "ACCEPTANCE_PHASE=web_api_worker_restart"
  & docker compose @composeArgs stop orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Worker 失败"
  }

  $restart = Submit-Task -Suffix "$runId-restart" -SubmittedText "P0-05 三进程重启恢复"
  & docker compose @composeArgs restart web api

  if ($LASTEXITCODE -ne 0) {
    throw "重启 Web/API 失败"
  }

  Wait-HttpOk -Uri "$apiBaseUrl/health/live" -Name "API"
  Wait-HttpOk -Uri "$webBaseUrl/health/live" -Name "Web"

  if ((Get-TaskState -Payload (Read-Task -DecisionTaskId $restart.decisionTaskId)) -ne "ACCEPTED") {
    throw "Web/API 重启后未恢复 ACCEPTED 权威状态"
  }

  & docker compose @composeArgs start orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Worker 失败"
  }

  $null = Wait-Completed -DecisionTaskId $restart.decisionTaskId
  $restartEvents = @(Read-SseEvents -DecisionTaskId $restart.decisionTaskId)
  Assert-EventHistory -Events $restartEvents -DecisionTaskId $restart.decisionTaskId
  Write-Output "PROCESS_RESTART_RECOVERY=COMPLETED:$($restart.decisionTaskId)"

  Write-Output "ACCEPTANCE_PHASE=redis_outage_and_flush"
  & docker compose @composeArgs stop redis

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Redis 失败"
  }

  & docker compose @composeArgs restart api

  if ($LASTEXITCODE -ne 0) {
    throw "Redis 中断后重启 API 失败"
  }

  Wait-HttpOk -Uri "$apiBaseUrl/health/live" -Name "API"
  $redisOutageReplay = @(
    Read-SseEvents -DecisionTaskId $normal.decisionTaskId -AfterCursor ([string]$events[0].cursor)
  )

  if ($redisOutageReplay.Count -ne ($events.Count - 1)) {
    throw "Redis 中断期间未从 Postgres 完整补发事件"
  }

  & docker compose @composeArgs start redis

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Redis 失败"
  }

  Wait-Redis
  $flush = & docker compose @composeArgs exec -T redis redis-cli FLUSHALL

  if ($LASTEXITCODE -ne 0 -or $flush -notcontains "OK") {
    throw "清空隔离 Redis 失败"
  }

  & docker compose @composeArgs restart api outbox-publisher orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Redis 清空后重启事件相关进程失败"
  }

  Wait-HttpOk -Uri "$apiBaseUrl/health/live" -Name "API"
  $afterFlush = @(Read-SseEvents -DecisionTaskId $normal.decisionTaskId)
  Assert-EventHistory -Events $afterFlush -DecisionTaskId $normal.decisionTaskId
  Write-Output "REDIS_OUTAGE_POSTGRES_REPLAY=PASS:EVENTS=$($afterFlush.Count)"

  Write-Output "ACCEPTANCE_PHASE=postgres_outage"
  & docker compose @composeArgs stop postgres

  if ($LASTEXITCODE -ne 0) {
    throw "停止 Postgres 失败"
  }

  $outageBody = New-CommandBody -Suffix "$runId-postgres" -SubmittedText "Postgres 中断失败关闭"
  $submitFailure = Invoke-WebRequest `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -Method Post `
    -Uri "$apiBaseUrl/api/v1/decision-tasks:execute" `
    -Headers $apiHeaders `
    -ContentType "application/json; charset=utf-8" `
    -Body ($outageBody | ConvertTo-Json -Depth 10 -Compress) `
    -TimeoutSec 15
  $submitFailureBody = $submitFailure.Content | ConvertFrom-Json

  if (
    $submitFailure.StatusCode -ne 503 -or
    $submitFailureBody.error.code -ne "PERSISTENCE_UNAVAILABLE"
  ) {
    throw "Postgres 中断期间提交未以 PERSISTENCE_UNAVAILABLE 失败关闭"
  }

  $readFailure = Invoke-WebRequest `
    -UseBasicParsing `
    -SkipHttpErrorCheck `
    -Uri "$apiBaseUrl/api/v1/decision-tasks/$($normal.decisionTaskId)" `
    -Headers $apiHeaders `
    -TimeoutSec 15

  if ($readFailure.StatusCode -ne 503) {
    throw "Postgres 中断期间读取未返回 503"
  }

  Write-Output "POSTGRES_OUTAGE_FAIL_CLOSED=503:PERSISTENCE_UNAVAILABLE"
  & docker compose @composeArgs start postgres

  if ($LASTEXITCODE -ne 0) {
    throw "重新启动 Postgres 失败"
  }

  Wait-Postgres
  & docker compose @composeArgs restart api outbox-publisher orchestrator-worker

  if ($LASTEXITCODE -ne 0) {
    throw "Postgres 恢复后重启后台进程失败"
  }

  Wait-HttpOk -Uri "$apiBaseUrl/health/live" -Name "API"

  if ((Get-TaskState -Payload (Read-Task -DecisionTaskId $normal.decisionTaskId)) -ne "COMPLETED") {
    throw "Postgres 恢复后既有完成事实不可读"
  }

  $recoveredEvents = @(Read-SseEvents -DecisionTaskId $normal.decisionTaskId)
  Assert-EventHistory -Events $recoveredEvents -DecisionTaskId $normal.decisionTaskId
  Write-Output "POSTGRES_OUTAGE_RECOVERY=PASS:EVENTS=$($recoveredEvents.Count)"
  Write-Output "COMPOSE_ACCEPTANCE=PASS"
}
catch {
  $acceptanceFailed = $true
  Write-Output "COMPOSE_ACCEPTANCE=FAIL:$($_.Exception.Message)"

  if ($started) {
    & docker compose @composeArgs logs `
      --no-color `
      --tail 160 `
      web `
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
