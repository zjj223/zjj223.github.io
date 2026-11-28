/* shared/contracts.js —— 契约单一来源（B2 批次）
   owner: architect
   约定：
   1. 本文件只定义结构与常量，不引用任何旧业务代码，不访问 localStorage / DOM。
   2. 事件名、状态码、结构字段只能从这里取；模块不得自造同义名。
   3. 结构校验函数只做形状检查，不做业务判断。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });

  /* 契约版本：字段含义变化时 +1，只加字段不 +1。 */
  var SCHEMA_VERSION = 1;

  /* ---------------- 事件 ---------------- */
  var EVENTS = {
    AUTH_CHANGED: "lk:auth:changed",
    GAME_SNAPSHOT_CHANGED: "lk:game:snapshot-changed",
    PROBLEMS_PROGRESS_CHANGED: "lk:problems:progress-changed",
    JUDGE_FINISHED: "lk:judge:finished",
    ROUTE_REQUESTED: "lk:route:requested"
  };

  /* 每个事件 detail 的必填字段（少一个即视为不合契约） */
  var EVENT_FIELDS = {
    "lk:auth:changed": ["schemaVersion", "eventId", "at", "session"],
    "lk:game:snapshot-changed": ["schemaVersion", "eventId", "at", "studentKey", "revision"],
    "lk:problems:progress-changed": ["schemaVersion", "eventId", "at", "studentKey", "problemKey", "done"],
    "lk:judge:finished": ["schemaVersion", "eventId", "at", "requestId", "problemKey", "result"],
    "lk:route:requested": ["schemaVersion", "eventId", "at", "route", "params"]
  };

  /* ---------------- 错误 ---------------- */
  var ERROR_CODES = {
    NOT_FOUND: "NOT_FOUND",
    AUTH_REQUIRED: "AUTH_REQUIRED",
    NETWORK_ERROR: "NETWORK_ERROR",
    JUDGE_UNAVAILABLE: "JUDGE_UNAVAILABLE",
    BAD_REQUEST: "BAD_REQUEST"
  };

  var RETRYABLE_CODES = { NETWORK_ERROR: true, JUDGE_UNAVAILABLE: true };

  function makeError(code, message, cause) {
    return {
      code: ERROR_CODES[code] ? code : "BAD_REQUEST",
      message: String(message || ""),
      retryable: !!RETRYABLE_CODES[code],
      cause: cause || null
    };
  }

  /* ---------------- 判题 ---------------- */
  var JUDGE_STATUS = [
    "accepted", "wrong_answer", "compile_error", "runtime_error",
    "time_limit", "network_error", "judge_unavailable"
  ];

  /* 只有 accepted 才算通过；绝不允许把网络失败当作通过。 */
  function isJudgePassed(status) {
    return status === "accepted";
  }

  /* ---------------- 结构定义（仅作文档与校验依据） ----------------
     ProblemRef     = {source:"ybt"|"pset"|"contest", id:string, key:string}
     ProblemSummary = {ref:ProblemRef, title:string, groupId:string|null,
                       lessonNo:number|null, difficulty:number|null, done:boolean}
     CatalogSnapshot= {schemaVersion:number, chapters:Array, problems:ProblemSummary[]}
     ProgressSnapshot={schemaVersion:number, studentKey:string, doneKeys:string[], completedCount:number}
     GameSnapshot   = {schemaVersion:number, revision:number, student:{id,displayName}, coin:number,
                       ownedPetCount:number, activePetIds:string[]}
     JudgeResult    = {requestId, problemKey, transportOk, status, passed, compileMessage,
                       runMessage, stdout, durationMs, memoryKb, raw} */

  var SOURCES = ["ybt", "pset", "contest"];

  function isRef(v) {
    return !!v && typeof v === "object" && typeof v.key === "string" &&
      v.key.length > 0 && SOURCES.indexOf(v.source) >= 0 && typeof v.id === "string";
  }

  function validateSnapshot(snap) {
    var errors = [];
    if (!snap || typeof snap !== "object") {
      return ["Snapshot 不是对象"];
    }
    if (snap.schemaVersion !== SCHEMA_VERSION) {
      errors.push("schemaVersion 应为 " + SCHEMA_VERSION + "，实际 " + snap.schemaVersion);
    }
    if (Array.isArray(snap.chapters) && Array.isArray(snap.problems)) {
      snap.problems.forEach(function (p, i) {
        if (!isRef(p && p.ref)) errors.push("problems[" + i + "].ref 不合契约");
        if (typeof p.title !== "string") errors.push("problems[" + i + "].title 必须是字符串");
        if (typeof p.done !== "boolean") errors.push("problems[" + i + "].done 必须是布尔");
      });
    }
    if (typeof snap.studentKey === "string" && Array.isArray(snap.doneKeys)) {
      if (typeof snap.completedCount !== "number") errors.push("ProgressSnapshot.completedCount 必须是数字");
    }
    if (typeof snap.revision === "number" && snap.student && typeof snap.coin === "number") {
      if (!Array.isArray(snap.activePetIds)) errors.push("GameSnapshot.activePetIds 必须是数组");
    }
    return errors;
  }

  function validateJudgeResult(r) {
    var errors = [];
    if (!r || typeof r !== "object") return ["JudgeResult 不是对象"];
    if (typeof r.requestId !== "string" || !r.requestId) errors.push("requestId 缺失");
    if (typeof r.problemKey !== "string" || !r.problemKey) errors.push("problemKey 缺失");
    if (JUDGE_STATUS.indexOf(r.status) < 0) errors.push("status 不在枚举内：" + r.status);
    if (typeof r.passed !== "boolean") errors.push("passed 必须是布尔");
    if (r.passed && r.status !== "accepted") errors.push("passed=true 但 status 不是 accepted");
    return errors;
  }

  function validateDetail(name, detail) {
    var need = EVENT_FIELDS[name];
    if (!need) return ["未知事件：" + name];
    var errors = [];
    need.forEach(function (f) {
      if (!detail || detail[f] === undefined || detail[f] === null) {
        errors.push("detail 缺少必填字段 " + f);
      }
    });
    return errors;
  }

  function makeEvent(name, extra) {
    var detail = {
      schemaVersion: SCHEMA_VERSION,
      eventId: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
      at: new Date().toISOString()
    };
    if (extra) {
      Object.keys(extra).forEach(function (k) { detail[k] = extra[k]; });
    }
    return { name: name, detail: detail };
  }

  LK.contracts = {
    schemaVersion: SCHEMA_VERSION,
    events: EVENTS,
    eventFields: EVENT_FIELDS,
    errorCodes: ERROR_CODES,
    judgeStatus: JUDGE_STATUS,
    sources: SOURCES,
    isRef: isRef,
    isJudgePassed: isJudgePassed,
    makeError: makeError,
    makeEvent: makeEvent,
    validateSnapshot: validateSnapshot,
    validateJudgeResult: validateJudgeResult,
    validateDetail: validateDetail
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
