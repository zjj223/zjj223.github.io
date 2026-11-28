/* tests/contract/run.js —— 契约测试总入口（B2）
   用法：node tests/contract/run.js
   退出码：0 全绿；1 有失败。不依赖浏览器、不联网。 */
"use strict";

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..", "..");

/* 按脚本顺序加载 shared 层（与页面加载顺序一致，见方案 5.2） */
const SHARED_ORDER = [
  "shared/index.js",
  "shared/contracts.js",
  "shared/storage-keys.js",
  "shared/utils.js",
  "shared/storage.js",
  "shared/bus.js",
  "shared/routes.js",
  "shared/config.js",
  "shared/auth-session.js"
];

let failed = 0;
let passed = 0;

function loadShared() {
  SHARED_ORDER.forEach((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error("缺少 " + rel);
    require(abs);
  });
  if (!globalThis.LK) throw new Error("加载后没有 window.LK 等价的 globalThis.LK");
  return globalThis.LK;
}

function runCase(suite, testCase, LK) {
  try {
    testCase.fn(LK);
    passed++;
    console.log("  PASS " + testCase.name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + testCase.name + " -> " + (e && e.message ? e.message : e));
  }
}

/* —— 静态断言：源码里不得出现第二份键名字面量（防止模块自造） —— */
function staticAssertions(LK) {
  const keys = LK.storageKeys.keys;
  const files = ["auth.js", "nav.js", "home.js", "app.js", "data/config.js"]
    .map((r) => path.join(ROOT, r))
    .filter((p) => fs.existsSync(p));

  console.log("\n[static] 键名在旧文件中仍有字面量（B2 期属预期，逐条登记，迁移时消除）");
  let literalHits = 0;
  files.forEach((file) => {
    const text = fs.readFileSync(file, "utf8");
    Object.keys(keys).forEach((name) => {
      const value = keys[name];
      const count = text.split(value).length - 1;
      if (count > 0) {
        literalHits += count;
        console.log("  " + path.basename(file) + " 含 " + name + " x" + count);
      }
    });
  });
  console.log("  合计字面量 " + literalHits + " 处（B2 不做迁移，故不计失败）");

  /* 中文文件名只能出现在 routes.js */
  const pages = LK.routes.all();
  const allowFiles = ["shared/routes.js", "shared/config.js", "index.html"];
  const candidates = ["auth.js", "nav.js", "home.js", "app.js"];
  let leaked = 0;
  candidates.forEach((rel) => {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, "utf8");
    pages.forEach((pg) => {
      if (pg.file === "index.html") return;
      if (text.indexOf(pg.file) >= 0 && allowFiles.indexOf(rel) < 0) {
        leaked++;
        console.log("  [warn] " + rel + " 仍直接写 " + pg.file + "（迁移后应改为 LK.routes.url）");
      }
    });
  });
  if (leaked) console.log("  直接写中文页名的位置 " + leaked + " 处（B2 期属预期）");
}

function checkRoutes(LK) {
  const pages = LK.routes.all();
  if (pages.length !== 10) throw new Error("页面数应为 10，实际 " + pages.length);
  const game = LK.routes.url("game");
  if (game !== "index.html?game=1") throw new Error("游戏页 URL 应带 ?game=1，实际 " + game);
  const problem = LK.routes.url("problem", { pid: "3001" });
  if (problem !== "预览_DevC布局.html?pid=3001") throw new Error("做题页 URL 不对：" + problem);
  if (LK.routes.keyOfFile("学习台.html") !== "study") throw new Error("反查 pageKey 失败");
}

function checkTokens() {
  const css = fs.readFileSync(path.join(ROOT, "css", "tokens.css"), "utf8");
  const vars = (css.match(/--lk-[a-z0-9-]+:/g) || []).length;
  if (vars < 30) throw new Error("tokens 变量过少：" + vars);
  if (/\.\w[\w-]*\s*\{/.test(css)) throw new Error("tokens.css 不应包含组件选择器");
  if (css.indexOf("#f6f3ec") < 0) throw new Error("tokens 未包含实测背景色 #f6f3ec");
  console.log("\n[static] tokens.css 变量 " + vars + " 个，无组件选择器");
}

function main() {
  console.log("== B2 契约测试 ==");
  let LK;
  try {
    LK = loadShared();
  } catch (e) {
    console.log("FAIL 加载 shared 层失败：" + e.message);
    return 1;
  }
  console.log("shared 文件 " + SHARED_ORDER.length + " 个加载完成，LK.version=" + LK.version);

  const suites = [
    require("./contracts.test.js"),
    require("./storage-keys.test.js"),
    require("./bus.test.js")
  ];

  suites.forEach((suite) => {
    console.log("\n[" + suite.name + "]  " + suite.cases.length + " 项");
    suite.cases.forEach((c) => runCase(suite, c, LK));
  });

  console.log("\n[routes]");
  try {
    checkRoutes(LK);
    passed++;
    console.log("  PASS 路由映射与 URL 拼装");
  } catch (e) {
    failed++;
    console.log("  FAIL " + e.message);
  }

  console.log("\n[tokens]");
  try {
    checkTokens();
    passed++;
    console.log("  PASS tokens 变量层");
  } catch (e) {
    failed++;
    console.log("  FAIL " + e.message);
  }

  console.log("\n[utils]");
  try {
    if (LK.utils.esc('<a b="c">') !== "&lt;a b=&quot;c&quot;&gt;") throw new Error("esc 转义不对");
    if (LK.utils.thousands(1234567) !== "1,234,567") throw new Error("thousands 不对");
    if (LK.utils.isoDate("2026-11-28T10:00:00+08:00") !== "2026-11-28") throw new Error("isoDate 不对");
    if (LK.utils.clamp("abc", 1, 5) !== 1) throw new Error("clamp 非法值应回落 min");
    if (LK.utils.parseQuery("?pid=3001&x=1").pid !== "3001") throw new Error("parseQuery 不对");
    passed++;
    console.log("  PASS 纯函数行为");
  } catch (e) {
    failed++;
    console.log("  FAIL " + e.message);
  }

  console.log("\n[auth-session]");
  try {
    if (LK.auth.isLoggedIn() !== false) throw new Error("无会话时应为未登录");
    try {
      LK.auth.requireSession();
      throw new Error("未登录时 requireSession 应抛错");
    } catch (inner) {
      if (!inner || inner.code !== "AUTH_REQUIRED") throw new Error("错误码应为 AUTH_REQUIRED");
    }
    passed++;
    console.log("  PASS 只读会话与未登录报错");
  } catch (e) {
    failed++;
    console.log("  FAIL " + e.message);
  }

  staticAssertions(LK);

  console.log("\nRESULT passed=" + passed + " failed=" + failed);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
