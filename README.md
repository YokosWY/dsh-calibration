# dsh-clarify-tier

[![release](https://img.shields.io/github/v/release/YokosWY/dsh-clarify-tier?color=7c6cf0)](https://github.com/YokosWY/dsh-clarify-tier/releases)
[![license](https://img.shields.io/github/license/YokosWY/dsh-clarify-tier?color=7c6cf0)](LICENSE)
[![platform](https://img.shields.io/badge/DSH-web%20client-7c6cf0)](#安装)
[![node](https://img.shields.io/badge/node-%E2%89%A522-7c6cf0)](package.json)

> 给 DSH 输入框加**一根框、两个模式**的档位条：
> `关闭 | 严格 | 极限 ‖ 循环`（思考）↔ `轻量 | 交付 | 极限 ‖ 循环`（循环）。
> 拨档 → 模型通过 `clarify_tier` / `forge_level` 读到 → 决定开工问多深、交付后磨几轮。

![demo](docs/demo.svg)

## 一根框两个模式

```
思考：  [关闭] [严格] [极限] ‖ [循环]        ← 紫
循环：  [轻量] [交付] [极限] ‖ [循环]亮     ← 琥珀
```

右侧「循环」用一条隔离线隔开，它是**模式开关**，不是第四档。
切到循环模式后，前三个格的含义从「问多深」变成「磨几轮」，标签和配色一起换。

| 模式 | 格 | 含义 | 模型读到 |
|---|---|---|---|
| 思考 | 关闭 | 不锚定、不循环，直接执行 | `clarify_tier=off`、`forge_level=off` |
| 思考 | 严格（默认） | 复述 + 2 确认点 + 回滚 + 验收 + 失败分支 | `clarify_tier=high` |
| 思考 | 极限 | 严格之上再加反例与代价、对抗自检、对抗复审 | `clarify_tier=max` |
| 循环 | 轻量 | 3 轮纯自检，适合小修小补 | `forge_level=lite` |
| 循环 | 交付 | 5 轮，第 2 轮独立评审 + 收敛复核 | `forge_level=high` |
| 循环 | 极限 | 8 轮，第 2 轮起每轮独立评审 | `forge_level=max` |

**为什么不叠两轴**：一根框放不下「问多深 × 磨几轮」四象限；循环模式下的轻量对齐交给 loop-forge 第 1 步的「定判据」，比再摆一条滑条更省。

## 状态模型（每个对话各用各的）

```json
{
  "schema": 6,
  "sessions": {
    "<sessionId>": { "mode": "think" | "loop", "level": "off" | "high" | "max", "updatedAt": "…" }
  }
}
```

- **会话键**：客户端用插槽 inject 给的 `sessionId`，经 `?session=` 传给桥；工具用 `exec.agent.session.id`，读不到才落 `default`
- `clarify_tier`：思考模式返回 `level`；循环模式返回 `off`（不叠加锚定）
- `forge_level`：思考模式返回 `off`；循环模式把 `off/high/max` 映射成 `lite/high/max` 与 3/5/8 轮
- **每轮快照**：一条用户消息 = 一轮。开工第一次调工具时，把当时的档位记成本轮快照（`turn.id + mode + level`）；本轮内再点档位条只改「下轮的值」，并在条子尾部显示一个琥珀小点（`pending`）
- 下一轮开工自动换用新值；取不到轮 id 时退回实时值（不做轮内保护，但功能不坏）
- 没单独设置过的对话，继承 `default` 会话（迁移自 0.6 的全局值），再没有就用内置 `think/high`
- 文件：`$DSH_HOME/storages/clarify-tier.json`；每会话只写自己那条，切模式不会丢档位；最多保留 100 个会话（删最旧的非 `default`）
- **实时同步**：`GET /events?session=…` 只推本会话；同一对话开两个窗口才互通，跨对话互不干扰；断线按 `retry: 2000` 自动重连

## 安装

需要：DSH Desktop / DSH NEXT（带 Web 客户端插件支持的版本）。

```powershell
pwsh -File install-profile.ps1             # 装进 desktop profile
pwsh -File install-profile.ps1 -Uninstall  # 卸载
```

脚本做三件事：往 profile 的 `package.json` 加一条 `link:` 依赖、把包名追加进 `dsh.profile.bundles`、
在 profile 的 `node_modules` 下建链接。装完**完全退出并重开** DSH（关窗口不够，要退出进程）。

验证：输入框工具行、模型选择左边出现一条四格框，默认停在「严格」；点最右「循环」，前三格变「轻量 / 交付 / 极限」且转琥珀色。再问模型「现在什么档」，它应能调 `clarify_tier` / `forge_level` 报出同值。

## 工作原理

| 层 | 文件 | 职责 |
|---|---|---|
| 客户端 | `lib/client.js` | 四格框 + 模式切换，注册进 `conversation.input.right`（`order=10`） |
| 宿主 | `lib/index.js` | 合并式落盘、回环桥、`clarify_tier` 与 `forge_level` 两个只读工具 |
| 形态 | `cordis.patch.yml` + `package.json` 的 `dsh.client` | 进 cordis 树，客户端产物编进启动包 |

- 桥：`http://127.0.0.1:43871/state`（GET/POST）与 `/events`（SSE）；只绑回环，端口可用 `DSH_CLARIFY_TIER_PORT` 改
- 档名 / 悬停 / 轮次表只在宿主定义一次，客户端从 `/state` 的 `labels`、`titles` 读；离线兜底文案由测试锁死与宿主一致
- 三条纪律：**fail-open**（注册失败只是控件不出现）、**不碰官方 DOM**、**不注入会话消息**

## 安全边界

桥只绑 `127.0.0.1`，并且：

- **带 Origin 的请求只放行本机页面**（`127.0.0.1` / `localhost` / `::1`），其余返回 403，且不回显 `Access-Control-Allow-Origin`
- 无 Origin 的请求（curl、测试、本地脚本）照常放行
- **POST 必须是 `application/json`**，挡掉 `text/plain` 这类绕过预检的简单请求
- 没有 token 鉴权：**同机其它进程仍可写**。这台机器上的信任边界就是本机，够用但不防本机恶意程序

## 测试

```bash
npm test     # node --test，29 项，约 4 秒
```

覆盖：状态默认值、模式/档位合并写、非法值 400、标量与坏 JSON 400、两种老 schema 迁移 + `.bak`、坏 JSON 与未知 schema 不覆写（含「未来 schema 带 tier/forge」也不降级）、字段坏只保留能认的一半、两个工具投影、跨站 Origin 403（读/写/预检/null/子域伪装）、本机 Origin 回显 204、`text/plain` 415、写盘失败 500、SSE 首帧与写入广播（两个订阅者收同一帧）、跨站 SSE 403、四格结构、两套标签、循环格亮起、只提交变化维度、focus 重新对齐、SSE 推送落本地与坏帧容错、`/state` 文案优先、兜底文案与宿主表逐字一致、琥珀样式与隔离线。

## 配套技能

| 技能 | 位置 | 作用 |
|---|---|---|
| clarify-needs | `skill/clarify-needs/` | 拿到思考档后怎么问：复述 / 确认点 / 设计树 / 共识摘要 |
| loop-forge | `D:\AI\Skills\mine\loop-forge`（junction 到技能目录） | 拿到循环档后怎么磨：判据 → 每轮报数 → 自动下一轮 → 自动止损 |

```powershell
cmd /c mklink /J "D:\AI\DSH-NEXT\skills\loop-forge" "D:\AI\Skills\mine\loop-forge"
cmd /c mklink /J "D:\AI\DSH-NEXT\skills\clarify-needs" "%CD%\skill\clarify-needs"
```

## 数据安全

- **读不出来不覆写**：坏 JSON / 未知 schema（如未来的 `schema:6`）只返回默认值并标 `corrupt` / `unsupported`，原文件原样保留
- **迁移前留备份**：旧的 `{tier, forge}` 迁移时先写 `clarify-tier.json.bak`
- **原子写**：临时文件 + `rename`，避免写到一半断电留下半截 JSON
- **写失败不谎报**：磁盘不可写时 POST 返回 500（`error: write failed`），不返回 200

## 已知边界

- 档位是**全局**的，不是每会话一份
- 桥接端口被占时，控件退化为只读（虚线边框 + `!`）：本地点击仍然换档，但**不会同步到宿主**，重启后按宿主里的值走
- `DSH_CLARIFY_TIER_PORT` 只改宿主端口；客户端 `BRIDGE` 写死 `43871`，改端口要两边一起改
- 工具返回的是调用时刻的值；中途改档要再调一次
- 循环模式不叠加思考档：需要强提问就先退回思考模式
- 多窗口实时同步：SSE 推送，同一对话两窗同时改动以最后落盘为准；SSE 不可用时退回「切窗口重新对齐」
- 快照是**按轮**的：只影响「我这一轮用什么」，不改你拨出来的值；别的对话互不影响

## 踩过的坑（别重犯）

| 坑 | 症状 | 正解 |
|---|---|---|
| 客户端 bundle 的 `id` 写成短名 | `duplicate factory registration` → `web boot: 1 entry did not activate` → GUI 起不来 | `id` 必须等于包名（含 `@scope`） |
| 宿主没声明 `inject` | `cannot get property "tools" without inject`，工具静默消失 | `export const inject = ["tools"]` |
| 两个开关写同一文件不做合并 | 切档把另一轴冲掉 | `writeState` 读旧值再合并 |
| 把「读不到」当成「要重置」 | 一次 GET 就把用户设置冲成默认 | 坏文件/未知 schema 只读兜底，迁移才写盘 |

## 卸载

1. `install-profile.ps1 -Uninstall`
2. 删 `$DSH_HOME/storages/clarify-tier.json`
3. 重开应用

## License

MIT
