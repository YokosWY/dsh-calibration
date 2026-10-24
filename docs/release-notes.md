# 发布说明正文

> GitHub Release 直接取用。更早版本（0.1.0–1.1.1）的逐条记录见 `CHANGELOG.md`。
> 写法约定：只写机制、范围、限制、数字；不写形容词与口号。

## v1.4.2 — 端口退让的日志与 chosenPort

**问题**：两套 DSH 同开时，后启动的那套会退让到下一个端口。但同一个 `http.Server` 上重试 `listen()` 时，前一次失败那回的 listen 回调也会被一起触发，于是日志里同时出现「就绪 43871」和「就绪 43872」——43871 其实是别的实例占着，`chosenPort` 也会被短暂写错。

**修法**

- 以 `server.address().port` 为准：实际绑上哪个端口才记「桥接就绪」，其余回调直接返回。
- 单端口 EADDRINUSE 不再打「控件会退化为只读」（那句只在 10 个端口全占时才成立）；运行期错误另走「桥接错误」。

**验证**：48 项测试（新增 1 项：退让成功时「桥接就绪」只出现一次、且写的是真绑上的端口），并确认回退该修复时这条测试会红。无行为变更。

## v1.4.1 — 档位标准收敛到三档

**本次改动**

- `clarify-needs` 的 `README.md` 与 `docs/design.md` 从四档（`off/low/high/max`）收敛到三档（`off/high/max`，关闭 / 严格 / 极致，默认严格）。技能本体 `SKILL.md` 早就是三档，这两个文件落后一版；而档位条只有三格，留一个拨不到的「常规」等于教模型读不存在的档。
- 原「常规」的三样（复述 / 2 个确认点 / 假设清单 ≤3）并入严格档；定档评分改成 `0=off / 1–2=high / ≥3=max`；地板改成「会改文件 / 配置 / 系统的任务最低 high」；技能版本记 v5.0。
- 两份 `AGENTS.md`（官方 DSH 与 NEXT 各一份，内容必须逐字相同）§0 同步：`off/high/max` 三档、最高档叫「极致」、工具读不到时按 `high`。
- 新增守则：`skill/clarify-needs/` 的档位表必须与宿主 `LEVELS` 完全一致——这类「文档多一档」的漂移以后会直接测试失败。

**验证**：`npm run verify` 通过，47 项测试（新增 1 项档位表守则）。两份 `AGENTS.md` md5 相同。

**升级**：技能目录是 junction 的话改完立即生效（不用重启）；插件的客户端 / 宿主行为未变。

## v1.4.0 — 宿主拆模块，对外不变

**本次改动**

- 宿主从单文件 693 行拆成五个模块：`index.js`（装配：起桥 + 注册工具 + dispose）、`core.js`（常量、档位文案表、会话键清洗、广播总线）、`state.js`（状态读写与迁移，坏文件只读兜底）、`bridge.js`（HTTP + SSE + 端口退让）、`tools.js`（`clarify_tier` / `forge_level` 与轮内快照）。
- 对外导出不变：`apply`、`inject`、`TIER_LABELS`、`TIER_TITLES`、`publicState`、`turnIdFromExec`、`sessionFromExec`、`originAllowed` 仍旧从 `lib/index.js` 取。
- 广播改成总线（`setBroadcaster` / `emit`）：桥与工具不再互相 import。
- 客户端**仍是单文件**：模块加载器只吃一个 factory，拆成 import 会直接起不来；内部的重复落值逻辑已收成 `applyState()`。
- `npm run lint` 换成 `scripts/check.mjs`：遍历 `lib` 与 `test` 下所有文件逐个 `node --check`，不再手写文件名。
- `package.json` 的 `files` 改成目录（`lib/`、`scripts`），并加了一道守则：`lib` 下每个模块都必须被 `files` 覆盖，漏加会测试失败。

**验证**：`npm run verify` 通过，46 项测试（新增 1 项 files 覆盖守则），语法检查 10 个文件。

**升级**：完全退出 DSH 再打开。这次不发新行为，回滚装回 1.3.0 的 `lib/` 即可。

## v1.3.0 — 少一次请求，断线能自己回来

**本次改动**

- **点一次档只发一个 POST**：宿主在 POST `/state` 的响应里直接回带 `mode/level/pending/turnLocked`，客户端不再补 GET。老宿主（1.2.0 及以前）不回 `pending`，客户端自动退回「POST + GET」，行为不变。
- **端口发现退避**：一轮 10 个端口全探空后记下时间，3 秒内点击不再重扫（原来每次交互都要打 10 个 fetch）；挂载时 `pull` 与 SSE 并发要端口，改为同一时刻只跑一轮发现。
- **端口缓存会作废**：GET 拿到非 2xx（端口上是别的实例）、网络错误、SSE 彻底断开，都清掉缓存的端口，下次重新发现。原来宿主重启换了端口，客户端会一直指着旧端口。
- **SSE 断线重建**：`readyState=2` 时浏览器不再自己重连，客户端按 `CONFIG.reconnectDelay`（默认 2 秒）重建，最多 `CONFIG.maxReconnects`（默认 3）次，收到消息即重置计数。
- **诊断默认关**：不再每次启动往 `clarify-tier-debug.jsonl` 追加事件（文件不轮转）。要抓注册链路时执行 `localStorage.setItem("dsh-tier-debug","1")` 再刷新，用完删掉。
- 客户端三处重复的落值逻辑收成 `applyState()`；容器 title 由 `barTitle()` 统一生成，离线与「下一轮生效」同时成立时两句话都写。

**验证**：`npm run verify` 通过，45 项测试，约 4 秒（新增 7 项：端口退避与去重、POST 带回状态不补 GET、老宿主补 GET、SSE 重建上限、诊断闸门、title 双状态、POST 响应带 `turnLocked`）。

**升级**：完全退出 DSH 再打开。

## v1.2.1 — 文案收尾

**修什么**

- `clarify_tier` 的工具描述还写着「关闭/严格/极限」，而宿主档位表已是「极致」——这段字每步都注入模型上下文，改名没走完。现已一致。
- README「已知边界」有两条与代码相反：档位早已按会话存（`schema: 6, sessions`），客户端也不必手工对齐端口（1.2.0 起自动发现）。已重写。
- `docs/demo.svg` 4 处、`lib/` 两侧文件头注释、`package.json` 描述里的「极限」全部改「极致」。
- 测试条数从 README 写的 29 修正为实际的 31（1.2.1 收尾后为 38）。

**加了几道守则**：新增 `test/consistency.test.mjs`（7 项）盯版本号与 CHANGELOG 同条、`files` 清单文件都在、当前文案不出现旧名、工具描述与宿主档位表同字、skill 状态表同字、README「已知边界」不再回头写「全局/写死端口」、README 写的测试条数等于实际条数。本地跑 `npm run verify`（`node --check` + 全部测试），推上去后由 `.github/workflows/ci.yml` 在 Node 22 / 24 各跑一遍。

**验证**：`npm run verify` 通过，38 项测试，约 3.6 秒。除测试与脚本外只改文案与注释，无行为变更。

## v1.2.0 — 端口自动避让与发现

**形态**

```text
思考：  关闭 | 严格 | 极致  ‖ 循环
循环：  轻量 | 交付 | 极致  ‖ 循环（亮）
```

右侧「循环」是模式开关，不是第四档；切过去后前三格从「问多深」变成「磨几轮」（3 / 5 / 8），配色由紫转琥珀。

**本次改动**

- 宿主端口在 `43871–43880` 里试绑，第一个能绑的即用；两套 DSH 同时开着不再互相顶掉。
- `/state` 增加 `plugin: "dsh-clarify-tier"` 标记；客户端按同区间探测该标记，选中端口写入 localStorage（`dsh-tier-port`），SSE 与读写都走发现结果。
- 最高档统一叫「极致」（原「极限」）。
- 测试 30 → 31：新增「端口被占时退到下一个 + 标记正确」。

**通道**

| 接口 / 工具 | 用途 |
|---|---|
| `clarify_tier` | 读思考档；循环模式下返回 `off` |
| `forge_level` | 读循环档；思考模式下返回 `off` |
| `GET /state?session=` | 读会话状态（带 `plugin` 标记） |
| `POST /state?session=` | 写会话状态，只写传来的维度 |
| `GET /events?session=` | SSE，按会话分流 |
| `POST /debug` | 客户端注册事件诊断 |

**安全**：桥只绑 `127.0.0.1`；带 Origin 的请求只放行 `dsh-app://app` 与本机 http，其余 403 且不回显 ACAO；`POST` 必须 `application/json`，否则 415；坏 JSON / 未知 schema 只读兜底不覆写；迁移前留 `.bak`；落盘走临时文件 + rename；写盘失败返回 500。

**升级**：装好后**完全退出 DSH 再打开**（关窗口不算）。旧 `{tier, forge}` 状态自动迁移成 `default` 会话并保留 `.bak`。

**已知限制**：10 个端口全被占时控件退化为只读（可本地换档、不同步宿主）；状态文件单机单份，并发写以最后落盘为准；无 token 鉴权，同机进程可写；快照按轮，只影响当前这一轮。
