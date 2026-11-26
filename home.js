/* 首页逻辑：轮播 / 欢迎 / 跳转 / 幸运签 / 比赛 / 题库 / 曲线 / 公告 / 信箱 */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var C = window.CATALOG || { chapters: [] };
  var CFG = window.SITE_CONFIG || {};
  var FT = window.FORTUNE || [];
  var GROUPS = C.chapters || [];
  var ALL = [];
  GROUPS.forEach(function (g) {
    (g.lessons || []).forEach(function (l) {
      (l.problems || []).forEach(function (p) { p._g = g; p._l = l; ALL.push(p); });
    });
  });

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  function ls(k, dft) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dft; } catch (e) { return dft; } }
  function lset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function doneSet() { return new Set(ls('studypage.done', [])); }
  function who() {
    var q = new URLSearchParams(location.search).get('name');
    if (q) return q;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/carlosia_phase1_save_v1/.test(k)) continue;
        var v = JSON.parse(localStorage.getItem(k) || '{}');
        if (v && v.profile && v.profile.name) return v.profile.name;
      }
    } catch (e) {}
    return '同学';
  }
  var NAME = who();
  var WORK = location.protocol === 'file:' ? '预览_DevC布局.html' : '预览_DevC布局.html';
  var NAMEQ = new URLSearchParams(location.search).get('name');

  function go(page, extra) {
    var q = [];
    if (NAMEQ) q.push('name=' + encodeURIComponent(NAMEQ));
    if (extra) q.push(extra);
    location.href = page + (q.length ? '?' + q.join('&') : '');
  }
  function goWork(pid) { location.href = WORK + '?pid=' + pid; }

  /* ---------------- B. Hero 轮播 ---------------- */
  (function hero() {
    var box = $('#hero'); if (!box) return;
    var slides = box.querySelectorAll('.slide');
    var dots = box.querySelectorAll('.dots i');
    var i = 0, timer = null;
    function show(n) {
      i = (n + slides.length) % slides.length;
      slides.forEach(function (s, k) { s.classList.toggle('on', k === i); });
      dots.forEach(function (d, k) { d.classList.toggle('on', k === i); });
    }
    function play() { stop(); timer = setInterval(function () { show(i + 1); }, 5000); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    dots.forEach(function (d, k) { d.addEventListener('click', function () { show(k); play(); }); });
    box.addEventListener('mouseenter', stop);
    box.addEventListener('mouseleave', play);
    show(0); play();

    var doneArr = Array.from(doneSet()).filter(function (k) { return ALL.some(function (p) { return 'ybt' + p.pid === k; }); });
    var lesN = GROUPS.reduce(function (a, g) { return a + (g.lessons || []).filter(function (l) { return (l.problems || []).length; }).length; }, 0);
    var s1 = $('#heroSub'), s3 = $('#heroCats'), s3b = $('#heroLes'), s3c = $('#heroPro'), s3d = $('#heroDone');
    if (s1) s1.textContent = ALL.length + ' 道 C++ 题按章节排好，从输出格式一直练到动态规划。';
    if (s3) s3.textContent = GROUPS.length + ' 大类，' + lesN + ' 章，' + ALL.length + ' 题';
    if (s3b) s3b.textContent = lesN;
    if (s3c) s3c.textContent = ALL.length;
    if (s3d) s3d.textContent = doneArr.length;
  })();

  /* ---------------- C. 欢迎卡 ---------------- */
  (function wel() {
    var box = $('#wel'); if (!box) return;
    var d = new Date();
    var mons = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
    var wks = ['星期天', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    var bigMonth = [1, 3, 5, 7, 8, 10, 12].indexOf(d.getMonth() + 1) >= 0 ? '大' : '小';
    $('#welName').textContent = NAME;
    $('#welMon').textContent = mons[d.getMonth()];
    $('#welSize').textContent = bigMonth;
    $('#welDay').textContent = d.getDate();
    $('#welWeek').textContent = wks[d.getDay()];

    var cd = $('#welCd');
    if (cd && CFG.exam) {
      cd.innerHTML = CFG.exam.map(function (e) {
        var n = daysBetween(today(), e.date);
        var txt = n >= 0 ? '还有 <b>' + n + '</b> 天' : '已过 <b>' + Math.abs(n) + '</b> 天';
        return '距 ' + e.name + ' ' + txt;
      }).join('<br>');
    }

    var btn = $('#btnCheck'), sub = $('#welSub');
    var st = ls('studypage.checkin', { last: '', streak: 0, total: 0 });
    function paint() {
      var isToday = st.last === today();
      btn.classList.toggle('done', isToday);
      btn.textContent = isToday ? '今天已打卡，连续 ' + st.streak + ' 天' : '今日打卡';
      if (sub) sub.textContent = st.total ? '累计打卡 ' + st.total + ' 天' : '每天来一次，攒个连续';
    }
    btn.addEventListener('click', function () {
      if (st.last === today()) return;
      var y = new Date(); y.setDate(y.getDate() - 1);
      st.streak = st.last === ymd(y) ? (st.streak || 0) + 1 : 1;
      st.total = (st.total || 0) + 1;
      st.last = today();
      lset('studypage.checkin', st);
      paint();
    });
    paint();
  })();

  /* ---------------- D. 问题跳转 ---------------- */
  (function jump() {
    var box = $('#jump'); if (!box) return;
    var inp = $('#jumpPid'), tip = $('#jumpTip');
    var done = doneSet();
    if (tip) tip.textContent = '题库共 ' + ALL.length + ' 题，已通过 ' + ALL.filter(function (p) { return done.has('ybt' + p.pid); }).length + ' 题';
    function go2() {
      var v = (inp.value || '').trim();
      if (!/^\d{3,4}$/.test(v)) { inp.focus(); inp.style.borderColor = '#e0a1a1'; setTimeout(function () { inp.style.borderColor = ''; }, 1200); return; }
      goWork(v);
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go2(); });
    inp.addEventListener('input', function () { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); });
    $('#btnJump').addEventListener('click', go2);
    $('#btnRand').addEventListener('click', function () {
      var last = ls('studypage.random.last', '');
      var pool = ALL.filter(function (p) { return !done.has('ybt' + p.pid) && String(p.pid) !== String(last); });
      if (!pool.length) pool = ALL.filter(function (p) { return String(p.pid) !== String(last); });
      if (!pool.length) return;
      var p = pool[Math.floor(Math.random() * pool.length)];
      lset('studypage.random.last', p.pid);
      goWork(p.pid);
    });
  })();

  /* ---------------- J. 今日幸运签 ---------------- */
  (function luck() {
    var box = $('#luckBox'), dotsBox = $('#luckDots');
    if (!box) return;

    function rec() { return ls('studypage.fortune', {}); }
    function last7() {
      var r = rec(), out = [];
      for (var i = 6; i >= 0; i--) {
        var d = new Date(); d.setDate(d.getDate() - i);
        out.push({ date: ymd(d), has: r[ymd(d)] !== undefined });
      }
      return out;
    }
    function streak() {
      var r = rec(), n = 0;
      var d = new Date();
      if (r[ymd(d)] === undefined) d.setDate(d.getDate() - 1);
      while (r[ymd(d)] !== undefined) { n++; d.setDate(d.getDate() - 1); }
      return n;
    }
    function paintDots() {
      if (!dotsBox) return;
      dotsBox.innerHTML = last7().map(function (x) { return '<i class="' + (x.has ? 'on' : '') + '"></i>'; }).join('');
    }

    function tube(scale) {
      if (scale === 's') {
        return '<div class="tube-s"><div class="lip"></div><div class="body"><em>签</em></div></div>';
      }
      return '<div class="tube" id="tube">' +
        '<div class="stick a"></div><div class="stick b"></div><div class="stick c"></div><div class="stick d"></div>' +
        '<div class="lip"></div><div class="body"><em>签</em></div></div>';
    }

    function idle() {
      box.innerHTML = '<div class="luck-body">' + tube() +
        '<div class="luck-txt"><p>摇一支，今天先做哪一章</p><small>一天一次，摇完记住就行</small>' +
        '<button class="btn-shake" id="btnShake">摇一摇</button></div></div>';
      $('#btnShake').addEventListener('click', shake);
      paintDots();
    }

    function shake() {
      var btn = $('#btnShake'), t = $('#tube');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '摇签中…';
      document.querySelector('.luck-txt p').textContent = '签筒晃起来…';
      t.classList.add('shake');
      setTimeout(function () {
        var r = rec();
        var idx = r[today()];
        if (idx === undefined) {
          idx = Math.floor(Math.random() * FT.length);
          while (FT.length > 1 && r[today()] === idx) idx = Math.floor(Math.random() * FT.length);
          r[today()] = idx;
          lset('studypage.fortune', r);
        }
        result(FT[idx], idx);
      }, 900);
    }

    function result(f, idx) {
      if (!f) return idle();
      var lvName = f.lv === 3 ? '上上签' : f.lv === 2 ? '上签' : '中签';
      var lvCls = f.lv === 3 ? '' : f.lv === 2 ? ' lv2' : ' lv1';
      var stk = streak();
      box.innerHTML = '<div class="luck-res">' +
        '<div class="slip">' +
          '<div class="s-top"><span class="stamp' + lvCls + '">' + lvName + '</span>' +
            '<span class="s-ch">' + (f.ch || '') + '</span></div>' +
          '<div class="txt">' + f.text + '</div>' +
          '<div class="s-bot"><span>宜 <b class="g">' + f.good + '</b></span>' +
            '<span>忌 <b class="b">' + f.bad + '</b></span></div>' +
        '</div>' +
        '<div class="luck-op">' +
          '<div class="meta">今天摇过了，明天再来<br>连续开签 ' + stk + ' 天</div>' +
          '<button class="btn-go" id="btnGo" type="button">去这一章</button>' +
        '</div></div>';
      $('#btnGo').addEventListener('click', function () {
        var q = ['g=' + f.g, 'l=' + f.l];
        if (NAMEQ) q.push('name=' + encodeURIComponent(NAMEQ));
        location.href = '学习台.html?' + q.join('&');
      });
      paintDots();
    }

    var r = rec();
    if (r[today()] !== undefined) result(FT[r[today()]], r[today()]); else idle();
  })();

  /* ---------------- E. 近期比赛 ---------------- */
  (function matches() {
    var box = $('#matches'); if (!box) return;
    var list = (CFG.matches || []);
    if (!list.length) { box.innerHTML = '<div class="empty" style="padding:24px 0">暂无比赛</div>'; return; }
    box.innerHTML = list.map(function (m) {
      var cls = m.state === 'run' ? 'run' : m.state === 'end' ? 'end' : 'todo';
      var tag = m.state === 'run' ? '进行中' : m.state === 'end' ? '已结束' : '未开始';
      return '<a class="mt ' + cls + '" href="俊杰月赛.html">' +
        '<div class="t"><b>' + m.title + '</b><i>' + tag + '</i></div>' +
        '<div class="m"><span class="ty">' + (m.type || '站内赛') + '</span>' +
        '<span class="st">' + (m.tip || '') + '</span>' +
        '<span class="tm">' + (m.start || '—') + (m.end ? '<br>' + m.end : '') + '</span></div></a>';
    }).join('');
  })();

  /* ---------------- F. 题库总览（目录式） ---------------- */
  (function cats() {
    var box = $('#cats'); if (!box) return;
    var done = doneSet();
    box.innerHTML = GROUPS.map(function (g, k) {
      var n = (g.lessons || []).reduce(function (a, l) { return a + (l.problems || []).length; }, 0);
      var ok = (g.lessons || []).reduce(function (a, l) { return a + (l.problems || []).filter(function (p) { return done.has('ybt' + p.pid); }).length; }, 0);
      var p = n ? Math.round(ok / n * 100) : 0;
      var len = (g.lessons || []).length;
      return '<a class="cat" href="练习题库.html">' +
        '<span class="no">' + (k + 1 < 10 ? '0' : '') + (k + 1) + '</span>' +
        '<span class="mid"><b>' + g.name + '</b><span>' + len + ' 节</span></span>' +
        '<span class="right">' + n + ' 题<em>' + (ok ? '通过 ' + ok + '，' + p + '%' : '未开始') + '</em></span></a>';
    }).join('');
  })();

  /* ---------------- G. 做题曲线 ---------------- */
  (function chart() {
    var box = $('#chartBox'); if (!box) return;
    var daily = ls('studypage.daily', {}), base = ls('studypage.doneBase', null);
    var done = new Set(Array.from(doneSet()).filter(function (k) {
      return ALL.some(function (p) { return 'ybt' + p.pid === k; });
    }));
    if (base === null) { lset('studypage.doneBase', Array.from(done)); }
    else {
      var bs = new Set(base);
      var add = Array.from(done).filter(function (x) { return !bs.has(x); }).length;
      if (add > 0) { var t = today(); daily[t] = (daily[t] || 0) + add; lset('studypage.daily', daily); lset('studypage.doneBase', Array.from(done)); }
    }
    var days = [], vals = [];
    for (var i = 13; i >= 0; i--) {
      var d = new Date(); d.setDate(d.getDate() - i);
      days.push(ymd(d)); vals.push(daily[ymd(d)] || 0);
    }
    if (!vals.some(function (v) { return v > 0; })) {
      box.innerHTML = '<div class="empty">还没有记录。做一道题，回来点「通过」，这里就长出第一根柱子。</div>';
      return;
    }
    var W = 780, H = 190, padB = 26, padT = 16;
    var maxV = Math.max(3, Math.max.apply(null, vals));
    var bw = 12, gap = 11, baseY = H - padB;
    function y(v) { return baseY - Math.round(v / maxV * (baseY - padT)); }
    var barX = 16, bars = '', labels = '';
    vals.forEach(function (v, k) {
      var x = barX + k * (bw + gap), yy = y(v);
      bars += '<rect x="' + x + '" y="' + yy + '" width="' + bw + '" height="' + (baseY - yy) + '" fill="rgba(23,38,90,.26)"/>';
    });
    var grid = '';
    [0, .5, 1].forEach(function (p) {
      var gy = baseY - Math.round(p * (baseY - padT));
      grid += '<line x1="0" y1="' + gy + '" x2="' + W + '" y2="' + gy + '" stroke="#E5E7E1"/>' +
        '<text x="2" y="' + (gy - 3) + '" font-size="10" fill="#8D939E">' + Math.round(maxV * p) + '</text>';
    });
    var acc = 0, pts = [], cum = vals.map(function (v, k) { acc += v; return acc; });
    var maxC = Math.max(1, acc);
    var chartL = 380;
    var lineW = W - chartL - 44;
    cum.forEach(function (c, k) {
      var x = chartL + Math.round(k * (lineW / Math.max(1, cum.length - 1)));
      var yy = baseY - Math.round(c / maxC * (baseY - padT));
      pts.push(x + ',' + yy);
    });
    var line = '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#17265A" stroke-width="1.5"/>';
    labels = '<text x="16" y="' + (H - 6) + '" font-size="10" fill="#8D939E">14 天前</text>' +
      '<text x="' + (chartL - 56) + '" y="' + (H - 6) + '" font-size="10" fill="#8D939E">今天</text>' +
      '<text x="' + (chartL + 4) + '" y="12" font-size="10" fill="#575D69">累计 ' + acc + ' 题</text>';
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
      grid + bars + line + labels + '</svg>';
  })();

  /* ---------------- H. 公告 ---------------- */
  (function notice() {
    var box = $('#notice'); if (!box) return;
    box.innerHTML = (CFG.notices || []).map(function (n) {
      return '<a class="nt" href="' + (n.href || '#') + '"><div class="d">' + n.date + '　' + n.year + '</div>' +
        '<div class="tt">' + n.title + '</div></a>';
    }).join('');
  })();

  /* ---------------- K. 网站信箱 ---------------- */
  (function mail() {
    var bar = $('#mailbar'); if (!bar) return;
    var btnW = $('#btnWrite'), form = $('#mform'), cnt = $('#mCnt'), ta = $('#mBody'), nick = $('#mNick'), btnS = $('#btnSend');
    var M = CFG.mail || {};
    var COOL = 60 * 1000;

    btnW.addEventListener('click', function () {
      if (bar.classList.contains('open')) {
        bar.classList.remove('open');
        btnW.classList.add('ghost'); btnW.textContent = '✎ 写一封';
        return;
      }
      bar.classList.add('open');
      form.style.display = '';
      btnW.classList.remove('ghost'); btnW.textContent = '收起';
      setTimeout(function () {
        var y = bar.getBoundingClientRect().top + window.pageYOffset - 64;
        window.scrollTo({ top: y < 0 ? 0 : y, behavior: 'smooth' });
      }, 420);
      ta.focus();
    });

    function coolLeft() {
      var last = ls('studypage.mail.last', 0);
      return Math.max(0, COOL - (Date.now() - last));
    }
    function tick() {
      var left = coolLeft();
      if (left > 0) {
        btnS.disabled = true;
        btnS.textContent = '稍等 ' + Math.ceil(left / 1000) + ' 秒';
        setTimeout(tick, 500);
      } else {
        btnS.disabled = ta.value.trim().length === 0 || ta.value.length > 200;
        btnS.textContent = '寄出';
      }
    }
    function updCnt() {
      var n = ta.value.length;
      cnt.textContent = n + '/200 字，只有站长能看到';
      cnt.classList.toggle('over', n > 200);
      if (coolLeft() <= 0) btnS.disabled = n === 0 || n > 200;
    }
    ta.addEventListener('input', updCnt);

    function copyText(txt) {
      try {
        navigator.clipboard.writeText(txt);
        return true;
      } catch (e) {
        try {
          ta.select(); document.execCommand('copy'); return true;
        } catch (e2) { return false; }
      }
    }

    function reset() {
      bar.classList.remove('open');
      form.style.display = 'none';
      btnW.style.display = '';
      btnW.classList.add('ghost');
      btnW.textContent = '✎ 写一封';
    }

    function success() {
      reset();
      var note = document.createElement('div');
      note.className = 'ok';
      note.innerHTML = '<span>✓</span><div>已收到，谢谢！站长会尽快看看<br><span style="color:#9aa3b2;font-size:11.5px">想补充的话，明天再来写</span></div>';
      bar.appendChild(note);
    }

    function fallback(body, nickVal) {
      var txt = '【网站信箱】\n昵称：' + (nickVal || '匿名') + '\n内容：' + body + '\n时间：' + today();
      if (M.email) {
        location.href = 'mailto:' + M.email + '?subject=' + encodeURIComponent('网站信箱留言') + '&body=' + encodeURIComponent(txt);
        showErr('已打开邮件客户端。如果没反应，点这里复制内容：', txt);
      } else {
        copyText(txt);
        showErr('还没接上收信通道，内容已复制，发给站长就行：', txt);
      }
      reset();
    }
    function showErr(msg, txt) {
      var e = bar.querySelector('.err');
      if (!e) { e = document.createElement('div'); e.className = 'err'; bar.appendChild(e); }
      e.innerHTML = msg + ' <button type="button" class="btn-s" style="width:auto;padding:0 10px;height:30px;margin-left:6px">复制内容</button>';
      e.querySelector('button').addEventListener('click', function () { copyText(txt); e.querySelector('button').textContent = '已复制'; });
    }

    btnS.addEventListener('click', function () {
      var body = ta.value.trim();
      if (!body || body.length > 200 || coolLeft() > 0) return;
      btnS.disabled = true; btnS.textContent = '寄出中…';
      var nickVal = (nick.value || '').trim();
      lset('studypage.mail.last', Date.now());

      if (M.supabaseUrl && M.supabaseKey) {
        var url = M.supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + (M.table || 'site_messages');
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: M.supabaseKey, Authorization: 'Bearer ' + M.supabaseKey, Prefer: 'return=minimal' },
          body: JSON.stringify({ nickname: nickVal || '匿名', body: body })
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          success();
        }).catch(function () { fallback(body, nickVal); tick(); });
      } else {
        setTimeout(function () { fallback(body, nickVal); tick(); }, 150);
      }
    });
    tick();
  })();

  /* ---------------- L. 箱庭世界（洛克贝） ---------------- */
  (function game() {
    var n = $('#gCoin'), tip = $('#gameTip');
    if (!n) return;
    var c = typeof window.siteCoin === 'function' ? window.siteCoin() : 0;
    n.textContent = String(c).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (tip && c <= 0) {
      tip.textContent = '还没开始攒。进游戏建角色，做题就会掉洛克贝。';
      tip.classList.add('zero');
    }
  })();

  /* ---------------- I. 浮标 ---------------- */
  (function fab() {
    var b = $('#fab'), tip = $('#fabTip');
    if (!b) return;
    b.addEventListener('click', function () {
      if (tip.classList.contains('on')) { tip.classList.remove('on'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      else { tip.classList.add('on'); }
    });
    b.addEventListener('mouseenter', function () { tip.classList.add('on'); });
    tip.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
  })();
})();



