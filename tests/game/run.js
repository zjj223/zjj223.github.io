/* tests/game/run.js —— R002 游戏数据层测试入口
   用法：node tests/game/run.js
   退出码：0 四条全 PASS；1 有失败。 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const PET_SRC = path.join(ROOT, "data", "petConfig.js");
const FORTUNE_SRC = path.join(ROOT, "data", "fortune.js");
const PET_TEXT = fs.readFileSync(PET_SRC, "utf8");

function assetVerFromSource() {
  const match = PET_TEXT.match(/const\s+ASSET_VER\s*=\s*["']([^"']+)["']/);
  if (!match) throw new Error("petConfig.js 中找不到 ASSET_VER 字面值");
  return match[1];
}

function buildContext() {
  const sandbox = { console: console, document: undefined };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function load(ctx, rel) {
  const abs = path.join(ROOT, rel);
  vm.runInContext(fs.readFileSync(abs, "utf8"), ctx, { filename: rel });
}

function main() {
  const ctx = buildContext();
  load(ctx, "shared/index.js");
  load(ctx, "shared/storage.js");
  load(ctx, "data/petConfig.js");
  load(ctx, "data/fortune.js");
  load(ctx, "game/index.js");
  load(ctx, "game/data-access.js");

  if (!ctx.LK || !ctx.LK.game) throw new Error("加载后没有 LK.game");
  if (typeof ctx.LK.game.getPetConfig !== "function") throw new Error("缺少 getPetConfig");

  const assetVer = assetVerFromSource();
  const suite = require("./data-access.test.js");
  let passed = 0;
  let failed = 0;

  console.log("== R002 游戏数据只读层 ==");
  console.log("game.version=" + ctx.LK.game.version + " ASSET_VER=" + assetVer);
  suite.cases.forEach(function (testCase) {
    try {
      testCase.fn(ctx, assetVer);
      passed++;
      console.log("  PASS " + testCase.name);
    } catch (e) {
      failed++;
      console.log("  FAIL " + testCase.name + " -> " + (e && e.message ? e.message : e));
    }
  });
  console.log("RESULT passed=" + passed + " failed=" + failed);
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
