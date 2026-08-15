# Issue tracker: GitHub

本仓库的问题与 PRD 统一记录在以下 GitHub Issues 中：

- 仓库：`Eclipseic1848/ChoiceMind`
- 地址：https://github.com/Eclipseic1848/ChoiceMind
- 命令行工具：GitHub CLI（`gh`）

在本地 Git 远程尚未配置时，命令应显式指定仓库：

```powershell
gh issue <command> -R Eclipseic1848/ChoiceMind
```

## 常用操作

- 创建 Issue：`gh issue create -R Eclipseic1848/ChoiceMind --title "..." --body "..."`
- 查看 Issue：`gh issue view <number> -R Eclipseic1848/ChoiceMind --comments`
- 列出 Issue：`gh issue list -R Eclipseic1848/ChoiceMind --state open`
- 评论：`gh issue comment <number> -R Eclipseic1848/ChoiceMind --body "..."`
- 添加标签：`gh issue edit <number> -R Eclipseic1848/ChoiceMind --add-label "..."`
- 移除标签：`gh issue edit <number> -R Eclipseic1848/ChoiceMind --remove-label "..."`
- 关闭 Issue：`gh issue close <number> -R Eclipseic1848/ChoiceMind --comment "..."`

需要结构化读取时，使用 `--json` 和 `--jq`，并同时读取标签与评论。

## 将 Pull Request 作为 triage 请求入口

**PRs as a request surface: no.**

当前不把外部 Pull Request 自动纳入 Issue triage 队列。如需改变此约定，可将上面的值改为 `yes`。

GitHub 的 Issue 和 Pull Request 共用编号空间。遇到单独的 `#42` 时，应先确定其类型；可先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 技能操作约定

当技能要求“发布到问题追踪器”时，在 `Eclipseic1848/ChoiceMind` 中创建 GitHub Issue。

当技能要求“读取相关 ticket”时，运行：

```powershell
gh issue view <number> -R Eclipseic1848/ChoiceMind --comments
```

## Wayfinder 操作

- **Map**：一个带有 `wayfinder:map` 标签的 Issue，正文包含 Notes、Decisions-so-far 和 Fog。
- **Child ticket**：与 Map 关联的子 Issue，使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task` 标签。
- **阻塞关系**：优先使用 GitHub 原生 Issue dependency；不可用时，在子 Issue 正文顶部使用 `Blocked by: #<number>`。
- **Frontier**：从 Map 的未关闭子 Issue 中排除仍有开放阻塞项或已有负责人者，按 Map 中的顺序选择第一个。
- **Claim**：运行 `gh issue edit <number> -R Eclipseic1848/ChoiceMind --add-assignee @me`；这是工作过程中的第一次外部写入。
- **Resolve**：先发布结论评论，再关闭 Issue，最后把上下文链接添加到 Map 的 Decisions-so-far。
