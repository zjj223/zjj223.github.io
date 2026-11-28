/* 共享层命名空间（B1 空壳）：只建立 window.LK，不加载任何业务实现。
   约定：shared/ 仅架构师可写；模块只通过本文件暴露的字段交互。 */
(function (global) {
  "use strict";
  var LK = global.LK || {};
  LK.version = "2026-11-28-b1";
  LK.ready = false;
  global.LK = LK;
})(typeof window !== "undefined" ? window : this);