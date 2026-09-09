$ErrorActionPreference = 'Stop'
$expectedImage = 'sha256:866ebea5648adbc74fd4dfe345bdd057fe78329a2c986e4bbb7e28110c091768'
docker --context desktop-linux image inspect $expectedImage --format '{{.Id}}' 2>$null
if ($LASTEXITCODE -eq 0) { return }
# 缺少基础镜像时拒绝自动下载；构建器仍可能访问官方注册表元数据。
foreach ($baseImage in @(
    'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
    'python@sha256:9d7f287598e1a5a978c015ee176d8216435aaf335ed69ac3c38dd1bbb10e8d64'
)) {
    docker --context desktop-linux image inspect $baseImage --format '{{.Id}}' 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'CANDIDATE_SECRETS_BASE_IMAGE_MISSING' }
}
# 只组合固定工具；不运行候选，不放宽执行隔离权限，构建步骤断网。
docker --context desktop-linux build --network none --pull=false --provenance=false --build-arg SOURCE_DATE_EPOCH=0 --file (Join-Path $PSScriptRoot 'Dockerfile.secrets') $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'CANDIDATE_SECRETS_IMAGE_BUILD_FAILED' }
docker --context desktop-linux image inspect $expectedImage --format '{{.Id}}'
if ($LASTEXITCODE -ne 0) { throw 'CANDIDATE_SECRETS_IMAGE_MISMATCH' }
