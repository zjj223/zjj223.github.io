#!/usr/bin/env node
/* tests/problems/api_smoke.js —— 题库 API 无浏览器冒烟（R002-BANK-01）
   用法：node tests/problems/api_smoke.js
   覆盖 A2–A7；A1 由外部的 node --check 负责。退出码 0 = 全过。 */

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const errors = [];

const sandbox = {
  window: {},
  console: {
    log() {},
    warn() {},
    error(...args) {
      errors.push(args.map(String).join(" "));
    }
  },
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  Math,
  JSON
};

const ctx = vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  vm.runInContext(code, ctx, { filename: rel });
}

[
  "data/catalog.js",
  "shared/index.js",
  "shared/contracts.js",
  "shared/storage-keys.js",
  "shared/utils.js",
  "shared/storage.js",
  "shared/bus.js",
  "shared/routes.js",
  "shared/config.js",
  "shared/auth-session.js",
  "problems/progress.js",
  "problems/api.js",
  "problems/index.js"
].forEach(load);

const LK = ctx.LK;
const P = LK.problems;
const failures = [];

function check(id, ok, detail) {
  const line = `${id} ${ok ? "PASS" : "FAIL"} ${detail || ""}`.trim();
  console.log(line);
  if (!ok) failures.push(line);
}

/* A2 目录与统计 */
const cat = P.getCatalog();
const st = P.getStats();
const lessons = cat.chapters.reduce((a, c) => a + ((c.lessons || []).length), 0);
console.log(`entries=${st.entries} unique=${st.unique} examples=${st.examples} practices=${st.practices} chapters=${cat.chapters.length} lessons=${lessons}`);
check("A2", st.entries === 1446 && st.unique === 1432 && st.examples === 243 && st.practices === 1203 &&
  cat.chapters.length === 9 && lessons === 58,
  `entries=${st.entries} unique=${st.unique} examples=${st.examples} practices=${st.practices} chapters=${cat.chapters.length} lessons=${lessons}`);

/* A3 跨章重复题必须在各自章可见 */
const b5 = P.getChapter("b5");
const b5first = b5 && b5.lessons && b5.lessons[0];
const b5hit = !!(b5first && (b5first.problems || []).some((p) => Number(p.pid) === 1414));
const b6 = P.getChapter("b6");
const b6hit = !!(b6 && (b6.lessons || []).some((l) => (l.problems || []).some((p) => Number(p.pid) === 1839)));
check("A3", b5hit && b6hit, `b5/1含1414=${b5hit} b6含1839=${b6hit}`);

/* A4 空存储进度 */
const pr0 = P.getProgress();
check("A4", Array.isArray(pr0.doneKeys) && pr0.doneKeys.length === 0 && pr0.completedCount === 0 && pr0.studentKey === "guest",
  `doneKeys=${pr0.doneKeys.length} completedCount=${pr0.completedCount} studentKey=${pr0.studentKey}`);

/* A5 markDone 写盘 + 事件 */
const got = [];
LK.bus.on("lk:problems:progress-changed", (d) => got.push(d));
const pr1 = P.markDone("ybt1414");
const raw = LK.storage.get("studypage.done");
const detail = got[0] || {};
const need = (LK.contracts.eventFields["lk:problems:progress-changed"] || []);
const fieldsOk = need.every((f) => detail[f] !== undefined && detail[f] !== null);
check("A5", raw === '["ybt1414"]' && got.length === 1 && fieldsOk && pr1.completedCount === 1,
  `raw=${raw} events=${got.length} fields=${need.join(",")}=${fieldsOk} completedCount=${pr1.completedCount}`);
if (got.length) console.log("A5 detail=" + JSON.stringify(detail));

/* A6 做题页地址 */
const url = P.getProblemUrl({ source: "ybt", id: "3001", key: "ybt3001" });
check("A6", url === "预览_DevC布局.html?pid=3001", `url=${url}`);

/* A7 全流程无 console.error */
check("A7", errors.length === 0, `console.error=${errors.length}`);

console.log(`RESULT ${failures.length === 0 ? "ALL_PASS" : "FAILED"} assertions=${7} failures=${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
