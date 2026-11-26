/* 全站顶部导航（各页共用）：页面上放 <div class="nav" data-page="home"><div class="nav-in" id="navIn"></div></div> */
(function () {
  var SVG = {
    home: '<path d="M10 3 3 9.5V17h5v-4h4v4h5V9.5z"/>',
    lib: '<rect x="3" y="3" width="6" height="6"/><rect x="11" y="3" width="6" height="6"/><rect x="3" y="11" width="6" height="6"/><rect x="11" y="11" width="6" height="6"/>',
    note: '<path d="M4 3h9a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2z"/><path d="M7 8h5M7 12h5"/>',
    month: '<path d="M5 3v14"/><path d="M5 4h9l-2.5 3 2.5 3H5"/>',
    contest: '<path d="M6 4h8v4a4 4 0 0 1-8 0z"/><path d="M6 5H4v2a2 2 0 0 0 2 2"/><path d="M14 5h2v2a2 2 0 0 1-2 2"/><path d="M10 12v3M7 17h6"/>',
    rank: '<path d="M4 17V10M10 17V5M16 17V8"/>',
    game: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.8v6.4M6.8 10h6.4"/>'
  };
  var ITEMS = [
    { k: 'home', t: '首页', h: '首页.html' },
    { k: 'lib', t: '练习题库', h: '练习题库.html' },
    { k: 'note', t: '学习笔记', h: '学习台.html' },
    { k: 'game', t: '游戏', h: 'index.html' },
    { k: 'month', t: '俊杰月赛', h: '俊杰月赛.html' },
    { k: 'contest', t: '比赛', h: '比赛.html' },
    { k: 'rank', t: '排行榜', h: '排行榜.html' }
  ];

  /* ---------------- 洛克贝数据层：直接读游戏存档，全站共用一份 ----------------
     游戏存档 = localStorage["carlosia_phase1_save_v1"]（云端模式会带 _cloud_ 后缀）
     结构 { version, selectedId, profiles:[{id,name,rockbell,...}], updatedAt }
     当前角色的洛克贝 = profiles 里 id 等于 selectedId 的那条的 rockbell */
  var SAVE_RE = /^carlosia_phase1_save_v1($|_)/;
  var WANT = (new URLSearchParams(location.search).get('name') || '').trim();

  /* 线上游戏用的是云端档（app.js 里 CLOUD_ENABLED 为真时 activeStorageKey 切到 _cloud_*），
     所以选档顺序：URL 指定玩家的云档 > 教师云档 > 其他云档 > 本地默认档，同级取 updatedAt 最新。 */
  function rank(key, want) {
    if (want && key === 'carlosia_phase1_save_v1_cloud_' + want) return 3;
    if (key === 'carlosia_phase1_save_v1_cloud_teacher') return 2;
    if (/_cloud_/.test(key)) return 1;
    return 0;
  }

  function pick(want) {
    var rows = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = String(localStorage.key(i));
        if (!SAVE_RE.test(k)) continue;
        var v = null;
        try { v = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { v = null; }
        if (!v) continue;
        /* 新版多角色档走 profiles；万一读到旧版单档 {profile:{}} 也认 */
        var list = Array.isArray(v.profiles) ? v.profiles : (v.profile ? [v.profile] : []);
        if (!list.length) continue;
        var cur = null;
        for (var j = 0; j < list.length; j++) {
          if (list[j] && list[j].id === v.selectedId) cur = list[j];
        }
        if (!cur) cur = list[0];
        if (!cur) continue;
        rows.push({
          key: k,
          name: String(cur.name || ''),
          coin: Math.max(0, Math.floor(Number(cur.rockbell) || 0)),
          at: String(v.updatedAt || ''),
          roles: list.length,
          rk: rank(k, want)
        });
      }
    } catch (e) {}
    if (!rows.length) return { key: '', name: '', coin: 0, at: '', roles: 0 };

    var hasCloud = false;
    for (var m = 0; m < rows.length; m++) if (rows[m].rk > 0) hasCloud = true;

    var best = null;
    for (var n = 0; n < rows.length; n++) {
      var r = rows[n];
      if (hasCloud && r.rk === 0) continue;           /* 有云档就不看本地旧档 */
      if (!best || r.rk > best.rk || (r.rk === best.rk && r.at > best.at)) best = r;
    }
    return best || rows[0];
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var subs = [], bc = null, last = '';
  function stamp(r) { return r.key + '|' + r.coin + '|' + r.name; }
  try { if (window.BroadcastChannel) bc = new BroadcastChannel('lk-coin'); } catch (e) {}

  function fire() {
    var r = pick(WANT), s = stamp(r);
    if (s === last) return;
    last = s;
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](r); } catch (e) {}
    }
  }

  function on(cb) {
    subs.push(cb);
    try { cb(pick(WANT)); } catch (e) {}
    return function () {
      var i = subs.indexOf(cb);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  window.lkCoin = {
    pick: pick,
    coin: function () { return pick(WANT).coin; },
    name: function () { return pick(WANT).name; },
    fmt: fmt,
    on: on,
    notify: function () { try { if (bc) bc.postMessage('x'); } catch (e) {} fire(); }
  };
  window.siteCoin = window.lkCoin.coin;
  window.siteName = function () { return window.lkCoin.name() || '同学'; };

  last = stamp(pick(WANT));

  /* 别的标签页/别的窗口改了存档 → 立刻同步；同页游戏回来走 visibilitychange */
  window.addEventListener('storage', function (e) {
    if (e && e.key && SAVE_RE.test(String(e.key))) fire();
  });
  if (bc) {
    try { bc.addEventListener('message', function () { fire(); }); } catch (e) {}
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') fire();
  });
  setInterval(function () {
    if (document.visibilityState !== 'hidden') fire();
  }, 3000);

  /* ---------------- 身份层：名字就是身份，不用密码 ----------------
     存在 localStorage["lk.user.v1"] = { name, role:'student'|'teacher', at }
     优先级：地址栏 ?name= > 登记过的身份 > 游戏存档里的角色名 */
  var UKEY = 'lk.user.v1';
  function lkUser() {
    try {
      var v = JSON.parse(localStorage.getItem(UKEY) || 'null');
      if (v && v.name) return { name: String(v.name), role: v.role === 'teacher' ? '老师' : '同学' };
    } catch (e) {}
    return null;
  }
  function saveUser(name, role) {
    try { localStorage.setItem(UKEY, JSON.stringify({ name: name, role: role || 'student', at: new Date().toISOString() })); } catch (e) {}
  }
  function killUser() { try { localStorage.removeItem(UKEY); } catch (e) {} }

  window.lkUser = { get: lkUser, set: saveUser, clear: killUser };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 通过题数 / 连续打卡，都从学习台自己的记录里读 */
  function stat() {
    var pass = 0, streak = 0;
    try {
      var d = JSON.parse(localStorage.getItem('studypage.done') || '[]');
      if (Array.isArray(d)) pass = d.length;
      else if (d && typeof d === 'object') pass = Object.keys(d).length;
    } catch (e) {}
    try {
      var ck = JSON.parse(localStorage.getItem('studypage.checkin') || 'null');
      if (ck != null) {
        if (typeof ck === 'number') streak = ck;
        else if (Array.isArray(ck)) streak = ck.length;
        else streak = Number(ck.streak || ck.days || 0) || 0;
      }
    } catch (e) {}
    return { pass: pass, streak: streak };
  }

  /* ---------------- 渲染 ---------------- */
  function icon(k) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5">' + SVG[k] + '</g></svg>';
  }

  var box = document.getElementById('navIn');
  var page = (document.querySelector('.nav') || {}).dataset || {};
  var state = { qname: WANT || null };

  var suffix = function () {
    return state.qname ? '?name=' + encodeURIComponent(state.qname) : '';
  };

  /* 把名字同步进地址栏，游戏那边的云档才认同一个人 */
  function pushName(n) {
    state.qname = n;
    WANT = n;                                   /* 金币也跟着换到这个人的云档 */
    last = ''; fire();
    try {
      if (location.protocol === 'file:') return;              /* 本地文件不改 query，改了反而打不开 */
      var u = new URL(location.href);
      if (u.searchParams.get('name') !== n) {
        u.searchParams.set('name', n);
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch (e) {}
  }
  function dropName() {
    state.qname = null;
    WANT = '';
    last = ''; fire();
    try {
      if (location.protocol === 'file:') return;
      var u = new URL(location.href);
      if (u.searchParams.get('name')) {
        u.searchParams.delete('name');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      }
    } catch (e) {}
  }

  function whoNow() {
    var u = lkUser();
    var name = state.qname || (u && u.name) || window.lkCoin.name() || '';
    return { guest: !name, name: name, user: u, role: (u && u.role) || '同学' };
  }

  function panelUser(w) {
    var s = stat(), c = window.lkCoin.coin();
    var rows = [
      ['01', '个人主页', '排行榜.html'],
      ['02', '学习记录', '学习台.html'],
      ['03', '练习题库', '练习题库.html'],
      ['04', '我的比赛', '比赛.html'],
      ['05', '箱庭世界', 'index.html'],
      ['06', '站内信', '首页.html#mailbar']
    ];
    var sub = w.role + (s.pass ? ' · 已通过 ' + s.pass + ' 题' : ' · 还没开始刷') + (s.streak ? ' · 连续 ' + s.streak + ' 天' : '');
    return '<div class="p-head">' +
        '<span class="seal">' + esc(w.name.trim().charAt(0)) + '</span>' +
        '<div class="meta"><b>' + esc(w.name) + '</b><span>' + esc(sub) + '</span></div>' +
      '</div>' +
      rows.map(function (r) {
        return '<a class="p-row" href="' + r[2] + suffix() + '"><em>' + r[0] + '</em><span>' + r[1] + '</span><i>›</i></a>';
      }).join('') +
      '<div class="p-foot"><span class="coin"><i></i>' + fmt(c) + ' 洛克贝</span>' +
        '<button type="button" class="p-quit">退出身份</button></div>';
  }

  function panelGuest() {
    return '<div class="p-head">' +
        '<span class="seal">?</span>' +
        '<div class="meta"><b>登录</b><span>名字就是身份，不用密码</span></div>' +
      '</div>' +
      '<form class="p-form" autocomplete="off">' +
        '<input name="nm" placeholder="你的名字，如 赵俊杰" maxlength="12">' +
        '<button type="submit">进入</button>' +
      '</form>' +
      '<div class="p-note">下次打开自动带你回来；游戏里的洛克贝也按这个名字归档。</div>';
  }

  function drawAcc(w) {
    var host = box && box.querySelector('.nav-acc');
    if (!host) return;
    var s = stat();
    var head = w.guest ? '登录' : w.name;
    var sub = w.guest ? '未登记' : (s.pass ? '通过 ' + s.pass + ' 题' : '还没刷');
    host.innerHTML =
      '<button class="acc' + (w.guest ? ' is-guest' : '') + '" type="button" aria-haspopup="true" aria-expanded="false">' +
        '<span class="seal">' + esc(w.guest ? '?' : w.name.trim().charAt(0)) + '</span>' +
        '<span class="txt"><b>' + esc(head) + '</b><i>' + esc(sub) + '</i></span>' +
        '<span class="cv">▾</span>' +
      '</button>' +
      '<div class="acc-panel">' + (w.guest ? panelGuest() : panelUser(w)) + '</div>';
    bindAcc(host);
  }

  function refreshAcc() {
    var w = whoNow();
    drawAcc(w);
    return w;
  }

  function bindAcc(host) {
    var btn = host.querySelector('.acc');
    var panel = host.querySelector('.acc-panel');

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var open = host.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var inp = host.querySelector('.p-form input');
        if (inp) setTimeout(function () { inp.focus(); }, 30);
      }
    });

    host.addEventListener('click', function (e) { e.stopPropagation(); });

    var quit = host.querySelector('.p-quit');
    if (quit) quit.addEventListener('click', function (e) {
      e.stopPropagation();
      killUser();
      dropName();
      host.classList.remove('open');
      refreshAcc();
    });

    var form = host.querySelector('.p-form');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var inp = form.querySelector('input');
        var v = (inp.value || '').trim();
        if (!v) { inp.focus(); return; }
        saveUser(v, 'student');
        pushName(v);
        host.classList.remove('open');
        refreshAcc();
      });
    }

    if (panel) panel.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  if (box) {
    box.innerHTML =
      '<a class="nav-logo" href="首页.html' + suffix() + '"><i>J</i>俊杰侃信奥</a>' +
      ITEMS.map(function (it) {
        return '<a class="nav-item' + (it.k === page.page ? ' on' : '') + '" href="' + it.h + suffix() + '">' +
          icon(it.k) + '<span>' + it.t + '</span></a>';
      }).join('') +
      '<span class="nav-sp"></span>' +
      '<a class="nav-coin" href="index.html' + suffix() + '" title="洛克贝：游戏里探索、战斗、做委托挣的"><i></i><span class="num">' + fmt(window.lkCoin.coin()) + '</span></a>' +
      '<div class="nav-acc"></div>';

    refreshAcc();

    /* 存档一变，数字和名字当场跟着变，不用刷新 */
    window.lkCoin.on(function (r) {
      var num = box.querySelector('.nav-coin .num');
      if (num) num.textContent = fmt(r.coin);
      var host = box.querySelector('.nav-acc');
      /* 面板开着时不重建，免得把正在输入的名字冲掉 */
      if (host && !host.classList.contains('open') && !lkUser() && !state.qname) refreshAcc();
    });
  }

  document.addEventListener('click', function () {
    var host = document.querySelector('.nav-acc');
    if (host) {
      host.classList.remove('open');
      var btn = host.querySelector('.acc');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var host = document.querySelector('.nav-acc');
    if (host) host.classList.remove('open');
  });

  /* 游戏页若也挂了本导航，游戏内加/花洛克贝后通知一次 */
  window.addEventListener('pagehide', function () { try { window.lkCoin.notify(); } catch (e) {} });
})();
