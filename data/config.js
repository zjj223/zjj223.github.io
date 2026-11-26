/* 首页配置：改这里，不用动 home.js
   信箱三档投递：
     1) 填 supabaseUrl + supabaseKey → 直接写进数据库（推荐）
     2) 只填 email → 打开邮件客户端，主题正文预填好
     3) 都不填 → 页面把内容复制出来，让学生自己发给你
*/
window.SITE_CONFIG = {
  brand: '俊杰侃信奥',

  /* 考试倒计时：改日期就行 */
  exam: [
    { name: 'CSP-J/S 2027 第一轮', date: '2027-09-19' },
    { name: 'NOIP 2026', date: '2026-11-27' }
  ],

  /* 近期比赛（空数组则显示"暂无"） */
  matches: [
    { title: '俊杰月赛 · 第 1 场', type: '站内赛', state: 'todo', tip: '未开放', start: '', end: '' }
  ],

  /* 网站信箱 */
  mail: {
    supabaseUrl: '',        // 例如 https://xxxx.supabase.co
    supabaseKey: '',        // anon public key
    table: 'site_messages',
    email: ''               // 收信邮箱，填了就能一键打开邮件
  },

  /* 首页公告（日期 + 标题 + 链接可空） */
  notices: [
    { date: '11 月 26 日', year: '2026 周四', title: '题库按 8 大类铺满，1367 道题可以直接做', href: '练习题库.html' },
    { date: '11 月 26 日', year: '2026 周四', title: '学习笔记支持按章节直达，点章名就进那一章', href: '学习台.html' },
    { date: '11 月 26 日', year: '2026 周四', title: '俊杰月赛筹备中，赛制已定，等赛题和评测', href: '俊杰月赛.html' },
    { date: '11 月 20 日', year: '2026 周五', title: '在线评测使用说明：写代码、提交、看结果', href: '预览_DevC布局.html' },
    { date: '11 月 20 日', year: '2026 周五', title: '有想法写进网站信箱，站长每天都会看', href: '#mailbar' }
  ]
};
