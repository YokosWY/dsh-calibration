# 变更记录

## 1.2.1 — 2026-10-24
- **收尾 1.2.0 的改名**：`clarify_tier` 的工具描述（每步都注入模型上下文的那段字）里还写着「极限」，与宿主 `LABELS` 的「极致」不一致；一并修掉两侧文件头注释
- **README 校准**：「已知边界」里「档位是全局的」「客户端 `BRIDGE` 写死 `43871`」两条与 1.2.0 代码相反（现在是按会话存 + 端口自动发现），重写；桥接端口写成区间 + 自动对齐
- **演示图**：`docs/demo.svg` 里 4 处「极限」改「极致」
- **package.json**：描述同步「极致」，版本 1.2.1
- **新增** `docs/release-notes.md`：1.0.0 起的发布说明正文，发版直接取用
- **一致性守则（新增 7 项测试）**：版本号与 CHANGELOG 首条同条、`files` 清单里的文件都存在、当前文案里不再出现旧名、工具描述与宿主档位表同字、skill 状态表同字、README「已知边界」不再回头写「全局/写死端口」、README 写的测试条数等于实际条数（31 → 38 就是它先报出来的）
- **本地 CI**：`npm run lint`（`node --check`）+ `npm run verify`（lint + test）；新增 `.github/workflows/ci.yml`，推上去后在 Node 22 / 24 各跑一遍
- 38 项测试全过（31 原有 + 7 守则）；除测试与脚本外只改文案，无行为变更

## 1.2.0 — 2026-10-24
- **端口自动避让**：宿主从 `43871` 起试到 `43880`，第一个能绑的即用；两套 DSH 同时开着不再互相顶掉
- **客户端自动发现**：按同区间探测 `/state` 的 `plugin` 标记，选中的端口存 localStorage；SSE 与读写都走发现结果
- **改名**：`极限` → `极致`（两种模式的最高档都叫极致）
- `/state` 增加 `plugin: "dsh-clarify-tier"` 标记，供发现用
- 测试 30 → 31 项：新增“端口被占时退到下一个 + 标记正确”

## 1.1.1 — 2026-10-24
- **线上验收通过**：轮 id = `19`，快照写入 `turn{id,mode,level}`；轮内改档后 `pending:true` 而工具仍读旧值
- 摘掉临时诊断（`phaseDiag` 与 `clarify-tier-turn.jsonl` 写入），代码回到干净状态
- 30 项测试全过；`/debug` 通道保留

## 1.1.0 — 2026-10-24
- **根因**：`exec.agent` 是带注入校验的 cordis 上下文代理，访问未声明属性会抛 `cannot get property "turnId" without inject`；旧代码把所有候选写成数组字面量一次性求值，整段落到 catch → turnId 恒为 null
- 改为**逐个候选惰性求值**，各自兜错；候选收敛为 `agent.phase.turn` 与 `exec.turnId` 两个已证实安全的读法
- 回归测试：用 Proxy 模拟“未知属性即抛错”的 agent，断言仍能取到 `phase.turn`
- 30 项测试全过

## 1.0.2 — 2026-10-24
- `turnIdFromExec` 逐候选追踪（写入 `clarify-tier-turn.jsonl`），定位“phaseTurn=17 但 turnId=null”

## 1.0.1 — 2026-10-24
- `readPhaseTurn`：兼容 `agent.phase` 是 getter / 函数 / 对象三种形状
- 加 `clarify-tier-turn.jsonl` 诊断：记录 phase 的类型/键/`turn` 值，定位“探针能看到、运行时取不到”的差异
- 其余不变

## 1.0.0 — 2026-10-24
- **轮 id 实测定案**：`agent.phase.turn`（探针实测 `{kind:"running", turn:15, step:1}`），轮内快照终于能落地
- 轮语义：同一 `phase.turn` 内只用开工时那份；`phase.turn` 变化即新一轮，自动换用当前值
- 移除临时工具 `debug_probe`（工具面回到 `clarify_tier` / `forge_level` 两个）
- 保留 `POST /debug` 诊断通道（客户端注册事件仍可查）
- 之前的调试链路全部留档：CORS（0.9.2）→ 插槽注册确认（0.9.3）→ 轮 id（1.0.0）

## 0.9.3 — 2026-10-24
- 客户端确认注册成功（`inject-fired` + `registered` → `conversation.input.right`）
- `debug_probe` 返回改成 JSON 安全（修 lossless JSON 报错），同时把探测结果写进宿主日志
- 轮 id 多候选：`exec.turnId` / `session.turn.id` / `agent.turn.id` / `loopCtx.turnId` / `loopCtx.turn.id` / `runtimeContext.turnId`
- 客户端诊断补 `ctx.sessions` 的键（判断能否由客户端标记轮起止）

## 0.9.2 — 2026-10-24
- **根因找到**：Web 客户端 Origin 是 `dsh-app://app`，被 Origin 白名单拒掉 → 所有 `/state`、`/events` 请求 CORS 失败，控件读到空数据
- Origin 白名单放行 `dsh-app:` 协议；其余规则不变（http/https 仍限本机）
- 诊断加码：上报 `ctx.slots` 的键、每个候选槽的 inject 是否真正触发
- `debug_probe` 加深：session.id / agent.id / phase / loopCtx / runtimeContext 的标量字段

## 0.9.1 — 2026-10-24（诊断版）
- 插槽候选回退：`conversation.input.right` → `.dock` → `.left`，谁存在用谁（NEXT 实际没有 right 的渲染点）
- 客户端诊断上报：apply / inject-call / registered / register-error 经 `POST /debug` 落到 `storages/clarify-tier-debug.jsonl`
- 新增临时工具 `debug_probe`：回传工具执行上下文（exec/agent/session/turn）字段名，用于定位 turn id
- 结论目标：确认插槽注册是否发生 + 拿到真正的轮 id 字段

## 0.9.0 — 2026-10-24
- **改成每轮快照**（替掉 0.8 的「整对话锁死」）：一条用户消息 = 一轮；开工第一次调工具时把当时档位记进 `turn{id,mode,level}`，本轮内不再变
- 轮内点档位条：正常写盘（不 409、不置灰），只影响下一轮；`/state` 与 SSE 返回 `pending`，条尾显示琥珀小点提示「下轮生效」
- 轮 id 取 `exec.agent.session.turn.id`；取不到时退回实时值（`turnLocked:false`），不阻塞
- 删除 `unlock_tier`：不再需要解锁动作
- 测试 29 项：轮内冻结、轮间生效、pending 标记、无轮 id 降级、会话隔离、迁移与安全全保留

## 0.8.0 — 2026-10-24
- **开始即锁**：本对话第一次调工具时把当时的档位冻住（`lockedAt`），之后整轮都不变，防误点
- 锁定期间点档位条：宿主回 `409 locked`，客户端弹红框提示并拉回真值；档位不变
- 新增 `unlock_tier`：只解本对话的锁，解完再点才生效（用户明说要改档时才调）
- 锁定按对话隔离：别的对话照常能改；`default` 永远不锁（兜底与继承源）
- GET `/state` 与 SSE 帧增加 `locked` 字段；客户端 `data-locked` 显示「锁」标记与禁止光标
- 测试 30 项：首次工具调用落锁、409 拒绝、解锁可再改、跨会话不受影响、default 不锁

## 0.7.0 — 2026-10-24
- **每个对话各用各的**：状态从「一个全局档位」改成 `{ schema: 6, sessions: { sessionId: {mode, level} } }`
- 会话键：客户端走插槽注入的 `sessionId`（`/state?session=`、`/events?session=`）；工具走 `exec.agent.session.id`，读不到才落 `default`
- SSE 按会话分流：同一对话的两个窗口互通，跨对话互不打扰
- 新对话没设置过时继承 `default`（迁移自 0.6 的全局值），再回落到 `think/high`；会话表上限 100，删最旧的非 default
- localStorage 键按会话分开（`dsh-tier-mode:<sessionId>`），断网时也不会串档
- 测试 28 项：会话隔离、工具按 exec 会话读、SSE 不跨会话、迁移、安全、数据安全全保留

## 0.6.0 — 2026-10-24
- **服务器推送**：新增 `GET /events`（SSE）。连上先推当前状态，之后每次成功写入广播给所有窗口；25 秒心跳保活，断线由浏览器按 `retry: 2000` 自动重连
- 客户端订阅 SSE：其他窗口改档后立即跟上；坏帧丢弃不抛错；`EventSource` 不可用时退回原来的「切窗口重新对齐」
- 订阅者随连接关闭清理，服务关闭时统一断开，心跳定时器 `unref`
- 测试 26 → 29：两个订阅者收到同一广播帧、跨站 SSE 403、客户端收到推送落本地 + 坏帧容错
- README 补实时同步说明，删掉「没有服务端推送」的旧限制

## 0.5.4 — 2026-10-23
- **堵住降级覆盖**：迁移判定加 schema 门槛——只有「没有 schema」或 `schema < 5` 的老文件才迁移；`{schema:6, forge:"max"}` 这种未来版本带旧字段的文件不再被降级写成 `schema:5`
- **修一处自引入回归**：POST body 是 `null` / 数字 / 字符串 / 数组时，`"mode" in patch` 抛 TypeError 会打断连接；现在先判对象，标量与坏 JSON 一律 400
- **测试 23 → 26**：未来 schema 带 tier/forge 不降级、标量 body 四种形态 400 且宿主仍可服务、focus 刷新注册（此前 effect cleanup 把监听拆了，测不到）
- 文档同步测试数量与覆盖范围

## 0.5.3 — 2026-10-23
- **读不再毁数据**：坏 JSON、未知 schema（`schema:6`）、字段坏文件一律只读兜底（`corrupt` / `unsupported` / `sanitized`），不再一次 GET 就把用户设置冲成默认；迁移前写 `.bak`，落盘改临时文件 + `rename`
- **写失败不谎报**：磁盘不可写时 POST 返 500（`write failed`），此前返回 200 但没写进去
- **非法值 400**：`mode` / `level` 不在枚举内直接拒绝，不再 200 吞掉
- **旧窗覆盖**：客户端只提交变化的那一维（切模式不动档位），切回窗口时重新对齐宿主状态
- **测试 23 项**：补坏文件/未知 schema/字段坏/写失败 500/预检 403/null Origin/子域伪装/只提交单维/`/state` 文案优先；去掉 300ms 魔法等待和测试间顺序依赖
- **文档**：README 补「数据安全」节，改正端口与降级语义（降级时本地仍换档、不回写宿主）

## 0.5.2 — 2026-10-23
- **安全**：回环桥不再接受任意站点写入。带 Origin 的请求只放行本机（127.0.0.1 / localhost / ::1），否则 403 且不回显 ACAO；POST 必须是 `application/json`（415）。修前实测：任意网页 POST 能改档位，响应头是 `Access-Control-Allow-Origin: *`
- **测试入库**：`test/` + `npm test`（node --test，18 项），覆盖状态迁移、两个工具投影、跨站 403、本机回显、四格结构与两套标签；桥 `unref()` 让测试进程自然退出
- **单一事实源**：档名 / 悬停表只在宿主定义，客户端从 `/state` 的 `labels`、`titles` 读；离线兜底由测试断言与宿主逐字一致
- **文档**：`docs/demo.svg` 从五格旧图重画成两行四格；README 补「安全边界」「测试」两节；`files` 补 `skill/`、`docs/`、`CHANGELOG.md`、安装器；加 `engines.node>=22`
- 状态 schema 不变（仍 `5`）

## 0.5.1 — 2026-10-23
- **全部档名收成二字**：思考 `关闭 / 严格 / 极限`、循环 `轻量 / 交付 / 极限`，与插件 0.2.7 起的二字悬停风格一致；四格宽度对齐
- 文案润色：悬停改成「档名 + 一句代价」，去掉「严 / 极 / 轻」这类单字缩写；工具返回文案同步
- 无状态变更（`schema:5` 不动），老档位值不需要迁移
- 测试：标签断言同步更新，宿主 + 客户端全过

## 0.5.0 — 2026-10-23
- **一框双模式**：四条控件收成一条 —`关 | 严 | 极 ‖ 循环`↔`轻 | 交付 | 极限 ‖ 循环`；右侧「循环」用隔离线分开，是模式开关不是第四档
- 思考档收成三档 `off / high / max`（删 `low`：收益太低）；循环档三档 `轻 / 交付 / 极限` = 3 / 5 / 8 轮
- 状态模型换成 `{ mode, level, schema: 5 }`；老 `{tier, forge}` 自动迁移（forge=std/max → 循环模式；tier=low → 严）
- 工具改成同一状态的两个投影：思考模式 `forge_level=off`；循环模式 `clarify_tier=off`
- 配套 `clarify-needs` 升 v5.0（三档），`loop-forge` 升 0.2.0（`std`→`high`，新增 `lite`）
- 测试：宿主 8 项（含迁移、模式/档位合并写、两个投影）+ 客户端 vm 冒烟

## 0.4.0 — 2026-10-23
- **双开关**：在需求锚定条右侧新增「循环锻造」分段条 `off / 标准 / 极限`，两条同槽（order 10 / 11），琥珀色表示第二条
- 宿主状态文件改成**合并式写入**：`{ tier, forge }` 共用一个文件，写其中一个不冲掉另一个
- 新增工具 `forge_level`：返回 `off / std / max` + 轮次上限（0 / 5 / 8）+ 评审方式，供 `loop-forge` 技能读取
- 配套技能 `loop-forge`（判据先行 → 每轮报数 → 自动下一轮 → 自动止损），装在 `D:\AI\Skills\mine\loop-forge`
- 兼容：老宿主只回 `tier` 时，锻造条保持本地值且不显示降级标记
- 测试：宿主集成测试 7 项 + 客户端 vm 冒烟测试全过（见 `D:\Documents\deepseek-harness\default-workspace\tmp\loop-forge-test`）

## 0.3.2 — 2026-10-23
- **再加强一档**：每档再加一件硬产出——常规 +假设清单(≤3)；严格 +前置检查表；极限 +对抗复审(≥3 条反对意见) +止损线
- 新增两条全局闸门：**缺件即未达标**（该档产出少一件不许动手）、**交付前回勾**（按验收标准逐条 ✓/✗）
- 技能 v4.2；AGENTS 与 README 同步

## 0.3.1 — 2026-10-23
- **档位强度整体调高**（用户：不调高察觉不到差异），每档加"必须交出的东西"：
  - 常规：+ 一句风险提示「最可能出岔子的是 X，出了按 Y 处理」
  - 严格：+ 回滚方案 + 验收标准 + 失败分支表
  - 极限：+ 每分支反例与代价 + 对抗自检（3 条前提逐条找反证）
- 技能同步 v4.1；AGENTS 与 README 同步

## 0.3.0 — 2026-10-23
- **档位收成四档**：删除 `low`（原「方向」），其余依次降级 —— 原 high→**low 常规**、原 max→**high 严格**、原 ultra→**max 极限**
- 默认档 `high` → **`low`**；悬停双字词改为 关闭 / 常规 / 严格 / 极限
- 状态文件加 `schema: 4`，读到时自动迁移旧值（high→low、max→high、ultra→max、low→off），一次性落盘
- 技能同步到 v4.0（SKILL/README/design/roadmap）
- 理由：多档利用率太低，中间那档几乎没人拨，留着只增加定档成本

## 0.2.7 — 2026-10-23
- 悬停只留前缀（关闭 / 轻量 / 常规 / 严格 / 极限），去掉后面的解释

## 0.2.6 — 2026-10-23
- 悬停文案统一成**双字词**：关闭 / 轻量 / 常规 / 严格 / 极限

## 0.2.5 — 2026-10-23
- 悬停文案改为**思考强度**刻度：关闭 / 轻 / 中 / 严 / 极限，各自一句话说明想到哪一步

## 0.2.4 — 2026-10-23
- 技能：**档位不进对话**——不写「档位 X」、不标首行、不复述档名；只靠行为体现（复述长短 / 确认点数量 / 是否弹窗）
- 背景：用户明确「档位 ultra · 落地」这类标记不要出现在回复里

## 0.2.3 — 2026-10-23
- 技能：**要问就用弹窗**——`ask_user_question` 多题打包一次，正文不再写问句、不堆 ❓ 列表
- 技能：**能不问就不问**——能按推荐答案安全推进的直接做并标「假设：…」，不为确认中断会话
- 背景：用户反馈「问句塞在正文里太啰嗦」

## 0.2.2 — 2026-10-23
- 技能：**解除提问次数/轮次上限**，判停改为「还有没有会改变执行的未知」；只问会做错的决策，能自己查的事实不占额度
- 技能：新增「档位必须看得见」表（各档第一条输出的固定形状）；档位标注只在 **max / ultra** 首行
- 背景：滑条装上后模型从没调过 `clarify_tier`，档位等于没装——根因是「若可用」这种软约束

## 0.2.0 — 2026-10-23
- **迁入技能 `clarify-needs`**（原在 token-governance 仓库，v0.11.1 起迁出）：仓库现在是「插件 + 技能」两半
  - 技能路径 `skill/clarify-needs/`，装法见 README（复制或 junction 到技能目录）
  - 五档命名统一为：静默 / 方向 / 约束 / 落地 / 拷问
- README 增加两半说明与技能安装段

## 0.1.3 — 2026-10-23
- 移除界面截图 `docs/preview.png`（改由 `docs/demo.svg` 演示）；README 同步去掉该图

## 0.1.2 — 2026-10-23
- README 加徽章（release / license / platform / node）
- 加安装演示动图 `docs/demo.svg`（五档循环点亮，无需截图）

## 0.1.1 — 2026-10-23
- 修：客户端 bundle id 用包名（含 scope），否则 client-modules 二次执行导致 web boot 失败
- 修：宿主 `export const inject = ["tools"]`，否则 `ctx.tools` 不可访问、`clarify_tier` 静默不注册

## 0.1.0 — 2026-10-23
- 首版：输入框工具行分段条（off / low / high / max / ultra）+ 宿主状态桥 + clarify_tier 工具
