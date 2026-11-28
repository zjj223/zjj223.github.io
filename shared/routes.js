/* shared/routes.js —— 公开页面路径唯一清单（B2 批次）
   owner: architect
   约定：
   1. 中文文件名只允许出现在本文件；其他模块用 pageKey 引用。
   2. 文件名是线上真实 URL，禁止改名；只允许拼查询参数。
   3. 生成 URL 时对中文段做 encodeURI，路径分隔保持 "/"。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  var PAGES = {
    home: { file: "首页.html", query: {} },
    study: { file: "学习台.html", query: {} },
    practice: { file: "练习题库.html", query: {} },
    ranking: { file: "排行榜.html", query: {} },
    contest: { file: "比赛.html", query: {} },
    monthly: { file: "俊杰月赛.html", query: {} },
    game: { file: "index.html", query: { game: "1" } },
    problem: { file: "预览_DevC布局.html", query: {} },
    admin: { file: "admin.html", query: {} },
    guide: { file: "图解_静态页面与部署与判题.html", query: {} }
  };

  /* 反向识别：当前 URL 文件名 -> pageKey（用于导航选中） */
  function keyOfFile(file) {
    var keys = Object.keys(PAGES);
    for (var i = 0; i < keys.length; i++) {
      if (PAGES[keys[i]].file === file) return keys[i];
    }
    return null;
  }

  function fileOf(key) {
    var p = PAGES[key];
    return p ? p.file : null;
  }

  function query(params) {
    var parts = [];
    var src = params || {};
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v === undefined || v === null || v === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    });
    return parts.join("&");
  }

  /* url("problem", {pid:"3001"}) -> "预览_DevC布局.html?pid=3001" */
  function url(key, params) {
    var p = PAGES[key];
    if (!p) throw new Error("未知页面：" + key);
    var merged = {};
    Object.keys(p.query).forEach(function (k) { merged[k] = p.query[k]; });
    var extra = params || {};
    Object.keys(extra).forEach(function (k) { merged[k] = extra[k]; });
    var qs = query(merged);
    /* 直接返回中文文件名：与现有 nav.js 的写法一致，浏览器自行编码。
       不预先 encodeURI，避免与历史外链、收藏的 URL 形态产生差异。 */
    return p.file + (qs ? "?" + qs : "");
  }

  function all() {
    return Object.keys(PAGES).map(function (k) {
      return { key: k, file: PAGES[k].file };
    });
  }

  LK.routes = { pages: PAGES, all: all, url: url, fileOf: fileOf, keyOfFile: keyOfFile };
})(typeof globalThis !== "undefined" ? globalThis : this);
