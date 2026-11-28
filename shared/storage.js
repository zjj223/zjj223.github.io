/* shared/storage.js —— localStorage 安全读写（B2 批次）
   owner: architect
   约定：
   1. 模块不直接调 localStorage，走 LK.storage；键名只从 LK.storageKeys 取。
   2. 任何异常都降级为 undefined / false，绝不抛给调用方，也不静默清数据。
   3. 版本迁移只加字段、不删字段；迁移失败保留原值。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  /* Node 或隐私模式下没有 localStorage：退回内存实现，保证测试与降级可用 */
  var memory = {};
  function backend() {
    try {
      if (typeof global.localStorage !== "undefined" && global.localStorage) return global.localStorage;
    } catch (e) { /* Safari 隐私模式访问即抛 */ }
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null; },
      setItem: function (k, v) { memory[k] = String(v); },
      removeItem: function (k) { delete memory[k]; },
      key: function (i) { return Object.keys(memory)[i] || null; },
      get length() { return Object.keys(memory).length; }
    };
  }

  function getRaw(key) {
    try { return backend().getItem(key); } catch (e) { return null; }
  }

  function setRaw(key, value) {
    try { backend().setItem(key, value); return true; } catch (e) { return false; }
  }

  function removeRaw(key) {
    try { backend().removeItem(key); return true; } catch (e) { return false; }
  }

  function getJSON(key, fallback) {
    var raw = getRaw(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    try {
      var v = JSON.parse(raw);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function setJSON(key, value) {
    try { return setRaw(key, JSON.stringify(value)); } catch (e) { return false; }
  }

  function keysWithPrefix(prefix) {
    var out = [];
    try {
      var ls = backend();
      for (var i = 0; i < ls.length; i++) {
        var k = String(ls.key(i));
        if (k.indexOf(prefix) === 0) out.push(k);
      }
    } catch (e) { /* 忽略：返回已收集部分 */ }
    return out;
  }

  /* 版本迁移：读 {v, data}，命中第 target 版则返回 data；否则交给 upgrade 生成新值并落盘。
     迁移失败时返回原值，不覆盖。 */
  function migrate(key, targetVersion, upgrade) {
    var box = getJSON(key, null);
    if (!box || typeof box !== "object" || (box.v === undefined && box.data === undefined)) {
      return { value: box, migrated: false };
    }
    if (box.v === targetVersion) return { value: box.data, migrated: false };
    try {
      var next = upgrade ? upgrade(box.data, box.v || 0, targetVersion) : box.data;
      setJSON(key, { v: targetVersion, data: next });
      return { value: next, migrated: true };
    } catch (e) {
      return { value: box.data, migrated: false, error: String(e && e.message || e) };
    }
  }

  /* 只读副本：调用方拿到的数组/对象改了不影响内部 */
  function clone(v) {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }

  LK.storage = {
    get: getRaw,
    set: setRaw,
    remove: removeRaw,
    getJSON: getJSON,
    setJSON: setJSON,
    keysWithPrefix: keysWithPrefix,
    migrate: migrate,
    clone: clone
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
