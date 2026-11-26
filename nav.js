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

  /* ---------------- 渲染 ---------------- */
  function icon(k) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5">' + SVG[k] + '</g></svg>';
  }

  var box = document.getElementById('navIn');
  var page = (document.querySelector('.nav') || {}).dataset || {};
  var qname = WANT || null;
  var who = qname || window.lkCoin.name();
  if (!who) who = '同学';
  var suffix = qname ? '?name=' + encodeURIComponent(qname) : '';
  var c = window.lkCoin.coin();

  if (box) {
    box.innerHTML =
      '<a class="nav-logo" href="首页.html' + suffix + '"><i>J</i>俊杰侃信奥</a>' +
      ITEMS.map(function (it) {
        return '<a class="nav-item' + (it.k === page.page ? ' on' : '') + '" href="' + it.h + suffix + '">' +
          icon(it.k) + '<span>' + it.t + '</span></a>';
      }).join('') +
      '<span class="nav-sp"></span>' +
      '<a class="nav-coin" href="index.html' + suffix + '" title="洛克贝：游戏里探索、战斗、做委托挣的"><i></i><span class="num">' + fmt(c) + '</span></a>' +
      '<a class="nav-user" href="index.html' + suffix + '"><span class="nm">' + who + '</span><span class="c">▾</span></a>';

    /* 存档一变，数字和名字当场跟着变，不用刷新 */
    window.lkCoin.on(function (r) {
      var num = box.querySelector('.nav-coin .num');
      if (num) num.textContent = fmt(r.coin);
      if (!qname) {
        var nm = box.querySelector('.nav-user .nm');
        if (nm && r.name) nm.textContent = r.name;
      }
    });
  }

  /* 游戏页若也挂了本导航，游戏内加/花洛克贝后通知一次 */
  window.addEventListener('pagehide', function () { try { window.lkCoin.notify(); } catch (e) {} });
})();

