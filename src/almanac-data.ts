import type { UnitKind } from "../shared/cards.ts";

export interface AlmanacCopy {
  description: string;
  attack: string;
  role: string;
}

export const ALMANAC_COPY: Record<UnitKind, AlmanacCopy> = {
  sunflower: { role: "经济", attack: "不攻击；每约 24 秒生产 50 阳光", description: "花园的经济核心。越早种下，越能支撑后续高费用阵容。" },
  peashooter: { role: "单线输出", attack: "向右发射豌豆，命中同行第一只僵尸", description: "可靠的基础射手，价格与持续输出都很均衡。" },
  snowpea: { role: "减速输出", attack: "寒冰豌豆造成伤害并减慢移动和啃食", description: "用较高费用换取控场能力，适合保护坚果和后排。" },
  threepeater: { role: "三线输出", attack: "同时向所在行及上下相邻行射击", description: "覆盖三条路线，但部署费用较高，适合居中布置。" },
  wallnut: { role: "防御", attack: "不攻击；以高生命阻挡僵尸", description: "朴实的肉盾，为后排射手争取持续输出时间。" },
  tallnut: { role: "重型防御", attack: "不攻击；撑杆僵尸无法越过", description: "比普通坚果更坚固，也能封锁撑杆跳跃路线。" },
  potatomine: { role: "伏击", attack: "准备完成后引爆附近僵尸", description: "便宜但需要时间武装，适合放在远处预判敌人路线。" },
  squash: { role: "近距离秒杀", attack: "发现近处僵尸后跳起砸击", description: "一次性的近战伏击植物，落地会将目标压扁。" },
  cherrybomb: { role: "范围爆破", attack: "对自身周围三行范围造成巨额伤害", description: "短引信范围炸弹，适合处理聚集的高威胁僵尸。" },
  jalapeno: { role: "整行清场", attack: "火浪烧穿所在整条路线", description: "不受距离影响，适合挽救已经失守的一整行。" },
  shieldbamboo: { role: "多阶段坦克", attack: "不攻击；每破一层护盾换一种守法", description: "三层竹甲依次转化为震退、竹钉与锁芯。总耐久略低于高坚果，换来的是三段主动收益：外甲碎时把身前僵尸推开，中甲碎时在前方落下竹钉定住来敌，内甲碎时锁住竹芯进入减伤——巨人的第一锤砸不死它。还有护盾时撑杆僵尸跳不过去。" },

  zombie: { role: "基础推进", attack: "靠近植物后持续啃食", description: "最普通的步兵，便宜、冷却短，适合持续施压。" },
  conehead: { role: "轻甲推进", attack: "近身啃食；路障提供额外耐久", description: "戴着路障的普通僵尸，能够承受更多豌豆。" },
  buckethead: { role: "重甲推进", attack: "近身啃食；铁桶提供大量耐久", description: "沉重铁桶让它成为可靠的正面坦克。" },
  screendoor: { role: "护盾推进", attack: "举铁门前进，护盾破碎后继续啃食", description: "以铁门吸收伤害，门破时会产生明显的碎裂反馈。" },
  newspaper: { role: "暴走突进", attack: "报纸破碎前缓慢推进，破碎后暴走", description: "不要被它安静阅读的样子骗了，失去报纸后速度大幅提升。" },
  polevaulter: { role: "越障突进", attack: "跳过首株普通植物后步行啃食", description: "能越过普通防线，但无法跳过高坚果。" },
  dancer: { role: "召唤", attack: "推进途中召唤上下相邻行的伴舞", description: "用伴舞同时向多路施压，本体也能近身攻击。" },
  football: { role: "高速重甲", attack: "高速冲锋并近身啃食", description: "速度、生命都很高，适合快速撕开薄弱路线。" },
  nailong: { role: "远程攻城", attack: "在约四格外大笑，向左发射金色光波", description: "不会主动贴脸啃食；同行有植物时会站在射程外持续轰击。" },
  shadowstrike: { role: "刺客", attack: "潜行接近，第一口造成额外伤害", description: "影幕里的残影普通豌豆锁不住，能直接摸到后排。第一次咬到植物就显形，之后速度也慢下来。寒冰射手看得穿影幕，土豆雷和窝瓜也不靠锁定，都是它的克星。" },
  zhongkui: { role: "阵型控制", attack: "近身啃食；每隔一段时间甩钩拖动植物", description: "抬钩有明显前摇，会把前方三格内的植物强行拖近一格，右边一格被占住就钩不动。坚果类和机关盾竹能崩掉第一钩。钩到窝瓜或土豆雷会被当场反杀，钩到寒冰射手则被冻住。" },
  mimicsunflower: { role: "资源干扰", attack: "潜伏时不攻击；现形后近身啃食", description: "钻进植物阵地装成一株向日葵，占着格子不动，主动攻击锁不到它。每次「生产」不产阳光，反而偷走 25 点，累计偷到 100 就现形。铲子能直接铲掉它，范围爆炸也打得到——数数自己种了几株向日葵就能发现异常。" },
  gargantuar: { role: "重型破阵", attack: "巨锤直接压扁植物；半血投出小鬼", description: "极其坚固的终局单位，砸击与小鬼能连续破坏防线。" },
  imp: { role: "召唤单位", attack: "落地后快速啃食", description: "由巨人投进花园深处，不作为直接可选卡。" },
  backupdancer: { role: "召唤单位", attack: "随舞王推进并近身啃食", description: "由舞王召唤到相邻路线，不作为直接可选卡。" },
};
