/* shared/auth-session.js —— 只读登录态（B2 批次）
   owner: architect
   约定：
   1. 只读：不写 localStorage、不创建 DOM、不发网络请求、不接管登录流程。
   2. 登录仍由旧 auth.js / AuthGate 负责；本文件只把“当前是否登录、是谁”读出来。
   3. 会话结构沿用 auth.js: {token, exp, name}；过期视为未登录。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  function key() {
    return (LK.storageKeys && LK.storageKeys.keys.AUTH_SESSION) || "carlosia:auth:v1";
  }

  function readRaw() {
    var s = LK.storage;
    if (!s) return null;
    return s.getJSON(key(), null);
  }

  function getSession() {
    var u = readRaw();
    if (!u || typeof u !== "object") return null;
    if (!u.token || !u.exp) return null;
    if (Date.now() >= Number(u.exp)) return null;
    return {
      token: String(u.token),
      exp: Number(u.exp),
      name: String(u.name || ""),
      teacher: !!u.teacher,
      studentKey: String(u.name || "")
    };
  }

  function isLoggedIn() {
    return getSession() !== null;
  }

  function displayName() {
    var s = getSession();
    return s ? s.name : "";
  }

  function requireSession() {
    var s = getSession();
    if (!s) {
      var err = (LK.contracts && LK.contracts.makeError)
        ? LK.contracts.makeError("AUTH_REQUIRED", "需要登录后才能继续")
        : { code: "AUTH_REQUIRED", message: "需要登录后才能继续", retryable: false, cause: null };
      throw err;
    }
    return s;
  }

  /* 订阅登录变化：优先用 bus（已接线时），否则监听 storage 事件兜底 */
  function subscribe(handler) {
    if (typeof handler !== "function") return function () {};
    if (LK.bus && LK.contracts) {
      return LK.bus.on(LK.contracts.events.AUTH_CHANGED, function (detail) {
        handler(detail && detail.session ? detail.session : getSession());
      });
    }
    function onStorage(e) {
      if (e && e.key === key()) handler(getSession());
    }
    try {
      global.addEventListener("storage", onStorage, false);
      return function () { global.removeEventListener("storage", onStorage, false); };
    } catch (e) {
      return function () {};
    }
  }

  LK.auth = {
    getSession: getSession,
    isLoggedIn: isLoggedIn,
    displayName: displayName,
    requireSession: requireSession,
    subscribe: subscribe
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
