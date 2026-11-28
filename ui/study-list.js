/* ui/study-list.js —— 学习台列表渲染纯函数（R002-UI-01）
   owner: ui
   约定：不碰 DOM、不碰本地存储、不发请求；输入 snapshot + state，输出字符串与数字。
   契约：
     state    = {g:'all'|<章id>, l:'all'|<课号>, status:'all'|'done'|'todo', kind:'all'|'ex'|'pr', q:string}
     snapshot = {problems:[ProblemSummary], doneKeys?:Array|Object|Set, groups?:[{id,name,lessons:[{no,name}]}]}
     ProblemSummary = {ref:{key}, pid?, title, groupId, lessonNo, type, done?, ac?, sub?, open?}
     render 返回 {rowsHtml, barPct, label, count}
*/
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = {});
  LK.ui = LK.ui || {};

  var ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escFallback(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  function esc(s) {
    if (LK.utils && typeof LK.utils.esc === "function") { return LK.utils.esc(s); }
    return escFallback(s);
  }

  var KIND_CN = { pr: "编程题", ex: "选择题" };

  function toSet(doneKeys) {
    var set = {};
    if (!doneKeys) { return set; }
    if (Array.isArray(doneKeys)) {
      doneKeys.forEach(function (k) { set[String(k)] = 1; });
      return set;
    }
    if (typeof doneKeys.forEach === "function" && typeof doneKeys.has === "function") {
      doneKeys.forEach(function (k) { set[String(k)] = 1; });
      return set;
    }
    if (typeof doneKeys === "object") {
      Object.keys(doneKeys).forEach(function (k) { if (doneKeys[k]) { set[String(k)] = 1; } });
    }
    return set;
  }

  /* ref.key 形如 'ybt1414'；对外展示的 data-pid 只保留数字部分 */
  function pidOf(item) {
    if (item.pid !== undefined && item.pid !== null && item.pid !== "") { return String(item.pid); }
    var key = item.ref && item.ref.key !== undefined ? String(item.ref.key) : "";
    var m = key.match(/\d+/);
    return m ? m[0] : key;
  }

  function keyOf(item) {
    if (item.ref && item.ref.key !== undefined) { return String(item.ref.key); }
    return "ybt" + pidOf(item);
  }

  /* 兼容两种输入：已标准化的 ProblemSummary，或 data/catalog.js 的原始题目对象 */
  function normalize(list, chapterId, lessonNo) {
    var out = [];
    (list || []).forEach(function (p) {
      if (!p) { return; }
      var pid = p.pid !== undefined ? p.pid : pidOf(p);
      out.push({
        ref: p.ref && p.ref.key !== undefined ? p.ref : { key: "ybt" + pid },
        pid: pid,
        title: p.title === undefined ? "" : p.title,
        groupId: p.groupId !== undefined ? p.groupId : chapterId,
        lessonNo: p.lessonNo !== undefined ? p.lessonNo : lessonNo,
        type: p.type !== undefined ? p.type : p.kind,
        done: p.done === true,
        ac: p.ac,
        sub: p.sub,
        open: p.open
      });
    });
    return out;
  }

  function flatten(snapshot) {
    if (!snapshot) { return []; }
    if (Array.isArray(snapshot.problems)) { return normalize(snapshot.problems); }
    /* 也接受 CATALOG 原形（chapters） */
    var out = [];
    (snapshot.chapters || []).forEach(function (g) {
      (g.lessons || []).forEach(function (l) {
        out = out.concat(normalize(l.problems, g.id, l.no));
      });
    });
    return out;
  }

  function filter(snapshot, state) {
    var st = state || {};
    var g = st.g === undefined ? "all" : st.g;
    var l = st.l === undefined ? "all" : st.l;
    var status = st.status || "all";
    var kind = st.kind || "all";
    var q = String(st.q || "").toLowerCase();
    var doneKeys = toSet(snapshot && snapshot.doneKeys);
    var all = flatten(snapshot);

    return all.filter(function (it) {
      if (g !== "all" && String(it.groupId) !== String(g)) { return false; }
      if (g !== "all" && l !== "all" && String(it.lessonNo) !== String(l)) { return false; }
      var isDone = doneKeys[keyOf(it)] === 1 || it.done === true;
      if (status === "done" && !isDone) { return false; }
      if (status === "todo" && isDone) { return false; }
      if (kind !== "all" && String(it.type) !== String(kind)) { return false; }
      if (q) {
        var hitPid = String(it.pid).toLowerCase().indexOf(q) >= 0;
        var hitTitle = String(it.title).toLowerCase().indexOf(q) >= 0;
        if (!hitPid && !hitTitle) { return false; }
      }
      return true;
    });
  }

  function labelOf(snapshot, state) {
    var st = state || {};
    if (st.g === undefined || st.g === "all") { return "C++ 题单"; }
    var groups = (snapshot && (snapshot.groups || snapshot.chapters)) || [];
    var name = "";
    groups.forEach(function (g) { if (String(g.id) === String(st.g)) { name = g.name || ""; } });
    if (!name) { return "题单"; }
    if (st.l !== undefined && st.l !== "all") {
      var lesName = "";
      groups.forEach(function (g) {
        if (String(g.id) !== String(st.g)) { return; }
        (g.lessons || []).forEach(function (x) { if (String(x.no) === String(st.l)) { lesName = x.name || ""; } });
      });
      if (lesName) { return name + " · " + lesName; }
    }
    return name;
  }

  function metaOf(it) {
    var parts = [KIND_CN[it.type] || "题目"];
    if (it.ac !== undefined && it.ac !== null) { parts.push("通过 " + it.ac); }
    return parts.join(" · ");
  }

  function render(snapshot, state) {
    var rows = filter(snapshot, state);
    var total = rows.length;
    var doneKeys = toSet(snapshot && snapshot.doneKeys);
    var ok = rows.filter(function (it) { return doneKeys[keyOf(it)] === 1 || it.done === true; }).length;
    var barPct = total ? Math.round(ok / total * 100) : 0;

    var html = rows.map(function (it) {
      return '<div class="lk-row"' +
        (it.open === false ? ' data-closed="1"' : "") +
        ' data-pid="' + esc(pidOf(it)) + '">' +
        '<span class="lk-row-title">' + esc(it.title) + '</span>' +
        '<span class="lk-row-meta">' + esc(metaOf(it)) + '</span></div>';
    }).join("");

    return { rowsHtml: html, barPct: barPct, label: labelOf(snapshot, state), count: total };
  }

  LK.ui.studyList = {
    version: "R002-UI-01",
    filter: filter,
    render: render
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
