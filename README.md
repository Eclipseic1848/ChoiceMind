# ChoiceMind 星枢智购

面向消费者的智能消费决策智能体。本仓库当前处于 P0 工程基线阶段，不包含支付、订单或物流功能。

## 本地开发

运行环境固定为 Node.js 22.22.1、pnpm 11.21.0 和 Python 3.14.6，并需要安装 `uv` 0.11.19。

```powershell
corepack pnpm install --frozen-lockfile
uv sync --frozen --project services/data-worker --group dev
corepack pnpm --filter @choicemind/web exec playwright install chromium
corepack pnpm dev
```

启动后可访问：

- Web 健康状态页：<http://127.0.0.1:3000>
- API 健康汇总：<http://127.0.0.1:3100/api/v1/system/health>
- 四个进程的存活端点分别位于 3000、3100、3200、3300 端口的 `/health/live`。

运行完整工程检查：

```powershell
corepack pnpm verify
```

## Linux Compose 基线

```bash
docker compose -f deploy/compose/compose.yaml config --quiet
docker compose -f deploy/compose/compose.yaml up --build
```

该 Compose 文件用于验证 Linux 容器化启动基线，不代表生产部署已经完成。
