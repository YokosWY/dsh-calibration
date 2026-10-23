# dsh-clarify-tier

[![release](https://img.shields.io/github/v/release/YokosWY/dsh-clarify-tier?color=7c6cf0)](https://github.com/YokosWY/dsh-clarify-tier/releases)
[![license](https://img.shields.io/github/license/YokosWY/dsh-clarify-tier?color=7c6cf0)](LICENSE)
[![platform](https://img.shields.io/badge/DSH-web%20client-7c6cf0)](#安装)
[![node](https://img.shields.io/badge/node-%E2%89%A522-7c6cf0)](package.json)

> 给 DSH 输入框加**一根框、两个模式**的档位条：
> `关 | 严 | 极 ‖ 循环`（思考）↔ `轻 | 交付 | 极限 ‖ 循环`（循环）。
> 拨档 → 模型通过 `clarify_tier` / `forge_level` 读到 → 决定开工问多深、交付后磨几轮。

![demo](docs/demo.svg)

## 一根框两个模式

```
思考：  [关] [严] [极] ‖ [循环]        ← 紫
循环：  [轻] [交付] [极限] ‖ [循环]亮   ← 琥珀
```

右侧「循环」用一条隔离线隔开，它是**模式开关**，不是第四档。
切到循环模式后，前三个格的含义从「问多深」变成「磨几轮」，标签和配色一起换。

| 模式 | 格 | 含义 | 模型读到 |
|---|---|---|---|
| 思考 | 关 | 不锚定、不循环 | `clarify_tier=off`、`forge_level=off` |
| 思考 | 严（默认） | 复述 + 2 确认点 + 回滚 + 验收 + 失败分支 | `clarify_tier=high` |
| 思考 | 极 | 严 + 反例与代价 + 对抗自检 + 对抗复审 | `clarify_tier=max` |
| 循环 | 轻 | 3 轮、纯自检（性价比） | `forge_level=lite` |
| 循环 | 交付 | 5 轮、第 2 轮独立评审 + 收敛复核 | `forge_level=high` |
| 循环 | 极限 | 8 轮、第 2 轮起每轮独立评审 | `forge_level=max` |

**为什么不叠两轴**：一根框放不下「问多深 × 磨几轮」四象限；循环模式下的轻量对齐交给 loop-forge 第 1 步的「定判据」，比再摆一条滑条更省。

## 状态模型

```json
{ "mode": "think" | "loop", "level": "off" | "high" | "max", "schema": 5 }
```

- `clarify_tier`：思考模式返回 `level`；循环模式返回 `off`（不叠加锚定）
- `forge_level`：思考模式返回 `off`；循环模式把 `off/high/max` 映射成 `lite/high/max` 与 3/5/8 轮
- 文件：`$DSH_HOME/storages/clarify-tier.json`，**合并式写入**，切模式不会丢档位

## 安装

需要：DSH Desktop / DSH NEXT（带 Web 客户端插件支持的版本）。

```powershell
pwsh -File install-profile.ps1             # 装进 desktop profile
pwsh -File install-profile.ps1 -Uninstall  # 卸载
```

脚本做三件事：往 profile 的 `package.json` 加一条 `link:` 依赖、把包名追加进 `dsh.profile.bundles`、
在 profile 的 `node_modules` 下建链接。装完**完全退出并重开** DSH（关窗口不够，要退出进程）。

验证：输入框工具行、模型选择左边出现一条四格框，默认停在「严」；点最右「循环」，前三格变「轻 / 交付 / 极限」且转琥珀色。再问模型「现在什么档」，它应能调 `clarify_tier` / `forge_level` 报出同值。

## 工作原理

| 层 | 文件 | 职责 |
|---|---|---|
| 客户端 | `lib/client.js` | 四格框 + 模式切换，注册进 `conversation.input.right`（`order=10`） |
| 宿主 | `lib/index.js` | 合并式落盘、回环桥、`clarify_tier` 与 `forge_level` 两个只读工具 |
| 形态 | `cordis.patch.yml` + `package.json` 的 `dsh.client` | 进 cordis 树，客户端产物编进启动包 |

- 桥：`http://127.0.0.1:43871/state`（GET/POST，只绑回环，CORS `*`，端口可用 `DSH_CLARIFY_TIER_PORT` 改）
- 三条纪律：**fail-open**（注册失败只是控件不出现）、**不碰官方 DOM**、**不注入会话消息**

## 配套技能

| 技能 | 位置 | 作用 |
|---|---|---|
| clarify-needs | `skill/clarify-needs/` | 拿到思考档后怎么问：复述 / 确认点 / 设计树 / 共识摘要 |
| loop-forge | `D:\AI\Skills\mine\loop-forge`（junction 到技能目录） | 拿到循环档后怎么磨：判据 → 每轮报数 → 自动下一轮 → 自动止损 |

```powershell
cmd /c mklink /J "D:\AI\DSH-NEXT\skills\loop-forge" "D:\AI\Skills\mine\loop-forge"
cmd /c mklink /J "D:\AI\DSH-NEXT\skills\clarify-needs" "%CD%\skill\clarify-needs"
```

## 已知边界

- 档位是**全局**的，不是每会话一份
- 桥接端口被占时，控件退化为只读（虚线边框 + `!`）
- 工具返回的是调用时刻的值；中途改档要再调一次
- 循环模式不叠加思考档：需要强提问就先退回思考模式

## 踩过的坑（别重犯）

| 坑 | 症状 | 正解 |
|---|---|---|
| 客户端 bundle 的 `id` 写成短名 | `duplicate factory registration` → `web boot: 1 entry did not activate` → GUI 起不来 | `id` 必须等于包名（含 `@scope`） |
| 宿主没声明 `inject` | `cannot get property "tools" without inject`，工具静默消失 | `export const inject = ["tools"]` |
| 两个开关写同一文件不做合并 | 切档把另一轴冲掉 | `writeState` 读旧值再合并 |

## 卸载

1. `install-profile.ps1 -Uninstall`
2. 删 `$DSH_HOME/storages/clarify-tier.json`
3. 重开应用

## License

MIT
