/* tests/ui/study-list.test.js —— R002-UI-01 断言集（B2–B6）
   由 tests/ui/run.js 调用；本文件只做断言，不含 DOM 操作与样式声明。 */
"use strict";

var results = [];

function check(id, name, fn) {
  try {
    var detail = fn();
    results.push({ id: id, name: name, ok: true, detail: detail || "" });
  } catch (e) {
    results.push({ id: id, name: name, ok: false, detail: e && e.message ? e.message : String(e) });
  }
}

function assert(cond, msg) {
  if (!cond) { throw new Error(msg || "断言失败"); }
}

function countRows(html) {
  return (html.match(/<div class="lk-row"/g) || []).length;
}

function allState(over) {
  var st = { g: "all", l: "all", status: "all", kind: "all", q: "" };
  Object.keys(over || {}).forEach(function (k) { st[k] = over[k]; });
  return st;
}

function run(deps) {
  var LK = deps.LK;
  var snapshot = deps.snapshot;
  var sl = LK.ui.studyList;

  check("B2", "state 全 all 时 1446 条，不按 pid 去重", function () {
    var r = sl.render(snapshot, allState());
    assert(r.count === 1446, "count=" + r.count + "，期望 1446");
    assert(countRows(r.rowsHtml) === 1446, "rows=" + countRows(r.rowsHtml) + "，期望 1446");
    return "count=" + r.count + " rows=" + countRows(r.rowsHtml) + " label=" + r.label;
  });

  check("B3", "{g:'b5',l:1} 时 76 条且含 data-pid=1414", function () {
    var r = sl.render(snapshot, allState({ g: "b5", l: 1 }));
    assert(r.count === 76, "count=" + r.count + "，期望 76");
    assert(r.rowsHtml.indexOf('data-pid="1414"') >= 0, "未找到 data-pid=1414");
    assert(countRows(r.rowsHtml) === 76, "rows=" + countRows(r.rowsHtml) + "，期望 76");
    return "count=" + r.count + " rows=" + countRows(r.rowsHtml) + " label=" + r.label;
  });

  check("B4", "{g:'b6',l:1} 时 90 条且含 data-pid=1839", function () {
    var r = sl.render(snapshot, allState({ g: "b6", l: 1 }));
    assert(r.count === 90, "count=" + r.count + "，期望 90");
    assert(r.rowsHtml.indexOf('data-pid="1839"') >= 0, "未找到 data-pid=1839");
    assert(countRows(r.rowsHtml) === 90, "rows=" + countRows(r.rowsHtml) + "，期望 90");
    return "count=" + r.count + " rows=" + countRows(r.rowsHtml) + " label=" + r.label;
  });

  check("B5", "title 注入 <script> 后只出现转义形态", function () {
    var evil = '<script>alert(1)</script>';
    var snap = { problems: [{ ref: { key: "ybt9001" }, pid: 9001, title: evil, groupId: "ch0", lessonNo: 1, type: "ex" }], groups: [] };
    var r = sl.render(snap, allState({ g: "ch0", l: 1 }));
    assert(r.rowsHtml.indexOf("<script>") < 0, "输出里直接出现了 <script>");
    assert(r.rowsHtml.indexOf("&lt;script&gt;") >= 0, "没有出现 &lt;script&gt;");
    assert(r.rowsHtml.indexOf('data-pid="9001"') >= 0, "data-pid 丢失");
    return "输出片段=" + r.rowsHtml.slice(0, 120);
  });

  check("B6", "空结果时 barPct=0、count=0、无 NaN", function () {
    var r = sl.render(snapshot, allState({ q: "zzzz-不存在-zzzz" }));
    assert(r.count === 0, "count=" + r.count);
    assert(r.barPct === 0, "barPct=" + r.barPct);
    assert(!/NaN/.test(r.rowsHtml + "|" + r.barPct), "输出里出现 NaN");
    return "count=0 barPct=0 rows=0";
  });

  /* 附加断言（不属于 B1–B8，用于证明 filter 与 render 同源） */
  check("X1", "filter 结果数 == render count（三组随机 state）", function () {
    var states = [allState({ status: "done" }), allState({ kind: "pr", g: "b1" }), allState({ q: "成绩", kind: "ex" })];
    var out = [];
    states.forEach(function (st) {
      var f = sl.filter(snapshot, st).length;
      var r = sl.render(snapshot, st).count;
      assert(f === r, "filter=" + f + " render=" + r);
      out.push(f);
    });
    return "counts=" + out.join("/");
  });

  check("X2", "doneKeys 生效后 barPct 与已通过数一致", function () {
    var base = snapshot.problems.filter(function (p) { return p.groupId === "b5" && String(p.lessonNo) === "1"; });
    var keys = base.slice(0, 38).map(function (p) { return p.ref.key; });
    var snap = { problems: snapshot.problems, groups: snapshot.groups, doneKeys: keys };
    var r = sl.render(snap, allState({ g: "b5", l: 1 }));
    assert(r.barPct === 50, "barPct=" + r.barPct + "，期望 50（38/76 四舍五入）");
    return "barPct=" + r.barPct + " count=" + r.count;
  });

  check("X3", "CATALOG 原形（chapters）输入与 snapshot 结果一致", function () {
    var r1 = sl.render(deps.CATALOG, allState({ g: "b6", l: 1 }));
    var r2 = sl.render(snapshot, allState({ g: "b6", l: 1 }));
    assert(r1.count === r2.count, "count 不一致");
    assert(r1.rowsHtml === r2.rowsHtml, "rowsHtml 不一致");
    return "count=" + r1.count;
  });

  check("X4", "只给 chapters（无 groups）时 label 仍取到组名与课名", function () {
    var r = sl.render(deps.CATALOG, allState({ g: "b6", l: 1 }));
    assert(r.label === "CSPS/提高组 · 2018年及以前", "label=" + r.label);
    return "label=" + r.label;
  });

  return results;
}

module.exports = { run: run };
