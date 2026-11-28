/* shared/utils.js —— 无副作用纯函数（B2 批次）
   owner: architect
   约定：纯函数，不读写 storage、不碰 DOM、不发请求；同名实现由各模块改为调用本文件。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  function clamp(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  function pad2(n) {
    n = Number(n) || 0;
    return (n < 10 ? "0" : "") + n;
  }

  /* 2026-11-28 -> "11 月 28 日"（与首页文案风格一致） */
  function cnDate(input) {
    var d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return "";
    return (d.getMonth() + 1) + " 月 " + d.getDate() + " 日";
  }

  function isoDate(input) {
    var d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /* 千分位；非数字原样返回空串，避免把 "abc" 当 0 */
  function thousands(n) {
    var v = Number(n);
    if (!isFinite(v)) return "";
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var self = this, args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, wait || 0);
    };
  }

  function throttle(fn, wait) {
    var last = 0;
    return function () {
      var now = Date.now();
      if (now - last >= (wait || 0)) {
        last = now;
        return fn.apply(this, arguments);
      }
      return undefined;
    };
  }

  function parseQuery(search) {
    var out = {};
    var s = String(search || "");
    if (s.charAt(0) === "?") s = s.slice(1);
    if (!s) return out;
    s.split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("=");
      var k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      var v = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1));
      if (out[k] === undefined) out[k] = v;
    });
    return out;
  }

  function queryString(obj) {
    var parts = [];
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      if (v === undefined || v === null || v === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    });
    return parts.join("&");
  }

  function safeJson(text, fallback) {
    try {
      var v = JSON.parse(text);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function pick(obj, keys, fallback) {
    var out = {};
    (keys || []).forEach(function (k) {
      out[k] = obj && obj[k] !== undefined ? obj[k] : fallback;
    });
    return out;
  }

  LK.utils = {
    esc: esc,
    clamp: clamp,
    pad2: pad2,
    cnDate: cnDate,
    isoDate: isoDate,
    thousands: thousands,
    debounce: debounce,
    throttle: throttle,
    parseQuery: parseQuery,
    queryString: queryString,
    safeJson: safeJson,
    pick: pick
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
