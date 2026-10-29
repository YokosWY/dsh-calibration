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
          return json && json.plugin === "dsh-calibration" ? port : null;
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
          return json && json.plugin === "dsh-calibration" ? json : null;
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
     * 扫一遍端口，把「有没有本插件、认不认识本会话」全收回来。
     * 两套 DSH 都跑本插件时，`plugin` 标记分不出谁是谁（端口都认），
     * 只有「认识这个会话」（owner=tool）的那个才算本实例。
     */
    function scanInstances(sessionId) {
      var found = [];
      return candidates()
        .reduce(function (chain, port) {
          return chain.then(function () {
            return probeState(port, sessionId).then(function (json) {
              if (json) found.push({ port: port, known: json.knownSession === true, state: json });
            });
          });
        }, Promise.resolve())
        .then(function () {
          return found;
        });
    }

    /** 本窗口是否已认准实例：未认准前不读不写任何桥，只用本地值。 */
    var ownership = { claimed: false };

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
    function barTitle(isPending, isDegraded, loop, counter, routeOn, routeLabel, agentOn, agentLabel) {
      var parts = [];
      if (isDegraded) parts.push("离线：改动只存本地，没有同步到宿主");
      if (isPending) parts.push("本轮仍用开工时的设置，这次改动下一轮生效");
      if (!parts.length) parts.push(loop ? "循环模式" : "思考模式");
      if (counter) parts.push("对抗审开");
      if (routeOn) parts.push("检索开：" + routeLabel);
      if (agentOn) parts.push("代理开：" + agentLabel);
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

    /**
     * 逐键合并兜底：宿主是旧版时可能少发 v3.5.0 新加的 off 显示名（本地 / 默认），
     * 少哪一档就补哪一档，免得轮换格那一下变成空白（客户端先于宿主更新时也会遇到）。
     */
    function withFallback(table, fallback) {
      var out = {};
      for (var k in fallback) out[k] = table && table[k] ? table[k] : fallback[k];
      return out;
    }

    function normalizeRoute(value) {
      // 只认 value.route：整份状态里的 level 是思考档，不能漏进检索档（SSE 只推 mode/level 时最容易踩）
      var src = value && value.route && typeof value.route === "object" ? value.route : {};
      return {
        on: src.on === true,
        level: ROUTE_LEVELS.indexOf(src.level) >= 0 ? src.level : DEFAULT_ROUTE_LEVEL,
      };
    }

    function normalizeAgent(value) {
      var src = value && value.agent && typeof value.agent === "object" ? value.agent : {};
      return {
        on: src.on === true,
        profile: AGENT_PROFILES.indexOf(src.profile) >= 0 ? src.profile : DEFAULT_AGENT_PROFILE,
      };
    }

    function normalize(value) {
      var mode = value && MODES.indexOf(value.mode) >= 0 ? value.mode : DEFAULT_MODE;
      var level = value && LEVELS.indexOf(value.level) >= 0 ? value.level : DEFAULT_LEVEL;
      return {
        mode: mode,
        level: level,
        counter: Boolean(value && value.counter === true),
        route: normalizeRoute(value),
        agent: normalizeAgent(value),
      };
    }

    function readLocal(sessionId) {
      try {
        var raw = localStorage.getItem(storageKey(sessionId));
        if (raw) {
          var parsed = JSON.parse(raw);
          if (
            parsed &&
            (MODES.indexOf(parsed.mode) >= 0 ||
              LEVELS.indexOf(parsed.level) >= 0 ||
              parsed.route ||
              parsed.agent)
          ) {
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

