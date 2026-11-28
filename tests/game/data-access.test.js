/* tests/game/data-access.test.js —— 只读数据层断言（R002） */
"use strict";

module.exports = {
  name: "data-access",
  cases: [
    {
      name: "getPetConfig 非空且是深拷贝",
      fn: function (ctx) {
        var source = ctx.CARLOSIA_PET_DATA.petDatabase;
        var copy = ctx.LK.game.getPetConfig();
        if (!Array.isArray(copy) || copy.length === 0) throw new Error("getPetConfig 返回空");
        if (copy === source) throw new Error("getPetConfig 返回了源对象引用");
        var before = source[0].name;
        copy[0].name = "__mutated__";
        if (source[0].name !== before) throw new Error("修改副本影响了源对象");
      }
    },
    {
      name: "getPetConfigVer 等于源码 ASSET_VER",
      fn: function (ctx, assetVer) {
        var actual = ctx.LK.game.getPetConfigVer();
        if (actual !== assetVer) throw new Error("ASSET_VER 期望 " + assetVer + "，实际 " + actual);
      }
    },
    {
      name: "getFortune 长度一致且字段齐全",
      fn: function (ctx) {
        var source = ctx.FORTUNE;
        var copy = ctx.LK.game.getFortune();
        if (!Array.isArray(copy)) throw new Error("getFortune 不是数组");
        if (copy.length !== source.length) throw new Error("长度不一致：" + copy.length + " vs " + source.length);
        var need = ["lv", "text", "good", "bad", "g", "l", "ch"];
        copy.forEach(function (item, i) {
          need.forEach(function (key) {
            if (item[key] === undefined || item[key] === null) throw new Error("第 " + i + " 条缺字段 " + key);
          });
        });
        if (copy === source) throw new Error("getFortune 返回了源对象引用");
      }
    },
    {
      name: "getFortuneCount 等于源数组长度",
      fn: function (ctx) {
        var actual = ctx.LK.game.getFortuneCount();
        if (actual !== ctx.FORTUNE.length) throw new Error("数量期望 " + ctx.FORTUNE.length + "，实际 " + actual);
      }
    }
  ]
};
