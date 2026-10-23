# 变更记录

## 0.1.1 — 2026-10-23
- 修：客户端 bundle id 用包名（含 scope），否则 client-modules 二次执行导致 web boot 失败
- 修：宿主 export inject = ["tools"]，否则 ctx.tools 不可访问、clarify_tier 静默不注册

## 0.1.0 — 2026-10-23
- 首版：输入框工具行分段条（off/low/high/max/ultra）+ 宿主状态桥 + clarify_tier 工具
