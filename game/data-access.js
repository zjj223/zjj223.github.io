/* game/data-access.js —— 游戏数据只读访问层（R002）
   owner: game
   约定：只读 global.CARLOSIA_PET_DATA（实际挂载名）与 global.FORTUNE；
   返回深拷贝，不写本地存储、不查 DOM、不修改源数据。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });
  var game = LK.game || (LK.game = {});

  function clone(value) {
    if (LK.storage && typeof LK.storage.clone === "function") return LK.storage.clone(value);
    try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
  }

  function petRoot() {
    return global.CARLOSIA_PET_DATA || global.PET_CONFIG || null;
  }

  function petList() {
    var root = petRoot();
    if (Array.isArray(root)) return root;
    if (root && Array.isArray(root.petDatabase)) return root.petDatabase;
    return [];
  }

  function getPetConfig() {
    return clone(petList());
  }

  function getPetConfigVer() {
    var list = petList();
    var first = list[0];
    var image = first && (first.image || (first.stages && first.stages[0] && first.stages[0].image));
    var match = String(image || "").match(/[?&]v=([^&"']+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function getFortune() {
    return Array.isArray(global.FORTUNE) ? clone(global.FORTUNE) : [];
  }

  function getFortuneCount() {
    return Array.isArray(global.FORTUNE) ? global.FORTUNE.length : 0;
  }

  game.getPetConfig = getPetConfig;
  game.getPetConfigVer = getPetConfigVer;
  game.getFortune = getFortune;
  game.getFortuneCount = getFortuneCount;
  game.dataAccess = Object.freeze({
    getPetConfig: getPetConfig,
    getPetConfigVer: getPetConfigVer,
    getFortune: getFortune,
    getFortuneCount: getFortuneCount
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
