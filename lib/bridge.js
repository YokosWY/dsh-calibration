/**
 * dsh-clarify-tier — 回环桥（HTTP + SSE）
 *
 * 只绑 127.0.0.1，端口在 43871–43880 里退让；带 Origin 的请求只放行本机页面与 dsh-app://。
 * POST /state 的响应刻意回带 pending / turnLocked：客户端点一次档就不用再补一次 GET。
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PACKAGE_ID,
  MODES,
  LEVELS,
  PORT,
  PORT_SPAN,
  LOCAL_HOSTS,
  STATE_FILE,
  sanitizeSession,
  setBroadcaster,
} from "./core.js";
import { readStore, sessionState, writeSession, publicState } from "./state.js";

export function originAllowed(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    // Web 客户端的真实 Origin 是自定义协议 dsh-app://app，不是 127.0.0.1
    if (url.protocol === "dsh-app:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function startBridge(log) {
  /** session → Set<res>；只在同一会话的窗口之间同步。 */
  const streams = new Map();
  function broadcast(sessionId, state) {
    const bucket = streams.get(sessionId);
    if (!bucket) return;
    const frame = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of bucket) {
      try {
        client.write(frame);
      } catch {
        bucket.delete(client);
      }
    }
  }
  setBroadcaster(broadcast);
  const heartbeat = setInterval(() => {
    for (const bucket of streams.values()) {
      for (const client of bucket) {
        try {
          client.write(": ping\n\n");
        } catch {
          bucket.delete(client);
        }
      }
    }
  }, 25000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin);
    const headers = {
      ...(allowed && origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    };

    if (!allowed) {
      res.writeHead(403, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "origin not allowed" }));
      return;
    }

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "bad url" }));
      return;
    }
    const sessionId = sanitizeSession(url.searchParams.get("session"));

    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        ...headers,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      res.write(`data: ${JSON.stringify(publicState(sessionId))}\n\n`);
      if (!streams.has(sessionId)) streams.set(sessionId, new Set());
      streams.get(sessionId).add(res);
      req.on("close", () => {
        const bucket = streams.get(sessionId);
        if (!bucket) return;
        bucket.delete(res);
        if (bucket.size === 0) streams.delete(sessionId);
      });
      return;
    }
    if (url.pathname === "/debug" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 8192) req.destroy();
      });
      req.on("end", () => {
        try {
          const line = `{"at":"${new Date().toISOString()}","body":${raw.slice(0, 4000)}}
`;
          writeFileSync(join(dirname(STATE_FILE), "clarify-tier-debug.jsonl"), line, { flag: "a" });
          log(`debug: ${raw.slice(0, 400)}`);
        } catch (error) {
          log(`debug 写入失败：${String(error)}`);
        }
        res.writeHead(204, headers);
        res.end();
      });
      return;
    }
    if (url.pathname === "/state" && req.method === "GET") {
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(publicState(sessionId)));
      return;
    }
    if (url.pathname === "/state" && req.method === "POST") {
      const type = String(req.headers["content-type"] || "").toLowerCase();
      if (!type.startsWith("application/json")) {
        res.writeHead(415, { ...headers, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "content-type must be application/json" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        let patch;
        try {
          patch = body.trim() === "" ? {} : JSON.parse(body);
        } catch {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }
        const isObject = patch && typeof patch === "object" && !Array.isArray(patch);
        if (!isObject) {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "body must be a JSON object" }));
          return;
        }
        const badKey =
          ("mode" in patch && !MODES.includes(patch.mode)) ||
          ("level" in patch && !LEVELS.includes(patch.level)) ||
          ("counter" in patch && typeof patch.counter !== "boolean");
        if (badKey) {
          res.writeHead(400, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "invalid mode or level", modes: MODES, levels: LEVELS }));
          return;
        }
        const saved = writeSession(sessionId, patch, { owner: "client" });
        if (!saved.ok) {
          log(`落盘失败（${sessionId}）：${saved.error}`);
          res.writeHead(500, { ...headers, "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "write failed", detail: saved.error }));
          return;
        }
        const current = sessionState(readStore(), sessionId);
        const snapshot = {
          session: sessionId,
          mode: saved.mode,
          level: saved.level,
          counter: saved.counter === true,
          pending: Boolean(current.turn && (current.turn.mode !== saved.mode || current.turn.level !== saved.level)),
          turnLocked: Boolean(current.turn),
          updatedAt: saved.updatedAt,
        };
        broadcast(sessionId, snapshot);
        res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
        // 响应体带 pending / turnLocked：客户端点一次档就够，不用再 GET 一次
        res.end(JSON.stringify({ ...saved, ...snapshot }));
      });
      return;
    }
    res.writeHead(404, headers);
    res.end("not found");
  });
  server.on("error", (error) => {
    // 启动期的 EADDRINUSE 由 listenAt 的 onError 记（会说清试了哪个端口），这里只捞运行期错误
    if (!chosenPort) return;
    log(`桥接错误：${String(error)}`);
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const bucket of streams.values()) {
      for (const client of bucket) {
        try {
          client.end();
        } catch {
          /* 忽略 */
        }
      }
    }
    streams.clear();
  });
  let chosenPort = null;
  const listenAt = (index) => {
    if (index >= PORT_SPAN) {
      log(`桥接端口 ${PORT}..${PORT + PORT_SPAN - 1} 全被占用，控件会退化为只读`);
      return;
    }
    const port = PORT + index;
    const onError = (error) => {
      server.removeListener("error", onError);
      log(`端口 ${port} 不可用（${error && error.code ? error.code : String(error)}），试下一个`);
      listenAt(index + 1);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      // 同一个 server 上重试 listen 时，前一次失败那回的 listen 回调也会被一起触发；
      // 以 address() 的实际端口为准，否则日志会写“就绪 43871”而其实绑的是 43872。
      const addr = typeof server.address === "function" ? server.address() : null;
      const boundPort = addr && typeof addr === "object" ? addr.port : null;
      if (boundPort !== port) return;
      chosenPort = port;
      log(`桥接就绪 http://127.0.0.1:${port}/state`);
      if (typeof server.unref === "function") server.unref();
    });
  };
  listenAt(0);
  server.__chosenPort = () => chosenPort;
  return server;
}
