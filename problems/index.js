/* problems/index.js —— 装配入口：命名空间、缺件加载、ready 标记。owner: problems */
(function (g) {
  var P = ((g.LK = g.LK || { version: "unset" })).problems = (g.LK.problems || {});
  if (!P.getCatalog && g.document && g.document.readyState === "loading" && g.document.write) g.document.write('<script src="problems/progress.js"><\/script><script src="problems/api.js"><\/script>'); P.ready = !!(P.getCatalog && P.getStats);
})(typeof globalThis !== "undefined" ? globalThis : this);
