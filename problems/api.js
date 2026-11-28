/* problems/api.js —— 题库对外 API（R002-BANK-01）
   owner: problems
   约定：
   1. 只读目录、只写进度，全部通过 LK.* 共享层，不直接碰 localStorage / DOM。
   2. 目录按条目展开（1446 条，同 pid 允许多条），unique 只进 stats。
   3. 判题结果字段与状态严格按 shared/contracts.js，网络失败绝不冒充通过。 */
(function (global) {
  "use strict";
  var LK = global.LK || (global.LK = { version: "unset" });
  LK.problems = LK.problems || {};

  var SCHEMA = 1;
  var GUEST = "guest";
  var YBT_MIN = 3001, YBT_MAX = 3079;
  var DEFAULT_JUDGE_URL = "http://59.110.125.57/judge";
  var state = { ref: null, chapters: [], problems: [], byKey: {}, byPid: [], stats: null };

  function win() {
    return (typeof window !== "undefined" && window) ? window : global;
  }

  function clone(v) {
    if (LK.storage && LK.storage.clone) return LK.storage.clone(v);
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }

  function makeError(code, message) {
    if (LK.contracts && LK.contracts.makeError) return LK.contracts.makeError(code, message);
    return { code: code, message: String(message || ""), retryable: false, cause: null };
  }

  function sourceOf(pid) {
    return (pid >= YBT_MIN && pid <= YBT_MAX) ? "ybt" : "pset";
  }

  function keyOfPid(pid) {
    return "ybt" + pid;
  }

  function typeOf(kind) {
    return kind === "ex" ? "example" : "practice";
  }

  /* 入参归一：{key}/{id}/'ybt3001'/'3001'/3001 → 'ybt3001' */
  function normalizeKey(ref) {
    if (ref === null || ref === undefined) return "";
    if (typeof ref === "number") return isFinite(ref) ? keyOfPid(ref) : "";
    if (typeof ref === "object") {
      if (typeof ref.key === "string" && ref.key) return ref.key;
      if (ref.id !== undefined) return normalizeKey(ref.id);
      return "";
    }
    var s = String(ref).trim();
    if (/^ybt\d+$/.test(s)) return s;
    if (/^\d+$/.test(s)) return keyOfPid(Number(s));
    return s;
  }

  function pidOfKey(key) {
    var m = /^ybt(\d+)$/.exec(String(key || ""));
    return m ? Number(m[1]) : null;
  }

  function build() {
    var w = win();
    var raw = w && w.CATALOG;
    var chapters = (raw && Array.isArray(raw.chapters)) ? raw.chapters : [];
    var problems = [], byKey = {}, byPid = [], examples = 0, practices = 0, lessons = 0, i, j, k;
    var sum, pid, ref, p;

    for (i = 0; i < chapters.length; i++) {
      var lesList = chapters[i].lessons || [];
      lessons += lesList.length;
      for (j = 0; j < lesList.length; j++) {
        var prList = lesList[j].problems || [];
        for (k = 0; k < prList.length; k++) {
          p = prList[k];
          pid = Number(p.pid);
          ref = { source: sourceOf(pid), id: String(pid), key: keyOfPid(pid) };
          sum = {
            ref: ref,
            title: String(p.title || ""),
            groupId: String(chapters[i].id || ""),
            lessonNo: Number(lesList[j].no),
            type: typeOf(p.kind),
            acceptCount: Number(p.ac) || 0,
            submitCount: Number(p.sub) || 0,
            timeLimitMs: Number(p.time) || 0,
            memoryLimitKb: Number(p.mem) || 0,
            difficulty: null
          };
          problems.push(sum);
          if (!byKey[ref.key]) byKey[ref.key] = sum;   /* getProblem 返回首条，不丢其他条目 */
          if (!byPid[pid]) byPid[pid] = sum;
          if (sum.type === "example") examples++; else practices++;
        }
      }
    }

    var uniq = {}, unique = 0;
    for (i = 0; i < problems.length; i++) {
      if (!uniq[problems[i].ref.key]) { uniq[problems[i].ref.key] = 1; unique++; }
    }

    state = {
      ref: raw,
      chapters: chapters,
      problems: problems,
      byKey: byKey,
      byPid: byPid,
      stats: { entries: problems.length, unique: unique, examples: examples, practices: practices, chapters: chapters.length, lessons: lessons }
    };
  }

  function ensure() {
    var w = win();
    if (!state.ref || state.ref !== (w && w.CATALOG)) build();
    return state;
  }

  function sessionOf() {
    var s = null;
    try { s = LK.auth && LK.auth.getSession ? LK.auth.getSession() : null; } catch (e) { s = null; }
    return s;
  }

  function studentKeyOf() {
    var s = sessionOf();
    if (!s) return GUEST;
    return String(s.studentKey || s.name || GUEST) || GUEST;
  }

  function doneSet() {
    var out = {}, list = LK.progress ? LK.progress.read() : [], i;
    for (i = 0; i < list.length; i++) out[list[i]] = 1;
    return out;
  }

  function summaryOut(sum, done) {
    var o = {
      ref: { source: sum.ref.source, id: sum.ref.id, key: sum.ref.key },
      title: sum.title,
      groupId: sum.groupId,
      lessonNo: sum.lessonNo,
      type: sum.type,
      acceptCount: sum.acceptCount,
      submitCount: sum.submitCount,
      timeLimitMs: sum.timeLimitMs,
      memoryLimitKb: sum.memoryLimitKb,
      difficulty: sum.difficulty,
      done: !!done[sum.ref.key]
    };
    return o;
  }

  /* ---------- 1. 目录 ---------- */
  function getCatalog() {
    var st = ensure(), done = doneSet(), list = [], i;
    for (i = 0; i < st.problems.length; i++) list.push(summaryOut(st.problems[i], done));
    return {
      schemaVersion: SCHEMA,
      chapters: clone(st.chapters),
      problems: list,
      stats: {
        entries: st.stats.entries,
        unique: st.stats.unique,
        examples: st.stats.examples,
        practices: st.stats.practices,
        chapters: st.stats.chapters,
        lessons: st.stats.lessons
      }
    };
  }

  /* ---------- 2/3. 章、课 ---------- */
  function getChapter(chapterId) {
    var st = ensure(), id = String(chapterId || ""), i;
    for (i = 0; i < st.chapters.length; i++) {
      if (String(st.chapters[i].id) === id) return clone(st.chapters[i]);
    }
    return null;
  }

  function getLesson(chapterId, lessonNo) {
    var ch = getChapter(chapterId), no = Number(lessonNo), i;
    if (!ch || !Array.isArray(ch.lessons)) return null;
    for (i = 0; i < ch.lessons.length; i++) {
      if (Number(ch.lessons[i].no) === no) return ch.lessons[i];
    }
    return null;
  }

  /* ---------- 4. 单题 ---------- */
  function getProblem(ref) {
    var st = ensure(), key = normalizeKey(ref), sum = st.byKey[key];
    if (!sum) {
      var pid = pidOfKey(key);
      if (pid !== null && st.byPid[pid]) sum = st.byPid[pid];
    }
    if (!sum) return null;
    return summaryOut(sum, doneSet());
  }

  /* ---------- 5. 做题页地址 ---------- */
  function getProblemUrl(ref, opts) {
    var key = normalizeKey(ref), pid = pidOfKey(key), params = {};
    if (pid === null) throw makeError("BAD_REQUEST", "题号无法解析：" + String(ref));
    params.pid = pid;
    if (opts && typeof opts === "object") {
      if (opts.g !== undefined && opts.g !== null && opts.g !== "") params.g = opts.g;
      if (opts.l !== undefined && opts.l !== null && opts.l !== "") params.l = opts.l;
    }
    if (!LK.routes || typeof LK.routes.url !== "function") {
      throw makeError("BAD_REQUEST", "shared/routes.js 未加载");
    }
    return LK.routes.url("problem", params);
  }

  /* ---------- 6. 进度 ---------- */
  function getProgress() {
    var st = ensure(), keys = LK.progress ? LK.progress.read() : [], valid = [], i, done = {};
    for (i = 0; i < st.problems.length; i++) valid.push(st.problems[i].ref.key);
    for (i = 0; i < keys.length; i++) if (st.byKey[keys[i]]) done[keys[i]] = 1;
    return {
      schemaVersion: SCHEMA,
      studentKey: studentKeyOf(),
      doneKeys: Object.keys(done),
      completedCount: Object.keys(done).length
    };
  }

  /* ---------- 7. 手动记完成（迁移期唯一写入口） ---------- */
  function markDone(problemKey, meta) {
    var key = normalizeKey(problemKey);
    if (!key) throw makeError("BAD_REQUEST", "problemKey 不能为空");
    var added = LK.progress ? LK.progress.add(key).added : false;
    var detailExtra = {
      studentKey: studentKeyOf(),
      problemKey: key,
      done: true,
      source: (meta && meta.source) ? String(meta.source) : "manual-submit-button",
      added: added
    };
    if (LK.bus && LK.contracts && LK.contracts.makeEvent) {
      var ev = LK.contracts.makeEvent(LK.contracts.events.PROBLEMS_PROGRESS_CHANGED, detailExtra);
      LK.bus.emit(ev.name, ev.detail);
    }
    return getProgress();
  }

  /* ---------- 8. 判题 ---------- */
  function judgeUrl(req) {
    if (req && typeof req.judgeUrl === "string" && req.judgeUrl) return req.judgeUrl;
    var loc = win() && win().location;
    var proto = loc && loc.protocol;
    if (proto === "http:" || proto === "https:") return "/judge";
    return DEFAULT_JUDGE_URL;
  }

  function judgeResult(requestId, problemKey, patch) {
    var r = {
      requestId: String(requestId || ""),
      problemKey: String(problemKey || ""),
      transportOk: false,
      status: "judge_unavailable",
      passed: false,
      compileMessage: "",
      runMessage: "",
      stdout: "",
      durationMs: 0,
      memoryKb: 0,
      raw: null
    };
    if (patch) for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) r[k] = patch[k];
    r.passed = (LK.contracts && LK.contracts.isJudgePassed)
      ? LK.contracts.isJudgePassed(r.status)
      : (r.status === "accepted");
    return r;
  }

  function sameOutput(a, b) {
    var norm = function (s) {
      return String(s === undefined || s === null ? "" : s)
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(function (x) { return x.replace(/\s+$/, ""); })
        .join("\n")
        .replace(/\n+$/, "");
    };
    return norm(a) === norm(b);
  }

  function mapStatus(res, expected) {
    var st = res && res.judgeStatus;
    if (st === "CE") return "compile_error";
    if (st === "TLE") return "time_limit";
    if (st === "MLE" || st === "OLE" || st === "RE") return "runtime_error";
    if (st === "OK") {
      if (typeof expected === "string") {
        return sameOutput(res.run && res.run.stdout, expected) ? "accepted" : "wrong_answer";
      }
      return "accepted";
    }
    return "judge_unavailable";
  }

  function postJSON(url, body, headers, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ctl = (typeof AbortController === "function") ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error("timeout"));
      }, timeoutMs);
      var opt = { method: "POST", headers: headers, body: JSON.stringify(body) };
      if (ctl) opt.signal = ctl.signal;
      global.fetch(url, opt).then(function (r) {
        clearTimeout(timer);
        resolve(r);
      }, function (e) {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function evaluate(req) {
    req = req || {};
    var requestId = String(req.requestId || "");
    var key = normalizeKey(req.problem);
    var session = sessionOf();

    if (!session) return Promise.reject(makeError("AUTH_REQUIRED", "判题需要先登录"));
    if (!key) return Promise.reject(makeError("BAD_REQUEST", "problem 不能为空"));
    if (typeof req.sourceCode !== "string" || !req.sourceCode.replace(/\s/g, "")) {
      return Promise.reject(makeError("BAD_REQUEST", "sourceCode 不能为空"));
    }
    if (typeof global.fetch !== "function") {
      return Promise.resolve(judgeResult(requestId, key, {
        status: "judge_unavailable", runMessage: "当前环境没有 fetch，判题不可用"
      }));
    }

    var base = judgeUrl(req);
    var lang = req.language ? String(req.language) : "cpp14";
    var stdin = typeof req.stdin === "string" ? req.stdin : "";
    var ticket = "";

    return postJSON(base + "/ticket", { token: session.token }, { "Content-Type": "application/json" }, 5000)
      .then(function (r) {
        if (!r.ok) throw makeError(r.status === 401 ? "AUTH_REQUIRED" : "JUDGE_UNAVAILABLE", "换票失败：" + r.status);
        return r.json();
      })
      .then(function (j) {
        ticket = (j && j.ticket) || "";
        if (!ticket) throw makeError("JUDGE_UNAVAILABLE", "服务端没有下发票据");
        return postJSON(base + "/run", { code: req.sourceCode, stdin: stdin, lang: lang },
          { "Content-Type": "application/json", "X-Judge-Ticket": ticket }, 12000);
      })
      .then(function (r) {
        if (r.status === 401) throw makeError("AUTH_REQUIRED", "票据失效，请重新登录");
        if (!r.ok) throw makeError("JUDGE_UNAVAILABLE", "判题服务返回 " + r.status);
        return r.json();
      })
      .then(function (res) {
        var result = judgeResult(requestId, key, {
          transportOk: true,
          status: mapStatus(res, req.expectedStdout),
          compileMessage: String((res.compile && res.compile.log) || ""),
          runMessage: String((res.run && res.run.stderr) || ""),
          stdout: String((res.run && res.run.stdout) || ""),
          durationMs: Math.round(Number((res.run && res.run.time) || 0) * 1000) || 0,
          memoryKb: Number((res.run && res.run.mem) || 0) || 0,
          raw: res
        });
        emitJudge(result);
        return result;
      }, function (err) {
        var result = judgeResult(requestId, key, {
          status: "judge_unavailable",
          runMessage: String((err && err.message) || "判题请求失败")
        });
        emitJudge(result);
        if (err && err.code === "AUTH_REQUIRED") return Promise.reject(err);
        return result;
      });
  }

  function emitJudge(result) {
    if (!(LK.bus && LK.contracts && LK.contracts.makeEvent)) return;
    var ev = LK.contracts.makeEvent(LK.contracts.events.JUDGE_FINISHED, {
      requestId: result.requestId,
      problemKey: result.problemKey,
      result: result
    });
    LK.bus.emit(ev.name, ev.detail);
  }

  /* ---------- 9. 统计 ---------- */
  function getStats() {
    var st = ensure();
    return {
      entries: st.stats.entries,
      unique: st.stats.unique,
      examples: st.stats.examples,
      practices: st.stats.practices,
      chapters: st.stats.chapters,
      lessons: st.stats.lessons
    };
  }

  LK.problems.schemaVersion = SCHEMA;
  LK.problems.GUEST = GUEST;
  LK.problems.getCatalog = getCatalog;
  LK.problems.getChapter = getChapter;
  LK.problems.getLesson = getLesson;
  LK.problems.getProblem = getProblem;
  LK.problems.getProblemUrl = getProblemUrl;
  LK.problems.getProgress = getProgress;
  LK.problems.markDone = markDone;
  LK.problems.evaluate = evaluate;
  LK.problems.getStats = getStats;
})(typeof globalThis !== "undefined" ? globalThis : this);
