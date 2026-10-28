# 变更记录

## 3.3.0 — 2026-10-28
- **免费线名单可配**：内置 `FREE_LINE_PROVIDERS` 只是默认值，`calibration-models.json` 顶层加 `providers` 即可增删，不用改代码也不用等发版：
  ```json
  { "providers": { "buddy": false, "my-free-channel": true } }
  ```
  `false` 摘掉内置项、`true` 加新渠道；名单按文件 `mtime+size` 缓存失效，改完下一个请求就生效（与 `models` 覆盖同一份文件）。单项 `free` 仍优先于名单。
- **为什么不做自动识别**：宿主 `llm` 只暴露 `LlmProviderInfo { id, name }` 与 `LlmModelInfo { provider, id, name, description?, inputModalities? }`，**没有任何价格/免费元数据**（已核 `app.asar` 内的类型声明），所以「谁免费」只能靠名单 + 人工覆盖。
- 测试 132 → 133（新增：providers 增删生效、删配置回落默认、scoreRoute 跟随名单）。

## 3.2.3 — 2026-10-28
- **修：免费线在同分时抢走自动挑模型**。实测 `state.agent.profile = efficiency` 时自动挑到 `buddy/deepseek-v4-flash`（`dsh-our-free-model` 的 WorkBuddy 免费线），子代理启动成功、运行期静默失败（无收尾消息）。根因不是能力分，而是同族同分（`deepseek-v4-flash` 与官方同分 8）时按 `provider:model` 字典序，`buddy` 排在最前。
- 改法：`scoreRoute` 给免费线打 `free` 标记（`core.js` 的 `FREE_LINE_PROVIDERS`），`better()` 在**同分时**把免费线排后——能力分更高照样能选中，不是无条件封杀；手动点名不受影响；`calibration-models.json` 里 `{ models: { "provider/model": { free: true|false } } }` 可单条覆盖。
- 名单只收名字够独特的渠道，`minimax` / `gemini` / `zcode` 这类可能与正规 provider 撞名的故意不收。
- 测试 131 → 132（新增：同分优先非免费线、高分免费线仍可选、free 覆盖生效）。
- 注意：插件在进程启动时加载，**改完要重启 DSH 才生效**。

## 3.2.2 — 2026-10-28
- **修：`yokos-beichenapi-anthropic` 的 baseURL 多了一层 `/v1`**。adapter 会自己拼 `/v1/messages`，于是实际请求 `…/v1/v1/messages` → `404 page not found`（子代理启动成功、运行中才挂，没有任何提示）。实测对照：`https://api.beichenapi.com/v1/messages` = 401（路径对、缺 key），`…/v1/v1/messages` = 404。已把该 provider 的 `baseURL` 改成 `https://api.beichenapi.com`（profile 改前备份 `cordis.patch.yml.bak-*-anthropic-baseurl`）
- **新增 `fallbackRoute`**：`agent_delegate` 启动自配子代理时，一并返回官方兜底 route；子代理若**运行期**失败（收到 `failed` 通知，工具无法自己等待异步结果），主模型用该 route 重派一次并告知用户「自配失败，已用官方兜底」。`clarify_tier` 的派活提示同步写清
- 说明：预检（`resolveCallConfig`）只验证配置能否解析，**不验证真实连通性**——所以 404 这种问题只会在运行期暴露
- **修测试守卫口径**：「README 写的测试条数跟实际一致」原来用 `\btest\(` 数测试，把 `/re/.test(x)` 这类正则调用也算成一条（README 写 131 却被判 132）；改成只数顶格 `test(`，与 `node --test` 的 `ℹ tests N` 对齐。测试 130 → 131

## 3.2.1 — 2026-10-28
- **包名转公开：`@local/dsh-calibration-tier` → `dsh-calibration-tier`**（npm 首发；`private` 去掉，补 `repository` / `homepage` / `bugs` / `keywords`）。客户端 bundle id、`cordis.patch.yml` 的 `name`、安装脚本与测试同步改名；本地 profile 的 `dependencies` / `dsh.profile.bundles` 与 `node_modules` junction 已迁移到新名（重启生效）
- **修：推理等级硬编码把自配模型误判成不可用**。3.2.0 里 `pickRoute` 给性能档写死 `reasoningEffort:"high"`，而 `llm-pi-ai` 注册的 `claude-opus-5-5` 没有声明 reasoning efforts，`resolveCallConfig` 直接拒（`does not support reasoning effort "high"`），于是每次自动挑到 opus 都回落官方
- 改法：`resolveRoutes` 采集每个模型真正声明的 `efforts`（`resolveModelInfo`）；`pickRoute` 只在有声明时才传（性能取最高档、效率取默认档）；**自动挑出的 effort 现在真的会传给子代理**（3.2.0 只用了用户显式传的）
- 预检失败若是「不支持该推理等级」，先去掉 `reasoning_effort` 重试自配，仍失败才回落官方；返回 `note` 会说清是哪一步
- 测试 129 → 130

## 3.2.0 — 2026-10-28
- **`agent_delegate` 加 `backend`**：`spawn`（默认，运行时换模型）/ `claude-code` / `codex`。后两者走 `provider: "claude-code"` / `"codex"` 的 `startActivation`，**不传 `agentOptions`**（两个后端都是 `NO_START_CAPABILITIES`，模型只能用各自 CLI 的配置），返回文本明写「CLI 配置模型」
- **自配 API 故障自动回退**：自动挑到非 `deepseek-*` 时先 `llm.resolveCallConfig` 预检；预检失败或启动失败都回退官方 route 重试一次，返回 `fellBack: true` + `note`，文本以「⚠️ 已回退」开头；CLI 后端起不来也回退到 `spawn` + 官方
- **`domain` 参数**：code / reasoning / writing / longContext / toolUse，直接按领域挑，不再只能靠 module 映射
- 测试 123 → 129（新增 backend、回退、domain 用例）

## 3.1.0 — 2026-10-28
- **新增 `agent_delegate`：当前会话就能用自配 API 的委派通道**。起因：官方 `subagent` 的白名单在会话创建时写进 projection 且只写一次，改配置只对新会话生效（实测当前会话仍报 `not allowed for this Session`）。读码发现白名单只在「模型显式传 provider/model」时校验（`assertAllowedModelSelection` 首行直接 return），所以 CT 自己调 `ctx.subagents.startActivation`，把 route 放进 `request.agentOptions`——走 provider 层，**不经过 allowedModels**
- 工具参数：`prompt` / `description` / `module`（executor/review/counter/research）/ 可选 `provider`+`model`+`reasoning_effort`/`cwd`；不传模型就按当前「代理」档位与领域自动挑（含注册表里的自配 API）
- **代价写清**：绕过宿主白名单，没有额度护栏；它是代理开关配套通道，不是通用后门
- `counter-audit` 与 `clarify-needs` 改用 `agent_delegate` 起审者；`clarify_tier` 的派活提示同步
- 测试 117 → 123（新增 `test/delegate.test.mjs` 6 项：自动挑、显式指定、无 subagents 报错、无 llm 报错、counter 隔离未知）

## 3.0.0 — 2026-10-28
- **第五个模式「代理」（v3）**：主条最右多一格 `代理`，开时右侧再出 `效率 | 性能` 两格（宽屏且检索关时并列；窄屏或检索开时收成一格轮换）。关掉 = 完全回到官方默认：不指定模型、不改白名单、`clarify_tier` 只回 `{on:false}`。代理是**策略开关**，不新建委托工具，执行仍走官方 `subagent`
- **子代理模型路由（接口层，不注册实例）**：新增 `lib/agents.js`——能力基线（按族打领域分）、注册表指纹重算、用户覆盖（`~/.dsh/storages/calibration-models.json`）、对抗避开主模型 provider、注册表里没有的 route 自动剔除。`clarify_tier` / `forge_level` 返回 `agent = {on, profile, planId, modules, isolation}`
- **诚实边界**：「自动更新」只更新「有哪些模型」，不更新「谁更强」；未知族一律 `unknown 5 分`。宿主 `llm` 服务无价格字段，没有自动「性价比」判据（按族 tier 估）
- **新增只读工具 `verify_claims`**：机械核对「断言 ↔ 来源」——文件类查工作区内路径 / 行号范围 / 锚点是否在该行 ±3 行；URL 类只验语法与域名分级（L1–L4）；命令类只标 weak；越界路径直接拒。它只证明「有对应的源」，不证明源本身真实
- **检索去掉「本地」档**：`ROUTE_LEVELS` 三档变两档（增量 / 全量）。开关关着就是不检索 = 本地行为；旧状态 `route.level="off"` 迁移成 `high`，`POST` 再收到 `off` 返回 400
- **对抗 v2**：新增技能 `counter-audit`（权威性 / 真实性 / 全面性三查 + 隔离三级 + 报告头带审者模型与 planId）；`counterPlan` 增 `isolation` 字段。旧 `counter-review` 保留三个月做回退
- **状态 schema 8 → 9**：补 `agent:{on:false,profile:"efficiency"}` 与 `turn.agent`（含 planId）；v7 跨两级、v8 单级迁移都留 `.bak`；未知 schema 仍只读兜底
- **配色**：代理紫红 `#b06fd0`（白字对比 ≈3.1，与现有 2.65–3.52 同带），变量 `--dct-agent`，只落在代理格与效率/性能格
- 工具描述与 `clarify-needs` 同步五模式；README / 使用说明 / demo 改「同框五模式」；`install-profile.ps1` 支持按路由表生成 `allowedModels`
- 测试 86 → 117

## 2.3.0 — 2026-10-28
- **`clarify_tier` 从「报档名」升级成「发清单」**：`think = {level,label,intensity,probes,axes,reverse,confirm,ask,text}`。常规 0 条；严格 2 个歧义点 · 3 条覆盖轴 · 1 次逆向；极致 3 · 6 · 3
- **歧义点**（问不问的判据）：目标与验收能不能一句话说清 / 不可逆与外部动作（推送、发布、改设置、删除）谁批准、怎么回滚 / 范围与取舍。只有「答案会改变执行」的才弹窗问，能自己查证的不占提问额度
- **覆盖轴**（全面性）：正常路径 / 边界与空值 / 失败与回滚，极致再加依赖与副作用、成本与性能、后续与可维护；逐轴给一句结论，未涉及的写 Z
- **逆向**（反推）：严格 1 条 pre-mortem；极致再加反证（什么证据会推翻结论）与反例（触发条件 / 后果 / 检查方法）
- **循环模式不再返回 `tier: "off"`**：轻量 / 交付 / 极致 同档位映射成 常规 / 严格 / 极致，`think.source="loop"`；`forge_level` 也带 `think`。起因是「循环档里从不提问」把公告面漏更新当成了默认行为（2.2.1 的 GitHub About 就是这么漏的）
- 工具描述与 `clarify-needs` 技能同步：三档表加「思考强度」列，新增「三张清单怎么用」小节（歧义点 / 覆盖轴 / 逆向），循环模式按同档位映射走本技能
- README、使用说明同步；新增 3 项测试（档位分配、循环映射、文案守护），测试 83 → 86

## 2.2.1 — 2026-10-27
- **修：循环一开，「检索」被染成绿色**。循环的换色规则原先写通用 `.dct-cell[data-on='1']:not(.dct-counter)`（特异性 0,5,0），压过检索的 `.dct-routecell / .dct-route-toggle{background:var(--dct-route)}`（0,3,0），所以只要在循环模式，检索开关和它那三格都跟着变绿；使用说明与 README 写的却是「检索常驻天蓝」，实现和文档不一致
- **改法**：循环的换色收窄成 `.dct-cell[data-level][data-on='1']`——只认三级条的选中格；检索格、检索开关、对抗开关各自保持天蓝 / 天蓝 / 雾红
- 收窄后暴露出第二个坑：循环格原先是靠这条通用规则才显绿的，它自己的 `.dct-mode[data-on='1']`（0,2,0）输给 `.dct-cell[data-on='1']`（0,3,0），一收窄就变紫。所以循环格那条升成 `.dct-root .dct-cell.dct-mode[data-on='1']`（0,4,0）：既不输紫，也不依赖源序（写成 0,3,0 也能赢，但把那条规则挪到紫之前就会翻车）
- 新增守卫：`data-mode='loop'` 那一段 CSS 里不许再出现 `.dct-route` / `.dct-counter`，也不许再出现通用 `.dct-cell[data-on='1']`；循环格那条必须是 0,4,0 的 `.dct-root .dct-cell.dct-mode`
- 真浏览器验证（一次性，脚本未入库）：headless Chrome 把同一份 CSS 在四种根属性下渲染出来取色——循环=绿 `#66ae7c`、检索=天蓝 `#3a9ad9`、循环+对抗同开=橙 `#cf8a4a` + 绿 + 红 + 天蓝四色并存、思考=紫 `#877be3` + 天蓝；修复前的同一份页面复现出「检索」与检索格都是绿
- 纯样式：状态 schema、`/state` 字段、`clarify_tier` / `forge_level` 返回、DOM 节点数与文案全不变，不用迁移
- 测试 80 → 81

## 2.2.0 — 2026-10-27
- **第四个模式「检索」（可叠加开关）**：主条最右侧多一格 `检索`，开启后最左侧多出三格 `本地 / 增量 / 全量`；思考档、循环档、对抗开关原样保留，四者互不覆盖（检索有独立字段 `route{on,level}`，不跟 `level` 抢值）
- **三档口径**：本地=只读已装技能、不联网；增量=联网找已装之外能用的技能，只读文本不安装，落暂存等宿主定；全量=地毯式检索 + 重合组差异分析，出判别卡，不设读取上限但只跑首轮、不跟循环叠加
- **`clarify_tier` 新增 `route`**：`{on,level,label,plan}`，`plan` 给关键词组数、读取口径、产出物与止损规则；关着时 `plan=null`，不占字。`forge_level` 也带同一字段
- **配色**：检索天蓝 `#3a9ad9`（白字对比 3.09，与现有 2.65–3.52 同带）；变量 `--dct-route`，只落在 `.dct-routecell` 与 `.dct-route-toggle` 的选中态
- **状态 schema 7 → 8**：补 `route:{on:false,level:"high"}`；v7 文件读时补齐并写回，写前 `.bak`（迁移纪律不变：只认得出的旧结构才写回，未来 schema 不降级覆写）
- 轮内快照 `turn{id,mode,level,counter,route}` 一并冻结；`pending` 判定把 route 两轴算进去
- 桥：`POST /state` 接受 `route:{on?,level?}`，非对象或非法档位 400；`/state` 增加 `routeLevels` 与 `defaultRoute`
- 文档：README 改「同框四模式」并补三条口径表、`demo.svg` 加检索行与天蓝图例、`clarify-needs` 的技能说明同步
- 测试 65 → 80 项

## 2.1.0 — 2026-10-27
- **循环 + 对抗 同开时，等级条的选中格转橙**：`--dct-mix:#cf8a4a`，只在 `data-mix="1"`（`mode=loop` 且 `counter=true`）时生效；循环开关保持绿、对抗开关保持红，只有左边等级格换色，所以「边磨边审」这个组合状态一眼可辨
- 橙色是手工取的暖橙，不是两色数值平均：`#66ae7c` 与 `#da7f7f` 平均得土黄 `#a0967d`（既不橙也发灰），取同亮度、同饱和度的橙才既像橙又不至于成为整条最亮的一格
- 新增根属性 `data-mix`，CSS 只认这一位；「下一轮生效」小点在同开时也用橙色
- 新增守卫：橙只落在 `[data-level][data-on='1']`，`.dct-mode` / `.dct-counter` 不许跟着变色；单独循环、单独对抗、都不开时 `data-mix="0"`
- `demo.svg` 循环行同步转橙并加一行图例；`docs/demo.png` 按新图重渲染（旧 PNG 还停在 1.9 的旧名与绿条）；README / 使用说明（Markdown + Word）/ 发布说明同步
- 纯前端样式：状态文件、`/state` 字段、`clarify_tier` 与 `forge_level` 的返回值都不变
- 测试 62 → 65

## 2.0.0 — 2026-10-25
- **改名 `dsh-calibration` → `dsh-calibration-tier`，简称 CT**：C 承接 `calibration`（把用力程度校准到任务），T 承接 `tier`（一根条上的档位）；第一代 `dsh-clarify-tier` 的缩写同样是 CT，两代名字接上
- 一并改的对外名字：仓库名、包名 `@local/dsh-calibration-tier`、客户端 bundle id、`cordis.patch.yml` 的 `name`、README / 使用说明 / 演示图 / 安装脚本 / 两个技能文档 / 测试
- **内部标识一律不动**：cordis 节点 id `calibration`、`/state` 的 `plugin` 标记（`PACKAGE_ID`）、状态文件 `storages/calibration.json`、调试文件 `calibration-debug.jsonl`、端口变量 `DSH_CALIBRATION_PORT`、CSS 前缀 `dct-`、工具名 `clarify_tier` / `forge_level` → 本次**无状态迁移**
- 升级：本地目录改名后，profile 的 `dependencies` 与 `bundles` 两项换成新包名（`install-profile.ps1` 会处理），重启应用生效
- 测试 62 项全过

## 1.9.1 — 2026-10-25
- **公开文案去掉口语「万一」**：GitHub About、README、使用说明、demo 副标题、`counter-review` 技能里的「万一」统一改成「对抗审查 / 反例句式 / 若…则…」
- 新增守卫：README、使用说明、demo、两个技能文档里再出现「万一」即测试失败
- 使用说明（Word）同步重新生成
- 测试 61 → 62

## 1.9.0 — 2026-10-24
- **改名 `dsh-clarify-tier` → `dsh-calibration`**：三种模式（思考/循环/对抗）+ 强度三档，本质是「把用力程度校准到任务」，旧名只覆盖了「需求锚定」一角
- 一并改：包名 `@local/dsh-calibration`、客户端 bundle id、`/state` 的 `plugin` 标记、cordis 节点 id、状态文件 `storages/calibration.json`、调试文件 `calibration-debug.jsonl`
- **旧状态自动迁移**：新文件不存在时读 `storages/clarify-tier.json`（v6/v7 都认），补齐后写到新文件名；旧文件原样保留可回滚
- 端口环境变量改为 `DSH_CALIBRATION_PORT`，仍兼容旧名 `DSH_CLARIFY_TIER_PORT`
- 工具名不变：`clarify_tier` / `forge_level`（AGENTS 与两个技能都在引用，改名只会惹麻烦）
- 顺带：界面去掉悬停解释，只留按钮本体（1.8.5 的内容并入本版）
- 测试 61 项全过

## 1.8.5 — 2026-10-24
- **去掉悬停解释**：档位格、循环、对抗、根节点都不再挂 `title`，只留按钮本体（根节点保留 `aria-label`，读屏不受影响）
- 新增守卫：任一子节点或根节点带 `title` 即测试失败
- 测试 60 → 61

## 1.8.4 — 2026-10-24
- **文案统一为「三模式」**：README 标题/开头/正文、`clarify-needs`、`counter-review` 变更记录、`demo.svg` 标题与副标题、GitHub About、`package.json` description，不再出现「双模式 / 两个模式」；关系写清：思考 ⇄ 循环 互斥切换，对抗可叠加
- **新增一致性守卫**：现行文档（README + 两个 SKILL/README + demo.svg）出现「双模式 / 两个模式」直接测试失败，README 必须含「三模式」
- 测试 59 → 60

## 1.8.3 — 2026-10-24
- **亮度回落到深一档**（在当前基础上 −6 个百分点，色相与饱和度不动）：思考 `#877be3`、循环 `#66ae7c`、对抗 `#da7f7f`
- 仍只在三个 CSS 变量里定义；`demo.svg` 同步
- 测试 59 项（样式断言跟新色值）

## 1.8.2 — 2026-10-24
- **配色回一点亮度**：柔雾版太灰，改成在旧版亮度上只降饱和——思考 `#8b7fe3`、循环 `#69b07f`、对抗 `#db8383`
- **循环与对抗之间加隔离线**：两个开关视觉上分开，不再像一组
- **修：对抗开在循环模式下会变绿**。原因：`.dct-root[data-mode='loop'] .dct-cell[data-on='1']` 比对抗规则多一个选择器，把红色盖掉了；改成 `:not(.dct-counter)` 让循环色只作用于前三格与循环键，对抗亮起后恒为红
- `demo.svg` 同步：新色号、加隔离线、循环行里对抗保持红
- 测试 59 项（结构断言改 7 个子节点，样式断言覆盖 `:not(.dct-counter)` 与恒红规则）

## 1.8.1 — 2026-10-24
- **配色改「柔雾」并收成变量**：思考 `#8a82cf`（雾紫）、循环 `#6fa47f`（雾绿）、对抗 `#cc8b8b`（雾红），三色统一降饱和；循环原来的琥珀、对抗原来的珊瑚红都换掉
- 颜色只在 `.dct-root` 的 `--dct-think / --dct-loop / --dct-counter` 三个 CSS 变量里定义，聚焦描边、循环内阴影、pending 小点全部引用变量，以后改一处即可
- `demo.svg` 同步换色；README 补一条配色说明
- 测试仍 59 项（样式断言改成校验变量定义与引用）

## 1.8.0 — 2026-10-24
- **一框两模式 + 一开关**：隔离线右侧从「循环」一个开关变成「循环 + 对抗」两个开关，互不影响；前三个格不变
- **对抗是独立开关**：`counter: true|false` 记在每个会话上；关着 = 0 条，行为与旧版完全一致；开着按档位给密度（常规/严格 3 条、极致 5 条）
- **两种模式都吃对抗**：思考模式 = 动手前审方案 + 交付前审改动（`scope=plan+delivery`）；循环模式 = 每轮审改动（`scope=round-changes`）
- **schema 6 → 7**：每个会话多一个 `counter`（缺省 false）；读到 v6 文件时补齐并写回，迁移前留 `.bak`；更早的 4/5 仍按原路迁移
- 两个工具都带 `counter`：`clarify_tier`（思考档 + 对抗）、`forge_level`（循环档 + 对抗）；不加第三个工具，每步调用次数不变
- 每轮快照带上 `counter`：本轮内切开关只影响下一轮（与档位一致）
- 界面：对抗开关珊瑚红，悬停写清「思考=前后各审一轮 / 循环=每轮」；`data-counter` 暴露状态
- README / demo.svg / `counter-review` / `clarify-needs` / `loop-forge` 文案同步
- 测试 58 → 59（开关渲染与只提交 counter、schema 7、对抗密度随档位、scope 随模式）

## 1.7.0 — 2026-10-24
- **新增技能 `counter-review`（对抗审）**：循环评审轮里当「反对者」，用六轴场景矩阵（版本/环境、机器状态、用户用法、数据形态、时序、极端量）对本轮改动逐条「万一」拷问
- 每条攻击必须带四元组 `隐患 | 触发条件 | 后果 | 检查方法`，缺项作废；三态收口：接受（挂 D 号）/ 驳回（给证据）/ 转边界（写进已知边界）
- **按档位预算**：轻量关；交付（high）只在收敛轮、≤3 条；极致（max）第 2 轮起每轮、≤5 条；连续 2 轮零新增 = 泛化收敛
- `forge_level` 返回值新增 `counter` 字段（enabled / maxAttacks / scope / onlyFinalRound / fromRound），由 `COUNTER_PLAN` 统一给值
- 与 `clarify-needs` 分工写死：它动手前审方案，本技能每轮审改动，共用同一套矩阵与三态判定
- 技能已 junction 到两套 DSH 的 skills 目录（`D:\AI\DSH-NEXT\skills`、`D:\AI\DSH-official\home\skills`）
- `loop-forge` 接入：评审后、修之前跑对抗审，报告块加「对抗审」一行
- 测试 55 → 58（counter 三档取值、COUNTER_PLAN 与 LEVELS 绑定、技能 frontmatter 合规）
- **命中演练 3/3**：fresh 子代理只看方法+改前状态，对 1.4.2/1.5.0/1.6.0 三个真实事故出 15 条攻击，三个根因全被点到；明细见 `skill/counter-review/docs/method.md`

## 1.6.1 — 2026-10-24
- **回退 1.6.0 的语义改动，只保留改名**：第一格的值仍是 `off`（技能退出位：不锚定、不复述、不提问、不标假设），只是滑条上显示为「常规」——即「按常规方式直接做」
- `LEVELS` 回到 `off/high/max`；`LOOP_PLAN` 键回到 off；1.6.0 引入的 `off→low` 平移逻辑一并撤掉（没有版本跑过 1.6.0，状态文件里没有 `low`）
- 文案同步：宿主 `LABELS/TITLES`、客户端兜底、`clarify_tier` 描述与返回文案、插件 README、`demo.svg`、`clarify-needs` v5.0 表述（注明滑条显示「常规」）、两份 `AGENTS.md` §0
- 测试 55 项全过（标签断言改成「常规」，其余断言仍用 `off`）

## 1.5.3 — 2026-10-24
- **认不准就不碰桥**：两套 DSH 同开、且谁都不认识本会话时，客户端不再「先用探测到的端口」——现在**不读、不写、不连 SSE**，只显示本地值（本地值天生属于本应用），带 `!` 标记；期间点击记账，认准实例后补写一次。这样另一套的档位再也不会出现在本应用里
- **单实例不设门槛**：端口上只找到一个本插件实例时直接认领，不必等工具落盘（原来要等 `knownSession`）
- 扫端口收成 `scanInstances()`：一次拿回「有几套实例、各自认不认识本会话」，替代原来的「找到第一个就收工」
- 修：挂载时 `pull()` 被调两次导致两条轮询链并发、轮次翻倍（实测 12 轮约 60 毫秒就烧完）；加 `resolving` 单飞保护
- 测试 53 → 55：单实例直接认领、两套都不认领时不连 SSE 不写桥且认领后补写

## 1.5.2 — 2026-10-24
- **未认领时定时重试**：刚开窗口、本轮的 `clarify_tier` 还没落盘时，两个实例都不认识这个会话，客户端只能先用探测到的端口（可能是另一套的）。原来只等「窗口聚焦」才复检，现在按 `CONFIG.ownerPollMs`（默认 5 秒、最多 12 轮 ≈ 1 分钟）自动重试，认领上就停
- 实测触发场景：官方 DSH 刚打开时 SSE 连到了 NEXT 的桥（`netstat` 看到官方渲染进程连 43871），因为官方侧还没有任何工具落盘；现在最多 5 秒就会自己切回 43872
- 未认领期间的点击仍只写本地（1.5.1 起对方文件不会被污染），认领后以宿主值为准
- 测试 52 → 53：无人认领 → 轮询 → 认领成功并停止

## 1.5.1 — 2026-10-24
- **认领信号改成「只认工具写的」**：1.5.0 用「本实例有没有这个会话」，可客户端自己也能写这个会话——误连到另一套实例时随便点一下，就把会话写进对方文件，信号被自己污染
- 每个会话加 `owner: "tool" | "client"`：POST（客户端）标 `client`，工具落本轮快照时标 `tool`；`knownSession` 只在 `owner === "tool"` 时为 true，且 owner **只升不降**
- 顺带让复核更及时：任何一次拉取发现 `knownSession=false` 就安排一次复核（`CONFIG.ownerCheckTtl` 节流 3 秒），不再只等窗口聚焦
- 兼容：老状态文件没有 owner → 视为未认领，退化为 1.4.2 的缓存行为；本轮第一次工具调用后自动获得认领能力
- 测试 51 → 52：客户端写不算认领、工具写后才算、工具认领后客户端再改档不降级

## 1.5.0 — 2026-10-24
- **两套 DSH 同开时按「会话归属」认桥**：`plugin` 标记只能证明「是同一个插件」，分不出是哪个实例——缓存丢失时客户端可能连到另一套 DSH 的桥，控件与工具各读各的状态文件
- `/state` 新增 `knownSession`：本实例的状态文件里有没有这个会话。客户端发现当前桥不认识本会话时，扫一遍 43871–43880，切到认识它的那个端口（并写回 localStorage）
- 认领时机：挂载时（先认领再连 SSE）、窗口重新聚焦时。老宿主不带该字段 → 一次都不多扫，行为不变
- 兼容：客户端 + 宿主同版本才有认领能力；单向升级时退化为旧行为（缓存 + 首个命中）
- 空窗：新对话还没被工具写过时两边都是 false，只能先用缓存端口；本轮第一次 `clarify_tier` 落盘后自我纠正（已写进已知边界）
- 测试 48 → 51：`knownSession` 正确性、两套实例按归属切端口、老宿主不额外扫端口

## 1.4.2 — 2026-10-24
- **修端口退让的日志与 chosenPort**：同一个 `http.Server` 上重试 `listen()` 时，前一次失败那回的 listen 回调也会被一起触发，导致真实日志里同时出现「就绪 43871」和「就绪 43872」（43871 其实是别的实例占着），`chosenPort` 也会被短暂写错
- 现在以 `server.address().port` 为准：实际绑上哪个端口才记「桥接就绪」，其余回调直接返回
- **顺手清掉一句误导**：单个端口 EADDRINUSE 时原来会打「控件会退化为只读」，可实际会退到下一个端口、功能正常；这句只在 10 个端口全占时才该出现。运行期错误另走一条「桥接错误」
- 测试 47 → 48：新增「退让成功时日志只报一次就绪、且报的是真绑上的端口」，并验证过**回退该修复时这条测试会红**
- 无行为变更（只影响日志与内部 chosenPort）

## 1.4.1 — 2026-10-24
- **档位标准收敛到三档**（关闭 / 严格 / 极致，默认严格）：`clarify-needs` 的 `README.md` 与 `docs/design.md` 还停在四档（含 `low 常规`），而档位条只有 `off/high/max` 三格——技能本体 `SKILL.md` 早就是三档，这两个文件落后一版
- 原「常规」的三样（复述 / 2 确认点 / 假设清单≤3）并入严格档；定档评分改 `0=off / 1–2=high / ≥3=max`；地板改「会改文件/配置/系统的任务最低 high」；`clarify-needs` 版本记 v5.0
- 两份 `AGENTS.md`（官方 DSH 与 NEXT）§0 同步成三档、最高档统一叫「极致」、取不到档位按 `high`（md5 保持一致）
- **新增守则**：`skill/clarify-needs/` 里的档位表必须与宿主 `LEVELS` 完全一致（多写一档就会红）——这次漂移就是它该拦住的
- 测试 46 → 47；版本 1.4.1（`files` 含 skill，所以技能文档改动也算发布内容）

## 1.4.0 — 2026-10-24
- **宿主拆模块**：`lib/index.js` 693 行 → 装配层 ~80 行，逻辑分到 `core.js`（常量/文案/会话键/广播总线）、`state.js`（读写与迁移）、`bridge.js`（HTTP + SSE + 端口退让）、`tools.js`（两个工具 + 轮内快照）。**对外导出不变**：`apply` / `inject` / `TIER_LABELS` / `TIER_TITLES` / `publicState` / `turnIdFromExec` 等照旧从 `lib/index.js` 拿
- **客户端保持单文件**：模块加载器只吃一个 factory，拆 import 会直接起不来；去重靠内部 `applyState()`，不靠拆文件
- **广播改成总线**：原来 `let broadcaster` + `startBridge` 反向赋值；现在 `core.js` 的 `setBroadcaster()` / `emit()`，桥与工具互不 import
- **lint 真查全量**：`scripts/check.mjs` 遍历 `lib/*.js`、`test/*.mjs` 与自身逐个 `node --check`，不再手写三个文件名
- **发版面**：`package.json` 的 `files` 改成 `lib/`、`scripts`；新增守则「`lib` 下每个模块都被 files 覆盖」，漏加文件会在测试里炸
- 测试 45 → 46；`npm run verify` 通过

## 1.3.0 — 2026-10-24
- **点一次档省一次请求**：宿主 POST `/state` 的响应改成带 `pending` / `turnLocked`（原来只回 `{ok,session,mode,level}`），客户端拿到就不用再补一次 GET；老宿主不回 `pending` 时自动退回拉取，行为不变
- **端口发现退避**：一轮 10 个端口全探空后记时间，3 秒内点击不再重扫（原来每次交互都要打 10 个 fetch）；挂载时 pull 与 SSE 同时要端口，改为同一时刻只跑一轮发现
- **端口缓存会在失败时作废**：GET 非 2xx（端口上是别的实例）或网络错误、SSE 彻底断开，都清掉 `bridgePort`，下次重新发现。原来宿主重启换了端口，客户端会一直指着旧端口
- **SSE 断线重建**：`readyState=2`（浏览器不再自己重连）时按 `CONFIG.reconnectDelay`（默认 2s）重建，最多 `CONFIG.maxReconnects`（默认 3）次；收到消息即重置计数
- **降级与待生效不再互相盖**：容器 title 由 `barTitle()` 统一生成，离线与「下一轮生效」同时成立时两句话都写；样式仍是 `!` 优先
- **诊断默认关**：`report()` 走 `debugOn()` 闸门，不再每次启动往 `clarify-tier-debug.jsonl` 追加 6 行（那个文件不轮转）。要用时 `localStorage.setItem("dsh-tier-debug","1")`
- 客户端三处重复的落值逻辑收成 `applyState()`；新增 `CONFIG` 作为可调项入口
- 测试 38 → 45：端口退避与去重、POST 带回状态不补 GET、老宿主补 GET、SSE 重建上限、诊断闸门、title 双状态、POST 响应带 `turnLocked`

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
