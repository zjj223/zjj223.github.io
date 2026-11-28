/* problems/progress.js —— 做题进度独占读写（R002-BANK-01）
   owner: problems
   约定：
   1. 只用 LK.storage，本文件不直接访问浏览器存储对象。
   2. 写入前统一规范化（非字符串丢弃、去重、保序），避免脏键。
   3. 迁移期键名不改：studypage.done + 'ybt<pid>'，历史进度零损失。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  /* 三个键尚未登记进 shared/storage-keys.js，先用本文件常量顶；ARCH 补登后整行替换。 */
  var LOCAL_KEYS = {
    DAILY: "studypage.daily", // TODO(R002-ARCH-S1)：等 ARCH 补键后替换为 LK.storageKeys.keys.*
    DONE_BASE: "studypage.doneBase", // TODO(R002-ARCH-S1)：等 ARCH 补键后替换为 LK.storageKeys.keys.*
    RANDOM_LAST: "studypage.random.last" // TODO(R002-ARCH-S1)：等 ARCH 补键后替换为 LK.storageKeys.keys.*
  };

  function doneKey() {
    var k = LK.storageKeys && LK.storageKeys.keys && LK.storageKeys.keys.STUDY_DONE;
    return k || "studypage.done";
  }

  /* 规范化：只留非空字符串，去重，保留首次出现顺序 */
  function normalize(list) {
    var out = [], seen = {}, i, v;
    if (!Array.isArray(list)) return out;
    for (i = 0; i < list.length; i++) {
      v = list[i];
      if (typeof v !== "string" || !v) continue;
      if (seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    return out;
  }

  function read() {
    var raw = LK.storage.getJSON(doneKey(), []);
    return normalize(raw);
  }

  function write(list) {
    return LK.storage.setJSON(doneKey(), normalize(list));
  }

  function has(problemKey) {
    return read().indexOf(String(problemKey)) >= 0;
  }

  /* 追加一条；已存在时 added=false，绝不重复写 */
  function add(problemKey) {
    var key = String(problemKey || "");
    var list = read();
    if (!key) return { keys: list, added: false };
    if (list.indexOf(key) >= 0) return { keys: list, added: false };
    list.push(key);
    write(list);
    return { keys: list, added: true };
  }

  function removeKey(problemKey) {
    var key = String(problemKey || "");
    var list = read().filter(function (x) { return x !== key; });
    write(list);
    return { keys: list };
  }

  /* 只统计在目录里真实存在的键，防止脏键把完成数吹高 */
  function count(validKeys) {
    var list = read(), valid = null, n = 0, i;
    if (Array.isArray(validKeys)) {
      valid = {};
      for (i = 0; i < validKeys.length; i++) valid[validKeys[i]] = 1;
    }
    for (i = 0; i < list.length; i++) {
      if (valid && !valid[list[i]]) continue;
      n++;
    }
    return n;
  }

  LK.progress = {
    LOCAL_KEYS: LOCAL_KEYS,
    key: doneKey,
    normalize: normalize,
    read: read,
    write: write,
    has: has,
    add: add,
    remove: removeKey,
    count: count
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
