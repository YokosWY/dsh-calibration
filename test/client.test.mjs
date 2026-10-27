// 客户端半边：四格结构、两套标签、只提交变化维度、兜底文案与宿主表一致。
// 运行：npm test
import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TIER_LABELS, TIER_TITLES } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const CODE = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

function boot(remote = { mode: "think", level: "high", plugin: "dsh-calibration" }, options = {}) {
  const registerCalls = [];
  const posts = [];
  const debugs = [];
  const fetches = [];
  const listeners = [];
  const streams = [];
  const store = new Map();
  if (options.local) for (const [k, v] of Object.entries(options.local)) store.set(k, String(v));
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.onmessage = null;
      this.onerror = null;
      streams.push(this);
    }
    close() {
      this.readyState = 2;
    }
  }
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat ? children.flat() : children,
    }),
    useState: (init) => [init, () => {}],
    // 不立刻执行 cleanup：否则 focus 监听刚挂上就被拆掉，测不到
    useEffect: (fn) => {
      fn();
    },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (cfg) => { sandbox.__loaded = cfg; } },
      addEventListener: (type) => { listeners.push(type); },
      removeEventListener: () => {},
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: "", textContent: "" }),
      head: { appendChild: () => {} },
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    fetch: (url, init) => {
      const method = (init && init.method) || "GET";
      const target = String(url);
      fetches.push({ url: target, method });
      if (target.includes("/debug")) {
        debugs.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null) });
      }
      if (method === "POST") {
        posts.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(options.postBody || {}) });
      }
      if (options.failGet) return Promise.reject(new Error("ECONNREFUSED"));
      // 按端口返回不同状态：模拟两套 DSH 各有一个桥
      const byPort = options.stateByPort || {};
      const port = Number((target.match(/:(\d+)\//) || [])[1]);
      if (options.onlyPorts && !options.onlyPorts.includes(port)) {
        return Promise.reject(new Error("ECONNREFUSED")); // 该端口没有实例在跑
      }
      const payload = byPort[port] || remote;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...payload }) });
    },
    console,
    Promise,
    setTimeout,
    EventSource: FakeEventSource,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: "client.js" });

  const mod = sandbox.__loaded.factory(() => React);
  const ctx = {
    slots: {
      inject: (name, cb) => cb(),
      register: (cfg, comp) => {
        registerCalls.push({ cfg, comp });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  return {
    mod,
    store,
    posts,
    debugs,
    fetches,
    registerCalls,
    loadedId: sandbox.__loaded.id,
    listeners,
    streams,
    render: (sessionId = "s-alpha") => {
      const el = registerCalls[0].comp({ sessionId });
      return el.type(el.props);
    },
  };
}

test("模块 id 等于包名（防 duplicate factory）", () => {
  assert.equal(boot().loadedId, "@local/dsh-calibration-tier");
});

test("只注册一条插槽，order=10，槽位正确", () => {
  const env = boot();
  assert.equal(env.registerCalls.length, 1);
  assert.equal(env.registerCalls[0].cfg.id, "tier-bar");
  assert.equal(env.registerCalls[0].cfg.order, 10);
  assert.equal(env.registerCalls[0].cfg.name, "conversation.input.right");
});

test("悬停解释已移除：档位格与两个开关都不带 title", async () => {
  const tree = boot().render();
  await tick();
  for (const [i, child] of tree.children.entries()) {
    if (child.props && child.props.className && child.props.className.includes("dct-sep")) continue;
    assert.equal("title" in child.props, false, `第 ${i} 个子节点还带 title`);
  }
  assert.equal("title" in tree.props, false, "根节点还带 title");
});

test("思考模式：3 档 + 3 隔离线 + 循环 + 对抗 + 检索，标签二字", async () => {
  const tree = boot().render();
  await tick();
  assert.equal(tree.props["data-mode"], "think");
  assert.equal(tree.children.length, 9, "3 档 + 隔离线 + 循环 + 隔离线 + 对抗 + 隔离线 + 检索");
  assert.equal(tree.children[3].props.className, "dct-sep");
  assert.equal(tree.children[5].props.className, "dct-sep");
  assert.equal(tree.children[7].props.className, "dct-sep");
  const labels = tree.children.slice(0, 3).map((c) => c.children[0]);
  assert.deepEqual(labels, ["常规", "严格", "极致"]);
  assert.equal(tree.children[4].children[0], "循环");
  assert.equal(tree.children[6].children[0], "对抗");
  assert.equal(tree.children[8].children[0], "检索");
});

test("循环模式：标签换成循环档，循环格亮起", async () => {
  const env = boot();
  env.store.set("dsh-tier-mode:s-alpha", JSON.stringify({ mode: "loop", level: "max" }));
  const tree = env.render();
  await tick();
  assert.equal(tree.props["data-mode"], "loop");
  const labels = tree.children.slice(0, 3).map((c) => c.children[0]);
  assert.deepEqual(labels, ["轻量", "交付", "极致"]);
  assert.equal(tree.children[4].props["data-on"], "1");
  assert.equal(tree.children[4].props["data-mode-toggle"], "loop");
});

test("挂载时注册 focus 刷新（双窗对齐）", () => {
  const env = boot();
  env.render(); // effect 在组件首次渲染时才跑
  assert.ok(env.listeners.includes("focus"));
});

test("用 SSE 接收其他窗口的改动并落本地", async () => {
  const env = boot();
  env.render();
  await tick(40);
  assert.equal(env.streams.length, 1, "应建立一条 SSE 连接");
  assert.match(env.streams[0].url, /\/events\?session=s-alpha$/);
  env.streams[0].onmessage({ data: JSON.stringify({ mode: "loop", level: "max" }) });
  assert.deepEqual(JSON.parse(env.store.get("dsh-tier-mode:s-alpha")), {
    mode: "loop",
    level: "max",
    counter: false,
    route: { on: false, level: "high" },
  });
  env.streams[0].onmessage({ data: "{bad" }); // 坏帧不许抛
});

test("点档位只提交 level，点循环只提交 mode", async () => {
  const env = boot();
  const tree = env.render();
  await tick();
  tree.children[0].props.onClick(); // 常规（值 off）
  await tick();
  assert.deepEqual(env.posts.at(-1), { level: "off" });
  env.render().children[4].props.onClick(); // 循环
  await tick();
  assert.deepEqual(env.posts.at(-1), { mode: "loop" });
});

test("文案优先用 /state 下发，桥缺失才用兜底", () => {
  const { resolveLabels, resolveTitles } = boot().mod.__internals;
  const meta = { labels: { think: { off: "甲", high: "乙", max: "丙" } }, titles: { think: { high: "乙的说明" } } };
  assert.equal(resolveLabels(meta, "think").high, "乙");
  assert.equal(resolveTitles(meta, "think").high, "乙的说明");
  assert.equal(resolveLabels(null, "loop").off, "轻量");
  assert.equal(resolveTitles(null, "loop").max.includes("8 轮"), true);
});

test("兜底文案与宿主表逐字一致", () => {
  const { FALLBACK_LABELS, FALLBACK_TITLES } = boot().mod.__internals;
  assert.deepEqual(FALLBACK_LABELS, TIER_LABELS);
  assert.deepEqual(FALLBACK_TITLES, TIER_TITLES);
});

test("样式：三色走变量（柔雾调）、隔离线、待生效小点存在", () => {
  const { CSS } = boot().mod.__internals;
  assert.match(CSS, /--dct-think:#877be3;--dct-loop:#66ae7c;--dct-counter:#da7f7f/);
  assert.match(CSS, /data-mode='loop'\] \.dct-cell\[data-on='1'\]:not\(\.dct-counter\)\{background:var\(--dct-loop\)\}/);
  assert.match(CSS, /\.dct-sep\{/);
  assert.match(CSS, /\.dct-mode\[data-on='1'\]/);
  assert.match(CSS, /data-pending='1'/);
  assert.match(CSS, /\.dct-counter\[data-on='1'\]\{background:var\(--dct-counter\)/);
});

test("样式：循环 + 对抗 同开的雾橙也只定义一次，且只打在三级条的选中格上", () => {
  const { CSS } = boot().mod.__internals;
  assert.match(CSS, /--dct-mix:#cf8a4a/, "雾橙要跟三色一样收在变量里");
  assert.match(
    CSS,
    /data-mix='1'\] \.dct-cell\[data-level\]\[data-on='1'\]\{background:var\(--dct-mix\)\}/,
    "选中那一格要实心橙",
  );
  assert.equal(/data-mix='1'\][^{]*\.dct-mode/.exec(CSS), null, "循环开关不许跟着变橙");
  assert.equal(/data-mix='1'\][^{]*\.dct-counter/.exec(CSS), null, "对抗开关不许跟着变橙");
});

test("循环 + 对抗 同开：根节点 data-mix=1，两个开关各留原色", async () => {
  const env = boot();
  env.store.set("dsh-tier-mode:s-alpha", JSON.stringify({ mode: "loop", level: "max", counter: true }));
  const tree = env.render();
  await tick();
  assert.equal(tree.props["data-mode"], "loop");
  assert.equal(tree.props["data-counter"], "1");
  assert.equal(tree.props["data-mix"], "1");
  assert.deepEqual(
    tree.children.slice(0, 3).map((c) => c.props["data-level"]),
    ["off", "high", "max"],
    "橙色规则认 data-level 这一组",
  );
  assert.equal(tree.children[4].props.className, "dct-cell dct-mode", "循环格不参与染色");
  assert.equal(tree.children[6].props.className, "dct-cell dct-counter", "对抗格不参与染色");
});

test("只有循环 + 对抗 同时亮才转橙：单独循环、单独对抗、都不开都是 0", async () => {
  const cases = [
    [{ mode: "loop", level: "high", counter: false }, "0"],
    [{ mode: "think", level: "high", counter: true }, "0"],
    [{ mode: "think", level: "high", counter: false }, "0"],
  ];
  for (const [value, expected] of cases) {
    const env = boot();
    env.store.set("dsh-tier-mode:s-alpha", JSON.stringify(value));
    assert.equal(env.render().props["data-mix"], expected, JSON.stringify(value));
  }
});

test("会话隔离：不同对话各存各的键，桥地址带 session", async () => {
  const env = boot();
  const a = env.render("s-alpha");
  env.render("s-beta").children[0].props.onClick();
  await tick();
  assert.deepEqual(env.posts.at(-1), { level: "off" });
  env.store.set("dsh-tier-mode:s-beta", JSON.stringify({ mode: "loop", level: "max" }));
  const b = env.render("s-beta");
  assert.equal(b.props["data-mode"], "loop", "beta 用自己的本地值");
  assert.equal(a.props["data-mode"], "think", "alpha 不该被 beta 影响");
  const { resolveSession, bridgeUrl } = env.mod.__internals;
  assert.equal(resolveSession({ sessionId: "s-x" }), "s-x");
  assert.match(bridgeUrl("s x", "/events"), /\?session=s%20x$/);
});

test("桥不可达：只探一遍端口，TTL 内再点不再重扫", async () => {
  const env = boot({ mode: "think", level: "high" }, { failGet: true });
  env.mod.__internals.CONFIG.portMissTtl = 60000;
  const tree = env.render();
  await tick(30);
  const probes = () => env.fetches.filter((f) => f.url.includes("session=probe")).length;
  assert.equal(probes(), 10, "10 个端口扫一遍；挂载时 pull 与 SSE 并发，不能各扫一遍");
  tree.children[0].props.onClick();
  await tick(30);
  assert.equal(probes(), 10, "TTL 内点击不该再扫一遍端口");
});

test("宿主在 POST 响应里带 pending 时，点一次档只发一次请求", async () => {
  const env = boot(
    { mode: "think", level: "high", plugin: "dsh-calibration" },
    { postBody: { ok: true, session: "s-alpha", mode: "think", level: "off", pending: false, turnLocked: true } },
  );
  const tree = env.render();
  await tick(30);
  const stateGets = () => env.fetches.filter((f) => f.method === "GET" && f.url.includes("/state")).length;
  const before = stateGets();
  tree.children[0].props.onClick();
  await tick(30);
  assert.equal(stateGets(), before, "POST 已带结果，不该再补一次 GET");
  assert.deepEqual(env.posts.at(-1), { level: "off" });
});

test("宿主 POST 不带 pending（老宿主）时退回拉一次", async () => {
  const env = boot();
  const tree = env.render();
  await tick(30);
  const stateGets = () => env.fetches.filter((f) => f.method === "GET" && f.url.includes("/state")).length;
  const before = stateGets();
  tree.children[0].props.onClick();
  await tick(30);
  assert.equal(stateGets(), before + 1, "老宿主缺 pending，应补一次 GET");
});

test("SSE 被彻底关掉后自动重建，且不超过 maxReconnects", async () => {
  const env = boot();
  const conf = env.mod.__internals.CONFIG;
  conf.reconnectDelay = 5;
  conf.maxReconnects = 2;
  env.render();
  await tick(40);
  assert.equal(env.streams.length, 1, "挂载应建立一条 SSE");

  env.streams[0].readyState = 2;
  env.streams[0].onerror();
  await tick(40);
  assert.equal(env.streams.length, 2, "彻底断开后应重建");

  env.streams[1].readyState = 2;
  env.streams[1].onerror();
  await tick(40);
  assert.equal(env.streams.length, 3, "第二次重建");

  env.streams[2].readyState = 2;
  env.streams[2].onerror();
  await tick(40);
  assert.equal(env.streams.length, 3, "达到上限后不再重建");
});

test("诊断默认关闭，localStorage 打标后才写 jsonl", async () => {
  const off = boot();
  off.render();
  await tick(20);
  assert.equal(off.debugs.length, 0, "默认不该往宿主写诊断");

  const on = boot({ mode: "think", level: "high" }, { local: { "dsh-tier-debug": "1" } });
  on.render();
  await tick(20);
  assert.ok(on.debugs.some((d) => d.event === "registered"), "打标后应回报注册事件");
});

test("离线与待生效同时成立时，title 两件事都说", () => {
  const { barTitle } = boot().mod.__internals;
  const both = barTitle(true, true, false);
  assert.match(both, /离线/);
  assert.match(both, /下一轮生效/);
  assert.equal(barTitle(false, false, true), "循环模式");
  assert.equal(barTitle(false, false, false), "思考模式");
});

test("对抗是独立开关：点一下只提交 counter，不动模式与档位", async () => {
  const env = boot();
  const tree = env.render();
  await tick(40);
  const btn = tree.children[6];
  assert.equal(btn.props["data-counter-toggle"], "off", "默认关");
  btn.props.onClick();
  await tick(40);
  assert.deepEqual(env.posts.at(-1), { counter: true }, "只提交 counter 一维");
});

test("两套 DSH 同开：当前桥不认识本会话时，切到认识它的那个端口", async () => {
  const env = boot(
    { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
    {
      stateByPort: {
        43871: { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
        43872: { mode: "think", level: "max", plugin: "dsh-calibration", knownSession: true },
      },
    },
  );
  const tree = env.render();
  await tick(80);
  assert.equal(env.store.get("dsh-tier-port"), "43872", "应切到认识本会话的那一端");
  tree.children[0].props.onClick(); // 认领之后的点击必须走新端口
  await tick(40);
  const posts = env.fetches.filter((f) => f.method === "POST");
  assert.match(posts.at(-1).url, /:43872\//, "认领后写入应走新端口");
});

test("老宿主没有 knownSession 字段：不额外扫端口", async () => {
  const env = boot({ mode: "think", level: "high", plugin: "dsh-calibration" });
  env.render();
  await tick(60);
  const probes = env.fetches.filter((f) => f.url.includes("session=s-alpha") && f.url.includes("/state")).length;
  assert.ok(probes <= 2, `不该为认领实例额外扫：${probes}`);
});

test("暂时谁都不认识本会话：过几秒自动重试，认领后停止轮询", async () => {
  const later = { mode: "think", level: "max", plugin: "dsh-calibration", knownSession: false };
  const env = boot(
    { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
    {
      stateByPort: {
        43871: { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
        43872: later,
      },
    },
  );
  env.mod.__internals.CONFIG.ownerPollMs = 10;
  env.mod.__internals.CONFIG.ownerPollTries = 8;
  env.render();
  await tick(40);
  assert.equal(env.store.get("dsh-tier-port"), "43871", "未认领时只能先用探测到的端口");

  later.knownSession = true; // 模拟本实例的工具刚刚落盘
  await tick(80);
  assert.equal(env.store.get("dsh-tier-port"), "43872", "轮询应认领到正确端口");
});

test("单实例：只有一套 DSH 时不依赖工具落盘，直接认领并写入", async () => {
  const env = boot(
    { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
    { onlyPorts: [43871] },
  );
  const tree = env.render();
  await tick(60);
  tree.children[0].props.onClick();
  await tick(40);
  assert.equal(env.posts.length, 1, "单实例应直接认领，不必等工具写");
  assert.deepEqual(env.posts[0], { level: "off" });
});

test("两套都不认领：不连 SSE、点击只存本地，认领后补写一次", async () => {
  const other = { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false };
  const env = boot(
    { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
    {
      onlyPorts: [43871, 43872],
      stateByPort: {
        43871: { mode: "think", level: "high", plugin: "dsh-calibration", knownSession: false },
        43872: other,
      },
    },
  );
  env.mod.__internals.CONFIG.ownerPollMs = 10;
  const tree = env.render();
  await tick(60);
  assert.equal(env.streams.length, 0, "未认领时不该连任何桥的 SSE");

  tree.children[0].props.onClick();
  await tick(30);
  assert.equal(env.posts.length, 0, "未认领时不该写任何实例");
  assert.deepEqual(
    JSON.parse(env.store.get("dsh-tier-mode:s-alpha")),
    { mode: "think", level: "off", counter: false, route: { on: false, level: "high" } },
    "改动先存本地",
  );

  other.knownSession = true; // 本实例的工具刚落盘
  await tick(80);
  assert.equal(env.posts.length, 1, "认领后应把攒下的改动补写一次");
  assert.deepEqual(env.posts[0], { level: "off" });
});

test("检索关闭：不渲染检索三格，主条仍是 3 档 + 三开关", async () => {
  const tree = boot().render();
  await tick();
  assert.equal(tree.props["data-route"], "0");
  const routeCells = tree.children.filter((c) => String((c.props && c.props.className) || "").includes("dct-routecell"));
  assert.equal(routeCells.length, 0);
});

test("检索开启：最左三格是 本地/增量/全量，与思考档并存", async () => {
  const env = boot();
  env.store.set(
    "dsh-tier-mode:s-alpha",
    JSON.stringify({ mode: "think", level: "max", route: { on: true, level: "high" } }),
  );
  const tree = env.render();
  await tick();
  assert.equal(tree.props["data-route"], "1");
  assert.equal(tree.props["data-route-level"], "high");
  assert.equal(tree.children.length, 13, "3 检索档 + 隔离线 + 3 思考档 + 隔离线 + 循环 + 隔离线 + 对抗 + 隔离线 + 检索");
  assert.deepEqual(
    tree.children.slice(0, 3).map((c) => c.children[0]),
    ["本地", "增量", "全量"],
  );
  assert.equal(tree.children[3].props.className, "dct-sep");
  assert.deepEqual(
    tree.children.slice(4, 7).map((c) => c.children[0]),
    ["常规", "严格", "极致"],
    "检索开着也必须能改思考档",
  );
  assert.equal(tree.children[12].children[0], "检索");
  assert.equal(tree.children[12].props["data-route-toggle"], "on");
});

test("点检索只提交 route.on，点全量只提交 route.level", async () => {
  const env = boot();
  const tree = env.render();
  await tick();
  tree.children[8].props.onClick(); // 检索开关
  await tick();
  assert.deepEqual(env.posts.at(-1), { route: { on: true } }, "切开关不许顺手改档位/模式");

  env.store.set(
    "dsh-tier-mode:s-alpha",
    JSON.stringify({ mode: "think", level: "high", route: { on: true, level: "high" } }),
  );
  const onTree = env.render();
  await tick();
  onTree.children[2].props.onClick(); // 全量
  await tick();
  assert.deepEqual(env.posts.at(-1), { route: { level: "max" } }, "换档不许顺手切换开关");
});

test("检索 + 循环 + 对抗同开：四段各亮各的，data-route 与 data-mix 互不干扰", async () => {
  const env = boot();
  env.store.set(
    "dsh-tier-mode:s-alpha",
    JSON.stringify({ mode: "loop", level: "max", counter: true, route: { on: true, level: "max" } }),
  );
  const tree = env.render();
  await tick();
  assert.equal(tree.props["data-mode"], "loop");
  assert.equal(tree.props["data-route"], "1");
  assert.equal(tree.props["data-mix"], "1");
  assert.equal(tree.children.length, 13);
  assert.equal(tree.children[2].props["data-on"], "1", "全量档亮");
  assert.equal(tree.children[8].props["data-mode-toggle"], "loop");
  assert.equal(tree.children[10].props["data-counter-toggle"], "on");
  assert.equal(tree.children[12].props["data-route-toggle"], "on");
});

test("检索档位坏值退回默认「增量」", async () => {
  const env = boot();
  env.store.set(
    "dsh-tier-mode:s-alpha",
    JSON.stringify({ mode: "think", level: "high", route: { on: true, level: "ultra" } }),
  );
  const tree = env.render();
  await tick();
  assert.equal(tree.props["data-route-level"], "high");
});

test("样式：天蓝变量只定义一次，且只打在检索格与检索开关上", () => {
  const { CSS } = boot().mod.__internals;
  assert.equal((CSS.match(/--dct-route:/g) || []).length, 1, "变量只能定义一次");
  assert.ok(CSS.includes("#3a9ad9"), "天蓝取 #3a9ad9");
  assert.ok(CSS.includes(".dct-routecell[data-on='1']{background:var(--dct-route)"), "检索格用天蓝");
  assert.ok(CSS.includes(".dct-route-toggle[data-on='1']{background:var(--dct-route)"), "检索开关用天蓝");
});
