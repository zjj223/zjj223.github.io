/* 共享层命名空间（B2）：只建立 window.LK 与版本号，不加载任何业务实现。
   约定：shared/ 仅架构师可写；模块只通过本文件暴露的字段交互。
   加载顺序见方案 5.2：index.js → contracts → storage-keys → utils → storage → bus
   → routes → config → auth-session（顺序由根 HTML 装配，不在本文件 import）。 */
(function (global) {
  "use strict";
  var LK = global.LK || {};
  LK.version = "2026-11-28-b2";
  if (LK.ready === undefined) LK.ready = false;
  /* schemaVersion 以 shared/contracts.js 为准，这里只在它尚未加载时占位 */
  if (LK.schemaVersion === undefined) LK.schemaVersion = 1;
  global.LK = LK;
})(typeof globalThis !== "undefined" ? globalThis : this);
