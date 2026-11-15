(function () {
  "use strict";

  const STORAGE_KEY = "carlosia_phase1_save_v1";
  const TEACHER_KEY = "teacher2026";
  const ACTION_COST = 1;
  const HATCH_EXP_REQUIREMENT = 120;
  const PET_BASE_HP_MAX = 80;
  const PET_BASE_MP_MAX = 80; // 废弃：保留兼容旧存档，不再显示和使用
  const PET_UPGRADE_COST_BASE = 100;
  const PET_UPGRADE_COST_STEP = 50;
  const PET_UPGRADE_HP_GAIN = 10;
  const COMPENSATION_ACTION_POINTS = 2;

  // ===== 云端存档（Supabase）=====
  // 部署到公网后，学生各自在自己电脑登录；两项留空则退回纯本地存档模式
  const CLOUD_CONFIG = {
    url: "https://rhfhtgjpnzasrlkcfdim.supabase.co",
    key: "sb_publishable__dL04pGC3ZNvK8tsIfixvQ_l6p5FOMC",
  };
  const CLOUD_ENABLED = Boolean(CLOUD_CONFIG.url && CLOUD_CONFIG.key);
  const CLOUD_TABLE = "students";
  let cloudSyncTimer = null;
  let cloudSyncBusy = false;
  let cloudSyncQueued = null;
  // 只有学生登录、或线上老师登录时才把进度写回云端；本地离线模式不动云端
  let cloudSyncAllowed = false;

  function cloudHeaders(extra) {
    return Object.assign(
      {
        apikey: CLOUD_CONFIG.key,
        Authorization: `Bearer ${CLOUD_CONFIG.key}`,
        "Content-Type": "application/json",
      },
      extra || {}
    );
  }

  async function cloudRequest(path, options) {
    const opts = options || {};
    const res = await fetch(`${CLOUD_CONFIG.url}/rest/v1/${path}`, {
      method: opts.method || "GET",
      headers: cloudHeaders(opts.headers),
      body: opts.body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `HTTP ${res.status}`);
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function cloudGetStudent(name) {
    const path = `${CLOUD_TABLE}?name=eq.${encodeURIComponent(
      name
    )}&select=name,pass,save,updated_at`;
    return cloudRequest(path).then((rows) => (rows && rows.length ? rows[0] : null));
  }

  function cloudGetAllStudents() {
    return cloudRequest(`${CLOUD_TABLE}?select=name,pass,save,updated_at&order=updated_at.desc`);
  }

  function cloudUpsertStudent(name, pass, save) {
    return cloudRequest(`${CLOUD_TABLE}?on_conflict=name`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        name,
        pass,
        save,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  // 把云端返回的一行还原成角色对象
  function profileFromCloud(row) {
    const raw = row && row.save && typeof row.save === "object" ? row.save : {};
    const profile = Object.assign({}, raw);
    profile.id =
      profile.id || `role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    profile.name = profile.name || (row && row.name) || "无名训练家";
    profile.pass = (row && row.pass) || profile.pass || "";
    return profile;
  }

  // 只同步"当前选中的这个角色"，合并写请求，避免连点探索时刷爆接口
  function scheduleCloudSync(profile) {
    if (!CLOUD_ENABLED || !cloudSyncAllowed || !profile || !profile.name) {
      return;
    }
    const payload = {
      name: profile.name,
      pass: String(profile.pass || "").slice(0, 12),
      save: profile,
    };
    cloudSyncQueued = payload;
    if (cloudSyncTimer) {
      clearTimeout(cloudSyncTimer);
    }
    cloudSyncTimer = setTimeout(() => {
      flushCloudSync();
    }, 2000);
  }

  async function flushCloudSync() {
    if (!cloudSyncQueued || cloudSyncBusy) {
      return;
    }
    const payload = cloudSyncQueued;
    cloudSyncQueued = null;
    cloudSyncBusy = true;
    try {
      await cloudUpsertStudent(payload.name, payload.pass, payload.save);
      setSaveStatus("已同步云端");
    } catch (err) {
      console.warn("云端同步失败", err);
      setSaveStatus("云端同步失败（已存本地）");
      // 留一次重试机会：把这条重新排队
      if (!cloudSyncQueued) {
        cloudSyncQueued = payload;
        cloudSyncTimer = setTimeout(flushCloudSync, 6000);
      }
    } finally {
      cloudSyncBusy = false;
    }
  }


  // 宠物战斗属性基础值
  const PET_BASE_ATTACK = 10;
  const PET_BASE_DEFENSE = 8;
  const PET_BASE_SPEED = 8;
  const PET_ATTACK_PER_LEVEL = 2;
  const PET_DEFENSE_PER_LEVEL = 1.5;
  const PET_SPEED_PER_LEVEL = 1;

  // 系别克制关系（仅展示，实际战斗暂不生效）
  const TYPE_CHART = Object.freeze({
    "火系": { strong: ["草系", "冰系", "机械系"], weak: ["水系", "地系"] },
    "水系": { strong: ["火系", "地系"], weak: ["草系", "电系"] },
    "草系": { strong: ["水系", "地系"], weak: ["火系", "冰系", "翼系"] },
    "电系": { strong: ["水系", "翼系"], weak: ["地系"] },
    "冰系": { strong: ["草系", "翼系", "龙系"], weak: ["火系", "机械系"] },
    "地系": { strong: ["火系", "电系", "机械系"], weak: ["水系", "草系"] },
    "翼系": { strong: ["草系", "普通系"], weak: ["电系", "冰系"] },
    "龙系": { strong: ["龙系"], weak: ["冰系"] },
    "恶系": { strong: ["光系", "幽系"], weak: ["光系", "幻系"] },
    "光系": { strong: ["恶系", "幽系"], weak: ["恶系"] },
    "幽系": { strong: ["普通系", "恶系"], weak: ["光系", "恶系", "幻系"] },
    "机械系": { strong: ["冰系"], weak: ["火系", "地系"] },
    "普通系": { strong: [], weak: ["翼系", "幽系"] },
    "幻系": { strong: ["幽系", "恶系"], weak: [] },
  });
  const PET_EVOLUTION_LEVELS = Object.freeze({
    2: 36,
    3: 54,
  });

  // 咕噜球配置
  const BALL_TYPES = Object.freeze([
    { id: "ball1", name: "普通咕噜球", price: 1, catchRate: 0.05, color: "#9e9e9e", desc: "基础捕捉率5%" },
    { id: "ball2", name: "中级咕噜球", price: 5, catchRate: 0.10, color: "#42a5f5", desc: "捕捉率10%" },
    { id: "ball3", name: "高级咕噜球", price: 10, catchRate: 0.15, color: "#66bb6a", desc: "捕捉率15%" },
    { id: "ball4", name: "超级咕噜球", price: 15, catchRate: 0.20, color: "#ffa726", desc: "捕捉率20%" },
    { id: "ball5", name: "至尊咕噜球", price: 25, catchRate: 0.30, color: "#ab47bc", desc: "捕捉率30%" },
    { id: "ball6", name: "国王咕噜球", price: 35, catchRate: 0.50, color: "#ef5350", desc: "捕捉率50%" },
  ]);

  // 计时器配置（2分钟）
  const TIMER_DURATION = 60; // 默认1分钟

  // 新手引导步骤
  const GUIDE_STEPS = Object.freeze([
    {
      title: "欢迎来到卡罗西亚大陆！",
      desc: "这是一个课堂养成游戏。你可以通过上课认真做题获得行动点，然后用行动点探索世界、培养宠物、和同学比拼战力！",
      highlight: "先创建或选择一个角色开始游戏吧！"
    },
    {
      title: "宠物系统",
      desc: "每个玩家最多可以拥有3只宠物。第一只宠物可以用1行动点刷新，其他宠物需要在大世界探索中捕捉获得。每只宠物都有独立的等级、经验和亲密度。",
      highlight: "宠物栏在左侧，可以切换出战宠物"
    },
    {
      title: "大世界探索",
      desc: "点击场景进入探索，每次探索消耗1行动点。探索可以获得经验值和场景专属道具，还有可能遇到野生宠物进行战斗。集齐一个场景的4个道具可以提升1级亲密度。",
      highlight: "亲密度越高，解锁的场景越多"
    },
    {
      title: "捕捉宠物",
      desc: "战斗胜利后有15%概率出现捕捉窗口。使用咕噜球可以捕捉野生宠物，咕噜球越好捕捉率越高。捕捉到的宠物会加入你的宠物栏。",
      highlight: "记得先去商店购买咕噜球"
    },
    {
      title: "商店系统",
      desc: "在商店可以用经验值购买场景道具，也可以上架自己的道具卖给其他同学。还有专门的咕噜球商店，用行动点购买各种咕噜球。",
      highlight: "经验当钱花，统一定价"
    },
    {
      title: "战力排行榜",
      desc: "排行榜按三只宠物的战斗力总和排名。每周老师会发布排行榜奖励，排名越靠前奖励的行动点越多。",
      highlight: "努力培养宠物，争夺榜首！"
    },
    {
      title: "课间计时器",
      desc: "游戏界面上方有一个2分钟计时器，老师可以用它来控制课间游戏时间。时间到了会有声音提示。",
      highlight: "准备好了吗？开始你的冒险吧！"
    }
  ]);

  // 场景宠物数量限制
  const SCENE_PET_REQUIREMENT = Object.freeze({
    "grassland": 1, "volcano": 1, "mermaid-bay": 1, "academy": 1, "snow-valley": 1,
    "thunder-valley": 2, "shadow-forest": 2, "dark-swamp": 2,
    "dragon-realm": 3, "sky-city": 3
  });

  const PET_DATA = window.CARLOSIA_PET_DATA || {};
  const FALLBACK_PET_POOL = [
    { name: "初始宠物", style: "普通系", mark: "初", image: null, desc: "", type: "未标注" },
  ];

  const SCENES = Object.freeze([
    {
      id: "grassland",
      name: "轻风草原",
      element: "草系",
      tag: "新手村",
      bondRequired: 0,
      drops: { exp: [7, 112] },
      feature: "适合新手的温和草原，经验 7-112。",
      artClass: "scene-grass",
    },
    {
      id: "volcano",
      name: "维苏威火山",
      element: "火系",
      tag: "进阶",
      bondRequired: 1,
      drops: { exp: [75, 187] },
      feature: "炽热的火山地带，经验 75-187。",
      artClass: "scene-fire",
    },
    {
      id: "mermaid-bay",
      name: "人鱼湾",
      element: "水系",
      tag: "中级",
      bondRequired: 2,
      drops: { exp: [150, 262] },
      feature: "神秘的海底世界，经验 150-262。",
      artClass: "scene-water",
    },
    {
      id: "academy",
      name: "皇家研究院",
      element: "光系",
      tag: "高级",
      bondRequired: 3,
      drops: { exp: [225, 337] },
      feature: "知识与魔法的殿堂，经验 225-337。",
      artClass: "scene-lab",
    },
    {
      id: "snow-valley",
      name: "雪人谷",
      element: "冰系",
      tag: "专家",
      bondRequired: 4,
      drops: { exp: [300, 412] },
      feature: "极寒的冰雪之地，经验 300-412。",
      artClass: "scene-ice",
    },
    {
      id: "thunder-valley",
      name: "雷鸣峡谷",
      element: "电系",
      tag: "大师",
      bondRequired: 5,
      drops: { exp: [375, 525] },
      feature: "雷电交加的神秘峡谷，经验 375-525。",
      artClass: "scene-thunder",
    },
    {
      id: "shadow-forest",
      name: "幽暗森林",
      element: "幽系",
      tag: "宗师",
      bondRequired: 6,
      drops: { exp: [450, 637] },
      feature: "终年不见阳光的神秘森林，经验 450-637。",
      artClass: "scene-shadow",
    },
    {
      id: "dark-swamp",
      name: "暗影沼泽",
      element: "恶系",
      tag: "噩梦",
      bondRequired: 7,
      drops: { exp: [525, 750] },
      feature: "危机四伏的黑暗沼泽，经验 525-750。",
      artClass: "scene-swamp",
    },
    {
      id: "dragon-realm",
      name: "龙之秘境",
      element: "龙系",
      tag: "传说",
      bondRequired: 8,
      drops: { exp: [600, 862] },
      feature: "龙族栖息的神秘领域，经验 600-862。",
      artClass: "scene-dragon",
    },
    {
      id: "sky-city",
      name: "天空之城",
      element: "翼系",
      tag: "神话",
      bondRequired: 9,
      drops: { exp: [675, 975] },
      feature: "漂浮在云端的失落之城，经验 675-975。",
      artClass: "scene-sky",
    },
  ]);

  // 场景专属道具：5 场景 × 4 道具 = 20 个
  // 探索时 18% 概率掉落，掉落时主打道具50%概率，其他三种平分50%
  const ITEM_DROP_CHANCE = 0.18;
  const BOND_NAME_UNLOCK_LEVEL = 3;

  const SCENE_ITEMS = Object.freeze({
    grassland: [
      {
        id: "grass-clover",
        name: "幸运四叶草",
        desc: "轻风草原深处罕见的四叶幸运草，传说能带来好运。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e8f5e9"/><path d="M32 38 C28 34 24 34 24 30 C24 26 28 24 32 28 C36 24 40 26 40 30 C40 34 36 34 32 38Z" fill="#66bb6a"/><path d="M26 34 C22 32 20 30 21 27 C22 24 26 24 28 27 C30 24 34 24 35 27 C36 30 34 32 30 34" fill="#81c784" opacity="0.7"/><line x1="32" y1="38" x2="32" y2="52" stroke="#4caf50" stroke-width="2.5" stroke-linecap="round"/><path d="M32 46 Q28 44 26 46" stroke="#4caf50" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
      },
      {
        id: "grass-feather",
        name: "风之羽毛",
        desc: "随风飘落到草原的轻盈羽毛，触感微凉。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e8f5e9"/><path d="M40 12 C28 16 20 28 20 40 L20 52" stroke="#a5d6a7" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M40 12 C34 14 28 20 26 28 C34 26 40 20 42 14 C42 13 41 12 40 12Z" fill="#81c784"/><path d="M38 18 C32 20 27 26 25 34 C32 32 38 26 40 20 C40 19 39 18 38 18Z" fill="#a5d6a7"/><path d="M35 26 C30 28 26 34 24 42 C30 40 35 34 37 28 C37 27 36 26 35 26Z" fill="#c8e6c9"/><line x1="20" y1="40" x2="16" y2="46" stroke="#66bb6a" stroke-width="2" stroke-linecap="round"/></svg>',
      },
      {
        id: "grass-dandelion",
        name: "蒲公英球",
        desc: "圆满的蒲公英绒球，轻轻一吹便会四散飞去。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e8f5e9"/><circle cx="32" cy="26" r="14" fill="none" stroke="#c8e6c9" stroke-width="1.5"/><g stroke="#a5d6a7" stroke-width="1.5" stroke-linecap="round"><line x1="32" y1="12" x2="32" y2="18"/><line x1="44" y1="18" x2="40" y2="22"/><line x1="46" y1="30" x2="40" y2="30"/><line x1="42" y1="40" x2="38" y2="36"/><line x1="32" y1="44" x2="32" y2="38"/><line x1="22" y1="40" x2="26" y2="36"/><line x1="18" y1="30" x2="24" y2="30"/><line x1="20" y1="18" x2="24" y2="22"/></g><circle cx="32" cy="26" r="5" fill="#81c784"/><line x1="32" y1="40" x2="32" y2="54" stroke="#66bb6a" stroke-width="2.5" stroke-linecap="round"/><path d="M32 48 Q28 46 26 48" stroke="#66bb6a" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
      },
      {
        id: "grass-dewdrop",
        name: "晨露水晶",
        desc: "草叶上凝结的晨露，在阳光下晶莹剔透。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e8f5e9"/><path d="M32 12 C24 24 20 32 20 40 C20 48 26 54 32 54 C38 54 44 48 44 40 C44 32 40 24 32 12Z" fill="#81d4fa"/><path d="M32 12 C26 22 24 30 24 38 C24 44 28 48 32 48 C30 42 28 36 30 28 C31 22 32 16 32 12Z" fill="#b3e5fc"/><ellipse cx="27" cy="34" rx="3" ry="5" fill="#e1f5fe" opacity="0.8"/></svg>',
      },
    ],
    volcano: [
      {
        id: "volcano-lava",
        name: "熔岩结晶",
        desc: "火山岩浆冷却后形成的结晶体，内部仍有余温。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><polygon points="32,10 46,24 42,46 22,46 18,24" fill="#ff7043"/><polygon points="32,10 40,22 32,30 24,22" fill="#ffab91"/><polygon points="24,22 32,30 28,46 20,38" fill="#e64a19" opacity="0.6"/><line x1="32" y1="30" x2="32" y2="46" stroke="#ffccbc" stroke-width="1.5"/><circle cx="30" cy="36" r="1.5" fill="#ffe0b2"/></svg>',
      },
      {
        id: "volcano-ember",
        name: "余烬火种",
        desc: "永不熄灭的微弱火种，是火山生命力的象征。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><path d="M32 10 C28 18 22 22 22 32 C22 40 26 46 32 46 C38 46 42 40 42 32 C42 26 38 22 36 18 C34 22 32 24 32 20 C32 16 32 12 32 10Z" fill="#ff5722"/><path d="M32 22 C29 26 27 30 27 34 C27 39 29 42 32 42 C35 42 37 39 37 34 C37 30 35 26 32 22Z" fill="#ffab40"/><ellipse cx="30" cy="34" rx="2.5" ry="4" fill="#ffe082" opacity="0.9"/></svg>',
      },
      {
        id: "volcano-charfruit",
        name: "炭烧果",
        desc: "被火山热气熏烤过的果实，外皮焦黑却香甜。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><circle cx="32" cy="36" r="18" fill="#5d4037"/><circle cx="32" cy="36" r="18" fill="url(#chargrad)"/><defs><radialGradient id="chargrad" cx="40%" cy="35%"><stop offset="0%" stop-color="#8d6e63"/><stop offset="100%" stop-color="#3e2723"/></radialGradient></defs><path d="M26 28 Q30 26 34 28" stroke="#ff7043" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.7"/><path d="M24 36 Q28 34 32 36" stroke="#ff7043" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.5"/><line x1="32" y1="18" x2="32" y2="12" stroke="#6d4c41" stroke-width="3" stroke-linecap="round"/><path d="M32 14 Q36 10 40 12" stroke="#558b2f" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>',
      },
      {
        id: "volcano-ash",
        name: "火山灰瓶",
        desc: "装着细腻火山灰的小玻璃瓶，是优质的肥料原料。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><rect x="26" y="10" width="12" height="6" rx="2" fill="#9e9e9e"/><path d="M24 16 L40 16 L42 24 L42 50 C42 54 38 56 32 56 C26 56 22 54 22 50 L22 24 Z" fill="#e0e0e0" stroke="#9e9e9e" stroke-width="1.5"/><path d="M22 32 L42 32 L42 50 C42 54 38 56 32 56 C26 56 22 54 22 50 Z" fill="#757575"/><ellipse cx="32" cy="32" rx="10" ry="2" fill="#616161"/><circle cx="28" cy="40" r="1.5" fill="#9e9e9e" opacity="0.6"/><circle cx="35" cy="44" r="1" fill="#bdbdbd" opacity="0.5"/></svg>',
      },
    ],
    "mermaid-bay": [
      {
        id: "bay-pearl",
        name: "珍珠贝",
        desc: "人鱼湾浅滩的双壳贝，孕育着圆润的珍珠。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><path d="M14 36 C14 24 22 14 32 14 C42 14 50 24 50 36 L50 44 C50 48 46 50 42 50 L22 50 C18 50 14 48 14 44 Z" fill="#ffccbc"/><path d="M14 36 C14 24 22 14 32 14 C36 14 40 16 42 20 L32 36 Z" fill="#ffab91"/><path d="M50 36 C50 24 42 14 32 14 C28 14 24 16 22 20 L32 36 Z" fill="#ffe0b2"/><circle cx="32" cy="38" r="7" fill="#fff9c4"/><circle cx="32" cy="38" r="7" fill="url(#pearlgrad)"/><defs><radialGradient id="pearlgrad" cx="35%" cy="30%"><stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#fff9c4"/><stop offset="100%" stop-color="#ffe082"/></radialGradient></defs><ellipse cx="29" cy="35" rx="2" ry="3" fill="#ffffff" opacity="0.8"/></svg>',
      },
      {
        id: "bay-coral",
        name: "珊瑚枝",
        desc: "从海湾礁石上采下的珊瑚枝，色泽温润如玉。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><path d="M32 54 L32 30" stroke="#ef9a9a" stroke-width="5" stroke-linecap="round"/><path d="M32 42 L22 32" stroke="#ef9a9a" stroke-width="4" stroke-linecap="round"/><path d="M32 36 L42 26" stroke="#ef9a9a" stroke-width="4" stroke-linecap="round"/><path d="M22 32 L18 24" stroke="#f48fb1" stroke-width="3" stroke-linecap="round"/><path d="M22 32 L26 24" stroke="#f48fb1" stroke-width="3" stroke-linecap="round"/><path d="M42 26 L38 18" stroke="#f48fb1" stroke-width="3" stroke-linecap="round"/><path d="M42 26 L46 18" stroke="#f48fb1" stroke-width="3" stroke-linecap="round"/><circle cx="18" cy="22" r="2.5" fill="#ce93d8"/><circle cx="26" cy="22" r="2.5" fill="#ce93d8"/><circle cx="38" cy="16" r="2.5" fill="#ce93d8"/><circle cx="46" cy="16" r="2.5" fill="#ce93d8"/><ellipse cx="32" cy="54" rx="10" ry="3" fill="#b0bec5" opacity="0.5"/></svg>',
      },
      {
        id: "bay-starfish",
        name: "海湾海星",
        desc: "五角星形的可爱海星，背面有细腻的颗粒纹理。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><polygon points="32,10 38,24 54,26 42,36 46,52 32,44 18,52 22,36 10,26 26,24" fill="#ff8a65"/><polygon points="32,10 38,24 54,26 42,36 46,52 32,44 18,52 22,36 10,26 26,24" fill="url(#stargrad)"/><defs><radialGradient id="stargrad" cx="50%" cy="45%"><stop offset="0%" stop-color="#ffab91"/><stop offset="100%" stop-color="#ff7043"/></radialGradient></defs><circle cx="28" cy="30" r="1.5" fill="#bf360c" opacity="0.5"/><circle cx="36" cy="30" r="1.5" fill="#bf360c" opacity="0.5"/><circle cx="32" cy="36" r="1.5" fill="#bf360c" opacity="0.5"/><circle cx="26" cy="38" r="1" fill="#bf360c" opacity="0.4"/><circle cx="38" cy="38" r="1" fill="#bf360c" opacity="0.4"/></svg>',
      },
      {
        id: "bay-shell",
        name: "海螺壳",
        desc: "螺旋形的海螺壳，贴近耳朵能听到海浪的声音。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><path d="M44 14 C34 14 26 22 26 32 C26 38 30 42 36 42 C40 42 44 38 44 34 C44 30 40 28 38 30 C36 32 34 30 34 28 C34 24 38 22 42 24 C46 26 48 22 46 18 C45 16 44 14 44 14Z" fill="#ffcc80"/><path d="M26 32 C22 36 20 42 22 48 C24 52 30 52 34 48 C30 46 28 42 30 38" fill="#ffb74d"/><path d="M44 14 C36 14 30 20 30 28 C30 32 34 34 36 32 C38 30 36 28 34 28 C32 28 32 24 36 22 C40 20 44 22 44 18 C44 16 44 14 44 14Z" fill="#ffe0b2" opacity="0.6"/><circle cx="38" cy="36" r="2" fill="#e65100" opacity="0.4"/></svg>',
      },
    ],
    academy: [
      {
        id: "academy-gear",
        name: "精密齿轮",
        desc: "皇家研究院制造的精密齿轮，咬合精准无误。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#f3e5f5"/><g fill="#9575cd"><rect x="29" y="6" width="6" height="8" rx="1"/><rect x="29" y="50" width="6" height="8" rx="1"/><rect x="6" y="29" width="8" height="6" rx="1"/><rect x="50" y="29" width="8" height="6" rx="1"/><rect x="12" y="12" width="6" height="8" rx="1" transform="rotate(-45 15 16)"/><rect x="46" y="12" width="6" height="8" rx="1" transform="rotate(45 49 16)"/><rect x="12" y="44" width="6" height="8" rx="1" transform="rotate(45 15 48)"/><rect x="46" y="44" width="6" height="8" rx="1" transform="rotate(-45 49 48)"/></g><circle cx="32" cy="32" r="16" fill="#b39ddb"/><circle cx="32" cy="32" r="6" fill="#7e57c2"/><circle cx="32" cy="32" r="3" fill="#ede7f6"/></svg>',
      },
      {
        id: "academy-potion",
        name: "炼金药剂",
        desc: "研究院炼金室调配的神秘药剂，瓶中液体泛着微光。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#f3e5f5"/><rect x="27" y="8" width="10" height="6" rx="2" fill="#8d6e63"/><path d="M25 14 L39 14 L41 22 L41 50 C41 54 37 56 32 56 C27 56 23 54 23 50 L23 22 Z" fill="#e1bee7" stroke="#9575cd" stroke-width="1.5"/><path d="M23 30 L41 30 L41 50 C41 54 37 56 32 56 C27 56 23 54 23 50 Z" fill="#ab47bc"/><ellipse cx="32" cy="30" rx="9" ry="2" fill="#8e24aa"/><circle cx="28" cy="40" r="2" fill="#ce93d8" opacity="0.7"/><circle cx="35" cy="46" r="1.5" fill="#e1bee7" opacity="0.6"/><path d="M27 36 Q29 34 31 36" stroke="#e1bee7" stroke-width="1.5" fill="none" opacity="0.5"/></svg>',
      },
      {
        id: "academy-scroll",
        name: "古老卷轴",
        desc: "记载着研究院失传知识的羊皮卷轴，字迹依然清晰。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#f3e5f5"/><rect x="14" y="16" width="36" height="32" rx="3" fill="#fff8e1"/><rect x="14" y="16" width="36" height="32" rx="3" fill="none" stroke="#d7ccc8" stroke-width="1.5"/><ellipse cx="14" cy="32" rx="4" ry="16" fill="#8d6e63"/><ellipse cx="50" cy="32" rx="4" ry="16" fill="#8d6e63"/><line x1="22" y1="24" x2="42" y2="24" stroke="#bcaaa4" stroke-width="1.5"/><line x1="22" y1="30" x2="42" y2="30" stroke="#bcaaa4" stroke-width="1.5"/><line x1="22" y1="36" x2="38" y2="36" stroke="#bcaaa4" stroke-width="1.5"/><line x1="22" y1="42" x2="40" y2="42" stroke="#bcaaa4" stroke-width="1.5"/><circle cx="32" cy="32" r="5" fill="none" stroke="#9575cd" stroke-width="1.5"/><text x="32" y="35" text-anchor="middle" font-size="7" fill="#7e57c2">知</text></svg>',
      },
      {
        id: "academy-astrolabe",
        name: "星象仪",
        desc: "研究院天文学家使用的小型星象仪，能观测星辰运行。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#f3e5f5"/><circle cx="32" cy="30" r="18" fill="none" stroke="#7e57c2" stroke-width="2"/><ellipse cx="32" cy="30" rx="18" ry="8" fill="none" stroke="#9575cd" stroke-width="1.5"/><ellipse cx="32" cy="30" rx="8" ry="18" fill="none" stroke="#9575cd" stroke-width="1.5"/><circle cx="32" cy="30" r="4" fill="#ffd54f"/><circle cx="20" cy="22" r="1.5" fill="#ffd54f"/><circle cx="44" cy="24" r="1.5" fill="#ffd54f"/><circle cx="40" cy="40" r="1.5" fill="#ffd54f"/><circle cx="24" cy="38" r="1.5" fill="#ffd54f"/><line x1="32" y1="48" x2="32" y2="56" stroke="#8d6e63" stroke-width="3" stroke-linecap="round"/><ellipse cx="32" cy="56" rx="8" ry="2" fill="#8d6e63"/></svg>',
      },
    ],
    "snow-valley": [
      {
        id: "snow-ice",
        name: "永冻冰晶",
        desc: "雪人谷深处万年不化的冰晶，散发着刺骨的寒气。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e0f7fa"/><polygon points="32,8 44,20 44,44 32,56 20,44 20,20" fill="#80deea"/><polygon points="32,8 44,20 32,32 20,20" fill="#b2ebf2"/><polygon points="20,20 32,32 32,56 20,44" fill="#4dd0e1" opacity="0.5"/><line x1="32" y1="8" x2="32" y2="56" stroke="#e0f7fa" stroke-width="1" opacity="0.6"/><line x1="20" y1="20" x2="44" y2="44" stroke="#e0f7fa" stroke-width="1" opacity="0.4"/><line x1="44" y1="20" x2="20" y2="44" stroke="#e0f7fa" stroke-width="1" opacity="0.4"/></svg>',
      },
      {
        id: "snow-flower",
        name: "雪绒花",
        desc: "只在极寒之地绽放的白色小花，花瓣如绒般柔软。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e0f7fa"/><g fill="#ffffff" stroke="#b2ebf2" stroke-width="1"><ellipse cx="32" cy="18" rx="6" ry="10"/><ellipse cx="32" cy="18" rx="6" ry="10" transform="rotate(72 32 32)"/><ellipse cx="32" cy="18" rx="6" ry="10" transform="rotate(144 32 32)"/><ellipse cx="32" cy="18" rx="6" ry="10" transform="rotate(216 32 32)"/><ellipse cx="32" cy="18" rx="6" ry="10" transform="rotate(288 32 32)"/></g><circle cx="32" cy="32" r="5" fill="#ffe082"/><circle cx="32" cy="32" r="3" fill="#ffb74d"/><line x1="32" y1="42" x2="32" y2="56" stroke="#80cbc4" stroke-width="2.5" stroke-linecap="round"/><path d="M32 50 Q28 48 26 50" stroke="#80cbc4" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
      },
      {
        id: "snow-berry",
        name: "冻浆果",
        desc: "被冰雪冻住的野生浆果，酸甜冰凉，是雪谷的美味。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e0f7fa"/><circle cx="24" cy="36" r="12" fill="#e57373"/><circle cx="40" cy="38" r="11" fill="#ef5350"/><circle cx="32" cy="28" r="10" fill="#f44336"/><circle cx="24" cy="36" r="12" fill="url(#berrygrad)" opacity="0.3"/><defs><radialGradient id="berrygrad" cx="30%" cy="25%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="transparent"/></radialGradient></defs><ellipse cx="20" cy="32" rx="3" ry="4" fill="#ffffff" opacity="0.4"/><ellipse cx="36" cy="24" rx="2.5" ry="3.5" fill="#ffffff" opacity="0.4"/><path d="M32 18 L32 12" stroke="#558b2f" stroke-width="2.5" stroke-linecap="round"/><path d="M32 14 Q36 10 40 12" stroke="#66bb6a" stroke-width="2" fill="none" stroke-linecap="round"/><g stroke="#b2ebf2" stroke-width="1" opacity="0.7"><line x1="18" y1="28" x2="16" y2="26"/><line x1="46" y1="30" x2="48" y2="28"/><line x1="28" y1="48" x2="27" y2="50"/></g></svg>',
      },
      {
        id: "snow-aurora",
        name: "极光石",
        desc: "吸收了雪人谷极光能量的石头，在黑暗中会发出微光。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e0f7fa"/><polygon points="32,10 46,22 44,46 20,46 18,22" fill="#90caf9"/><polygon points="32,10 40,20 32,28 24,20" fill="#bbdefb"/><polygon points="24,20 32,28 30,46 20,40" fill="#64b5f6" opacity="0.5"/><path d="M20 28 Q28 24 36 28 Q44 32 44 28" stroke="#a5d6a7" stroke-width="2" fill="none" opacity="0.8"/><path d="M20 34 Q28 30 36 34 Q44 38 44 34" stroke="#ce93d8" stroke-width="2" fill="none" opacity="0.7"/><path d="M22 40 Q28 37 34 40 Q40 43 42 40" stroke="#80deea" stroke-width="1.5" fill="none" opacity="0.6"/><circle cx="28" cy="24" r="1.5" fill="#ffffff" opacity="0.8"/><circle cx="38" cy="32" r="1" fill="#ffffff" opacity="0.6"/></svg>',
      },
    ],
    "thunder-valley": [
      {
        id: "thunder-crystal",
        name: "雷电结晶",
        desc: "在雷电中孕育的结晶，内部闪烁着电光。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff8e1"/><polygon points="32,8 44,24 40,48 24,48 20,24" fill="#ffd54f"/><polygon points="32,8 38,22 32,32 26,22" fill="#ffecb3"/><polygon points="26,22 32,32 30,48 22,42" fill="#ffc107" opacity="0.6"/><path d="M32 20 L28 32 L34 32 L30 44" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      },
      {
        id: "thunder-feather",
        name: "闪电羽毛",
        desc: "传说中雷鸟遗落的羽毛，触碰会有麻感。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff8e1"/><path d="M42 10 C30 14 22 26 22 38 L22 50" stroke="#ffd54f" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M42 10 C36 12 30 18 28 26 C36 24 42 18 44 12 C44 11 43 10 42 10Z" fill="#ffc107"/><path d="M40 16 C34 18 29 24 27 32 C34 30 40 24 42 18 C42 17 41 16 40 16Z" fill="#ffd54f"/><path d="M37 24 C32 26 28 32 26 40 C32 38 37 32 39 26 C39 25 38 24 37 24Z" fill="#ffecb3"/><path d="M22 38 L18 44" stroke="#ffc107" stroke-width="2" stroke-linecap="round"/></svg>',
      },
      {
        id: "thunder-storm-eye",
        name: "风暴之眼",
        desc: "风暴中心凝结的球体，安静却蕴含巨大能量。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff8e1"/><circle cx="32" cy="32" r="18" fill="#90caf9" opacity="0.4"/><circle cx="32" cy="32" r="14" fill="#64b5f6" opacity="0.5"/><circle cx="32" cy="32" r="8" fill="#fff"/><circle cx="32" cy="32" r="5" fill="#ffd54f"/><path d="M20 24 Q32 20 44 24" stroke="#42a5f5" stroke-width="2" fill="none" opacity="0.6"/><path d="M18 32 Q32 28 46 32" stroke="#42a5f5" stroke-width="2" fill="none" opacity="0.5"/><path d="M20 40 Q32 36 44 40" stroke="#42a5f5" stroke-width="2" fill="none" opacity="0.4"/></svg>',
      },
      {
        id: "thunder-stone",
        name: "雷鸣石",
        desc: "峡谷中常见的石头，靠近时会嗡嗡作响。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff8e1"/><polygon points="20,22 44,18 50,38 38,52 18,48" fill="#9e9e9e"/><polygon points="20,22 44,18 36,34 22,36" fill="#bdbdbd"/><polygon points="36,34 50,38 44,50 38,52" fill="#757575" opacity="0.6"/><path d="M30 26 L26 36 L32 36 L28 46" stroke="#ffd54f" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="40" cy="28" r="2" fill="#ffc107" opacity="0.7"/></svg>',
      },
    ],
    "shadow-forest": [
      {
        id: "shadow-ghost-fire",
        name: "鬼火",
        desc: "幽暗森林中漂浮的幽蓝火焰，冰冷刺骨。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1a1a2e"/><path d="M32 12 C26 22 20 28 20 38 C20 46 26 52 32 52 C38 52 44 46 44 38 C44 30 38 26 36 20 C34 24 32 26 32 22 C32 18 32 14 32 12Z" fill="#4fc3f7"/><path d="M32 24 C28 30 26 34 26 40 C26 44 28 48 32 48 C36 48 38 44 38 40 C38 36 36 32 32 24Z" fill="#81d4fa"/><ellipse cx="29" cy="38" rx="2" ry="4" fill="#e1f5fe" opacity="0.8"/></svg>',
      },
      {
        id: "shadow-soul-orb",
        name: "灵魂珠",
        desc: "封存着游魂的水晶球，内部有影子游动。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1a1a2e"/><circle cx="32" cy="34" r="18" fill="#7c4dff" opacity="0.3"/><circle cx="32" cy="34" r="14" fill="#651fff" opacity="0.5"/><circle cx="32" cy="34" r="10" fill="#b388ff"/><path d="M28 30 Q26 28 28 26 Q30 24 32 26 Q34 28 32 30" stroke="#fff" stroke-width="1.5" fill="none" opacity="0.7"/><circle cx="28" cy="34" r="1.5" fill="#fff" opacity="0.8"/><circle cx="35" cy="36" r="1" fill="#fff" opacity="0.6"/><line x1="32" y1="16" x2="32" y2="12" stroke="#9e9e9e" stroke-width="2"/></svg>',
      },
      {
        id: "shadow-bone",
        name: "幽魂骨",
        desc: "森林中散落的古老骨头，散发着幽光。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1a1a2e"/><ellipse cx="20" cy="32" rx="6" ry="8" fill="#e0e0e0"/><ellipse cx="44" cy="32" rx="6" ry="8" fill="#e0e0e0"/><rect x="20" y="28" width="24" height="8" rx="4" fill="#f5f5f5"/><circle cx="18" cy="26" r="3" fill="#f5f5f5"/><circle cx="18" cy="38" r="3" fill="#f5f5f5"/><circle cx="46" cy="26" r="3" fill="#f5f5f5"/><circle cx="46" cy="38" r="3" fill="#f5f5f5"/><path d="M26 30 L30 30 M34 30 L38 30" stroke="#9e9e9e" stroke-width="1.5"/></svg>',
      },
      {
        id: "shadow-curse-doll",
        name: "诅咒娃娃",
        desc: "被遗弃的布偶，据说带着不祥的诅咒。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1a1a2e"/><circle cx="32" cy="22" r="10" fill="#8d6e63"/><rect x="24" y="30" width="16" height="20" rx="4" fill="#a1887f"/><circle cx="28" cy="20" r="2" fill="#d32f2f"/><circle cx="36" cy="20" r="2" fill="#d32f2f"/><path d="M28 26 Q32 28 36 26" stroke="#5d4037" stroke-width="1.5" fill="none"/><line x1="24" y1="36" x2="18" y2="42" stroke="#8d6e63" stroke-width="3" stroke-linecap="round"/><line x1="40" y1="36" x2="46" y2="42" stroke="#8d6e63" stroke-width="3" stroke-linecap="round"/><line x1="28" y1="50" x2="26" y2="56" stroke="#8d6e63" stroke-width="3" stroke-linecap="round"/><line x1="36" y1="50" x2="38" y2="56" stroke="#8d6e63" stroke-width="3" stroke-linecap="round"/></svg>',
      },
    ],
    "dark-swamp": [
      {
        id: "swamp-poison",
        name: "剧毒瓶",
        desc: "装着沼泽剧毒的小瓶，散发着诡异的绿光。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1b2e1b"/><rect x="27" y="8" width="10" height="6" rx="2" fill="#5d4037"/><path d="M24 14 L40 14 L42 22 L42 50 C42 54 38 56 32 56 C26 56 22 54 22 50 L22 22 Z" fill="#a5d6a7" stroke="#388e3c" stroke-width="1.5"/><path d="M22 30 L42 30 L42 50 C42 54 38 56 32 56 C26 56 22 54 22 50 Z" fill="#7cb342"/><ellipse cx="32" cy="30" rx="10" ry="2" fill="#558b2f"/><circle cx="28" cy="40" r="2" fill="#aed581" opacity="0.7"/><circle cx="35" cy="46" r="1.5" fill="#c5e1a5" opacity="0.5"/><path d="M27 36 Q29 34 31 36" stroke="#aed581" stroke-width="1.5" fill="none" opacity="0.6"/></svg>',
      },
      {
        id: "swamp-tooth",
        name: "毒牙",
        desc: "沼泽猛兽脱落的毒牙，依然带着剧毒。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1b2e1b"/><path d="M24 14 L28 14 L30 48 C30 52 26 54 24 50 C22 46 22 20 24 14Z" fill="#fff9c4"/><path d="M36 14 L40 14 L42 48 C42 52 38 54 36 50 C34 46 34 20 36 14Z" fill="#fff9c4"/><path d="M26 16 L28 16 L28 40 C28 42 26 43 25 41 C24 38 24 20 26 16Z" fill="#fffde7"/><path d="M38 16 L40 16 L40 40 C40 42 38 43 37 41 C36 38 36 20 38 16Z" fill="#fffde7"/><ellipse cx="26" cy="30" rx="1.5" ry="4" fill="#7cb342" opacity="0.5"/><ellipse cx="39" cy="30" rx="1.5" ry="4" fill="#7cb342" opacity="0.5"/></svg>',
      },
      {
        id: "swamp-dark-scale",
        name: "暗鳞",
        desc: "沼泽深处怪物身上脱落的黑色鳞片。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1b2e1b"/><path d="M32 12 C40 12 48 20 48 32 C48 44 40 52 32 52 C24 52 16 44 16 32 C16 20 24 12 32 12Z" fill="#263238"/><path d="M32 16 C38 16 44 22 44 32 C44 42 38 48 32 48 C26 48 20 42 20 32 C20 22 26 16 32 16Z" fill="#37474f"/><path d="M24 28 Q32 24 40 28 Q36 34 32 34 Q28 34 24 28Z" fill="#546e7a"/><path d="M26 38 Q32 34 38 38 Q34 42 32 42 Q30 42 26 38Z" fill="#455a64"/><circle cx="30" cy="30" r="1" fill="#78909c" opacity="0.6"/></svg>',
      },
      {
        id: "swamp-mud",
        name: "腐泥",
        desc: "沼泽底部的黑色腐泥，散发着恶臭却有奇效。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#1b2e1b"/><ellipse cx="32" cy="40" rx="22" ry="14" fill="#3e2723"/><ellipse cx="32" cy="38" rx="20" ry="12" fill="#4e342e"/><ellipse cx="26" cy="36" rx="4" ry="2" fill="#5d4037" opacity="0.6"/><ellipse cx="38" cy="38" rx="3" ry="1.5" fill="#5d4037" opacity="0.5"/><circle cx="28" cy="34" r="2" fill="#6d4c41" opacity="0.4"/><circle cx="36" cy="35" r="1.5" fill="#6d4c41" opacity="0.3"/><path d="M20 28 Q22 26 24 28" stroke="#5d4037" stroke-width="2" fill="none" opacity="0.5"/><path d="M40 26 Q42 24 44 26" stroke="#5d4037" stroke-width="2" fill="none" opacity="0.5"/></svg>',
      },
    ],
    "dragon-realm": [
      {
        id: "dragon-scale",
        name: "龙鳞",
        desc: "龙族身上脱落的鳞片，坚硬如铁且泛着光泽。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><path d="M32 10 C42 10 50 20 50 32 C50 44 42 54 32 54 C22 54 14 44 14 32 C14 20 22 10 32 10Z" fill="#ff7043"/><path d="M32 14 C40 14 46 22 46 32 C46 42 40 50 32 50 C24 50 18 42 18 32 C18 22 24 14 32 14Z" fill="#ff8a65"/><path d="M24 26 Q32 22 40 26 Q36 32 32 32 Q28 32 24 26Z" fill="#ffab91"/><path d="M26 36 Q32 32 38 36 Q34 40 32 40 Q30 40 26 36Z" fill="#ffccbc"/><path d="M28 44 Q32 42 36 44" stroke="#ffab91" stroke-width="1.5" fill="none" opacity="0.6"/></svg>',
      },
      {
        id: "dragon-claw",
        name: "龙爪",
        desc: "巨龙脱落的利爪，锋利无比。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><path d="M20 14 L24 14 L26 44 C26 50 22 52 20 48 C18 44 18 20 20 14Z" fill="#fff9c4"/><path d="M30 12 L34 12 L36 48 C36 54 32 56 30 52 C28 48 28 18 30 12Z" fill="#fff9c4"/><path d="M40 14 L44 14 L46 44 C46 50 42 52 40 48 C38 44 38 20 40 14Z" fill="#fff9c4"/><path d="M22 16 L24 16 L24 40 C24 42 22 43 21 41 C20 38 20 20 22 16Z" fill="#fffde7"/><path d="M32 14 L34 14 L34 44 C34 46 32 47 31 45 C30 42 30 18 32 14Z" fill="#fffde7"/><path d="M42 16 L44 16 L44 40 C44 42 42 43 41 41 C40 38 40 20 42 16Z" fill="#fffde7"/></svg>',
      },
      {
        id: "dragon-bone",
        name: "龙骨",
        desc: "远古巨龙的遗骨，蕴含着强大的力量。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><ellipse cx="16" cy="32" rx="7" ry="10" fill="#ffe0b2"/><ellipse cx="48" cy="32" rx="7" ry="10" fill="#ffe0b2"/><rect x="16" y="27" width="32" height="10" rx="5" fill="#fff8e1"/><circle cx="14" cy="24" r="3.5" fill="#fff8e1"/><circle cx="14" cy="40" r="3.5" fill="#fff8e1"/><circle cx="50" cy="24" r="3.5" fill="#fff8e1"/><circle cx="50" cy="40" r="3.5" fill="#fff8e1"/><path d="M22 29 L26 29 M30 29 L34 29 M38 29 L42 29" stroke="#ffcc80" stroke-width="1.5"/><path d="M32 18 L32 27 M32 37 L32 46" stroke="#ffcc80" stroke-width="2"/></svg>',
      },
      {
        id: "dragon-gem",
        name: "龙晶",
        desc: "龙族宝藏中最珍贵的宝石，蕴含龙之力。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#fff3e0"/><polygon points="32,8 48,24 44,48 20,48 16,24" fill="#ff7043"/><polygon points="32,8 42,22 32,32 22,22" fill="#ffab91"/><polygon points="22,22 32,32 30,48 18,42" fill="#e64a19" opacity="0.5"/><line x1="32" y1="8" x2="32" y2="48" stroke="#ffe0b2" stroke-width="1" opacity="0.6"/><line x1="16" y1="24" x2="48" y2="24" stroke="#ffe0b2" stroke-width="1" opacity="0.4"/><ellipse cx="26" cy="20" rx="3" ry="5" fill="#fff" opacity="0.4"/></svg>',
      },
    ],
    "sky-city": [
      {
        id: "sky-feather",
        name: "神鸟羽毛",
        desc: "天空之城神鸟遗落的金色羽毛。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><path d="M42 10 C30 14 22 26 22 38 L22 52" stroke="#ffd54f" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M42 10 C36 12 30 18 28 26 C36 24 42 18 44 12 C44 11 43 10 42 10Z" fill="#ffc107"/><path d="M40 16 C34 18 29 24 27 32 C34 30 40 24 42 18 C42 17 41 16 40 16Z" fill="#ffd54f"/><path d="M37 24 C32 26 28 32 26 40 C32 38 37 32 39 26 C39 25 38 24 37 24Z" fill="#ffecb3"/><line x1="22" y1="38" x2="18" y2="44" stroke="#ffc107" stroke-width="2" stroke-linecap="round"/></svg>',
      },
      {
        id: "sky-cloud",
        name: "云朵棉",
        desc: "从天空之城采集的实体云朵，柔软蓬松。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><ellipse cx="24" cy="36" rx="12" ry="10" fill="#fff"/><ellipse cx="40" cy="34" rx="14" ry="12" fill="#fff"/><ellipse cx="32" cy="40" rx="18" ry="10" fill="#fff"/><ellipse cx="20" cy="38" rx="8" ry="7" fill="#f5f5f5" opacity="0.5"/><ellipse cx="44" cy="38" rx="8" ry="7" fill="#f5f5f5" opacity="0.5"/><circle cx="26" cy="32" r="2" fill="#e3f2fd" opacity="0.6"/><circle cx="38" cy="30" r="1.5" fill="#e3f2fd" opacity="0.5"/></svg>',
      },
      {
        id: "sky-wing",
        name: "天使之翼",
        desc: "传说中天使遗落的翅膀碎片，散发圣光。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><path d="M32 14 C28 18 26 24 26 30 C26 36 28 40 32 42 C36 40 38 36 38 30 C38 24 36 18 32 14Z" fill="#fff"/><path d="M26 22 C20 24 16 30 16 36 C16 42 20 46 26 44 C24 40 24 34 26 30 C22 32 20 36 20 40 C18 36 18 30 22 26 C20 28 18 32 18 36 C16 32 18 26 24 22Z" fill="#f5f5f5"/><path d="M38 22 C44 24 48 30 48 36 C48 42 44 46 38 44 C40 40 40 34 38 30 C42 32 44 36 44 40 C46 36 46 30 42 26 C44 28 46 32 46 36 C48 32 46 26 40 22Z" fill="#f5f5f5"/><circle cx="32" cy="28" r="3" fill="#ffd54f" opacity="0.6"/></svg>',
      },
      {
        id: "sky-stone",
        name: "天空石",
        desc: "从天空之城坠落的神秘石头，能让人漂浮。",
        icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64" rx="12" fill="#e3f2fd"/><polygon points="32,10 46,22 44,46 20,46 18,22" fill="#90caf9"/><polygon points="32,10 40,20 32,28 24,20" fill="#bbdefb"/><polygon points="24,20 32,28 30,46 20,40" fill="#64b5f6" opacity="0.5"/><line x1="32" y1="10" x2="32" y2="46" stroke="#e3f2fd" stroke-width="1" opacity="0.6"/><ellipse cx="27" cy="24" rx="3" ry="5" fill="#fff" opacity="0.5"/><path d="M20 52 Q32 48 44 52" stroke="#90caf9" stroke-width="1.5" fill="none" opacity="0.4"/></svg>',
      },
    ],
  });
  const MARKET_STORAGE_KEY = "carlosia_market_v1";
  const MARKET_TABLE = "market_listings";
  const MARKET_FEE_RATE = 0.1; // 卖家手续费 10%
  // 每个道具的统一定价（经验值）- 已×5
  const ITEM_PRICES = Object.freeze({
    "grass-clover": 200, "grass-feather": 250, "grass-dandelion": 150, "grass-dewdrop": 175,
    "volcano-lava": 400, "volcano-ember": 350, "volcano-charfruit": 250, "volcano-ash": 200,
    "bay-pearl": 300, "bay-coral": 275, "bay-starfish": 225, "bay-shell": 200,
    "academy-gear": 325, "academy-potion": 350, "academy-scroll": 300, "academy-astrolabe": 375,
    "snow-ice": 350, "snow-flower": 300, "snow-berry": 225, "snow-aurora": 400,
    "thunder-crystal": 450, "thunder-feather": 425, "thunder-storm-eye": 500, "thunder-stone": 350,
    "shadow-ghost-fire": 550, "shadow-soul-orb": 600, "shadow-bone": 475, "shadow-curse-doll": 650,
    "swamp-poison": 650, "swamp-tooth": 700, "swamp-dark-scale": 750, "swamp-mud": 500,
    "dragon-scale": 800, "dragon-claw": 850, "dragon-bone": 750, "dragon-gem": 1000,
    "sky-feather": 900, "sky-cloud": 800, "sky-wing": 1000, "sky-stone": 1100,
  });

  // ===== 场景内探索地点 =====
  const SCENE_SPOTS = Object.freeze({
    grassland: [
      { id: "meadow", name: "草地深处", desc: "茂密的草地随风起伏，藏着不少小玩意。", exp: [7, 30], mainItem: "grass-clover" },
      { id: "stream", name: "溪流边", desc: "清澈的小溪潺潺流过，水面泛着光。", exp: [22, 45], mainItem: "grass-dewdrop" },
      { id: "windmill", name: "风车下", desc: "古老的风车缓缓转动，风声悦耳。", exp: [37, 60], mainItem: "grass-feather" },
      { id: "flowerfield", name: "花海", desc: "五颜六色的野花盛开，蝴蝶翩翩起舞。", exp: [52, 75], mainItem: "grass-dandelion" },
      { id: "hillside", name: "小山坡", desc: "登上坡顶可以俯瞰整个草原。", exp: [67, 90], mainItem: "grass-clover" },
      { id: "treehollow", name: "神秘树洞", desc: "巨大的老树洞里似乎藏着什么秘密。", exp: [90, 112], mainItem: "grass-dewdrop" },
    ],
    volcano: [
      { id: "ashfield", name: "火山灰原", desc: "灰色的火山灰铺满大地，松软异常。", exp: [75, 97], mainItem: "volcano-ash" },
      { id: "crater", name: "熔岩口", desc: "滚烫的岩浆翻涌，热浪扑面而来。", exp: [97, 120], mainItem: "volcano-lava" },
      { id: "kiln", name: "炭窑遗址", desc: "废弃的炭窑还冒着余烟，飘着焦香。", exp: [112, 135], mainItem: "volcano-charfruit" },
      { id: "lavapool", name: "岩浆池", desc: "炽热的岩浆咕嘟冒泡，映红了天空。", exp: [127, 150], mainItem: "volcano-ember" },
      { id: "rocky", name: "火岩区", desc: "黑色的火山岩遍地，行走困难。", exp: [142, 165], mainItem: "volcano-lava" },
      { id: "deepcrater", name: "火山口深处", desc: "越往下越热，传说有火之精灵栖息。", exp: [165, 187], mainItem: "volcano-ember" },
    ],
    "mermaid-bay": [
      { id: "shallow", name: "浅滩", desc: "温暖的浅海水清澈见底，鱼儿游过。", exp: [150, 172], mainItem: "bay-pearl" },
      { id: "reef", name: "珊瑚礁", desc: "五彩的珊瑚丛中藏着各种宝贝。", exp: [165, 187], mainItem: "bay-coral" },
      { id: "shipwreck", name: "沉船残骸", desc: "古老的沉船静静躺在海底，神秘莫测。", exp: [180, 202], mainItem: "bay-shell" },
      { id: "deepcave", name: "深海洞穴", desc: "幽暗的海底洞穴，回声阵阵。", exp: [195, 217], mainItem: "bay-starfish" },
      { id: "kelpforest", name: "海草森林", desc: "巨大的海草随波摇曳，像水下森林。", exp: [210, 232], mainItem: "bay-pearl" },
      { id: "seatemple", name: "海底神殿", desc: "传说中的人鱼神殿，布满珍珠。", exp: [232, 262], mainItem: "bay-coral" },
    ],
    academy: [
      { id: "library", name: "图书馆", desc: "高耸的书架直达天花板，书香弥漫。", exp: [225, 247], mainItem: "academy-scroll" },
      { id: "lab", name: "实验室", desc: "瓶瓶罐罐摆满桌面，炼金师正在忙碌。", exp: [240, 262], mainItem: "academy-potion" },
      { id: "observatory", name: "天文台", desc: "巨大的望远镜指向星空，繁星闪烁。", exp: [255, 277], mainItem: "academy-astrolabe" },
      { id: "workshop", name: "炼金工坊", desc: "熔炉里炼着各种神奇的材料。", exp: [270, 292], mainItem: "academy-potion" },
      { id: "classroom", name: "魔法教室", desc: "学生们在这里学习基础魔法。", exp: [285, 307], mainItem: "academy-gear" },
      { id: "forbidden", name: "禁忌书架", desc: "封锁的区域，藏着古老的禁忌知识。", exp: [307, 337], mainItem: "academy-scroll" },
    ],
    "snow-valley": [
      { id: "snowfield", name: "雪原", desc: "一望无际的雪原，脚下咯吱作响。", exp: [300, 322], mainItem: "snow-flower" },
      { id: "icecave", name: "冰洞", desc: "晶莹的冰洞散发着幽蓝的光，寒气逼人。", exp: [315, 337], mainItem: "snow-ice" },
      { id: "aurora", name: "极光台", desc: "仰望天空，绚丽的极光缓缓流动。", exp: [330, 352], mainItem: "snow-aurora" },
      { id: "frozenlake", name: "冰封湖", desc: "湖面冻得结结实实，可以滑冰。", exp: [345, 367], mainItem: "snow-berry" },
      { id: "snowpeak", name: "雪山顶", desc: "爬上山顶，寒风凛冽但风景绝佳。", exp: [360, 382], mainItem: "snow-ice" },
      { id: "icepalace", name: "冰晶宫殿", desc: "传说中冰之女王的宫殿，闪耀夺目。", exp: [382, 412], mainItem: "snow-aurora" },
    ],
    "thunder-valley": [
      { id: "canyon-entrance", name: "峡谷入口", desc: "两侧峭壁高耸，远处传来隐隐雷声。", exp: [375, 397], mainItem: "thunder-stone" },
      { id: "electric-field", name: "雷电场", desc: "空气中弥漫着电荷，毛发都会竖起来。", exp: [390, 420], mainItem: "thunder-crystal" },
      { id: "lightning-rock", name: "闪电石", desc: "被闪电劈中的巨石，表面还带着电弧。", exp: [405, 435], mainItem: "thunder-crystal" },
      { id: "storm-platform", name: "风暴台", desc: "峡谷中央的高台，风暴在此汇聚。", exp: [420, 450], mainItem: "thunder-storm-eye" },
      { id: "thunder-cliff", name: "雷霆崖", desc: "悬崖边雷声滚滚，震耳欲聋。", exp: [435, 480], mainItem: "thunder-feather" },
      { id: "thunder-temple", name: "雷神殿", desc: "传说中雷神居住的殿堂，电光四射。", exp: [480, 525], mainItem: "thunder-storm-eye" },
    ],
    "shadow-forest": [
      { id: "forest-edge", name: "森林边缘", desc: "阳光在这里变得微弱，气氛诡异。", exp: [450, 480], mainItem: "shadow-ghost-fire" },
      { id: "dark-path", name: "幽暗小径", desc: "两旁的树木遮天蔽日，看不清前路。", exp: [465, 510], mainItem: "shadow-soul-orb" },
      { id: "grave", name: "古老墓地", desc: "散落着古老的墓碑，偶尔传来低语。", exp: [487, 540], mainItem: "shadow-bone" },
      { id: "haunted-house", name: "闹鬼小屋", desc: "废弃的小屋，窗户里似乎有影子晃动。", exp: [510, 570], mainItem: "shadow-curse-doll" },
      { id: "deep-woods", name: "森林深处", desc: "越往里走越黑暗，幽灵出没频繁。", exp: [540, 600], mainItem: "shadow-soul-orb" },
      { id: "ghost-king-castle", name: "幽灵王城堡", desc: "传说中幽灵王的居所，阴气冲天。", exp: [600, 637], mainItem: "shadow-ghost-fire" },
    ],
    "dark-swamp": [
      { id: "swamp-edge", name: "沼泽边缘", desc: "泥泞的土地散发着腐臭的气息。", exp: [525, 562], mainItem: "swamp-poison" },
      { id: "toxic-pool", name: "毒水池", desc: "碧绿的毒水冒着泡，碰之即伤。", exp: [547, 600], mainItem: "swamp-tooth" },
      { id: "rotten-tree", name: "腐木林", desc: "腐烂的树木扭曲成诡异的形状。", exp: [570, 630], mainItem: "swamp-poison" },
      { id: "serpent-den", name: "毒蛇巢穴", desc: "无数毒蛇盘踞的洞穴，危险至极。", exp: [600, 667], mainItem: "swamp-tooth" },
      { id: "dark-lake", name: "黑暗湖", desc: "漆黑的湖水深不见底，藏着怪物。", exp: [637, 712], mainItem: "swamp-dark-scale" },
      { id: "evil-altar", name: "邪恶祭坛", desc: "沼泽深处的神秘祭坛，散发恶意。", exp: [712, 750], mainItem: "swamp-dark-scale" },
    ],
    "dragon-realm": [
      { id: "dragon-gate", name: "龙门", desc: "巨大的石门上刻着龙族的图腾。", exp: [600, 637], mainItem: "dragon-scale" },
      { id: "volcanic-lair", name: "熔岩龙巢", desc: "炽热的龙巢，岩浆缓缓流淌。", exp: [622, 675], mainItem: "dragon-claw" },
      { id: "dragon-bone-field", name: "龙骨荒原", desc: "遍地都是远古巨龙的骸骨。", exp: [652, 712], mainItem: "dragon-bone" },
      { id: "treasure-cave", name: "宝藏洞穴", desc: "龙族收集的宝藏堆积如山。", exp: [682, 750], mainItem: "dragon-gem" },
      { id: "dragon-peak", name: "龙之峰", desc: "群龙栖息的高峰，龙威浩荡。", exp: [720, 810], mainItem: "dragon-scale" },
      { id: "dragon-king-temple", name: "龙王殿", desc: "传说中龙王的宫殿，金碧辉煌。", exp: [810, 862], mainItem: "dragon-gem" },
    ],
    "sky-city": [
      { id: "cloud-stairs", name: "云梯", desc: "通往天空之城的云朵阶梯。", exp: [675, 720], mainItem: "sky-feather" },
      { id: "floating-garden", name: "浮空花园", desc: "漂浮在云端的美丽花园。", exp: [705, 765], mainItem: "sky-cloud" },
      { id: "wind-temple", name: "风之神殿", desc: "供奉风神的古老神殿。", exp: [735, 802], mainItem: "sky-feather" },
      { id: "bird-palace", name: "百鸟宫殿", desc: "无数神鸟栖息的华丽宫殿。", exp: [772, 847], mainItem: "sky-wing" },
      { id: "thunder-platform", name: "雷霆台", desc: "云层之上的高台，雷电交加。", exp: [817, 900], mainItem: "sky-stone" },
      { id: "god-throne", name: "天神王座", desc: "传说中天神的王座，光芒万丈。", exp: [900, 975], mainItem: "sky-stone" },
    ],
  });

  // 每个场景的野生精灵（用于探索遇敌）
    const WILD_PETS = Object.freeze({
    grassland: { petIds: ["magic-cat", "spring-rabbit", "yibei-fenfen", "sleepy-king", "bounce-seed", "gran-seed", "qili-grass", "small-bee"], levelRange: [2, 4], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    volcano: { petIds: ["fire-god", "fire-guardian", "fire-dragon", "fire-monkey"], levelRange: [5, 8], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "mermaid-bay": { petIds: ["water-spirit", "water-shell", "small-lotus", "water-ball"], levelRange: [8, 13], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    academy: { petIds: ["dimo", "platinum-unicorn", "holy-sword-x", "pen-child", "small-cow"], levelRange: [15, 22], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "snow-valley": { petIds: ["snow-shadow-doll", "sundae-sweet", "snow-doll", "snow-beast"], levelRange: [30, 40], encounterRate: 0.8, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "thunder-valley": { petIds: ["kula", "electric-circle", "thunder-ball"], levelRange: [38, 48], encounterRate: 0.8, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "shadow-forest": { petIds: ["bone-dragon", "flower-antelope", "small-mushroom", "grass-bug"], levelRange: [46, 56], encounterRate: 0.8, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "dark-swamp": { petIds: ["demon-wolf", "dragon-breath-par", "wuda", "star-demon", "duoduo"], levelRange: [55, 68], encounterRate: 0.8, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "dragon-realm": { petIds: ["wing-dragon", "tooth-dragon", "horn-dragon", "small-stone"], levelRange: [65, 80], encounterRate: 0.8, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
    "sky-city": { petIds: ["royal-griffin", "holy-wing-king", "mini-liwu", "bean-dragon", "mecha-shell"], levelRange: [80, 90], encounterRate: 0.8, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.03 },
  });

  const PET_DATABASE = Array.isArray(PET_DATA.petDatabase) ? PET_DATA.petDatabase : [];
  const PET_POOL = Object.freeze(
    PET_DATABASE.length > 0 ? PET_DATABASE : FALLBACK_PET_POOL,
  );

  const els = {};
  let state = null;
  let selectedSceneId = "grassland";
  let teacherUnlocked = false;
  let resultMessage = "";
  let resultIsWarning = false;
  let currentView = "world"; // "world" 大世界 / "scene" 场景内 / "shop" 商店
  let selectedSpotId = null;
  let currentShopTab = "market"; // "market" 逛市场 / "sell" 我要卖 / "mine" 我的上架
  let marketState = { listings: [] };
  let isExploring = false; // 探索动画进行中，防止重复点击
  let pulledProfileIds = []; // 老师拉入的学生ID列表（不存档）
  let timerInterval = null; // 计时器interval
  let timerSeconds = TIMER_DURATION; // 计时器剩余秒数
  let timerStarted = false; // 计时器是否已启动过（启动后不能再加时间）
  let currentGuideStep = 0; // 当前引导步骤
  let guideStartIndex = 0; // 引导起始步骤（学生端已自动建档，跳过"创建角色"这一步）
  let captureTarget = null; // 当前捕捉目标野生宠物
  let lastToastTime = {}; // 记录上次提示时间，避免重复提示
  // 本地存档键：老师端用全班存档，学生登录后切到自己的独立缓存，避免互相覆盖
  let activeStorageKey = STORAGE_KEY;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheElements();
    state = loadState();
    marketState = loadMarket();
    const changed = normalizeState();
    // 加载时检查所有宠物的自动进化
    let evolvedAny = false;
    if (state?.profiles) {
      state.profiles.forEach((profile) => {
        if (profile.pets) {
          profile.pets.forEach((pet) => {
            if (autoEvolvePet(pet)) {
              evolvedAny = true;
            }
          });
        }
        // 同步当前出战宠物
        if (profile.pet && profile.pets && profile.activePetIndex !== undefined) {
          profile.pet = profile.pets[profile.activePetIndex];
        }
      });
    }
    // 加载阶段发生的进化不播放演出（避免刚进游戏就被弹窗打断），直接丢弃记录
    pendingEvolution = null;
    bindEvents();
    if (changed || evolvedAny) {
      saveState("存档已刷新");
    } else {
      setSaveStatus("存档已读取");
    }
    // 登录界面默认显示，登录后才渲染游戏
    if (els.loginView) {
      els.loginView.classList.remove("hidden");
    }
    // 本地双击打开（老师备课）默认进老师入口；线上默认学生登录
    if (location.protocol === "file:") {
      const loginModeButtons = document.querySelectorAll("[data-login-mode]");
      loginModeButtons.forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.loginMode === "teacher");
      });
      if (els.loginForm) {
        els.loginForm.hidden = false;
      }
      if (els.studentLoginForm) {
        els.studentLoginForm.hidden = true;
      }
    }
  }

  // 老师登录：进后台，并把云端全班数据拉下来（拉不到就继续用本地）
  async function handleLogin(event) {
    event.preventDefault();
    const code = els.teacherCode.value.trim();
    if (code !== TEACHER_KEY) {
      els.loginError.hidden = false;
      els.teacherCode.value = "";
      return;
    }
    teacherUnlocked = true;
    els.loginError.hidden = true;
    // 本地双击打开（老师离线备课 / 线下课）保持纯本地存档；线上才拉云端全班
    const useCloudTeacher = CLOUD_ENABLED && location.protocol !== "file:";
    activeStorageKey = useCloudTeacher ? `${STORAGE_KEY}_cloud_teacher` : STORAGE_KEY;
    cloudSyncAllowed = useCloudTeacher;
    if (useCloudTeacher) {
      setSaveStatus("正在读取全班数据");
      try {
        const rows = await cloudGetAllStudents();
        if (rows && rows.length) {
          const merged = rows.map(profileFromCloud);
          state.profiles = merged;
          state.selectedId = merged[0].id;
          normalizeState();
          pendingEvolution = null;
          setSaveStatus(`全班数据已加载（${merged.length} 人）`);
        }
      } catch (err) {
        console.warn("读取云端名单失败", err);
        setSaveStatus("云端读取失败（沿用本地存档）");
      }
    }
    els.loginView.classList.add("hidden");
    // 老师端：恢复三栏桌面布局
    const teacherGrid = document.querySelector(".app-grid");
    if (teacherGrid) {
      teacherGrid.classList.remove("is-student");
    }
    // 老师端恢复"角色存档"面板
    const teacherPanel = document.querySelector(".profile-panel");
    if (teacherPanel) {
      teacherPanel.hidden = false;
    }
    // 老师端保留课间计时器
    const teacherTimer = document.querySelector(".timer-panel");
    if (teacherTimer) {
      teacherTimer.style.display = "";
    }
    // 老师端显示老师后台
    const teacherBox = document.querySelector(".teacher-panel");
    if (teacherBox) {
      teacherBox.style.display = "";
    }
    render();
  }

  // 学生登录：按名字查云端存档，查不到就自动建一个新档
  async function handleStudentLogin(event) {
    event.preventDefault();
    if (!CLOUD_ENABLED) {
      showStudentError("云端未配置，暂时只能本地玩");
      return;
    }
    const name = (els.studentName.value || "").trim().slice(0, 12);
    const pass = (els.studentPass.value || "").trim();
    if (!name) {
      showStudentError("请先填写名字");
      return;
    }
    if (!/^\d{4}$/.test(pass)) {
      showStudentError("密码要是 4 位数字");
      return;
    }
    showStudentError("");
    els.studentLoginBtn.disabled = true;
    const oldLabel = els.studentLoginBtn.textContent;
    els.studentLoginBtn.textContent = "正在连接…";
    try {
      let row = await cloudGetStudent(name);
      if (!row) {
        const profile = buildNewProfile(name, pass);
        await cloudUpsertStudent(name, pass, profile);
        row = { name, pass, save: profile };
      } else if (String(row.pass || "").trim() !== pass) {
        showStudentError("密码不对，再试一次");
        return;
      }
      const profile = profileFromCloud(row);
      state.profiles = [profile];
      state.selectedId = profile.id;
      // 学生端用独立缓存键，不碰老师电脑上的全班存档
      activeStorageKey = `${STORAGE_KEY}_cloud_${name}`;
      cloudSyncAllowed = true;
      // 已自动建档，引导从第 2 步开始，不再提示"创建角色"
      guideStartIndex = 1;
      normalizeState();
      pendingEvolution = null;
      try {
        localStorage.setItem(activeStorageKey, JSON.stringify(state));
      } catch (err) {
        console.warn("写本地缓存失败", err);
      }
      els.loginView.classList.add("hidden");
      // 学生端切换为桌面宽屏：单列外壳 + 内部"宠物侧栏 / 主区"
      const studentGrid = document.querySelector(".app-grid");
      if (studentGrid) {
        studentGrid.classList.add("is-student");
      }
      setSaveStatus("云端存档已加载");
      // 学生端只有一个角色，隐藏"角色存档/新建角色"面板
      const studentPanel = document.querySelector(".profile-panel");
      if (studentPanel) {
        studentPanel.hidden = true;
      }
      // 学生端不显示课堂计时器（这是老师控场的工具）
      const studentTimer = document.querySelector(".timer-panel");
      if (studentTimer) {
        studentTimer.style.display = "none";
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
      }
      // 学生端不显示老师后台
      const studentTeacherBox = document.querySelector(".teacher-panel");
      if (studentTeacherBox) {
        studentTeacherBox.style.display = "none";
      }
      render();
    } catch (err) {
      console.error("学生登录失败", err);
      showStudentError("连不上云端，检查网络后再试");
    } finally {
      els.studentLoginBtn.disabled = false;
      els.studentLoginBtn.textContent = oldLabel;
    }
  }

  function showStudentError(message) {
    if (!els.studentLoginError) {
      return;
    }
    els.studentLoginError.textContent = message || "";
    els.studentLoginError.hidden = !message;
  }

  // 学生端首次登录自动建档
  function buildNewProfile(name, pass) {
    const now = new Date().toISOString();
    return {
      id: `role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      pass: pass || "",
      gender: "male",
      hp: 0,
      mp: 0,
      exp: 0,
      actionPoints: 10,
      egg: { granted: true, grantedAt: now, hatched: false, hatchedAt: null },
      pet: null,
      pets: [],
      activePetIndex: 0,
      inventory: {},
      balls: {},
      bondScenes: [],
      guideCompleted: false,
      compensationEligible: false,
      compensationClaimed: false,
      createdAt: now,
    };
  }

  // 排行榜：显示所有学生，按战力或经验排序
  function showRank(type) {
    els.rankTabPower.classList.toggle("active", type === "power");
    els.rankTabExp.classList.toggle("active", type === "exp");
    els.rankModal.hidden = false;

    const profiles = state.profiles
      .filter((p) => p.pet)
      .map((p) => ({
        name: p.name,
        level: p.pet.level,
        power: getPetPower(p.pet),
        exp: p.exp,
        type: p.pet.type,
      }))
      .sort((a, b) => (type === "power" ? b.power - a.power : b.exp - a.exp));

    els.rankList.replaceChildren();
    profiles.forEach((p, index) => {
      const item = document.createElement("div");
      item.className = `rank-item${index < 3 ? ` top${index + 1}` : ""}`;

      const num = document.createElement("span");
      num.className = "rank-num";
      num.textContent = index + 1;

      const info = document.createElement("div");
      info.className = "rank-info";

      const name = document.createElement("div");
      name.className = "rank-name";
      name.textContent = p.name;

      const sub = document.createElement("div");
      sub.className = "rank-sub";
      sub.textContent = `Lv.${p.level} · ${p.type}`;

      info.append(name, sub);

      const value = document.createElement("span");
      value.className = "rank-value";
      value.textContent = type === "power" ? `战力 ${p.power}` : `经验 ${p.exp}`;

      item.append(num, info, value);
      els.rankList.appendChild(item);
    });

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rank-item";
      empty.style.justifyContent = "center";
      empty.style.color = "var(--muted)";
      empty.textContent = "暂无排行数据";
      els.rankList.appendChild(empty);
    }
  }

  function cacheElements() {
    els.loginView = document.getElementById("loginView");
    els.loginForm = document.getElementById("loginForm");
    els.teacherCode = document.getElementById("teacherCode");
    els.loginError = document.getElementById("loginError");
    els.loginTabs = document.getElementById("loginView");
    els.studentLoginForm = document.getElementById("studentLoginForm");
    els.studentName = document.getElementById("studentName");
    els.studentPass = document.getElementById("studentPass");
    els.studentLoginBtn = document.getElementById("studentLoginBtn");
    els.studentLoginError = document.getElementById("studentLoginError");
    els.pushAllToCloud = document.getElementById("pushAllToCloud");
    els.exportAllSaves = document.getElementById("exportAllSaves");
    els.exportMessage = document.getElementById("exportMessage");
    els.rankModal = document.getElementById("rankModal");
    els.rankList = document.getElementById("rankList");
    els.rankClose = document.getElementById("rankClose");
    els.rankTabPower = document.getElementById("rankTabPower");
    els.rankTabExp = document.getElementById("rankTabExp");
    els.navRank = document.getElementById("navRank");
    els.saveStatus = document.getElementById("saveStatus");
    els.createForm = document.getElementById("createForm");
    els.playerName = document.getElementById("playerName");
    els.profileList = document.getElementById("profileList");
    els.emptyState = document.getElementById("emptyState");
    els.gameView = document.getElementById("gameView");
    els.activeName = document.getElementById("activeName");
    els.activeGender = document.getElementById("activeGender");
    els.actionPoints = document.getElementById("actionPoints");
    els.petStatus = document.getElementById("petStatus");
    els.petDetail = document.getElementById("petDetail");
    els.petSmallIcon = document.getElementById("petSmallIcon");
    els.hpValue = document.getElementById("hpValue");
    els.expValue = document.getElementById("expValue");
    els.hpBar = document.getElementById("hpBar");
    els.expBar = document.getElementById("expBar");
    els.powerValue = document.getElementById("powerValue");
    els.attackValue = document.getElementById("attackValue");
    els.defenseValue = document.getElementById("defenseValue");
    els.speedValue = document.getElementById("speedValue");
    els.expHint = document.getElementById("expHint");
    els.typeInfo = document.getElementById("typeInfo");
    els.typeLabel = document.getElementById("typeLabel");
    els.typeStrong = document.getElementById("typeStrong");
    els.typeWeak = document.getElementById("typeWeak");
    els.battleModal = document.getElementById("battleModal");
    els.battleTitle = document.getElementById("battleTitle");
    els.battleStage = document.getElementById("battleStage");
    els.battleFx = document.getElementById("battleFx");
    els.battlePlayerSide = document.getElementById("battlePlayerSide");
    els.battlePlayerSprite = document.getElementById("battlePlayerSprite");
    els.battlePlayerImage = document.getElementById("battlePlayerImage");
    els.battlePlayerFallback = document.getElementById("battlePlayerFallback");
    els.battlePlayerName = document.getElementById("battlePlayerName");
    els.battlePlayerLv = document.getElementById("battlePlayerLv");
    els.battlePlayerHp = document.getElementById("battlePlayerHp");
    els.battlePlayerHpNum = document.getElementById("battlePlayerHpNum");
    els.battleEnemySide = document.getElementById("battleEnemySide");
    els.battleEnemySprite = document.getElementById("battleEnemySprite");
    els.battleEnemyImage = document.getElementById("battleEnemyImage");
    els.battleEnemyFallback = document.getElementById("battleEnemyFallback");
    els.battleEnemyName = document.getElementById("battleEnemyName");
    els.battleEnemyLv = document.getElementById("battleEnemyLv");
    els.battleEnemyHp = document.getElementById("battleEnemyHp");
    els.battleEnemyHpNum = document.getElementById("battleEnemyHpNum");
    els.battleLog = document.getElementById("battleLog");
    els.battleResult = document.getElementById("battleResult");
    els.typeTooltip = document.getElementById("typeTooltip");
    els.evolveModal = document.getElementById("evolveModal");
    els.evolveCard = document.getElementById("evolveCard");
    els.evolveSprite = document.getElementById("evolveSprite");
    els.evolveSpriteFallback = document.getElementById("evolveSpriteFallback");
    els.evolveTitle = document.getElementById("evolveTitle");
    els.evolveName = document.getElementById("evolveName");
    els.evolveClose = document.getElementById("evolveClose");
    els.evolveCaption = document.getElementById("evolveCaption");
    els.sceneGrid = document.getElementById("sceneGrid");
    els.resultMessage = document.getElementById("resultMessage");
    els.hatchPanel = document.getElementById("hatchPanel");
    els.hatchContent = document.getElementById("hatchContent");
    els.teacherLogin = document.getElementById("teacherLogin");
    els.teacherKey = document.getElementById("teacherKey");
    els.teacherControls = document.getElementById("teacherControls");
    els.teacherSelect = document.getElementById("teacherSelect");
    els.petLevelAmount = document.getElementById("petLevelAmount");
    els.boostPetLevel = document.getElementById("boostPetLevel");
    els.boostPetLevelMax = document.getElementById("boostPetLevelMax");
    els.petLevelMessage = document.getElementById("petLevelMessage");
    els.apAmount = document.getElementById("apAmount");
    els.addAp = document.getElementById("addAp");
    els.subtractAp = document.getElementById("subtractAp");
    els.teacherLogout = document.getElementById("teacherLogout");
    els.pullStudentName = document.getElementById("pullStudentName");
    els.pullStudent = document.getElementById("pullStudent");
    els.clearPulled = document.getElementById("clearPulled");
    els.addAllPulledAp = document.getElementById("addAllPulledAp");
    els.pulledList = document.getElementById("pulledList");
    els.teacherMessage = document.getElementById("teacherMessage");
    // 新视图元素
    els.worldView = document.getElementById("worldView");
    els.sceneView = document.getElementById("sceneView");
    els.shopView = document.getElementById("shopView");
    els.navWorld = document.getElementById("navWorld");
    els.navShop = document.getElementById("navShop");
    els.backToWorld = document.getElementById("backToWorld");
    els.sceneInnerTitle = document.getElementById("sceneInnerTitle");
    els.sceneAtmosphere = document.getElementById("sceneAtmosphere");
    els.sceneSpotList = document.getElementById("sceneSpotList");
    els.sceneResult = document.getElementById("sceneResult");
    els.shopTabMarket = document.getElementById("shopTabMarket");
    els.shopTabSell = document.getElementById("shopTabSell");
    els.shopTabMine = document.getElementById("shopTabMine");
    els.shopTabBalls = document.getElementById("shopTabBalls");
    els.shopContent = document.getElementById("shopContent");
    // 计时器元素
    els.timerDisplay = document.getElementById("timerDisplay");
    els.timerStartBtn = document.getElementById("timerStartBtn");
    els.timerPauseBtn = document.getElementById("timerPauseBtn");
    els.timerAddBtn = document.getElementById("timerAddBtn");
    els.timerResetBtn = document.getElementById("timerResetBtn");
    // 宠物栏元素
    els.petTeamList = document.getElementById("petTeamList");
    // 捕捉窗口元素
    els.captureModal = document.getElementById("captureModal");
    els.captureClose = document.getElementById("captureClose");
    els.capturePetImage = document.getElementById("capturePetImage");
    els.capturePetName = document.getElementById("capturePetName");
    els.capturePetLevel = document.getElementById("capturePetLevel");
    els.capturePetType = document.getElementById("capturePetType");
    els.captureBallList = document.getElementById("captureBallList");
    els.captureResult = document.getElementById("captureResult");
    // 排行榜视图元素
    els.rankView = document.getElementById("rankView");
    els.rankContent = document.getElementById("rankContent");
    // 引导系统元素
    els.guideOverlay = document.getElementById("guideOverlay");
    els.guideStep = document.getElementById("guideStep");
    els.guideTitle = document.getElementById("guideTitle");
    els.guideDesc = document.getElementById("guideDesc");
    els.guideHighlight = document.getElementById("guideHighlight");
    els.guidePrev = document.getElementById("guidePrev");
    els.guideNext = document.getElementById("guideNext");
    els.guideSkip = document.getElementById("guideSkip");
    // 老师后台新元素
    els.publishRankReward = document.getElementById("publishRankReward");
    els.rankRewardResult = document.getElementById("rankRewardResult");
    els.resetGuide = document.getElementById("resetGuide");
    // 场景背包元素
    els.sceneInventory = document.getElementById("sceneInventory");
  }

  function bindEvents() {
    els.loginForm.addEventListener("submit", handleLogin);
    if (els.studentLoginForm) {
      els.studentLoginForm.addEventListener("submit", handleStudentLogin);
    }
    // 学生 / 老师两个入口来回切
    const loginModeButtons = document.querySelectorAll("[data-login-mode]");
    loginModeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.loginMode;
        loginModeButtons.forEach((other) => {
          other.classList.toggle("is-active", other === btn);
        });
        if (els.studentLoginForm) {
          els.studentLoginForm.hidden = mode !== "student";
        }
        if (els.studentLoginError) {
          els.studentLoginError.hidden = true;
        }
        if (els.loginForm) {
          els.loginForm.hidden = mode !== "teacher";
        }
        if (els.loginError) {
          els.loginError.hidden = true;
        }
      });
    });
    els.navRank?.addEventListener("click", () => showRank("power"));
    els.rankClose?.addEventListener("click", () => { els.rankModal.hidden = true; });
    els.rankTabPower?.addEventListener("click", () => showRank("power"));
    els.rankTabExp?.addEventListener("click", () => showRank("exp"));
    els.rankModal?.addEventListener("click", (e) => {
      if (e.target === els.rankModal) els.rankModal.hidden = true;
    });
    els.createForm.addEventListener("submit", handleCreateProfile);
    els.profileList.addEventListener("click", handleProfileSelect);
    els.sceneGrid.addEventListener("click", handleSceneSelect);
    els.hatchContent.addEventListener("click", handleHatchClick);
    els.teacherLogin.addEventListener("submit", handleTeacherLogin);
    els.addAp.addEventListener("click", () => adjustActionPoints(1));
    els.subtractAp.addEventListener("click", () => adjustActionPoints(-1));
    els.teacherLogout.addEventListener("click", handleTeacherLogout);
    if (els.pushAllToCloud) {
      els.pushAllToCloud.addEventListener("click", pushAllSavesToCloud);
    }
    if (els.exportAllSaves) {
      els.exportAllSaves.addEventListener("click", exportAllSaves);
    }
    els.pullStudent.addEventListener("click", handlePullStudent);
    els.clearPulled.addEventListener("click", () => {
      pulledProfileIds = [];
      renderPulledList();
      render();
    });
    els.addAllPulledAp?.addEventListener("click", handleAddAllPulledAp);
    els.boostPetLevel?.addEventListener("click", () => {
      const profile = getTeacherSelectedProfile();
      if (!profile?.pet) {
        setTeacherMessage("请选择一个已孵化宠物的学生角色。", true);
        return;
      }
      const delta = Number.parseInt(els.petLevelAmount?.value, 10);
      if (!Number.isInteger(delta) || delta < 1) {
        setTeacherMessage("提升等级数必须是正整数。", true);
        return;
      }
      boostPetLevel(profile, profile.pet.level + delta);
    });
    els.boostPetLevelMax?.addEventListener("click", () => {
      const profile = getTeacherSelectedProfile();
      if (!profile?.pet) {
        setTeacherMessage("请选择一个已孵化宠物的学生角色。", true);
        return;
      }
      const match = findPetMatch(profile.pet);
      const stageCount = match?.template?.stages?.length || 1;
      const topLevel = stageCount >= 2 ? PET_EVOLUTION_LEVELS[stageCount] || 54 : 54;
      boostPetLevel(profile, Math.max(profile.pet.level, topLevel));
    });
    // 视图切换
    els.navWorld.addEventListener("click", () => switchView("world"));
    els.navShop.addEventListener("click", () => switchView("shop"));
    els.backToWorld.addEventListener("click", () => switchView("world"));
    // 场景内部探索
    els.sceneSpotList.addEventListener("click", handleSpotExplore);
    // 商店标签
    els.shopTabMarket.addEventListener("click", () => renderShop("market"));
    els.shopTabSell.addEventListener("click", () => renderShop("sell"));
    els.shopTabMine.addEventListener("click", () => renderShop("mine"));
    els.shopTabBalls?.addEventListener("click", () => renderShop("balls"));
    // 商店操作（事件委托）
    els.shopContent.addEventListener("click", handleShopAction);
    // 计时器事件
    els.timerStartBtn?.addEventListener("click", startTimer);
    els.timerPauseBtn?.addEventListener("click", pauseTimer);
    els.timerAddBtn?.addEventListener("click", addTimerTime);
    els.timerResetBtn?.addEventListener("click", resetTimer);
    // 宠物栏事件（事件委托）
    els.petTeamList?.addEventListener("click", handlePetTeamClick);
    // 捕捉窗口事件
    els.captureClose?.addEventListener("click", closeCaptureModal);
    els.captureBallList?.addEventListener("click", handleCaptureBallClick);
    els.captureModal?.addEventListener("click", (e) => {
      if (e.target === els.captureModal) closeCaptureModal();
    });
    // 排行榜视图切换
    els.navRank?.addEventListener("click", () => switchView("rank"));
    // 引导系统事件
    els.guidePrev?.addEventListener("click", prevGuideStep);
    els.guideNext?.addEventListener("click", nextGuideStep);
    els.guideSkip?.addEventListener("click", skipGuide);
    // 老师后台新事件
    els.publishRankReward?.addEventListener("click", publishRankReward);
    els.resetGuide?.addEventListener("click", handleResetGuide);
  }

  function loadState() {
    const fallback = { version: 1, selectedId: null, profiles: [], updatedAt: null };
    try {
      const raw = localStorage.getItem(activeStorageKey);
      if (!raw) {
        return fallback;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.profiles)) {
        return fallback;
      }
      return {
        version: 1,
        selectedId: typeof parsed.selectedId === "string" ? parsed.selectedId : null,
        profiles: parsed.profiles.map(normalizeProfile),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } catch (error) {
      console.warn("读取本地存档失败", error);
      return fallback;
    }
  }

  function normalizeState() {
    let changed = false;
    state.profiles = state.profiles.map((profile) => {
      const normalized = normalizeProfile(profile);
      const previousPet = profile?.pet || null;
      if (Boolean(previousPet) !== Boolean(normalized.pet)) {
        changed = true;
      }
      if (
        previousPet &&
        normalized.pet &&
        (previousPet.level !== normalized.pet.level ||
          previousPet.hpMax !== normalized.pet.hpMax ||
          previousPet.stage !== normalized.pet.stage ||
          previousPet.petId !== normalized.pet.petId ||
          previousPet.name !== normalized.pet.name ||
          previousPet.image !== normalized.pet.image ||
          previousPet.bond !== normalized.pet.bond ||
          previousPet.nickname !== normalized.pet.nickname)
      ) {
        changed = true;
      }
      // 背包或亲密度场景记录变化时也需要存档
      if (
        JSON.stringify(profile?.inventory || {}) !== JSON.stringify(normalized.inventory) ||
        JSON.stringify(profile?.bondScenes || []) !== JSON.stringify(normalized.bondScenes)
      ) {
        changed = true;
      }
      if (!normalized.egg.granted && !normalized.pet && meetsEggThreshold(normalized)) {
        normalized.egg.granted = true;
        normalized.egg.grantedAt = new Date().toISOString();
        changed = true;
      }
      // 亲密度改为手动提升，移除自动触发逻辑
      return normalized;
    });

    if (!state.profiles.some((profile) => profile.id === state.selectedId)) {
      state.selectedId = state.profiles[0]?.id ?? null;
      changed = true;
    }
    return changed;
  }

  function normalizeInventory(inventory) {
    if (!inventory || typeof inventory !== "object") {
      return {};
    }
    const result = {};
    for (const [key, value] of Object.entries(inventory)) {
      const count = clampInteger(value, 0, Number.MAX_SAFE_INTEGER);
      if (count > 0 && typeof key === "string" && key) {
        result[key] = count;
      }
    }
    return result;
  }

  function normalizeProfile(profile) {
    const egg = profile?.egg && typeof profile.egg === "object" ? profile.egg : {};
    const pet = normalizePet(profile?.pet) || normalizeLegacyImagePet(profile);
    const hasLegacyPet = Boolean(profile?.pet || profile?.petName);

    return {
      id:
        typeof profile?.id === "string" && profile.id
          ? profile.id
          : `role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: sanitizeName(profile?.name || "未命名角色"),
      pass: typeof profile?.pass === "string" ? profile.pass : "",
      gender: profile?.gender === "female" ? "female" : "male",
      hp: clampInteger(profile?.hp, 0, Number.MAX_SAFE_INTEGER),
      mp: clampInteger(profile?.mp, 0, Number.MAX_SAFE_INTEGER),
      exp: clampInteger(profile?.exp, 0, Number.MAX_SAFE_INTEGER),
      actionPoints: clampInteger(profile?.actionPoints, 0, Number.MAX_SAFE_INTEGER),
      egg: {
        granted: Boolean(egg.granted || pet),
        grantedAt: typeof egg.grantedAt === "string" ? egg.grantedAt : null,
        hatched: Boolean(egg.hatched || pet),
        hatchedAt: typeof egg.hatchedAt === "string" ? egg.hatchedAt : null,
      },
      pet,
      // 道具背包：{ itemId: 数量 }，允许重复堆叠
      inventory: normalizeInventory(profile?.inventory),
      // 已触发亲密度升级的场景 id 列表（每场景每宠物仅一次）
      bondScenes: Array.isArray(profile?.bondScenes) ? profile.bondScenes.filter((s) => typeof s === "string") : [],
      // 只给本次补偿上线前已经孵化宠物的旧角色开放补偿。
      compensationEligible:
        typeof profile?.compensationEligible === "boolean"
          ? profile.compensationEligible
          : hasLegacyPet,
      compensationClaimed: Boolean(profile?.compensationClaimed),
      createdAt:
        typeof profile?.createdAt === "string" ? profile.createdAt : new Date().toISOString(),
      // 多宠物系统：所有宠物列表
      pets: Array.isArray(profile?.pets) ? profile.pets.map(normalizePet).filter(Boolean) : (pet ? [pet] : []),
      activePetIndex: clampInteger(profile?.activePetIndex, 0, 2),
      // 咕噜球库存：{ ballId: 数量 }
      balls: normalizeInventory(profile?.balls),
      // 新手引导是否完成
      guideCompleted: Boolean(profile?.guideCompleted),
    };
  }

  function normalizePet(pet) {
    if (!pet || typeof pet !== "object" || typeof pet.name !== "string") {
      return null;
    }
    const match = findPetMatch(pet);
    const petTemplate = match?.template || null;
    const stageCount = petTemplate?.stages?.length || 1;
    const requestedStage = match
      ? match.stageIndex + 1
      : clampInteger(pet.stage, 1, stageCount);
    const level = clampInteger(pet.level, 1, Number.MAX_SAFE_INTEGER);
    const matchedStage = Math.min(
      requestedStage,
      getMaxEvolutionStage(level, stageCount),
    );
    const stageData = petTemplate?.stages?.[matchedStage - 1] || null;
    return {
      petId: petTemplate?.petId || sanitizeName(pet.petId || ""),
      stage: matchedStage,
      name: sanitizeName(stageData?.name || pet.name),
      image: stageData?.image || (typeof pet.image === "string" ? pet.image : null),
      desc: sanitizeName(stageData?.desc || pet.desc || ""),
      type: sanitizeName(stageData?.type || pet.type || "未标注"),
      style: sanitizeName(stageData?.style || pet.style || "初始宠物"),
      mark: sanitizeName(stageData?.mark || pet.mark || pet.name.slice(0, 1) || "宠"),
      level,
      hpMax: clampInteger(pet.hpMax, PET_BASE_HP_MAX, Number.MAX_SAFE_INTEGER),
      mpMax: clampInteger(pet.mpMax, PET_BASE_MP_MAX, Number.MAX_SAFE_INTEGER),
      isShiny: !!pet.isShiny || (petTemplate?.petId || "").startsWith("shiny-"),
      hatchedAt: typeof pet.hatchedAt === "string" ? pet.hatchedAt : new Date().toISOString(),
      // 亲密度等级：集齐场景道具后 +1，最高 10
      bond: clampInteger(pet.bond, 0, 10),
      // 已触发亲密度升级的场景 id 列表（每只宠物独立，每场景每宠物仅一次）
      bondScenes: Array.isArray(pet.bondScenes) ? pet.bondScenes.filter(s => typeof s === "string") : [],
      // 宠物昵称：亲密度 ≥3 后可设置，显示在原名之后
      nickname: typeof pet.nickname === "string" ? pet.nickname : "",
    };
  }

  function normalizeLegacyImagePet(profile) {
    const petName = sanitizeName(profile?.petName);
    if (!petName) {
      return null;
    }
    const gender = profile?.gender === "female" ? "female" : "male";
    const match = findPetMatch({ name: petName });
    const petTemplate = match?.template || null;
    if (petTemplate) {
      return createStoredPet(
        petTemplate,
        new Date().toISOString(),
        null,
        1,
      );
    }
    return {
      petId: petTemplate?.petId || "",
      stage: 1,
      name: petTemplate?.name || petName,
      image: petTemplate?.image || null,
      desc: petTemplate?.desc || "",
      type: petTemplate?.type || "未标注",
      style: petTemplate?.style || (gender === "female" ? "可爱系" : "帅气系"),
      mark: petTemplate?.mark || petName.slice(0, 1) || "宠",
      level: 1,
      hpMax: PET_BASE_HP_MAX,
      mpMax: PET_BASE_MP_MAX,
      hatchedAt:
      typeof profile?.egg?.hatchedAt === "string" ? profile.egg.hatchedAt : new Date().toISOString(),
    };
  }

  function findPetTemplate(pet) {
    return findPetMatch(pet)?.template || null;
  }

  function findPetMatch(pet) {
    if (!pet || PET_DATABASE.length === 0) {
      return null;
    }
    for (const template of PET_DATABASE) {
      if (template.petId === pet.petId) {
        const stageIndex = Number.isInteger(pet.stage)
          ? Math.max(0, Math.min(template.stages.length - 1, pet.stage - 1))
          : Math.max(
              0,
              template.stages.findIndex((stage) => stage.name === pet.name),
            );
        return { template, stageIndex };
      }
      const stageIndex = template.stages.findIndex((stage) => stage.name === pet.name);
      if (stageIndex >= 0) {
        return { template, stageIndex };
      }
    }
    return null;
  }

  function saveState(message) {
    state.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(activeStorageKey, JSON.stringify(state));
      setSaveStatus(message);
    } catch (error) {
      console.error("写入本地存档失败", error);
      setSaveStatus("存档失败");
    }
    // 云端模式：本地存完顺手把当前角色推到 Supabase（2 秒内多次改动只发一次）
    const current = state.profiles.find((profile) => profile.id === state.selectedId);
    if (current && current.name) {
      scheduleCloudSync(current);
    }
  }

  function setSaveStatus(message) {
    const time = new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    els.saveStatus.textContent = `${message || "已保存"} ${time}`;
  }

  // ===== 市场数据读写 =====
  function loadMarket() {
    try {
      const raw = localStorage.getItem(MARKET_STORAGE_KEY);
      if (!raw) return { listings: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.listings)) return { listings: [] };
      return { listings: parsed.listings.filter((l) => l && typeof l.itemId === "string") };
    } catch (error) {
      console.warn("读取市场数据失败", error);
      return { listings: [] };
    }
  }

  function saveMarket(message) {
    try {
      localStorage.setItem(MARKET_STORAGE_KEY, JSON.stringify(marketState));
      if (message) setSaveStatus(message);
    } catch (error) {
      console.error("写入市场数据失败", error);
    }
  }

  function rowToListing(row) {
    return {
      id: row.id,
      sellerId: row.seller_id,
      sellerName: row.seller_name,
      itemId: row.item_id,
      itemName: row.item_name,
      price: row.price,
      listedAt: row.listed_at,
    };
  }

  // 市场存在云端：全班共用一个市场，谁上架谁都能看见、都能买
  async function loadMarketFromCloud() {
    if (!CLOUD_ENABLED) return marketState;
    try {
      const rows = await cloudRequest(`${MARKET_TABLE}?select=*&order=listed_at.desc`);
      marketState.listings = Array.isArray(rows) ? rows.map(rowToListing) : [];
      saveMarket();
    } catch (error) {
      console.warn("读取云端市场失败（先用本地缓存）", error);
    }
    return marketState;
  }

  function getItemDef(itemId) {
    for (const sceneId of Object.keys(SCENE_ITEMS)) {
      const found = SCENE_ITEMS[sceneId].find((item) => item.id === itemId);
      if (found) return { ...found, sceneId };
    }
    return null;
  }

  function getItemPrice(itemId) {
    return ITEM_PRICES[itemId] || 50;
  }

  // 上架道具（写入云端共享市场，全班可见）
  async function listItem(itemId) {
    const profile = getActiveProfile();
    if (!profile) return { ok: false, msg: "请先选择角色。" };
    const count = profile.inventory[itemId] || 0;
    if (count < 1) return { ok: false, msg: "背包中没有该道具。" };
    const itemDef = getItemDef(itemId);
    if (!itemDef) return { ok: false, msg: "道具不存在。" };
    const price = getItemPrice(itemId);
    const listing = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sellerId: profile.id,
      sellerName: profile.name,
      itemId,
      itemName: itemDef.name,
      price,
      listedAt: new Date().toISOString(),
    };
    if (CLOUD_ENABLED) {
      try {
        await cloudRequest(MARKET_TABLE, {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            id: listing.id,
            seller_id: listing.sellerId,
            seller_name: listing.sellerName,
            item_id: listing.itemId,
            item_name: listing.itemName,
            price: listing.price,
          }),
        });
      } catch (error) {
        console.error("上架到云端市场失败", error);
        return { ok: false, msg: "上架失败，请检查网络后重试。" };
      }
    }
    profile.inventory[itemId] = count - 1;
    if (profile.inventory[itemId] <= 0) delete profile.inventory[itemId];
    marketState.listings.push(listing);
    saveMarket();
    saveState("已上架");
    return { ok: true, msg: `已上架【${itemDef.name}】，售价 ${price} 经验。` };
  }

  // 下架道具（同时从云端市场撤下）
  async function unlistItem(listingId) {
    const profile = getActiveProfile();
    if (!profile) return { ok: false, msg: "请先选择角色。" };
    const idx = marketState.listings.findIndex((l) => l.id === listingId);
    if (idx < 0) return { ok: false, msg: "该上架不存在。" };
    const listing = marketState.listings[idx];
    if (listing.sellerId !== profile.id) return { ok: false, msg: "只能下架自己的道具。" };
    if (CLOUD_ENABLED) {
      try {
        await cloudRequest(
          `${MARKET_TABLE}?id=eq.${encodeURIComponent(listingId)}&seller_id=eq.${encodeURIComponent(
            profile.id
          )}`,
          { method: "DELETE", headers: { Prefer: "return=minimal" } }
        );
      } catch (error) {
        console.error("下架失败", error);
        return { ok: false, msg: "下架失败，请检查网络后重试。" };
      }
    }
    profile.inventory[listing.itemId] = (profile.inventory[listing.itemId] || 0) + 1;
    marketState.listings.splice(idx, 1);
    saveMarket();
    saveState("已下架");
    return { ok: true, msg: `已下架【${listing.itemName}】，已退回背包。` };
  }

  // 给卖家加经验（卖家云端的存档一起更新）
  async function addExpToSeller(sellerName, amount) {
    if (!sellerName || !amount) return;
    try {
      const row = await cloudGetStudent(sellerName);
      if (!row || !row.save) return;
      const save = Object.assign({}, row.save);
      save.exp = (save.exp || 0) + amount;
      await cloudUpsertStudent(row.name, row.pass, save);
    } catch (error) {
      console.warn("给卖家结算经验失败", error);
    }
  }

  // 购买道具（云端共享市场，买家卖家都能实时同步）
  async function buyItem(listingId) {
    const profile = getActiveProfile();
    if (!profile) return { ok: false, msg: "请先选择角色。" };
    const listing = marketState.listings.find((l) => l.id === listingId);
    if (!listing) return { ok: false, msg: "该道具已被买走或下架。" };
    if (listing.sellerId === profile.id) return { ok: false, msg: "不能购买自己上架的道具。" };
    if (profile.exp < listing.price) return { ok: false, msg: `经验不足，需要 ${listing.price} 经验。` };

    // 先抢下云端这条商品，避免两个同学同时买同一件
    if (CLOUD_ENABLED) {
      let removed = null;
      try {
        removed = await cloudRequest(
          `${MARKET_TABLE}?id=eq.${encodeURIComponent(listingId)}`,
          { method: "DELETE", headers: { Prefer: "return=representation" } }
        );
      } catch (error) {
        console.error("购买失败", error);
        return { ok: false, msg: "购买失败，请检查网络后重试。" };
      }
      if (!Array.isArray(removed) || removed.length === 0) {
        marketState.listings = marketState.listings.filter((l) => l.id !== listingId);
        saveMarket();
        return { ok: false, msg: "手慢了，这件道具已经被别人买走。" };
      }
    }

    profile.exp -= listing.price;
    profile.inventory[listing.itemId] = (profile.inventory[listing.itemId] || 0) + 1;
    const sellerReceive = Math.floor(listing.price * (1 - MARKET_FEE_RATE));
    await addExpToSeller(listing.sellerName, sellerReceive);
    marketState.listings = marketState.listings.filter((l) => l.id !== listingId);
    saveMarket();
    saveState("购买已存档");
    return {
      ok: true,
      msg: `购买成功！获得【${listing.itemName}】，花费 ${listing.price} 经验。卖家 ${listing.sellerName} 获得 ${sellerReceive} 经验（扣${Math.round(MARKET_FEE_RATE * 100)}%手续费）。`,
    };
  }

  function handleCreateProfile(event) {
    event.preventDefault();
    const formData = new FormData(els.createForm);
    const name = sanitizeName(formData.get("playerName"));
    if (!name) {
      return;
    }
    const gender = formData.get("gender") === "female" ? "female" : "male";
    const now = new Date().toISOString();
    const profile = {
      id: `role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      gender,
      hp: 0,
      mp: 0,
      exp: 0,
      actionPoints: 10,
      egg: { granted: true, grantedAt: now, hatched: false, hatchedAt: null },
      pet: null,
      pets: [],
      activePetIndex: 0,
      inventory: {},
      balls: {},
      bondScenes: [],
      guideCompleted: false,
      compensationEligible: false,
      compensationClaimed: false,
      createdAt: now,
    };
    state.profiles.unshift(profile);
    state.selectedId = profile.id;
    selectedSceneId = "grassland";
    resultMessage = "角色已创建！获得10点初始行动点和1个宠物蛋，快去孵化吧！";
    resultIsWarning = false;
    els.createForm.reset();
    saveState("角色已存档");
    render();
  }

  function handleProfileSelect(event) {
    const deleteButton = event.target.closest("[data-delete-profile-id]");
    if (deleteButton) {
      handleProfileDelete(deleteButton.dataset.deleteProfileId);
      return;
    }

    const button = event.target.closest("[data-profile-id]");
    if (!button) {
      return;
    }
    state.selectedId = button.dataset.profileId;
    selectedSceneId = getScene(selectedSceneId)?.unlocked ? selectedSceneId : "grassland";
    resultMessage = "";
    resultIsWarning = false;
    saveState("角色已切换");
    render();
  }

  function handleProfileDelete(profileId) {
    const profile = state.profiles.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }

    const confirmed = window.confirm(`确定删除角色「${profile.name}」吗？删除后无法恢复。`);
    if (!confirmed) {
      return;
    }

    state.profiles = state.profiles.filter((item) => item.id !== profileId);
    if (state.selectedId === profileId) {
      state.selectedId = state.profiles[0]?.id ?? null;
      selectedSceneId = "grassland";
      resultMessage = "";
      resultIsWarning = false;
    }
    saveState("角色已删除");
    setTeacherMessage("角色存档已删除。", false);
    render();
  }

  function handleSceneSelect(event) {
    const button = event.target.closest("[data-scene-id]");
    if (!button || button.disabled) {
      return;
    }
    const scene = getScene(button.dataset.sceneId);
    const profile = getActiveProfile();
    if (!scene || !isSceneUnlocked(scene, profile)) {
      return;
    }
    selectedSceneId = scene.id;
    selectedSpotId = null;
    switchView("scene");
  }

  function switchView(view) {
    currentView = view;
    if (view === "world") {
      selectedSpotId = null;
    }
    render();
  }

  function handleExplore(spot) {
    if (isExploring) return;
    const changed = normalizeState();
    const profile = getActiveProfile();
    const scene = getScene(selectedSceneId);
    if (!profile || !scene || !isSceneUnlocked(scene, profile)) {
      if (changed) saveState("存档已刷新");
      setSceneResult("该场景未解锁，无法探索。", true);
      render();
      return;
    }
    // 探索不再消耗行动点：孩子可自由探索，行动点只用于消费（孵化、换宠、咕噜球、计时加速）
    isExploring = true;
    const spotName = spot ? spot.name : "探索";
    const spots = SCENE_SPOTS[scene.id] || [];
    const spotIndex = spot ? spots.findIndex((s) => s.id === spot.id) : -1;
    setSceneResult(`正在${spotName}探索中…`, false, true);

    setTimeout(() => {
      const outcome = rollSceneDrop(scene, spot?.exp);

      // 判定是否遇敌
      const wildConfig = WILD_PETS[scene.id];
      const encounter = wildConfig && profile.pet && Math.random() < wildConfig.encounterRate;
      let battleWin = true;
      let lostItem = null;

      if (encounter) {
        const wildPet = generateWildPet(scene.id);
        if (wildPet) {
          // 智能提示：遇到野生宠物
          checkSmartTips(profile, { encounterWild: true, battleStart: true });

          const battle = simulateBattle(profile.pet, wildPet);
          battleWin = battle.win;
          showBattleModal(profile.pet, wildPet, battle);

          if (battleWin) {
            // 胜利：全额经验 + 额外奖励
            profile.exp += outcome.exp;
            const bonusExp = Math.floor(outcome.exp * 0.5);
            profile.exp += bonusExp;
            // 15%概率弹出捕捉窗口（等战斗演出播完再弹，避免两个弹窗叠加）
            if (Math.random() < 0.15 && profile.pets.length < 3) {
              setTimeout(() => {
                showCaptureModal(wildPet);
              }, 3400);
            }
          } else {
            // 失败：50%概率扣除一个道具，有道具则给50%经验，没道具给15%经验
            const ownedItems = Object.entries(profile.inventory).filter(([, count]) => count > 0);
            const willLoseItem = ownedItems.length > 0 && Math.random() < 0.5;
            if (willLoseItem) {
              const [lostId] = ownedItems[Math.floor(Math.random() * ownedItems.length)];
              profile.inventory[lostId] -= 1;
              const lostDef = getItemDef(lostId);
              lostItem = lostDef?.name || lostId;
              profile.exp += Math.floor(outcome.exp * 0.5);
            } else if (ownedItems.length > 0) {
              profile.exp += Math.floor(outcome.exp * 0.5);
            } else {
              profile.exp += Math.floor(outcome.exp * 0.15);
            }
          }
        } else {
          profile.exp += outcome.exp;
        }
      } else {
        profile.exp += outcome.exp;
      }

      const eggGranted = grantEggIfEligible(profile);
      const earnedExp = encounter && !battleWin
        ? (lostItem ? Math.floor(outcome.exp * 0.5) : (Object.keys(profile.inventory).length > 0 ? Math.floor(outcome.exp * 0.5) : Math.floor(outcome.exp * 0.15)))
        : outcome.exp;
      const parts = [`${scene.name}·${spotName}：经验 +${earnedExp}。`];
      if (eggGranted) parts.push("首次达标，已自动发放【随机初始宠物蛋】。");

      // 道具掉落：战败不获得
      let droppedItem = null;
      if (!encounter || battleWin) {
        droppedItem = rollSceneItem(scene, spot);
        if (droppedItem) {
          profile.inventory[droppedItem.id] = (profile.inventory[droppedItem.id] || 0) + 1;
          parts.push(`获得道具【${droppedItem.name}】！`);
          // 智能提示：道具集齐或快集齐了
          checkSmartTips(profile, { sceneId: scene.id });
        }
      }

      // 战败：被抢走道具
      if (encounter && !battleWin && lostItem) {
        parts.push(`💔 被抢走了道具【${lostItem}】！`);
      } else if (encounter && !battleWin && !lostItem) {
        parts.push(`💔 战斗失败，本次经验收益降低。`);
      }

      // 亲密度改为手动提升（宠物栏中点击按钮），这里只检查是否集齐并提示
      const items = SCENE_ITEMS[scene.id] || [];
      const allCollected = items.every((item) => (profile.inventory[item.id] || 0) >= 1);
      const bondDone = profile.pet?.bondScenes?.includes(scene.id);
      if (allCollected && !bondDone) {
        parts.push(`✨ ${scene.name}道具已集齐！可以在宠物栏点击「提升亲密度」按钮。`);
      }

      // 自动升级：经验足够时自动升级，最多一次
      let autoUpgraded = false;
      let evolInfo = null;
      if (profile.pet) {
        const cost = getUpgradeCost(profile.pet.level);
        if (profile.exp >= cost) {
          profile.exp -= cost;
          profile.pet.level += 1;
          profile.pet.hpMax += PET_UPGRADE_HP_GAIN;
          autoUpgraded = true;
          parts.push(`宠物自动升至 Lv.${profile.pet.level}！`);
          // 自动进化检查
          const evolved = tryAutoEvolve(profile);
          if (evolved) {
            parts.push(`自动进化为【${profile.pet.name}】！`);
            if (typeof evolved === "object") evolInfo = evolved;
          }
        }
      }

      if (encounter && battleWin) {
        parts.push(`战斗胜利！额外经验 +${Math.floor(outcome.exp * 0.5)}。`);
      }

      setSceneResult(parts.join(" "), false, false, droppedItem, false);
      saveState("探索已存档");
      isExploring = false;
      render();
      if (autoUpgraded && !evolInfo) {
        flashPetCard(profile.activePetIndex, "is-levelup");
      }
      if (evolInfo) {
        // 若同一次探索触发了战斗演出，等战斗弹窗关闭后再播进化，避免两个弹窗叠在一起
        const delayMs = Math.max(420, battleCloseAt - Date.now() + 180);
        setTimeout(() => showEvolutionModal(evolInfo), delayMs);
      }
    }, 800);
  }

  function handleSpotExplore(event) {
    const button = event.target.closest("[data-spot-id]");
    if (!button || button.disabled || isExploring) return;
    const scene = getScene(selectedSceneId);
    const spots = SCENE_SPOTS[scene?.id] || [];
    const spot = spots.find((s) => s.id === button.dataset.spotId);
    if (!spot) return;
    selectedSpotId = spot.id;
    handleExplore(spot);
  }

  function setSceneResult(message, warning, exploring, droppedItem, bondUp) {
    if (!els.sceneResult) return;
    els.sceneResult.textContent = message;
    els.sceneResult.className = `result-message${warning ? " warning" : ""}${exploring ? " exploring" : ""}`;
    // 道具获得动画
    if (droppedItem) {
      els.sceneResult.classList.add("has-item-drop");
      els.sceneResult.dataset.itemIcon = droppedItem.icon;
      els.sceneResult.dataset.itemName = droppedItem.name;
    } else {
      els.sceneResult.classList.remove("has-item-drop");
    }
    // 亲密度升级动画
    if (bondUp) {
      els.sceneResult.classList.add("has-bond-up");
    } else {
      els.sceneResult.classList.remove("has-bond-up");
    }
  }

  function handleHatchClick(event) {
    const compensationButton = event.target.closest("#compensationButton");
    if (compensationButton) {
      handleCompensationClaim();
      return;
    }

    const evolveButton = event.target.closest("#evolvePetButton");
    if (evolveButton) {
      handlePetEvolution();
      return;
    }

    const upgradeButton = event.target.closest("#upgradePetButton");
    if (upgradeButton) {
      handlePetUpgrade();
      return;
    }

    const renameButton = event.target.closest("#renamePetButton");
    if (renameButton) {
      handleRenamePet();
      return;
    }

    const randomButton = event.target.closest("#randomPetButton");
    if (randomButton) {
      handleRandomPet();
      return;
    }

    const button = event.target.closest("#hatchButton");
    if (!button) {
      return;
    }
    const profile = getActiveProfile();
    if (!profile || !profile.egg.granted || profile.egg.hatched || profile.pet) {
      return;
    }
    const petTemplate = randomItem(PET_POOL);
    const now = new Date().toISOString();
    profile.pet = createStoredPet(petTemplate, now);
    // 确保pets数组包含该宠物
    if (!Array.isArray(profile.pets)) {
      profile.pets = [];
    }
    if (!profile.pets.some(p => p.petId === profile.pet.petId && p.hatchedAt === profile.pet.hatchedAt)) {
      profile.pets.push(profile.pet);
    }
    profile.activePetIndex = 0;
    profile.egg.hatched = true;
    profile.egg.hatchedAt = now;

    // 亲密度改为手动提升，移除自动触发逻辑
    let hatchMsg = `孵化完成：${profile.pet.name}（${profile.pet.style}）。可继续消耗经验升级宠物。集齐场景道具后可在宠物栏手动提升亲密度。`;
    setResult(hatchMsg, false);
    saveState("孵化已存档");
    render();
  }

  function handleCompensationClaim() {
    const profile = getActiveProfile();
    if (!profile?.pet || !profile.compensationEligible || profile.compensationClaimed) {
      return;
    }

    const petTemplate = randomItem(PET_POOL);
    const previousPet = profile.pet;
    profile.pet = createStoredPet(petTemplate, new Date().toISOString(), previousPet, 1);
    profile.actionPoints += COMPENSATION_ACTION_POINTS;
    profile.compensationClaimed = true;
    setResult(
      `补偿已领取：宠物已随机更换为 ${profile.pet.name}（${profile.pet.type}），行动点 +${COMPENSATION_ACTION_POINTS}。`,
      false,
    );
    saveState("补偿已存档");
    render();
  }

  function handlePetEvolution() {
    const profile = getActiveProfile();
    const match = findPetMatch(profile?.pet);
    const currentStage = profile?.pet?.stage || 1;
    const nextStage = match?.template?.stages?.[currentStage];
    const requiredLevel = getEvolutionLevel(nextStage?.stage, nextStage);
    if (!profile?.pet || !match || !nextStage) {
      return;
    }

    if (profile.pet.level < requiredLevel) {
      setResult(`等级不足，进化为${nextStage.name}需要达到 Lv.${requiredLevel}。`, true);
      render();
      return;
    }

    profile.pet = createStoredPet(
      match.template,
      new Date().toISOString(),
      profile.pet,
      nextStage.stage,
    );
    setResult(
      `${profile.pet.name}进化完成，当前为第 ${profile.pet.stage} 阶段。`,
      false,
    );
    saveState("宠物进化已存档");
    render();
  }

  function handlePetUpgrade() {
    const profile = getActiveProfile();
    if (!profile?.pet) {
      return;
    }
    const cost = getUpgradeCost(profile.pet.level);
    if (profile.exp < cost) {
      setResult(`经验不足，宠物升级需要 ${cost} 经验。`, true);
      render();
      return;
    }

    profile.exp -= cost;
    const oldAttack = getPetAttack(profile.pet);
    const oldDefense = getPetDefense(profile.pet);
    const oldSpeed = getPetSpeed(profile.pet);
    profile.pet.level += 1;
    profile.pet.hpMax += PET_UPGRADE_HP_GAIN;
    const atkGain = getPetAttack(profile.pet) - oldAttack;
    const defGain = getPetDefense(profile.pet) - oldDefense;
    const spdGain = getPetSpeed(profile.pet) - oldSpeed;

    let msg = `${profile.pet.name} 升至 Lv.${profile.pet.level}：生命 +${PET_UPGRADE_HP_GAIN}，攻击 +${atkGain}，防御 +${defGain}，速度 +${spdGain}。`;

    // 自动进化：升级后检查是否达到进化等级
    const evolved = tryAutoEvolve(profile);
    let evolInfo = null;
    if (evolved) {
      msg += ` 自动进化为【${profile.pet.name}】！`;
      if (typeof evolved === "object") evolInfo = evolved;
    }

    setResult(msg, false);
    saveState("宠物升级已存档");
    render();
    if (!evolInfo) {
      flashPetCard(profile.activePetIndex, "is-levelup");
    } else {
      setTimeout(() => showEvolutionModal(evolInfo), 300);
    }
  }

  // 自动进化检查
  // 最近一次自动进化的前后形态，用于播放进化演出
  let pendingEvolution = null;

  function takePendingEvolution() {
    const info = pendingEvolution;
    pendingEvolution = null;
    return info;
  }

  function tryAutoEvolve(profile) {
    if (!profile?.pet) return false;
    const evolved = autoEvolvePet(profile.pet);
    if (!evolved) return false;
    // 同步到pets数组
    if (profile.pets && profile.activePetIndex !== undefined) {
      profile.pets[profile.activePetIndex] = profile.pet;
    }
    // 返回进化信息（对象为真值，兼容原有 if (evolved) 判断）
    return takePendingEvolution() || true;
  }

  // 检查单个宠物是否需要自动进化（原地修改）
  function autoEvolvePet(pet) {
    if (!pet) return false;
    const match = findPetMatch(pet);
    if (!match) return false;
    let evolved = false;
    // 循环检查，可能需要多次进化（比如从1阶直接升到3阶）
    while (true) {
      const currentStage = pet.stage || 1;
      const nextStage = match.template?.stages?.[currentStage];
      if (!nextStage) break;
      const requiredLevel = getEvolutionLevel(nextStage.stage, nextStage);
      if (pet.level < requiredLevel) break;
      // 执行进化
      const oldPet = { ...pet };
      const newPet = createStoredPet(
        match.template,
        oldPet.hatchedAt || new Date().toISOString(),
        oldPet,
        nextStage.stage,
      );
      // 复制新宠物的属性到原对象
      Object.assign(pet, newPet);
      evolved = true;
      pendingEvolution = {
        from: {
          name: oldPet.nickname || oldPet.name,
          image: oldPet.image || "",
          stage: oldPet.stage || 1,
          level: oldPet.level,
        },
        to: {
          name: pet.nickname || pet.name,
          image: pet.image || "",
          stage: pet.stage || 1,
          level: pet.level,
        },
      };
    }
    return evolved;
  }

  // 修改宠物昵称：亲密度 ≥3 级永久解锁，可随时修改
  function handleRenamePet() {
    const profile = getActiveProfile();
    if (!profile?.pet) {
      return;
    }
    if ((profile.pet.bond || 0) < BOND_NAME_UNLOCK_LEVEL) {
      setResult(`亲密度不足，修改昵称需要达到 Lv.${BOND_NAME_UNLOCK_LEVEL}。`, true);
      render();
      return;
    }
    const current = profile.pet.nickname || "";
    const input = window.prompt(
      `为【${profile.pet.name}】设置昵称（最多 8 个字，留空则清除昵称）：`,
      current,
    );
    if (input === null) {
      return;
    }
    const trimmed = input.trim().slice(0, 8);
    profile.pet.nickname = trimmed;
    if (trimmed) {
      setResult(`昵称已修改：${profile.pet.name} · ${trimmed}`, false);
    } else {
      setResult(`已清除【${profile.pet.name}】的昵称。`, false);
    }
    saveState("昵称已存档");
    render();
  }

  // 随机新宠物：消耗 1 行动点，新宠物初始状态，经验归 0，亲密度归零，道具保留
  function handleRandomPet() {
    const profile = getActiveProfile();
    if (!profile?.pet) {
      return;
    }
    if (profile.actionPoints < ACTION_COST) {
      setResult(`行动点不足，随机新宠物需要 ${ACTION_COST} 行动点。`, true);
      render();
      return;
    }

    const oldPetName = profile.pet.name;
    const confirmed = window.confirm(
      `确定消耗 ${ACTION_COST} 行动点重新随机宠物吗？\n\n` +
      `· 新宠物为初始状态（Lv.1，阶段 1）\n` +
      `· 角色经验将归 0（当前 ${profile.exp}）\n` +
      `· 宠物亲密度将归零（当前 Lv.${profile.pet.bond || 0}）\n` +
      `· 道具背包保留不变\n\n` +
      `当前宠物：${oldPetName}`,
    );
    if (!confirmed) {
      return;
    }

    // 扣行动点
    profile.actionPoints -= ACTION_COST;

    // 随机新宠物（初始状态）
    const petTemplate = randomItem(PET_POOL);
    profile.pet = createStoredPet(petTemplate, new Date().toISOString());

    // 同步更新pets数组中的第一只宠物
    if (!Array.isArray(profile.pets)) {
      profile.pets = [];
    }
    if (profile.pets.length > 0) {
      profile.pets[0] = profile.pet;
    } else {
      profile.pets.push(profile.pet);
    }
    profile.activePetIndex = 0;

    // 经验归 0
    profile.exp = 0;

    // 亲密度归零，已升级场景记录清空
    profile.pet.bond = 0;
    profile.pet.bondScenes = [];

    // 道具背包保留（inventory 不做任何修改）

    // 亲密度改为手动提升，移除自动触发逻辑
    let randomMsg = `已重新随机宠物：${oldPetName} → ${profile.pet.name}（${profile.pet.style}）。行动点 -${ACTION_COST}，经验归 0，亲密度归零，道具保留。集齐场景道具后可在宠物栏手动提升亲密度。`;
    setResult(randomMsg, false);
    saveState("随机新宠物已存档");
    render();
  }

  function handleTeacherLogin(event) {
    event.preventDefault();
    if (els.teacherKey.value.trim() === TEACHER_KEY) {
      teacherUnlocked = true;
      els.teacherKey.value = "";
      setTeacherMessage("后台权限已开启。", false);
      render();
      return;
    }
    setTeacherMessage("权限码错误。", true);
  }

  function handleTeacherLogout() {
    teacherUnlocked = false;
    setTeacherMessage("后台权限已关闭。", false);
    render();
  }

  function setExportMessage(text) {
    if (els.exportMessage) {
      els.exportMessage.textContent = text || "";
    }
  }

  // 老师后台：把本地全班存档逐个建成云端账号，密码统一 1234
  async function pushAllSavesToCloud() {
    if (!CLOUD_ENABLED) {
      setExportMessage("云端还没配置，无法上传");
      return;
    }
    const profiles = (state.profiles || []).filter((p) => p && p.name);
    if (!profiles.length) {
      setExportMessage("后台里还没有学生，先在下面创建一个角色");
      return;
    }
    // 先查重名，重名会互相覆盖
    const seen = new Set();
    const dup = new Set();
    profiles.forEach((p) => {
      const n = p.name.trim();
      if (seen.has(n)) {
        dup.add(n);
      }
      seen.add(n);
    });
    if (dup.size) {
      setExportMessage(`有重名学生：${[...dup].join("、")}，请先改掉重复的名字再上传`);
      return;
    }
    if (els.pushAllToCloud) {
      els.pushAllToCloud.disabled = true;
    }
    let ok = 0;
    const fails = [];
    setExportMessage(`正在上传 0 / ${profiles.length} …`);
    for (const profile of profiles) {
      try {
        profile.pass = "1234";
        await cloudUpsertStudent(profile.name, "1234", profile);
        ok += 1;
      } catch (err) {
        console.warn("上传失败", profile.name, err);
        fails.push(profile.name);
      }
      setExportMessage(`正在上传 ${ok + fails.length} / ${profiles.length} …`);
    }
    try {
      localStorage.setItem(activeStorageKey, JSON.stringify(state));
    } catch (err) {
      console.warn("保存本地失败", err);
    }
    setExportMessage(
      `完成：成功 ${ok} 人${fails.length ? `，失败 ${fails.length} 人（${fails.join("、")}）` : ""}，密码统一 1234`
    );
    if (els.pushAllToCloud) {
      els.pushAllToCloud.disabled = false;
    }
  }

  // 老师后台：把全班存档导出成 JSON 文件（备份用）
  function exportAllSaves() {
    const data = JSON.stringify(
      { exportedAt: new Date().toISOString(), profiles: state.profiles || [] },
      null,
      2
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `carlosia全班存档_${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setExportMessage(`已导出 ${(state.profiles || []).length} 个学生`);
  }

  function handlePullStudent() {
    const name = els.pullStudentName.value.trim();
    if (!name) {
      setTeacherMessage("请输入学生姓名。", true);
      return;
    }
    const profile = state.profiles.find((p) => p.name === name);
    if (!profile) {
      setTeacherMessage(`未找到学生「${name}」。`, true);
      return;
    }
    if (pulledProfileIds.includes(profile.id)) {
      setTeacherMessage(`学生「${name}」已在拉入列表中。`, true);
      return;
    }
    pulledProfileIds.push(profile.id);
    els.pullStudentName.value = "";
    setTeacherMessage(`已拉入学生「${name}」。`, false);
    renderPulledList();
    render();
  }

  function renderPulledList() {
    els.pulledList.replaceChildren();
    if (pulledProfileIds.length === 0) {
      els.pulledList.textContent = "未拉入学生，当前显示全部角色。";
      return;
    }
    const names = pulledProfileIds
      .map((id) => state.profiles.find((p) => p.id === id)?.name)
      .filter(Boolean);
    els.pulledList.textContent = `已拉入：${names.join("、")}`;
  }

  // 给所有拉入的学生每人加60行动点
  function handleAddAllPulledAp() {
    if (pulledProfileIds.length === 0) {
      setTeacherMessage("请先拉入学生再发奖励。", true);
      return;
    }
    let count = 0;
    pulledProfileIds.forEach((id) => {
      const profile = state.profiles.find((p) => p.id === id);
      if (profile) {
        profile.actionPoints = (profile.actionPoints || 0) + 60;
        count++;
      }
    });
    saveState("全员奖励发放");
    setTeacherMessage(`已给 ${count} 名学生每人发放60行动点！`, false);
    render();
  }

  function adjustActionPoints(direction) {
    const amount = Number.parseInt(els.apAmount.value, 10);
    const profile = state.profiles.find((item) => item.id === els.teacherSelect.value);
    if (!profile) {
      setTeacherMessage("请选择学生角色。", true);
      return;
    }
    if (!Number.isInteger(amount) || amount < 1) {
      setTeacherMessage("行动点数量必须为正整数。", true);
      return;
    }

    if (direction > 0) {
      profile.actionPoints += amount;
      setTeacherMessage(`${profile.name} 行动点增加 ${amount}。`, false);
    } else {
      const deducted = Math.min(profile.actionPoints, amount);
      profile.actionPoints -= deducted;
      setTeacherMessage(`${profile.name} 行动点扣除 ${deducted}。`, false);
    }
    saveState("后台已存档");
    render();
  }

  function getTeacherSelectedProfile() {
    const id = els.teacherSelect?.value;
    if (!id) return null;
    return state.profiles.find((item) => item.id === id) || null;
  }

  function setPetLevelMessage(message, warning) {
    if (!els.petLevelMessage) return;
    els.petLevelMessage.textContent = message;
    els.petLevelMessage.classList.toggle("warning", Boolean(warning));
  }

  // 后台调试：把指定学生的出战宠物提到目标等级，并检查是否触发进化
  function boostPetLevel(profile, targetLevel) {
    if (!profile?.pet) {
      setPetLevelMessage("该学生还没有宠物。", true);
      return;
    }
    const pet = profile.pet;
    const oldLevel = pet.level;
    const nextLevel = Math.max(oldLevel, Math.floor(Number(targetLevel) || 0));
    if (nextLevel <= oldLevel) {
      setPetLevelMessage(`${pet.name} 已经是 Lv.${oldLevel}，无需提升。`, true);
      return;
    }
    const delta = nextLevel - oldLevel;

    pet.level = nextLevel;
    pet.hpMax += PET_UPGRADE_HP_GAIN * delta;

    if (profile.pets && Number.isInteger(profile.activePetIndex)) {
      profile.pets[profile.activePetIndex] = pet;
    }

    // 进化检查（一次可能跨多个阶段，只演最终形态）
    pendingEvolution = null;
    const evolved = autoEvolvePet(pet);
    const evolInfo = evolved ? takePendingEvolution() : null;
    if (profile.pets && Number.isInteger(profile.activePetIndex)) {
      profile.pets[profile.activePetIndex] = pet;
    }

    saveState("后台已调整宠物等级");
    render();

    let msg = `${profile.name}：${pet.name} Lv.${oldLevel} → Lv.${nextLevel}（生命 +${
      PET_UPGRADE_HP_GAIN * delta
    }）`;
    if (evolInfo) {
      msg += `，并进化为【${pet.name}】`;
    }
    setPetLevelMessage(msg, false);
    setTeacherMessage(msg, false);

    if (evolInfo) {
      setTimeout(() => showEvolutionModal(evolInfo), 120);
    }
  }

  function render() {
    const changed = normalizeState();
    if (changed) {
      saveState("存档已刷新");
    }

    renderProfileList();
    renderTeacherPanel();

    const profile = getActiveProfile();
    els.emptyState.hidden = Boolean(profile);
    els.gameView.hidden = !profile;
    if (!profile) {
      return;
    }

    const selectedScene = getScene(selectedSceneId);
    if (!selectedScene || !isSceneUnlocked(selectedScene, profile)) {
      selectedSceneId = "grassland";
    }

    els.activeName.textContent = profile.name;
    els.activeGender.textContent = genderLabel(profile.gender);
    els.actionPoints.textContent = String(profile.actionPoints);
    if (profile.pet) {
      const bondLv = profile.pet.bond || 0;
      const statusLv = document.createElement("span");
      statusLv.className = "pet-status-lv";
      statusLv.textContent = `Lv.${profile.pet.level}`;
      const statusBond = document.createElement("span");
      statusBond.className = "pet-status-bond";
      statusBond.textContent = `亲密 ${bondLv}`;
      els.petStatus.replaceChildren(statusLv, statusBond);
      const petDisplayName = profile.pet.nickname
        ? `${profile.pet.name} · ${profile.pet.nickname}`
        : profile.pet.name;
      els.petDetail.textContent = `${petDisplayName} · ${profile.pet.type} · HP ${profile.pet.hpMax} · 战力 ${getPetPower(profile.pet)}`;
      els.petSmallIcon.hidden = !profile.pet.image;
      if (profile.pet.image) {
        els.petSmallIcon.src = profile.pet.image;
        els.petSmallIcon.alt = `${profile.pet.name}头像`;
      }
      els.petDetail.textContent += profile.compensationEligible
        ? profile.compensationClaimed
          ? " · 补偿已领取"
          : " · 可领取补偿"
        : "";
    } else if (profile.egg.granted) {
      els.petStatus.textContent = "待孵化";
      els.petDetail.textContent = "已获得随机初始宠物蛋";
      els.petSmallIcon.hidden = true;
    } else {
      els.petStatus.textContent = "未孵化";
      els.petDetail.textContent = `经验达到 ${HATCH_EXP_REQUIREMENT} 解锁`;
      els.petSmallIcon.hidden = true;
    }

    renderStats(profile);
    renderSceneGrid();
    renderResult();
    renderHatch(profile);

    // 视图切换
    els.worldView.hidden = currentView !== "world";
    els.sceneView.hidden = currentView !== "scene";
    els.shopView.hidden = currentView !== "shop";
    if (els.rankView) els.rankView.hidden = currentView !== "rank";
    els.navWorld.classList.toggle("active", currentView === "world" || currentView === "scene");
    els.navShop.classList.toggle("active", currentView === "shop");
    if (els.navRank) els.navRank.classList.toggle("active", currentView === "rank");

    if (currentView === "scene") {
      renderSceneInner(profile);
    } else if (currentView === "shop") {
      renderShop(currentShopTab);
    } else if (currentView === "rank") {
      renderRankView();
    }
  }

  function renderProfileList() {
    els.profileList.replaceChildren();
    // 如果老师拉入了学生，只显示被拉入的
    const visibleProfiles = pulledProfileIds.length > 0
      ? state.profiles.filter((p) => pulledProfileIds.includes(p.id))
      : state.profiles;

    if (visibleProfiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "profile-empty";
      empty.textContent = pulledProfileIds.length > 0 ? "拉入的学生暂无角色存档" : "暂无角色存档";
      els.profileList.appendChild(empty);
      return;
    }

    visibleProfiles.forEach((profile) => {
      const row = document.createElement("div");
      row.className = "profile-record";

      const button = document.createElement("button");
      button.type = "button";
      button.className = `profile-option${profile.id === state.selectedId ? " active" : ""}`;
      button.dataset.profileId = profile.id;

      const name = document.createElement("strong");
      name.textContent = profile.name;
      const meta = document.createElement("span");
      meta.textContent = `${genderLabel(profile.gender)} · 行动点 ${profile.actionPoints} · 经验 ${profile.exp}`;

      button.append(name, meta);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "profile-delete";
      deleteButton.dataset.deleteProfileId = profile.id;
      deleteButton.setAttribute("aria-label", `删除角色${profile.name}`);
      deleteButton.title = "删除角色";
      deleteButton.textContent = "删";

      row.append(button, deleteButton);
      els.profileList.appendChild(row);
    });
  }

  function renderTeacherPanel() {
    els.teacherLogin.hidden = teacherUnlocked;
    els.teacherControls.hidden = !teacherUnlocked;
    const previousTeacherSelection = els.teacherSelect.value;
    els.teacherSelect.replaceChildren();

    if (!teacherUnlocked) {
      return;
    }

    // 老师后台下拉列表：如果拉入了学生，只显示被拉入的
    const visibleProfiles = pulledProfileIds.length > 0
      ? state.profiles.filter((p) => pulledProfileIds.includes(p.id))
      : state.profiles;

    if (visibleProfiles.length === 0) {
      const option = document.createElement("option");
      option.textContent = pulledProfileIds.length > 0 ? "拉入的学生暂无角色" : "暂无学生角色";
      option.value = "";
      els.teacherSelect.appendChild(option);
      els.teacherSelect.disabled = true;
      els.apAmount.disabled = true;
      els.addAp.disabled = true;
      els.subtractAp.disabled = true;
      return;
    }

    els.teacherSelect.disabled = false;
    els.apAmount.disabled = false;
    els.addAp.disabled = false;
    els.subtractAp.disabled = false;

    visibleProfiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name}（行动点 ${profile.actionPoints}）`;
      els.teacherSelect.appendChild(option);
    });
    els.teacherSelect.value =
      visibleProfiles.find((profile) => profile.id === previousTeacherSelection)?.id ||
      state.selectedId ||
      state.profiles[0].id;
    renderPulledList();
  }

  function renderStats(profile) {
    if (!profile.pet) {
      setEmptyCapStat(els.hpValue, els.hpBar, "未孵化");
      setStat(els.expValue, els.expBar, profile.exp, HATCH_EXP_REQUIREMENT);
      els.expHint.textContent = `孵蛋还需 ${Math.max(0, HATCH_EXP_REQUIREMENT - profile.exp)} 经验`;
      els.powerValue.textContent = "--";
      els.attackValue.textContent = "--";
      els.defenseValue.textContent = "--";
      els.speedValue.textContent = "--";
      els.typeInfo.hidden = true;
      return;
    }

    const nextHpMax = profile.pet.hpMax + PET_UPGRADE_HP_GAIN;
    const upgradeCost = getUpgradeCost(profile.pet.level);
    setStat(els.hpValue, els.hpBar, profile.pet.hpMax, nextHpMax);
    setStat(els.expValue, els.expBar, profile.exp, upgradeCost);
    els.expHint.textContent = `升级还需 ${Math.max(0, upgradeCost - profile.exp)} 经验`;

    els.powerValue.textContent = String(getPetPower(profile.pet));
    els.attackValue.textContent = String(getPetAttack(profile.pet));
    els.defenseValue.textContent = String(getPetDefense(profile.pet));
    els.speedValue.textContent = String(getPetSpeed(profile.pet));

    // 系别标签（点击弹出克制说明）
    els.typeInfo.hidden = false;
    els.typeLabel.textContent = profile.pet.type;
    els.typeLabel.style.cursor = "pointer";
    els.typeLabel.onclick = (e) => {
      const rect = els.typeLabel.getBoundingClientRect();
      showTypeTooltip(profile.pet.type, rect.left, rect.bottom + 8);
    };
    els.typeStrong.textContent = "点击查看克制关系";
    els.typeWeak.textContent = "";
  }

  // ===== 箱庭大世界：区域点坐标 / 场景底图 / 地标表情 =====
  const SCENE_MAP_POS = {
    "grassland": [16, 68],
    "volcano": [38, 45],
    "mermaid-bay": [82, 52],
    "academy": [66, 84],
    "snow-valley": [19, 22],
    "thunder-valley": [45, 56],
    "shadow-forest": [71, 44],
    "dark-swamp": [50, 24],
    "dragon-realm": [77, 20],
    "sky-city": [53, 9],
  };

  const SCENE_IMG = {
    "grassland": "assets/boxworld/scene-grassland.webp",
    "volcano": "assets/boxworld/scene-volcano.webp",
    "mermaid-bay": "assets/boxworld/scene-bay.webp",
    "academy": "assets/boxworld/scene-academy.webp",
    "snow-valley": "assets/boxworld/scene-snow.webp",
    "thunder-valley": "assets/boxworld/scene-thunder.webp",
    "shadow-forest": "assets/boxworld/scene-shadow.webp",
    "dark-swamp": "assets/boxworld/scene-swamp.webp",
    "dragon-realm": "assets/boxworld/scene-dragon.webp",
    "sky-city": "assets/boxworld/scene-sky.webp",
  };

  const SCENE_EMOJI = {
    "grassland": "🌿",
    "volcano": "🔥",
    "mermaid-bay": "🌊",
    "academy": "🔬",
    "snow-valley": "❄️",
    "thunder-valley": "⚡",
    "shadow-forest": "🌲",
    "dark-swamp": "🌫️",
    "dragon-realm": "🐉",
    "sky-city": "🏛️",
  };

  // 六个探索点在场景图上的固定位置（百分比，与 spots 顺序一一对应）
  const STAGE_SPOT_XY = [[26, 76], [78, 47], [64, 26], [38, 63], [55, 21], [8, 55]];

  function renderSceneGrid() {
    els.sceneGrid.classList.add("map-mode");
    els.sceneGrid.replaceChildren();
    const profile = getActiveProfile();

    const cont = document.createElement("div");
    cont.className = "continent";

    const bg = document.createElement("img");
    bg.className = "continent-bg";
    bg.src = "assets/boxworld/map-continent.webp";
    bg.alt = "卡罗西亚大陆";
    cont.appendChild(bg);

    SCENES.forEach((scene) => {
      const unlocked = isSceneUnlocked(scene, profile);
      const lockReason = getSceneLockReason(scene, profile);
      const pos = SCENE_MAP_POS[scene.id] || [50, 50];

      const button = document.createElement("button");
      button.type = "button";
      button.className = `map-pin ${unlocked ? "" : "locked"} ${
        scene.id === selectedSceneId ? "selected" : ""
      }`;
      button.dataset.sceneId = scene.id;
      button.disabled = !unlocked;
      button.style.left = `${pos[0]}%`;
      button.style.top = `${pos[1]}%`;
      button.setAttribute("aria-label", unlocked ? scene.name : `${scene.name}，${lockReason}`);

      const dot = document.createElement("span");
      dot.className = "map-dot";
      dot.textContent = SCENE_EMOJI[scene.id] || "📍";

      const name = document.createElement("span");
      name.className = "map-name";
      name.textContent = scene.name;

      const meta = document.createElement("span");
      meta.className = "map-meta";
      meta.textContent = unlocked
        ? `${scene.tag} · ${scene.drops.exp[0]}-${scene.drops.exp[1]}`
        : lockReason;

      button.append(dot, name, meta);
      cont.appendChild(button);
    });

    els.sceneGrid.appendChild(cont);

    // 预加载十张场景底图，进场景时不用等
    Object.keys(SCENE_IMG).forEach((key) => {
      const pre = new Image();
      pre.src = SCENE_IMG[key];
    });
  }

  function renderSceneInner(profile) {
    const scene = getScene(selectedSceneId);
    if (!scene) return;
    els.sceneInnerTitle.textContent = scene.name;

    // 场景舞台：真实底图 + 训练师 + 宠物 + 六个探索点
    els.sceneAtmosphere.replaceChildren();
    const stageEl = document.createElement("div");
    stageEl.className = "scene-stage";

    const stageBg = document.createElement("img");
    stageBg.className = "scene-stage-bg";
    stageBg.src = SCENE_IMG[scene.id] || "";
    stageBg.alt = scene.name;
    stageEl.appendChild(stageBg);

    const stageDesc = document.createElement("p");
    stageDesc.className = "scene-stage-desc";
    stageDesc.textContent = scene.feature || "";
    stageEl.appendChild(stageDesc);

    const trainerEl = document.createElement("div");
    trainerEl.className = "stage-player";
    const trainerImg = document.createElement("img");
    trainerImg.src = "assets/boxworld/trainer-boy-sprite.png";
    trainerImg.alt = "";
    trainerEl.appendChild(trainerImg);
    stageEl.appendChild(trainerEl);

    if (profile.pet && profile.pet.image) {
      const petEl = document.createElement("div");
      petEl.className = "stage-pet";
      const petImgEl = document.createElement("img");
      petImgEl.src = profile.pet.image;
      petImgEl.alt = profile.pet.name || "";
      petEl.appendChild(petImgEl);
      stageEl.appendChild(petEl);
    }

    // 探索点直接落在图上的对应位置（沿用原有点击事件委托）
    els.sceneSpotList.replaceChildren();
    els.sceneSpotList.className = "stage-spot-layer";
    const spots = SCENE_SPOTS[scene.id] || [];
    spots.forEach((spot, spotIndex) => {
      const xy = STAGE_SPOT_XY[spotIndex] || [50, 50];
      const card = document.createElement("button");
      card.type = "button";
      card.className = `stage-spot${selectedSpotId === spot.id ? " selected" : ""}`;
      card.dataset.spotId = spot.id;
      card.style.left = `${xy[0]}%`;
      card.style.top = `${xy[1]}%`;
      card.disabled = isExploring;
      card.title = `${spot.name}：${spot.desc}（经验 ${spot.exp[0]}-${spot.exp[1]}，免费探索）`;

      const spotIcon = document.createElement("span");
      spotIcon.className = "stage-dot";
      spotIcon.textContent = SCENE_EMOJI[scene.id] || "🔍";

      const spotName = document.createElement("span");
      spotName.className = "stage-tag";
      spotName.textContent = spot.name;

      card.append(spotIcon, spotName);
      els.sceneSpotList.appendChild(card);
    });

    stageEl.appendChild(els.sceneSpotList);
    els.sceneAtmosphere.appendChild(stageEl);

    // 场景道具收集情况（显示在场景下面）
    if (els.sceneInventory) {
      els.sceneInventory.replaceChildren();
      const items = SCENE_ITEMS[scene.id] || [];
      const collected = items.filter((item) => (profile.inventory[item.id] || 0) >= 1).length;
      const bondDone = profile.pet && Array.isArray(profile.pet.bondScenes) && profile.pet.bondScenes.includes(scene.id);

      const invPanel = document.createElement("div");
      invPanel.className = "inventory-panel";

      const heading = document.createElement("h4");
      heading.className = "inventory-heading";
      heading.textContent = `${scene.name}道具 ${collected}/${items.length}${bondDone ? " · 亲密度已提升" : ""}`;
      invPanel.appendChild(heading);

      const itemGrid = document.createElement("div");
      itemGrid.className = "inventory-item-grid";

      items.forEach((item) => {
        const count = profile.inventory[item.id] || 0;
        const itemEl = document.createElement("div");
        itemEl.className = `inventory-item ${count > 0 ? "owned" : "locked"}`;
        itemEl.title = `${item.name}：${item.desc}（持有 ${count} 个）`;

        const iconWrap = document.createElement("div");
        iconWrap.className = "inventory-item-icon";
        iconWrap.innerHTML = item.icon;

        const itemName = document.createElement("span");
        itemName.className = "inventory-item-name";
        itemName.textContent = item.name;

        const itemCount = document.createElement("span");
        itemCount.className = "inventory-item-count";
        itemCount.textContent = count > 0 ? `×${count}` : "未获得";

        itemEl.append(iconWrap, itemName, itemCount);
        itemGrid.appendChild(itemEl);
      });

      invPanel.appendChild(itemGrid);
      els.sceneInventory.appendChild(invPanel);
    }
  }

  function renderResult() {
    els.resultMessage.textContent = resultMessage;
    els.resultMessage.classList.toggle("warning", resultIsWarning);
  }

  // ===== 商店渲染 =====
  async function renderShop(tab) {
    currentShopTab = tab;
    els.shopTabMarket.classList.toggle("active", tab === "market");
    els.shopTabSell.classList.toggle("active", tab === "sell");
    els.shopTabMine.classList.toggle("active", tab === "mine");

    // 逛市场时先从云端拉全班的最新挂单
    if (tab === "market") {
      await loadMarketFromCloud();
      if (currentShopTab !== tab) return;
    }

    els.shopContent.replaceChildren();

    const profile = getActiveProfile();
    if (!profile) return;

    if (tab === "market") {
      renderMarketTab(profile);
    } else if (tab === "sell") {
      renderSellTab(profile);
    } else if (tab === "mine") {
      renderMineTab(profile);
    }
  }

  function renderMarketTab(profile) {
    if (marketState.listings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shop-empty";
      empty.textContent = "市场上还没有道具，快去「我要卖」上架吧！";
      els.shopContent.appendChild(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "shop-grid";
    // 按上架时间倒序
    const sorted = [...marketState.listings].sort((a, b) =>
      new Date(b.listedAt) - new Date(a.listedAt),
    );
    sorted.forEach((listing) => {
      const itemDef = getItemDef(listing.itemId);
      const card = document.createElement("div");
      card.className = "shop-item-card";
      const isOwn = listing.sellerId === profile.id;

      const icon = document.createElement("div");
      icon.className = "shop-item-icon";
      icon.innerHTML = itemDef?.icon || "";

      const info = document.createElement("div");
      info.className = "shop-item-info";
      const name = document.createElement("strong");
      name.textContent = listing.itemName;
      const seller = document.createElement("span");
      seller.className = "shop-seller";
      seller.textContent = `卖家：${listing.sellerName}${isOwn ? "（我）" : ""}`;
      info.append(name, seller);

      const price = document.createElement("div");
      price.className = "shop-item-price";
      price.textContent = `${listing.price} 经验`;

      card.append(icon, info, price);

      if (!isOwn) {
        const buyBtn = document.createElement("button");
        buyBtn.type = "button";
        buyBtn.className = "primary-button shop-buy-btn";
        buyBtn.dataset.action = "buy";
        buyBtn.dataset.listingId = listing.id;
        buyBtn.disabled = profile.exp < listing.price;
        buyBtn.textContent = "购买";
        card.appendChild(buyBtn);
      } else {
        const ownTag = document.createElement("span");
        ownTag.className = "shop-own-tag";
        ownTag.textContent = "我的上架";
        card.appendChild(ownTag);
      }
      grid.appendChild(card);
    });
    els.shopContent.appendChild(grid);
  }

  function renderSellTab(profile) {
    const ownedItems = [];
    for (const sceneId of Object.keys(SCENE_ITEMS)) {
      SCENE_ITEMS[sceneId].forEach((item) => {
        const count = profile.inventory[item.id] || 0;
        if (count > 0) {
          ownedItems.push({ ...item, count, sceneId });
        }
      });
    }
    if (ownedItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shop-empty";
      empty.textContent = "背包里还没有道具，去探索场景获取吧！";
      els.shopContent.appendChild(empty);
      return;
    }
    const hint = document.createElement("p");
    hint.className = "shop-hint";
    hint.textContent = "统一定价，卖出后系统收取 10% 手续费。点击道具即可上架。";
    els.shopContent.appendChild(hint);

    const grid = document.createElement("div");
    grid.className = "shop-grid";
    ownedItems.forEach((item) => {
      const price = getItemPrice(item.id);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "shop-item-card sell-card";
      card.dataset.action = "list";
      card.dataset.itemId = item.id;

      const icon = document.createElement("div");
      icon.className = "shop-item-icon";
      icon.innerHTML = item.icon;

      const info = document.createElement("div");
      info.className = "shop-item-info";
      const name = document.createElement("strong");
      name.textContent = item.name;
      const count = document.createElement("span");
      count.className = "shop-seller";
      count.textContent = `持有 ×${item.count}`;
      info.append(name, count);

      const priceEl = document.createElement("div");
      priceEl.className = "shop-item-price";
      priceEl.textContent = `售价 ${price} 经验`;

      const listTag = document.createElement("span");
      listTag.className = "shop-list-tag";
      listTag.textContent = "点击上架";

      card.append(icon, info, priceEl, listTag);
      grid.appendChild(card);
    });
    els.shopContent.appendChild(grid);
  }

  function renderMineTab(profile) {
    const myListings = marketState.listings.filter((l) => l.sellerId === profile.id);
    if (myListings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shop-empty";
      empty.textContent = "你还没有上架任何道具。";
      els.shopContent.appendChild(empty);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "shop-grid";
    myListings.forEach((listing) => {
      const itemDef = getItemDef(listing.itemId);
      const card = document.createElement("div");
      card.className = "shop-item-card";

      const icon = document.createElement("div");
      icon.className = "shop-item-icon";
      icon.innerHTML = itemDef?.icon || "";

      const info = document.createElement("div");
      info.className = "shop-item-info";
      const name = document.createElement("strong");
      name.textContent = listing.itemName;
      const time = document.createElement("span");
      time.className = "shop-seller";
      time.textContent = `售价 ${listing.price} 经验`;
      info.append(name, time);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "danger-button shop-cancel-btn";
      cancelBtn.dataset.action = "unlist";
      cancelBtn.dataset.listingId = listing.id;
      cancelBtn.textContent = "下架";

      card.append(icon, info, cancelBtn);
      grid.appendChild(card);
    });
    els.shopContent.appendChild(grid);
  }

  async function handleShopAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "buy") {
      button.disabled = true;
      const result = await buyItem(button.dataset.listingId);
      setResult(result.msg, !result.ok);
      render();
    } else if (action === "list") {
      button.disabled = true;
      const result = await listItem(button.dataset.itemId);
      setResult(result.msg, !result.ok);
      render();
    } else if (action === "unlist") {
      button.disabled = true;
      const result = await unlistItem(button.dataset.listingId);
      setResult(result.msg, !result.ok);
      render();
    }
  }

  function renderHatch(profile) {
    els.hatchPanel.classList.toggle("male-style", profile.gender === "male");
    els.hatchPanel.classList.toggle("female-style", profile.gender === "female");
    els.hatchContent.replaceChildren();

    if (profile.pet) {
      const match = findPetMatch(profile.pet);
      const stageCount = match?.template?.stages?.length || 1;
      const currentStage = Math.max(1, Math.min(stageCount, profile.pet.stage || 1));
      const nextStage = match?.template?.stages?.[currentStage];
      const nextEvolutionLevel = getEvolutionLevel(nextStage?.stage, nextStage);
      const visual = createPetVisual(profile.pet);
      const copy = document.createElement("div");
      copy.className = "hatch-copy";
      const title = document.createElement("h3");
      const displayName = profile.pet.nickname
        ? `${profile.pet.name} · ${profile.pet.nickname}`
        : profile.pet.name;
      title.textContent = `${displayName} Lv.${profile.pet.level} · 阶段 ${currentStage}/${stageCount}`;
      const text = document.createElement("p");
      const upgradeCost = getUpgradeCost(profile.pet.level);
      const evolutionText = nextStage
        ? `下一阶段为${nextStage.name}，达到 Lv.${nextEvolutionLevel} 后可进化。`
        : "已达到当前进化链最高阶段。";
      text.textContent = `${profile.pet.desc || "已孵化宠物"} 系别：${profile.pet.type}。${evolutionText} 生命上限 ${profile.pet.hpMax}，攻击 ${getPetAttack(profile.pet)}，防御 ${getPetDefense(profile.pet)}，速度 ${getPetSpeed(profile.pet)}。宠物升级需要 ${upgradeCost} 经验。`;
      const bondLevel = profile.pet.bond || 0;
      const tags = createHatchTags([
        profile.pet.style,
        profile.pet.type,
        genderLabel(profile.gender),
        `可用经验 ${profile.exp}`,
        `亲密度 Lv.${bondLevel}`,
      ]);
      const buttons = [];
      if (match?.template) {
        copy.append(createEvolutionTrack(match.template, currentStage));
      }
      // 进化改为自动进化，移除手动进化按钮，显示进化进度提示
      if (nextStage) {
        const evolveHint = document.createElement("p");
        evolveHint.className = "rename-hint";
        evolveHint.textContent = `达到 Lv.${nextEvolutionLevel} 后将自动进化为【${nextStage.name}】。`;
        copy.append(evolveHint);
      }
      if (profile.compensationEligible && !profile.compensationClaimed) {
        const compensationButton = document.createElement("button");
        compensationButton.id = "compensationButton";
        compensationButton.type = "button";
        compensationButton.className = "secondary-button compensation-button";
        compensationButton.innerHTML =
          '<span class="button-icon" aria-hidden="true">↻</span>领取补偿：随机宠物 +2行动点';
        buttons.push(compensationButton);
      }

      // 升级宠物按钮已移除，升级改为探索时自动升级
      const upgradeHint = document.createElement("p");
      upgradeHint.className = "rename-hint";
      upgradeHint.textContent = `宠物升级为自动升级，探索获得经验后自动升级（当前升级需要 ${upgradeCost} 经验）。`;
      copy.append(upgradeHint);

      // 亲密度和昵称操作已移到宠物栏
      const bondHint = document.createElement("p");
      bondHint.className = "rename-hint";
      bondHint.textContent = `亲密度 Lv.${bondLevel}/10，集齐场景道具后可在宠物栏点击「提升亲密度」。修改昵称、刷新宠物等操作也在宠物栏中。`;
      copy.append(bondHint);

      copy.prepend(title, text, tags);
      copy.append(...buttons);

      els.hatchContent.append(visual, copy);
      return;
    }

    if (profile.egg.granted) {
      const visual = createEggVisual();
      const copy = document.createElement("div");
      copy.className = "hatch-copy";
      const title = document.createElement("h3");
      title.textContent = "随机初始宠物蛋";
      const text = document.createElement("p");
      text.textContent = `${genderLabel(profile.gender)}角色孵蛋画风：${hatchStyleText(
        profile.gender,
      )}。`;
      const button = document.createElement("button");
      button.id = "hatchButton";
      button.type = "button";
      button.className = "primary-button";
      button.innerHTML = '<span class="button-icon" aria-hidden="true">◇</span>孵化';
      copy.append(title, text, createHatchTags(hatchTags(profile.gender)), button);
      els.hatchContent.append(visual, copy);
      return;
    }

    const visual = createEggVisual();
    const copy = document.createElement("div");
    copy.className = "hatch-copy";
    const title = document.createElement("h3");
    title.textContent = "孵蛋未解锁";
    const text = document.createElement("p");
    text.textContent = `门槛：经验≥${HATCH_EXP_REQUIREMENT}。探索只获得经验，经验达标后自动发放宠物蛋。`;
    copy.append(title, text, createHatchTags(["无初始宠物", "经验孵蛋"]));
    els.hatchContent.append(visual, copy);
  }

  function rollSceneDrop(scene, expRange) {
    const range = expRange || scene.drops.exp;
    const exp = randomInt(range[0], range[1]);
    return { exp };
  }

  // 道具掉落：18% 概率触发；第5地点掉率70%；第5、6地点无主打倾向，4道具等概率
  function rollSceneItem(scene, spot) {
    if (!scene) return null;
    const spots = SCENE_SPOTS[scene.id] || [];
    const spotIndex = spots.findIndex((s) => s.id === spot?.id);
    // 第5个探索地点（index=4）掉率70%，其余18%
    const dropChance = spotIndex === 4 ? 0.7 : ITEM_DROP_CHANCE;
    if (Math.random() >= dropChance) {
      return null;
    }
    const items = SCENE_ITEMS[scene.id];
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }
    // 第5、6地点无主打倾向，4道具等概率；其他地点主打道具50%概率
    if (spotIndex === 4 || spotIndex === 5) {
      return items[Math.floor(Math.random() * items.length)];
    }
    const mainItemId = spot?.mainItem;
    const mainItem = items.find((item) => item.id === mainItemId);
    if (mainItem && Math.random() < 0.5) {
      return mainItem;
    }
    const otherItems = mainItem ? items.filter((item) => item.id !== mainItemId) : items;
    return otherItems[Math.floor(Math.random() * otherItems.length)];
  }

  // 检测某场景道具是否集齐，集齐则触发亲密度 +1（每场景仅一次）
  function checkAndTriggerBond(profile, sceneId) {
    if (!profile?.pet) {
      return false;
    }
    // 该宠物在该场景已触发过亲密度升级，不再重复
    if (Array.isArray(profile.pet.bondScenes) && profile.pet.bondScenes.includes(sceneId)) {
      return false;
    }
    const items = SCENE_ITEMS[sceneId];
    if (!Array.isArray(items) || items.length === 0) {
      return false;
    }
    // 检查 4 种道具是否都至少有 1 个
    const allCollected = items.every((item) => (profile.inventory[item.id] || 0) >= 1);
    if (!allCollected) {
      return false;
    }
    // 触发亲密度升级，消耗每个道具各1个
    profile.pet.bond = Math.min(10, (profile.pet.bond || 0) + 1);
    items.forEach((item) => {
      const count = profile.inventory[item.id] || 0;
      if (count > 1) {
        profile.inventory[item.id] = count - 1;
      } else {
        delete profile.inventory[item.id];
      }
    });
    if (!Array.isArray(profile.pet.bondScenes)) {
      profile.pet.bondScenes = [];
    }
    profile.pet.bondScenes.push(sceneId);
    return true;
  }

  // 批量检查所有已开放场景，触发已集齐但未升级的亲密度（用于孵化/随机新宠物后兜底）
  function checkAllBonds(profile) {
    if (!profile?.pet) {
      return 0;
    }
    let upgraded = 0;
    SCENES.forEach((scene) => {
      if (checkAndTriggerBond(profile, scene.id)) {
        upgraded += 1;
      }
    });
    return upgraded;
  }

  function grantEggIfEligible(profile) {
    if (profile.egg.granted || profile.pet || !meetsEggThreshold(profile)) {
      return false;
    }
    profile.egg.granted = true;
    profile.egg.grantedAt = new Date().toISOString();
    return true;
  }

  function meetsEggThreshold(profile) {
    return profile.exp >= HATCH_EXP_REQUIREMENT;
  }

  function setStat(valueElement, barElement, value, target) {
    valueElement.textContent = `${value} / ${target}`;
    const percent = Math.min(100, Math.round((value / target) * 100));
    barElement.style.width = `${percent}%`;
  }

  function setEmptyCapStat(valueElement, barElement, text) {
    valueElement.textContent = text;
    barElement.style.width = "0%";
  }

  function getUpgradeCost(level) {
    if (level <= 10) return 110 + level * 70;
    if (level <= 30) return 220 + level * 110;
    return 450 + level * 170;
  }

  // 宠物战斗属性计算（由等级决定，无需存档）
  function getPetAttack(pet) {
    const base = Math.floor(PET_BASE_ATTACK + (pet.level - 1) * PET_ATTACK_PER_LEVEL);
    return pet.isShiny ? base + 5 : base;
  }

  function getPetDefense(pet) {
    const base = Math.floor(PET_BASE_DEFENSE + (pet.level - 1) * PET_DEFENSE_PER_LEVEL);
    return pet.isShiny ? base + 3 : base;
  }

  function getPetSpeed(pet) {
    const base = Math.floor(PET_BASE_SPEED + (pet.level - 1) * PET_SPEED_PER_LEVEL);
    return pet.isShiny ? base + 3 : base;
  }

  // 战斗力综合评分
  function getPetPower(pet) {
    return Math.floor(
      pet.hpMax * 0.5 +
      getPetAttack(pet) * 3 +
      getPetDefense(pet) * 2 +
      getPetSpeed(pet) * 2,
    );
  }

  // 系别克制描述
  function getTypeInfo(type) {
    return TYPE_CHART[type] || { strong: [], weak: [] };
  }

  // ===== 战斗系统 =====
  function generateWildPet(sceneId) {
    const config = WILD_PETS[sceneId];
    if (!config) return null;
    // 判断是否遇到异色稀有宠物（低概率）
    let petId;
    let isShiny = false;
    if (config.shinyPetIds && config.shinyPetIds.length > 0 && Math.random() < (config.shinyRate || 0.03)) {
      petId = config.shinyPetIds[Math.floor(Math.random() * config.shinyPetIds.length)];
      isShiny = true;
    } else {
      petId = config.petIds[Math.floor(Math.random() * config.petIds.length)];
    }
    const template = PET_DATABASE.find((p) => p.petId === petId);
    if (!template) return null;
    const level = randomInt(config.levelRange[0], config.levelRange[1]);
    const stage = template.stages.find((s) => level >= s.needLevel) || template.stages[0];
    // 异色宠物基础资质更强（+30%血量，+5攻击，+3防御，+3速度）
    const shinyBonus = isShiny ? 1.3 : 1;
    const shinyAtkBonus = isShiny ? 5 : 0;
    const shinyDefBonus = isShiny ? 3 : 0;
    const shinySpdBonus = isShiny ? 3 : 0;
    return {
      name: stage.name,
      image: stage.image || null,
      type: stage.type || template.type,
      level,
      isShiny,
      hpMax: Math.floor((PET_BASE_HP_MAX + (level - 1) * PET_UPGRADE_HP_GAIN) * shinyBonus),
      attack: getPetAttack({ level }) + shinyAtkBonus,
      defense: getPetDefense({ level }) + shinyDefBonus,
      speed: getPetSpeed({ level }) + shinySpdBonus,
    };
  }

  // 模拟全自动战斗，返回 {win, log, events}
  // events 为结构化战斗事件，供战斗演出播放
  function simulateBattle(playerPet, wildPet) {
    const log = [];
    const events = [];
    let playerHp = playerPet.hpMax;
    let wildHp = wildPet.hpMax;
    const playerAtk = getPetAttack(playerPet);
    const playerDef = getPetDefense(playerPet);
    const playerSpd = getPetSpeed(playerPet);

    log.push(`野生的 ${wildPet.name}（Lv.${wildPet.level}）出现了！`);

    let playerFirst = playerSpd >= wildPet.speed;
    let round = 0;
    while (playerHp > 0 && wildHp > 0 && round < 20) {
      round += 1;
      if (playerFirst) {
        const dmg = Math.max(1, playerAtk - Math.floor(wildPet.defense * 0.5) + randomInt(-2, 2));
        wildHp -= dmg;
        log.push(`${playerPet.name} 发起攻击，造成 ${dmg} 点伤害！`);
        events.push({
          side: "player",
          dmg,
          playerHp: Math.max(0, playerHp),
          wildHp: Math.max(0, wildHp),
        });
        if (wildHp <= 0) break;
        const wildDmg = Math.max(1, wildPet.attack - Math.floor(playerDef * 0.5) + randomInt(-2, 2));
        playerHp -= wildDmg;
        log.push(`${wildPet.name} 反击，造成 ${wildDmg} 点伤害！`);
        events.push({
          side: "enemy",
          dmg: wildDmg,
          playerHp: Math.max(0, playerHp),
          wildHp: Math.max(0, wildHp),
        });
      } else {
        const wildDmg = Math.max(1, wildPet.attack - Math.floor(playerDef * 0.5) + randomInt(-2, 2));
        playerHp -= wildDmg;
        log.push(`${wildPet.name} 抢先攻击，造成 ${wildDmg} 点伤害！`);
        events.push({
          side: "enemy",
          dmg: wildDmg,
          playerHp: Math.max(0, playerHp),
          wildHp: Math.max(0, wildHp),
        });
        if (playerHp <= 0) break;
        const dmg = Math.max(1, playerAtk - Math.floor(wildPet.defense * 0.5) + randomInt(-2, 2));
        wildHp -= dmg;
        log.push(`${playerPet.name} 反击，造成 ${dmg} 点伤害！`);
        events.push({
          side: "player",
          dmg,
          playerHp: Math.max(0, playerHp),
          wildHp: Math.max(0, wildHp),
        });
      }
    }

    const win = wildHp <= 0;
    if (win) {
      log.push(`🎉 胜利！野生 ${wildPet.name} 被击败了。`);
    } else {
      log.push(`💀 战败...${playerPet.name} 被击败了。`);
    }
    return { win, log, events };
  }

  // ===== 战斗演出系统 =====
  let battleTimers = [];
  let battleCloseAt = 0; // 战斗弹窗预计关闭的时间戳，用于给其他演出让位

  function clearBattleTimers() {
    battleTimers.forEach((timerId) => clearTimeout(timerId));
    battleTimers = [];
  }

  function scheduleBattle(task, delayMs) {
    const timerId = setTimeout(task, delayMs);
    battleTimers.push(timerId);
    return timerId;
  }

  function setBattleSprite(imgEl, fallbackEl, src) {
    if (imgEl) {
      if (src) {
        imgEl.src = src;
        imgEl.style.display = "";
      } else {
        imgEl.removeAttribute("src");
        imgEl.style.display = "none";
      }
    }
    if (fallbackEl) fallbackEl.hidden = Boolean(src);
  }

  function updateBattleHp(fillEl, numEl, hp, maxHp) {
    const safeMax = Math.max(1, maxHp);
    const ratio = Math.max(0, Math.min(1, hp / safeMax));
    if (fillEl) {
      fillEl.style.width = `${(ratio * 100).toFixed(2)}%`;
      fillEl.classList.toggle("is-low", ratio <= 0.3);
    }
    if (numEl) numEl.textContent = `${Math.max(0, Math.round(hp))}/${safeMax}`;
  }

  function replayBattleAnimation(el, className) {
    if (!el || !className) return;
    el.classList.remove(className);
    void el.offsetWidth; // 强制重排，重启动画
    el.classList.add(className);
  }

  function spawnBattleDamage(side, dmg) {
    if (!els.battleFx || !els.battleStage) return;
    const anchor = side === "player" ? els.battlePlayerSprite : els.battleEnemySprite;
    if (!anchor) return;
    const stageRect = els.battleStage.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const node = document.createElement("span");
    node.className = "battle-damage";
    node.textContent = `-${dmg}`;
    node.style.left = `${rect.left - stageRect.left + rect.width / 2}px`;
    node.style.top = `${rect.top - stageRect.top + rect.height * 0.42}px`;
    els.battleFx.appendChild(node);
    scheduleBattle(() => node.remove(), 900);
  }

  // 把完整事件压缩成不超过 maxTicks 个节拍，最后一拍必须是真实终局
  function buildBattleTicks(events, maxTicks) {
    if (!Array.isArray(events) || events.length === 0) return [];
    if (events.length <= maxTicks) return events.slice();
    const ticks = [];
    const step = (events.length - 1) / (maxTicks - 1);
    for (let i = 0; i < maxTicks; i += 1) {
      const idx = Math.min(events.length - 1, Math.round(i * step));
      ticks.push(events[idx]);
    }
    return ticks;
  }

  function resetBattleStage() {
    [
      els.battleStage,
      els.battlePlayerSide,
      els.battleEnemySide,
      els.battlePlayerSprite,
      els.battleEnemySprite,
      els.battlePlayerHp,
      els.battleEnemyHp,
    ].forEach((el) => {
      if (!el) return;
      el.classList.remove(
        "is-entering-player",
        "is-entering-enemy",
        "is-lunge-player",
        "is-lunge-enemy",
        "is-hit",
        "is-shaking",
        "is-win",
        "is-lose",
        "is-win-glow",
        "is-low",
      );
    });
  }

  // 显示战斗弹窗（双方对峙 + 攻击演出）
  function showBattleModal(playerPet, wildPet, battle) {
    if (!els.battleModal) return;

    clearBattleTimers();
    resetBattleStage();
    if (els.battleFx) els.battleFx.replaceChildren();
    if (els.battleLog) els.battleLog.replaceChildren();

    const win = Boolean(battle && battle.win);
    const events = Array.isArray(battle?.events) ? battle.events : [];
    const logs = Array.isArray(battle?.log) ? battle.log : [];

    const playerMaxHp = Math.max(1, playerPet?.hpMax || 1);
    const enemyMaxHp = Math.max(1, wildPet?.hpMax || 1);
    const finalPlayerHp = events.length ? events[events.length - 1].playerHp : playerMaxHp;
    const finalWildHp = events.length ? events[events.length - 1].wildHp : enemyMaxHp;

    els.battleModal.hidden = false;
    els.battleTitle.textContent = win ? "⚔️ 战斗胜利！" : "⚔️ 战斗失败…";
    els.battleResult.textContent = win
      ? "获得额外经验奖励！"
      : "本次探索收益降低，可能丢失道具！";
    els.battleResult.className = `battle-result ${win ? "win" : "lose"}`;

    if (els.battlePlayerName) els.battlePlayerName.textContent = playerPet?.name || "我方";
    if (els.battlePlayerLv) els.battlePlayerLv.textContent = `Lv.${playerPet?.level || 1}`;
    setBattleSprite(els.battlePlayerImage, els.battlePlayerFallback, playerPet?.image);

    if (els.battleEnemyName) {
      els.battleEnemyName.textContent = `${wildPet?.isShiny ? "✨" : ""}野生 ${
        wildPet?.name || "未知"
      }`;
    }
    if (els.battleEnemyLv) els.battleEnemyLv.textContent = `Lv.${wildPet?.level || 1}`;
    setBattleSprite(els.battleEnemyImage, els.battleEnemyFallback, wildPet?.image);

    updateBattleHp(els.battlePlayerHp, els.battlePlayerHpNum, playerMaxHp, playerMaxHp);
    updateBattleHp(els.battleEnemyHp, els.battleEnemyHpNum, enemyMaxHp, enemyMaxHp);

    // 入场
    replayBattleAnimation(els.battlePlayerSide, "is-entering-player");
    replayBattleAnimation(els.battleEnemySide, "is-entering-enemy");

    const ticks = buildBattleTicks(events, 6);
    const ENTER_MS = 380;
    const SETTLE_MS = 560;
    const beatMs = Math.max(260, Math.min(400, Math.floor(1400 / Math.max(1, ticks.length))));

    let elapsed = ENTER_MS;
    ticks.forEach((tick) => {
      const attackerSprite = tick.side === "player" ? els.battlePlayerSprite : els.battleEnemySprite;
      const defenderSprite = tick.side === "player" ? els.battleEnemySprite : els.battlePlayerSprite;
      const defenderSide = tick.side === "player" ? "enemy" : "player";

      scheduleBattle(() => {
        replayBattleAnimation(
          attackerSprite,
          tick.side === "player" ? "is-lunge-player" : "is-lunge-enemy",
        );
        replayBattleAnimation(els.battleStage, "is-shaking");

        scheduleBattle(() => {
          replayBattleAnimation(defenderSprite, "is-hit");
          spawnBattleDamage(defenderSide, tick.dmg);
          updateBattleHp(els.battlePlayerHp, els.battlePlayerHpNum, tick.playerHp, playerMaxHp);
          updateBattleHp(els.battleEnemyHp, els.battleEnemyHpNum, tick.wildHp, enemyMaxHp);
        }, 130);
      }, elapsed);

      elapsed += beatMs;
    });

    // 终局结算演出
    scheduleBattle(() => {
      updateBattleHp(els.battlePlayerHp, els.battlePlayerHpNum, win ? finalPlayerHp : 0, playerMaxHp);
      updateBattleHp(els.battleEnemyHp, els.battleEnemyHpNum, win ? 0 : finalWildHp, enemyMaxHp);
      if (win) {
        replayBattleAnimation(els.battlePlayerSide, "is-win");
        replayBattleAnimation(els.battleStage, "is-win-glow");
      } else {
        replayBattleAnimation(els.battlePlayerSide, "is-lose");
      }
    }, elapsed);

    // 战斗日志（节奏加快，避免长时间占用课间）
    logs.forEach((line, index) => {
      scheduleBattle(() => {
        const p = document.createElement("p");
        p.textContent = line;
        p.className = "battle-log-line";
        if (els.battleLog) {
          els.battleLog.appendChild(p);
          els.battleLog.scrollTop = els.battleLog.scrollHeight;
        }
      }, ENTER_MS + index * 110);
    });

    // 演出结束后停留，再关闭；关闭时清空定时器，避免堆积误关
    const totalMs = elapsed + SETTLE_MS + 800;
    battleCloseAt = Date.now() + totalMs;
    scheduleBattle(() => {
      if (els.battleModal) els.battleModal.hidden = true;
      battleCloseAt = 0;
      clearBattleTimers();
    }, totalMs);
  }

  // ===== 进化演出 =====
  let evolveTimers = [];

  function clearEvolveTimers() {
    evolveTimers.forEach((timerId) => clearTimeout(timerId));
    evolveTimers = [];
  }

  function scheduleEvolve(task, delayMs) {
    const timerId = setTimeout(task, delayMs);
    evolveTimers.push(timerId);
    return timerId;
  }

  function setEvolveSprite(src) {
    if (!els.evolveSprite) return;
    if (src) {
      els.evolveSprite.src = src;
      els.evolveSprite.style.display = "";
      if (els.evolveSpriteFallback) els.evolveSpriteFallback.hidden = true;
    } else {
      els.evolveSprite.removeAttribute("src");
      els.evolveSprite.style.display = "none";
      if (els.evolveSpriteFallback) els.evolveSpriteFallback.hidden = false;
    }
  }

  function closeEvolveModal() {
    clearEvolveTimers();
    if (!els.evolveModal) return;
    els.evolveModal.hidden = true;
    if (els.evolveCard) els.evolveCard.classList.remove("is-flashing", "is-revealed");
  }

  // 播放进化演出：旧形态蓄光 -> 闪白 -> 新形态弹出（总时长约 2.9 秒，可点击跳过）
  function showEvolutionModal(info) {
    if (!info || !els.evolveModal || !els.evolveCard) return;
    const from = info.from || {};
    const to = info.to || {};

    clearEvolveTimers();
    els.evolveCard.classList.remove("is-revealed");
    if (els.evolveTitle) els.evolveTitle.hidden = true;
    if (els.evolveClose) els.evolveClose.hidden = true;
    if (els.evolveName) els.evolveName.textContent = "";
    if (els.evolveCaption) {
      els.evolveCaption.textContent = `【${from.name || to.name || "宠物"}】正在进化…`;
    }

    setEvolveSprite(from.image);
    els.evolveModal.hidden = false;
    if (els.evolveClose) els.evolveClose.onclick = closeEvolveModal;

    // 白光蓄满 -> 闪白
    scheduleEvolve(() => {
      if (els.evolveCard) els.evolveCard.classList.add("is-flashing");
    }, 880);

    // 换新形态并揭示
    scheduleEvolve(() => {
      setEvolveSprite(to.image);
      if (els.evolveCard) els.evolveCard.classList.add("is-revealed");
      if (els.evolveTitle) {
        els.evolveTitle.hidden = false;
        els.evolveTitle.textContent = "✨ 进化成功！";
      }
      if (els.evolveName) {
        const lv = to.level ? ` Lv.${to.level}` : "";
        els.evolveName.textContent = `【${to.name || "新形态"}】${lv}`;
      }
    }, 1060);

    // 露出"点击继续"
    scheduleEvolve(() => {
      if (els.evolveClose) els.evolveClose.hidden = false;
    }, 2100);

    // 兜底自动收起
    scheduleEvolve(() => {
      closeEvolveModal();
    }, 2900);
  }

  // 给宠物卡片加一次性强调动画
  function flashPetCard(index, className) {
    if (index === undefined || index === null) return;
    setTimeout(() => {
      const card = document.querySelector(`.pet-team-item[data-index="${index}"]`);
      if (!card) return;
      card.classList.remove(className);
      void card.offsetWidth;
      card.classList.add(className);
      setTimeout(() => card.classList.remove(className), 820);
    }, 60);
  }

  // 显示系别克制弹窗
  function showTypeTooltip(type, x, y) {
    const info = getTypeInfo(type);
    els.typeTooltip.innerHTML = `
      <strong>${type}</strong>
      <span class="tt-strong">克制：${info.strong.length > 0 ? info.strong.join("、") : "无"}</span>
      <span class="tt-weak">被克：${info.weak.length > 0 ? info.weak.join("、") : "无"}</span>
    `;
    els.typeTooltip.style.left = `${x}px`;
    els.typeTooltip.style.top = `${y}px`;
    els.typeTooltip.hidden = false;
    els.typeTooltip.classList.remove("fade-out");
    // 1.5秒后淡出
    setTimeout(() => {
      els.typeTooltip.classList.add("fade-out");
      setTimeout(() => {
        els.typeTooltip.hidden = true;
      }, 500);
    }, 1500);
  }

  function getEvolutionLevel(stageNumber, stageData = null) {
    return (
      stageData?.needLevel ||
      PET_EVOLUTION_LEVELS[stageNumber] ||
      Number.MAX_SAFE_INTEGER
    );
  }

  function getMaxEvolutionStage(level, stageCount) {
    let maxStage = 1;
    for (let stage = 2; stage <= stageCount; stage += 1) {
      if (level < getEvolutionLevel(stage)) {
        break;
      }
      maxStage = stage;
    }
    return maxStage;
  }

  function createStoredPet(petTemplate, now, previousPet = null, stage = null) {
    const requestedStage = Math.max(
      1,
      Math.min(petTemplate.stages.length, stage || previousPet?.stage || 1),
    );
    const stageNumber = Math.min(
      requestedStage,
      getMaxEvolutionStage(previousPet?.level || 1, petTemplate.stages.length),
    );
    const stageData = petTemplate.stages[stageNumber - 1] || petTemplate.stages[0];
    // 异色宠物判断
    const isShiny = petTemplate.petId?.startsWith("shiny-") || previousPet?.isShiny;
    // 异色宠物基础资质更强（+30%血量）
    const baseHp = isShiny ? Math.floor(PET_BASE_HP_MAX * 1.3) : PET_BASE_HP_MAX;
    return {
      petId: petTemplate.petId || "",
      stage: stageNumber,
      name: stageData.name,
      image: stageData.image || null,
      desc: stageData.desc || "",
      type: stageData.type || petTemplate.type || "未标注",
      style: stageData.style || petTemplate.style || "初始宠物",
      mark: stageData.mark || petTemplate.mark || stageData.name.slice(0, 1) || "宠",
      level: previousPet?.level || 1,
      hpMax: previousPet?.hpMax || baseHp,
      mpMax: previousPet?.mpMax || PET_BASE_MP_MAX,
      isShiny: !!isShiny,
      hatchedAt: previousPet?.hatchedAt || now,
      bond: clampInteger(previousPet?.bond, 0, 10),
      nickname: typeof previousPet?.nickname === "string" ? previousPet.nickname : "",
    };
  }

  function createEggVisual() {
    const visual = document.createElement("div");
    visual.className = "egg-visual";
    const egg = document.createElement("div");
    egg.className = "egg-core";
    visual.appendChild(egg);
    return visual;
  }

  function createPetVisual(pet) {
    const visual = document.createElement("div");
    visual.className = "pet-card";
    if (pet.isShiny) {
      visual.classList.add("shiny-pet");
      const shinyBadge = document.createElement("div");
      shinyBadge.className = "shiny-badge";
      shinyBadge.textContent = "✨异色";
      visual.appendChild(shinyBadge);
    }
    if (pet.image) {
      const image = document.createElement("img");
      image.className = "pet-avatar";
      image.src = pet.image;
      image.alt = `${pet.name}宠物图片`;
      image.addEventListener("error", () => {
        image.remove();
        visual.appendChild(createPetMark(pet));
      });
      visual.appendChild(image);
      return visual;
    }
    visual.appendChild(createPetMark(pet));
    return visual;
  }

  function createPetMark(pet) {
    const mark = document.createElement("div");
    mark.className = "pet-mark";
    mark.textContent = (pet.mark || pet.name || "宠").slice(0, 1);
    return mark;
  }

  function createEvolutionTrack(petTemplate, currentStage) {
    const track = document.createElement("div");
    track.className = "evolution-track";
    petTemplate.stages.forEach((stage) => {
      const item = document.createElement("div");
      item.className = `evolution-step ${
        stage.stage <= currentStage ? "reached" : "locked"
      }`;

      const image = document.createElement("img");
      image.src = stage.image;
      image.alt = `${stage.name}第${stage.stage}阶段`;

      const name = document.createElement("span");
      name.textContent = `阶段${stage.stage} · ${stage.name}`;

      item.append(image, name);
      track.appendChild(item);
    });
    return track;
  }

  // 道具背包面板：标签页切换场景，紧凑展示
  function createInventoryPanel(profile) {
    const panel = document.createElement("div");
    panel.className = "inventory-panel";

    const heading = document.createElement("h4");
    heading.className = "inventory-heading";
    heading.textContent = "我的背包";
    panel.appendChild(heading);

    // 标签页容器
    const tabs = document.createElement("div");
    tabs.className = "inventory-tabs";

    // 内容容器
    const content = document.createElement("div");
    content.className = "inventory-content";

    let activeTab = 0;

    SCENES.forEach((scene, sceneIndex) => {
      const items = SCENE_ITEMS[scene.id] || [];
      const collected = items.filter((item) => (profile.inventory[item.id] || 0) >= 1).length;
      const bondDone = profile.pet && Array.isArray(profile.pet.bondScenes) && profile.pet.bondScenes.includes(scene.id);

      // 标签按钮
      const tabBtn = document.createElement("button");
      tabBtn.type = "button";
      tabBtn.className = `inventory-tab${sceneIndex === 0 ? " active" : ""}`;
      tabBtn.textContent = `${scene.name} ${collected}/${items.length}`;
      if (bondDone) tabBtn.classList.add("bond-done");
      tabBtn.onclick = () => {
        tabs.querySelectorAll(".inventory-tab").forEach((t) => t.classList.remove("active"));
        tabBtn.classList.add("active");
        content.querySelectorAll(".inventory-scene-group").forEach((g) => (g.hidden = true));
        content.querySelector(`[data-scene-tab="${scene.id}"]`).hidden = false;
      };
      tabs.appendChild(tabBtn);

      // 场景内容
      const sceneGroup = document.createElement("div");
      sceneGroup.className = "inventory-scene-group";
      sceneGroup.dataset.sceneTab = scene.id;
      sceneGroup.hidden = sceneIndex !== 0;

      const sceneHeader = document.createElement("div");
      sceneHeader.className = "inventory-scene-header";

      const sceneName = document.createElement("span");
      sceneName.className = "inventory-scene-name";
      sceneName.textContent = scene.name;

      const progress = document.createElement("span");
      progress.className = "inventory-scene-progress";
      progress.textContent = `${collected}/${items.length}${bondDone ? " · 亲密度已提升" : ""}`;
      if (bondDone) progress.classList.add("bond-done");

      sceneHeader.append(sceneName, progress);
      sceneGroup.appendChild(sceneHeader);

      const itemGrid = document.createElement("div");
      itemGrid.className = "inventory-item-grid";

      items.forEach((item) => {
        const count = profile.inventory[item.id] || 0;
        const itemEl = document.createElement("div");
        itemEl.className = `inventory-item ${count > 0 ? "owned" : "locked"}`;
        itemEl.title = `${item.name}：${item.desc}（持有 ${count} 个）`;

        const iconWrap = document.createElement("div");
        iconWrap.className = "inventory-item-icon";
        iconWrap.innerHTML = item.icon;

        const itemName = document.createElement("span");
        itemName.className = "inventory-item-name";
        itemName.textContent = item.name;

        const itemCount = document.createElement("span");
        itemCount.className = "inventory-item-count";
        itemCount.textContent = count > 0 ? `×${count}` : "未获得";

        itemEl.append(iconWrap, itemName, itemCount);
        itemGrid.appendChild(itemEl);
      });

      sceneGroup.appendChild(itemGrid);
      content.appendChild(sceneGroup);
    });

    panel.append(tabs, content);
    return panel;
  }

  function createHatchTags(tags) {
    const wrapper = document.createElement("div");
    wrapper.className = "hatch-tags";
    tags.forEach((tag) => {
      const item = document.createElement("span");
      item.textContent = tag;
      wrapper.appendChild(item);
    });
    return wrapper;
  }

  function setResult(message, warning) {
    resultMessage = message;
    resultIsWarning = warning;
  }

  function setTeacherMessage(message, warning) {
    els.teacherMessage.textContent = message;
    els.teacherMessage.classList.toggle("warning", warning);
  }

  function getActiveProfile() {
    return state.profiles.find((profile) => profile.id === state.selectedId) || null;
  }

  function getScene(id) {
    return SCENES.find((scene) => scene.id === id) || null;
  }

  // 判断场景是否对当前角色解锁（根据宠物亲密度和宠物数量）
  function isSceneUnlocked(scene, profile) {
    if (!scene) return false;
    const bond = profile?.pet?.bond || 0;
    const petCount = profile?.pets?.length || (profile?.pet ? 1 : 0);
    const hasEgg = profile?.egg?.granted;
    // 第一个场景（轻风草原）：有宠物蛋即可进入，方便新手先探索赚经验孵蛋
    const requiredPets = scene.id === "grassland" ? 0 : (SCENE_PET_REQUIREMENT[scene.id] || 1);
    return bond >= (scene.bondRequired || 0) && (petCount >= requiredPets || (scene.id === "grassland" && hasEgg));
  }

  // 获取场景锁定原因
  function getSceneLockReason(scene, profile) {
    if (!scene) return "未知";
    const bond = profile?.pet?.bond || 0;
    const petCount = profile?.pets?.length || (profile?.pet ? 1 : 0);
    const hasEgg = profile?.egg?.granted;
    const requiredPets = scene.id === "grassland" ? 0 : (SCENE_PET_REQUIREMENT[scene.id] || 1);
    if (bond < (scene.bondRequired || 0)) {
      return `亲密度 Lv.${scene.bondRequired} 解锁`;
    }
    if (petCount < requiredPets && !(scene.id === "grassland" && hasEgg)) {
      return `需要 ${requiredPets} 只宠物（当前${petCount}只）`;
    }
    return null;
  }

  function formatRange(range) {
    return `${range[0]}-${range[1]}`;
  }

  function genderLabel(gender) {
    return gender === "female" ? "女" : "男";
  }

  function hatchStyleText(gender) {
    return gender === "female" ? "可爱 / 软萌 / 唯美系" : "帅气 / 威风 / 酷系";
  }

  function hatchTags(gender) {
    return gender === "female" ? ["可爱系", "软萌系", "唯美系"] : ["帅气系", "威风系", "酷系"];
  }

  function randomItem(list) {
    return list[randomInt(0, list.length - 1)];
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sanitizeName(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 12);
  }

  function clampInteger(value, min, max) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
  }

  function sceneArt(id) {
    if (id === "grassland") {
      return `
        <svg viewBox="0 0 220 92" role="img" aria-label="轻风草原">
          <circle cx="184" cy="21" r="13" fill="#f7d86b" />
          <path d="M0 62 C48 42 76 75 118 52 C158 31 184 50 220 39 V92 H0 Z" fill="#4f9f64" opacity="0.95" />
          <path d="M17 74 C52 58 83 80 116 66 C148 52 181 61 214 52" fill="none" stroke="#e8f7d9" stroke-width="4" />
          <path d="M36 48 C51 37 66 37 81 48" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.72" />
        </svg>`;
    }
    if (id === "volcano") {
      return `
        <svg viewBox="0 0 220 92" role="img" aria-label="维苏威火山">
          <path d="M45 92 L98 18 L123 52 L151 16 L202 92 Z" fill="#783626" />
          <path d="M99 19 L113 36 L123 52 L132 36 L151 16 L161 31 L127 45 Z" fill="#ffd2a6" />
          <path d="M0 74 C56 58 108 80 160 63 C183 55 201 55 220 60 V92 H0 Z" fill="#c65a42" />
          <circle cx="64" cy="21" r="10" fill="#ffb152" opacity="0.84" />
        </svg>`;
    }
    if (id === "mermaid-bay") {
      return `
        <svg viewBox="0 0 220 92" role="img" aria-label="人鱼湾">
          <path d="M0 56 C35 43 63 70 102 55 C137 42 166 51 220 40 V92 H0 Z" fill="#3285b9" />
          <path d="M12 69 C43 55 69 79 103 65 C139 50 166 61 209 49" fill="none" stroke="#d9fbff" stroke-width="4" stroke-linecap="round" />
          <path d="M120 34 C132 24 146 24 158 34 C146 40 132 40 120 34 Z" fill="#f7d1cf" />
          <circle cx="42" cy="25" r="12" fill="#e9fbff" opacity="0.76" />
        </svg>`;
    }
    if (id === "academy") {
      return `
        <svg viewBox="0 0 220 92" role="img" aria-label="皇家研究院">
          <path d="M31 82 H190 V92 H31 Z" fill="#837c70" />
          <path d="M50 38 H171 V82 H50 Z" fill="#f8f4e9" />
          <path d="M42 38 L110 14 L179 38 Z" fill="#c48a26" />
          <path d="M72 51 H92 V82 H72 Z M102 51 H122 V82 H102 Z M132 51 H152 V82 H132 Z" fill="#b8dbea" />
          <circle cx="110" cy="32" r="7" fill="#ffffff" />
        </svg>`;
    }
    if (id === "snow-valley") {
      return `
        <svg viewBox="0 0 220 92" role="img" aria-label="雪人谷">
          <path d="M0 71 C37 51 68 70 100 48 C136 24 179 39 220 19 V92 H0 Z" fill="#dff7fb" />
          <path d="M21 78 C62 55 92 74 127 55 C158 38 188 42 215 33" fill="none" stroke="#72aeb9" stroke-width="4" />
          <circle cx="66" cy="39" r="9" fill="#ffffff" />
          <circle cx="66" cy="56" r="14" fill="#ffffff" />
          <circle cx="68" cy="37" r="1.7" fill="#232323" />
        </svg>`;
    }
    return `
      <svg viewBox="0 0 220 92" role="img" aria-label="锁定场景">
        <path d="M0 68 C40 52 78 70 111 54 C145 38 178 50 220 34 V92 H0 Z" fill="#aca69c" />
        <rect x="87" y="36" width="46" height="34" rx="6" fill="#6f6a64" />
        <path d="M96 36 V27 C96 18 102 12 110 12 C118 12 124 18 124 27 V36" fill="none" stroke="#6f6a64" stroke-width="8" stroke-linecap="round" />
        <circle cx="110" cy="53" r="4" fill="#ffffff" />
      </svg>`;
  }

  // ============================================
  // 多宠物系统
  // ============================================
  function getActivePet(profile) {
    if (!profile || !profile.pets || profile.pets.length === 0) return null;
    const idx = Math.min(profile.activePetIndex || 0, profile.pets.length - 1);
    return profile.pets[idx];
  }

  function syncActivePet(profile) {
    // 同步profile.pet为当前出战宠物（兼容旧代码）
    const active = getActivePet(profile);
    profile.pet = active;
  }

  function renderPetTeam(profile) {
    if (!els.petTeamList) return;
    els.petTeamList.replaceChildren();

    if (!profile.pets || profile.pets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pet-team-empty";
      empty.textContent = "暂无宠物，先孵化或捕捉一只吧！";
      els.petTeamList.appendChild(empty);
      return;
    }

    profile.pets.forEach((pet, index) => {
      const card = document.createElement("div");
      card.className = `pet-team-item${index === profile.activePetIndex ? " active" : ""}`;
      card.dataset.index = index;

      const header = document.createElement("div");
      header.className = "pet-team-header";

      const img = document.createElement("img");
      img.src = pet.image || "";
      img.alt = pet.name;
      img.className = "pet-team-img";
      img.onerror = () => { img.style.display = "none"; };

      const nameDiv = document.createElement("div");
      nameDiv.className = "pet-team-meta";
      const name = document.createElement("div");
      name.className = "pet-team-name";
      name.textContent = pet.nickname ? `${pet.name}（${pet.nickname}）` : pet.name;
      const level = document.createElement("div");
      level.className = "pet-team-level";
      level.textContent = `Lv.${pet.level} · ${pet.type}`;
      nameDiv.append(name, level);

      header.append(img, nameDiv);

      const bond = document.createElement("div");
      bond.className = "pet-team-bond";
      bond.textContent = `亲密度 ${pet.bond || 0}/10`;

      // 操作按钮区域
      const actions = document.createElement("div");
      actions.className = "pet-team-actions";

      // 第一行：主要操作
      const row1 = document.createElement("div");
      row1.className = "pet-team-row";

      if (index === 0) {
        // 第一只宠物：刷新按钮
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "btn-switch";
        refreshBtn.textContent = "🔄 刷新";
        refreshBtn.title = "消耗1行动点随机更换宠物";
        refreshBtn.dataset.action = "refresh";
        refreshBtn.dataset.index = index;
        row1.appendChild(refreshBtn);
      } else {
        // 其他宠物：放生按钮
        const releaseBtn = document.createElement("button");
        releaseBtn.className = "btn-release";
        releaseBtn.textContent = "放生";
        releaseBtn.title = "放生这只宠物";
        releaseBtn.dataset.action = "release";
        releaseBtn.dataset.index = index;
        row1.appendChild(releaseBtn);
      }

      if (index !== profile.activePetIndex) {
        const switchBtn = document.createElement("button");
        switchBtn.className = "btn-switch";
        switchBtn.textContent = "⚔️ 出战";
        switchBtn.dataset.action = "switch";
        switchBtn.dataset.index = index;
        row1.appendChild(switchBtn);
      } else {
        const activeTag = document.createElement("span");
        activeTag.className = "pet-team-active-tag";
        activeTag.textContent = "✓ 出战中";
        row1.appendChild(activeTag);
      }

      // 第二行：亲密度和昵称
      const row2 = document.createElement("div");
      row2.className = "pet-team-row";

      // 提升亲密度按钮（检查是否有场景道具集齐）
      const bondScene = findBondScene(profile, pet);
      const bondBtn = document.createElement("button");
      bondBtn.className = "btn-bond";
      bondBtn.dataset.action = "bond";
      bondBtn.dataset.index = index;
      if (bondScene) {
        bondBtn.textContent = `💕 提升亲密度（${bondScene.name}）`;
        bondBtn.title = `消耗${bondScene.name}的4个道具，提升1级亲密度`;
        bondBtn.disabled = false;
      } else {
        bondBtn.textContent = "💕 提升亲密度";
        bondBtn.title = "集齐任意场景的4个道具后可提升亲密度";
        bondBtn.disabled = true;
      }
      row2.appendChild(bondBtn);

      // 修改昵称按钮（亲密度>=3解锁）
      const renameBtn = document.createElement("button");
      renameBtn.className = "btn-rename";
      renameBtn.dataset.action = "rename";
      renameBtn.dataset.index = index;
      if ((pet.bond || 0) >= BOND_NAME_UNLOCK_LEVEL) {
        renameBtn.textContent = "✏️ 修改昵称";
        renameBtn.disabled = false;
      } else {
        renameBtn.textContent = `✏️ 昵称（亲密度${BOND_NAME_UNLOCK_LEVEL}解锁）`;
        renameBtn.disabled = true;
      }
      row2.appendChild(renameBtn);

      actions.append(row1, row2);
      card.append(header, bond, actions);
      els.petTeamList.appendChild(card);
    });
  }

  // 查找可以提升亲密度的场景
  function findBondScene(profile, pet) {
    for (const scene of SCENES) {
      const items = SCENE_ITEMS[scene.id] || [];
      const allCollected = items.every(item => (profile.inventory[item.id] || 0) >= 1);
      const bondDone = pet.bondScenes?.includes(scene.id);
      if (allCollected && !bondDone) {
        return scene;
      }
    }
    return null;
  }

  function handlePetTeamClick(event) {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const index = parseInt(btn.dataset.index);
    const profile = getActiveProfile();
    if (!profile) return;

    if (action === "switch") {
      profile.activePetIndex = index;
      syncActivePet(profile);
      saveState("已切换出战宠物");
      render();
      flashPetCard(index, "is-switching");
    } else if (action === "release") {
      if (profile.pets.length <= 1) {
        showResult("至少需要保留一只宠物！", true);
        return;
      }
      if (confirm(`确定要放生 ${profile.pets[index].name} 吗？放生后不可恢复！`)) {
        profile.pets.splice(index, 1);
        if (profile.activePetIndex >= profile.pets.length) {
          profile.activePetIndex = profile.pets.length - 1;
        }
        syncActivePet(profile);
        saveState("宠物已放生");
        render();
      }
    } else if (action === "refresh") {
      if (profile.actionPoints < 1) {
        showResult("行动点不足！", true);
        return;
      }
      profile.actionPoints -= 1;
      const newPet = createRandomPet();
      profile.pets[0] = newPet;
      profile.activePetIndex = 0;
      syncActivePet(profile);
      saveState("已刷新宠物");
      render();
    } else if (action === "bond") {
      // 手动提升亲密度
      const pet = profile.pets[index];
      const bondScene = findBondScene(profile, pet);
      if (!bondScene) {
        showResult("没有可提升亲密度的场景，请先集齐道具！", true);
        return;
      }
      // 消耗道具，提升亲密度
      const items = SCENE_ITEMS[bondScene.id] || [];
      items.forEach((item) => {
        const count = profile.inventory[item.id] || 0;
        if (count > 1) {
          profile.inventory[item.id] = count - 1;
        } else {
          delete profile.inventory[item.id];
        }
      });
      pet.bond = Math.min(10, (pet.bond || 0) + 1);
      if (!Array.isArray(pet.bondScenes)) {
        pet.bondScenes = [];
      }
      pet.bondScenes.push(bondScene.id);
      syncActivePet(profile);
      saveState("亲密度已提升");
      showToast("💕 亲密度提升！", `${pet.name}的亲密度提升至 Lv.${pet.bond}！`, "success");
      render();
    } else if (action === "rename") {
      // 修改昵称
      const pet = profile.pets[index];
      if ((pet.bond || 0) < BOND_NAME_UNLOCK_LEVEL) {
        showResult(`亲密度不足，修改昵称需要达到 Lv.${BOND_NAME_UNLOCK_LEVEL}。`, true);
        return;
      }
      const current = pet.nickname || "";
      const input = window.prompt(
        `为【${pet.name}】设置昵称（最多8个字，留空则清除昵称）：`,
        current,
      );
      if (input === null) return;
      pet.nickname = input.trim().slice(0, 8);
      syncActivePet(profile);
      saveState("昵称已修改");
      showToast("✏️ 昵称已修改", `${pet.name}的昵称已设置为「${pet.nickname || "无"}」`, "success");
      render();
    }
  }

  function createRandomPet() {
    const pool = PET_POOL.length > 0 ? PET_POOL : FALLBACK_PET_POOL;
    const template = pool[Math.floor(Math.random() * pool.length)];
    const stageData = template.stages?.[0] || template;
    return normalizePet({
      petId: template.petId,
      stage: 1,
      name: stageData.name || template.name,
      image: stageData.image || template.image,
      desc: stageData.desc || template.desc || "",
      type: stageData.type || template.type || "未标注",
      style: template.style || "初始宠物",
      level: 1,
      exp: 0,
      bond: 0,
      nickname: null,
    });
  }

  // ============================================
  // 捕捉系统
  // ============================================
  function showCaptureModal(wildPet) {
    captureTarget = wildPet;
    if (!els.captureModal) return;

    els.capturePetImage.src = wildPet.image || "";
    els.capturePetImage.onerror = () => { els.capturePetImage.style.display = "none"; };
    els.capturePetName.textContent = wildPet.name;
    els.capturePetLevel.textContent = `Lv.${wildPet.level}`;
    els.capturePetType.textContent = wildPet.type;
    els.captureResult.textContent = "";

    // 异色稀有标识
    if (els.captureShinyLabel) {
      els.captureShinyLabel.style.display = wildPet.isShiny ? "inline-block" : "none";
    }

    renderCaptureBalls();
    els.captureModal.hidden = false;
  }

  function renderCaptureBalls() {
    if (!els.captureBallList) return;
    els.captureBallList.replaceChildren();
    const profile = getActiveProfile();
    if (!profile) return;

    BALL_TYPES.forEach((ball) => {
      const count = profile.balls?.[ball.id] || 0;
      const item = document.createElement("div");
      item.className = `capture-ball-item${count === 0 ? " disabled" : ""}`;
      item.dataset.ballId = ball.id;
      item.style.setProperty("--ball-color", ball.color);

      const icon = document.createElement("div");
      icon.className = "capture-ball-icon";
      icon.textContent = "⚪";

      const info = document.createElement("div");
      info.className = "capture-ball-info";
      info.innerHTML = `<strong>${ball.name}</strong><span>${ball.desc} · 拥有 ${count} 个</span>`;

      item.append(icon, info);
      els.captureBallList.appendChild(item);
    });
  }

  function handleCaptureBallClick(event) {
    const item = event.target.closest(".capture-ball-item");
    if (!item || item.classList.contains("disabled")) return;
    const ballId = item.dataset.ballId;
    const ball = BALL_TYPES.find(b => b.id === ballId);
    const profile = getActiveProfile();
    if (!ball || !profile || !captureTarget) return;

    // 消耗咕噜球
    if (!profile.balls) profile.balls = {};
    profile.balls[ballId] = (profile.balls[ballId] || 0) - 1;
    if (profile.balls[ballId] <= 0) delete profile.balls[ballId];

    // 计算捕捉成功率（野生宠物等级越高，越难捕捉）
    const levelPenalty = Math.max(0, (captureTarget.level - 5) * 0.01);
    const successRate = Math.max(0.01, ball.catchRate - levelPenalty);
    const success = Math.random() < successRate;

    if (success) {
      // 捕捉成功：宠物降为1级0阶段
      if (profile.pets.length >= 3) {
        els.captureResult.textContent = "宠物栏已满（最多3只），无法捕捉！";
        return;
      }
      const petCountBefore = profile.pets.length;
      const newPet = normalizePet({
        petId: captureTarget.petId,
        stage: 1,
        name: captureTarget.name,
        image: captureTarget.image,
        desc: captureTarget.desc,
        type: captureTarget.type,
        style: captureTarget.style,
        level: 1,
        exp: 0,
        bond: 0,
        isShiny: !!captureTarget.isShiny,
        nickname: null,
      });
      profile.pets.push(newPet);
      syncActivePet(profile);
      els.captureResult.textContent = `🎉 捕捉成功！${captureTarget.name} 加入了你的队伍！`;
      saveState("捕捉成功");

      // 捕捉到第二只宠物后提示排行榜
      if (petCountBefore < 2 && profile.pets.length >= 2) {
        setTimeout(() => {
          showToast(
            "🏆 排行榜解锁！",
            "你有2只宠物了！战力排行榜按三只宠物战力总和排名，去看看你的排名吧！",
            "success",
            6000
          );
        }, 2000);
      }

      setTimeout(() => {
        closeCaptureModal();
        render();
      }, 1500);
    } else {
      els.captureResult.textContent = `💨 捕捉失败！${captureTarget.name} 逃跑了...`;
      saveState("捕捉失败");
      setTimeout(() => {
        closeCaptureModal();
      }, 1500);
    }
    renderCaptureBalls();
  }

  function closeCaptureModal() {
    if (els.captureModal) els.captureModal.hidden = true;
    captureTarget = null;
  }

  // ============================================
  // 计时器系统
  // ============================================
  function startTimer() {
    if (timerInterval) return;
    timerStarted = true;
    updateTimerButtons();
    timerInterval = setInterval(() => {
      timerSeconds--;
      updateTimerDisplay();
      if (timerSeconds <= 0) {
        pauseTimer();
        playTimerSound();
        timerSeconds = 0;
        updateTimerDisplay();
      }
    }, 1000);
  }

  function pauseTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function resetTimer() {
    pauseTimer();
    timerSeconds = TIMER_DURATION;
    timerStarted = false;
    updateTimerDisplay();
    updateTimerButtons();
  }

  // 加时间：扣20行动点，加30秒，只有未启动时才能加
  function addTimerTime() {
    if (timerStarted) {
      showToast("⏱ 计时器已启动", "请先重置后再加时间", "warning");
      return;
    }
    const profile = getActiveProfile();
    if (!profile) return;
    if (profile.actionPoints < 20) {
      showToast("❌ 行动点不足", "加30秒需要20个行动点", "warning");
      return;
    }
    profile.actionPoints -= 20;
    timerSeconds += 30;
    saveState("加时成功");
    updateTimerDisplay();
    showToast("⏱ 加时成功", "+30秒！当前剩余" + Math.floor(timerSeconds/60) + "分" + (timerSeconds%60) + "秒", "success");
  }

  // 更新计时器按钮状态：已启动后禁用加时间按钮
  function updateTimerButtons() {
    if (!els.timerAddBtn) return;
    els.timerAddBtn.disabled = timerStarted;
    els.timerAddBtn.style.opacity = timerStarted ? "0.5" : "1";
  }

  function updateTimerDisplay() {
    if (!els.timerDisplay) return;
    const min = Math.floor(timerSeconds / 60);
    const sec = timerSeconds % 60;
    els.timerDisplay.textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function playTimerSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.frequency.value = 800;
      oscillator.type = "sine";
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 1);
    } catch (e) {
      // 忽略音频错误
    }
  }

  // ============================================
  // 排行榜系统（视图版）
  // ============================================
  async function renderRankView() {
    if (!els.rankContent) return;
    els.rankContent.replaceChildren();

    // 排行榜从云端拉全班，保证每个同学看到的都是同一张榜
    let sourceProfiles = state.profiles;
    if (CLOUD_ENABLED) {
      try {
        const rows = await cloudGetAllStudents();
        if (Array.isArray(rows) && rows.length) {
          sourceProfiles = rows.map((row) => profileFromCloud(row));
        }
      } catch (error) {
        console.warn("读取云端排行榜失败（先显示本地数据）", error);
      }
    }
    if (!els.rankContent) return;
    els.rankContent.replaceChildren();

    const profiles = sourceProfiles
      .filter((p) => p && p.name)
      .map(p => {
        const pets = p.pets || [];
        const totalPower = pets.reduce((sum, pet) => sum + getPetPower(pet), 0);
        return {
          name: p.name,
          power: totalPower,
          petCount: pets.length,
          maxLevel: pets.length ? Math.max(...pets.map(pet => pet.level)) : 0,
        };
      })
      .sort((a, b) => b.power - a.power);

    profiles.forEach((p, index) => {
      const item = document.createElement("div");
      item.className = `rank-item${index < 3 ? ` top${index + 1}` : ""}`;

      const num = document.createElement("span");
      num.className = "rank-num";
      num.textContent = index + 1;

      const info = document.createElement("div");
      info.className = "rank-info";

      const name = document.createElement("div");
      name.className = "rank-name";
      const me = getActiveProfile();
      name.textContent = me && me.name === p.name ? `${p.name}（我）` : p.name;

      const sub = document.createElement("div");
      sub.className = "rank-sub";
      sub.textContent =
        p.petCount > 0 ? `${p.petCount}只宠物 · 最高Lv.${p.maxLevel}` : "还没有宠物";

      info.append(name, sub);

      const value = document.createElement("span");
      value.className = "rank-value";
      value.textContent = `战力 ${p.power}`;

      item.append(num, info, value);
      els.rankContent.appendChild(item);
    });

    if (profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rank-item";
      empty.style.justifyContent = "center";
      empty.style.color = "var(--muted)";
      empty.textContent = "暂无排行数据";
      els.rankContent.appendChild(empty);
    }
  }

  async function publishRankReward() {
    // 以云端全班名单为准发奖，保证每个孩子都真的收到
    let sourceProfiles = state.profiles;
    if (CLOUD_ENABLED) {
      try {
        const rows = await cloudGetAllStudents();
        if (Array.isArray(rows) && rows.length) {
          sourceProfiles = rows.map((row) => profileFromCloud(row));
        }
      } catch (error) {
        console.warn("读取云端全班名单失败（改用本地名单发奖）", error);
      }
    }

    const profiles = sourceProfiles
      .filter(p => p.pets && p.pets.length > 0)
      .map(p => ({
        id: p.id,
        name: p.name,
        power: p.pets.reduce((sum, pet) => sum + getPetPower(pet), 0),
      }))
      .sort((a, b) => b.power - a.power);

    let rewardMsg = [];
    const changed = [];
    profiles.forEach((p, index) => {
      let reward = 5;
      if (index < 3) reward = 20;
      else if (index < 10) reward = 15;
      else if (index < 30) reward = 10;

      const profile = sourceProfiles.find(pr => pr.id === p.id) ||
        sourceProfiles.find(pr => pr.name === p.name);
      if (profile) {
        profile.actionPoints = (profile.actionPoints || 0) + reward;
        rewardMsg.push(`${p.name}: +${reward}行动点`);
        changed.push(profile);
      }
    });

    // 写回云端
    if (CLOUD_ENABLED) {
      for (const profile of changed) {
        try {
          await cloudUpsertStudent(profile.name, profile.pass, profile);
        } catch (error) {
          console.warn(`发奖写回云端失败：${profile.name}`, error);
        }
      }
    }

    // 老师端本地列表也同步一份，界面显示一致
    changed.forEach((profile) => {
      const local = state.profiles.find(pr => pr.name === profile.name);
      if (local) {
        local.actionPoints = profile.actionPoints;
      }
    });

    saveState("排行榜奖励已发布");
    if (els.rankRewardResult) {
      els.rankRewardResult.textContent = `✅ 已发布奖励！共${profiles.length}人获得奖励（已写入云端）。`;
    }
    render();
  }

  // ============================================
  // 新手引导系统
  // ============================================
  function startGuide() {
    currentGuideStep = guideStartIndex;
    renderGuideStep();
    if (els.guideOverlay) els.guideOverlay.hidden = false;
  }

  function renderGuideStep() {
    const step = GUIDE_STEPS[currentGuideStep];
    if (!step) return;
    if (els.guideStep) els.guideStep.textContent = `${currentGuideStep + 1} / ${GUIDE_STEPS.length}`;
    if (els.guideTitle) els.guideTitle.textContent = step.title;
    if (els.guideDesc) els.guideDesc.textContent = step.desc;
    if (els.guideHighlight) els.guideHighlight.textContent = step.highlight;
    if (els.guidePrev) els.guidePrev.disabled = currentGuideStep === 0;
    if (els.guideNext) els.guideNext.textContent = currentGuideStep === GUIDE_STEPS.length - 1 ? "完成" : "下一步";
  }

  function nextGuideStep() {
    if (currentGuideStep < GUIDE_STEPS.length - 1) {
      currentGuideStep++;
      renderGuideStep();
    } else {
      skipGuide();
    }
  }

  function prevGuideStep() {
    if (currentGuideStep > 0) {
      currentGuideStep--;
      renderGuideStep();
    }
  }

  function skipGuide() {
    if (els.guideOverlay) els.guideOverlay.hidden = true;
    const profile = getActiveProfile();
    if (profile) {
      profile.guideCompleted = true;
      saveState("引导已跳过");
    }
  }

  function handleResetGuide() {
    const profile = getActiveProfile();
    if (!profile) return;
    profile.guideCompleted = false;
    saveState("引导已重置");
    if (els.teacherMessage) els.teacherMessage.textContent = "已重置该学生的引导状态";
    startGuide();
  }

  // ============================================
  // 咕噜球商店
  // ============================================
  function renderBallShop(profile) {
    if (!els.shopContent) return;
    els.shopContent.replaceChildren();

    const header = document.createElement("div");
    header.className = "shop-header";
    header.innerHTML = `<h3>咕噜球商店</h3><p>用行动点购买咕噜球，用于捕捉野生宠物</p><p>当前行动点: <strong>${profile.actionPoints}</strong></p>`;
    els.shopContent.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "ball-shop-grid";

    BALL_TYPES.forEach((ball) => {
      const count = profile.balls?.[ball.id] || 0;
      const card = document.createElement("div");
      card.className = "ball-shop-card";
      card.style.setProperty("--ball-color", ball.color);

      const icon = document.createElement("div");
      icon.className = "ball-shop-icon";
      icon.textContent = "⚪";

      const name = document.createElement("div");
      name.className = "ball-shop-name";
      name.textContent = ball.name;

      const desc = document.createElement("div");
      desc.className = "ball-shop-desc";
      desc.textContent = ball.desc;

      const owned = document.createElement("div");
      owned.className = "ball-shop-owned";
      owned.textContent = `拥有: ${count}`;

      const buyBtn = document.createElement("button");
      buyBtn.className = "ball-shop-buy";
      buyBtn.textContent = `购买 (${ball.price}行动点)`;
      buyBtn.dataset.ballId = ball.id;
      buyBtn.disabled = profile.actionPoints < ball.price;

      card.append(icon, name, desc, owned, buyBtn);
      grid.appendChild(card);
    });

    els.shopContent.appendChild(grid);
  }

  function buyBall(ballId) {
    const profile = getActiveProfile();
    const ball = BALL_TYPES.find(b => b.id === ballId);
    if (!profile || !ball) return;
    if (profile.actionPoints < ball.price) {
      showResult("行动点不足！", true);
      return;
    }
    profile.actionPoints -= ball.price;
    if (!profile.balls) profile.balls = {};
    profile.balls[ballId] = (profile.balls[ballId] || 0) + 1;
    saveState("购买成功");
    renderShop("balls");
  }

  // ============================================
  // 辅助函数
  // ============================================
  function getActiveProfile() {
    if (!state || !state.profiles) return null;
    const profile = state.profiles.find(p => p.id === state.selectedId) || null;
    // 确保profile.pet始终指向pets数组中的出战宠物（保持引用一致）
    if (profile && profile.pets && profile.pets.length > 0) {
      const idx = Math.min(profile.activePetIndex || 0, profile.pets.length - 1);
      profile.activePetIndex = idx;
      profile.pet = profile.pets[idx];
    }
    return profile;
  }

  function showResult(message, warning = false) {
    if (els.resultMessage) {
      els.resultMessage.textContent = message;
      els.resultMessage.className = `result-message global-result${warning ? " warning" : ""}`;
    }
  }

  // 重写renderShop支持咕噜球标签
  const _originalRenderShop = renderShop;
  renderShop = async function(tab) {
    currentShopTab = tab;
    if (els.shopTabMarket) els.shopTabMarket.classList.toggle("active", tab === "market");
    if (els.shopTabSell) els.shopTabSell.classList.toggle("active", tab === "sell");
    if (els.shopTabMine) els.shopTabMine.classList.toggle("active", tab === "mine");
    if (els.shopTabBalls) els.shopTabBalls.classList.toggle("active", tab === "balls");

    const profile = getActiveProfile();
    if (!profile) return;

    if (tab === "balls") {
      renderBallShop(profile);
    } else {
      await _originalRenderShop(tab);
    }
  };

  // 重写handleShopAction支持购买咕噜球
  const _originalHandleShopAction = handleShopAction;
  handleShopAction = async function(event) {
    const buyBtn = event.target.closest(".ball-shop-buy");
    if (buyBtn) {
      buyBall(buyBtn.dataset.ballId);
      return;
    }
    await _originalHandleShopAction(event);
  };

  // 重写switchView支持排行榜视图
  const _originalSwitchView = switchView;
  switchView = function(view) {
    currentView = view;
    if (els.worldView) els.worldView.hidden = view !== "world";
    if (els.sceneView) els.sceneView.hidden = view !== "scene";
    if (els.shopView) els.shopView.hidden = view !== "shop";
    if (els.rankView) els.rankView.hidden = view !== "rank";

    if (els.navWorld) els.navWorld.classList.toggle("active", view === "world");
    if (els.navShop) els.navShop.classList.toggle("active", view === "shop");
    if (els.navRank) els.navRank.classList.toggle("active", view === "rank");

    if (view === "shop") renderShop(currentShopTab);
    if (view === "rank") renderRankView();
    render(); // 调用render渲染场景内部等内容
  };

  // 重写render函数，添加宠物栏渲染和引导检查
  const _originalRender = render;
  render = function() {
    _originalRender();
    const profile = getActiveProfile();
    if (profile) {
      renderPetTeam(profile);
      syncActivePet(profile);
      // 检查是否需要显示引导
      if (!profile.guideCompleted && els.guideOverlay && els.guideOverlay.hidden) {
        // 延迟显示，让页面先渲染
        setTimeout(() => {
          if (!profile.guideCompleted) startGuide();
        }, 500);
      }
    }
  };

  // 重写handleProfileSelect，切换角色时重置计时器
  const _originalHandleProfileSelect = handleProfileSelect;
  handleProfileSelect = function(event) {
    _originalHandleProfileSelect(event);
    resetTimer();
  };

  // ============================================
  // 智能提示系统 (Toast)
  // ============================================
  function showToast(title, message, type = "info", duration = 4000) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    // 防止重复提示（3秒内相同标题不重复）
    const now = Date.now();
    if (lastToastTime[title] && now - lastToastTime[title] < 3000) return;
    lastToastTime[title] = now;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    const icons = {
      info: "💡",
      success: "✅",
      warning: "⚠️",
      error: "❌"
    };

    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <div class="toast-content">
        <div class="toast-title">${title}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close" type="button">×</button>
      <div class="toast-progress"></div>
    `;

    container.appendChild(toast);

    // 关闭按钮
    toast.querySelector(".toast-close").addEventListener("click", () => {
      removeToast(toast);
    });

    // 自动消失
    setTimeout(() => {
      removeToast(toast);
    }, duration);
  }

  function removeToast(toast) {
    if (!toast || toast.classList.contains("toast-out")) return;
    toast.classList.add("toast-out");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }

  // 智能提示检查：根据游戏状态触发相应提示
  function checkSmartTips(profile, context = {}) {
    if (!profile) return;

    // 1. 道具集齐提示（可以升级亲密度了）
    if (context.sceneId) {
      const items = SCENE_ITEMS[context.sceneId] || [];
      const collected = items.filter(item => (profile.inventory[item.id] || 0) >= 1).length;
      const scene = SCENES.find(s => s.id === context.sceneId);
      const bondDone = profile.pet?.bondScenes?.includes(context.sceneId);

      if (collected === items.length && !bondDone) {
        showToast(
          "🎉 道具集齐！",
          `${scene?.name || "该场景"}的4个道具已集齐，亲密度自动提升！`,
          "success"
        );
      } else if (collected === items.length - 1 && !bondDone) {
        // 只差一个道具时提示
        const missing = items.find(item => (profile.inventory[item.id] || 0) === 0);
        if (missing) {
          showToast(
            "📦 快集齐了！",
            `还差【${missing.name}】就能集齐${scene?.name || "该场景"}道具提升亲密度！`,
            "info",
            3000
          );
        }
      }
    }

    // 2. 道具只剩一个时提示去商店
    if (context.itemLow) {
      showToast(
        "🛒 道具不足",
        "你的道具快用完了，去商店看看吧！",
        "warning",
        3000
      );
    }

    // 3. 遇到野生宠物但没有咕噜球时提示
    if (context.encounterWild && !hasAnyBall(profile)) {
      showToast(
        "⚾ 没有咕噜球！",
        "遇到野生宠物了，但你没有咕噜球。可以在捕捉窗口临时购买（贵5行动点），或去商店购买。",
        "warning",
        5000
      );
    }

    // 4. 战斗没跳过提示
    if (context.battleStart) {
      showToast(
        "⚔️ 战斗开始！",
        "战斗结果会自动结算，经验马上到账。",
        "info",
        3000
      );
    }
  }

  function hasAnyBall(profile) {
    if (!profile.balls) return false;
    return Object.values(profile.balls).some(count => count > 0);
  }

  // ============================================
  // 临时购买咕噜球功能
  // ============================================
  function renderCaptureBalls() {
    if (!els.captureBallList) return;
    els.captureBallList.replaceChildren();
    const profile = getActiveProfile();
    if (!profile) return;

    BALL_TYPES.forEach((ball) => {
      const count = profile.balls?.[ball.id] || 0;
      const item = document.createElement("div");
      item.className = `capture-ball-item${count === 0 ? " disabled" : ""}`;
      item.dataset.ballId = ball.id;
      item.style.setProperty("--ball-color", ball.color);

      const icon = document.createElement("div");
      icon.className = "capture-ball-icon";
      icon.textContent = "⚪";

      const info = document.createElement("div");
      info.className = "capture-ball-info";
      info.innerHTML = `<strong>${ball.name}</strong><span>${ball.desc} · 拥有 ${count} 个</span>`;

      item.append(icon, info);
      els.captureBallList.appendChild(item);
    });

    // 如果没有咕噜球，显示临时购买按钮
    if (!hasAnyBall(profile)) {
      const hint = document.createElement("div");
      hint.className = "temp-buy-hint";
      hint.textContent = "你没有咕噜球！可以临时购买（比商店贵5行动点）";

      const tempBtn = document.createElement("button");
      tempBtn.className = "temp-buy-ball";
      tempBtn.textContent = `临时购买普通咕噜球（${BALL_TYPES[0].price + 5}行动点）`;
      tempBtn.disabled = profile.actionPoints < BALL_TYPES[0].price + 5;
      tempBtn.addEventListener("click", () => {
        if (profile.actionPoints < BALL_TYPES[0].price + 5) return;
        profile.actionPoints -= (BALL_TYPES[0].price + 5);
        if (!profile.balls) profile.balls = {};
        profile.balls[BALL_TYPES[0].id] = (profile.balls[BALL_TYPES[0].id] || 0) + 1;
        saveState("临时购买成功");
        // 直接更新DOM，而不是重新渲染整个列表，避免事件委托问题
        const firstBallItem = els.captureBallList.querySelector('.capture-ball-item');
        if (firstBallItem) {
          firstBallItem.classList.remove('disabled');
          const infoEl = firstBallItem.querySelector('.capture-ball-info span');
          if (infoEl) {
            infoEl.textContent = BALL_TYPES[0].desc + ' · 拥有 ' + profile.balls[BALL_TYPES[0].id] + ' 个';
          }
        }
        // 隐藏临时购买按钮和提示
        const hintEl = els.captureBallList.querySelector('.temp-buy-hint');
        const btnEl = els.captureBallList.querySelector('.temp-buy-ball');
        if (hintEl) hintEl.style.display = 'none';
        if (btnEl) btnEl.style.display = 'none';
        showToast("⚾ 购买成功", "临时购买成功！点击咕噜球即可捕捉", "success");
      });

      els.captureBallList.appendChild(hint);
      els.captureBallList.appendChild(tempBtn);
    }
  }

})();

