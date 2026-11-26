/* 全站顶部导航渲染：页面里放 <div class="nav" data-page="home"><div class="nav-in" id="navIn"></div></div> */
(function () {
  var SVG = {
    home: '<path d="M10 3 3 9.5V17h5v-4h4v4h5V9.5z"/>',
    lib: '<rect x="3" y="3" width="6" height="6"/><rect x="11" y="3" width="6" height="6"/><rect x="3" y="11" width="6" height="6"/><rect x="11" y="11" width="6" height="6"/>',
    note: '<path d="M4 3h9a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2z"/><path d="M7 8h5M7 12h5"/>',
    month: '<path d="M5 3v14"/><path d="M5 4h9l-2.5 3 2.5 3H5"/>',
    contest: '<path d="M6 4h8v4a4 4 0 0 1-8 0z"/><path d="M6 5H4v2a2 2 0 0 0 2 2"/><path d="M14 5h2v2a2 2 0 0 1-2 2"/><path d="M10 12v3M7 17h6"/>',
    rank: '<path d="M4 17V10M10 17V5M16 17V8"/>'
  };
  var ITEMS = [
    { k: 'home', t: '首页', h: '首页.html' },
    { k: 'lib', t: '练习题库', h: '练习题库.html' },
    { k: 'note', t: '学习笔记', h: '学习台.html' },
    { k: 'month', t: '俊杰月赛', h: '俊杰月赛.html' },
    { k: 'contest', t: '比赛', h: '比赛.html' },
    { k: 'rank', t: '排行榜', h: '排行榜.html' }
  ];

  function icon(k) {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5">' + SVG[k] + '</g></svg>';
  }
  function name() {
    var q = new URLSearchParams(location.search).get('name');
    if (q) return q;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!/carlosia_phase1_save_v1/.test(key)) continue;
        var v = JSON.parse(localStorage.getItem(key) || '{}');
        if (v && v.profile && v.profile.name) return v.profile.name;
      }
    } catch (e) {}
    return '同学';
  }

  var box = document.getElementById('navIn');
  var page = (document.querySelector('.nav') || {}).dataset || {};
  var who = name();
  var suffix = who && who !== '同学' ? '?name=' + encodeURIComponent(who) : '';

  if (box) {
    box.innerHTML =
      '<a class="nav-logo" href="首页.html' + suffix + '"><i>J</i>俊杰侃信奥</a>' +
      ITEMS.map(function (it) {
        return '<a class="nav-item' + (it.k === page.page ? ' on' : '') + '" href="' + it.h + suffix + '">' +
          icon(it.k) + '<span>' + it.t + '</span></a>';
      }).join('') +
      '<span class="nav-sp"></span>' +
      '<a class="nav-user" href="index.html' + suffix + '">' + who + '<span class="c">▾</span></a>';
  }
})();
