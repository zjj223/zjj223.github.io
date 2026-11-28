/* 游戏模块入口（R002）：命名空间 + 版本；页面仍不引用本文件。owner: game */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });
  LK.game = LK.game || {};
  LK.game.version = "2026-11-28-r002";
  LK.game.ready = false;
})(typeof globalThis !== "undefined" ? globalThis : this);