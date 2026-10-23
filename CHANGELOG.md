# 变更记录

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
