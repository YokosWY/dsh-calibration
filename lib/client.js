/**
 * dsh-clarify-tier — 客户端半边
 *
 * 一根框、两个模式：
 *   思考模式：关 | 严 | 极   ‖ 循环
 *   循环模式：轻 | 交付 | 极致 ‖ 循环（亮起）
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

    /*
     * 文案的唯一事实源在宿主（lib/index.js 的 LABELS / TITLES），客户端通过 GET /state 取。
     * 下面这份只在桥不可达时兜底，保证控件仍可用——不参与“改档名”的维护。
     */
    var FALLBACK_LABELS = {
      think: { off: "关闭", high: "严格", max: "极致" },
      loop: { off: "轻量", high: "交付", max: "极致" },
    };
    var FALLBACK_TITLES = {
      think: {
        off: "关闭：不锚定、不循环，直接执行",
        high: "严格：复述 + 2 确认点 + 回滚 + 验收 + 失败分支",
        max: "极致：严格之上再加反例与代价、对抗自检、对抗复审",
      },
      loop: {
        off: "轻量：3 轮纯自检，适合小修小补",
        high: "交付：5 轮，第 2 轮独立评审 + 收敛复核",
        max: "极致：8 轮，第 2 轮起每轮独立评审",
      },
    };

    var STORAGE_KEY = "dsh-tier-mode";
    var DEFAULT_MODE = "think";
    var DEFAULT_LEVEL = "high";
    var DEFAULT_SESSION = "default";
    var PORT_BASE = 43871;
    var PORT_SPAN = 10; // 与宿主一致：43871..43880
    var PORT_KEY = "dsh-tier-port";
    var DEBUG_KEY = "dsh-tier-debug";
    var bridgePort = null;

    /*
     * 可调项（测试会改，也别有洞天）：
     * - portMissTtl：一轮 11 个端口全探空后，多久内不再重扫（避免每次点击都打 11 个 fetch）
     * - reconnectDelay / maxReconnects：SSE 判定断开后，隔多久重建、最多重建几次
     * - ownerCheckTtl：发现当前桥不认识本会话时，复核实例的最小间隔
     * - ownerPollMs / ownerPollTries：一直没认领上时，多久重试一次、最多几轮（约 1 分钟）
     * - debug：默认关。开着时每次启动会往宿主写 jsonl，文件没有轮转，别长期开
     */
    var CONFIG = {
      portMissTtl: 3000,
      reconnectDelay: 2000,
      maxReconnects: 3,
      ownerCheckTtl: 3000,
      ownerPollMs: 5000,
      ownerPollTries: 12,
      debug: false,
    };

    function readPortLocal() {
      try {
        var v = parseInt(localStorage.getItem(PORT_KEY) || "", 10);
        return v > 0 ? v : null;
      } catch (e) {
        return null;
      }
    }

    function writePortLocal(port) {
      try {
        localStorage.setItem(PORT_KEY, String(port));
      } catch (e) {
        /* 忽略 */
      }
    }

    function portUrl(port, sessionId, path) {
      return "http://127.0.0.1:" + port + (path || "/state") + "?session=" + encodeURIComponent(sessionId);
    }

    function probePort(port) {
      return fetch(portUrl(port, "probe", "/state"), { method: "GET", credentials: "omit", cache: "no-store" })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (json) {
          return json && json.plugin === "dsh-clarify-tier" ? port : null;
        })
        .catch(function () {
          return null;
        });
    }

    /** 依次探测端口，认 `plugin` 标记，避免两套 DSH 抢 43871。 */
    function discoverPort() {
      return candidates()
        .reduce(function (chain, port) {
          return chain.then(function (found) {
            if (found) return found;
            return probePort(port);
          });
        }, Promise.resolve(null))
        .then(function (found) {
          if (found) adoptPort(found);
          return found;
        });
    }

    function candidates() {
      var list = [];
      var cached = readPortLocal();
      if (cached) list.push(cached);
      for (var i = 0; i < PORT_SPAN; i += 1) {
        var port = PORT_BASE + i;
        if (list.indexOf(port) < 0) list.push(port);
      }
      return list;
    }

    /** 读某端口的完整状态（认 `plugin` 标记）。只读，不写任何东西。 */
    function probeState(port, sessionId) {
      return fetch(portUrl(port, sessionId, "/state"), { method: "GET", credentials: "omit", cache: "no-store" })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (json) {
          return json && json.plugin === "dsh-clarify-tier" ? json : null;
        })
        .catch(function () {
          return null;
        });
    }

    function adoptPort(port) {
      bridgePort = port;
      portMissAt = 0;
      writePortLocal(port);
    }

    /**
     * 两套 DSH 都跑本插件时，`plugin` 标记分不出谁是谁（端口都认）。
     * 用「这次会话在谁的状态文件里」认领：只有本实例的桥才认识这个 sessionId。
     */
    function findOwner(sessionId) {
      return candidates()
        .reduce(function (chain, port) {
          return chain.then(function (found) {
            if (found) return found;
            return probeState(port, sessionId).then(function (json) {
              return json && json.knownSession === true ? port : null;
            });
          });
        }, Promise.resolve(null));
    }

    /** 探空一次就记住时间：TTL 内不再重扫，别让每次点击都变成 11 个 fetch。 */
    var portMissAt = 0;

    /** 同一时刻只允许一轮发现（挂载时 pull 与 SSE 会同时要端口）。 */
    var discovering = null;

    /** 端口失效（宿主重启换了端口、或连接被拒）：丢掉缓存，下次重新发现。 */
    function invalidatePort() {
      bridgePort = null;
    }

    function ensurePort() {
      if (bridgePort) return Promise.resolve(bridgePort);
      if (portMissAt && Date.now() - portMissAt < CONFIG.portMissTtl) return Promise.resolve(null);
      if (!discovering) {
        discovering = discoverPort().then(function (found) {
          portMissAt = found ? 0 : Date.now();
          discovering = null;
          return found;
        });
      }
      return discovering;
    }

    /** 会话键：优先插槽给的 sessionId；退回 URL 里的 id；再退回 default。 */
    function resolveSession(props) {
      try {
        if (props && typeof props.sessionId === "string" && props.sessionId) return props.sessionId;
      } catch (e) {
        /* 忽略 */
      }
      try {
        if (typeof location !== "undefined" && location && typeof location.href === "string") {
          var match = location.href.match(/session[-/]([0-9a-zA-Z-]{8,})/);
          if (match) return match[1];
        }
      } catch (e) {
        /* 忽略 */
      }
      return DEFAULT_SESSION;
    }

    function storageKey(sessionId) {
      return STORAGE_KEY + ":" + sessionId;
    }

    function bridgeUrl(sessionId, path) {
      return portUrl(bridgePort || readPortLocal() || PORT_BASE, sessionId, path);
    }

    /** 容器 title：离线与「下轮生效」是两件事，同时成立时都要说清楚。 */
    function barTitle(isPending, isDegraded, loop) {
      var parts = [];
      if (isDegraded) parts.push("离线：改动只存本地，没有同步到宿主");
      if (isPending) parts.push("本轮仍用开工时的档位，这次改动下一轮生效");
      if (!parts.length) parts.push(loop ? "循环模式" : "思考模式");
      return parts.join("；");
    }

    /** 文案优先用 /state 下发的表，桥挂掉才用本地兜底。 */
    function resolveLabels(meta, mode) {
      if (meta && meta.labels && meta.labels[mode]) return meta.labels[mode];
      return FALLBACK_LABELS[mode] || FALLBACK_LABELS.think;
    }

    function resolveTitles(meta, mode) {
      if (meta && meta.titles && meta.titles[mode]) return meta.titles[mode];
      return FALLBACK_TITLES[mode] || FALLBACK_TITLES.think;
    }

    function normalize(value) {
      var mode = value && MODES.indexOf(value.mode) >= 0 ? value.mode : DEFAULT_MODE;
      var level = value && LEVELS.indexOf(value.level) >= 0 ? value.level : DEFAULT_LEVEL;
      return { mode: mode, level: level };
    }

    function readLocal(sessionId) {
      try {
        var raw = localStorage.getItem(storageKey(sessionId));
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

    function writeLocal(sessionId, state) {
      try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(state));
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
      ".dct-root[data-pending='1']::after{content:'·';opacity:.85;color:#e08a2e;font-size:16px;",
      "padding-inline:3px;line-height:1;font-weight:700}",
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

    function fetchRemote(sessionId) {
      return ensurePort()
        .then(function (port) {
          if (!port) return null;
          return fetch(portUrl(port, sessionId, "/state"), { method: "GET", credentials: "omit", cache: "no-store" })
            .then(function (res) {
              // 端口上有东西但不是本插件（旧实例 / 别人的 404）：丢掉缓存，下次重新发现
              if (!res.ok) {
                invalidatePort();
                return null;
              }
              return res.json();
            })
            .then(function (json) {
              return json && typeof json === "object" ? json : null;
            })
            .catch(function () {
              invalidatePort();
              return null;
            });
        })
        .catch(function () {
          return null;
        });
    }

    /**
     * 写回宿主。返回 `{ status, body }`：宿主 1.2.1 起在 POST 响应里直接带档位与 pending，
     * 客户端能省掉一次 GET（老宿主回 `{ok,session,mode,level}`，那就按没有 pending 处理）。
     */
    function pushRemote(sessionId, patch) {
      return ensurePort()
        .then(function (port) {
          if (!port) return { status: 0, body: null };
          return fetch(portUrl(port, sessionId, "/state"), {
            method: "POST",
            credentials: "omit",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          })
            .then(function (res) {
              var code = typeof res.status === "number" ? res.status : res.ok === false ? 0 : 200;
              var body = null;
              try {
                body = res.json ? res.json() : null;
              } catch (e) {
                body = null;
              }
              return Promise.resolve(body)
                .then(function (json) {
                  return { status: code, body: json && typeof json === "object" ? json : null };
                })
                .catch(function () {
                  return { status: code, body: null };
                });
            })
            .catch(function () {
              invalidatePort();
              return { status: 0, body: null };
            });
        })
        .catch(function () {
          return { status: 0, body: null };
        });
    }

    function TierBar(props) {
      var sessionId = resolveSession(props);
      var initial = readLocal(sessionId);
      var state = hooks.useState(initial);
      var value = state[0];
      var setValue = state[1];
      var degraded = hooks.useState(false);
      var isDegraded = degraded[0];
      var setDegraded = degraded[1];
      var meta = hooks.useState(null);
      var remoteMeta = meta[0];
      var setMeta = meta[1];
      var pend = hooks.useState(false);
      var isPending = pend[0];
      var setPending = pend[1];

      /** 统一落值入口：本地缓存、pending、降级标记都从这一条走。 */
      function applyState(json) {
        if (!json || (MODES.indexOf(json.mode) < 0 && LEVELS.indexOf(json.level) < 0)) return false;
        var remote = normalize(json);
        setValue(remote);
        writeLocal(sessionId, remote);
        if (json.labels) setMeta({ labels: json.labels, titles: json.titles || null });
        setPending(Boolean(json.pending));
        setDegraded(false);
        return true;
      }

      /** 拉一次真值；拉不到就保持降级，不动本地值。 */
      function pull() {
        return fetchRemote(sessionId).then(function (json) {
          if (!applyState(json)) setDegraded(true);
          // 当前桥不认识本会话：可能挂错实例了，顺手复核一次（有节流，别每题都扫）
          if (json && json.knownSession === false) scheduleOwnerCheck();
        });
      }

      /** 复核实例的节流：CONFIG.ownerCheckTtl 内最多一次。 */
      var ownerCheckAt = 0;
      function scheduleOwnerCheck() {
        var now = Date.now();
        if (ownerCheckAt && now - ownerCheckAt < CONFIG.ownerCheckTtl) return;
        ownerCheckAt = now;
        verifyOwner();
      }

      /**
       * 认领实例：如果当前桥不认识本会话（knownSession=false），说明可能挂到了另一套 DSH 上。
       * 扫一遍端口，找到认识本会话的那个就切过去；一个都还没认领时按 ownerPollMs 轮询几轮
       * （本轮的第一次工具调用会把它写进正确的实例，几秒内就能纠回来）。
       * 老宿主不带该字段 → 直接当已认领，维持现状。
       */
      var pollTimer = null;
      var disposed = false;

      function verifyOwner(attempt) {
        var round = attempt || 0;
        return fetchRemote(sessionId)
          .then(function (state) {
            if (state && state.knownSession !== false) return true;
            if (!state) return false;
            return findOwner(sessionId).then(function (port) {
              if (port) {
                adoptPort(port);
                return fetchRemote(sessionId).then(function (next) {
                  applyState(next);
                  return true;
                });
              }
              if (round < CONFIG.ownerPollTries && !disposed) {
                pollTimer = setTimeout(function () {
                  verifyOwner(round + 1);
                }, CONFIG.ownerPollMs);
              }
              return false;
            });
          })
          .catch(function () {
            return false;
          });
      }

      hooks.useEffect(function () {
        var alive = true;
        var stream = null;
        var retryTimer = null;
        var tries = 0;
        disposed = false;

        pull();

        // 服务端推送：别的窗口改档后立刻跟上，不用等切窗口
        function connect() {
          ensurePort()
            .then(function (port) {
              if (!alive || !port || typeof EventSource === "undefined") return;
              try {
                if (stream) stream.close();
              } catch (e) {
                /* 忽略 */
              }
              stream = new EventSource(portUrl(port, sessionId, "/events"));
              stream.onmessage = function (event) {
                if (!alive) return;
                try {
                  if (applyState(JSON.parse(event.data))) tries = 0;
                } catch (e) {
                  /* 坏帧忽略 */
                }
              };
              stream.onerror = function () {
                if (!alive) return;
                // readyState=2：连接被彻底关掉，浏览器不会自己重连，得重建一条。
                // 端口也可能换了（宿主重启），顺手作废缓存。
                if (!stream || stream.readyState !== 2) return;
                setDegraded(true);
                invalidatePort();
                if (tries >= CONFIG.maxReconnects) return;
                tries += 1;
                try {
                  stream.close();
                } catch (e) {
                  /* 忽略 */
                }
                retryTimer = setTimeout(connect, CONFIG.reconnectDelay);
              };
            })
            .catch(function () {
              stream = null;
            });
        }
        // 先认准实例再连 SSE：两套 DSH 同时开时，端口标记分不出谁是谁
        verifyOwner()
          .then(function () {
            if (alive) connect();
          })
          .catch(function () {
            if (alive) connect();
          });

        // 兜底：SSE 不可用时，切回窗口重新对齐，避免旧值覆盖新值
        var onFocus = function () {
          if (!stream) pull();
          verifyOwner();
        };
        try {
          if (typeof window !== "undefined" && window.addEventListener) {
            window.addEventListener("focus", onFocus);
          }
        } catch (e) {
          /* 忽略 */
        }
        return function () {
          alive = false;
          disposed = true;
          if (pollTimer) {
            try {
              clearTimeout(pollTimer);
            } catch (e) {
              /* 忽略 */
            }
          }
          if (retryTimer) {
            try {
              clearTimeout(retryTimer);
            } catch (e) {
              /* 忽略 */
            }
          }
          try {
            if (stream) stream.close();
          } catch (e) {
            /* 忽略 */
          }
          try {
            if (typeof window !== "undefined" && window.removeEventListener) {
              window.removeEventListener("focus", onFocus);
            }
          } catch (e) {
            /* 忽略 */
          }
        };
      }, [sessionId]);

      var mode = value.mode;
      var level = value.level;
      var loop = mode === "loop";
      var labels = resolveLabels(remoteMeta, mode);
      var titles = resolveTitles(remoteMeta, mode);

      /** 只提交变化的那一维：换档不动模式，切模式不动档位。 */
      function commit(patch) {
        var normalized = normalize({
          mode: patch.mode || mode,
          level: patch.level || level,
        });
        setValue(normalized);
        writeLocal(sessionId, normalized);
        pushRemote(sessionId, patch).then(function (res) {
          if (res.status !== 200) {
            setDegraded(true);
            pull(); // 写失败：以宿主里的值为准
            return;
          }
          // 宿主 1.2.1 起在 POST 响应里直接带 pending / turnLocked：省掉这次点击后的第二次 GET。
          // 老宿主不回 pending，就退回拉一次。
          if (res.body && "pending" in res.body && applyState(res.body)) return;
          pull();
        });
      }

      function pickLevel(next) {
        if (LEVELS.indexOf(next) < 0) return;
        commit({ level: next });
      }

      function toggleMode() {
        commit({ mode: loop ? "think" : "loop" });
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
          "data-pending": isPending ? "1" : "0",
          title: barTitle(isPending, isDegraded, loop),
        },
        cells,
      );
    }

    var inject = ["slots", "sessions"];

    /** 诊断开着吗：默认关，`localStorage.setItem("dsh-tier-debug","1")` 后才往宿主写 jsonl（那个文件没有轮转）。 */
    function debugOn() {
      if (CONFIG.debug) return true;
      try {
        return localStorage.getItem(DEBUG_KEY) === "1";
      } catch (e) {
        return false;
      }
    }

    /** 诊断：把注册过程中的事件回报宿主（定位插槽问题用，默认关闭）。 */
    function report(event, extra) {
      if (!debugOn()) return;
      try {
        fetch(bridgeUrl("client", "/debug"), {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: event,
            extra: extra || null,
            href: typeof location !== "undefined" ? String(location.href).slice(0, 160) : null,
          }),
        }).catch(function () {});
      } catch (e) {
        /* 忽略 */
      }
    }

    var registered = false;

    /** 依次尝试候选插槽：新版本改过槽名，谁在就用谁。 */
    function trySlot(ctx, name, label) {
      if (registered) return;
      try {
        report("inject-call", { slot: name });
        ctx.slots.inject(name, function () {
          report("inject-fired", { slot: name });
          if (registered) return;
          try {
            ctx.slots.register(
              {
                name: name,
                id: "tier-bar",
                order: 10,
                label: function () {
                  return label;
                },
                inject: function (sessionId) {
                  return { sessionId: sessionId };
                },
              },
              function SlotComponent(props) {
                return React.createElement(TierBar, { sessionId: props && props.sessionId });
              },
            );
            registered = true;
            report("registered", { slot: name });
          } catch (error) {
            report("register-error", { slot: name, message: String((error && error.message) || error) });
          }
        });
      } catch (error) {
        report("inject-error", { slot: name, message: String((error && error.message) || error) });
      }
    }

    function apply(ctx) {
      installStyles();
      if (debugOn()) {
        report("apply", {
          slotsApi: (function () {
            try {
              return ctx && ctx.slots ? Object.keys(ctx.slots).slice(0, 40) : null;
            } catch (e) {
              return null;
            }
          })(),
          sessionsApi: (function () {
            try {
              return ctx && ctx.sessions ? Object.keys(ctx.sessions).slice(0, 40) : null;
            } catch (e) {
              return null;
            }
          })(),
        });
      }
      var candidates = ["conversation.input.right", "conversation.input.dock", "conversation.input.left"];
      trySlot(ctx, candidates[0], "档位（思考 / 循环）");
      try {
        setTimeout(function () {
          trySlot(ctx, candidates[1], "档位（思考 / 循环）");
        }, 900);
        setTimeout(function () {
          trySlot(ctx, candidates[2], "档位（思考 / 循环）");
        }, 1800);
      } catch (e) {
        /* 忽略 */
      }
    }

    installStyles();

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      LEVELS: LEVELS,
      MODES: MODES,
      FALLBACK_LABELS: FALLBACK_LABELS,
      FALLBACK_TITLES: FALLBACK_TITLES,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ORDER: ENTRY_ORDER,
      DEFAULT_MODE: DEFAULT_MODE,
      DEFAULT_LEVEL: DEFAULT_LEVEL,
      CONFIG: CONFIG,
      CSS: CSS,
      TierBar: TierBar,
      barTitle: barTitle,
      debugOn: debugOn,
      invalidatePort: invalidatePort,
      resolveLabels: resolveLabels,
      resolveTitles: resolveTitles,
      resolveSession: resolveSession,
      bridgeUrl: bridgeUrl,
    };

    return module.exports;
  },
});
