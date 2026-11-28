/* tests/contract/contracts.test.js —— 契约测试（B2）
   只验证结构与常量，不依赖浏览器。 */
"use strict";

module.exports = {
  name: "contracts",
  cases: [
    {
      name: "schemaVersion 存在且为 1",
      fn: function (LK) {
        if (LK.contracts.schemaVersion !== 1) throw new Error("schemaVersion 应为 1");
      }
    },
    {
      name: "五个事件名与方案 5.3 完全一致",
      fn: function (LK) {
        var want = [
          "lk:auth:changed",
          "lk:game:snapshot-changed",
          "lk:problems:progress-changed",
          "lk:judge:finished",
          "lk:route:requested"
        ];
        var got = Object.keys(LK.contracts.events).map(function (k) { return LK.contracts.events[k]; });
        want.forEach(function (w) {
          if (got.indexOf(w) < 0) throw new Error("缺少事件 " + w);
        });
        if (got.length !== want.length) throw new Error("事件数量应为 5，实际 " + got.length);
      }
    },
    {
      name: "每个事件都有必填字段清单，且每个清单非空",
      fn: function (LK) {
        Object.keys(LK.contracts.events).forEach(function (k) {
          var name = LK.contracts.events[k];
          var fields = LK.contracts.eventFields[name];
          if (!fields || !fields.length) throw new Error(name + " 没有必填字段");
          ["schemaVersion", "eventId", "at"].forEach(function (f) {
            if (fields.indexOf(f) < 0) throw new Error(name + " 缺通用字段 " + f);
          });
        });
      }
    },
    {
      name: "错误码齐全且 makeError 会修正非法 code",
      fn: function (LK) {
        ["NOT_FOUND", "AUTH_REQUIRED", "NETWORK_ERROR", "JUDGE_UNAVAILABLE", "BAD_REQUEST"].forEach(function (c) {
          if (LK.contracts.errorCodes[c] !== c) throw new Error("缺错误码 " + c);
        });
        var e1 = LK.contracts.makeError("NETWORK_ERROR", "断网");
        if (!e1.retryable) throw new Error("NETWORK_ERROR 应可重试");
        var e2 = LK.contracts.makeError("NOT_FOUND", "没找到");
        if (e2.retryable) throw new Error("NOT_FOUND 不应可重试");
        var e3 = LK.contracts.makeError("WHAT", "非法");
        if (e3.code !== "BAD_REQUEST") throw new Error("非法 code 应回落 BAD_REQUEST");
      }
    },
    {
      name: "只有 accepted 算通过，网络失败绝不能算通过",
      fn: function (LK) {
        if (!LK.contracts.isJudgePassed("accepted")) throw new Error("accepted 应为通过");
        ["wrong_answer", "compile_error", "runtime_error", "time_limit", "network_error", "judge_unavailable"]
          .forEach(function (s) {
            if (LK.contracts.isJudgePassed(s)) throw new Error(s + " 不应算通过");
          });
      }
    },
    {
      name: "validateJudgeResult 能抓出 passed 与 status 矛盾",
      fn: function (LK) {
        var bad = LK.contracts.validateJudgeResult({
          requestId: "r1", problemKey: "ybt3001", status: "network_error", passed: true
        });
        if (!bad.length) throw new Error("应当报错：passed=true 但 status 不是 accepted");
        var good = LK.contracts.validateJudgeResult({
          requestId: "r1", problemKey: "ybt3001", status: "accepted", passed: true
        });
        if (good.length) throw new Error("合法结果不应报错：" + good.join("; "));
      }
    },
    {
      name: "validateDetail 抓缺字段；makeEvent 生成合规 detail",
      fn: function (LK) {
        var ev = LK.contracts.makeEvent(LK.contracts.events.ROUTE_REQUESTED, { route: "study", params: {} });
        var errs = LK.contracts.validateDetail(ev.name, ev.detail);
        if (errs.length) throw new Error("makeEvent 产物不合契约：" + errs.join("; "));
        var bad = LK.contracts.validateDetail(LK.contracts.events.AUTH_CHANGED, { schemaVersion: 1 });
        if (!bad.length) throw new Error("缺字段时应当报错");
      }
    },
    {
      name: "isRef 拒绝 source 不在枚举内的引用",
      fn: function (LK) {
        if (!LK.contracts.isRef({ source: "ybt", id: "3001", key: "ybt3001" })) throw new Error("合法 ref 被拒");
        if (LK.contracts.isRef({ source: "洛谷", id: "3001", key: "x" })) throw new Error("非法 source 未被拒");
        if (LK.contracts.isRef({ source: "ybt", id: "3001", key: "" })) throw new Error("空 key 未被拒");
      }
    }
  ]
};
