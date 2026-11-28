/* ================= AuthGate：全站登录闸 =================
   作用：页面不再被登录挡；需要身份的动作调 AuthGate.require()
   门票落 localStorage，24 小时内刷新免登录；每次开页面静默 student_check 校验
   依赖：无（不依赖 app.js / nav.js，单独可跑）
*/
window.AuthGate = (function () {
  const KEY = "carlosia:auth:v1";
  const TTL = 24 * 3600 * 1000;
  const SB = {
    url: "https://rhfhtgjpnzasrlkcfdim.supabase.co",
    key: "sb_publishable__dL04pGC3ZNvK8tsIfixvQ_l6p5FOMC",
  };
  // nav.js 的昵称身份：登录成功后同步过去，让带导航条的页面直接显示名字
  const UKEY = "lk.user.v1";

  let user = load();
  const listeners = [];
  let pending = null;
  let maskEl = null;
  let menuEl = null;
  let teacherMode = false;
  let lockMode = false;
  let booted = false;

  function online() {
    return location.protocol !== "file:" && !!SB.url && !!SB.key;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const u = JSON.parse(raw);
      if (!u || !u.token || !u.exp) return null;
      if (Date.now() > u.exp) {
        localStorage.removeItem(KEY);
        return null;
      }
      return u;
    } catch (e) {
      return null;
    }
  }

  function persist(u) {
    try {
      localStorage.setItem(KEY, JSON.stringify(u));
    } catch (e) {}
  }

  function syncNickname(name, role) {
    try {
      if (window.lkUser) window.lkUser.set(name, role || "student");
      else if (name) localStorage.setItem(UKEY, JSON.stringify({ name: name, role: role || "student", at: new Date().toISOString() }));
      else localStorage.removeItem(UKEY);
    } catch (e) {}
  }

  function setSession(name, token, role) {
    user = { name: name, token: token, role: role || "student", exp: Date.now() + TTL };
    persist(user);
    syncNickname(name, user.role);
    emit();
  }

  function clear() {
    user = null;
    try {
      localStorage.removeItem(KEY);
    } catch (e) {}
    syncNickname(null);
    emit();
  }

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn(user);
      } catch (e) {}
    });
  }

  async function rpc(fn, body) {
    const r = await fetch(SB.url + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SB.key,
        Authorization: "Bearer " + SB.key,
      },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error("rpc " + fn + " " + r.status);
    return r.json();
  }

  /* ---------------- 弹窗 ---------------- */
  function buildMask() {
    if (maskEl) return maskEl;
    maskEl = document.createElement("div");
    maskEl.className = "auth-mask";
    maskEl.hidden = true;
    maskEl.innerHTML =
      '<div class="auth-card" role="dialog" aria-modal="true">' +
      '<button type="button" class="auth-close" aria-label="关闭">×</button>' +
      '<header class="auth-head">' +
      '<span class="auth-seal" aria-hidden="true">俊</span>' +
      '<div><h2 class="auth-title">登录 · 卡罗西亚</h2>' +
      '<p class="auth-sub">账号和密码由老师统一发放，登录后进度跟着账号走</p></div>' +
      '</header>' +
      '<form class="auth-form">' +
      '<label class="auth-field auth-field-name"><span>账号名</span>' +
      '<input class="auth-name" placeholder="和老师约好的那个名字" autocomplete="off" maxlength="12" /></label>' +
      '<label class="auth-field"><span>密码</span>' +
      '<input class="auth-pass" placeholder="4~6 位数字" inputmode="numeric" autocomplete="off" maxlength="12" /></label>' +
      '<button type="submit" class="auth-submit">进入大陆</button>' +
      "</form>" +
      '<p class="auth-err" hidden></p>' +
      "</div>";
    document.body.appendChild(maskEl);
    maskEl.querySelector(".auth-close").onclick = close;
    maskEl.addEventListener("click", function (e) {
      if (e.target === maskEl) close();
    });
    maskEl.querySelector(".auth-form").onsubmit = onSubmit;
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && maskEl && !maskEl.hidden) close();
    });
    return maskEl;
  }

  function open(opts) {
    opts = opts || {};
    pending = opts.onSuccess || null;
    lockMode = !!opts.lock;
    if (!online()) {
      // file:// 本地双击：没有服务端，直接放行
      if (pending) {
        const fn = pending;
        pending = null;
        fn(user);
      }
      return true;
    }
    buildMask();
    teacherMode = !!opts.teacher;
    const m = maskEl;
    const nameEl = m.querySelector(".auth-name");
    m.querySelector(".auth-pass").placeholder = teacherMode ? "后台权限码" : "4~6 位数字密码";
    m.querySelector(".auth-pass").inputMode = teacherMode ? "text" : "numeric";
    const nameField = m.querySelector(".auth-field-name");
    if (nameField) nameField.hidden = teacherMode;
    m.querySelector(".auth-err").hidden = true;
    m.querySelector(".auth-close").hidden = lockMode;
    m.hidden = false;
    if (!teacherMode) nameEl.focus();
    else m.querySelector(".auth-pass").focus();
    return false;
  }

  function close() {
    if (lockMode) return; // 强制登录：卡不能关
    if (maskEl) maskEl.hidden = true;
    pending = null;
  }

  async function onSubmit(e) {
    e.preventDefault();
    const m = maskEl;
    const nameEl = m.querySelector(".auth-name");
    const passEl = m.querySelector(".auth-pass");
    const err = m.querySelector(".auth-err");
    const name = (nameEl.value || "").trim();
    const pass = (passEl.value || "").trim();
    const isTeacher = teacherMode;

    function fail(msg) {
      err.textContent = msg;
      err.hidden = false;
      return false;
    }
    if (!isTeacher && !name) return fail("请先填账号名");
    if (!pass) return fail(isTeacher ? "请输入权限码" : "请输入密码");

    const btn = m.querySelector(".auth-submit");
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "验证中…";
    try {
      if (isTeacher) {
        const res = await rpc("teacher_login", { p_code: pass });
        if (!res || !res.ok) return fail("权限码不对");
        setSession("老师", res.token, "teacher");
      } else {
        const isPin = /^\d{4,6}$/.test(pass);
        const res = isPin
          ? await rpc("student_login", { p_name: name, p_pin: pass })
          : await rpc("teacher_enter", { p_code: pass, p_name: name });
        if (!res || !res.ok) {
          const code = res && res.code;
          return fail(
            code === "bad_pin"
              ? "密码不对，再试一次"
              : code === "no_user"
              ? "没有这个账号，请让老师开一个"
              : code === "locked"
              ? "试错太多，等 " + (res.seconds || 60) + " 秒再试"
              : code === "class_locked"
              ? "老师已暂停全班登录，等老师说开始"
              : "登录没通过，检查名字和密码"
          );
        }
        setSession(name, res.token, "student");
        try {
          localStorage.setItem(
            "carlosia:auth:bootsave:v1",
            JSON.stringify({ name: name, save: res.save || {}, at: Date.now() })
          );
        } catch (e) {}
      }
      m.hidden = true;
      lockMode = false;
      const fn = pending;
      pending = null;
      if (fn) fn(user);
    } catch (ex) {
      fail("连不上云端，检查网络");
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  /* ---------------- 已登录小菜单 ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function openProfileMenu(anchor) {
    if (!menuEl) {
      menuEl = document.createElement("div");
      menuEl.className = "auth-menu";
      menuEl.hidden = true;
      document.body.appendChild(menuEl);
      document.addEventListener("click", function (e) {
        if (menuEl && !menuEl.hidden && !menuEl.contains(e.target)) menuEl.hidden = true;
      });
    }
    if (!menuEl.hidden) {
      menuEl.hidden = true;
      return;
    }
    menuEl.innerHTML =
      '<p class="auth-menu-name">' + esc(user ? user.name : "") + "</p>" +
      '<p class="auth-menu-sub">已登录 · 进度存在云端</p>' +
      (user && user.role === "teacher" ? '<button type="button" class="auth-menu-go">进入后台</button>' : "") +
      '<button type="button" class="auth-menu-out">退出登录</button>';
    menuEl.hidden = false;
    const goBtn = menuEl.querySelector(".auth-menu-go");
    if (goBtn) {
      goBtn.onclick = function () {
        menuEl.hidden = true;
        location.href = "admin.html";
      };
    }
    menuEl.querySelector(".auth-menu-out").onclick = function () {
      menuEl.hidden = true;
      logout();
    };
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      menuEl.style.right = Math.max(8, window.innerWidth - r.right) + "px";
      menuEl.style.top = r.bottom + 8 + "px";
    }
  }

  /* ---------------- 对外 ---------------- */
  function require(reason, cb) {
    if (user && Date.now() < user.exp) {
      if (cb) cb(user);
      return true;
    }
    open({ reason: reason, onSuccess: cb });
    return false;
  }

  function mountButton(el) {
    if (!el) return;
    const paint = function (u) {
      el.textContent = u ? u.name : "登录";
      el.classList.toggle("is-on", !!u);
      el.title = u ? "点击可退出登录" : "登录后进度存到账号";
    };
    el.onclick = function () {
      if (user) openProfileMenu(el);
      else open({});
    };
    paint(user);
    listeners.push(paint);
  }

  async function logout() {
    const t = user && user.token;
    if (t && online()) {
      try {
        await rpc("student_logout", { p_token: t });
      } catch (e) {}
    }
    clear();
    pending = null;
    location.reload();
  }

  async function restore() {
    user = load();
    if (user && online()) {
      try {
        let okFlag = true;
        try {
          const res = await rpc("student_check", { p_token: user.token });
          okFlag = !!(res && res.ok !== false);
        } catch (e) { okFlag = true; } // 网络问题不踢人
        if (!okFlag) {
          // 服务端说会话没了：先续期一次（24 小时内继续用），续不上才清
          try {
            const ext = await rpc("student_extend_session", { p_token: user.token });
            okFlag = !!(ext && ext.ok !== false);
          } catch (e) { okFlag = false; }
        }
        if (!okFlag) clear();
      } catch (e) {
        /* 网络抖动不踢人 */
      }
    }
    emit();
    return user;
  }

  /* ---------------- 页面统一守卫 ----------------
     boot({force:true})：无票就弹卡且关不掉；有票先静默校验（老师踢人立刻生效）
     boot({force:true, role:'teacher'})：只有老师门票放行，学生票会弹权限码卡
  */
  async function boot(opts) {
    opts = opts || {};
    if (booted) return user;
    booted = true;
    await restore();
    const needRole = opts.role || null;
    const ok = !!user && Date.now() < user.exp && (!needRole || user.role === needRole);
    if (!ok && opts.force !== false) {
      open({ lock: true, teacher: needRole === "teacher" });
    }
    return user;
  }

  return {
    user: function () {
      return user;
    },
    isLoggedIn: function () {
      return !!user && Date.now() < user.exp;
    },
    require: require,
    open: open,
    close: close,
    boot: boot,
    logout: logout,
    restore: restore,
    mountButton: mountButton,
    setSession: setSession,
    clear: clear,
    onChange: function (fn) {
      listeners.push(fn);
    },
  };
})();
