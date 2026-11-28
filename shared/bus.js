/* shared/bus.js —— 事件总线（B2 批次）
   owner: architect
   约定：
   1. 事件名只从 LK.contracts.events 取，自造名字会被拒绝并记一条 warn。
   2. on() 返回取消函数；handler 收到只读 detail（浅冻结）。
   3. 同一 eventId 只投递一次，用于防重放与去重。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  var handlers = {};
  var seen = {};

  function known(name) {
    var events = (LK.contracts && LK.contracts.events) || {};
    return Object.keys(events).some(function (k) { return events[k] === name; });
  }

  function freeze(detail) {
    if (!detail || typeof detail !== "object") return detail;
    try { return Object.freeze(detail); } catch (e) { return detail; }
  }

  function on(name, handler) {
    if (typeof handler !== "function") return function () {};
    if (!known(name)) {
      if (global.console && console.warn) console.warn("[LK.bus] 未知事件：", name);
      return function () {};
    }
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(handler);
    return function unsubscribe() { off(name, handler); };
  }

  function off(name, handler) {
    var list = handlers[name];
    if (!list) return;
    var i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) delete handlers[name];
  }

  function once(name, handler) {
    var cancel = null;
    cancel = on(name, function (detail) {
      cancel();
      handler(detail);
    });
    return cancel;
  }

  function emit(name, detail) {
    if (!known(name)) {
      if (global.console && console.warn) console.warn("[LK.bus] 未知事件：", name);
      return 0;
    }
    var id = detail && detail.eventId;
    if (id) {
      if (seen[id]) return 0;
      seen[id] = Date.now();
    }
    var list = (handlers[name] || []).slice();
    var frozen = freeze(detail);
    var done = 0;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](frozen);
        done++;
      } catch (e) {
        if (global.console && console.error) console.error("[LK.bus] handler 异常：", name, e);
      }
    }
    return done;
  }

  /* 兜底：eventId 记录不能无限增长，超过 500 条清空一次 */
  function prune() {
    var ids = Object.keys(seen);
    if (ids.length > 500) seen = {};
  }

  LK.bus = { on: on, off: off, once: once, emit: emit, prune: prune, known: known };
})(typeof globalThis !== "undefined" ? globalThis : this);
