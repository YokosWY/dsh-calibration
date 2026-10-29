    /*
     * 配色只在这里定义一次（2026-10-24 v1.8.1 起）：三色统一降饱和的「柔雾」调。
     * 思考=雾紫 #877be3 / 循环=雾绿 #66ae7c / 对抗=雾红 #da7f7f；
     * 循环 + 对抗 同开（data-mix='1'）时三级条的选中格用雾橙 #cf8a4a：红绿之间的橙不是取色值平均
     * （平均出来是土黄 #a0967d），而是取同一亮度、同一饱和度的暖橙。
     */
    var CSS = [
      ".dct-root{--dct-think:#877be3;--dct-loop:#66ae7c;--dct-counter:#da7f7f;--dct-mix:#cf8a4a;--dct-route:#3a9ad9;--dct-agent:#24543f;",
      "display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;",
      "border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.08);",
      "font-size:11px;line-height:1;user-select:none;flex:none;margin-inline-end:6px;",
      "font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dct-cell{appearance:none;border:0;background:transparent;color:inherit;opacity:.55;",
      "font:inherit;padding:4px 7px;border-radius:999px;cursor:pointer;transition:opacity .12s,background .12s}",
      ".dct-cell:hover{opacity:.9}",
      ".dct-root .dct-cell[data-on='1']{background:var(--dct-think);color:#fff;opacity:1;font-weight:600}",
      // 循环只换「三级条」的选中格（2.2.1 起）：原先写通用 .dct-cell[data-on='1']，特异性 0,5,0
      // 压过检索的 0,3,0，循环一开检索格也被染绿。检索常驻天蓝、对抗恒红，同 2.1.0 的橙只落在等级格。
      ".dct-root[data-mode='loop'] .dct-cell[data-level][data-on='1']{background:var(--dct-loop)}",
      ".dct-root .dct-counter[data-on='1']{background:var(--dct-counter);color:#fff;opacity:1;font-weight:600}",
      // 循环 + 对抗 同开：三级条的选中格由绿转橙；循环/对抗两个开关各留原色（绿 / 红）
      ".dct-root[data-mix='1'] .dct-cell[data-level][data-on='1']{background:var(--dct-mix)}",
      // 检索：末尾的轮换格（v3.5.0）「本地 → 增量 → 全量」，天蓝 #3a9ad9（与三色同亮度带，白字对比 3.09）。
      // 用户口径 2026-10-29：本地也要保持颜色渲染——所以不看 data-on，三档恒亮；
      // 写法用 .dct-cell.dct-routecell（0,4,0），稳压上面通用 .dct-cell[data-on='1'] 的 0,3,0，不依赖源序
      ".dct-root .dct-cell.dct-routecell{background:var(--dct-route);color:#fff;opacity:1;font-weight:600;",
      "box-shadow:0 0 0 1px rgba(58,154,217,.45) inset}",
      // 代理：末尾轮换格「默认 → 效率 → 性能」，墨绿 #24543f——白字对比 ≈8.7，比三档更深，
      // 靠明度差跟循环雾绿 #66ae7c 分开；同样恒亮，「默认」也保持墨绿
      ".dct-root .dct-cell.dct-agentcell{background:var(--dct-agent);color:#fff;opacity:1;font-weight:600;",
      "font-variant-numeric:tabular-nums;box-shadow:0 0 0 1px rgba(36,84,63,.45) inset}",
      ".dct-sep{width:1px;height:14px;background:rgba(127,127,127,.38);margin:0 3px;border-radius:1px}",
      ".dct-mode{border-left:0;letter-spacing:.5px}",
      // 循环格要写满 .dct-root .dct-cell.dct-mode（0,4,0）：只写 .dct-mode[data-on='1']（0,2,0）会输给
      // 上面 .dct-cell[data-on='1'] 的紫（0,3,0）；写成 0,3,0 又能赢但依赖源序，升到 0,4,0 才与顺序无关
      ".dct-root .dct-cell.dct-mode[data-on='1']{background:var(--dct-loop);color:#fff;opacity:1;font-weight:600;",
      "box-shadow:0 0 0 1px rgba(102,174,124,.45) inset}",
      ".dct-cell:focus-visible{outline:2px solid var(--dct-think);outline-offset:1px}",
      ".dct-root[data-degraded='1']{border-style:dashed}",
      ".dct-root[data-pending='1']::after{content:'·';opacity:.85;color:var(--dct-loop);font-size:16px;",
      "padding-inline:3px;line-height:1;font-weight:700}",
      ".dct-root[data-mix='1'][data-pending='1']::after{color:var(--dct-mix)}",
      ".dct-root[data-degraded='1']::after{content:'!';opacity:.5;font-size:10px;padding-inline:3px}",
    ].join("");

    function installStyles() {
      try {
        if (typeof document === "undefined") return;
        if (document.getElementById("dct-style")) return;
        var el = document.createElement("style");
        el.id = "dct-style";
        el.textContent = CSS;
        document.head.appendChild(el);
      } catch (e) {
        /* 忽略 */
      }
    }

