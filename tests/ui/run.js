/* tests/ui/run.js —— R002-UI-01 测试入口
   用法：node tests/ui/run.js
   行为：vm 加载 shared/utils.js + data/catalog.js + ui/study-list.js，
        构造 snapshot（1,446 条按条目），跑 study-list.test.js 的 B2–B6 与附加断言。
   约束：只读运行文件，不写任何文件。 */
"use strict";

var vm = require("vm");
var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..", "..");

function makeContext() {
  var sandbox = { console: console, window: {} };
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, rel) {
  var code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}

function buildSnapshot(catalog) {
  var problems = [];
  var groups = [];
  (catalog.chapters || []).forEach(function (g) {
    var les = [];
    var n = 0;
    (g.lessons || []).forEach(function (l) {
      var probs = l.problems || [];
      n += probs.length;
      les.push({ no: l.no, name: l.name, count: probs.length });
      probs.forEach(function (p) {
        problems.push({
          ref: { key: "ybt" + p.pid },
          pid: p.pid,
          title: p.title,
          groupId: g.id,
          lessonNo: l.no,
          type: p.kind,
          done: false,
          ac: p.ac,
          sub: p.sub,
          open: p.open
        });
      });
    });
    groups.push({ id: g.id, name: g.name, count: n, lessons: les });
  });
  return { problems: problems, groups: groups, doneKeys: [] };
}

function main() {
  var ctx = makeContext();
  load(ctx, "shared/utils.js");
  load(ctx, "data/catalog.js");
  load(ctx, "ui/study-list.js");

  var LK = ctx.LK;
  var catalog = ctx.window.CATALOG;
  if (!LK || !LK.utils || !LK.ui || !LK.ui.studyList) { console.error("加载失败：LK.ui.studyList 未挂载"); return 1; }
  if (!catalog || !catalog.chapters) { console.error("加载失败：window.CATALOG 缺失"); return 1; }

  var snapshot = buildSnapshot(catalog);
  var rows = LK.ui.studyList.render(snapshot, { g: "all", l: "all", status: "all", kind: "all", q: "" });
  console.log("snapshot.problems=" + snapshot.problems.length + " groups=" + snapshot.groups.length);
  console.log("rows=" + rows.count);
  console.log("barPct=" + rows.barPct + " label=" + rows.label);

  var results = require("./study-list.test.js").run({ LK: LK, snapshot: snapshot, CATALOG: catalog });
  var fail = 0;
  results.forEach(function (r) {
    if (!r.ok) { fail += 1; }
    console.log("[" + r.id + "] " + (r.ok ? "PASS" : "FAIL") + "  " + r.name + "  -> " + r.detail);
  });
  console.log("总 " + results.length + " 项，通过 " + (results.length - fail) + " 项，失败 " + fail + " 项");
  return fail === 0 ? 0 : 1;
}

process.exitCode = main();
