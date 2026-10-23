/**
 * dsh-clarify-tier — 客户端半边
 *
 * 一根框、两个模式：
 *   思考模式：关 | 严 | 极   ‖ 循环
 *   循环模式：轻 | 交付 | 极限 ‖ 循环（亮起）
 * 右侧「循环」用一条隔离线与三档分开，它是模式开关，不是第四档。
 * 切到循环模式后，前面三格的含义从「问多深」变为「磨几轮」，配色由紫转琥珀。
 *
 * ── 四条纪律 ───────────────────────────────────────────────────────────
 *  1. **fail-open**：插槽注册失败、桥接不可达，只让控件消失/只读，不连累输入框。
 *  2. **不碰官方 DOM**：不找、不改、不重排官方元素。
 *  3. **不注入消息**：状态只走宿主文件 + `clarify_tier` / `forge_level` 工具。
 *  4. **一格一义**：同一格在两种模式下含义不同，标签与提示必须同步切换，不能留旧标签。
 */
/*
 * id 必须是**包名**（含 @scope），因为 dsh-client-modules 用 package name 当浏览器模块身份。
 * 写成短名会 duplicate factory registration → web boot 失败 → 恢复模式。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-clarify-tier",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var hooks = React;

    var PACKAGE_ID = "dsh-clarify-tier";
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ORDER = 10;
    var LEVELS = ["off", "high", "max"];
    var MODES = ["think", "loop"];

    var THINK_LABELS = { off: "关闭", high: "严格", max: "极限" };
    var THINK_TITLES = {
      off: "关闭：不锚定、不循环，直接执行",
      high: "严格：复述 + 2 确认点 + 回滚 + 验收 + 失败分支",
      max: "极限：严格之上再加反例与代价、对抗自检、对抗复审",
    };
    var LOOP_LABELS = { off: "轻量", high: "交付", max: "极限" };
    var LOOP_TITLES = {
      off: "轻量：3 轮纯自检，适合小修小补",
      high: "交付：5 轮，第 2 轮独立评审 + 收敛复核",
      max: "极限：8 轮，第 2 轮起每轮独立评审",
    };

    var STORAGE_KEY = "dsh-tier-mode";
    var DEFAULT_MODE = "think";
    var DEFAULT_LEVEL = "high";
    var BRIDGE = "http://127.0.0.1:43871/state";

    function normalize(value) {
      var mode = value && MODES.indexOf(value.mode) >= 0 ? value.mode : DEFAULT_MODE;
      var level = value && LEVELS.indexOf(value.level) >= 0 ? value.level : DEFAULT_LEVEL;
      return { mode: mode, level: level };
    }

    function readLocal() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && (MODES.indexOf(parsed.mode) >= 0 || LEVELS.indexOf(parsed.level) >= 0)) {
            return normalize(parsed);
          }
        }
      } catch (e) {
        /* 忽略 */
      }
      return normalize(null);
    }

    function writeLocal(state) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        /* 忽略 */
      }
    }

    var CSS = [
      ".dct-root{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;",
      "border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.08);",
      "font-size:11px;line-height:1;user-select:none;flex:none;margin-inline-end:6px;",
      "font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dct-cell{appearance:none;border:0;background:transparent;color:inherit;opacity:.55;",
      "font:inherit;padding:4px 7px;border-radius:999px;cursor:pointer;transition:opacity .12s,background .12s}",
      ".dct-cell:hover{opacity:.9}",
      ".dct-root .dct-cell[data-on='1']{background:#7c6cf0;color:#fff;opacity:1;font-weight:600}",
      ".dct-root[data-mode='loop'] .dct-cell[data-on='1']{background:#e08a2e}",
      ".dct-sep{width:1px;height:14px;background:rgba(127,127,127,.38);margin:0 3px;border-radius:1px}",
      ".dct-mode{border-left:0;letter-spacing:.5px}",
      ".dct-mode[data-on='1']{background:#e08a2e;color:#fff;opacity:1;font-weight:600;",
      "box-shadow:0 0 0 1px rgba(224,138,46,.5) inset}",
      ".dct-cell:focus-visible{outline:2px solid #7c6cf0;outline-offset:1px}",
      ".dct-root[data-degraded='1']{border-style:dashed}",
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

    function fetchRemote() {
      try {
        return fetch(BRIDGE, { method: "GET", credentials: "omit", cache: "no-store" })
          .then(function (res) {
            if (!res.ok) return null;
            return res.json();
          })
          .then(function (json) {
            return json && typeof json === "object" ? json : null;
          })
          .catch(function () {
            return null;
          });
      } catch (e) {
        return Promise.resolve(null);
      }
    }

    function pushRemote(patch) {
      try {
        return fetch(BRIDGE, {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        })
          .then(function (res) {
            return res.ok;
          })
          .catch(function () {
            return false;
          });
      } catch (e) {
        return Promise.resolve(false);
      }
    }

    function TierBar() {
      var initial = readLocal();
      var state = hooks.useState(initial);
      var value = state[0];
      var setValue = state[1];
      var degraded = hooks.useState(false);
      var isDegraded = degraded[0];
      var setDegraded = degraded[1];

      hooks.useEffect(function () {
        var alive = true;
        fetchRemote().then(function (json) {
          if (!alive) return;
          if (json && (MODES.indexOf(json.mode) >= 0 || LEVELS.indexOf(json.level) >= 0)) {
            var remote = normalize(json);
            setValue(remote);
            writeLocal(remote);
            setDegraded(false);
          } else {
            setDegraded(true);
          }
        });
        return function () {
          alive = false;
        };
      }, []);

      var mode = value.mode;
      var level = value.level;
      var loop = mode === "loop";
      var labels = loop ? LOOP_LABELS : THINK_LABELS;
      var titles = loop ? LOOP_TITLES : THINK_TITLES;

      function commit(next) {
        var normalized = normalize(next);
        setValue(normalized);
        writeLocal(normalized);
        pushRemote(normalized).then(function (ok) {
          setDegraded(!ok);
        });
      }

      function pickLevel(next) {
        if (LEVELS.indexOf(next) < 0) return;
        commit({ mode: mode, level: next });
      }

      function toggleMode() {
        commit({ mode: loop ? "think" : "loop", level: level });
      }

      var cells = LEVELS.map(function (l) {
        return React.createElement(
          "button",
          {
            key: l,
            type: "button",
            className: "dct-cell",
            "data-on": l === level ? "1" : "0",
            "data-level": l,
            title: titles[l],
            "aria-pressed": l === level ? "true" : "false",
            onClick: function () {
              pickLevel(l);
            },
          },
          labels[l],
        );
      });

      cells.push(
        React.createElement("span", { key: "sep", className: "dct-sep", "aria-hidden": "true" }),
        React.createElement(
          "button",
          {
            key: "mode",
            type: "button",
            className: "dct-cell dct-mode",
            "data-on": loop ? "1" : "0",
            "data-mode-toggle": loop ? "loop" : "think",
            title: loop ? "循环中：点一下退回思考档" : "循环：切到循环模式，交付后自动打磨",
            "aria-pressed": loop ? "true" : "false",
            onClick: toggleMode,
          },
          "循环",
        ),
      );

      return React.createElement(
        "div",
        {
          className: "dct-root",
          role: "group",
          "aria-label": loop ? "循环档位" : "思考档位",
          "data-dsh-tier": "1",
          "data-mode": mode,
          "data-degraded": isDegraded ? "1" : "0",
          title: loop ? "循环模式" : "思考模式",
        },
        cells,
      );
    }

    var inject = ["slots", "sessions"];

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          var dispose = ctx.slots.register(
            {
              name: SLOT_NAME,
              id: "tier-bar",
              order: ENTRY_ORDER,
              label: function () {
                return "档位（思考 / 循环）";
              },
              inject: function (sessionId) {
                return { sessionId: sessionId };
              },
            },
            function SlotComponent() {
              return React.createElement(TierBar, null);
            },
          );
          return function () {
            try {
              if (typeof dispose === "function") dispose();
            } catch (e) {
              /* 忽略 */
            }
          };
        });
      } catch (error) {
        try {
          console.error("[clarify-tier] 插槽注册失败，控件不会出现：", error);
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    installStyles();

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      LEVELS: LEVELS,
      MODES: MODES,
      THINK_LABELS: THINK_LABELS,
      LOOP_LABELS: LOOP_LABELS,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ORDER: ENTRY_ORDER,
      DEFAULT_MODE: DEFAULT_MODE,
      DEFAULT_LEVEL: DEFAULT_LEVEL,
      CSS: CSS,
      TierBar: TierBar,
    };

    return module.exports;
  },
});
