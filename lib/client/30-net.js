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

