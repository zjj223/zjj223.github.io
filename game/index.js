/* 游戏模块入口（B1 空壳）：当前无实现，任何页面都不得引用本文件。
   接口契约见 多人并行架构方案_2026-11-27.md 第 5 章。owner: game */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });
  LK.game = LK.game || {};
  LK.game.ready = false;
})(typeof window !== "undefined" ? window : this);