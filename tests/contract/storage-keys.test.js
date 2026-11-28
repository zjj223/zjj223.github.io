/* tests/contract/storage-keys.test.js —— 键名唯一性与真实键值核对（B2）
   唯一性用代码断言；与源码真实值的一致性由 run.js 的文件扫描断言补足。 */
"use strict";

module.exports = {
  name: "storage-keys",
  cases: [
    {
      name: "键名无重复",
      fn: function (LK) {
        var seen = {};
        Object.keys(LK.storageKeys.keys).forEach(function (k) {
          var v = LK.storageKeys.keys[k];
          if (seen[v]) throw new Error("键重复：" + v + "（" + seen[v] + " 与 " + k + "）");
          seen[v] = k;
        });
      }
    },
    {
      name: "七个已知键与线上真实键一致",
      fn: function (LK) {
        var want = {
          AUTH_SESSION: "carlosia:auth:v1",
          AUTH_BOOT_SAVE: "carlosia:auth:bootsave:v1",
          USER_NICKNAME: "lk.user.v1",
          GAME_SAVE: "carlosia_phase1_save_v1",
          STUDY_DONE: "studypage.done",
          STUDY_CHECKIN: "studypage.checkin",
          STUDY_LAST: "studypage.last"
        };
        Object.keys(want).forEach(function (k) {
          if (LK.storageKeys.keys[k] !== want[k]) {
            throw new Error(k + " 期望 " + want[k] + "，实际 " + LK.storageKeys.keys[k]);
          }
        });
      }
    },
    {
      name: "游戏存档云端档识别：主键 + _cloud_ 后缀都认，别的档不认",
      fn: function (LK) {
        if (!LK.storageKeys.isGameSaveKey("carlosia_phase1_save_v1")) throw new Error("主键未识别");
        if (!LK.storageKeys.isGameSaveKey("carlosia_phase1_save_v1_cloud_teacher")) throw new Error("云档未识别");
        if (LK.storageKeys.isGameSaveKey("studypage.done")) throw new Error("题库进度被误判成游戏存档");
        if (LK.storageKeys.cloudKey("teacher") !== "carlosia_phase1_save_v1_cloud_teacher") throw new Error("cloudKey 拼接错误");
      }
    }
  ]
};
