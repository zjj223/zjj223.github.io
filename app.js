(function () {
  "use strict";

  const STORAGE_KEY = "carlosia_phase1_save_v1";
  const MAX_PETS = 6;
  const HATCH_EXP_REQUIREMENT = 120;
  const PET_BASE_HP_MAX = 80;
  const PET_BASE_MP_MAX = 80; // 废弃：保留兼容旧存档，不再显示和使用
  const PET_UPGRADE_COST_BASE = 100;
  const PET_UPGRADE_COST_STEP = 50;
  const PET_UPGRADE_HP_GAIN = 10;
  const COMPENSATION_ACTION_POINTS = 2;

  // 【安全改造】老师权限码、老师代管口令都不再写在前端。
  // 前端只把用户输入的字符交给服务端函数核对（teacher_login / teacher_enter），
  // 核对通过后拿到一张会话门票，前端从此不带任何口令。
  // 每用一次"老师代管"按 2 的次方扣该学生的洛克贝：第 1 次 2，第 2 次 4 … 第 10 次 1024 封顶。
  const SECOND_PASS_MAX_USES = 10;

  // ===== 云端存档（Supabase）=====
  // 部署到公网后，学生各自在自己电脑登录；两项留空则退回纯本地存档模式
  const CLOUD_CONFIG = {
    url: "https://rhfhtgjpnzasrlkcfdim.supabase.co",
    key: "sb_publishable__dL04pGC3ZNvK8tsIfixvQ_l6p5FOMC",
  };
  const CLOUD_ENABLED = Boolean(CLOUD_CONFIG.url && CLOUD_CONFIG.key);
  // 【安全改造】会话门票：登录时由服务端函数核对口令后发下来，只活在内存+sessionStorage。
  // 前端不再保存、不再传输任何口令原文。门票 12 小时过期，刷新即失效。
  let studentToken = null;
  let teacherToken = null;
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
    // 加超时：网络卡住时不要让孩子一直看到"上架中…"这种 loading
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutMs = Number(opts.timeout) || 8000;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`${CLOUD_CONFIG.url}/rest/v1/${path}`, {
        method: opts.method || "GET",
        headers: cloudHeaders(opts.headers),
        body: opts.body,
        signal: controller ? controller.signal : undefined,
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
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 调服务端函数（PostgREST 的 /rpc/ 入口）。口令校验、发门票、写入限制都在服务端做
  function rpcCall(fn, body) {
    return cloudRequest(`rpc/${fn}`, {
      method: "POST",
      body: JSON.stringify(body || {}),
      timeout: 15000,
    });
  }

  // 读全班：必须凭门票走服务端函数（返回里不带任何密码字段）。
  // 【安全改造·第二批】表对匿名已经彻底关门，没门票就直接当"看不到全班"，不再兜底读表
  function cloudGetAllStudents() {
    if (!studentToken && !teacherToken) return Promise.resolve([]);
    const tk = teacherToken || studentToken;
    return rpcCall("class_roster", { p_token: tk });
  }

  // 【安全改造·第二批】写存档已经不允许"按名字直写表"：
  // 学生只能 student_save（写自己），老师只能 teacher_set_save（凭老师门票）。
  // 原来的 cloudUpsertStudent / cloudGetStudent 已删除，避免再有人从控制台绕过去。

  // 【安全改造】原来这里有一整套"读全表密码 / 改全表密码 / 备份还原"的做法，
  // 因为密码已不在表里，这些函数全部删除，改成服务端函数：
  //   teacher_create        老师建号（密码由服务端生成并哈希）
  //   teacher_reset_pins    一键重置全班密码（返回一次性清单给老师抄）
  //   class_lock            锁班 = 暂停登录，不再动密码
  function teacherCreateStudent(name, pin, save) {
    if (!teacherToken) {
      return Promise.reject(new Error("没有老师门票，请先进入后台"));
    }
    return rpcCall("teacher_create", {
      p_token: teacherToken,
      p_name: name,
      p_pin: pin || "",
      p_save: save || {},
    });
  }

  function teacherResetPins() {
    if (!teacherToken) {
      return Promise.reject(new Error("没有老师门票，请先进入后台"));
    }
    return rpcCall("teacher_reset_pins", { p_token: teacherToken });
  }

  function classLock(on) {
    if (!teacherToken) {
      return Promise.reject(new Error("没有老师门票，请先进入后台"));
    }
    return rpcCall("class_lock", { p_token: teacherToken, p_on: Boolean(on) });
  }

  function teacherSetSave(name, save) {
    if (!teacherToken) {
      return Promise.reject(new Error("没有老师门票，请先进入后台"));
    }
    return rpcCall("teacher_set_save", {
      p_token: teacherToken,
      p_name: name,
      p_save: save,
    });
  }

  // 把云端返回的一行还原成角色对象（不再有任何 pass 字段）
  function profileFromCloud(row) {
    const raw = row && row.save && typeof row.save === "object" ? row.save : {};
    const profile = Object.assign({}, raw);
    profile.id =
      profile.id || `role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    profile.name = profile.name || (row && row.name) || "无名训练家";
    delete profile.pass;
    return profile;
  }

  // 只同步"当前选中的这个角色"，合并写请求，避免连点探索时刷爆接口
  function scheduleCloudSync(profile) {
    if (!CLOUD_ENABLED || !cloudSyncAllowed || !profile || !profile.name) {
      return;
    }
    // 存档里不再夹带密码；这里显式剔除，避免旧档案里的残留字段被带上去
    const save = Object.assign({}, profile);
    delete save.pass;
    const payload = {
      name: profile.name,
      save,
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
      // 有学生会话门票时走服务端函数（只能写自己那一行）；
      // 老师端改档走老师门票；两样都没有就不写（表权限已经收紧，直写会被拒）
      if (studentToken) {
        const res = await rpcCall("student_save", { p_token: studentToken, p_save: payload.save });
        if (!res || !res.ok) {
          throw new Error((res && res.code) || "save_rejected");
        }
      } else if (teacherToken) {
        const res = await rpcCall("teacher_set_save", {
          p_token: teacherToken,
          p_name: payload.name,
          p_save: payload.save,
        });
        if (!res || !res.ok) {
          throw new Error((res && res.code) || "teacher_save_rejected");
        }
      } else {
        setSaveStatus("仅本地存档（未登录云端）");
        return;
      }
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

  // 咕噜球配置（按捕捉率阶梯定价：越稳越贵）
  // 每场战斗 +1 洛克贝，一节课大概攒 30~50 个：便宜的先用，国王球要攒几节课
  const PET_REFRESH_COST = 50; // 刷新起始宠物消耗 50 洛克贝
  const BALL_TYPES = Object.freeze([
    { id: "ball1", name: "普通咕噜球", price: 5, catchRate: 0.05, color: "#9e9e9e", desc: "基础捕捉率5%" },
    { id: "ball2", name: "中级咕噜球", price: 10, catchRate: 0.10, color: "#42a5f5", desc: "捕捉率10%" },
    { id: "ball3", name: "高级咕噜球", price: 18, catchRate: 0.15, color: "#66bb6a", desc: "捕捉率15%" },
    { id: "ball4", name: "超级咕噜球", price: 30, catchRate: 0.20, color: "#ffa726", desc: "捕捉率20%" },
    { id: "ball5", name: "至尊咕噜球", price: 60, catchRate: 0.30, color: "#ab47bc", desc: "捕捉率30%" },
    { id: "ball6", name: "国王咕噜球", price: 120, catchRate: 0.50, color: "#ef5350", desc: "捕捉率50%" },
  ]);

  // ===== 时装 / 形象 =====
  // 每个场景对应一套形象，男女各一版。整套换图（不是换部件）
  const OUTFIT_PRICE = 10000;      // 洛克贝兑换价
  const OUTFIT_ITEM_NEED = 100;    // 或用该场景道具凑够 100 个
  const OUTFITS = Object.freeze([
    {
      id: "starter", name: "新手装", tag: "初始形象",
      sceneId: null, sceneName: "新手",
      boy: "./assets/boxworld/trainer-boy-sprite.png",
      girl: "./assets/boxworld/trainer-girl-sprite.png",
      color: "#7c9fd4", free: true,
      intro: "出生自带的探险服，免费永久拥有。",
    },
    {
      id: "grass", name: "草原旅人", tag: "轻风草原",
      sceneId: "grassland", sceneName: "轻风草原",
      boy: "./assets/outfits/boy-grass.png",
      girl: "./assets/outfits/girl-grass.png",
      color: "#8bc34a",
      intro: "草帽配四叶草徽章，风吹过草地的味道。",
    },
    {
      id: "lava", name: "熔岩战甲", tag: "维苏威火山",
      sceneId: "volcano", sceneName: "维苏威火山",
      boy: "./assets/outfits/boy-lava.png",
      girl: "./assets/outfits/girl-lava.png",
      color: "#e64a19",
      intro: "熔岩纹护甲配火焰披风，火山里最能打的一身。",
    },
    {
      id: "sea", name: "人鱼之歌", tag: "人鱼湾",
      sceneId: "mermaid-bay", sceneName: "人鱼湾",
      boy: "./assets/outfits/boy-sea.png",
      girl: "./assets/outfits/girl-sea.png",
      color: "#29b6f6",
      intro: "贝壳胸扣和浪花披风，走起来像踩着水。",
    },
    {
      id: "academy", name: "皇家学者", tag: "皇家研究院",
      sceneId: "academy", sceneName: "皇家研究院",
      boy: "./assets/outfits/boy-academy.png",
      girl: "./assets/outfits/girl-academy.png",
      color: "#3949ab",
      intro: "学士帽配金边长袍，一看就是读过很多书。",
    },
    {
      id: "snow", name: "冰原守护", tag: "雪人谷",
      sceneId: "snow-valley", sceneName: "雪人谷",
      boy: "./assets/outfits/boy-snow.png",
      girl: "./assets/outfits/girl-snow.png",
      color: "#4fc3f7",
      intro: "毛领大衣和冰晶护肩，站在雪里也不冷。",
    },
    {
      id: "thunder", name: "雷霆机甲", tag: "雷鹗峡谷",
      sceneId: "thunder-valley", sceneName: "雷鹗峡谷",
      boy: "./assets/outfits/boy-thunder.png",
      girl: "./assets/outfits/girl-thunder.png",
      color: "#ffee58",
      intro: "身上带电路光条，走到哪都噼里啪啦。",
    },
    {
      id: "shadow", name: "幽影猎手", tag: "幽暗森林",
      sceneId: "shadow-forest", sceneName: "幽暗森林",
      boy: "./assets/outfits/boy-shadow.png",
      girl: "./assets/outfits/girl-shadow.png",
      color: "#7c4dff",
      intro: "兜帽面罩加破边斗篷，安静得没有脚步声。",
    },
    {
      id: "swamp", name: "沼泽巫医", tag: "幽影沼泽",
      sceneId: "dark-swamp", sceneName: "幽影沼泽",
      boy: "./assets/outfits/boy-swamp.png",
      girl: "./assets/outfits/girl-swamp.png",
      color: "#7cb342",
      intro: "尖帽挂着小骨头，腰上一排药瓶。",
    },
    {
      id: "dragon", name: "龙鳞勇者", tag: "龙之秘境",
      sceneId: "dragon-realm", sceneName: "龙之秘境",
      boy: "./assets/outfits/boy-dragon.png",
      girl: "./assets/outfits/girl-dragon.png",
      color: "#ff7043",
      intro: "一整身龙鳞甲，背后是能看见骨架的龙翼。",
    },
    {
      id: "starlight", name: "星辉礼服", tag: "天空之城",
      sceneId: "sky-city", sceneName: "天空之城",
      boy: "./assets/outfits/boy-starlight.png",
      girl: "./assets/outfits/girl-starlight.png",
      color: "#ffd54f",
      intro: "星空披风配金边礼服，天空之城的庆典装。",
    },
  ]);

  function findOutfit(outfitId) {
    return OUTFITS.find((o) => o.id === outfitId) || OUTFITS[0];
  }

  // 当前穿着的立绘路径（性别决定取哪一版）
  function outfitSrc(profile, outfitId) {
    const outfit = findOutfit(outfitId || (profile && profile.outfit) || "starter");
    return profile && profile.gender === "female" ? outfit.girl : outfit.boy;
  }

  function ownedOutfits(profile) {
    if (!profile) return ["starter"];
    if (!Array.isArray(profile.outfits) || !profile.outfits.length) return ["starter"];
    return profile.outfits.includes("starter") ? profile.outfits : ["starter", ...profile.outfits];
  }

  // 该场景 4 种道具一共攒了多少个
  function sceneItemTotal(profile, sceneId) {
    const items = SCENE_ITEMS[sceneId] || [];
    return items.reduce((sum, item) => sum + (Number(profile.inventory?.[item.id]) || 0), 0);
  }

  // 扣掉该场景 100 个道具（按道具顺序依次扣）
  function consumeSceneItems(profile, sceneId, need) {
    const items = SCENE_ITEMS[sceneId] || [];
    let remain = need;
    for (const item of items) {
      if (remain <= 0) break;
      const have = Number(profile.inventory?.[item.id]) || 0;
      if (have <= 0) continue;
      const take = Math.min(have, remain);
      profile.inventory[item.id] = have - take;
      if (profile.inventory[item.id] <= 0) delete profile.inventory[item.id];
      remain -= take;
    }
    return remain <= 0;
  }

  const TIMER_DURATION = 60; // 默认1分钟

  // 新手引导步骤
  const GUIDE_STEPS = Object.freeze([
    {
      title: "欢迎来到卡罗西亚大陆！",
      desc: "这是一个课堂养成游戏。你可以通过上课认真做题获得洛克贝，然后用洛克贝探索世界、培养宠物、和同学比拼战力！",
      highlight: "先创建或选择一个角色开始游戏吧！"
    },
    {
      title: "宠物系统",
      desc: "每个玩家最多可以拥有6只宠物。第一只宠物可以用50洛克贝刷新，其他宠物需要在大世界探索中捕捉获得。每只宠物都有独立的等级、经验和亲密度。",
      highlight: "宠物栏在左侧，可以切换出战宠物"
    },
    {
      title: "大世界探索",
      desc: "点击场景进入探索，探索不花洛克贝，想点几次点几次。探索可以获得经验值和场景专属道具，还有可能遇到野生宠物进行战斗。每场战斗都会得到 1 个洛克贝。集齐一个场景的4个道具可以提升1级亲密度。",
      highlight: "亲密度越高，解锁的场景越多"
    },
    {
      title: "捕捉宠物",
      desc: "战斗胜利后有15%概率出现捕捉窗口。使用咕噜球可以捕捉野生宠物，咕噜球越好捕捉率越高。捕捉到的宠物会加入你的宠物栏。",
      highlight: "记得先去商店购买咕噜球"
    },
    {
      title: "商店与市场",
      desc: "商店用洛克贝买咕噜球，越稳的越贵：普通球 5 洛克贝（5%），国王球 120 洛克贝（50%）。市场可以和同学互相买卖场景道具，成交后卖家承担 1/5 手续费（向上取整），到账是扣完手续费的部分。",
      highlight: "用洛克贝交易，统一定价"
    },
    {
      title: "战力排行榜",
      desc: "排行榜按全部宠物的战斗力总和排名。每周老师会发布排行榜奖励，排名越靠前奖励的洛克贝越多。",
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
      feature: "新手村，野生宠物 1-10 级。",
      artClass: "scene-grass",
    },
    {
      id: "volcano",
      name: "维苏威火山",
      element: "火系",
      tag: "进阶",
      bondRequired: 1,
      drops: { exp: [75, 187] },
      feature: "进阶地带，野生宠物 11-20 级。",
      artClass: "scene-fire",
    },
    {
      id: "mermaid-bay",
      name: "人鱼湾",
      element: "水系",
      tag: "中级",
      bondRequired: 2,
      drops: { exp: [150, 262] },
      feature: "海底秘境，野生宠物 21-30 级。",
      artClass: "scene-water",
    },
    {
      id: "academy",
      name: "皇家研究院",
      element: "光系",
      tag: "高级",
      bondRequired: 3,
      drops: { exp: [225, 337] },
      feature: "知识殿堂，野生宠物 31-40 级。",
      artClass: "scene-lab",
    },
    {
      id: "snow-valley",
      name: "雪人谷",
      element: "冰系",
      tag: "专家",
      bondRequired: 4,
      drops: { exp: [300, 412] },
      feature: "极寒雪域，野生宠物 41-50 级。",
      artClass: "scene-ice",
    },
    {
      id: "thunder-valley",
      name: "雷鸣峡谷",
      element: "电系",
      tag: "大师",
      bondRequired: 5,
      drops: { exp: [375, 525] },
      feature: "雷电峡谷，野生宠物 51-60 级。",
      artClass: "scene-thunder",
    },
    {
      id: "shadow-forest",
      name: "幽暗森林",
      element: "幽系",
      tag: "宗师",
      bondRequired: 6,
      drops: { exp: [450, 637] },
      feature: "幽暗森林，野生宠物 61-70 级。",
      artClass: "scene-shadow",
    },
    {
      id: "dark-swamp",
      name: "暗影沼泽",
      element: "恶系",
      tag: "噩梦",
      bondRequired: 7,
      drops: { exp: [525, 750] },
      feature: "暗影沼泽，野生宠物 71-80 级。",
      artClass: "scene-swamp",
    },
    {
      id: "dragon-realm",
      name: "龙之秘境",
      element: "龙系",
      tag: "传说",
      bondRequired: 8,
      drops: { exp: [600, 862] },
      feature: "龙族领域，野生宠物 81-90 级。",
      artClass: "scene-dragon",
    },
    {
      id: "sky-city",
      name: "天空之城",
      element: "翼系",
      tag: "神话",
      bondRequired: 9,
      drops: { exp: [675, 975] },
      feature: "云端王城，野生宠物 91-100 级。",
      artClass: "scene-sky",
    },
  ]);

  // 经验倍率：让每个场景"探索 100 次左右"刚好够升到该场景的满级
  // （战斗不再给经验，所以只靠没遇敌的那几次探索来涨级）
  const SCENE_EXP_MULT = Object.freeze({
    grassland: 1,
    volcano: 1.4,
    "mermaid-bay": 1.4,
    academy: 2.2,
    "snow-valley": 2.15,
    "thunder-valley": 2.1,
    "shadow-forest": 2,
    "dark-swamp": 1.95,
    "dragon-realm": 1.95,
    "sky-city": 2.6,
  });

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
  const MARKET_FEE_RATE = 0.2; // 卖家手续费 1/5，向上取整
  function marketFee(price) {
    return Math.ceil(Number(price || 0) * MARKET_FEE_RATE);
  }
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
    grassland: { petIds: ["magic-cat", "spring-rabbit", "yibei-fenfen", "sleepy-king", "bounce-seed", "gran-seed", "qili-grass", "small-bee"], levels: [[1, 2], [2, 5], [4, 7], [6, 9], [7, 10], [10, 10]], levelRange: [1, 10], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    volcano: { petIds: ["fire-god", "fire-guardian", "fire-dragon", "fire-monkey"], levels: [[11, 12], [12, 15], [14, 17], [16, 19], [17, 20], [20, 20]], levelRange: [11, 20], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "mermaid-bay": { petIds: ["water-spirit", "water-shell", "small-lotus", "water-ball"], levels: [[21, 22], [22, 25], [24, 27], [26, 29], [27, 30], [30, 30]], levelRange: [21, 30], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    academy: { petIds: ["dimo", "platinum-unicorn", "holy-sword-x", "pen-child", "small-cow"], levels: [[31, 32], [32, 35], [34, 37], [36, 39], [37, 40], [40, 40]], levelRange: [31, 40], encounterRate: 0.5, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "snow-valley": { petIds: ["snow-shadow-doll", "sundae-sweet", "snow-doll", "snow-beast"], levels: [[41, 42], [42, 45], [44, 47], [46, 49], [47, 50], [50, 50]], levelRange: [41, 50], encounterRate: 0.65, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "thunder-valley": { petIds: ["kula", "electric-circle", "thunder-ball"], levels: [[51, 52], [52, 55], [54, 57], [56, 59], [57, 60], [60, 60]], levelRange: [51, 60], encounterRate: 0.65, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "shadow-forest": { petIds: ["bone-dragon", "flower-antelope", "small-mushroom", "grass-bug"], levels: [[61, 62], [62, 65], [64, 67], [66, 69], [67, 70], [70, 70]], levelRange: [61, 70], encounterRate: 0.65, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "dark-swamp": { petIds: ["demon-wolf", "dragon-breath-par", "wuda", "star-demon", "duoduo"], levels: [[71, 72], [72, 75], [74, 77], [76, 79], [77, 80], [80, 80]], levelRange: [71, 80], encounterRate: 0.65, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "dragon-realm": { petIds: ["wing-dragon", "tooth-dragon", "horn-dragon", "small-stone"], levels: [[81, 82], [82, 85], [84, 87], [86, 89], [87, 90], [90, 90]], levelRange: [81, 90], encounterRate: 0.65, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
    "sky-city": { petIds: ["royal-griffin", "holy-wing-king", "mini-liwu", "bean-dragon", "mecha-shell"], levels: [[91, 92], [92, 95], [94, 97], [96, 99], [97, 100], [100, 100]], levelRange: [91, 100], encounterRate: 0.65, shinyPetIds: ["shiny-pink-star", "shiny-snow-doll", "shiny-demon-wolf"], shinyRate: 0.01 },
  });

  const PET_DATABASE = Array.isArray(PET_DATA.petDatabase) ? PET_DATA.petDatabase : [];
  const PET_POOL = Object.freeze(
    PET_DATABASE.length > 0 ? PET_DATABASE : FALLBACK_PET_POOL,
  );

  const els = {};
  let state = null;
  let selectedSceneId = "grassland";
  let teacherUnlocked = false;
  let teacherSelectedId = null; // 后台名单里点中的学生
  let resultMessage = "";
  let resultIsWarning = false;
  let currentView = "world"; // "world" 大世界 / "scene" 场景内 / "shop" 商店
  let selectedSpotId = null;
  let currentShopTab = "market"; // "market" 逛市场 / "sell" 我要卖 / "mine" 我的上架
  let currentStoreTab = "balls"; // "balls" 咕噜球 / "fashion" 时装
  let marketState = { listings: [] };
  let isExploring = false; // 探索动画进行中，防止重复点击
  let pulledProfileIds = []; // 老师拉入的学生ID列表（不存档）
  let timerInterval = null; // 计时器interval
  let timerSeconds = TIMER_DURATION; // 计时器剩余秒数
  let timerStarted = false; // 计时器是否已启动过（启动后不能再加时间）
  let currentGuideStep = 0; // 当前引导步骤
  let guideStartIndex = 0; // 引导起始步骤（学生端已自动建档，跳过"创建角色"这一步）
  let captureTarget = null; // 当前捕捉目标野生宠物
  let captureLocked = false; // 捕捉判定中：锁住咕噜球，防止连点一次抓多只
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
    setLoginMode(location.protocol === "file:" ? "teacher" : "student");
  }

  // 老师登录：进后台，并把云端全班数据拉下来（拉不到就继续用本地）
  // 【安全改造】权限码交给服务端核对，核对通过拿老师门票；源码里不再出现任何口令原文
  async function handleLogin(event) {
    event.preventDefault();
    const code = els.teacherCode.value.trim();
    if (!code) {
      els.loginError.hidden = false;
      return;
    }
    let res = null;
    if (CLOUD_ENABLED && location.protocol !== "file:") {
      try {
        res = await rpcCall("teacher_login", { p_code: code });
      } catch (err) {
        console.warn("老师登录请求失败", err);
        els.loginError.hidden = false;
        return;
      }
    }
    // 离线（file://）时没有服务端，保留本机备课用的放行方式：本地不需要联网也能进后台
    const offlineOk = location.protocol === "file:";
    if (!offlineOk && (!res || !res.ok)) {
      els.loginError.hidden = false;
      els.teacherCode.value = "";
      return;
    }
    if (res && res.ok) {
      teacherToken = res.token;
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
    const backHomeBtn = document.getElementById("btnBackHome");
    if (backHomeBtn) backHomeBtn.hidden = true;
    // 老师模式：只显示后台名单，不显示地图与其它面板
    document.body.classList.add("is-teacher-mode");
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
    // 4~6 位纯数字 = 学生自己的密码；其它长度 = 老师代管口令（交给服务端核对，前端不认识它）
    const isPin = /^\d{4,6}$/.test(pass);
    if (!isPin && !pass) {
      showStudentError("请填写密码");
      return;
    }
    showStudentError("");
    els.studentLoginBtn.disabled = true;
    const oldLabel = els.studentLoginBtn.textContent;
    els.studentLoginBtn.textContent = "正在验证…";
    try {
      let res = null;
      if (isPin) {
        // 1) 服务端校验密码（连错 5 次锁 60 秒），通过后发一张 12 小时门票
        res = await rpcCall("student_login", { p_name: name, p_pin: pass });
        if (res && !res.ok && res.code === "no_user") {
          // 2) 没这个账号：自动建档也走服务端（不再由前端直接往表里插）
          const fresh = buildNewProfile(name, pass);
          res = await rpcCall("student_register", {
            p_name: name,
            p_pin: pass,
            p_save: fresh,
          });
        }
      } else {
        // 老师代管：用权限码进某个孩子的账号，服务端核对并扣费
        res = await rpcCall("teacher_enter", { p_code: pass, p_name: name });
      }

      if (!res || !res.ok) {
        const code = res && res.code;
        if (code === "bad_pin") showStudentError("密码不对，再试一次");
        else if (code === "locked") showStudentError(`试错太多，请等 ${res.seconds || 60} 秒再试`);
        else if (code === "class_locked") showStudentError("老师已暂停全班登录，等老师说开始");
        else if (code === "exists") showStudentError("这个名字已经有人用了，换个名字或找老师");
        else if (code === "bad_pin_format") showStudentError("密码要 4~6 位数字");
        else if (code === "no_user") showStudentError("没这个账号，先让老师登记一下");
        else if (code === "bad_code") showStudentError("老师的码不对");
        else showStudentError("登录没通过，检查名字和密码");
        return;
      }

      // 门票只留在内存，不落盘、不写进存档
      studentToken = res.token || null;
      const profile = profileFromCloud({ name, save: res.save, updated_at: res.updated_at });
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
      // 登录成功后先停在「开始游戏 / 学习台」选择页，点开始游戏才真正进游戏
      showStudentLanding(profile.name);
    } catch (err) {
      console.error("学生登录失败", err);
      showStudentError("连不上云端，检查网络后再试");
    } finally {
      els.studentLoginBtn.disabled = false;
      els.studentLoginBtn.textContent = oldLabel;
    }
  }

  // ===== 多人可见（Phase 0）：同场景互相看见，位置不落库，断网自动退回单人模式 =====
  const PEERS_ENABLED = true;
  const ROOM_PREFIX = "carlosia:room:";
  // 场景里一个班分散在多个场景，单场景人多也就 15 人，800ms 够顺滑；
  // 大世界是全班共用的一个频道，50 人同时走动时 800ms 会把额度打满，放宽到 2 秒。
  const PEER_SEND_MIN_INTERVAL = 800;
  const PEER_WORLD_SEND_MIN_INTERVAL = 2000;
  const PEER_STALE_MS = 12000;
  const PEER_MAX = 20;
  // 大世界是全班一个房间：只显示 20 人会让后进班的同学"看不见同学"，
  // 而多渲染几十个小人几乎不花钱（46×78 的 DOM 节点 + 2 秒一次位移），所以大世界放到 50。
  const PEER_WORLD_MAX = 50;
  const PEER_HEARTBEAT_MS = 5000;
  // 同伴头顶不显示真名，避免全班互相看到姓名；改成 赵*杰 这种掩码
  const PEER_MASK_NAME = true;

  const peerState = {
    client: null,
    channel: null,
    roomId: null,
    selfKey: null,
    sessionTag: null,
    peers: new Map(),
    lastSendAt: 0,
    heartbeatTimer: null,
    runtimeOff: false,
    retried: false,
    warned: false,
  };

  function isStudentSession() {
    const grid = document.querySelector(".app-grid");
    return Boolean(grid && grid.classList.contains("is-student"));
  }

  function peerProfile() {
    const p = getActiveProfile();
    return p && p.name ? p : null;
  }

  // 当前可见舞台（场景舞台 / 大地图），用来做坐标换算
  function peerStage() {
    if (currentView === "scene") {
      const cont = document.querySelector(".scene-stage");
      const img = cont ? cont.querySelector(".scene-stage-bg") : null;
      return cont && img ? { cont, img, mode: "scene" } : null;
    }
    const cont = document.querySelector(".continent");
    const img = cont ? cont.querySelector(".continent-bg") : null;
    return cont && img ? { cont, img, mode: "map" } : null;
  }

  // 本地容器百分比 -> 底图归一化坐标（object-fit: cover 的换算）
  function localPctToImage(stage, xPct, yPct) {
    const cw = stage.cont.clientWidth;
    const ch = stage.cont.clientHeight;
    if (!cw || !ch) return null;
    const iw = stage.img.naturalWidth;
    const ih = stage.img.naturalHeight;
    if (!iw || !ih) return [xPct / 100, yPct / 100];
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const offX = (cw - dw) / 2;
    const offY = (ch - dh) / 2;
    const nx = ((xPct / 100) * cw - offX) / dw;
    const ny = ((yPct / 100) * ch - offY) / dh;
    return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))];
  }

  // 底图归一化坐标 -> 本地容器百分比
  function imageToLocalPct(stage, nx, ny) {
    const cw = stage.cont.clientWidth;
    const ch = stage.cont.clientHeight;
    if (!cw || !ch) return null;
    const iw = stage.img.naturalWidth;
    const ih = stage.img.naturalHeight;
    if (!iw || !ih) return [nx * 100, ny * 100];
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const offX = (cw - dw) / 2;
    const offY = (ch - dh) / 2;
    return [((offX + nx * dw) / cw) * 100, ((offY + ny * dh) / ch) * 100];
  }

  // 显示用名字：赵俊杰 -> 赵*杰，欧阳娜娜 -> 欧**娜，单字 -> 赵*
  function maskPeerName(raw) {
    const chars = Array.from(String(raw == null ? "" : raw).trim());
    if (!chars.length) return "同学";
    if (chars.length <= 2) return chars[0] + "*";
    return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
  }

  function peerDisplayName(profile) {
    const raw = profile && profile.name ? profile.name : "";
    return PEER_MASK_NAME ? maskPeerName(raw) : raw || "同学";
  }

  function peerPayload() {
    const p = peerProfile();
    if (!p) return null;
    const stage = peerStage();
    let nx = 0.5;
    let ny = 0.7;
    if (stage) {
      const cur = currentView === "scene"
        ? { x: scenePlayerPos.x, y: scenePlayerPos.y }
        : { x: mapPlayerPos.x, y: mapPlayerPos.y };
      const img = localPctToImage(stage, cur.x, cur.y);
      if (img) {
        nx = img[0];
        ny = img[1];
      }
    }
    return {
      v: 1,
      k: peerState.selfKey || "",
      name: peerDisplayName(p),
      gender: p.gender || "male",
      outfit: p.outfit || "starter",
      pet: (p.pet && p.pet.image) || null,
      x: Number(nx.toFixed(4)),
      y: Number(ny.toFixed(4)),
      t: Date.now(),
    };
  }

  function ensureRealtime() {
    if (peerState.runtimeOff || !PEERS_ENABLED || !CLOUD_ENABLED) return null;
    if (peerState.client) return peerState.client;
    if (typeof supabase === "undefined" || !supabase || typeof supabase.createClient !== "function") {
      if (!peerState.warned) {
        peerState.warned = true;
        console.info("[多人可见] 实时库未加载，已退回单机模式");
      }
      return null;
    }
    try {
      peerState.client = supabase.createClient(CLOUD_CONFIG.url, CLOUD_CONFIG.key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 10 } },
      });
    } catch (err) {
      peerState.runtimeOff = true;
      console.info("[多人可见] 实时客户端创建失败，已退回单机模式", err);
      return null;
    }
    return peerState.client;
  }

  function disablePeers(reason) {
    if (peerState.runtimeOff) return;
    peerState.runtimeOff = true;
    console.info(`[多人可见] 已关闭（${reason}），单人玩法不受影响`);
    leaveRoom();
  }

  function joinRoom(roomId, force) {
    if (!roomId || peerState.runtimeOff || !PEERS_ENABLED) return;
    if (!force && peerState.roomId === roomId && peerState.channel) return;
    if (!isStudentSession()) return;
    const p = peerProfile();
    if (!p) return;
    leaveRoom();
    const client = ensureRealtime();
    if (!client) return;
    if (!peerState.sessionTag) {
      peerState.sessionTag = String(Math.floor(1000 + Math.random() * 9000));
    }
    // presence key 只用 ASCII，避免中文/特殊字符在部分网络设备上出问题；显示名仍从 meta.name 取
    peerState.selfKey = `p${peerState.sessionTag}${Math.floor(Math.random() * 90 + 10)}`;
    peerState.roomId = roomId;
    const ch = client.channel(`${ROOM_PREFIX}${roomId}`, {
      config: { presence: { key: peerState.selfKey } },
    });
    peerState.channel = ch;

    ch.on("broadcast", { event: "move" }, (msg) => onPeerMove(msg && msg.payload))
      .on("broadcast", { event: "here" }, (msg) => onPeerMove(msg && msg.payload))
      .on("presence", { event: "sync" }, () => onPeerPresenceSync(ch))
      .on("presence", { event: "join" }, () => onPeerPresenceSync(ch))
      .on("presence", { event: "update" }, () => onPeerPresenceSync(ch))
      .on("presence", { event: "leave" }, (ev) => {
        if (ev && ev.key) removePeer(ev.key);
      });

    let subscribed = false;
    ch.subscribe((status) => {
      if (peerState.channel !== ch) return;
      if (status === "SUBSCRIBED") {
        subscribed = true;
        peerState.failCount = 0;
        trackSelf();
        sendPeerPos(true);
        startPeerHeartbeat();
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        // 校园网抖动很常见：先退避重连，连续失败 3 次才退回单机
        peerState.failCount = (peerState.failCount || 0) + 1;
        if (peerState.failCount > 3) {
          disablePeers("实时通道断开");
          return;
        }
        setTimeout(() => {
          if (peerState.roomId === roomId && peerState.channel === ch) joinRoom(roomId, true);
        }, 2500 * peerState.failCount);
      }
    });

    // 10 秒连不上：先重连，连续失败 3 次才静默退回单机
    setTimeout(() => {
      if (subscribed || peerState.channel !== ch) return;
      peerState.failCount = (peerState.failCount || 0) + 1;
      if (peerState.failCount > 3) {
        disablePeers("连接超时");
      } else {
        joinRoom(roomId, true);
      }
    }, 10000);
  }

  function leaveRoom() {
    const ch = peerState.channel;
    peerState.channel = null;
    peerState.roomId = null;
    stopPeerHeartbeat();
    if (ch) {
      try {
        ch.unsubscribe();
      } catch (err) {
        /* 忽略 */
      }
      try {
        if (peerState.client && peerState.client.removeChannel) peerState.client.removeChannel(ch);
      } catch (err) {
        /* 忽略 */
      }
    }
    Array.from(peerState.peers.keys()).forEach((key) => {
      const peer = peerState.peers.get(key);
      if (peer && peer.el && peer.el.parentNode) peer.el.parentNode.removeChild(peer.el);
    });
    peerState.peers.clear();
    document.querySelectorAll(".peer-layer").forEach((l) => l.replaceChildren());
  }

  function trackSelf() {
    const ch = peerState.channel;
    const payload = peerPayload();
    if (!ch || !payload) return;
    try {
      ch.track({
        name: payload.name,
        gender: payload.gender,
        outfit: payload.outfit,
        pet: payload.pet,
        x: payload.x,
        y: payload.y,
        joinedAt: Date.now(),
      });
    } catch (err) {
      /* 忽略 */
    }
  }

  function sendPeerPos(force) {
    if (peerState.runtimeOff || !peerState.channel || !peerState.roomId) return;
    if (document.hidden && !force) return;
    const now = Date.now();
    const minInterval =
      currentView === "world" ? PEER_WORLD_SEND_MIN_INTERVAL : PEER_SEND_MIN_INTERVAL;
    if (!force && now - peerState.lastSendAt < minInterval) return;
    const targetRoom = currentView === "scene"
      ? selectedSceneId
      : currentView === "world"
        ? "world"
        : null;
    if (!targetRoom || targetRoom !== peerState.roomId) return;
    const payload = peerPayload();
    if (!payload) return;
    peerState.lastSendAt = now;
    try {
      peerState.channel.send({ type: "broadcast", event: "move", payload });
    } catch (err) {
      /* 忽略 */
    }
  }

  function startPeerHeartbeat() {
    stopPeerHeartbeat();
    peerState.heartbeatTimer = setInterval(() => {
      if (document.hidden || !peerState.channel) return;
      const now = Date.now();
      Array.from(peerState.peers.keys()).forEach((key) => {
        const peer = peerState.peers.get(key);
        if (peer && now - (peer.lastSeen || 0) > PEER_STALE_MS) {
          removePeer(key);
        }
      });
      // 走动时位置广播本身就证明"我还在"；只有停步超过一个心跳周期才补发一次。
      // 以前每 5 秒无条件 track + 发位置，会让每个客户端多出一倍的固定消息量。
      if (now - peerState.lastSendAt >= PEER_HEARTBEAT_MS) sendPeerPos(true);
    }, PEER_HEARTBEAT_MS);
  }

  function stopPeerHeartbeat() {
    if (peerState.heartbeatTimer) {
      clearInterval(peerState.heartbeatTimer);
      peerState.heartbeatTimer = null;
    }
  }

  function onPeerMove(payload) {
    if (!payload || payload.v !== 1) return;
    if (!payload.k || payload.k === peerState.selfKey) return;
    if (typeof payload.x !== "number" || typeof payload.y !== "number") return;
    const peerCap = peerState.roomId === "world" ? PEER_WORLD_MAX : PEER_MAX;
    if (!peerState.peers.has(payload.k) && peerState.peers.size >= peerCap) return;
    const peer = peerState.peers.get(payload.k) || { key: payload.k, name: "同学", el: null };
    if (payload.name) peer.name = payload.name;
    if (payload.gender) peer.gender = payload.gender;
    if (payload.outfit) peer.outfit = payload.outfit;
    peer.pet = payload.pet || null;
    peer.nx = payload.x;
    peer.ny = payload.y;
    peer.lastSeen = Date.now();
    peerState.peers.set(payload.k, peer);
    renderPeer(peer);
  }

  function onPeerPresenceSync(ch) {
    if (!ch || ch !== peerState.channel) return;
    let presence = {};
    try {
      presence = ch.presenceState() || {};
    } catch (err) {
      presence = {};
    }
    Object.keys(presence).forEach((key) => {
      if (key === peerState.selfKey) return;
      const metas = presence[key] || [];
      const meta = metas[0];
      if (!meta) return;
      if (!peerState.peers.has(key) && peerState.peers.size >= PEER_MAX) return;
      const existed = peerState.peers.has(key);
      const peer = peerState.peers.get(key) || { key, name: "同学", el: null };
      if (meta.name) peer.name = meta.name;
      if (meta.gender) peer.gender = meta.gender;
      if (meta.outfit) peer.outfit = meta.outfit;
      if (meta.pet !== undefined) peer.pet = meta.pet || null;
      if (typeof meta.x === "number") peer.nx = meta.x;
      if (typeof meta.y === "number") peer.ny = meta.y;
      if (!existed) peer.lastSeen = Date.now();
      peerState.peers.set(key, peer);
      renderPeer(peer);
    });
  }

  function ensurePeerLayer(stage) {
    if (!stage || !stage.cont) return null;
    let layer = stage.cont.querySelector(".peer-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "peer-layer";
    }
    // 必须追加在舞台最后，否则会被探索点层盖住
    if (layer !== stage.cont.lastElementChild) stage.cont.appendChild(layer);
    return layer;
  }

  function buildPeerEl(peer, mode) {
    const el = document.createElement("div");
    el.className = `peer-avatar${mode === "map" ? " is-map" : ""}`;
    el.dataset.peerKey = peer.key;

    const sprite = document.createElement("img");
    sprite.className = "peer-sprite";
    sprite.alt = "";
    sprite.src = outfitSrc({ gender: peer.gender || "male", outfit: peer.outfit || "starter" }, peer.outfit);

    const nameEl = document.createElement("span");
    nameEl.className = "peer-name";
    nameEl.textContent = String(peer.name || "同学").split("#")[0];

    el.appendChild(sprite);
    if (peer.pet) {
      const petEl = document.createElement("img");
      petEl.className = "peer-pet";
      petEl.src = peer.pet;
      petEl.alt = "";
      el.appendChild(petEl);
    }
    el.appendChild(nameEl);
    return el;
  }

  function renderPeer(peer) {
    const stage = peerStage();
    if (!stage) return;
    const layer = ensurePeerLayer(stage);
    if (!layer) return;
    if (typeof peer.nx !== "number" || typeof peer.ny !== "number") return;
    let el = peer.el;
    if (!el || !el.isConnected || el.parentNode !== layer) {
      el = buildPeerEl(peer, stage.mode);
      peer.el = el;
      layer.appendChild(el);
      el.dataset.hasPos = "0";
    }
    // 名字 / 服装 / 宠物随时更新（换装换宠只改节点，不重建整个图层）
    const nameNode = el.querySelector(".peer-name");
    if (nameNode) {
      const shownName = String(peer.name || "同学").split("#")[0];
      if (nameNode.textContent !== shownName) nameNode.textContent = shownName;
    }
    const spriteNode = el.querySelector(".peer-sprite");
    if (spriteNode) {
      const wanted = outfitSrc({ gender: peer.gender || "male", outfit: peer.outfit || "starter" }, peer.outfit);
      if (spriteNode.getAttribute("src") !== wanted) spriteNode.src = wanted;
    }
    const petNode = el.querySelector(".peer-pet");
    if (peer.pet && !petNode) {
      const petImg = document.createElement("img");
      petImg.className = "peer-pet";
      petImg.src = peer.pet;
      petImg.alt = "";
      el.insertBefore(petImg, nameNode);
    } else if (!peer.pet && petNode) {
      petNode.remove();
    } else if (petNode && peer.pet && petNode.getAttribute("src") !== peer.pet) {
      petNode.src = peer.pet;
    }    const local = imageToLocalPct(stage, peer.nx, peer.ny);
    if (!local) return;
    const prevX = parseFloat(el.style.left || "0");
    const prevY = parseFloat(el.style.top || "0");
    const far = el.dataset.hasPos === "1" && (Math.abs(prevX - local[0]) > 15 || Math.abs(prevY - local[1]) > 15);
    if (far) el.classList.add("is-teleport");
    el.style.left = `${local[0]}%`;
    el.style.top = `${local[1]}%`;
    el.style.zIndex = String(100 + Math.round(local[1]));
    el.dataset.hasPos = "1";
    if (far) {
      setTimeout(() => {
        el.classList.remove("is-teleport");
      }, 80);
    }
  }

  function removePeer(key) {
    const peer = peerState.peers.get(key);
    peerState.peers.delete(key);
    if (!peer) return;
    let el = peer.el;
    if (!el) {
      const layer = document.querySelector(".peer-layer");
      if (layer) {
      Array.from(layer.querySelectorAll(".peer-avatar")).some((node) => {
          if (node.dataset.peerKey === key) {
            el = node;
            return true;
          }
          return false;
        });
      }
    }
    if (el && el.parentNode) {
      el.classList.add("is-leaving");
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 220);
    }
  }

  // 舞台重建（每次 render 都会 replaceChildren）后重新铺一遍同伴
  function syncPeerLayer() {
    const stage = peerStage();
    if (!stage) return;
    const layer = ensurePeerLayer(stage);
    if (!layer) return;
    layer.replaceChildren();
    peerState.peers.forEach((peer) => {
      peer.el = null;
      renderPeer(peer);
    });
  }

  function syncPeersWithView() {
    if (!PEERS_ENABLED || peerState.runtimeOff) return;
    if (!isStudentSession()) {
      leaveRoom();
      return;
    }
    const target = currentView === "scene"
      ? selectedSceneId
      : currentView === "world"
        ? "world"
        : null;
    if (!target) {
      leaveRoom();
      return;
    }
    if (peerState.roomId !== target || !peerState.channel) {
      joinRoom(target);
    }
  }  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const target = currentView === "scene"
      ? selectedSceneId
      : currentView === "world"
        ? "world"
        : null;
    if (!target || !isStudentSession()) return;
    if (peerState.runtimeOff || !peerState.channel) {
      peerState.runtimeOff = false;
      peerState.failCount = 0;
      joinRoom(target, true);
      return;
    }
    peerState.lastSendAt = 0;
    trackSelf();
    sendPeerPos(true);
  });

  // ===== 洛克王国式全屏大世界：功能坞 + 角色走动 =====
  let zoneLayoutReady = false;
  const mapPlayerPos = { x: 50, y: 84 };

  function positionMapPlayer() {
    sendPeerPos();
    const el = document.getElementById("mapPlayer");
    if (!el) return;
    el.style.left = `${mapPlayerPos.x}%`;
    el.style.top = `${mapPlayerPos.y}%`;
    const petEl = document.getElementById("mapPet");
    if (petEl) {
      petEl.style.left = `${Math.min(97, mapPlayerPos.x + 1.9)}%`;
      petEl.style.top = `${Math.min(94, mapPlayerPos.y + 0.7)}%`;
    }
  }

  function moveMapPlayer(dx, dy) {
    mapPlayerPos.x = Math.max(5, Math.min(95, mapPlayerPos.x + dx));
    mapPlayerPos.y = Math.max(8, Math.min(92, mapPlayerPos.y + dy));
    positionMapPlayer();
  }

  // 场景内角色位置（进入场景时回到默认站位）
  const scenePlayerPos = { x: 50, y: 72 };

  function positionScenePlayer() {
    sendPeerPos();
    const el = document.querySelector(".scene-stage .stage-player");
    if (!el) return;
    el.style.left = `${scenePlayerPos.x}%`;
    el.style.top = `${scenePlayerPos.y}%`;
    const petEl = document.querySelector(".scene-stage .stage-pet");
    if (petEl) {
      petEl.style.left = `${Math.min(94, scenePlayerPos.x - 3)}%`;
      petEl.style.top = `${Math.min(92, scenePlayerPos.y + 1)}%`;
    }
  }

  function moveScenePlayer(dx, dy) {
    stopSceneWalk();
    scenePlayerPos.x = Math.max(6, Math.min(94, scenePlayerPos.x + dx));
    scenePlayerPos.y = Math.max(22, Math.min(92, scenePlayerPos.y + dy));
    positionScenePlayer();
  }

  // 鼠标点击走动：点哪儿，角色就走哪儿
  const sceneWalkTarget = { x: null, y: null };
  let sceneWalkTimer = null;
  let walkClickBound = false;

  function stopSceneWalk() {
    sceneWalkTarget.x = null;
    sceneWalkTarget.y = null;
    if (sceneWalkTimer) {
      clearInterval(sceneWalkTimer);
      sceneWalkTimer = null;
      sendPeerPos(true);
    }
  }

  function walkSceneTo(tx, ty) {
    sceneWalkTarget.x = Math.max(6, Math.min(94, tx));
    sceneWalkTarget.y = Math.max(22, Math.min(92, ty));
    if (sceneWalkTimer) return;
    sceneWalkTimer = setInterval(() => {
      const dx = sceneWalkTarget.x - scenePlayerPos.x;
      const dy = sceneWalkTarget.y - scenePlayerPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (!isFinite(dist) || dist < 0.8) {
        stopSceneWalk();
        return;
      }
      const step = Math.min(0.9, dist);
      scenePlayerPos.x += (dx / dist) * step;
      scenePlayerPos.y += (dy / dist) * step;
      positionScenePlayer();
    }, 16);
  }

  function resetScenePlayer() {
    scenePlayerPos.x = 50;
    scenePlayerPos.y = 72;
  }

  function setupZoneLayout() {
    if (!zoneLayoutReady) {
      zoneLayoutReady = true;

      const petBody = document.getElementById("petModalBody");
      const shopBody = document.getElementById("shopModalBody");
      const timerBody = document.getElementById("timerModalBody");

      // 宠物侧栏整体搬进宠物弹窗（计时器单独挪到计时弹窗）
      const sidebar = document.querySelector(".game-sidebar");
      if (sidebar && petBody) {
        const timer = sidebar.querySelector(".timer-panel");
        if (timer && timerBody) {
          timer.style.display = "";
          timerBody.appendChild(timer);
        }
        // 三栏布局：左宠物列表 / 中宠物详情 / 右宠物能力
        const listCol = petBody.querySelector("#petColList");
        const detailCol = petBody.querySelector("#petColDetail");
        const abilityCol = petBody.querySelector("#petColAbility");
        const teamPanel = sidebar.querySelector(".pet-team-panel");
        const overviewPanel = sidebar.querySelector(".hatch-panel");
        const statsPanel = sidebar.querySelector(".stat-panel");
        if (listCol && teamPanel) listCol.appendChild(teamPanel);
        if (detailCol && overviewPanel) detailCol.appendChild(overviewPanel);
        if (abilityCol && statsPanel) abilityCol.appendChild(statsPanel);
        // 操作按钮区挂到「宠物属性」栏底部
        const actionBarEl = document.getElementById("petActionBar");
        if (abilityCol && actionBarEl) abilityCol.appendChild(actionBarEl);
        // 剩余未归类的节点仍放中栏，避免丢失
        while (sidebar.firstElementChild) {
          (detailCol || petBody).appendChild(sidebar.firstElementChild);
        }
        sidebar.style.display = "none";
      }

      // 商店面板搬进商店弹窗
      const shopPanel = document.querySelector("#shopView .shop-panel");
      if (shopPanel && shopBody) {
        shopBody.appendChild(shopPanel);
      }

      const hide = (id) => {
        const m = document.getElementById(id);
        if (m) m.hidden = true;
      };
      document.getElementById("petModalClose")?.addEventListener("click", () => hide("petModal"));
      document.getElementById("shopModalClose")?.addEventListener("click", () => hide("shopModal"));
      document.getElementById("timerModalClose")?.addEventListener("click", () => hide("timerModal"));
      document.getElementById("storeModalClose")?.addEventListener("click", () => hide("storeModal"));
      ["petModal", "shopModal", "timerModal", "storeModal"].forEach((id) => {
        const m = document.getElementById(id);
        if (m) {
          m.addEventListener("click", (e) => {
            if (e.target === m) m.hidden = true;
          });
        }
      });

      const show = (id) => {
        const m = document.getElementById(id);
        if (!m) return;
        m.hidden = false;
        const body = m.querySelector(".zone-modal-body");
        if (body) body.scrollTop = 0;
      };

      document.getElementById("dockPet")?.addEventListener("click", () => show("petModal"));
      document.getElementById("dockShop")?.addEventListener("click", () => {
        renderShop(currentShopTab);
        show("shopModal");
      });
      document.getElementById("dockRank")?.addEventListener("click", () => {
    rankModalReadOnly = false;
    showRank("power");
  });
      // 底栏「商店」：独立的咕噜球 / 时装商店（原「计时」入口）
      document.getElementById("dockTimer")?.addEventListener("click", () => {
        renderStore(currentStoreTab);
        show("storeModal");
      });
      document.getElementById("storeTabBalls")?.addEventListener("click", () => renderStore("balls"));
      document.getElementById("storeTabFashion")?.addEventListener("click", () => renderStore("fashion"));
      // 商店里的购买按钮（事件委托，按钮是动态生成的）
      document.getElementById("storeModalBody")?.addEventListener("click", (e) => {
        const buyBtn = e.target.closest(".ball-shop-buy");
        if (!buyBtn) return;
        e.preventDefault();
        buyBall(buyBtn.dataset.ballId);
      });

      // 方向键 / WASD 走动
      window.addEventListener("keydown", (e) => {
        if (currentView !== "world" && currentView !== "scene") return;
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const code = e.code || "";
        const key = (e.key || "").length === 1 ? e.key.toLowerCase() : e.key;
        const dirs = {
          ArrowLeft: [-3, 0],
          ArrowRight: [3, 0],
          ArrowUp: [0, -3],
          ArrowDown: [0, 3],
          KeyA: [-3, 0],
          KeyD: [3, 0],
          KeyW: [0, -3],
          KeyS: [0, 3],
          a: [-3, 0],
          d: [3, 0],
          w: [0, -3],
          s: [0, 3],
        };
        const dir = dirs[code] || dirs[key];
        if (!dir) return;
        e.preventDefault();
        if (currentView === "world") {
          moveMapPlayer(dir[0], dir[1]);
        } else {
          moveScenePlayer(dir[0], dir[1]);
        }
      });
    }

    const dockBar = document.getElementById("dockBar");
    if (dockBar) dockBar.hidden = false;
    const timerPanel = document.querySelector("#timerModalBody .timer-panel");
    if (timerPanel) timerPanel.style.display = "";
    positionMapPlayer();

    // 场景里点地面就走过去（document 捕获阶段，避免被其他点击处理吞掉）
    if (!walkClickBound) {
      walkClickBound = true;
      document.addEventListener("click", (e) => {
        if (currentView !== "scene") return;
        const target = e.target;
        if (!target || !target.closest) return;
        if (target.closest(".stage-spot")) return;
        const stage = target.closest(".scene-stage");
        if (!stage) return;
        const r = stage.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const tx = ((e.clientX - r.left) / r.width) * 100;
        const ty = ((e.clientY - r.top) / r.height) * 100;
        const mark = document.createElement("div");
        mark.className = "walk-mark";
        mark.style.left = `${tx}%`;
        mark.style.top = `${ty}%`;
        stage.appendChild(mark);
        setTimeout(() => mark.remove(), 620);
        walkSceneTo(tx, ty);
      }, true);
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
      gender: "male",
      hp: 0,
      mp: 0,
      exp: 0,
      rockbell: 0,
      egg: { granted: true, grantedAt: now, hatched: false, hatchedAt: null },
      pet: null,
      pets: [],
      activePetIndex: 0,
      inventory: {},
      balls: {},
      bondScenes: [],
      guideCompleted: false,
      outfits: ["starter"],
      outfit: "starter",
      // 性别互换：每人只能用一次
      genderSwapUsed: false,
      // 自助改密码：每人只能用一次
      passChangeUsed: false,
      // 老师用第二密码进入过几次（1 次 = 扣 2 洛克贝，10 次封顶 1024）
      secondPassUses: 0,
      // 点赞：今天每个榜点过几次 / 我赞过谁几次 / 收到过多少赞
      likesGiven: null,
      likesSent: {},
      likedCount: 0,
      compensationEligible: false,
      compensationClaimed: false,
      createdAt: now,
    };
  }

  // ===== 排行榜：战力 / 财富 / 时装 + 点赞 =====
  const RANK_META = {
    power: { title: "战力榜", hint: "按宠物战力总和排名，点赞每次 +5 洛克贝" },
    wealth: { title: "财富榜", hint: "按洛克贝余额排名，点赞每次 +5 洛克贝" },
    outfit: { title: "时装榜", hint: "按已拥有的时装套数排名，点赞每次 +5 洛克贝" },
  };
  const LIKE_PER_DAY = 3; // 每人每天每个榜单 3 次
  const LIKE_REWARD = 5; // 每次点赞给点赞的人 +5 洛克贝

  function dayKeyOf(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 今日点赞额度：{ day, power, wealth, outfit }，跨天自动重置
  function getLikeQuota(profile) {
    const day = dayKeyOf();
    const q = profile.likesGiven;
    if (!q || q.day !== day) {
      profile.likesGiven = { day, power: 0, wealth: 0, outfit: 0 };
    }
    return profile.likesGiven;
  }

  function likeLeftOf(profile, type) {
    if (!profile) return 0;
    const day = dayKeyOf();
    const q = profile.likesGiven;
    if (!q || q.day !== day) return LIKE_PER_DAY;
    return Math.max(0, LIKE_PER_DAY - (q[type] || 0));
  }

  let rankCache = null;
  let rankCacheAt = 0;
  let rankLoadError = false;
  let rankModalReadOnly = false; // 老师看榜时只读，不显示点赞按钮
  let rankRenderToken = 0;
  // 演练账号（老师自己建的测试号）不参与全班榜单，免得挡住真学生
  const RANK_HIDDEN_PATTERN = /测试|引导|demo|test/i;

  // 排行榜统一从云端拉全班名单，否则每个孩子只能看到自己
  async function loadRankProfiles(force) {
    const now = Date.now();
    if (!force && rankCache && now - rankCacheAt < 60000) return rankCache;
    let list = Array.isArray(state.profiles) ? state.profiles.slice() : [];
    let fresh = !CLOUD_ENABLED; // 没开云端时本地数据就是唯一真相，可以缓存
    rankLoadError = false;

    if (CLOUD_ENABLED) {
      try {
        const rows = await cloudGetAllStudents();
        if (Array.isArray(rows) && rows.length) {
          list = rows.map((row) => profileFromCloud(row));
          fresh = true;
        }
      } catch (error) {
        rankLoadError = true;
        console.warn("读取云端排行榜失败（先显示本地数据）", error);
      }
    }
    rankCache = list.filter((p) => p && p.name);
    // 拉失败就不要缓存，不然这一分钟里每次切榜都只会看到"暂无数据"
    rankCacheAt = fresh ? now : 0;
    return rankCache;
  }

  function buildRankRows(list, type) {
    const all = list || [];
    // 演练账号不上榜，但他们点的赞照样算数
    const visible = all.filter((p) => p && p.name && !RANK_HIDDEN_PATTERN.test(p.name));
    const rows = visible.map((p) => {
      const pets = (Array.isArray(p.pets) ? p.pets : []).filter((pet) => pet && pet.level);
      const ownOutfits = Array.isArray(p.outfits) ? p.outfits.filter(Boolean) : [];
      return {
        name: p.name,
        petCount: pets.length,
        power: pets.reduce((sum, pet) => sum + getPetPower(pet), 0),
        maxLevel: pets.length ? Math.max(...pets.map((pet) => pet.level)) : 0,
        rockbell: Math.max(0, Number(p.rockbell) || 0),
        // 人人都有新手装，老账号存档里没有 outfits 字段时按 1 套算
        outfits: ownOutfits.length || 1,
        // 被赞次数：全班点赞记录汇总（含不上榜的演练账号）
        likedCount: sumLikesFor(all, p.name),
      };
    });
    const sorters = {
      power: (a, b) => b.power - a.power,
      wealth: (a, b) => b.rockbell - a.rockbell,
      outfit: (a, b) => b.outfits - a.outfits,
    };
    return rows.sort(sorters[type] || sorters.power);
  }

  function rankSubText(row, type) {
    if (type === "power")
      return row.petCount ? `${row.petCount}只宠物 · 最高Lv.${row.maxLevel}` : "还没有宠物";
    if (type === "wealth") return "洛克贝余额";
    return "已解锁时装";
  }

  function rankValueText(row, type) {
    if (type === "power") return `战力 ${row.power}`;
    if (type === "wealth") return `💰 ${row.rockbell}`;
    return `👗 ${row.outfits} 套`;
  }

  function renderRankList(container, rows, type, readOnly = false) {
    if (!container) return;
    container.replaceChildren();
    const me = getActiveProfile();
    rows.forEach((row, index) => {
      const item = document.createElement("div");
      item.className = `rank-item${index < 3 ? ` top${index + 1}` : ""}`;

      const num = document.createElement("span");
      num.className = "rank-num";
      num.textContent = index + 1;

      const info = document.createElement("div");
      info.className = "rank-info";

      const name = document.createElement("div");
      name.className = "rank-name";
      name.textContent = me && me.name === row.name ? `${row.name}（我）` : row.name;

      const sub = document.createElement("div");
      sub.className = "rank-sub";
      sub.textContent = rankSubText(row, type);

      info.append(name, sub);

      const value = document.createElement("span");
      value.className = "rank-value";
      value.textContent = rankValueText(row, type);

      // 点赞区：被赞次数 + 点赞按钮（每次 +5 洛克贝，每人每榜每天 3 次）
      const actions = document.createElement("div");
      actions.className = "rank-actions";

      const liked = document.createElement("span");
      liked.className = "rank-liked";
      liked.textContent = `获赞 ${row.likedCount}`;

      const likeBtn = document.createElement("button");
      likeBtn.type = "button";
      likeBtn.className = "rank-like-btn";
      const isMe = me && me.name === row.name;
      const left = likeLeftOf(me, type);

      if (readOnly) {
        // 老师端只看数据，不给点赞按钮，免得看着一堆"明天再来"以为坏了
        actions.append(liked);
        item.append(num, info, value, actions);
        container.appendChild(item);
        return;
      }

      if (isMe) {
        likeBtn.disabled = true;
        likeBtn.textContent = "自己";
      } else if (left <= 0) {
        likeBtn.disabled = true;
        likeBtn.textContent = "明天再来";
      } else {
        likeBtn.textContent = "点赞";
      }
      likeBtn.addEventListener("click", () => likeRankEntry(row.name, type, likeBtn));

      actions.append(liked, likeBtn);
      item.append(num, info, value, actions);
      container.appendChild(item);
    });

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rank-item";
      empty.style.justifyContent = "center";
      empty.style.color = "var(--muted)";
      empty.textContent = rankLoadError
        ? "网络有点慢，没读到全班名单，过几秒重新打开排行榜试试。"
        : "暂无排行数据";
      container.appendChild(empty);
    }
  }

  async function showRank(type) {
    const key = RANK_META[type] ? type : "power";
    const token = ++rankRenderToken;
    [
      [els.rankTabPower, "power"],
      [els.rankTabWealth, "wealth"],
      [els.rankTabOutfit, "outfit"],
    ].forEach(([el, k]) => {
      if (el) el.classList.toggle("active", k === key);
    });
    els.rankModal.hidden = false;
    els.rankModal.style.zIndex = "10001"; // 老师模式下登录层是 9999，弹窗要压在它上面
    if (els.rankList) els.rankList.scrollTop = 0; // 每次都从第一名看起
    // 有缓存就先秒出，避免每切一个榜都闪一下"读取中"
    if (rankCache) {
      renderRankList(els.rankList, buildRankRows(rankCache, key), key, rankModalReadOnly);
    } else if (els.rankList) {
      els.rankList.innerHTML =
        '<div class="rank-item" style="justify-content:center;color:var(--muted)">正在读取全班数据…</div>';
    }

    const list = await loadRankProfiles();
    if (token !== rankRenderToken) return; // 期间又切了别的榜，让后来的那次渲染
    renderRankList(els.rankList, buildRankRows(list, key), key, rankModalReadOnly);
  }

  // 被赞次数 = 全班所有人"赞过这个人几次"加起来。
  // 存在各自的 likesSent 里，互相不写对方的存档，避免两个人同时在线时把赞数覆盖掉
  function sumLikesFor(profiles, name) {
    if (!name) return 0;
    let total = 0;
    (profiles || []).forEach((p) => {
      const sent = p && p.likesSent;
      if (sent && typeof sent === "object") {
        total += Math.max(0, Number(sent[name]) || 0);
      }
    });
    return total;
  }

  // 点赞拿到洛克贝时，中间弹一下"恭喜获得"，1 秒后自己淡出
  function showCoinGain(amount, total) {
    document.querySelectorAll(".coin-gain").forEach(function (n) { n.remove(); });
    const box = document.createElement("div");
    box.className = "coin-gain";
    box.innerHTML =
      '<div class="coin-gain-title">🎉 恭喜获得</div>' +
      '<div class="coin-gain-amount">+' + amount + ' 洛克贝</div>' +
      '<div class="coin-gain-total">当前 ' + total + ' 个</div>';
    document.body.appendChild(box);
    setTimeout(function () {
      box.classList.add("is-out");
      setTimeout(function () { box.remove(); }, 300);
    }, 1000);
  }
  // 点赞：给被赞的同学 +1 赞，给点赞的人 +5 洛克贝，每人每榜每天最多 3 次
  async function likeRankEntry(targetName, type, btn) {
    const me = getActiveProfile();
    if (!me || !targetName) return;
    if (me.name === targetName) {
      setResult("不能给自己点赞。", true);
      return;
    }
    const left = likeLeftOf(me, type);
    if (left <= 0) {
      setResult("这个榜今天已经点满 3 次了，明天再来吧。", true);
      return;
    }
    if (btn && btn.disabled) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "点赞中…";
    }

    const quota = getLikeQuota(me);
    quota[type] = (quota[type] || 0) + 1;
    if (!me.likesSent || typeof me.likesSent !== "object") me.likesSent = {};
    me.likesSent[targetName] = (Number(me.likesSent[targetName]) || 0) + 1;
    me.rockbell = (Number(me.rockbell) || 0) + LIKE_REWARD;
    saveState(`给 ${targetName} 点了赞`);
    showCoinGain(LIKE_REWARD, me.rockbell);

    setResult(`👍 给 ${targetName} 点赞成功，你获得 ${LIKE_REWARD} 洛克贝。`, false);

    const list = await loadRankProfiles(true); // 强制刷新，赞数要从云端最新算
    // 自己刚点的这一下本地已经记上了，云端同步还没回来，先把本地这份合进去，避免点了没反应
    const self = getActiveProfile();
    const merged = list.map((p) =>
      self && p && p.name === self.name ? Object.assign({}, p, { likesSent: self.likesSent }) : p,
    );
    rankCache = merged;
    rankCacheAt = Date.now();
    if (els.rankModal && !els.rankModal.hidden) {
      renderRankList(els.rankList, buildRankRows(merged, type), type);
    }
    render();
  }

  // 角色面板用：把自己收到的赞刷新一下（别人点的赞存在别人的存档里）
  async function refreshMyLikedCount(profile) {
    if (!profile) return;
    const list = await loadRankProfiles();
    const total = sumLikesFor(list, profile.name);
    profile.likedCount = total;
    const el = document.getElementById("roleLikedValue");
    if (el) el.textContent = `${total} 次`;
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
    els.registerForm = document.getElementById("registerForm");
    els.registerName = document.getElementById("registerName");
    els.registerPass = document.getElementById("registerPass");
    els.registerBtn = document.getElementById("registerBtn");
    els.pushAllToCloud = document.getElementById("pushAllToCloud");
    els.exportAllSaves = document.getElementById("exportAllSaves");
    els.exportMessage = document.getElementById("exportMessage");
    els.rankModal = document.getElementById("rankModal");
    els.rankList = document.getElementById("rankList");
    els.rankClose = document.getElementById("rankClose");
    els.rankTabPower = document.getElementById("rankTabPower");
   els.rankTabWealth = document.getElementById("rankTabWealth");
    els.rankTabOutfit = document.getElementById("rankTabOutfit");
    els.rankViewTabPower = document.getElementById("rankViewTabPower");
   els.rankViewTabWealth = document.getElementById("rankViewTabWealth");
    els.rankViewTabOutfit = document.getElementById("rankViewTabOutfit");
    els.rankTitle = document.getElementById("rankTitle");
    els.rankHint = document.getElementById("rankHint");
    els.navRank = document.getElementById("navRank");
    els.saveStatus = document.getElementById("saveStatus");
    els.createForm = document.getElementById("createForm");
    els.playerName = document.getElementById("playerName");
    els.profileList = document.getElementById("profileList");
    els.emptyState = document.getElementById("emptyState");
    els.gameView = document.getElementById("gameView");
    els.activeName = document.getElementById("activeName");
    els.activeGender = document.getElementById("activeGender");
    els.rockbell = document.getElementById("rockbell");
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
    els.bondValue = document.getElementById("bondValue");
    els.bondBar = document.getElementById("bondBar");
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

  // ===== 登录外壳：账号登录 / 账号注册 / 后台登录，学生多一层「开始游戏 / 学习台」选择页 =====
  function setLoginMode(mode) {
    document.querySelectorAll("[data-login-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.loginMode === mode);
    });
    const studentForm = document.getElementById("studentLoginForm");
    const registerForm = document.getElementById("registerForm");
    const teacherForm = document.getElementById("loginForm");
    const landing = document.getElementById("studentLanding");
    // 三个表单同一时间只放一个，切换时落地页和所有提示一起复位
    if (studentForm) studentForm.hidden = mode !== "student";
    if (registerForm) registerForm.hidden = mode !== "register";
    if (teacherForm) teacherForm.hidden = mode !== "teacher";
    if (landing) landing.hidden = true;
    ["studentLoginError", "registerError", "loginError", "landingNotice"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  // 学生登录成功：不直接进游戏，先给一个选择页
  function showStudentLanding(name) {
    const landing = document.getElementById("studentLanding");
    const tabs = document.querySelector(".login-tabs");
    if (!landing) return;
    if (tabs) tabs.hidden = true;
    ["studentLoginForm", "registerForm", "loginForm", "studentLoginError", "registerError", "landingNotice"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    document.getElementById("landingHello").textContent = `你好，${name}`;
    landing.hidden = false;
    els.loginView.classList.remove("hidden");
  }

  function showLandingNotice(text) {
    const el = document.getElementById("landingNotice");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showLandingNotice._t);
    showLandingNotice._t = setTimeout(() => {
      el.hidden = true;
    }, 3000);
  }

  // 真正进游戏：原先写在学生登录成功那一段，原样搬出来，点「开始游戏」才执行
  function enterGame() {
    els.loginView.classList.add("hidden");
    const backHomeBtn = document.getElementById("btnBackHome");
    if (backHomeBtn) backHomeBtn.hidden = false;
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
    setupZoneLayout();
    render();
  }

  // 游戏顶栏「🏠 学习台」：只是把全屏选择页盖回去，不重新鉴权、不重读云端、不动 state
  function reopenHome() {
    const tabs = document.querySelector(".login-tabs");
    if (tabs) tabs.hidden = true;
    ["studentLoginForm", "studentLoginError", "registerError", "landingNotice", "registerForm", "loginForm"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
    const landing = document.getElementById("studentLanding");
    if (landing) landing.hidden = false;
    els.loginView.classList.remove("hidden");
  }

  // 账号注册：名字 + 4~6 位数字密码，走服务端建档（和登录里"自动建档"是同一条链路）
  async function handleRegister(event) {
    event.preventDefault();
    if (!CLOUD_ENABLED) {
      showRegisterError("云端未配置，暂时只能本地玩");
      return;
    }
    const name = (els.registerName.value || "").trim().slice(0, 12);
    const pass = (els.registerPass.value || "").trim();
    if (!name) {
      showRegisterError("请先填一个账号名");
      return;
    }
    if (!/^\d{4,6}$/.test(pass)) {
      showRegisterError("密码要 4~6 位数字");
      return;
    }
    showRegisterError("");
    els.registerBtn.disabled = true;
    const oldLabel = els.registerBtn.textContent;
    els.registerBtn.textContent = "正在注册…";
    try {
      const fresh = buildNewProfile(name, pass);
      const res = await rpcCall("student_register", {
        p_name: name,
        p_pin: pass,
        p_save: fresh,
      });
      if (!res || !res.ok) {
        const code = res && res.code;
        if (code === "exists") showRegisterError("这个名字已经有人用了，换一个");
        else if (code === "bad_pin_format") showRegisterError("密码要 4~6 位数字");
        else if (code === "class_locked") showRegisterError("老师已暂停全班登录，等老师说开始");
        else if (code === "bad_pin") showRegisterError("密码不对，再试一次");
        else showRegisterError("注册没通过，稍后再试");
        return;
      }
      studentToken = res.token || null;
      const profile = profileFromCloud({ name, save: res.save, updated_at: res.updated_at });
      state.profiles = [profile];
      state.selectedId = profile.id;
      activeStorageKey = `${STORAGE_KEY}_cloud_${name}`;
      cloudSyncAllowed = true;
      guideStartIndex = 1;
      normalizeState();
      pendingEvolution = null;
      try {
        localStorage.setItem(activeStorageKey, JSON.stringify(state));
      } catch (err) {
        console.warn("写本地缓存失败", err);
      }
      showStudentLanding(profile.name);
    } catch (err) {
      console.error("账号注册失败", err);
      showRegisterError("连不上云端，检查网络后再试");
    } finally {
      els.registerBtn.disabled = false;
      els.registerBtn.textContent = oldLabel;
    }
  }

  function showRegisterError(message) {
    const el = document.getElementById("registerError");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  // 切换账号：重载回登录页，顺手把本地缓存落一次，避免刚打的几秒进度丢在内存里
  function switchAccount() {
    try {
      localStorage.setItem(activeStorageKey, JSON.stringify(state));
    } catch (err) {
      /* 忽略 */
    }
    location.reload();
  }

  function bindEvents() {
    els.loginForm.addEventListener("submit", handleLogin);
    if (els.studentLoginForm) {
      els.studentLoginForm.addEventListener("submit", handleStudentLogin);
    }
    // 账号登录 / 账号注册 / 后台登录三个入口来回切，统一走 setLoginMode，保证只露一个表单
    document.querySelectorAll("[data-login-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setLoginMode(btn.dataset.loginMode));
    });
    const registerForm = document.getElementById("registerForm");
    if (registerForm) registerForm.addEventListener("submit", handleRegister);
    const startGameBtn = document.getElementById("btnStartGame");
    if (startGameBtn) startGameBtn.addEventListener("click", enterGame);
    const studyRoomBtn = document.getElementById("btnStudyRoom");
    if (studyRoomBtn) {
      studyRoomBtn.addEventListener("click", () => {
        // 学习台 → 题库主页（独立静态页，点题再进 Dev-C++ 做题页）
        const win = window.open("刷题主页.html", "_studypage");
        if (!win) showLandingNotice("题库页被浏览器拦下了，允许弹窗后再试一次");
      });
    }
    const switchAccountBtn = document.getElementById("btnSwitchAccount");
    if (switchAccountBtn) switchAccountBtn.addEventListener("click", switchAccount);
    const backHomeBtn = document.getElementById("btnBackHome");
    if (backHomeBtn) backHomeBtn.addEventListener("click", reopenHome);
    els.rankClose?.addEventListener("click", () => { els.rankModal.hidden = true; });
    els.rankTabPower?.addEventListener("click", () => showRank("power"));
   els.rankTabWealth?.addEventListener("click", () => showRank("wealth"));
    els.rankTabOutfit?.addEventListener("click", () => showRank("outfit"));
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

    // 后台名单：点名字看详情、搜名字过滤
    document.getElementById("teacherRoster")?.addEventListener("click", (e) => {
      const chip = e.target.closest(".teacher-roster-chip");
      if (!chip) return;
      teacherSelectedId = chip.dataset.profileId;
      const profiles = getTeacherRosterProfiles();
      const profile = state.profiles.find((p) => p.id === teacherSelectedId);
      if (!profile) return;
      els.teacherSelect.value = profile.id;
      renderTeacherRoster(profiles);
      renderTeacherDetail(profile);
    });

    document.getElementById("teacherRosterSearch")?.addEventListener("input", () => {
      renderTeacherRoster(getTeacherRosterProfiles());
    });

    // 后台详情：道具加减
    document.getElementById("teacherDetail")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".teacher-item-btn");
      if (!btn || btn.disabled) return;
      const profile = state.profiles.find((p) => p.id === teacherSelectedId);
      if (!profile) return;
      const delta = Number(btn.dataset.delta) || 0;
      const id = btn.dataset.itemId;
      if (!id || !delta) return;
      if (btn.dataset.kind === "ball") {
        if (!profile.balls) profile.balls = {};
        profile.balls[id] = Math.max(0, (profile.balls[id] || 0) + delta);
      } else {
        if (!profile.inventory) profile.inventory = {};
        profile.inventory[id] = Math.max(0, (profile.inventory[id] || 0) + delta);
        if (profile.inventory[id] <= 0) delete profile.inventory[id];
      }
      saveState("后台调整道具");
      renderTeacherDetail(profile);
      renderTeacherRoster(getTeacherRosterProfiles());
      pushTeacherProfileToCloud(profile);
    });

    els.teacherLogout.addEventListener("click", handleTeacherLogout);
    if (els.pushAllToCloud) {
      els.pushAllToCloud.addEventListener("click", pushAllSavesToCloud);
    }
    if (els.exportAllSaves) {
      els.exportAllSaves.addEventListener("click", exportAllSaves);
    }
    document
      .getElementById("lockAllPasswords")
      ?.addEventListener("click", lockAllPasswords);
    document
      .getElementById("unlockAllPasswords")
      ?.addEventListener("click", restoreAllPasswords);
    document
      .getElementById("exportPassBackup")
      ?.addEventListener("click", exportPassBackup);
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
    // 宠物操作按钮区（在宠物属性栏底部）
    document.getElementById("petActionBar")?.addEventListener("click", handlePetTeamClick);
    // 捕捉窗口事件
    els.captureClose?.addEventListener("click", closeCaptureModal);
    els.captureBallList?.addEventListener("click", handleCaptureBallClick);
    els.captureModal?.addEventListener("click", (e) => {
      if (e.target === els.captureModal) closeCaptureModal();
    });
    // 排行榜视图切换
    els.navRank?.addEventListener("click", () => {
      // 老师模式下 game 视图是藏着的，改用弹窗展示榜单（只读，不能点赞）
      rankModalReadOnly = true;
      showRank(rankViewType || "power");
    });
    const bindRankViewTab = (el, type) =>
      el?.addEventListener("click", () => {
        rankViewType = type;
        renderRankView();
      });
    bindRankViewTab(els.rankViewTabPower, "power");
   bindRankViewTab(els.rankViewTabWealth, "wealth");
    bindRankViewTab(els.rankViewTabOutfit, "outfit");
    // 引导系统事件（新版：手指引导 + 功能卡）
    els.guideSkip?.addEventListener("click", skipGuideV2);
    els.guideNext?.addEventListener("click", () => handleGuideNextClick());
    const guideCardsSkipBtn = document.getElementById("guideCardsSkip");
    guideCardsSkipBtn?.addEventListener("click", skipGuideV2);
    document.getElementById("guideCardPrev")?.addEventListener("click", () => changeGuideCard(-1));
    document.getElementById("guideCardNext")?.addEventListener("click", () => changeGuideCard(1));
    document.getElementById("guideHelpBtn")?.addEventListener("click", () => {
      const profile = getActiveProfile();
      if (!profile) return;
      openGuideV2(1, 0, true);
    });
    // 老师后台新事件
    els.publishRankReward?.addEventListener("click", publishRankReward);
    els.resetGuide?.addEventListener("click", handleResetGuide);
    setupRoleModal();
    setupPetTabs();

    // 场景道具抽屉：点顶栏胶囊开合
    const bagBtn = document.getElementById("sceneBagBtn");
    bagBtn?.addEventListener("click", () => {
      const inv = document.getElementById("sceneInventory");
      if (inv) inv.classList.toggle("open");
    });
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

    // 宠物栏：所有宠物 + 出战下标
    // 【修复】原来这里写死 clamp 到 0~2，导致第 4、5、6 只永远选不上出战（一存档就被改回第 3 只）
    const petList = Array.isArray(profile?.pets)
      ? profile.pets.map(normalizePet).filter(Boolean)
      : (pet ? [pet] : []);
    const petIndex = clampInteger(profile?.activePetIndex, 0, Math.max(0, petList.length - 1));

    return {
      id:
        typeof profile?.id === "string" && profile.id
          ? profile.id
          : `role_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: sanitizeName(profile?.name || "未命名角色"),
      // 【安全改造】存档里不再保留 pass
      gender: profile?.gender === "female" ? "female" : "male",
      hp: clampInteger(profile?.hp, 0, Number.MAX_SAFE_INTEGER),
      mp: clampInteger(profile?.mp, 0, Number.MAX_SAFE_INTEGER),
      exp: clampInteger(profile?.exp, 0, Number.MAX_SAFE_INTEGER),
      rockbell: clampInteger(profile?.rockbell, 0, Number.MAX_SAFE_INTEGER),
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
      pets: petList,
      activePetIndex: petIndex,
      // 咕噜球库存：{ ballId: 数量 }
      balls: normalizeInventory(profile?.balls),
      // 新手引导是否完成
      guideCompleted: Boolean(profile?.guideCompleted),
      // 新引导进度：0 未开始 / 1 手指引导 / 2 功能卡 / 3 已完成
      guideStage: typeof profile?.guideStage === "number"
        ? clampInteger(profile.guideStage, 0, 3)
        : (profile?.guideCompleted ? 3 : 0),
      guideStepIndex: clampInteger(profile?.guideStepIndex, 0, 12),
      // 时装：已拥有的套装 id 列表 + 当前穿着
      outfits: Array.isArray(profile?.outfits)
        ? Array.from(new Set(profile.outfits.filter((id) => typeof id === "string")))
        : ["starter"],
      outfit: typeof profile?.outfit === "string" && findOutfit(profile.outfit).id === profile.outfit
        ? profile.outfit
        : "starter",
      // 性别互换：每人只能用一次
      genderSwapUsed: Boolean(profile?.genderSwapUsed),
      // 自助改密码：每人只能用一次
      passChangeUsed: Boolean(profile?.passChangeUsed),
      // 老师用第二密码进入过几次（1 次 = 扣 2 洛克贝，10 次封顶 1024）
      secondPassUses: clampInteger(profile?.secondPassUses, 0, SECOND_PASS_MAX_USES),
      // 点赞：今天每个榜已经点过几次（{ day, power, wealth, outfit }）
      likesGiven:
        profile?.likesGiven && typeof profile.likesGiven === "object"
          ? {
              day: String(profile.likesGiven.day || ""),
              power: clampInteger(profile.likesGiven.power, 0, LIKE_PER_DAY),
              wealth: clampInteger(profile.likesGiven.wealth, 0, LIKE_PER_DAY),
              outfit: clampInteger(profile.likesGiven.outfit, 0, LIKE_PER_DAY),
            }
          : null,
      // 我赞过谁几次：{ "同学名": 次数 }
      likesSent:
        profile?.likesSent && typeof profile.likesSent === "object" ? profile.likesSent : {},
      // 收到的赞（展示用，打开面板时按全班记录重新算）
      likedCount: Math.max(0, Number(profile?.likedCount) || 0),
    };
  }

  // 底栏角色信息面板：头像 + 名字 + 性别 + 洛克贝 + 出战宠物
  function renderDockProfile(profile) {
    const box = document.getElementById("dockProfile");
    if (!box || !profile) return;
    box.replaceChildren();

    const pets = Array.isArray(profile.pets) ? profile.pets : [];
    const activePet = pets[profile.activePetIndex] || profile.pet || null;

    const avatar = document.createElement("img");
    avatar.className = "dock-profile-avatar";
    avatar.alt = "";
    avatar.src = outfitSrc(profile);
    avatar.onerror = function () { avatar.style.visibility = "hidden"; };
    box.appendChild(avatar);

    const main = document.createElement("div");
    main.className = "dock-profile-main";

    const nameRow = document.createElement("div");
    nameRow.className = "dock-profile-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = profile.name;
    const genderSpan = document.createElement("span");
    genderSpan.className = "dock-profile-gender";
    genderSpan.textContent = genderLabel(profile.gender);
    nameRow.append(nameSpan, genderSpan);

    const metaRow = document.createElement("div");
    metaRow.className = "dock-profile-meta";
    const apLabel = document.createElement("span");
    apLabel.innerHTML = '洛克贝 <b>' + profile.rockbell + '</b>';
    metaRow.appendChild(apLabel);
    if (activePet) {
      const petLabel = document.createElement("span");
      petLabel.innerHTML =
        '宠物 <b>' + (activePet.name || "—") + '</b> Lv.' + (activePet.level || 1);
      metaRow.appendChild(petLabel);
    }

    main.append(nameRow, metaRow);
    box.appendChild(main);
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
  // 【安全改造·第二批】读市场走服务端函数，卖家名字由服务端掩码（王*智），不再露真名
  async function loadMarketFromCloud() {
    if (!CLOUD_ENABLED) return marketState;
    try {
      const rows = await rpcCall("market_list", {});
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
  // 【安全改造·第二批】扣背包、建上架都在服务端一次做完，前端只发意图
  async function listItem(itemId, customPrice) {
    const profile = getActiveProfile();
    if (!profile) return { ok: false, msg: "请先选择角色。" };
    const count = profile.inventory[itemId] || 0;
    if (count < 1) return { ok: false, msg: "背包中没有该道具。" };
    const itemDef = getItemDef(itemId);
    if (!itemDef) return { ok: false, msg: "道具不存在。" };
    const raw = Number(customPrice);
    const price =
      Number.isFinite(raw) && raw > 0
        ? Math.min(99999, Math.max(2, Math.floor(raw)))
        : Math.max(2, getItemPrice(itemId));
    if (CLOUD_ENABLED) {
      if (!studentToken) return { ok: false, msg: "会话已过期，请重新登录。" };
      try {
        const res = await rpcCall("market_add", {
          p_token: studentToken,
          p_item_id: itemId,
          p_item_name: itemDef.name,
          p_price: price,
        });
        if (!res || !res.ok) {
          const codes = {
            no_item: "背包里没有这个道具了",
            no_session: "会话已过期，请重新登录",
            bad_price: "价格不合适",
          };
          return { ok: false, msg: codes[res && res.code] || "上架失败，请重试。" };
        }
      } catch (error) {
        console.error("上架到云端市场失败", error);
        return { ok: false, msg: "上架失败，请检查网络后重试。" };
      }
    }
    // 服务端已扣掉一个，本地跟着扣
    profile.inventory[itemId] = count - 1;
    if (profile.inventory[itemId] <= 0) delete profile.inventory[itemId];
    await loadMarketFromCloud();
    saveState("已上架");
    return { ok: true, msg: `已上架【${itemDef.name}】，售价 ${price} 洛克贝。` };
  }

  // 下架道具（服务端校验"是不是你的"，再把道具退回背包）
  async function unlistItem(listingId) {
    const profile = getActiveProfile();
    if (!profile) return { ok: false, msg: "请先选择角色。" };
    const listing = marketState.listings.find((l) => l.id === listingId);
    if (!listing) return { ok: false, msg: "该上架不存在。" };
    if (listing.sellerId !== profile.id) return { ok: false, msg: "只能下架自己的道具。" };
    if (CLOUD_ENABLED) {
      if (!studentToken) return { ok: false, msg: "会话已过期，请重新登录。" };
      try {
        const res = await rpcCall("market_cancel", { p_token: studentToken, p_id: listingId });
        if (!res || !res.ok) {
          return { ok: false, msg: res && res.code === "not_mine" ? "只能下架自己的道具。" : "下架失败，请重试。" };
        }
      } catch (error) {
        console.error("下架失败", error);
        return { ok: false, msg: "下架失败，请检查网络后重试。" };
      }
    }
    profile.inventory[listing.itemId] = (profile.inventory[listing.itemId] || 0) + 1;
    marketState.listings = marketState.listings.filter((l) => l.id !== listingId);
    saveMarket();
    saveState("已下架");
    return { ok: true, msg: `已下架【${listing.itemName}】，已退回背包。` };
  }

  // 购买道具（服务端一次事务：抢锁、扣钱、给道具、给卖家结算）
  async function buyItem(listingId) {
    const profile = getActiveProfile();
    if (!profile) return { ok: false, msg: "请先选择角色。" };
    const listing = marketState.listings.find((l) => l.id === listingId);
    if (!listing) return { ok: false, msg: "该道具已被买走或下架。" };
    if (listing.sellerId === profile.id) return { ok: false, msg: "不能购买自己上架的道具。" };
    if (profile.rockbell < listing.price) return { ok: false, msg: `洛克贝不足，需要 ${listing.price} 洛克贝。` };

    const fee = marketFee(listing.price);
    const sellerReceive = Math.max(0, listing.price - fee);

    if (CLOUD_ENABLED) {
      if (!studentToken) return { ok: false, msg: "会话已过期，请重新登录。" };
      let res = null;
      try {
        res = await rpcCall("market_buy", { p_token: studentToken, p_id: listingId });
      } catch (error) {
        console.error("购买失败", error);
        return { ok: false, msg: "购买失败，请检查网络后重试。" };
      }
      if (!res || !res.ok) {
        if (res && res.code === "gone") {
          await loadMarketFromCloud();
          return { ok: false, msg: "手慢了，这件道具已经被别人买走。" };
        }
        if (res && res.code === "poor") return { ok: false, msg: "洛克贝不足。" };
        if (res && res.code === "self") return { ok: false, msg: "不能购买自己上架的道具。" };
        return { ok: false, msg: "购买失败，请重试。" };
      }
      // 服务端已经扣过钱、结算过卖家，这里只把本地界面刷新成服务端的真实存档
      await refreshSelfSave();
      await loadMarketFromCloud();
      saveState("购买已存档");
      return {
        ok: true,
        msg: `购买成功！获得【${listing.itemName}】，花费 ${listing.price} 洛克贝。卖家 ${listing.sellerName} 到手 ${sellerReceive} 洛克贝（手续费 ${fee}）。`,
      };
    }

    // 本地离线模式：没有服务端，就按原逻辑在本地算
    profile.rockbell -= listing.price;
    profile.inventory[listing.itemId] = (profile.inventory[listing.itemId] || 0) + 1;
    marketState.listings = marketState.listings.filter((l) => l.id !== listingId);
    saveMarket();
    saveState("购买已存档");
    return {
      ok: true,
      msg: `购买成功！获得【${listing.itemName}】，花费 ${listing.price} 洛克贝。`,
    };
  }

  // 服务端改过我的存档（买道具扣钱）之后，把最新存档拉回来覆盖本地
  async function refreshSelfSave() {
    if (!studentToken) return;
    try {
      const res = await rpcCall("class_roster", { p_token: studentToken });
      const rows = Array.isArray(res) ? res : [];
      const me = getActiveProfile();
      if (!me) return;
      const row = rows.find((r) => r && r.name === me.name);
      if (!row || !row.save) return;
      const fresh = profileFromCloud(row);
      // 只覆盖服务端说了算的数值，其他本地内容保持不动
      me.rockbell = fresh.rockbell;
      me.inventory = fresh.inventory;
      me.pets = fresh.pets;
      me.pet = fresh.pet;
      state.profiles = state.profiles.map((p) => (p.id === me.id ? me : p));
    } catch (err) {
      console.warn("拉回自己的最新存档失败", err);
    }
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
      rockbell: 0,
      egg: { granted: true, grantedAt: now, hatched: false, hatchedAt: null },
      pet: null,
      pets: [],
      activePetIndex: 0,
      inventory: {},
      balls: {},
      bondScenes: [],
      guideCompleted: false,
      outfits: ["starter"],
      outfit: "starter",
      // 性别互换：每人只能用一次
      genderSwapUsed: false,
      // 自助改密码：每人只能用一次
      passChangeUsed: false,
      // 老师用第二密码进入过几次（1 次 = 扣 2 洛克贝，10 次封顶 1024）
      secondPassUses: 0,
      // 点赞：今天每个榜点过几次 / 我赞过谁几次 / 收到过多少赞
      likesGiven: null,
      likesSent: {},
      likedCount: 0,
      compensationEligible: false,
      compensationClaimed: false,
      createdAt: now,
    };
    state.profiles.unshift(profile);
    state.selectedId = profile.id;
    selectedSceneId = "grassland";
    resultMessage = "角色已创建！获得10点初始洛克贝和1个宠物蛋，快去孵化吧！";
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
    resetScenePlayer();
    stopSceneWalk();
    positionScenePlayer();
    switchView("scene");
  }

  function switchView(view) {
    currentView = view;
    if (view === "world") {
      selectedSpotId = null;
      stopSceneWalk();
    }
    if (view !== "scene") stopSceneWalk();
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
    // 探索不再消耗洛克贝：孩子可自由探索，洛克贝只用于消费（孵化、换宠、咕噜球、计时加速）
    isExploring = true;
    const spotName = spot ? spot.name : "探索";
    const spots = SCENE_SPOTS[scene.id] || [];
    const spotIndex = spot ? spots.findIndex((s) => s.id === spot.id) : -1;
    setSceneResult(`正在${spotName}探索中…`, false, true);

    setTimeout(() => {
      const outcome = rollSceneDrop(scene, spot?.exp);

      // 判定是否遇敌
      // 新手引导那一次探索不遇敌：先让孩子熟悉「探索→拿经验」这个循环，别一上手就碰上输掉战斗的弹窗
      const guideSoftExplore = profile.guideStage === 1 && guideV2StepIndex === 4 && !guideV2ReviewMode;
      const wildConfig = WILD_PETS[scene.id];
      const encounter = !guideSoftExplore && wildConfig && profile.pet && Math.random() < wildConfig.encounterRate;
      // 遇敌了就不给经验，所以把经验补偿到"没遇敌"的那几次探索上，总量不变
      const expComp = wildConfig && profile.pet ? 1 / (1 - (wildConfig.encounterRate || 0)) : 1;
      const expMult = SCENE_EXP_MULT[scene.id] || 1;
      let battleWin = true;
      let lostItem = null;
      let expGained = 0;

      if (encounter) {
        const wildPet = generateWildPet(scene.id, spotIndex);
        if (wildPet) {
          const battle = simulateBattle(profile.pet, wildPet);
          battleWin = battle.win;
          showBattleModal(profile.pet, wildPet, battle);

          if (battleWin) {
            // 打赢了也不给经验，只留洛克贝和捕捉机会
            expGained = 0;
            // 15%概率弹出捕捉窗口（等战斗演出播完再弹，避免两个弹窗叠加）
            if (Math.random() < 0.15 && profile.pets.length < MAX_PETS) {
              setTimeout(() => {
                showCaptureModal(wildPet);
              }, 3400);
            }
          } else {
            // 打输了：不给经验，50% 概率被抢走一个道具
            expGained = 0;
            const ownedItems = Object.entries(profile.inventory).filter(([, count]) => count > 0);
            if (ownedItems.length > 0 && Math.random() < 0.5) {
              const [lostId] = ownedItems[Math.floor(Math.random() * ownedItems.length)];
              profile.inventory[lostId] -= 1;
              const lostDef = getItemDef(lostId);
              lostItem = lostDef?.name || lostId;
            }
          }
        } else {
          expGained = Math.round(outcome.exp * expComp * expMult);
          profile.exp += expGained;
        }
      } else {
        expGained = Math.round(outcome.exp * expComp * expMult);
        profile.exp += expGained;
      }

      // 洛克贝产出：每打完一场战斗 +1（不分场景、不分胜负）
      if (encounter) {
        profile.rockbell = (profile.rockbell || 0) + 1;
      }

      const eggGranted = grantEggIfEligible(profile);
      const parts = [];
      if (encounter) {
        parts.push(
          battleWin
            ? `${scene.name}·${spotName}：打败了野生宠物，这场不给经验。`
            : `${scene.name}·${spotName}：💔 打输了，这场不给经验。`
        );
      } else {
        parts.push(`${scene.name}·${spotName}：经验 +${expGained}。`);
      }
      if (encounter) parts.push("洛克贝 +1。");
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
        parts.push("战斗胜利！可以趁现在试着抓它。");
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

  let sceneResultTimer = null; // 场景提示 2 秒后自动消失
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
    // 新提示顶替旧的，并重新计时；"探索中…"这种常驻状态不走倒计时
    if (sceneResultTimer) {
      clearTimeout(sceneResultTimer);
      sceneResultTimer = null;
    }
    if (message && !exploring) {
      sceneResultTimer = setTimeout(() => {
        if (els.sceneResult) {
          els.sceneResult.textContent = "";
          els.sceneResult.className = "result-message";
          els.sceneResult.removeAttribute("data-item-icon");
          els.sceneResult.removeAttribute("data-item-name");
        }
        sceneResultTimer = null;
      }, 2000);
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
    profile.rockbell += COMPENSATION_ACTION_POINTS;
    profile.compensationClaimed = true;
    setResult(
      `补偿已领取：宠物已随机更换为 ${profile.pet.name}（${profile.pet.type}），洛克贝 +${COMPENSATION_ACTION_POINTS}。`,
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

  // 随机新宠物：消耗 50 洛克贝，新宠物初始状态，经验归 0，亲密度归零，道具保留
  function handleRandomPet() {
    const profile = getActiveProfile();
    if (!profile?.pet) {
      return;
    }
    if (profile.rockbell < PET_REFRESH_COST) {
      setResult(`洛克贝不足，随机新宠物需要 ${PET_REFRESH_COST} 洛克贝。`, true);
      render();
      return;
    }

    const oldPetName = profile.pet.name;
    const confirmed = window.confirm(
      `确定消耗 ${PET_REFRESH_COST} 洛克贝重新随机宠物吗？\n\n` +
      `· 新宠物为初始状态（Lv.1，阶段 1）\n` +
      `· 角色经验将归 0（当前 ${profile.exp}）\n` +
      `· 宠物亲密度将归零（当前 Lv.${profile.pet.bond || 0}）\n` +
      `· 道具背包保留不变\n\n` +
      `当前宠物：${oldPetName}`,
    );
    if (!confirmed) {
      return;
    }

    // 扣洛克贝
    profile.rockbell -= PET_REFRESH_COST;

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
    let randomMsg = `已重新随机宠物：${oldPetName} → ${profile.pet.name}（${profile.pet.style}）。洛克贝 -${PET_REFRESH_COST}，经验归 0，亲密度归零，道具保留。集齐场景道具后可在宠物栏手动提升亲密度。`;
    setResult(randomMsg, false);
    saveState("随机新宠物已存档");
    render();
  }

  // 游戏内「老师后台」解锁：同样走服务端核对权限码
  async function handleTeacherLogin(event) {
    event.preventDefault();
    const code = els.teacherKey.value.trim();
    if (!code) {
      setTeacherMessage("请输入权限码。", true);
      return;
    }
    if (CLOUD_ENABLED && location.protocol !== "file:") {
      try {
        const res = await rpcCall("teacher_login", { p_code: code });
        if (!res || !res.ok) {
          setTeacherMessage("权限码错误。", true);
          return;
        }
        teacherToken = res.token;
      } catch (err) {
        console.warn("老师后台解锁失败", err);
        setTeacherMessage("连不上云端，稍后再试。", true);
        return;
      }
    }
    teacherUnlocked = true;
    els.teacherKey.value = "";
    document.body.classList.add("is-teacher-mode");
    setTeacherMessage("后台权限已开启。", false);
    render();
  }

  function handleTeacherLogout() {
    teacherUnlocked = false;
    document.body.classList.remove("is-teacher-mode");
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
    const pins = [];
    setExportMessage(`正在上传 0 / ${profiles.length} …`);
    for (const profile of profiles) {
      try {
        // 【安全改造】交给服务端建号：密码由服务端随机生成并哈希，返回一次明文给老师抄
        const res = await teacherCreateStudent(profile.name, "", profile);
        if (!res || !res.ok) {
          throw new Error((res && res.code) || "create_failed");
        }
        if (res.pin) pins.push({ name: profile.name, pin: res.pin });
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
    if (pins.length) {
      // 密码只在这里出现一次，之后服务端也拿不回原文
      downloadPinList(pins, "卡罗西亚_建号密码清单");
    }
    setExportMessage(
      `完成：成功 ${ok} 人${fails.length ? `，失败 ${fails.length} 人（${fails.join("、")}）` : ""}${
        pins.length ? "，每人一个独立随机密码，清单已下载（只此一次）" : ""
      }`
    );
    if (els.pushAllToCloud) {
      els.pushAllToCloud.disabled = false;
    }
  }

  // 把"名字 + 密码"清单导成文本文件（只给老师自己保管，不上传任何地方）
  function downloadPinList(list, title) {
    const lines = list.map((x) => `${x.name}\t${x.pin}`);
    const text = `${title}\n生成时间：${new Date().toLocaleString()}\n共 ${list.length} 人\n\n姓名\t密码\n` + lines.join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `${title}_${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
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

  function lockMsgBox() {
    return document.getElementById("lockMessage");
  }

  function setLockMessage(text, isError) {
    const box = lockMsgBox();
    if (box) {
      box.textContent = text;
      box.classList.toggle("is-error", Boolean(isError));
    }
    setTeacherMessage(text, Boolean(isError));
  }

  // 【安全改造】原来的"锁班"是：把全班密码统一改成同一个口令，要还原就得先把原密码存一份在本地。
  // 这条路的代价是全班密码在老师电脑上以明文躺着一份。现在改成：锁班只是暂停登录，
  // 服务端一个开关而已，谁都不用改密码，也就不需要备份。
  async function lockAllPasswords() {
    if (!CLOUD_ENABLED || location.protocol === "file:") {
      setLockMessage("离线模式不控制登录，无需锁班", true);
      return;
    }
    if (!teacherToken) {
      setLockMessage("请先进入老师后台（需要权限码）", true);
      return;
    }
    if (!confirm("暂停全班登录？\n已经在游戏里的同学不受影响，只是新登录会被告知「等老师说开始」。")) {
      return;
    }
    try {
      setLockMessage("正在暂停登录…");
      const res = await classLock(true);
      if (!res || !res.ok) {
        setLockMessage("暂停失败，请检查网络后重试", true);
        return;
      }
      setLockMessage("✅ 已暂停全班登录。要恢复就点「恢复全班登录」。");
    } catch (err) {
      setLockMessage(`❌ 失败：${err.message || err}`, true);
    }
  }

  // 恢复登录（不再涉及任何密码还原）
  async function restoreAllPasswords() {
    if (!CLOUD_ENABLED || location.protocol === "file:") {
      setLockMessage("离线模式无需解锁", true);
      return;
    }
    if (!teacherToken) {
      setLockMessage("请先进入老师后台（需要权限码）", true);
      return;
    }
    try {
      setLockMessage("正在恢复登录…");
      const res = await classLock(false);
      if (!res || !res.ok) {
        setLockMessage("恢复失败，请检查网络后重试", true);
        return;
      }
      setLockMessage("✅ 已恢复全班登录。");
    } catch (err) {
      setLockMessage(`❌ 失败：${err.message || err}`, true);
    }
  }

  // 重置全班密码：服务端给每人随机生成 6 位码并哈希，原文只回一次，导出成清单给老师
  async function exportPassBackup() {
    if (!CLOUD_ENABLED || location.protocol === "file:") {
      setLockMessage("离线模式没有云端账号可重置", true);
      return;
    }
    if (!teacherToken) {
      setLockMessage("请先进入老师后台（需要权限码）", true);
      return;
    }
    if (
      !confirm(
        "重置全班密码？\n每个人会拿到一个新的 6 位随机密码，旧密码立即失效。\n清单只给一次，请存好。"
      )
    ) {
      return;
    }
    try {
      setLockMessage("正在重置并生成清单…");
      const res = await teacherResetPins();
      if (!res || !res.ok) {
        setLockMessage(`重置失败：${(res && res.code) || "未知原因"}`, true);
        return;
      }
      const list = Array.isArray(res.list) ? res.list : [];
      if (!list.length) {
        setLockMessage("没有可重置的账号", true);
        return;
      }
      downloadPinList(list, "卡罗西亚_全班新密码");
      setLockMessage(
        `✅ 已重置 ${list.length} 人的密码，清单已下载。旧密码全部作废，请把清单存到只有你能看到的地方。`
      );
    } catch (err) {
      setLockMessage(`❌ 失败：${err.message || err}`, true);
    }
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

  // 给所有拉入的学生每人加60洛克贝
  function handleAddAllPulledAp() {
    if (pulledProfileIds.length === 0) {
      setTeacherMessage("请先拉入学生再发奖励。", true);
      return;
    }
    let count = 0;
    pulledProfileIds.forEach((id) => {
      const profile = state.profiles.find((p) => p.id === id);
      if (profile) {
        profile.rockbell = (profile.rockbell || 0) + 60;
        count++;
      }
    });
    saveState("全员奖励发放");
    setTeacherMessage(`已给 ${count} 名学生每人发放60洛克贝！`, false);
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
      setTeacherMessage("洛克贝数量必须为正整数。", true);
      return;
    }

    if (direction > 0) {
      profile.rockbell += amount;
      setTeacherMessage(`${profile.name} 洛克贝增加 ${amount}。`, false);
    } else {
      const deducted = Math.min(profile.rockbell, amount);
      profile.rockbell -= deducted;
      setTeacherMessage(`${profile.name} 洛克贝扣除 ${deducted}。`, false);
    }
    saveState("后台已存档");
    pushTeacherProfileToCloud(profile);
    render();
  }

  // 后台改完立刻推云端（学生必须先退出登录，否则会被自己的存档覆盖）
  async function pushTeacherProfileToCloud(profile) {
    if (!profile || !CLOUD_ENABLED || location.protocol === "file:") {
      return;
    }
    try {
      if (teacherToken) {
        // 老师门票：服务端允许改任意学生的存档，但改不了密码
        const res = await teacherSetSave(profile.name, profile);
        if (!res || !res.ok) {
          throw new Error((res && res.code) || "teacher_save_failed");
        }
      } else {
        setTeacherMessage("没拿到老师门票，改动只存在本机；请重新进后台再试。", true);
        return;
      }
      setTeacherMessage(`已同步云端：${profile.name}（孩子需重新登录才生效）`, false);
    } catch (err) {
      console.warn("同步云端失败", err);
      setTeacherMessage(`云端同步失败：${profile.name}，请检查网络后重试`, true);
    }
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
    els.rockbell.textContent = String(profile.rockbell);
    renderDockProfile(profile);
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
    syncPeersWithView();
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
      meta.textContent = `${genderLabel(profile.gender)} · 洛克贝 ${profile.rockbell} · 经验 ${profile.exp}`;

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

    if (!teacherUnlocked) {
      return;
    }

    // 老师后台名单：如果拉入了学生，只显示被拉入的
    const visibleProfiles = pulledProfileIds.length > 0
      ? state.profiles.filter((p) => pulledProfileIds.includes(p.id))
      : state.profiles;

    // 下拉框保留但隐藏，作为现有操作函数（加减洛克贝等）的统一入口
    els.teacherSelect.replaceChildren();
    visibleProfiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name}（洛克贝 ${profile.rockbell}）`;
      els.teacherSelect.appendChild(option);
    });

    if (visibleProfiles.length === 0) {
      els.teacherSelect.disabled = true;
      els.apAmount.disabled = true;
      els.addAp.disabled = true;
      els.subtractAp.disabled = true;
      teacherSelectedId = null;
      renderTeacherRoster([]);
      renderTeacherDetail(null);
      return;
    }

    els.teacherSelect.disabled = false;
    els.apAmount.disabled = false;
    els.addAp.disabled = false;
    els.subtractAp.disabled = false;

    // 选中：优先上次点开的，其次当前角色，最后第一个
    const picked =
      visibleProfiles.find((profile) => profile.id === teacherSelectedId) ||
      visibleProfiles.find((profile) => profile.id === state.selectedId) ||
      visibleProfiles[0];
    teacherSelectedId = picked.id;
    els.teacherSelect.value = picked.id;

    renderTeacherRoster(visibleProfiles);
    renderTeacherDetail(picked);
    renderPulledList();
  }

  function getTeacherRosterProfiles() {
    return pulledProfileIds.length > 0
      ? state.profiles.filter((p) => pulledProfileIds.includes(p.id))
      : state.profiles;
  }

  // 后台名单：只显示名字 + 洛克贝，点一下看详情
  function renderTeacherRoster(profiles) {
    const box = document.getElementById("teacherRoster");
    if (!box) return;
    box.replaceChildren();
    const keyword = (document.getElementById("teacherRosterSearch")?.value || "").trim();

    if (!profiles.length) {
      const empty = document.createElement("p");
      empty.className = "teacher-roster-empty";
      empty.textContent = "还没有学生角色。先用下面的「拉入学生」把名字加进来。";
      box.appendChild(empty);
      return;
    }

    profiles.forEach((profile) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "teacher-roster-chip" + (profile.id === teacherSelectedId ? " active" : "");
      chip.dataset.profileId = profile.id;

      const name = document.createElement("span");
      name.className = "teacher-roster-name";
      name.textContent = profile.name;

      const bell = document.createElement("span");
      bell.className = "teacher-roster-bell";
      bell.textContent = `💰 ${profile.rockbell}`;

      chip.append(name, bell);
      if (keyword && profile.name.indexOf(keyword) < 0) chip.hidden = true;
      box.appendChild(chip);
    });
  }

  // 后台详情：孩子的基本信息 + 各类道具的加减
  function renderTeacherDetail(profile) {
    const box = document.getElementById("teacherDetail");
    if (!box) return;
    box.replaceChildren();

    if (!profile) {
      const empty = document.createElement("p");
      empty.className = "teacher-detail-empty";
      empty.textContent = "点上面的名字，查看这个孩子的存档，并增减道具";
      box.appendChild(empty);
      return;
    }

    const info = document.createElement("div");
    info.className = "teacher-detail-info";
    const rows = [
      ["名字", profile.name],
      ["密码", "由系统保管（看不到）"],
      ["洛克贝", profile.rockbell],
      ["经验", profile.exp],
      ["宠物", `${(profile.pets || []).length} / 6`],
      ["第二密码用过", (profile.secondPassUses || 0) + " 次"],
    ];
    rows.forEach(([key, value]) => {
      const cell = document.createElement("div");
      cell.className = "teacher-info-cell";
      const k = document.createElement("span");
      k.className = "teacher-info-key";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "teacher-info-value";
      v.textContent = value;
      cell.append(k, v);
      info.appendChild(cell);
    });
    box.appendChild(info);

    // 咕噜球
    box.appendChild(buildTeacherItemGroup("咕噜球", BALL_TYPES.map((ball) => ({
      id: ball.id,
      name: ball.name,
      count: Number(profile.balls?.[ball.id]) || 0,
      kind: "ball",
    }))));

    // 各场景道具
    SCENES.forEach((scene) => {
      const items = SCENE_ITEMS[scene.id] || [];
      if (!items.length) return;
      box.appendChild(buildTeacherItemGroup(scene.name, items.map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        count: Number(profile.inventory?.[item.id]) || 0,
        kind: "item",
      }))));
    });
  }

  function buildTeacherItemGroup(title, items) {
    const section = document.createElement("div");
    section.className = "teacher-item-section";

    const head = document.createElement("h4");
    head.textContent = title;
    section.appendChild(head);

    const list = document.createElement("div");
    list.className = "teacher-item-list";

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "teacher-item-row";

      const name = document.createElement("span");
      name.className = "teacher-item-name";
      if (item.icon && String(item.icon).indexOf("<svg") === 0) {
        // 图标是内置 SVG 常量，直接渲染；名字用 title 提示
        const icon = document.createElement("span");
        icon.className = "teacher-item-icon";
        icon.innerHTML = item.icon;
        name.append(icon);
      }
      const label = document.createElement("span");
      label.className = "teacher-item-label";
      label.textContent = item.name;
      name.append(label);

      const count = document.createElement("span");
      count.className = "teacher-item-count";
      count.textContent = `×${item.count}`;

      const minus = document.createElement("button");
      minus.type = "button";
      minus.className = "teacher-item-btn minus";
      minus.textContent = "−";
      minus.dataset.itemId = item.id;
      minus.dataset.kind = item.kind;
      minus.dataset.delta = "-1";
      minus.disabled = item.count <= 0;

      const plus = document.createElement("button");
      plus.type = "button";
      plus.className = "teacher-item-btn plus";
      plus.textContent = "+";
      plus.dataset.itemId = item.id;
      plus.dataset.kind = item.kind;
      plus.dataset.delta = "1";

      row.append(name, count, minus, plus);
      list.appendChild(row);
    });

    section.appendChild(list);
    return section;
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
      if (els.bondValue) els.bondValue.textContent = "--";
      if (els.bondBar) els.bondBar.style.width = "0%";
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

    // 亲密度（放在宠物属性栏）
    const bondLevel = profile.pet.bond || 0;
    if (els.bondValue) els.bondValue.textContent = `Lv.${bondLevel} / 10`;
    if (els.bondBar) els.bondBar.style.width = `${Math.min(100, (bondLevel / 10) * 100)}%`;

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
      const lvCfg = WILD_PETS[scene.id];
      const lvText =
        lvCfg && Array.isArray(lvCfg.levels) && lvCfg.levels.length
          ? `${lvCfg.levels[0][0]}-${lvCfg.levels[lvCfg.levels.length - 1][1]}`
          : null;
      meta.textContent = unlocked
        ? lvText
          ? `${scene.tag} · 野生宠物 ${lvText} 级`
          : `${scene.tag} · ${scene.drops.exp[0]}-${scene.drops.exp[1]}`
        : lockReason;

      button.append(dot, name, meta);
      cont.appendChild(button);
    });

    els.sceneGrid.appendChild(cont);

    // 玩家角色：全屏大世界里能走动的训练师
    const playerEl = document.createElement("div");
    playerEl.className = "map-player";
    playerEl.id = "mapPlayer";
    const spriteSrc = outfitSrc(profile);
    playerEl.innerHTML = `<img alt="" src="${spriteSrc}">`;
    playerEl.style.left = `${mapPlayerPos.x}%`;
    playerEl.style.top = `${mapPlayerPos.y}%`;
    cont.appendChild(playerEl);

    // 出战宠物跟在训练师右后方一起走
    const activePet = profile && Array.isArray(profile.pets) && profile.pets.length
      ? profile.pets[Math.min(Math.max(Number(profile.activePetIndex) || 0, 0), profile.pets.length - 1)]
      : null;
    if (activePet && activePet.image) {
      const petEl = document.createElement("div");
      petEl.className = "map-pet";
      petEl.id = "mapPet";
      petEl.innerHTML = `<img alt="" src="${activePet.image}">`;
      petEl.style.left = `${Math.min(97, mapPlayerPos.x + 1.9)}%`;
      petEl.style.top = `${Math.min(94, mapPlayerPos.y + 0.7)}%`;
      cont.appendChild(petEl);
    }

    syncPeerLayer();
    // 点地图空白处，角色走过去
    cont.addEventListener("click", (e) => {
      if (e.target.closest(".map-pin")) return;
      const rect = cont.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      mapPlayerPos.x = Math.max(5, Math.min(95, x));
      mapPlayerPos.y = Math.max(8, Math.min(92, y));
      positionMapPlayer();
    });

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
    trainerEl.style.left = `${scenePlayerPos.x}%`;
    trainerEl.style.top = `${scenePlayerPos.y}%`;
    const trainerImg = document.createElement("img");
    trainerImg.src = outfitSrc(profile);
    trainerImg.alt = "";
    trainerEl.appendChild(trainerImg);
    stageEl.appendChild(trainerEl);

    if (profile.pet && profile.pet.image) {
      const petEl = document.createElement("div");
      petEl.className = "stage-pet";
      petEl.style.left = `${Math.min(94, scenePlayerPos.x - 3)}%`;
      petEl.style.top = `${Math.min(92, scenePlayerPos.y + 1)}%`;
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
      card.setAttribute(
        "aria-label",
        `${spot.name}：${spot.desc}（经验 ${spot.exp[0]}-${spot.exp[1]}，免费探索）`,
      );

      // 悬停小面板：这个点会遇到几级野生宠物、遇敌概率、掉道具概率
      const wildCfg = WILD_PETS[scene.id];
      const lvRange =
        (wildCfg && Array.isArray(wildCfg.levels) && wildCfg.levels[spotIndex]) ||
        (wildCfg && wildCfg.levelRange) ||
        [1, 1];
      const dropPct = Math.round((spotIndex === 4 ? 0.7 : ITEM_DROP_CHANCE) * 100);
      const encPct = Math.round(((wildCfg && wildCfg.encounterRate) || 0) * 100);

      const spotTip = document.createElement("span");
      spotTip.className = `spot-tip${xy[1] < 34 ? " is-below" : ""}${
        xy[0] < 22 ? " is-left" : xy[0] > 78 ? " is-right" : ""
      }`;
      [
        ["🐾", `野生宠物 Lv.${lvRange[0]}-${lvRange[1]}`],
        ["⚔️", `遇敌概率 ${encPct}%`],
        ["🎁", `道具概率 ${dropPct}%`],
      ].forEach(([icon, text]) => {
        const row = document.createElement("span");
        row.className = "spot-tip-row";
        const iconEl = document.createElement("span");
        iconEl.className = "spot-tip-icon";
        iconEl.textContent = icon;
        const textEl = document.createElement("span");
        textEl.className = "spot-tip-text";
        textEl.textContent = text;
        row.append(iconEl, textEl);
        spotTip.appendChild(row);
      });

      const spotIcon = document.createElement("span");
      spotIcon.className = "stage-dot";
      spotIcon.textContent = SCENE_EMOJI[scene.id] || "🔍";

      const spotName = document.createElement("span");
      spotName.className = "stage-tag";
      spotName.textContent = spot.name;

      card.append(spotIcon, spotName);
      card.appendChild(spotTip);
      els.sceneSpotList.appendChild(card);
    });

    stageEl.appendChild(els.sceneSpotList);
    els.sceneAtmosphere.appendChild(stageEl);
    syncPeerLayer();

    // 场景道具收集情况（显示在场景下面）
    if (els.sceneInventory) {
      els.sceneInventory.replaceChildren();
      els.sceneInventory.classList.remove("open");
      const items = SCENE_ITEMS[scene.id] || [];
      const collected = items.filter((item) => (profile.inventory[item.id] || 0) >= 1).length;

      // 顶栏道具胶囊的计数（抽屉收起时唯一的入口）
      const bagBtnEl = document.getElementById("sceneBagBtn");
      if (bagBtnEl) {
        bagBtnEl.textContent = `🎒 道具 ${collected}/${items.length}`;
      }

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

  let resultClearTimer = null; // 全局提示条 2 秒后自动消失
  let lastRenderedResult = null;
  function renderResult() {
    const text = resultMessage;
    els.resultMessage.textContent = text;
    els.resultMessage.classList.toggle("warning", resultIsWarning);
    // 文案没变就不重新计时，避免走动/刷新导致提示一直挂着
    if (text === lastRenderedResult) return;
    lastRenderedResult = text;
    if (resultClearTimer) {
      clearTimeout(resultClearTimer);
      resultClearTimer = null;
    }
    if (text) {
      // 新的提示顶替旧的：先清上一个计时，再重新起 2 秒
      resultClearTimer = setTimeout(() => {
        resultMessage = "";
        resultIsWarning = false;
        lastRenderedResult = "";
        els.resultMessage.textContent = "";
        els.resultMessage.classList.remove("warning");
        resultClearTimer = null;
      }, 2000);
    }
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
      price.textContent = `${listing.price} 洛克贝`;

      card.append(icon, info, price);

      if (!isOwn) {
        const buyBtn = document.createElement("button");
        buyBtn.type = "button";
        buyBtn.className = "primary-button shop-buy-btn";
        buyBtn.dataset.action = "buy";
        buyBtn.dataset.listingId = listing.id;
        buyBtn.disabled = profile.rockbell < listing.price;
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
    hint.textContent = "自己定价：最低 2 洛克贝，最高 99999。成交后系统向卖家收 1/5 手续费（向上取整）。点道具填价格就能上架。";
    els.shopContent.appendChild(hint);

    const grid = document.createElement("div");
    grid.className = "shop-grid";
    ownedItems.forEach((item) => {
      const suggest = getItemPrice(item.id);
      const card = document.createElement("div");
      card.className = "shop-item-card sell-card";

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
      priceEl.textContent = "参考价 " + suggest + " 洛克贝";

      const listTag = document.createElement("span");
      listTag.className = "shop-list-tag";
      listTag.textContent = "点我定价";

      card.append(icon, info, priceEl, listTag);
      card.addEventListener("click", () => openSellPriceEditor(card, item, suggest));
      grid.appendChild(card);
    });
    els.shopContent.appendChild(grid);
  }

  // 点道具卡片 → 就地变成"填价格"的小表单
  function openSellPriceEditor(card, item, suggest) {
    if (card.dataset.editing === "1") return;
    card.dataset.editing = "1";
    card.classList.add("is-editing");
    card.replaceChildren();

    const form = document.createElement("div");
    form.className = "sell-price-form";

    const title = document.createElement("strong");
    title.className = "sell-price-title";
    title.textContent = item.name + " ×" + item.count;

    const tip = document.createElement("span");
    tip.className = "sell-price-tip";
    tip.textContent = "填你的价格（2 ~ 99999）";

    const row = document.createElement("div");
    row.className = "sell-price-row";

    const input = document.createElement("input");
    input.type = "number";
    input.min = "2";
    input.max = "99999";
    input.value = String(suggest);
    input.className = "sell-price-input";

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "sell-price-ok";
    ok.textContent = "上架";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sell-price-cancel";
    cancel.textContent = "算了";

    cancel.addEventListener("click", (e) => {
      e.stopPropagation();
      render();
    });

    ok.addEventListener("click", async (e) => {
      e.stopPropagation();
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 2) {
        setResult("价格最低 2 洛克贝，再改一下。", true);
        return;
      }
      ok.disabled = true;
      ok.textContent = "上架中…";
      try {
        const result = await listItem(item.id, Math.floor(value));
        setResult(result.msg, !result.ok);
      } catch (error) {
        console.error("上架失败", error);
        setResult("上架失败，请检查网络后重试。", true);
      } finally {
        ok.disabled = false;
        ok.textContent = "上架";
        render();
      }
    });

    row.append(input, ok, cancel);
    form.append(title, tip, row);
    card.appendChild(form);
    try { input.focus(); input.select(); } catch (err) {}
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
      time.textContent = `售价 ${listing.price} 洛克贝`;
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
      text.className = "pet-evolve-line";
      text.textContent = nextStage
        ? `下一阶段：${nextStage.name} · Lv.${nextEvolutionLevel} 自动进化`
        : "已达最高进化阶段";
      const buttons = [];
      if (profile.compensationEligible && !profile.compensationClaimed) {
        const compensationButton = document.createElement("button");
        compensationButton.id = "compensationButton";
        compensationButton.type = "button";
        compensationButton.className = "secondary-button compensation-button";
        compensationButton.innerHTML =
          '<span class="button-icon" aria-hidden="true">↻</span>领取补偿：随机宠物 +2洛克贝';
        buttons.push(compensationButton);
      }

      copy.prepend(title, text);
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
  function generateWildPet(sceneId, spotIndex) {
    const config = WILD_PETS[sceneId];
    if (!config) return null;
    // 判断是否遇到异色稀有宠物（低概率）
    let petId;
    let isShiny = false;
    if (config.shinyPetIds && config.shinyPetIds.length > 0 && Math.random() < (config.shinyRate || 0.01)) {
      petId = config.shinyPetIds[Math.floor(Math.random() * config.shinyPetIds.length)];
      isShiny = true;
    } else {
      // 该场景所有野生宠物等概率出现
      petId = config.petIds[Math.floor(Math.random() * config.petIds.length)];
    }
    const template = PET_DATABASE.find((p) => p.petId === petId);
    if (!template) return null;
    // 等级：按探索点的位置取对应等级段，找不到就用场景总段
    const idx = Number.isInteger(spotIndex) && spotIndex >= 0 ? spotIndex : -1;
    const range =
      (idx >= 0 && Array.isArray(config.levels) && config.levels[idx]) || config.levelRange;
    const level = randomInt(range[0], range[1]);
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
    // 越级保护：野生宠物比你高 1-2 级时，给你补一点攻防（最多补 2 级），
    // 不然等级差 1 级就是必输，新手第一战遇上 2 级怪就卡住了
    const lvGap = Math.max(0, Math.min(2, (wildPet.level || 1) - (playerPet.level || 1)));
    const playerAtk = getPetAttack(playerPet) + lvGap * 3;
    const playerDef = getPetDefense(playerPet) + lvGap * 2;
    const playerSpd = getPetSpeed(playerPet);

    log.push(`野生的 ${wildPet.name}（Lv.${wildPet.level}）出现了！`);

    let playerFirst = playerSpd >= wildPet.speed;
    // 30 回合上限：同级对打能正常分出胜负（20 回合太短，同级也会因为打不完判负）
    let round = 0;
    while (playerHp > 0 && wildHp > 0 && round < 30) {
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
      ? "打赢了！这场不给经验，可以试着抓它。"
      : "打输了，这场不给经验，可能被抢走道具。";
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

  // ===== 角色弹窗：左立绘 + 右页签（信息 / 道具 / 衣服） =====
  let roleModalTab = "info";

  function roleTitleOf(profile) {
    const inv = (profile && profile.inventory) || {};
    const owned = Object.keys(inv).filter((key) => Number(inv[key]) > 0).length;
    if (owned >= 20) return "道具收集家";
    if (owned >= 10) return "草原探索者";
    if (owned >= 3) return "初出茅庐";
    return "新手上路";
  }

  function petCountOf(profile) {
    if (!profile) return 0;
    if (Array.isArray(profile.pets) && profile.pets.length) return profile.pets.length;
    return profile.pet ? 1 : 0;
  }

  function buildRoleInfo(profile) {
    const box = document.createElement("div");
    box.className = "role-info-pane";

    const wrap = document.createElement("div");
    wrap.className = "role-info-grid";
    const powerEl = document.getElementById("powerValue");
    const rows = [
      ["姓名", profile.name || "—"],
      ["密码", "由系统保管（看不到）"],
      ["称号", roleTitleOf(profile)],
      ["等级", "Lv." + (profile.level || 1)],
      ["洛克贝", String(profile.rockbell ?? 0)],
      ["宠物数", petCountOf(profile) + " 只"],
      ["战斗力", powerEl ? powerEl.textContent : "—"],
      ["被赞", (Number(profile.likedCount) || 0) + " 次"],
    ];
    rows.forEach((row) => {
      const cell = document.createElement("div");
      cell.className = "role-info-item";
      const key = document.createElement("span");
      key.className = "role-info-key";
      key.textContent = row[0];
      const value = document.createElement("strong");
      value.className = "role-info-value";
      if (row[0] === "被赞") value.id = "roleLikedValue";
      value.textContent = row[1];
      cell.append(key, value);
      wrap.appendChild(cell);
    });
    box.appendChild(wrap);
    box.appendChild(buildRoleActions(profile));
    // 被赞次数藏在别人的存档里，打开面板时异步算一遍
    setTimeout(() => refreshMyLikedCount(profile), 0);
    return box;
  }

  // 角色页底部的两个"一次性"按钮：性别互换 + 改密码
  function buildRoleActions(profile) {
    const actions = document.createElement("div");
    actions.className = "role-actions";

    // ① 性别互换：每人一次，整张立绘跟着换
    const swapBtn = document.createElement("button");
    swapBtn.type = "button";
    swapBtn.id = "roleGenderSwapBtn";
    swapBtn.className = "role-action-btn" + (profile.genderSwapUsed ? " is-used" : "");
    swapBtn.textContent = profile.genderSwapUsed
      ? "性别已换过"
      : "换" + (profile.gender === "female" ? "男生" : "女生");
    swapBtn.disabled = Boolean(profile.genderSwapUsed);
    swapBtn.addEventListener("click", () => {
      const p = getActiveProfile();
      if (!p || p.genderSwapUsed) return;
      p.gender = p.gender === "female" ? "male" : "female";
      p.genderSwapUsed = true;
      render();
      renderRoleModal();
      scheduleCloudSync(p);
      showToast(
        "形象切换成功",
        "现在是" + genderLabel(p.gender) + "生形象，所有衣服都会跟着换。这个按钮只有一次机会哦。",
        "success"
      );
    });
    actions.appendChild(swapBtn);

    // ② 改密码：每人一次，改完立刻写回云端
    const passArea = document.createElement("div");
    passArea.className = "role-pass-area";

    const passBtn = document.createElement("button");
    passBtn.type = "button";
    passBtn.id = "rolePassBtn";
    passBtn.className = "role-action-btn" + (profile.passChangeUsed ? " is-used" : "");
    passBtn.textContent = profile.passChangeUsed ? "密码已改过" : "改密码";
    passBtn.disabled = Boolean(profile.passChangeUsed);

    const editor = document.createElement("div");
    editor.className = "role-pass-editor";
    editor.hidden = true;

    passBtn.addEventListener("click", () => {
      passBtn.hidden = true;
      editor.hidden = false;
      actions.classList.add("is-editing");
      editor.replaceChildren(
        (() => {
          const tip = document.createElement("span");
          tip.className = "role-pass-tip";
          tip.textContent = "新密码要 4~6 位数字（比如 5678）";
          const input = document.createElement("input");
          input.type = "text";
          input.inputMode = "numeric";
          input.maxLength = 6;
          input.className = "role-pass-input";
          input.placeholder = "输入新密码";
          const ok = document.createElement("button");
          ok.type = "button";
          ok.className = "role-pass-ok";
          ok.textContent = "确定";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "role-pass-cancel";
          cancel.textContent = "算了";
          cancel.addEventListener("click", () => {
            editor.hidden = true;
            passBtn.hidden = false;
            actions.classList.remove("is-editing");
          });
          ok.addEventListener("click", async () => {
            const p = getActiveProfile();
            if (!p) return;
            const value = (input.value || "").trim();
            if (!/^\d{4,6}$/.test(value)) {
              showToast("密码不对", "要填 4~6 位数字，比如 5678", "warning");
              return;
            }
            if (!studentToken) {
              showToast("先重新登录", "会话已过期，重新登录后再改密码", "warning");
              return;
            }
            ok.disabled = true;
            ok.textContent = "保存中…";
            try {
              // 【安全改造】新密码直接交给服务端写进哈希列，前端不保留原文
              const res = await rpcCall("set_pin", { p_token: studentToken, p_new: value });
              if (!res || !res.ok) {
                throw new Error((res && res.code) || "set_pin_failed");
              }
              p.passChangeUsed = true;
              saveState("密码已更新");
              showToast("密码已更新", "以后用新密码登录。这次改密码机会已经用完啦。", "success", 6000);
            } catch (err) {
              console.warn("改密码失败", err);
              showToast("改密码失败", "网络不好或会话过期，稍后再试", "warning");
            }
            render();
            renderRoleModal();
          });
          const line = document.createElement("div");
          line.className = "role-pass-line";
          line.append(input, ok, cancel);
          const wrap = document.createElement("div");
          wrap.className = "role-pass-form";
          wrap.append(tip, line);
          return wrap;
        })()
      );
    });

    passArea.append(passBtn, editor);
    actions.appendChild(passArea);
    return actions;
  }

  function buildRoleItems(profile) {
    const wrap = document.createElement("div");
    wrap.className = "role-items-wrap";
    const inv = profile.inventory || {};

    // 第一组：咕噜球（从商店买的捕捉球都放在这里）
    const ballSection = document.createElement("div");
    ballSection.className = "role-item-section";
    const ballHead = document.createElement("h4");
    const ballOwned = BALL_TYPES.filter((b) => Number(profile.balls?.[b.id]) > 0).length;
    ballHead.textContent = "咕噜球　" + ballOwned + "/" + BALL_TYPES.length;
    ballSection.appendChild(ballHead);
    const ballGrid = document.createElement("div");
    ballGrid.className = "role-item-grid";
    BALL_TYPES.forEach((ball) => {
      const count = Number(profile.balls?.[ball.id]) || 0;
      const cell = document.createElement("div");
      cell.className = "role-item-cell" + (count > 0 ? " owned" : " locked");
      const icon = document.createElement("span");
      icon.className = "role-item-icon";
      icon.textContent = count > 0 ? "⚪" : "·";
      const name = document.createElement("span");
      name.className = "role-item-name";
      name.textContent = ball.name;
      const num = document.createElement("span");
      num.className = "role-item-count";
      num.textContent = count > 0 ? "×" + count : "未获得";
      cell.append(icon, name, num);
      ballGrid.appendChild(cell);
    });
    ballSection.appendChild(ballGrid);
    wrap.appendChild(ballSection);

    SCENES.forEach((scene) => {
      const items = SCENE_ITEMS[scene.id] || [];
      if (!items.length) return;
      const owned = items.filter((item) => Number(inv[item.id]) > 0).length;
      const section = document.createElement("div");
      section.className = "role-item-section";
      const head = document.createElement("h4");
      head.textContent = scene.name + "　" + owned + "/" + items.length;
      section.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "role-item-grid";
      items.forEach((item) => {
        const count = Number(inv[item.id]) || 0;
        const cell = document.createElement("div");
        cell.className = "role-item-cell" + (count > 0 ? " owned" : " locked");
        const icon = document.createElement("span");
        icon.className = "role-item-icon";
        icon.innerHTML = count > 0 ? item.icon || "❔" : "·";
        const name = document.createElement("span");
        name.className = "role-item-name";
        name.textContent = item.name;
        const num = document.createElement("span");
        num.className = "role-item-count";
        num.textContent = count > 0 ? "×" + count : "未获得";
        cell.append(icon, name, num);
        grid.appendChild(cell);
      });
      section.appendChild(grid);
      wrap.appendChild(section);
    });
    if (!wrap.children.length) {
      const empty = document.createElement("p");
      empty.className = "role-empty";
      empty.textContent = "还没有可收集的道具。";
      wrap.appendChild(empty);
    }
    return wrap;
  }

  function buildRoleClothes() {
    const profile = getActiveProfile();
    const wrap = document.createElement("div");
    wrap.className = "role-clothes";
    if (!profile) return wrap;

    const owned = ownedOutfits(profile);
    const wearing = profile.outfit || "starter";
    const head = document.createElement("div");
    head.className = "role-clothes-head";
    head.innerHTML = `<strong>我的衣柜</strong><span>共 ${OUTFITS.length} 套 · 已拥有 ${owned.length} 套</span>`;
    wrap.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "outfit-grid";
    OUTFITS.forEach((outfit) => {
      const hasIt = owned.includes(outfit.id);
      const isOn = wearing === outfit.id;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "outfit-card" + (isOn ? " is-wearing" : "") + (hasIt ? "" : " is-locked");
      card.dataset.outfitId = outfit.id;

      const thumb = document.createElement("img");
      thumb.className = "outfit-thumb";
      thumb.src = outfitSrc(profile, outfit.id);
      thumb.alt = outfit.name;
      thumb.style.setProperty("--outfit-color", outfit.color);

      const name = document.createElement("span");
      name.className = "outfit-name";
      name.textContent = outfit.name;

      const tag = document.createElement("span");
      tag.className = "outfit-tag";
      tag.textContent = isOn ? "穿着中" : hasIt ? outfit.tag : "未拥有";

      card.append(thumb, name, tag);
      card.addEventListener("click", () => handleOutfitCardClick(outfit));
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    const note = document.createElement("p");
    note.className = "role-clothes-note";
    note.textContent = "点已拥有的衣服直接换；没有的衣服去商店的「时装」页，用 10000 洛克贝或该场景 100 个道具解锁。";
    wrap.appendChild(note);
    return wrap;
  }

  function handleOutfitCardClick(outfit) {
    const profile = getActiveProfile();
    if (!profile || !outfit) return;
    if (!ownedOutfits(profile).includes(outfit.id)) {
      const roleModal = document.getElementById("roleModal");
      const storeModal = document.getElementById("storeModal");
      if (roleModal) roleModal.hidden = true;
      renderStore("fashion");
      if (storeModal) storeModal.hidden = false;
      return;
    }
    if ((profile.outfit || "starter") === outfit.id) return;
    profile.outfit = outfit.id;
    saveState("已换装");
    renderRoleModal();
    render();
  }

  function renderRoleModal() {
    const profile = getActiveProfile();
    const area = document.getElementById("rolePanelArea");
    const img = document.getElementById("rolePortraitImg");
    const nameEl = document.getElementById("rolePortraitName");
    if (!area) return;
    if (!profile) {
      area.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "role-empty";
      empty.textContent = "还没有角色，先新建一个吧。";
      area.appendChild(empty);
      return;
    }
    if (img) {
      img.src = outfitSrc(profile);
      img.alt = profile.name || "训练师";
    }
    if (nameEl) nameEl.textContent = profile.name || "训练师";
    // 衣服页需要更多横向空间，立绘栏自动收窄
    const layout = document.querySelector("#roleModal .role-layout");
    if (layout) layout.classList.toggle("is-clothes", roleModalTab === "clothes");
    area.replaceChildren();
    if (roleModalTab === "items") {
      area.appendChild(buildRoleItems(profile));
    } else if (roleModalTab === "clothes") {
      area.appendChild(buildRoleClothes());
    } else {
      area.appendChild(buildRoleInfo(profile));
    }
  }

  // ===== 宠物弹窗页签：宠物信息 / 宠物道具 =====
  let petModalTab = "info";

  function makePetCard(title, bodyText) {
    const card = document.createElement("div");
    card.className = "pet-item-card";
    const head = document.createElement("h4");
    head.textContent = title;
    const body = document.createElement("p");
    body.textContent = bodyText;
    card.append(head, body);
    return card;
  }

  function renderPetItemsView() {
    const box = document.getElementById("petItemsView");
    if (!box) return;
    box.replaceChildren();
    const profile = getActiveProfile();
    if (!profile || !profile.pet) {
      const empty = document.createElement("p");
      empty.className = "role-empty";
      empty.textContent = "还没有宠物，先去孵一个蛋吧。";
      box.appendChild(empty);
      return;
    }
    const pet = profile.pet;
    const bondScenes = Array.isArray(pet.bondScenes) ? pet.bondScenes : [];
    const sceneNames = bondScenes.map((id) => {
      const scene = getScene(id);
      return scene ? scene.name : id;
    });
    let evoText = "已到最终形态";
    try {
      const match = findPetMatch(pet);
      const stages = (match && match.template && match.template.stages) || [];
      const index = match && typeof match.stageIndex === "number" ? match.stageIndex : 0;
      const next = stages[index + 1];
      if (next) {
        evoText = "下一阶段：" + (next.name || "进化形态") + "，到达对应等级后自动进化";
      }
    } catch (err) {
      evoText = "—";
    }
    box.append(
      makePetCard("🐾 " + (pet.name || "宠物"), "当前等级 Lv." + (pet.level || 1) + "，详细属性看「宠物信息」页"),
      makePetCard(
        "💕 亲密度提升记录（" + bondScenes.length + " 个场景）",
        sceneNames.length ? sceneNames.join("、") : "还没有在任何场景提升过亲密度"
      ),
      makePetCard("✨ 进化", evoText),
      makePetCard("🎒 宠物道具", "宠物专属道具还没上线，后续会支持进化材料与亲密道具")
    );
  }

  function setupPetTabs() {
    const body = document.getElementById("petModalBody");
    if (!body || body.dataset.tabsBound === "1") return;
    body.dataset.tabsBound = "1";
    body.querySelectorAll("[data-pet-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        petModalTab = btn.dataset.petTab || "info";
        body.querySelectorAll("[data-pet-tab]").forEach((other) => {
          other.classList.toggle("active", other === btn);
        });
        applyPetTab();
        if (petModalTab === "items") renderPetItemsView();
      });
    });
    applyPetTab();
  }

  // 页签只切换右栏内容：属性面板 / 宠物道具。中栏大图始终在
  function applyPetTab() {
    const ability = document.getElementById("petColAbility");
    const itemsView = document.getElementById("petItemsView");
    if (!ability) return;
    const mode = petModalTab === "items" ? "items" : "info";
    ability.dataset.mode = mode;
    if (itemsView) itemsView.hidden = mode !== "items";
  }

  function setupRoleModal() {
    const modal = document.getElementById("roleModal");
    if (!modal || modal.dataset.bound === "1") return;
    modal.dataset.bound = "1";
    const close = document.getElementById("roleModalClose");
    if (close) close.addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.hidden = true;
    });
    modal.querySelectorAll("[data-role-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        roleModalTab = btn.dataset.roleTab || "info";
        modal.querySelectorAll("[data-role-tab]").forEach((other) => {
          other.classList.toggle("active", other === btn);
        });
        renderRoleModal();
      });
    });
    document.getElementById("dockRole")?.addEventListener("click", () => {
      modal.hidden = false;
      renderRoleModal();
    });
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
      for (let slot = 0; slot < MAX_PETS; slot += 1) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "pet-team-item is-empty";
        emptyCard.title = `空位（宠物栏上限 ${MAX_PETS} 只）`;
        const emptyLabel = document.createElement("div");
        emptyLabel.className = "pet-team-empty-label";
        emptyLabel.textContent = "空位";
        emptyCard.appendChild(emptyLabel);
        els.petTeamList.appendChild(emptyCard);
      }
      return;
    }

    // 操作按钮统一放到「宠物属性」栏底部，只针对出战宠物
    const actionBar = document.getElementById("petActionBar");
    if (actionBar) actionBar.replaceChildren();

    profile.pets.forEach((pet, index) => {
      const card = document.createElement("div");
      card.className = `pet-team-item${index === profile.activePetIndex ? " active" : ""}`;
      card.dataset.index = index;
      card.title = index === profile.activePetIndex ? "当前出战宠物" : "点击设为出战";
      card.style.cursor = index === profile.activePetIndex ? "default" : "pointer";

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
      card.append(header);
      els.petTeamList.appendChild(card);

      // 操作按钮只给「出战宠物」，统一挂在宠物属性栏底部
      if (index !== profile.activePetIndex || !actionBar) return;

      const actions = document.createElement("div");
      actions.className = "pet-actions";

      const btnRow = document.createElement("div");
      btnRow.className = "pet-actions-row";

      if (index === 0) {
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "btn-switch pet-act-btn";
        refreshBtn.textContent = "🔄 刷新";
        refreshBtn.title = "刷新：消耗50洛克贝随机更换宠物";
        refreshBtn.dataset.action = "refresh";
        refreshBtn.dataset.index = index;
        btnRow.appendChild(refreshBtn);
      } else {
        const releaseBtn = document.createElement("button");
        releaseBtn.className = "btn-release pet-act-btn";
        releaseBtn.textContent = "🗑 放生";
        releaseBtn.title = "放生这只宠物";
        releaseBtn.dataset.action = "release";
        releaseBtn.dataset.index = index;
        btnRow.appendChild(releaseBtn);
      }

      const activeTag = document.createElement("span");
      activeTag.className = "pet-team-active-tag pet-act-tag";
      activeTag.textContent = "✓ 出战中";
      btnRow.appendChild(activeTag);

      const btnRow2 = document.createElement("div");
      btnRow2.className = "pet-actions-row";

      const bondScene = findBondScene(profile, pet);
      const bondBtn = document.createElement("button");
      bondBtn.className = "btn-bond pet-act-btn";
      bondBtn.dataset.action = "bond";
      bondBtn.dataset.index = index;
      if (bondScene) {
        bondBtn.textContent = "💕 提升亲密度";
        bondBtn.title = `提升亲密度：消耗${bondScene.name}的4个道具，提升1级`;
        bondBtn.disabled = false;
      } else {
        bondBtn.textContent = "💕 提升亲密度";
        bondBtn.title = "集齐任意场景的4个道具后可提升亲密度";
        bondBtn.disabled = true;
      }
      btnRow2.appendChild(bondBtn);

      const renameBtn = document.createElement("button");
      renameBtn.className = "btn-rename pet-act-btn";
      renameBtn.dataset.action = "rename";
      renameBtn.dataset.index = index;
      if ((pet.bond || 0) >= BOND_NAME_UNLOCK_LEVEL) {
        renameBtn.textContent = "✏️ 改昵称";
        renameBtn.title = "修改昵称";
        renameBtn.disabled = false;
      } else {
        renameBtn.textContent = `✏️ 改昵称（亲密${BOND_NAME_UNLOCK_LEVEL}）`;
        renameBtn.title = `亲密度${BOND_NAME_UNLOCK_LEVEL}解锁修改昵称`;
        renameBtn.disabled = true;
      }
      btnRow2.appendChild(renameBtn);

      actions.append(btnRow, btnRow2);
      actionBar.appendChild(actions);
    });

    // 补足 6 个槽位：没宠物的位置显示空槽，让"最多 6 只"的容量一眼可见
    const emptySlots = MAX_PETS - profile.pets.length;
    for (let slot = 0; slot < emptySlots; slot += 1) {
      const emptyCard = document.createElement("div");
      emptyCard.className = "pet-team-item is-empty";
      emptyCard.title = `空位（宠物栏上限 ${MAX_PETS} 只）`;
      const emptyLabel = document.createElement("div");
      emptyLabel.className = "pet-team-empty-label";
      emptyLabel.textContent = "空位";
      emptyCard.appendChild(emptyLabel);
      els.petTeamList.appendChild(emptyCard);
    }
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
    if (!btn) {
      // 点整张卡片 = 切换出战
      const card = event.target.closest(".pet-team-item");
      if (card) {
        const idx = parseInt(card.dataset.index);
        const p = getActiveProfile();
        if (p && idx !== p.activePetIndex) {
          p.activePetIndex = idx;
          syncActivePet(p);
          saveState("已切换出战宠物");
          render();
          flashPetCard(idx, "is-switching");
        }
      }
      return;
    }
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
      if (profile.rockbell < PET_REFRESH_COST) {
        showResult(`洛克贝不足！刷新需要 ${PET_REFRESH_COST} 洛克贝。`, true);
        return;
      }
      profile.rockbell -= PET_REFRESH_COST;
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
    captureLocked = false;
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
      // 判定中（captureLocked）也一律置灰，避免连点重复投球
      item.className = `capture-ball-item${count === 0 || captureLocked ? " disabled" : ""}`;
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
    // 判定没结束前的任何再次点击都直接忽略：一次战斗只能抓一只
    if (captureLocked) return;
    const ballId = item.dataset.ballId;
    const ball = BALL_TYPES.find(b => b.id === ballId);
    const profile = getActiveProfile();
    if (!ball || !profile || !captureTarget) return;

    // 宠物栏已满：先提示，不白扣咕噜球
    if (!profile.pets) profile.pets = [];
    if (profile.pets.length >= MAX_PETS) {
      els.captureResult.textContent = `宠物栏已满（最多${MAX_PETS}只），无法捕捉！`;
      return;
    }

    // 上锁：从此刻起所有咕噜球置灰，直到弹窗关闭才解锁
    captureLocked = true;

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
      if (profile.pets.length >= MAX_PETS) {
        els.captureResult.textContent = `宠物栏已满（最多${MAX_PETS}只），无法捕捉！`;
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
            "你有2只宠物了！战力排行榜按全部宠物战力总和排名，去看看你的排名吧！",
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
    captureLocked = false;
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

  // 加时间：扣20洛克贝，加30秒，只有未启动时才能加
  function addTimerTime() {
    if (timerStarted) {
      showToast("⏱ 计时器已启动", "请先重置后再加时间", "warning");
      return;
    }
    const profile = getActiveProfile();
    if (!profile) return;
    if (profile.rockbell < 20) {
      showToast("❌ 洛克贝不足", "加30秒需要20个洛克贝", "warning");
      return;
    }
    profile.rockbell -= 20;
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
  let rankViewType = "power";

  async function renderRankView() {
    if (!els.rankContent) return;
    const token = ++rankRenderToken;

    [
      [els.rankViewTabPower, "power"],
      [els.rankViewTabWealth, "wealth"],
      [els.rankViewTabOutfit, "outfit"],
    ].forEach(([el, k]) => {
      if (el) el.classList.toggle("active", k === rankViewType);
    });
    const meta = RANK_META[rankViewType] || RANK_META.power;
    if (els.rankTitle) els.rankTitle.textContent = meta.title;
    if (els.rankHint) els.rankHint.textContent = meta.hint;

    if (rankCache) {
      renderRankList(els.rankContent, buildRankRows(rankCache, rankViewType), rankViewType, true);
    } else {
      els.rankContent.replaceChildren();
    }

    const list = await loadRankProfiles();
    if (token !== rankRenderToken) return;
    renderRankList(els.rankContent, buildRankRows(list, rankViewType), rankViewType, true);
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
        profile.rockbell = (profile.rockbell || 0) + reward;
        rewardMsg.push(`${p.name}: +${reward}洛克贝`);
        changed.push(profile);
      }
    });

    // 写回云端
    if (CLOUD_ENABLED) {
      for (const profile of changed) {
        try {
          if (teacherToken) {
            const res = await teacherSetSave(profile.name, profile);
            if (!res || !res.ok) {
              throw new Error((res && res.code) || "teacher_save_failed");
            }
          } else {
            throw new Error("no_teacher_session");
          }
        } catch (error) {
          console.warn(`发奖写回云端失败：${profile.name}`, error);
        }
      }
    }

    // 老师端本地列表也同步一份，界面显示一致
    changed.forEach((profile) => {
      const local = state.profiles.find(pr => pr.name === profile.name);
      if (local) {
        local.rockbell = profile.rockbell;
      }
    });

    saveState("排行榜奖励已发布");
    if (els.rankRewardResult) {
      els.rankRewardResult.textContent = `✅ 已发布奖励！共${profiles.length}人获得奖励（已写入云端）。`;
    }
    render();
  }

  // ============================================
  // 新手引导系统（手指引导 + 功能卡）
  // ============================================
  const GUIDE_STEPS_V2 = Object.freeze([
    { key: "pet", target: "#dockPet", mode: "click", title: "先领一只宠物", desc: "点下面的「宠物」按钮，把宠物栏打开。" },
    { key: "hatch", target: "#hatchButton", mode: "click", title: "免费孵化第一只", desc: "点「孵化」。这一步免费，点完你就有一只自己的宠物了。" },
    { key: "bell", target: "#dockBar", mode: "next", close: ["petModal"], title: "洛克贝就是钱", desc: "打一场战斗得 1 个洛克贝。攒够 10 个，就能买一颗咕噜球去抓野生宠物。" },
    { key: "grass", target: '.map-pin[data-scene-id="grassland"]', mode: "click", close: ["petModal", "storeModal", "roleModal", "rankModal"], title: "从这里开始", desc: "点「轻风草原」。这是新手村，经验最适合你现在的等级。" },
    { key: "spot", target: ".stage-spot", mode: "click", title: "点一下试试", desc: "点随便一个探索点。会给经验、可能掉道具，也可能遇到野生宠物打一场。" },
    { key: "reward", target: null, mode: "next", title: "经验和洛克贝到手", desc: "看到下面那行字没有？经验涨了。打过战斗的探索还会多 1 个洛克贝，打输了也有。" },
    { key: "store", target: "#dockTimer", mode: "click", close: ["petModal", "roleModal", "rankModal", "marketModal"], title: "攒够了就买球", desc: "点下面的「商店」。最便宜的球 5 个洛克贝，最贵的 120 个，越贵越容易抓到。有球才能在大世界抓宠物。" },
    { key: "fashion", target: "#storeTabFashion", mode: "click", title: "商店里还有衣服", desc: "再点右边的「时装」。这里有 10 套衣服，一个场景一套，男女各一个版本。" },
    { key: "role", target: "#dockRole", mode: "click", close: ["storeModal", "petModal", "rankModal"], title: "看看你自己的资料", desc: "点最左边这个「角色」，能看你的名字、等级、洛克贝和现在的样子。" },
    { key: "swap", target: "#roleGenderSwapBtn", mode: "click", fake: true, title: "这里能换一次性别", desc: "点一下这个按钮。换完以后整个形象都会变，男生的衣服变女生的，女生的变男生的。每人只能换一次。" },
    { key: "pass", target: "#rolePassBtn", mode: "click", fake: true, title: "密码也能自己改一次", desc: "点一下这里，就能把密码改成你自己记得住的 4 位数字。也只能改一次，要想清楚。" },
    { key: "clothes", target: '[data-role-tab="clothes"]', mode: "click", title: "再看看衣柜", desc: "点「衣服」，这里放着你所有的形象。" },
    { key: "wear", target: ".outfit-card", mode: "click", title: "点一张就穿上了", desc: "点一张卡片，就换成那一套衣服。灰掉的是还没解锁的，要去商店用洛克贝或者道具换。" },
  ]);

  const GUIDE_CARDS_V2 = Object.freeze([
    { icon: "🧭", title: "探索不要钱", sub: "想点几次点几次。集齐一个场景的 4 件道具，亲密度升一级。" },
    { icon: "⚔️", title: "每场战斗 +1 洛克贝", sub: "不分场景、不分输赢。输了也有，不用怕打不过。" },
    { icon: "🪢", title: "战斗胜利后可能能抓宠物", sub: "弹出捕捉窗口就扔咕噜球，球越好成功率越高。" },
    { icon: "🏪", title: "商店：六种球，5 到 120 洛克贝", sub: "越贵越稳：普通球 5 洛克贝抓 5%，国王球 120 洛克贝抓 50%。" },
    { icon: "🛒", title: "市场：和同学互相买卖", sub: "挂 10 洛克贝，成交后卖家承担 1/5 手续费，实收 8。" },
    { icon: "👕", title: "衣服：一个场景一套", sub: "10 套形象，男女各一版。10000 洛克贝，或者那个场景的道具攒够 100 个，就能换。" },
    { icon: "🔄", title: "换性别：每人一次", sub: "在「角色」页点那个按钮，整套形象直接变。换过就不能再换了。" },
    { icon: "🔑", title: "改密码：每人一次", sub: "密码记不住就改成 4 位数字，只能改一次。老师那边能看到你设成什么。" },
  ]);

  let guideV2StepIndex = 0;
  let guideV2CardIndex = 0;
  let guideV2WaitTimer = null;
  let guideV2DocHandler = null;
  let guideV2ReviewMode = false;
  let guideV2BootTimer = null;

  function guideOverlayEl() { return document.getElementById("guideOverlay"); }
  function guideTipEl() { return document.getElementById("guideTip"); }
  function guideRingEl() { return document.getElementById("guideRing"); }
  function guideCardsEl() { return document.getElementById("guideCards"); }

  function clearGuideBlocks() {
    ["top", "bottom", "left", "right"].forEach((k) => {
      const b = document.querySelector(`.guide-block[data-gb="${k}"]`);
      if (b) { b.style.cssText = ""; b.hidden = true; }
    });
  }

  function hideGuideAll() {
    const ov = guideOverlayEl();
    if (ov) ov.hidden = true;
    clearGuideBlocks();
    const ring = guideRingEl();
    if (ring) { ring.hidden = true; ring.style.cssText = ""; }
    const tip = guideTipEl();
    if (tip) tip.hidden = true;
    const cards = guideCardsEl();
    if (cards) cards.hidden = true;
    if (guideV2WaitTimer) { clearTimeout(guideV2WaitTimer); guideV2WaitTimer = null; }
    if (guideV2DocHandler) { document.removeEventListener("click", guideV2DocHandler, true); guideV2DocHandler = null; }
  }

  function openGuideV2(stage, stepIndex, review) {
    hideGuideAll();
    guideV2ReviewMode = Boolean(review);
    guideV2StepIndex = Math.max(0, Math.min(stepIndex || 0, GUIDE_STEPS_V2.length - 1));
    const profile = getActiveProfile();
    if (profile && !review) {
      profile.guideStage = stage;
      profile.guideStepIndex = guideV2StepIndex;
      profile.guideCompleted = false;
    }
    const ov = guideOverlayEl();
    if (ov) ov.hidden = false;
    if (stage === 2) {
      renderGuideCards();
    } else {
      waitGuideTarget();
    }
  }

  function waitGuideTarget() {
    const step = GUIDE_STEPS_V2[guideV2StepIndex];
    if (!step) { enterGuideCards(); return; }
    // 已经有宠物了：跳过"领宠物 / 孵化"这两步（老账号重看时按钮已经不在了）
    const profile = getActiveProfile();
    if (profile && profile.pet && (step.key === "pet" || step.key === "hatch")) {
      advanceGuideV2();
      return;
    }
    if (!step.target) { showGuideStepV2(null); return; }
    let tries = 0;
    const attempt = () => {
      const el = document.querySelector(step.target);
      if (el) { showGuideStepV2(el); return; }
      tries += 1;
      if (tries >= 12) { showGuideStepV2(null); return; }
      guideV2WaitTimer = setTimeout(attempt, 120);
    };
    attempt();
  }

  function showGuideStepV2(targetEl) {
    const step = GUIDE_STEPS_V2[guideV2StepIndex];
    // 每次显示前先把会挡住目标的弹窗收起来
    if (step.close && step.close.length) guideCloseModals(step.close);
    const tip = guideTipEl();
    const ring = guideRingEl();
    const cards = guideCardsEl();
    if (cards) cards.hidden = true;
    if (tip) tip.hidden = false;

    const stepLabel = document.getElementById("guideStep");
    if (stepLabel) stepLabel.textContent = `${guideV2StepIndex + 1} / ${GUIDE_STEPS_V2.length}`;
    const titleEl = document.getElementById("guideTitle");
    const descEl = document.getElementById("guideDesc");
    if (titleEl) titleEl.textContent = step.title;
    if (descEl) descEl.textContent = step.desc;

    const nextBtn = els.guideNext;
    if (nextBtn) {
      // 找不到目标时（比如老账号孵化按钮已经没了）也给出"知道了"，避免卡死
      nextBtn.hidden = step.mode === "click" && Boolean(targetEl);
      nextBtn.textContent = "知道了";
    }

    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const pad = 6;
      const r = {
        top: Math.max(0, rect.top - pad),
        left: Math.max(0, rect.left - pad),
        right: Math.min(window.innerWidth, rect.right + pad),
        bottom: Math.min(window.innerHeight, rect.bottom + pad),
      };
      layoutGuideBlocks(r);
      if (ring) {
        ring.hidden = false;
        ring.style.top = r.top + "px";
        ring.style.left = r.left + "px";
        ring.style.width = Math.max(0, r.right - r.left) + "px";
        ring.style.height = Math.max(0, r.bottom - r.top) + "px";
      }
      positionGuideTip(r);
    } else {
      clearGuideBlocks();
      const b = document.querySelector('.guide-block[data-gb="top"]');
      if (b) {
        b.hidden = false;
        b.style.top = "0";
        b.style.left = "0";
        b.style.right = "0";
        b.style.bottom = "0";
        b.style.width = "auto";
        b.style.height = "100%";
      }
      if (ring) ring.hidden = true;
      if (tip) {
        tip.style.left = "50%";
        tip.style.top = "50%";
        tip.style.transform = "translate(-50%,-50%)";
      }
      if (nextBtn) nextBtn.hidden = false;
    }

    if (step.mode === "click" && targetEl) {
      if (guideV2DocHandler) document.removeEventListener("click", guideV2DocHandler, true);
      guideV2DocHandler = function (e) {
        if (targetEl.contains(e.target)) {
          // 演练步骤：拦住真动作，别让孩子在引导里把"一次性机会"用掉
          if (step.fake) {
            e.preventDefault();
            e.stopPropagation();
            showToast("这是演练", "刚才只是让你看看位置，真的要用的时候再点它就行。", "info", 3000);
          }
          document.removeEventListener("click", guideV2DocHandler, true);
          guideV2DocHandler = null;
          setTimeout(() => advanceGuideV2(), step.fake ? 320 : 260);
        }
      };
      document.addEventListener("click", guideV2DocHandler, true);
    }
  }

  function layoutGuideBlocks(r) {
    const set = (key, style) => {
      const b = document.querySelector(`.guide-block[data-gb="${key}"]`);
      if (!b) return;
      b.hidden = false;
      b.style.top = (style.top || 0) + "px";
      b.style.left = (style.left || 0) + "px";
      b.style.right = style.right === undefined ? "auto" : style.right + "px";
      b.style.bottom = style.bottom === undefined ? "auto" : style.bottom + "px";
      b.style.width = style.width === undefined ? "auto" : style.width + "px";
      b.style.height = style.height === undefined ? "auto" : style.height + "px";
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    set("top", { top: 0, left: 0, right: 0, height: r.top });
    set("bottom", { top: r.bottom, left: 0, right: 0, height: Math.max(0, vh - r.bottom) });
    set("left", { top: r.top, left: 0, width: r.left, height: Math.max(0, r.bottom - r.top) });
    set("right", { top: r.top, left: r.right, width: Math.max(0, vw - r.right), height: Math.max(0, r.bottom - r.top) });
  }

  function positionGuideTip(r) {
    const tip = guideTipEl();
    if (!tip) return;
    tip.style.transform = "none";
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tipW = Math.min(296, vw - 32);
    let left = r.left + (r.right - r.left) / 2 - tipW / 2;
    left = Math.max(12, Math.min(left, vw - tipW - 12));
    tip.style.left = left + "px";
    tip.style.width = tipW + "px";
    tip.style.top = "0px";
    const h = tip.offsetHeight || 180;
    let top;
    if (r.top - h - 20 >= 8) {
      top = r.top - h - 20;
    } else {
      top = Math.min(vh - h - 12, r.bottom + 16);
    }
    tip.style.top = Math.max(8, top) + "px";
  }

  // 引导换步骤时，把挡住目标的弹窗收起来，避免"高亮了却点不到"
  function guideCloseModals(ids) {
    (ids || []).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.hidden = true;
      el.classList.remove("is-open");
    });
  }

  function advanceGuideV2() {
    if (guideV2StepIndex < GUIDE_STEPS_V2.length - 1) {
      guideV2StepIndex += 1;
      const nextStep = GUIDE_STEPS_V2[guideV2StepIndex];
      // 下一步要露出底栏/地图，先把宠物、商店、角色这些弹窗收起来
      if (nextStep && (nextStep.key === "bell" || nextStep.key === "grass" || nextStep.key === "store")) {
        guideCloseModals(["petModal"]);
      }
      if (nextStep && nextStep.key === "grass") {
        guideCloseModals(["storeModal", "roleModal", "rankModal", "petModal"]);
      }
      // 第 9 步要到底栏点「角色」，先把商店关掉，否则底栏被弹窗盖住点不到
      if (nextStep && nextStep.key === "role") {
        guideCloseModals(["storeModal"]);
      }
      if (nextStep && nextStep.key === "store") {
        guideCloseModals(["roleModal", "rankModal", "marketModal", "petModal"]);
      }
      const profile = getActiveProfile();
      if (profile && !guideV2ReviewMode) {
        profile.guideStepIndex = guideV2StepIndex;
        profile.guideStage = 1;
        saveState("引导进度已保存");
      }
      waitGuideTarget();
    } else {
      enterGuideCards();
    }
  }

  function enterGuideCards() {
    const profile = getActiveProfile();
    if (profile && !guideV2ReviewMode) {
      profile.guideStage = 2;
      profile.guideStepIndex = GUIDE_STEPS_V2.length - 1;
      saveState("引导进入功能卡");
    }
    guideV2CardIndex = 0;
    renderGuideCards();
  }

  function renderGuideCards() {
    hideGuideAll();
    const ov = guideOverlayEl();
    if (ov) ov.hidden = false;
    // 功能卡阶段：铺满一层压暗，避免后面的弹窗透出来抢注意力
    const block = document.querySelector('.guide-block[data-gb="top"]');
    if (block) {
      block.hidden = false;
      block.style.cssText = "top:0;left:0;right:0;bottom:0;width:auto;height:auto;";
    }
    const cards = guideCardsEl();
    if (cards) cards.hidden = false;
    const list = document.getElementById("guideCardList");
    if (!list) return;
    list.replaceChildren();
    GUIDE_CARDS_V2.forEach((c) => {
      const div = document.createElement("div");
      div.className = "guide-card";
      div.innerHTML = `<div class="guide-card-icon">${c.icon}</div><div><div class="guide-card-title">${c.title}</div><div class="guide-card-sub">${c.sub}</div></div>`;
      list.appendChild(div);
    });
    updateGuideCardView();
  }

  function updateGuideCardView() {
    const items = document.querySelectorAll("#guideCardList .guide-card");
    items.forEach((el, i) => { el.style.display = i === guideV2CardIndex ? "" : "none"; });
    const idx = document.getElementById("guideCardIndex");
    if (idx) idx.textContent = `${guideV2CardIndex + 1} / ${GUIDE_CARDS_V2.length}`;
    const prev = document.getElementById("guideCardPrev");
    if (prev) prev.disabled = guideV2CardIndex === 0;
    const next = document.getElementById("guideCardNext");
    if (next) next.textContent = guideV2CardIndex === GUIDE_CARDS_V2.length - 1 ? "开始冒险" : "下一张";
  }

  function changeGuideCard(delta) {
    const target = guideV2CardIndex + delta;
    if (target < 0) return;
    if (target >= GUIDE_CARDS_V2.length) { finishGuideV2(); return; }
    guideV2CardIndex = target;
    updateGuideCardView();
  }

  function handleGuideNextClick() {
    const step = GUIDE_STEPS_V2[guideV2StepIndex];
    const btn = els.guideNext;
    // 按钮没显示（正常的"点击类"步骤）就别动；显示了就一律可以推进
    if (btn && btn.hidden) return;
    if (!btn && step && step.mode === "click") return;
    advanceGuideV2();
  }

  function finishGuideV2() {
    hideGuideAll();
    // 引导收尾，把所有弹窗关掉，让孩子回到大世界
    guideCloseModals(["roleModal", "petModal", "storeModal", "rankModal", "marketModal"]);
    const profile = getActiveProfile();
    if (profile) {
      profile.guideStage = 3;
      profile.guideCompleted = true;
      saveState("引导已完成");
    }
    const helpBtn = document.getElementById("guideHelpBtn");
    if (helpBtn) helpBtn.hidden = false;
    if (typeof showToast === "function") {
      showToast("🎉 新手引导完成", "以后忘了怎么玩，点右下角「?」重看一遍", "success");
    }
  }

  function skipGuideV2() {
    finishGuideV2();
  }

  function handleResetGuide() {
    const profile = getActiveProfile();
    if (!profile) return;
    profile.guideCompleted = false;
    profile.guideStage = 0;
    profile.guideStepIndex = 0;
    saveState("引导已重置");
    if (els.teacherMessage) els.teacherMessage.textContent = "已重置该学生的引导状态";
    openGuideV2(1, 0, false);
  }

  // ============================================
  // 咕噜球商店
  // ============================================
  function renderBallShop(profile, container) {
    const box = container || els.shopContent;
    if (!box) return;
    box.replaceChildren();

    const header = document.createElement("div");
    header.className = "shop-header";
    header.innerHTML = `<h3>咕噜球</h3><p>用洛克贝购买咕噜球，用于捕捉野生宠物</p><p>当前洛克贝: <strong>${profile.rockbell}</strong></p>`;
    box.appendChild(header);

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
      buyBtn.textContent = `购买 (${ball.price}洛克贝)`;
      buyBtn.dataset.ballId = ball.id;
      buyBtn.disabled = profile.rockbell < ball.price;

      card.append(icon, name, desc, owned, buyBtn);
      grid.appendChild(card);
    });

    box.appendChild(grid);
  }

  // ============================================
  // 商店弹窗：咕噜球 / 时装
  // ============================================
  function renderStore(tab) {
    currentStoreTab = tab === "fashion" ? "fashion" : "balls";
    const tabBalls = document.getElementById("storeTabBalls");
    const tabFashion = document.getElementById("storeTabFashion");
    if (tabBalls) tabBalls.classList.toggle("active", currentStoreTab === "balls");
    if (tabFashion) tabFashion.classList.toggle("active", currentStoreTab === "fashion");

    const body = document.getElementById("storeModalBody");
    if (!body) return;
    body.replaceChildren();
    const profile = getActiveProfile();
    if (!profile) return;
    if (currentStoreTab === "fashion") {
      renderFashionStore(profile, body);
    } else {
      renderBallShop(profile, body);
    }
  }

  // 时装商店：每个场景一套形象，两种解锁方式
  function renderFashionStore(profile, container) {
    if (!container) return;
    const owned = ownedOutfits(profile);
    const header = document.createElement("div");
    header.className = "shop-header";
    header.innerHTML = `<h3>时装</h3><p>每个场景一套形象，男女各一版。两选一解锁：${OUTFIT_PRICE} 洛克贝，或该场景道具攒够 ${OUTFIT_ITEM_NEED} 个。</p><p>当前洛克贝: <strong>${profile.rockbell}</strong></p>`;
    container.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "fashion-shop-grid";
    OUTFITS.forEach((outfit) => {
      const hasIt = owned.includes(outfit.id);
      const card = document.createElement("div");
      card.className = "fashion-shop-card" + (hasIt ? " is-owned" : "");
      card.style.setProperty("--outfit-color", outfit.color);

      const icon = document.createElement("div");
      icon.className = "fashion-shop-icon";
      const img = document.createElement("img");
      img.src = outfitSrc(profile, outfit.id);
      img.alt = outfit.name;
      icon.appendChild(img);

      const label = document.createElement("div");
      label.className = "fashion-shop-name";
      label.textContent = outfit.name;

      const tag = document.createElement("div");
      tag.className = "fashion-shop-tag";
      tag.textContent = outfit.tag;

      card.append(icon, label, tag);

      const intro = document.createElement("p");
      intro.className = "fashion-shop-intro";
      intro.textContent = outfit.intro;
      card.appendChild(intro);

      if (!hasIt) {
        const btns = document.createElement("div");
        btns.className = "fashion-shop-btns";

        const bellBtn = document.createElement("button");
        bellBtn.type = "button";
        bellBtn.className = "fashion-buy-bell";
        bellBtn.textContent = `${OUTFIT_PRICE} 洛克贝`;
        bellBtn.disabled = Number(profile.rockbell) < OUTFIT_PRICE;
        bellBtn.addEventListener("click", () => unlockOutfitByRockbell(outfit));

        const itemBtn = document.createElement("button");
        itemBtn.type = "button";
        itemBtn.className = "fashion-buy-item";
        const have = outfit.sceneId ? sceneItemTotal(profile, outfit.sceneId) : 0;
        itemBtn.textContent = outfit.sceneId
          ? `道具 ${Math.min(have, OUTFIT_ITEM_NEED)}/${OUTFIT_ITEM_NEED}`
          : `道具 0/${OUTFIT_ITEM_NEED}`;
        itemBtn.disabled = !outfit.sceneId || have < OUTFIT_ITEM_NEED;
        itemBtn.addEventListener("click", () => unlockOutfitByItems(outfit));

        btns.append(bellBtn, itemBtn);
        card.appendChild(btns);
      } else {
        const wearing = (profile.outfit || "starter") === outfit.id;
        const wearBtn = document.createElement("button");
        wearBtn.type = "button";
        wearBtn.className = "fashion-wear-btn" + (wearing ? " is-on" : "");
        wearBtn.textContent = wearing ? "正在穿着" : "穿上";
        wearBtn.disabled = wearing;
        wearBtn.addEventListener("click", () => wearOutfitFromStore(outfit.id));
        card.appendChild(wearBtn);
      }

      grid.appendChild(card);
    });
    container.appendChild(grid);
  }

  function unlockOutfit(outfit) {
    const profile = getActiveProfile();
    if (!profile || !outfit) return;
    const owned = ownedOutfits(profile);
    if (owned.includes(outfit.id)) return;
    profile.outfits = [...owned, outfit.id];
    profile.outfit = outfit.id;
    saveState("已解锁并换上");
    renderStore("fashion");
    render();
    const body = document.getElementById("storeModalBody");
    if (body) {
      const tip = document.createElement("p");
      tip.className = "shop-note";
      tip.textContent = `已解锁「${outfit.name}」并直接穿上。`;
      body.insertBefore(tip, body.firstChild ? body.firstChild.nextSibling : null);
    }
  }

  function unlockOutfitByRockbell(outfit) {
    const profile = getActiveProfile();
    if (!profile || !outfit) return;
    if (Number(profile.rockbell) < OUTFIT_PRICE) {
      alert(`洛克贝不够，还差 ${OUTFIT_PRICE - Number(profile.rockbell)} 个。`);
      return;
    }
    profile.rockbell -= OUTFIT_PRICE;
    unlockOutfit(outfit);
  }

  function unlockOutfitByItems(outfit) {
    const profile = getActiveProfile();
    if (!profile || !outfit || !outfit.sceneId) return;
    const have = sceneItemTotal(profile, outfit.sceneId);
    if (have < OUTFIT_ITEM_NEED) {
      alert(`「${outfit.sceneName}」的道具还差 ${OUTFIT_ITEM_NEED - have} 个。`);
      return;
    }
    consumeSceneItems(profile, outfit.sceneId, OUTFIT_ITEM_NEED);
    unlockOutfit(outfit);
  }

  function wearOutfitFromStore(outfitId) {
    const profile = getActiveProfile();
    if (!profile) return;
    if (!ownedOutfits(profile).includes(outfitId)) return;
    profile.outfit = outfitId;
    saveState("已换装");
    renderStore("fashion");
    render();
  }

  function buyBall(ballId) {
    const profile = getActiveProfile();
    const ball = BALL_TYPES.find(b => b.id === ballId);
    if (!profile || !ball) return;
    if (profile.rockbell < ball.price) {
      showResult("洛克贝不足！", true);
      return;
    }
    profile.rockbell -= ball.price;
    if (!profile.balls) profile.balls = {};
    profile.balls[ballId] = (profile.balls[ballId] || 0) + 1;
    saveState("购买成功");
    renderStore("balls");
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

  // 重写renderShop：市场只保留 逛市场 / 我要卖 / 我的上架 三页签，咕噜球已迁到独立商店
  const _originalRenderShop = renderShop;
  renderShop = async function(tab) {
    const nextTab = tab === "balls" ? "market" : tab;
    currentShopTab = nextTab;
    if (els.shopTabMarket) els.shopTabMarket.classList.toggle("active", nextTab === "market");
    if (els.shopTabSell) els.shopTabSell.classList.toggle("active", nextTab === "sell");
    if (els.shopTabMine) els.shopTabMine.classList.toggle("active", nextTab === "mine");

    const profile = getActiveProfile();
    if (!profile) return;

    await _originalRenderShop(nextTab);
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
      // 检查是否需要启动新手引导（新版：手指引导 + 功能卡）
      const guideOverlay = document.getElementById("guideOverlay");
      const helpBtn = document.getElementById("guideHelpBtn");
      if (helpBtn) helpBtn.hidden = !profile.guideCompleted;
      if (!profile.guideCompleted && guideOverlay && guideOverlay.hidden && !guideV2BootTimer) {
        // 延迟显示，让页面先渲染
        guideV2BootTimer = setTimeout(() => {
          guideV2BootTimer = null;
          const p = getActiveProfile();
          if (!p || p.guideCompleted) return;
          const ov = document.getElementById("guideOverlay");
          if (ov && !ov.hidden) return;
          const stage = p.guideStage || 0;
          if (stage === 2) {
            renderGuideCards();
            const ov2 = document.getElementById("guideOverlay");
            if (ov2) ov2.hidden = false;
          } else {
            openGuideV2(1, p.guideStepIndex || 0, false);
          }
        }, 600);
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
  function showToast(title, message, type = "info", duration = 2000) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    // 同一时间只留一条：新提示直接把旧的顶掉，不再叠成一排气泡
    Array.from(container.children).forEach((node) => {
      if (node.classList && node.classList.contains("toast")) node.remove();
    });

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

    const bar = toast.querySelector(".toast-progress");
    if (bar) bar.style.animationDuration = duration + "ms";

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

    // 3. 遇敌相关（战斗开始、没有咕噜球）不再弹右上角提示：
    //    战斗弹窗本身有标题和结算行，捕捉窗里也有"你没有咕噜球！可以临时购买"的说明和按钮，
    //    右上角再弹一遍属于重复，已去掉。
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
      // 判定中（captureLocked）也一律置灰，避免连点重复投球
      item.className = `capture-ball-item${count === 0 || captureLocked ? " disabled" : ""}`;
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
      hint.textContent = "你没有咕噜球！可以临时购买（比商店贵5洛克贝）";

      const tempBtn = document.createElement("button");
      tempBtn.className = "temp-buy-ball";
      tempBtn.textContent = `临时购买普通咕噜球（${BALL_TYPES[0].price + 5}洛克贝）`;
      tempBtn.disabled = profile.rockbell < BALL_TYPES[0].price + 5;
      tempBtn.addEventListener("click", () => {
        if (profile.rockbell < BALL_TYPES[0].price + 5) return;
        profile.rockbell -= (BALL_TYPES[0].price + 5);
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

