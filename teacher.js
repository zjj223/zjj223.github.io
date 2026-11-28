/* 教师工作台逻辑：发洛克贝 / 发邮件 / 班级与账号 / 操作记录
   依赖 auth.js（门票）+ 现有 RPC（class_roster 等），新 RPC 未部署时自动降级并提示 */
(function () {
  var SB = { url: "https://rhfhtgjpnzasrlkcfdim.supabase.co", key: "sb_publishable__dL04pGC3ZNvK8tsIfixvQ_l6p5FOMC" };
  var user = null, roster = [], notReady = {};      // notReady: 记哪些新接口 404
  var pickCoin = {}, pickMail = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function time(t) { if (!t) return "—"; var d = new Date(t); if (isNaN(d.getTime())) return "—"; return (d.getMonth() + 1) + "-" + d.getDate() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }

  function token() { return user && user.token; }

  async function rpc(fn, body) {
    var r = await fetch(SB.url + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SB.key, Authorization: "Bearer " + SB.key },
      body: JSON.stringify(body || {})
    });
    if (r.status === 404) { notReady[fn] = true; var e = new Error("not_deployed"); e.notDeployed = true; throw e; }
    if (!r.ok) throw new Error("rpc " + fn + " " + r.status);
    return r.json();
  }

  function saveOf(row) { try { return row && row.save ? row.save : {}; } catch (e) { return {}; } }
  function coinOf(row) { var s = saveOf(row); return Math.max(0, Math.floor(Number(s.rockbell) || 0)); }
  function petsOf(row) { var s = saveOf(row); var p = s.pets || s.petList || []; return Array.isArray(p) ? p.length : 0; }

  /* ---------------- 身份 ---------------- */
  async function whoAmI() {
    var g = window.AuthGate;
    if (!g || !g.user || !g.user()) {
      $("twWho").textContent = "未登录";
      return false;
    }
    user = g.user();
    try {
      var res = await rpc("auth_staff", { p_token: token() });
      if (res && res.ok) {
        var isT = res.role === "root" || res.role === "admin" || res.role === "teacher";
        $("twWho").innerHTML = esc(res.name) + " · " + (isT ? "教师" : "学生");
        if (!isT) return false;
        user = { name: res.name, token: token(), role: "teacher" };
        return true;
      }
    } catch (e) {
      /* 新接口没部署：先用门票自带的角色兜底 */
    }
    if (user.role === "teacher") {
      $("twWho").innerHTML = esc(user.name) + " · 教师";
      return true;
    }
    $("twWho").innerHTML = esc(user.name) + " · 学生";
    return false;
  }

  function blocked(msg) {
    document.querySelector(".tw-main").innerHTML =
      '<div class="card"><div class="banner bad">' + esc(msg) + '</div>' +
      '<button class="btn" onclick="location.href=\'学习台.html\'">回学习台</button></div>';
    document.querySelector(".tw-tabs").style.display = "none";
  }

  /* ---------------- 名单 ---------------- */
  async function loadRoster() {
    try {
      var rows = await rpc("class_roster", { p_token: token() });
      roster = Array.isArray(rows) ? rows : (rows && rows.roster) || [];
    } catch (e) { roster = []; }
    try {
      if ($("rosterCount")) $("rosterCount").textContent = String(roster.length);
      renderPicks();
      renderRoster();
      renderAudit();
    } catch (e2) {
      var el = $("coinPick"); if (el) el.innerHTML = '<div class="hint">渲染出错：' + esc(String(e2 && e2.message || e2)) + '</div>';
    }
  }

  function match(name, q) { return !q || String(name).indexOf(q) >= 0; }

  function renderPicks() {
    var q1 = ($("coinSearch") && $("coinSearch").value.trim()) || "";
    var q2 = ($("mailSearch") && $("mailSearch").value.trim()) || "";
    if ($("coinPick")) {
      var rows1 = roster.filter(function (r) { return match(r.name, q1); });
      $("coinPick").innerHTML = rows1.length ? rows1.map(function (r) {
        var on = pickCoin[r.name] ? " on" : "";
        return '<label class="' + (on ? "on" : "") + '" data-name="' + esc(r.name) + '">' +
          '<input type="checkbox" data-k="coin" data-name="' + esc(r.name) + '"' + (pickCoin[r.name] ? " checked" : "") + ' />' +
          '<span class="nm">' + esc(r.name) + '</span><span class="mt">' + num(coinOf(r)) + ' 洛克贝</span></label>';
      }).join("") : '<div class="hint">没找到人</div>';
    }
    if ($("mailPick")) {
      var rows2 = roster.filter(function (r) { return match(r.name, q2); });
      $("mailPick").innerHTML = rows2.length ? rows2.map(function (r) {
        var on = pickMail[r.name] ? " on" : "";
        return '<label class="' + (on ? "on" : "") + '" data-name="' + esc(r.name) + '">' +
          '<input type="checkbox" data-k="mail" data-name="' + esc(r.name) + '"' + (pickMail[r.name] ? " checked" : "") + ' />' +
          '<span class="nm">' + esc(r.name) + '</span><span class="mt">' + num(coinOf(r)) + ' 洛克贝</span></label>';
      }).join("") : '<div class="hint">没找到人</div>';
    }
    var mc = Object.keys(pickMail).length;
    if ($("mailCount")) $("mailCount").textContent = "已选 " + mc + " 人";
  }

  function renderRoster() {
    var q = ($("rosterSearch") && $("rosterSearch").value.trim()) || "";
    var rows = roster.filter(function (r) { return match(r.name, q); });
    if (!$("rosterBody")) return;
    $("rosterBody").innerHTML = rows.length ? rows.map(function (r) {
      return "<tr><td>" + esc(r.name) + (r.online ? ' <span class="mt" style="color:#2f8a4f">在线</span>' : "") + "</td>" +
        '<td class="num">' + num(coinOf(r)) + "</td>" +
        '<td class="num">' + petsOf(r) + "</td>" +
        "<td>" + time(r.last_login_at || r.last_seen_at) + "</td>" +
        "<td>" + time(r.updated_at) + "</td>" +
        '<td><button class="btn ghost sm" data-act="kick" data-name="' + esc(r.name) + '">踢下线</button> ' +
        '<button class="btn danger sm" data-act="del" data-name="' + esc(r.name) + '">注销</button></td></tr>';
    }).join("") : '<tr><td colspan="6" class="hint">没有记录</td></tr>';
  }

  /* ---------------- 发洛克贝 ---------------- */
  function targets() {
    var names = Object.keys(pickCoin);
    var manual = ($("coinManual").value || "").split(/[,，、\s]+/).filter(Boolean);
    manual.forEach(function (n) { if (roster.some(function (r) { return r.name === n; }) && names.indexOf(n) < 0) names.push(n); });
    return names;
  }

  function log(txt) { var el = $("coinLog"); if (!el) return; el.insertAdjacentHTML("afterbegin", "<div>" + esc(txt) + "</div>"); }

  async function grantOne(name, delta, reason) {
    try {
      var res = await rpc("teacher_grant_coin", { p_token: token(), p_name: name, p_delta: delta, p_reason: reason || "" });
      if (res && res.ok) return { ok: true, before: res.before, after: res.after, mode: "新接口" };
      return { ok: false, msg: (res && res.code) === "daily_limit" ? "超出当日 5000 上限" : (res && res.code) === "too_large" ? "单次超过 999" : "没通过：" + (res && res.code) };
    } catch (e) {
      if (!e.notDeployed) return { ok: false, msg: "连不上云端" };
      /* 降级：走旧接口整份存档写回 */
      var row = roster.find(function (r) { return r.name === name; });
      if (!row) return { ok: false, msg: "名单里没这个人" };
      var save = saveOf(row);
      var before = Math.max(0, Math.floor(Number(save.rockbell) || 0));
      var after = Math.max(0, Math.min(999999, before + delta));
      save.rockbell = after;
      var r2 = await rpc("teacher_set_save", { p_token: token(), p_name: name, p_save: save });
      if (r2 && r2.ok !== false) {
        row.save = save;
        return { ok: true, before: before, after: after, mode: "旧接口" };
      }
      return { ok: false, msg: "写回存档失败" };
    }
  }

  async function doCoin() {
    var names = targets();
    var delta = parseInt(($("coinNum").value || "0"), 10);
    var reason = ($("coinReason").value || "").trim();
    if (!names.length) return toast("coin", "先勾人，或者把名字填进去", "bad");
    if (!delta) return toast("coin", "数量不能是 0", "bad");
    if (Math.abs(delta) > 999) return toast("coin", "单次最多 ±999", "bad");
    if (delta > 0 && names.length * delta > 5000) {
      if (!confirm("这次一共要发 " + names.length * delta + " 洛克贝，可能碰到每人每天 5000 的上限。继续？")) return;
    }
    var btn = $("btnCoin"); btn.disabled = true; btn.textContent = "发放中…";
    var done = 0, fail = 0;
    for (var i = 0; i < names.length; i++) {
      var r = await grantOne(names[i], delta, reason);
      if (r.ok) { done++; log(names[i] + " " + (delta > 0 ? "+" : "") + delta + " → " + num(r.after) + "（" + r.mode + "）"); }
      else { fail++; log(names[i] + " 失败：" + r.msg); }
    }
    toast("coin", "发放完成：成功 " + done + " 人，失败 " + fail + " 人", fail ? "bad" : "ok");
    btn.disabled = false; btn.textContent = "确认发放";
    await loadRoster();
  }

  /* ---------------- 发邮件 ---------------- */
  function dayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }

  function buildMail(title, body, coin) {
    return {
      id: "m_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      sender: "卡罗西亚邮局",
      title: title,
      date: dayKey(),
      icon: "💌",
      body: body,
      rewards: { coin: coin, items: [], balls: [], pets: [] },
      read: false,
      claimed: false
    };
  }

  async function appendMail(row, mail) {
    var save = JSON.parse(JSON.stringify(saveOf(row) || {}));
    if (!save.mailbox || !Array.isArray(save.mailbox.mails)) save.mailbox = { mails: [] };
    save.mailbox.mails.unshift(mail);
    if (save.mailbox.mails.length > 200) save.mailbox.mails.length = 200;
    var res = await rpc("teacher_set_save", { p_token: token(), p_name: row.name, p_save: save });
    if (res && res.ok !== false) { row.save = save; row.updated_at = new Date().toISOString(); return true; }
    return false;
  }

  async function doMail() {
    var names = Object.keys(pickMail);
    var title = ($("mailTitle").value || "").trim();
    var body = ($("mailBody").value || "").trim();
    var coin = parseInt(($("mailCoin").value || "0"), 10) || 0;
    if (!names.length) return toast("mail", "先勾收件人", "bad");
    if (!title) return toast("mail", "标题不能空", "bad");
    if (names.length > 50) return toast("mail", "一次最多 50 人", "bad");
    if (coin < 0 || coin > 5000) return toast("mail", "附件洛克贝 0~5000", "bad");
    var btn = $("btnMail"); btn.disabled = true; btn.textContent = "发送中…";

    /* 优先走服务端邮件表：在线学生也不会被存档冲掉 */
    try {
      var res = await rpc("teacher_send_mail", {
        p_token: token(), p_names: names, p_title: title, p_body: body,
        p_rewards: { coin: coin }, p_sender: "卡罗西亚邮局"
      });
      if (res && res.ok) {
        toast("mail", "已发给 " + res.sent + " 人（服务端邮件）。学生进游戏在站内信里领取。", "ok");
        pickMail = {}; $("mailTitle").value = ""; $("mailBody").value = ""; $("mailCoin").value = 0; renderPicks();
        btn.disabled = false; btn.textContent = "确认发送";
        return;
      }
      toast("mail", "没发出去：" + ((res && res.code) || "未知"), "bad");
      btn.disabled = false; btn.textContent = "确认发送";
      return;
    } catch (e) {
      if (!e.notDeployed) {
        toast("mail", "连不上云端", "bad");
        btn.disabled = false; btn.textContent = "确认发送";
        return;
      }
    }

    /* 兜底：服务端邮件表还没建，就写进学生存档（要先踢在线的人） */
    var online = names.filter(function (n) { var r = roster.find(function (x) { return x.name === n; }); return r && r.online; });
    for (var k = 0; k < online.length; k++) {
      try { await rpc("teacher_kick", { p_token: token(), p_name: online[k] }); } catch (e2) {}
    }
    if (online.length) {
      toast("mail", "服务端邮件表没建，改走存档：先把在线的 " + online.join("、") + " 踢下线…", "info");
      await new Promise(function (r) { setTimeout(r, 1500); });
    }

    var done = 0, fail = 0;
    for (var i = 0; i < names.length; i++) {
      var row = roster.find(function (r) { return r.name === names[i]; });
      btn.textContent = "发送中 " + (i + 1) + "/" + names.length;
      if (!row) { fail++; continue; }
      var mail = buildMail(title, body, coin);
      try {
        if (await appendMail(row, mail)) done++; else fail++;
      } catch (e3) { fail++; }
      toast("mail", "已发 " + done + "，失败 " + fail + "（还在继续）", "info");
    }
    toast("mail", "完成：成功 " + done + " 人，失败 " + fail + " 人。学生下次进游戏，在站内信里领取。", fail ? "bad" : "ok");
    btn.disabled = false; btn.textContent = "确认发送";
    if (!fail) { pickMail = {}; $("mailTitle").value = ""; $("mailBody").value = ""; $("mailCoin").value = 0; renderPicks(); }
    renderRoster();
  }

  /* ---------------- 班级与账号 ---------------- */
  async function doKick(name) {
    if (!confirm("把 " + name + " 踢下线？他手上的门票立刻作废。")) return;
    try {
      var res = await rpc("teacher_kick", { p_token: token(), p_name: name });
      classMsg(res && res.ok ? name + " 已下线" : "没踢成：" + ((res && res.code) || "未知"), res && res.ok);
      await loadRoster();
    } catch (e) { classMsg("连不上云端", false); }
  }

  async function doDelete(name) {
    if (!confirm("注销 " + name + "？会先存一份存档快照，然后把账号、门票、邮件都删掉。")) return;
    if (!confirm("真的要注销 " + name + "？这一步不能撤销。")) return;
    try {
      var res = await rpc("admin_delete_student", { p_token: token(), p_names: [name] });
      if (res && res.ok && res.deleted) classMsg(name + " 已注销，快照写进操作记录", true);
      else classMsg("没注销成：" + ((res && res.code) || "未知"), false);
      await loadRoster();
    } catch (e) {
      classMsg(e.notDeployed ? "注销接口还没上线（要 root 账号 + 先跑工作台 SQL）" : "连不上云端", false);
    }
  }

  function classMsg(t, ok) { var el = $("classMsg"); if (!el) return; el.innerHTML = '<span style="color:' + (ok ? "#1f6b39" : "#8d3226") + '">' + esc(t) + "</span>"; }

  async function newAcc() {
    var name = prompt("新学生账号的名字（2~6 个汉字）");
    if (!name) return;
    var pin = prompt("初始密码（4~6 位数字）", "1234");
    if (!pin) return;
    try {
      var res = await rpc("teacher_create", { p_token: token(), p_name: name.trim(), p_pin: pin.trim(), p_save: {} });
      classMsg(res && res.ok ? "已建账号 " + name + "，密码 " + pin : "没建成：" + ((res && res.code) || "未知"), res && res.ok);
      await loadRoster();
    } catch (e) { classMsg("连不上云端", false); }
  }

  async function resetPins() {
    if (!confirm("把全班密码重置成 1234？")) return;
    try {
      var res = await rpc("teacher_reset_pins", { p_token: token() });
      classMsg(res && res.ok ? "已重置 " + (res.count || res.reset || 0) + " 个账号" : "没重置成：" + ((res && res.code) || "未知"), res && res.ok);
    } catch (e) { classMsg("连不上云端", false); }
  }

  async function lockClass() {
    if (!confirm("暂停/恢复全班登录？确认后切换当前状态。")) return;
    try {
      var res = await rpc("class_lock", { p_token: token(), p_on: true });
      classMsg(res && res.ok ? "已暂停全班登录（再点一次可恢复）" : "没成功：" + ((res && res.code) || "未知"), res && res.ok);
    } catch (e) { classMsg("连不上云端", false); }
  }

  /* ---------------- 操作记录 ---------------- */
  async function renderAudit() {
    var el = $("auditLog"); if (!el) return;
    try {
      var res = await rpc("admin_audit_list", { p_token: token(), p_limit: 40 });
      var rows = (res && res.logs) || [];
      el.innerHTML = rows.length ? rows.map(function (r) {
        return "<div>" + time(r.created_at) + " · " + esc(r.actor || "") + " " + esc(r.action) + " → " + esc(r.target || "") + "</div>";
      }).join("") : '<div class="hint">还没有记录</div>';
    } catch (e) {
      el.innerHTML = '<div class="hint">' + (e.notDeployed ? "日志接口还没上线（先跑 supabase_后台管理_20261126.sql）；发币/发邮件仍可用。" : "读不到日志") + "</div>";
    }
  }

  /* ---------------- 小工具 ---------------- */
  function toast(where, txt, kind) {
    var el = $(where === "coin" ? "coinMsg" : "mailMsg");
    if (!el) return;
    var cls = kind === "ok" ? "ok" : (kind === "info" ? "info" : "bad");
    el.innerHTML = '<div class="banner ' + cls + '">' + esc(txt) + "</div>";
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll(".tw-tab"), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tw-tab"), function (x) { x.classList.remove("on"); });
        b.classList.add("on");
        Array.prototype.forEach.call(document.querySelectorAll(".tw-panel"), function (p) { p.hidden = true; });
        $("p-" + b.dataset.tab).hidden = false;
        if (b.dataset.tab === "log") renderAudit();
      };
    });

    $("btnBack").onclick = function () { location.href = "学习台.html"; };

    $("coinPick").addEventListener("change", function (e) {
      var cb = e.target.closest("input[type=checkbox]"); if (!cb) return;
      var n = cb.dataset.name;
      if (cb.checked) pickCoin[n] = true; else delete pickCoin[n];
      cb.closest("label").classList.toggle("on", cb.checked);
    });
    $("mailPick").addEventListener("change", function (e) {
      var cb = e.target.closest("input[type=checkbox]"); if (!cb) return;
      var n = cb.dataset.name;
      if (cb.checked) pickMail[n] = true; else delete pickMail[n];
      cb.closest("label").classList.toggle("on", cb.checked);
      $("mailCount").textContent = "已选 " + Object.keys(pickMail).length + " 人";
    });
    $("coinSearch").oninput = renderPicks;
    $("mailSearch").oninput = renderPicks;
    $("rosterSearch").oninput = renderRoster;

    $("mailPickAll").onclick = function () { roster.forEach(function (r) { pickMail[r.name] = true; }); renderPicks(); };
    $("mailPickNone").onclick = function () { pickMail = {}; renderPicks(); };

    $("btnCoin").onclick = doCoin;
    $("btnMail").onclick = doMail;
    $("btnMailClear").onclick = function () { $("mailTitle").value = ""; $("mailBody").value = ""; $("mailCoin").value = 0; };
    $("btnNewAcc").onclick = newAcc;
    $("btnResetPin").onclick = resetPins;
    $("btnLockClass").onclick = lockClass;

    $("rosterBody").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-act]"); if (!b) return;
      if (b.dataset.act === "kick") doKick(b.dataset.name);
      if (b.dataset.act === "del") doDelete(b.dataset.name);
    });
  }

  async function start() {
    bind();
    var ok = await whoAmI();
    if (!ok) { blocked("这个页面只给教师账号用。回学习台用教师账号登录，再从身份卡里点「教师工作台」。"); return; }
    await loadRoster();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
