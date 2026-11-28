/* shared/storage-keys.js —— localStorage 键名唯一清单（B2 批次）
   owner: architect
   约定：
   1. 全站键名只允许从这里取；模块里不得再写字符串字面量。
   2. 只改映射不改物理键名——现有线上数据必须继续可读，禁止静默迁移。
   3. 键名与真实读写位置一一对应，来源见每行注释。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  var KEYS = {
    /* 登录门票：auth.js:7（{token, exp, name}），12 小时 TTL */
    AUTH_SESSION: "carlosia:auth:v1",
    /* 登录前存档暂存：auth.js:208 */
    AUTH_BOOT_SAVE: "carlosia:auth:bootsave:v1",
    /* 导航显示昵称：auth.js:14 -> nav.js 读取 */
    USER_NICKNAME: "lk.user.v1",
    /* 游戏存档主键：app.js + nav.js:26 同源；云端档加 "_cloud_<key>" 后缀 */
    GAME_SAVE: "carlosia_phase1_save_v1",
    GAME_SAVE_CLOUD_PREFIX: "_cloud_",
    /* 题库完成进度：14 处引用，后续由 problems/progress.js 独占 */
    STUDY_DONE: "studypage.done",
    /* 每日打卡：nav.js:178 */
    STUDY_CHECKIN: "studypage.checkin",
    /* 做题页最后打开：预览_DevC布局.html:2818（只写不读，P3 遗留） */
    STUDY_LAST: "studypage.last",
    /* 每日新增做题数：读 home.js:278；写 286 */
    STUDY_DAILY: "studypage.daily",
    /* 当日新增的基线快照：读 home.js:278；写 282、286 */
    STUDY_DONE_BASE: "studypage.doneBase",
    /* 随机一题上次抽到：读 home.js:140；写 145 */
    STUDY_RANDOM_LAST: "studypage.random.last",
    /* 求签记录：读 home.js:155；写 207 */
    STUDY_FORTUNE: "studypage.fortune",
    /* 邮件上次查看时间：读 home.js:362；写 434 */
    STUDY_MAIL_LAST: "studypage.mail.last"
  };

  /* 旧名 -> 新名 的兼容表。当前为空：只登记“别名”关系，不产生物理迁移。 */
  var ALIASES = {
    "carlosia:auth:v1": "AUTH_SESSION",
    "lk.user.v1": "USER_NICKNAME",
    "carlosia_phase1_save_v1": "GAME_SAVE",
    "studypage.done": "STUDY_DONE"
  };

  /* 需要扫描同前缀家族的键（游戏存档有 _cloud_ 变体） */
  var SCAN_PREFIXES = ["carlosia_phase1_save_v1", "studypage."];

  function isGameSaveKey(key) {
    return typeof key === "string" &&
      (key === KEYS.GAME_SAVE || key.indexOf(KEYS.GAME_SAVE + KEYS.GAME_SAVE_CLOUD_PREFIX) === 0);
  }

  function cloudKey(name) {
    return KEYS.GAME_SAVE + KEYS.GAME_SAVE_CLOUD_PREFIX + String(name || "");
  }

  function all() {
    return Object.keys(KEYS).map(function (k) { return KEYS[k]; });
  }

  LK.storageKeys = {
    keys: KEYS,
    aliases: ALIASES,
    scanPrefixes: SCAN_PREFIXES,
    isGameSaveKey: isGameSaveKey,
    cloudKey: cloudKey,
    all: all
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
