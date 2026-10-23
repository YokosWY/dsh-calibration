/**
 * dsh-clarify-tier — 客户端半边
 *
 * 在输入框工具行放两条分段条：
 *   1. 需求锚定档位：off | low | high | max
 *   2. 循环锻造开关：off | 标准 | 极限（loop-forge 的强度与轮次上限）
 * 位置靠插槽 order 控制（10 / 11），排在模型选择左边、两条紧挨着形成双开关。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 *  1. **fail-open**：插槽注册失败、桥接接口不可达，都只让控件不出现/退化为只读，
 *     绝不连累输入框本身。
 *  2. **不碰官方 DOM**：不找、不改、不重排任何官方元素；只用自己插槽里的节点。
 *  3. **不注入消息**：档位只走宿主状态文件 + `clarify_tier` / `forge_level` 工具，不往会话里塞事件。
 */
/*
 * id 必须是**包名**（含 @scope），因为 dsh-client-modules 用 package name 当浏览器模块身份：
 *   - 启动图 row.id = "@local/dsh-clarify-tier"（URL 里就是它）
 *   - 模块系统认为「已注册」的判据是 factories.has(row.id)
 * 写成短名 "dsh-clarify-tier" 时，第一批 combo 注册完仍判为未注册 → 再拉一次单资源 URL
 * → bundle 二次执行 → register() 抛 duplicate factory registration → web boot 失败 → 恢复模式。
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
    var TIERS = ["off", "low", "high", "max"];
    var LABELS = {
      off: "off",
      low: "low",
      high: "high",
      max: "max",
    };
    var TITLES = {
      off: "关闭",
      low: "常规",
      high: "严格",
      max: "极限",
    };
    /** 循环锻造开关：off 不自动点火；std 上限 5 轮；max 上限 8 轮且每轮独立评审。 */
    var FORGE_LEVELS = ["off", "std", "max"];
    var FORGE_LABELS = { off: "off", std: "标准", max: "极限" };
    var FORGE_TITLES = {
      off: "关闭循环",
      std: "标准档：上限 5 轮，第 2 轮独立评审 + 收敛复核",
      max: "极限档：上限 8 轮，第 2 轮起每轮独立评审",
    };
    var STORAGE_KEY = "dsh-clarify-tier";
    var STORAGE_KEY_FORGE = "dsh-forge-level";
    /** v4：删掉原 low（方向），其余降一级——旧 high→low、旧 max→high、旧 ultra→max。 */
    var LEGACY_TIERS = { high: "low", max: "high", ultra: "max" };
    var SCHEMA = 4;
    var DEFAULT_TIER = "low";
    var DEFAULT_FORGE = "off";
    var BRIDGE = "http://127.0.0.1:43871/state";

    function readLocal() {
      try {
        var v = localStorage.getItem(STORAGE_KEY);
        if (v && TIERS.indexOf(v) >= 0) return v;
        if (v && LEGACY_TIERS[v]) {
          var migrated = LEGACY_TIERS[v];
          localStorage.setItem(STORAGE_KEY, migrated);
          return migrated;
        }
      } catch (e) {
        /* 忽略 */
      }
      return null;
    }

    function writeLocal(tier) {
      try {
        localStorage.setItem(STORAGE_KEY, tier);
      } catch (e) {
        /* 忽略 */
      }
    }

    function readForgeLocal() {
      try {
        var v = localStorage.getItem(STORAGE_KEY_FORGE);
        if (v && FORGE_LEVELS.indexOf(v) >= 0) return v;
      } catch (e) {
        /* 忽略 */
      }
      return null;
    }

    function writeForgeLocal(level) {
      try {
        localStorage.setItem(STORAGE_KEY_FORGE, level);
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
      ".dct-cell[data-on='1']{background:#7c6cf0;color:#fff;opacity:1;font-weight:600}",
      ".dct-root[data-axis='forge'] .dct-cell[data-on='1']{background:#e08a2e}",
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

    /** 从宿主桥读取当前状态；失败返回 null（保持本地值）。 */
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
      var initial = readLocal() || DEFAULT_TIER;
      var state = hooks.useState(initial);
      var tier = state[0];
      var setTier = state[1];
      var degraded = hooks.useState(false);
      var isDegraded = degraded[0];
      var setDegraded = degraded[1];

      hooks.useEffect(function () {
        var alive = true;
        fetchRemote().then(function (json) {
          if (!alive) return;
          if (json && TIERS.indexOf(json.tier) >= 0) {
            setTier(json.tier);
            writeLocal(json.tier);
            setDegraded(false);
          } else {
            setDegraded(true);
          }
        });
        return function () {
          alive = false;
        };
      }, []);

      function pick(next) {
        if (TIERS.indexOf(next) < 0) return;
        setTier(next);
        writeLocal(next);
        pushRemote({ tier: next }).then(function (ok) {
          setDegraded(!ok);
        });
      }

      return React.createElement(
        "div",
        {
          className: "dct-root",
          role: "group",
          "aria-label": "需求锚定档位",
          "data-dsh-clarify-tier": "1",
          "data-axis": "clarify",
          "data-degraded": isDegraded ? "1" : "0",
          title: TITLES[tier] || tier,
        },
        TIERS.map(function (t) {
          return React.createElement(
            "button",
            {
              key: t,
              type: "button",
              className: "dct-cell",
              "data-on": t === tier ? "1" : "0",
              "data-tier": t,
              title: TITLES[t],
              "aria-pressed": t === tier ? "true" : "false",
              onClick: function () {
                pick(t);
              },
            },
            LABELS[t],
          );
        }),
      );
    }

    function ForgeBar() {
      var initial = readForgeLocal() || DEFAULT_FORGE;
      var state = hooks.useState(initial);
      var level = state[0];
      var setLevel = state[1];
      var degraded = hooks.useState(false);
      var isDegraded = degraded[0];
      var setDegraded = degraded[1];

      hooks.useEffect(function () {
        var alive = true;
        fetchRemote().then(function (json) {
          if (!alive) return;
          if (json) {
            if (FORGE_LEVELS.indexOf(json.forge) >= 0) {
              setLevel(json.forge);
              writeForgeLocal(json.forge);
            }
            setDegraded(false);
          } else {
            setDegraded(true);
          }
        });
        return function () {
          alive = false;
        };
      }, []);

      function pick(next) {
        if (FORGE_LEVELS.indexOf(next) < 0) return;
        setLevel(next);
        writeForgeLocal(next);
        pushRemote({ forge: next }).then(function (ok) {
          setDegraded(!ok);
        });
      }

      return React.createElement(
        "div",
        {
          className: "dct-root",
          role: "group",
          "aria-label": "循环锻造开关",
          "data-dsh-forge-level": "1",
          "data-axis": "forge",
          "data-degraded": isDegraded ? "1" : "0",
          title: FORGE_TITLES[level] || level,
        },
        FORGE_LEVELS.map(function (t) {
          return React.createElement(
            "button",
            {
              key: t,
              type: "button",
              className: "dct-cell",
              "data-on": t === level ? "1" : "0",
              "data-forge": t,
              title: FORGE_TITLES[t],
              "aria-pressed": t === level ? "true" : "false",
              onClick: function () {
                pick(t);
              },
            },
            FORGE_LABELS[t],
          );
        }),
      );
    }

    var inject = ["slots", "sessions"];

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          var dispose = [];
          dispose.push(
            ctx.slots.register(
              {
                name: SLOT_NAME,
                id: "clarify-tier",
                order: ENTRY_ORDER,
                label: function () {
                  return "需求锚定档位";
                },
                inject: function (sessionId) {
                  return { sessionId: sessionId };
                },
              },
              function SlotComponent() {
                return React.createElement(TierBar, null);
              },
            ),
          );
          dispose.push(
            ctx.slots.register(
              {
                name: SLOT_NAME,
                id: "loop-forge",
                order: ENTRY_ORDER + 1,
                label: function () {
                  return "循环锻造开关";
                },
                inject: function (sessionId) {
                  return { sessionId: sessionId };
                },
              },
              function SlotComponent() {
                return React.createElement(ForgeBar, null);
              },
            ),
          );
          return function () {
            dispose.forEach(function (fn) {
              try {
                if (typeof fn === "function") fn();
              } catch (e) {
                /* 忽略 */
              }
            });
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
      TIERS: TIERS,
      LEGACY_TIERS: LEGACY_TIERS,
      FORGE_LEVELS: FORGE_LEVELS,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ORDER: ENTRY_ORDER,
      DEFAULT_TIER: DEFAULT_TIER,
      DEFAULT_FORGE: DEFAULT_FORGE,
      CSS: CSS,
      TierBar: TierBar,
      ForgeBar: ForgeBar,
    };

    return module.exports;
  },
});
