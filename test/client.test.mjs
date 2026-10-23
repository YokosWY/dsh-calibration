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
const CODE = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

function boot(remote = { mode: "think", level: "high" }) {
  const registerCalls = [];
  const posts = [];
  const listeners = [];
  const store = new Map();
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
      if (method === "POST") {
        posts.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...remote }) });
    },
    console,
    Promise,
    setTimeout,
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
    registerCalls,
    loadedId: sandbox.__loaded.id,
    listeners,
    render: () => registerCalls[0].comp().type(),
  };
}

test("模块 id 等于包名（防 duplicate factory）", () => {
  assert.equal(boot().loadedId, "@local/dsh-clarify-tier");
});

test("只注册一条插槽，order=10，槽位正确", () => {
  const env = boot();
  assert.equal(env.registerCalls.length, 1);
  assert.equal(env.registerCalls[0].cfg.id, "tier-bar");
  assert.equal(env.registerCalls[0].cfg.order, 10);
  assert.equal(env.registerCalls[0].cfg.name, "conversation.input.right");
});

test("思考模式：3 档 + 1 隔离线 + 1 循环，标签二字", () => {
  const tree = boot().render();
  assert.equal(tree.props["data-mode"], "think");
  assert.equal(tree.children.length, 5);
  assert.equal(tree.children[3].props.className, "dct-sep");
  const labels = tree.children.slice(0, 3).map((c) => c.children[0]);
  assert.deepEqual(labels, ["关闭", "严格", "极限"]);
  assert.equal(tree.children[4].children[0], "循环");
});

test("循环模式：标签换成循环档，循环格亮起", () => {
  const env = boot();
  env.store.set("dsh-tier-mode", JSON.stringify({ mode: "loop", level: "max" }));
  const tree = env.render();
  assert.equal(tree.props["data-mode"], "loop");
  const labels = tree.children.slice(0, 3).map((c) => c.children[0]);
  assert.deepEqual(labels, ["轻量", "交付", "极限"]);
  assert.equal(tree.children[4].props["data-on"], "1");
  assert.equal(tree.children[4].props["data-mode-toggle"], "loop");
});

test("挂载时注册 focus 刷新（双窗对齐）", () => {
  const env = boot();
  env.render(); // effect 在组件首次渲染时才跑
  assert.ok(env.listeners.includes("focus"));
});

test("点档位只提交 level，点循环只提交 mode", () => {
  const env = boot();
  const tree = env.render();
  tree.children[0].props.onClick(); // 关闭
  assert.deepEqual(env.posts.at(-1), { level: "off" });
  env.render().children[4].props.onClick(); // 循环
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

test("样式：循环模式琥珀、隔离线存在", () => {
  const { CSS } = boot().mod.__internals;
  assert.match(CSS, /data-mode='loop'\] \.dct-cell\[data-on='1'\]\{background:#e08a2e\}/);
  assert.match(CSS, /\.dct-sep\{/);
  assert.match(CSS, /\.dct-mode\[data-on='1'\]/);
});
