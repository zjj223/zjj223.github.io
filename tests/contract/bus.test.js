/* tests/contract/bus.test.js —— 事件总线行为测试（B2） */
"use strict";

module.exports = {
  name: "bus",
  cases: [
    {
      name: "未知事件被拒绝且不投递",
      fn: function (LK) {
        var hits = 0;
        LK.bus.on("lk:self-invented", function () { hits++; });
        LK.bus.emit("lk:self-invented", { schemaVersion: 1 });
        if (hits !== 0) throw new Error("自造事件不应被投递");
      }
    },
    {
      name: "订阅返回取消函数，取消后不再收到",
      fn: function (LK) {
        var hits = 0;
        var off = LK.bus.on(LK.contracts.events.JUDGE_FINISHED, function () { hits++; });
        var ev = LK.contracts.makeEvent(LK.contracts.events.JUDGE_FINISHED, {
          requestId: "r1", problemKey: "ybt3001",
          result: { requestId: "r1", problemKey: "ybt3001", status: "accepted", passed: true }
        });
        LK.bus.emit(ev.name, ev.detail);
        if (hits !== 1) throw new Error("应收到 1 次，实际 " + hits);
        off();
        var ev2 = LK.contracts.makeEvent(LK.contracts.events.JUDGE_FINISHED, {
          requestId: "r2", problemKey: "ybt3001",
          result: { requestId: "r2", problemKey: "ybt3001", status: "accepted", passed: true }
        });
        LK.bus.emit(ev2.name, ev2.detail);
        if (hits !== 1) throw new Error("取消后不应再收到，实际 " + hits);
      }
    },
    {
      name: "同一 eventId 只投递一次（防重放）",
      fn: function (LK) {
        var hits = 0;
        LK.bus.on(LK.contracts.events.ROUTE_REQUESTED, function () { hits++; });
        var ev = LK.contracts.makeEvent(LK.contracts.events.ROUTE_REQUESTED, { route: "study", params: {} });
        LK.bus.emit(ev.name, ev.detail);
        LK.bus.emit(ev.name, ev.detail);
        if (hits !== 1) throw new Error("同 eventId 应只投递 1 次，实际 " + hits);
      }
    },
    {
      name: "handler 抛异常不影响其他订阅者",
      fn: function (LK) {
        var hits = 0;
        LK.bus.on(LK.contracts.events.AUTH_CHANGED, function () { throw new Error("boom"); });
        LK.bus.on(LK.contracts.events.AUTH_CHANGED, function () { hits++; });
        var ev = LK.contracts.makeEvent(LK.contracts.events.AUTH_CHANGED, { session: { name: "测试" } });
        LK.bus.emit(ev.name, ev.detail);
        if (hits !== 1) throw new Error("后面的订阅者应仍被调用");
      }
    },
    {
      name: "detail 被冻结，订阅者改不动",
      fn: function (LK) {
        var captured = null;
        LK.bus.on(LK.contracts.events.GAME_SNAPSHOT_CHANGED, function (d) { captured = d; });
        var ev = LK.contracts.makeEvent(LK.contracts.events.GAME_SNAPSHOT_CHANGED, {
          studentKey: "s1", revision: 3
        });
        LK.bus.emit(ev.name, ev.detail);
        if (!captured) throw new Error("未收到事件");
        if (!Object.isFrozen(captured)) throw new Error("detail 应被冻结");
      }
    }
  ]
};
