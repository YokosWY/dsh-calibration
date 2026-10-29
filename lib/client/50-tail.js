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
      ROUTE_LEVELS: ROUTE_LEVELS,
      ROUTE_CYCLE: ROUTE_CYCLE,
      AGENT_PROFILES: AGENT_PROFILES,
      AGENT_CYCLE: AGENT_CYCLE,
      DEFAULT_AGENT_PROFILE: DEFAULT_AGENT_PROFILE,
      DEFAULT_ROUTE_LEVEL: DEFAULT_ROUTE_LEVEL,
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
      withFallback: withFallback,
      resolveSession: resolveSession,
      bridgeUrl: bridgeUrl,
      scanInstances: scanInstances,
      ownership: ownership,
    };

    return module.exports;
  },
});
