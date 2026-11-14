(function (global) {
  "use strict";

  // 每只宠物的阶段图片放在：
  // assets/pets/all/{pet-folder}/stage-1.png
  // assets/pets/all/{pet-folder}/stage-2.png
  // assets/pets/all/{pet-folder}/stage-3.png
  // 新增宠物使用SVG占位图，后续可替换为PNG
  function createStage(petId, stage, name, type, style, mark, needLevel, desc) {
    const petFolder = petId;
    return Object.freeze({
      stage,
      name,
      image: `./assets/pets/all/${petFolder}/stage-${stage}.png`,
      desc,
      type,
      style,
      mark,
      needLevel,
    });
  }

  function createPet(petId, type, style, mark, stageDefinitions) {
    const stages = stageDefinitions.map((definition, index) =>
      createStage(
        petId,
        index + 1,
        definition.name,
        type,
        style,
        mark,
        definition.needLevel,
        definition.desc,
      ),
    );
    const firstStage = stages[0];

    return Object.freeze({
      petId,
      name: firstStage.name,
      image: firstStage.image,
      desc: firstStage.desc,
      type,
      style,
      mark,
      stages: Object.freeze(stages),
    });
  }

  const petDatabase = Object.freeze([
    // ===== 原有30只宠物（取消男女设定） =====
    createPet("dimo", "光系", "帅气系", "迪", [
      { name: "迪莫", needLevel: 1, desc: "经典光系伙伴，勇敢而富有亲和力。" },
    ]),
    createPet("fire-god", "火系", "威风系", "火", [
      { name: "火花", needLevel: 1, desc: "火系幼年形态，热情而充满活力。" },
      { name: "火神", needLevel: 36, desc: "火系进化形态，气势明快。" },
      { name: "烈火战神", needLevel: 54, desc: "火系高阶形态，拥有强烈的战斗气场。" },
    ]),
    createPet("sonic-dog", "普通系", "酷系", "音", [
      { name: "护主犬", needLevel: 1, desc: "忠诚的伙伴，擅长守护同伴。" },
      { name: "音速犬", needLevel: 36, desc: "进化形态，行动迅捷。" },
    ]),
    createPet("demon-wolf", "恶系", "酷系", "恶", [
      { name: "恶魔狼", needLevel: 1, desc: "外表冷峻的恶系伙伴。" },
    ]),
    createPet("luoyin", "地系", "威风系", "罗", [
      { name: "阿米亚特", needLevel: 1, desc: "地系幼年伙伴，沉稳厚重。" },
      { name: "阿米樱", needLevel: 36, desc: "地系成长形态，力量感更强。" },
      { name: "罗隐", needLevel: 54, desc: "地系高阶形态，像可靠的小山一样稳重。" },
    ]),
    createPet("sleepy-king", "普通系", "威风系", "瞌", [
      { name: "白发懒人", needLevel: 1, desc: "普通系幼年伙伴，憨厚慵懒。" },
      { name: "动力猿", needLevel: 36, desc: "普通系成长形态，行动力更强。" },
      { name: "瞌睡王", needLevel: 54, desc: "普通系高阶形态，关键时刻很可靠。" },
    ]),
    createPet("platinum-unicorn", "光系", "帅气系", "白", [
      { name: "小独角兽", needLevel: 1, desc: "光系幼年伙伴，纯净而优雅。" },
      { name: "白金独角兽", needLevel: 36, desc: "光系进化形态，银白而明亮。" },
    ]),
    createPet("royal-griffin", "翼系", "威风系", "皇", [
      { name: "小狮鹫", needLevel: 1, desc: "翼系幼年伙伴，拥有王者血统。" },
      { name: "神圣狮鹫", needLevel: 36, desc: "翼系成长形态，气质神圣威严。" },
      { name: "皇家狮鹫", needLevel: 54, desc: "翼系高阶形态，拥有王者般的翅膀与气场。" },
    ]),
    createPet("kula", "电系", "酷系", "酷", [
      { name: "拉特", needLevel: 1, desc: "电系幼年伙伴，活泼敏捷。" },
      { name: "酷拉", needLevel: 36, desc: "电系进化形态，带着明快的雷电气息。" },
    ]),
    createPet("wing-dragon", "龙系", "帅气系", "翼", [
      { name: "小翼龙", needLevel: 1, desc: "龙系幼年伙伴，拥有飞行天赋。" },
      { name: "翼龙", needLevel: 36, desc: "龙系进化形态，飞行感强烈。" },
    ]),
    createPet("bone-dragon", "幽系", "酷系", "骨", [
      { name: "大头骨龙", needLevel: 1, desc: "幽系幼年伙伴，神秘而沉稳。" },
      { name: "寂灭骨龙", needLevel: 36, desc: "幽系进化形态，拥有强烈的骨龙气质。" },
    ]),
    createPet("holy-wing-king", "翼系", "威风系", "圣", [
      { name: "灵羽勇士", needLevel: 1, desc: "翼系成长伙伴，带有守护者气场。" },
      { name: "圣羽翼王", needLevel: 36, desc: "翼系进化形态，圣洁而威严。" },
    ]),
    createPet("fire-guardian", "火系", "威风系", "烈", [
      { name: "火尾瓦特", needLevel: 1, desc: "火系幼年伙伴，尾焰明亮。" },
      { name: "火尾战士", needLevel: 36, desc: "火系成长形态，沉着刚劲。" },
      { name: "烈火守护", needLevel: 54, desc: "火系高阶形态，像燃烧的守卫。" },
    ]),
    createPet("brave-lion", "普通系", "威风系", "勇", [
      { name: "小勇狮", needLevel: 1, desc: "普通系幼年伙伴，勇敢而热烈。" },
      { name: "炽焰狮", needLevel: 36, desc: "普通系成长形态，拥有炽热的鬃毛。" },
      { name: "炽心勇狮", needLevel: 54, desc: "普通系高阶形态，勇猛而充满力量。" },
    ]),
    createPet("dragon-breath-par", "恶系", "酷系", "龙", [
      { name: "小帕尔", needLevel: 1, desc: "恶系幼年伙伴，神秘而灵巧。" },
      { name: "帕尔萨斯", needLevel: 36, desc: "恶系成长形态，气场更加锋利。" },
      { name: "龙息帕尔", needLevel: 54, desc: "恶系高阶形态，带有龙息般的气场。" },
    ]),
    createPet("clown-duke", "幻系", "帅气系", "丑", [
      { name: "小丑豆豆", needLevel: 1, desc: "幻系幼年伙伴，古怪而有趣。" },
      { name: "小丑兔", needLevel: 36, desc: "幻系成长形态，拥有独特的舞台感。" },
      { name: "小丑公爵", needLevel: 54, desc: "幻系高阶形态，古怪帅气。" },
    ]),
    createPet("holy-sword-x", "机械系", "酷系", "剑", [
      { name: "圣剑侍从", needLevel: 1, desc: "机械系伙伴，利落而认真。" },
      { name: "圣剑-X", needLevel: 36, desc: "机械系进化形态，带有未来装备风格。" },
    ]),
    createPet("handsome-puppet", "幻系", "帅气系", "帅", [
      { name: "牵线木偶", needLevel: 1, desc: "幻系伙伴，精致而神秘。" },
      { name: "帅帅魔偶", needLevel: 36, desc: "幻系进化形态，精致利落。" },
    ]),
    createPet("giant-stone", "地系", "威风系", "巨", [
      { name: "石石", needLevel: 1, desc: "地系幼年伙伴，厚重稳健。" },
      { name: "巨灵石", needLevel: 36, desc: "地系进化形态，像可靠的岩石伙伴。" },
    ]),
    createPet("hammer-stork", "翼系", "酷系", "锤", [
      { name: "锤头鹳", needLevel: 1, desc: "翼系伙伴，造型独特，兼具飞行与力量感。" },
    ]),
    createPet("water-spirit", "水系", "唯美系", "水", [
      { name: "水蓝蓝", needLevel: 1, desc: "水系幼年伙伴，清澈灵动。" },
      { name: "水灵", needLevel: 36, desc: "水系成长形态，温柔而明亮。" },
      { name: "圣水守护", needLevel: 54, desc: "水系高阶形态，拥有守护者气质。" },
    ]),
    createPet("magic-cat", "草系", "可爱系", "魔", [
      { name: "喵喵", needLevel: 1, desc: "草系幼年伙伴，俏皮亲人。" },
      { name: "魔力猫", needLevel: 36, desc: "草系成长形态，拥有轻快的自然气息。" },
      { name: "武斗酷猫", needLevel: 54, desc: "草系高阶形态，灵巧而有力量。" },
    ]),
    createPet("snow-shadow-doll", "冰系", "唯美系", "雪", [
      { name: "大耳帽兜", needLevel: 1, desc: "冰系幼年伙伴，柔软可爱。" },
      { name: "帽兜娃娃", needLevel: 36, desc: "冰系成长形态，清冷而灵动。" },
      { name: "雪影娃娃", needLevel: 54, desc: "冰系高阶形态，像雪花一样轻盈。" },
    ]),
    createPet("velvet-fairy", "光系", "唯美系", "绒", [
      { name: "小绒茧", needLevel: 1, desc: "光系幼年伙伴，柔软而安静。" },
      { name: "绒绒", needLevel: 36, desc: "光系成长形态，明亮柔和。" },
      { name: "绒仙子", needLevel: 54, desc: "光系高阶形态，拥有仙子般的气质。" },
    ]),
    createPet("spring-rabbit", "草系", "可爱系", "春", [
      { name: "春兔", needLevel: 1, desc: "草系伙伴，活泼甜美。" },
      { name: "春花兔", needLevel: 36, desc: "草系进化形态，带着春日花香。" },
    ]),
    createPet("pink-star-rabbit", "幻系", "软萌系", "粉", [
      { name: "粉星仔", needLevel: 1, desc: "幻系伙伴，软萌灵巧。" },
      { name: "粉耳星兔", needLevel: 36, desc: "幻系进化形态，像星光下的小兔子。" },
    ]),
    createPet("flower-antelope", "幽系", "唯美系", "花", [
      { name: "铃兰羊", needLevel: 1, desc: "幽系伙伴，优雅而安静。" },
      { name: "锥尾羊", needLevel: 36, desc: "幽系成长形态，拥有轻盈灵巧的身姿。" },
      { name: "花影羚羊", needLevel: 54, desc: "幽系高阶形态，拥有花影般的梦幻感。" },
    ]),
    createPet("sundae-sweet", "冰系", "可爱系", "甜", [
      { name: "圣代甜甜", needLevel: 1, desc: "冰系伙伴，甜美俏皮。" },
    ]),
    createPet("yibei-fenfen", "草系", "软萌系", "伊", [
      { name: "伊贝儿", needLevel: 1, desc: "草系幼年伙伴，圆润可亲。" },
      { name: "伊贝粉粉", needLevel: 36, desc: "草系进化形态，温柔可爱。" },
    ]),

    // ===== 新增洛克王国世界手游宠物 =====
    createPet("water-shell", "水系", "威风系", "壳", [
      { name: "板板壳", needLevel: 1, desc: "水系幼年伙伴，背着坚硬的贝壳。" },
      { name: "咔咔壳", needLevel: 36, desc: "水系成长形态，贝壳更加坚固。" },
      { name: "水泡壳", needLevel: 54, desc: "水系高阶形态，能吐出巨大的水泡攻击。" },
    ]),
    createPet("qili-grass", "草系", "唯美系", "奇", [
      { name: "奇丽草", needLevel: 1, desc: "草系幼年伙伴，身上有美丽的花纹。" },
      { name: "奇丽叶", needLevel: 36, desc: "草系成长形态，叶子宽大而翠绿。" },
      { name: "奇丽花", needLevel: 54, desc: "草系高阶形态，绽放出奇异的花朵。" },
    ]),
    createPet("electric-sheep", "电系", "可爱系", "咩", [
      { name: "电咩咩", needLevel: 1, desc: "电系幼年伙伴，身上带着静电。" },
      { name: "粉咩咩", needLevel: 36, desc: "电系成长形态，毛发变成粉色。" },
      { name: "电球咩咩", needLevel: 54, desc: "电系高阶形态，变成带电的圆球。" },
    ]),
    createPet("snow-doll", "冰系", "唯美系", "娃", [
      { name: "雪娃娃", needLevel: 1, desc: "冰系幼年伙伴，像雪人一样可爱。" },
      { name: "冰封怨灵", needLevel: 36, desc: "冰系进化形态，被冰封的怨灵觉醒了。" },
    ]),
    createPet("small-otter", "普通系", "可爱系", "獭", [
      { name: "小鼠獭", needLevel: 1, desc: "普通系幼年伙伴，活泼好动的小水獭。" },
      { name: "燕尾獭", needLevel: 36, desc: "普通系成长形态，尾巴像燕子一样。" },
      { name: "卷胡巨獭", needLevel: 54, desc: "普通系高阶形态，长着卷曲胡须的巨獭。" },
    ]),
    createPet("duoduo-poison", "毒系", "酷系", "毒", [
      { name: "多多", needLevel: 1, desc: "毒系幼年伙伴，带着毒气的小怪物。" },
      { name: "多啦多", needLevel: 36, desc: "毒系成长形态，毒气更加浓郁。" },
      { name: "古啦多", needLevel: 54, desc: "毒系高阶形态，古老的毒系霸主。" },
    ]),
    createPet("cute-ape", "火系", "威风系", "猿", [
      { name: "可爱猿", needLevel: 1, desc: "火系幼年伙伴，可爱的小猴子。" },
      { name: "炽热猿", needLevel: 36, desc: "火系成长形态，全身散发着炽热气息。" },
      { name: "火焰猿", needLevel: 54, desc: "火系高阶形态，被火焰包裹的巨猿。" },
    ]),
    createPet("blues", "冰系", "帅气系", "布", [
      { name: "布鲁斯", needLevel: 1, desc: "冰系幼年伙伴，酷酷的小海豹。" },
      { name: "雪顶布鲁斯", needLevel: 36, desc: "冰系成长形态，头顶覆盖着冰雪。" },
      { name: "冰钻布鲁斯", needLevel: 54, desc: "冰系高阶形态，拥有冰钻般的利爪。" },
    ]),
    createPet("spirit-fox", "火系", "唯美系", "狐", [
      { name: "灵狐", needLevel: 1, desc: "火系幼年伙伴，灵动的小狐狸。" },
      { name: "九尾狐", needLevel: 36, desc: "火系成长形态，长出了九条尾巴。" },
      { name: "尖嘴狐仙", needLevel: 54, desc: "火系高阶形态，修炼成仙的狐狸。" },
    ]),
    createPet("gran-seed", "草系", "帅气系", "格", [
      { name: "格兰种子", needLevel: 1, desc: "草系幼年伙伴，像一颗会飞的种子。" },
      { name: "格兰花", needLevel: 36, desc: "草系成长形态，花瓣可以旋转飞行。" },
      { name: "格兰球", needLevel: 54, desc: "草系高阶形态，变成了圆滚滚的飞行球。" },
    ]),
    createPet("benbo-mouse", "地系", "可爱系", "奔", [
      { name: "奔波鼠", needLevel: 1, desc: "地系幼年伙伴，四处奔波的小老鼠。" },
      { name: "流浪鼠", needLevel: 36, desc: "地系进化形态，到处流浪的老鼠。" },
    ]),
    createPet("ground-mouse", "土系", "可爱系", "鼠", [
      { name: "地鼠", needLevel: 1, desc: "土系幼年伙伴，擅长在地下挖洞。" },
      { name: "遁鼠", needLevel: 36, desc: "土系进化形态，能瞬间遁入地下。" },
      { name: "遁地鼠", needLevel: 54, desc: "土系高阶形态，遁地能力极强。" },
    ]),
    createPet("bee-queen", "虫系", "威风系", "蜂", [
      { name: "一窝蜂", needLevel: 1, desc: "虫系幼年伙伴，成群结队的小蜜蜂。" },
      { name: "黄蜂后", needLevel: 36, desc: "虫系进化形态，蜂群的女王。" },
    ]),
    createPet("jade-jellyfish", "水系", "唯美系", "母", [
      { name: "翡翠水母", needLevel: 1, desc: "水系幼年伙伴，像翡翠一样的水母。" },
      { name: "琉璃水母", needLevel: 36, desc: "水系进化形态，像琉璃一样美丽。" },
    ]),
    createPet("timid-eel", "电系", "酷系", "鳗", [
      { name: "胆小鳗鱼", needLevel: 1, desc: "电系幼年伙伴，胆小的小鳗鱼。" },
      { name: "闪电鳗鱼", needLevel: 36, desc: "电系进化形态，能释放闪电的鳗鱼。" },
    ]),
    createPet("grass-bug", "虫系", "可爱系", "虫", [
      { name: "小草虫", needLevel: 1, desc: "虫系幼年伙伴，生活在草丛中的小虫。" },
      { name: "草衣虫", needLevel: 36, desc: "虫系进化形态，用草叶编织外衣。" },
    ]),
    createPet("black-cat", "幽系", "酷系", "猫", [
      { name: "小黑猫", needLevel: 1, desc: "幽系幼年伙伴，神秘的小黑猫。" },
      { name: "黑猫巫师", needLevel: 36, desc: "幽系进化形态，会魔法的黑猫。" },
    ]),
    createPet("pig-tusk", "冰系", "威风系", "猪", [
      { name: "呼呼猪", needLevel: 1, desc: "冰系幼年伙伴，爱睡觉的小猪。" },
      { name: "獠牙猪", needLevel: 36, desc: "冰系进化形态，长出了锋利的獠牙。" },
    ]),
    createPet("pine-sheep", "草系", "唯美系", "松", [
      { name: "松仔", needLevel: 1, desc: "草系幼年伙伴，像松果一样的小羊。" },
      { name: "松叶羊", needLevel: 36, desc: "草系成长形态，身上长满松针。" },
      { name: "针叶巡林", needLevel: 54, desc: "草系高阶形态，森林的守护者。" },
    ]),
    createPet("dai-lu", "普通系", "帅气系", "路", [
      { name: "呆小路", needLevel: 1, desc: "普通系幼年伙伴，呆呆的小路。" },
      { name: "舞动路路", needLevel: 36, desc: "普通系成长形态，喜欢跳舞。" },
      { name: "白发路路", needLevel: 54, desc: "普通系高阶形态，白发的舞者。" },
    ]),
    createPet("spider", "虫系", "酷系", "蛛", [
      { name: "圆眼蜘蛛", needLevel: 1, desc: "虫系幼年伙伴，圆眼睛的小蜘蛛。" },
      { name: "尖角蜘蛛", needLevel: 36, desc: "虫系进化形态，长着尖角的蜘蛛。" },
    ]),
    createPet("qiuluo-poison", "毒系", "酷系", "裘", [
      { name: "裘洛", needLevel: 1, desc: "毒系幼年伙伴，神秘的小毒物。" },
      { name: "裘力", needLevel: 36, desc: "毒系成长形态，毒性更强。" },
      { name: "裘卡", needLevel: 54, desc: "毒系高阶形态，毒系杀手。" },
    ]),
    createPet("douding-fish", "水系", "可爱系", "豆", [
      { name: "豆丁鱼", needLevel: 1, desc: "水系幼年伙伴，像豆子一样的小鱼。" },
      { name: "快鳍鱼", needLevel: 36, desc: "水系成长形态，鱼鳍变得很快。" },
      { name: "龙鱼", needLevel: 54, desc: "水系高阶形态，像龙一样的鱼。" },
    ]),
    createPet("bobo-snail", "水系", "可爱系", "螺", [
      { name: "波波螺", needLevel: 1, desc: "水系幼年伙伴，会吐泡泡的小螺。" },
      { name: "消波螺", needLevel: 36, desc: "水系成长形态，能消除波浪。" },
      { name: "嗜波螺", needLevel: 54, desc: "水系高阶形态，以波浪为食。" },
    ]),
    createPet("scepter", "机械系", "酷系", "权", [
      { name: "权杖-Ⅱ", needLevel: 1, desc: "机械系幼年伙伴，初级权杖。" },
      { name: "权杖-V", needLevel: 36, desc: "机械系进化形态，高级权杖。" },
    ]),
    createPet("kaka-bird", "翼系", "可爱系", "咔", [
      { name: "咔咔羽毛", needLevel: 1, desc: "翼系幼年伙伴，毛茸茸的小鸟。" },
      { name: "咔咔雀", needLevel: 36, desc: "翼系成长形态，活泼的小雀。" },
      { name: "咔咔鸟", needLevel: 54, desc: "翼系高阶形态，会唱歌的小鸟。" },
    ]),
    createPet("memory-stone", "地系", "酷系", "忆", [
      { name: "记忆石", needLevel: 1, desc: "地系伙伴，承载着古老记忆的石头。" },
    ]),
    createPet("grass-spirit", "草系", "唯美系", "灵", [
      { name: "绿草精灵", needLevel: 1, desc: "草系幼年伙伴，草丛中的小精灵。" },
      { name: "魔草巫灵", needLevel: 36, desc: "草系进化形态，会魔法的草灵。" },
    ]),
    createPet("sea-helmet", "水系", "威风系", "盔", [
      { name: "海盔虫", needLevel: 1, desc: "水系幼年伙伴，戴着头盔的小虫。" },
      { name: "刺盔虫", needLevel: 36, desc: "水系成长形态，头盔长满尖刺。" },
      { name: "千棘盔", needLevel: 54, desc: "水系高阶形态，千棘之王。" },
    ]),
    createPet("wind-shark", "水系", "威风系", "鲨", [
      { name: "风铃鲨", needLevel: 1, desc: "水系幼年伙伴，像风铃一样的小鲨。" },
      { name: "蓝蝶鲨", needLevel: 36, desc: "水系成长形态，像蝴蝶一样美丽。" },
      { name: "彩蝶鲨", needLevel: 54, desc: "水系高阶形态，五彩斑斓的鲨鱼。" },
    ]),
    createPet("ritual-giant", "地系", "威风系", "仪", [
      { name: "仪使者", needLevel: 1, desc: "地系幼年伙伴，仪式的使者。" },
      { name: "仪式之星", needLevel: 36, desc: "地系成长形态，仪式中的明星。" },
      { name: "仪式巨像", needLevel: 54, desc: "地系高阶形态，巨大的仪式石像。" },
    ]),
    // ===== 异色稀有宠物（3只） =====
    createPet("shiny-demon-wolf", "恶系", "异色稀有", "异", [
      { name: "异色恶魔狼", needLevel: 1, desc: "稀有的白紫色恶魔狼，基础资质比普通恶魔狼更强。" },
      { name: "异色魔狼王", needLevel: 36, desc: "异色恶魔狼的进化形态，散发着神秘的紫色光芒。" },
      { name: "异色魔影狼王", needLevel: 54, desc: "传说中的异色狼王，月影下的最强猎手。" },
    ]),
    createPet("shiny-snow-doll", "冰系", "异色稀有", "异", [
      { name: "异色大耳帽兜", needLevel: 1, desc: "稀有的粉绿色大耳帽兜，基础资质比普通大耳帽兜更强。" },
      { name: "异色帽兜精灵", needLevel: 36, desc: "异色大耳帽兜的进化形态，耳朵像花瓣一样美丽。" },
      { name: "异色雪影女王", needLevel: 54, desc: "冰雪中的异色女王，拥有治愈人心的力量。" },
    ]),
    createPet("shiny-pink-star", "幻系", "异色稀有", "异", [
      { name: "异色粉星仔", needLevel: 1, desc: "稀有的紫蓝色粉星仔，基础资质比普通粉星仔更强。" },
      { name: "异色紫耳星兔", needLevel: 36, desc: "异色粉星仔的进化形态，星星闪烁着神秘的紫光。" },
      { name: "异色彩星神", needLevel: 54, desc: "来自星空的异色神明，能带来好运与奇迹。" },
    ]),
  ]);

  global.CARLOSIA_PET_DATA = Object.freeze({
    petDatabase,
  });
})(window);
