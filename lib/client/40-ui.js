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
        if (!json || (MODES.indexOf(json.mode) < 0 && LEVELS.indexOf(json.level) < 0 && !json.route && !json.agent))
          return false;
        var remote = normalize(json);
        setValue(remote);
        writeLocal(sessionId, remote);
        if (json.labels) setMeta({ labels: json.labels, titles: json.titles || null });
        setPending(Boolean(json.pending));
        setDegraded(false);
        return true;
      }

      /**
       * 拉一次真值。三种情形：
       * 1) 老宿主没有 knownSession / 或明确认识本会话 → 认领，正常同步
       * 2) 不认识 → 扫端口找认识它的那个；只有一套在跑时直接认（没得选）
       * 3) 两套以上、谁都不认识 → **不认领**：不读不写任何桥，只用本地值（本地值天然属于本应用）
       */
      function pull() {
        return fetchRemote(sessionId).then(function (json) {
          if (!json) {
            ownership.claimed = false;
            setDegraded(true);
            return;
          }
          if (json.knownSession !== false) {
            claim(json);
            return;
          }
          return resolveOwner();
        });
      }

      /** 未认领期间的改动：先记账，认领成功再补写，避免写进别人的状态文件。 */
      var pendingPatch = null;

      /** 认领后落值；顺带把降级标记清掉，并把「未认领期间攒下的改动」补写上去。 */
      function claim(json) {
        ownership.claimed = true;
        var ok = applyState(json);
        if (ok && pendingPatch) {
          var patch = pendingPatch;
          pendingPatch = null;
          pushRemote(sessionId, patch).then(function (res) {
            if (res.status === 200 && res.body && "pending" in res.body) {
              applyState(res.body);
              return;
            }
            pull();
          });
        }
        if (!ok) {
          ownership.claimed = false;
          setDegraded(true);
        }
        return ok;
      }

      /**
       * 谁都不认识这个会话：扫一遍端口。
       * - 有 owner（本实例工具写过）→ 切过去
       * - 只有一套 DSH → 它就是我的
       * - 两套以上 → 认不了，降级为「只存本地」，并按 ownerPollMs 轮询等工具落盘
       */
      var pollTimer = null;
      var disposed = false;
      var pollRound = 0;
      var resolving = null;

      function resolveOwner() {
        // 同一时刻只跑一轮扫描（挂载、聚焦、轮询可能同时触发）
        if (resolving) return resolving;
        resolving = scanInstances(sessionId)
          .then(function (list) {
            var owner = null;
            for (var i = 0; i < list.length; i += 1) {
              if (list[i].known) {
                owner = list[i];
                break;
              }
            }
            if (owner) {
              adoptPort(owner.port);
              pollRound = 0;
              resolving = null;
              return claim(owner.state);
            }
            if (list.length === 1) {
              // 机器上只有一套在跑：不存在「连错实例」，直接认
              adoptPort(list[0].port);
              resolving = null;
              return claim(list[0].state);
            }
            // 两套以上且都没认领：只用本地值，别去碰别人的文件
            ownership.claimed = false;
            setDegraded(true);
            resolving = null;
            if (pollRound < CONFIG.ownerPollTries && !disposed) {
              pollRound += 1;
              pollTimer = setTimeout(function () {
                resolveOwner();
              }, CONFIG.ownerPollMs);
            }
            return null;
          })
          .catch(function () {
            resolving = null;
            return null;
          });
        return resolving;
      }

      hooks.useEffect(function () {
        var alive = true;
        var stream = null;
        var retryTimer = null;
        var tries = 0;
        disposed = false;

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
        // 先认准实例再连 SSE：没认准之前不连，免得收到另一套实例的推送
        pull().then(function () {
          if (alive && ownership.claimed) connect();
        });

        // 兜底：SSE 不可用时，切回窗口重新对齐，避免旧值覆盖新值
        var onFocus = function () {
          if (!stream) pull();
          else if (!ownership.claimed) pull();
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
      var counter = value.counter === true;
      var routeOn = Boolean(value.route && value.route.on === true);
      var routeLevel =
        value.route && ROUTE_LEVELS.indexOf(value.route.level) >= 0 ? value.route.level : DEFAULT_ROUTE_LEVEL;
      var labels = resolveLabels(remoteMeta, mode);
      var titles = resolveTitles(remoteMeta, mode);
      var routeLabels = withFallback(resolveLabels(remoteMeta, "route"), FALLBACK_LABELS.route);
      var agentLabels = withFallback(resolveLabels(remoteMeta, "agent"), FALLBACK_LABELS.agent);
      var agentTitles = withFallback(resolveTitles(remoteMeta, "agent"), FALLBACK_TITLES.agent);
      var agentOn = Boolean(value.agent && value.agent.on === true);
      var agentProfile =
        value.agent && AGENT_PROFILES.indexOf(value.agent.profile) >= 0 ? value.agent.profile : DEFAULT_AGENT_PROFILE;
      // 两个轮换格的显示值（v3.5.0）：关 = 本地 / 默认，不再是「开关 + 两档」两段
      var routeDisplay = routeOn ? routeLevel : "off";
      var agentDisplay = agentOn ? agentProfile : "off";
      var routeTitles = withFallback(resolveTitles(remoteMeta, "route"), FALLBACK_TITLES.route);
      var routeNext = ROUTE_CYCLE[(ROUTE_CYCLE.indexOf(routeDisplay) + 1) % ROUTE_CYCLE.length];
      var agentNext = AGENT_CYCLE[(AGENT_CYCLE.indexOf(agentDisplay) + 1) % AGENT_CYCLE.length];

      /** 只提交变化的那一维：换档不动模式/对抗，切模式不动档位/对抗，切对抗不动前两者。 */
      function commit(patch) {
        var nextRoute = value.route;
        if (patch.route) {
          nextRoute = {
            on: typeof patch.route.on === "boolean" ? patch.route.on : value.route.on,
            level: ROUTE_LEVELS.indexOf(patch.route.level) >= 0 ? patch.route.level : value.route.level,
          };
        }
        var nextAgent = value.agent;
        if (patch.agent) {
          nextAgent = {
            on: typeof patch.agent.on === "boolean" ? patch.agent.on : value.agent.on,
            profile:
              AGENT_PROFILES.indexOf(patch.agent.profile) >= 0 ? patch.agent.profile : value.agent.profile,
          };
        }
        var normalized = normalize({
          mode: patch.mode || mode,
          level: patch.level || level,
          counter: typeof patch.counter === "boolean" ? patch.counter : counter,
          route: nextRoute,
          agent: nextAgent,
        });
        setValue(normalized);
        writeLocal(sessionId, normalized);
        // 没认准实例：先只存本地，记账等认领后再补写（绝不先写别人的状态文件）
        if (!ownership.claimed) {
          pendingPatch = patch;
          setDegraded(true);
          return;
        }
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

      function toggleCounter() {
        commit({ counter: !counter });
      }

      function toggleMode() {
        commit({ mode: loop ? "think" : "loop" });
      }

      /**
       * 检索格轮换（v3.5.0）：本地 → 增量 → 全量 → 本地。
       * 只提交变的那一维：已在增量档时开检索不必再写 level。
       */
      function cycleRoute() {
        if (!routeOn) {
          commit(
            routeLevel === DEFAULT_ROUTE_LEVEL ? { route: { on: true } } : { route: { on: true, level: DEFAULT_ROUTE_LEVEL } },
          );
          return;
        }
        if (routeLevel === "high") {
          commit({ route: { level: "max" } });
          return;
        }
        commit({ route: { on: false } });
      }

      /** 代理格轮换（v3.5.0）：默认 → 效率 → 性能 → 默认。同样只提交变的一维。 */
      function cycleAgent() {
        if (!agentOn) {
          commit(
            agentProfile === DEFAULT_AGENT_PROFILE
              ? { agent: { on: true } }
              : { agent: { on: true, profile: DEFAULT_AGENT_PROFILE } },
          );
          return;
        }
        if (agentProfile === "efficiency") {
          commit({ agent: { profile: "performance" } });
          return;
        }
        commit({ agent: { on: false } });
      }

      var cells = [];
      LEVELS.forEach(function (l) {
        cells.push(
          React.createElement(
            "button",
            {
              key: l,
              type: "button",
              className: "dct-cell",
              "data-on": l === level ? "1" : "0",
              "data-level": l,
              "aria-pressed": l === level ? "true" : "false",
              onClick: function () {
                pickLevel(l);
              },
            },
            labels[l],
          ),
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
            "aria-pressed": loop ? "true" : "false",
            onClick: toggleMode,
          },
          "循环",
        ),
        React.createElement("span", { key: "sep2", className: "dct-sep", "aria-hidden": "true" }),
        React.createElement(
          "button",
          {
            key: "counter",
            type: "button",
            className: "dct-cell dct-counter",
            "data-on": counter ? "1" : "0",
            "data-counter-toggle": counter ? "on" : "off",
            "aria-pressed": counter ? "true" : "false",
            onClick: toggleCounter,
          },
          "对抗",
        ),
        React.createElement("span", { key: "sep3", className: "dct-sep", "aria-hidden": "true" }),
        // 检索格（v3.5.0）：排在选项条末尾，点一下 本地 → 增量 → 全量 → 本地
        React.createElement(
          "button",
          {
            key: "route",
            type: "button",
            className: "dct-cell dct-routecell",
            "data-on": routeOn ? "1" : "0",
            "data-route-cycle": routeDisplay,
            "data-route-level": routeLevel,
            "data-route-toggle": routeOn ? "on" : "off",
            "aria-pressed": routeOn ? "true" : "false",
            title: routeTitles[routeDisplay] + "；点击切到" + routeLabels[routeNext],
            onClick: cycleRoute,
          },
          routeLabels[routeDisplay],
        ),
        React.createElement("span", { key: "sep4", className: "dct-sep", "aria-hidden": "true" }),
        // 代理格（v3.5.0）：末尾第二格，一个格子轮换 默认 → 效率 → 性能 → 默认
        React.createElement(
          "button",
          {
            key: "agent",
            type: "button",
            className: "dct-cell dct-agentcell",
            "data-on": agentOn ? "1" : "0",
            "data-agent-cycle": agentDisplay,
            "data-agent-profile": agentProfile,
            "data-agent-toggle": agentOn ? "on" : "off",
            "aria-pressed": agentOn ? "true" : "false",
            title: agentTitles[agentDisplay] + "；点击切到" + agentLabels[agentNext],
            onClick: cycleAgent,
          },
          agentLabels[agentDisplay],
        ),
      );

      return React.createElement(
        "div",
        {
          className: "dct-root",
          role: "group",
          "aria-label":
            (loop ? "循环档位" : "思考档位") +
            "（含检索·" +
            routeLabels[routeDisplay] +
            "；代理·" +
            agentLabels[agentDisplay] +
            "）",
          "data-dsh-tier": "1",
          "data-mode": mode,
          "data-degraded": isDegraded ? "1" : "0",
          "data-pending": isPending ? "1" : "0",
          "data-counter": counter ? "1" : "0",
          "data-route": routeOn ? "1" : "0",
          "data-route-level": routeLevel,
          "data-route-cycle": routeDisplay,
          "data-agent": agentOn ? "1" : "0",
          "data-agent-profile": agentProfile,
          "data-agent-cycle": agentDisplay,
          // 循环 + 对抗 同开：CSS 靠这一位把前三级条染橙
          "data-mix": loop && counter ? "1" : "0",
        },
        cells,
      );
    }

