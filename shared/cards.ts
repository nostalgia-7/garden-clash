/**
 * 共享的纯数值卡表与盘面常量。服务器权威模拟和浏览器本地模拟都读这一份，
 * 保证两端数值完全一致。这里**只放规则数值**，不含任何渲染信息
 * （name/icon/VISUAL_LAYOUT 留在客户端 src/game.ts）。
 */

export type Side = "plants" | "zombies";
export type PlantKind =
  | "sunflower" | "peashooter" | "snowpea" | "wallnut" | "potatomine" | "cherrybomb"
  | "threepeater" | "tallnut" | "jalapeno" | "squash" | "shieldbamboo";
export type ZombieKind =
  | "zombie" | "conehead" | "buckethead" | "polevaulter" | "football" | "gargantuar" | "imp"
  | "screendoor" | "newspaper" | "dancer" | "nailong" | "backupdancer"
  | "shadowstrike" | "zhongkui" | "mimicsunflower";
export type UnitKind = PlantKind | ZombieKind;

/** 单位的规则数值。cost/cooldown 只对可选卡有意义；小鬼和伴舞是被召唤的，不入卡池。 */
export interface CardStats {
  kind: UnitKind;
  side: Side;
  cost: number;
  cooldown: number;
  hp: number;
  speed?: number;        // 僵尸移动速度（像素/秒）
  damage?: number;
  attackEvery?: number;  // 攻击间隔（秒）
  /** 远程僵尸的射程（像素）。奶龙靠它站在射程外发光波，不近身啃食。 */
  range?: number;
}

export const PLANT_STATS: CardStats[] = [
  { kind: "sunflower", side: "plants", cost: 50, cooldown: 7.5, hp: 300 },
  { kind: "peashooter", side: "plants", cost: 100, cooldown: 7.5, hp: 300, damage: 20, attackEvery: 1.5 },
  { kind: "snowpea", side: "plants", cost: 175, cooldown: 7.5, hp: 300, damage: 20, attackEvery: 1.5 },
  { kind: "threepeater", side: "plants", cost: 325, cooldown: 7.5, hp: 300, damage: 20, attackEvery: 1.5 },
  { kind: "wallnut", side: "plants", cost: 50, cooldown: 30, hp: 4000 },
  { kind: "tallnut", side: "plants", cost: 125, cooldown: 30, hp: 8000 },
  { kind: "potatomine", side: "plants", cost: 25, cooldown: 30, hp: 300, damage: 1800 },
  { kind: "squash", side: "plants", cost: 50, cooldown: 30, hp: 300, damage: 1800 },
  { kind: "cherrybomb", side: "plants", cost: 150, cooldown: 50, hp: 999, damage: 1800 },
  { kind: "jalapeno", side: "plants", cost: 125, cooldown: 50, hp: 999, damage: 1800 },
  // 机关盾竹：总耐久 7000 略低于 125 阳光的高坚果，多花 50 阳光换三段主动收益。
  { kind: "shieldbamboo", side: "plants", cost: 175, cooldown: 35, hp: 7000 },
];

export const ZOMBIE_STATS: CardStats[] = [
  { kind: "zombie", side: "zombies", cost: 50, cooldown: 3, hp: 270, speed: 19, damage: 100, attackEvery: 1 },
  { kind: "conehead", side: "zombies", cost: 75, cooldown: 5, hp: 640, speed: 19, damage: 100, attackEvery: 1 },
  { kind: "buckethead", side: "zombies", cost: 125, cooldown: 8, hp: 1370, speed: 19, damage: 100, attackEvery: 1 },
  { kind: "screendoor", side: "zombies", cost: 125, cooldown: 8, hp: 1370, speed: 19, damage: 100, attackEvery: 1 },
  { kind: "newspaper", side: "zombies", cost: 100, cooldown: 7, hp: 470, speed: 19, damage: 100, attackEvery: 1 },
  { kind: "polevaulter", side: "zombies", cost: 125, cooldown: 9, hp: 500, speed: 36, damage: 100, attackEvery: 1 },
  { kind: "dancer", side: "zombies", cost: 200, cooldown: 16, hp: 500, speed: 17, damage: 100, attackEvery: 1 },
  { kind: "football", side: "zombies", cost: 175, cooldown: 13, hp: 1400, speed: 38, damage: 100, attackEvery: 1 },
  { kind: "nailong", side: "zombies", cost: 225, cooldown: 14, hp: 800, speed: 15, damage: 45, attackEvery: 1.6, range: 340 },
  // 影袭：介于撑杆 125 与橄榄球 175 之间，用低耐久换一次可靠的接近。
  { kind: "shadowstrike", side: "zombies", cost: 150, cooldown: 11, hp: 540, speed: 26, damage: 100, attackEvery: 1 },
  // 钟馗：生命低于同价位坦克，买的是每 11 秒一次的阵型破坏。
  { kind: "zhongkui", side: "zombies", cost: 200, cooldown: 15, hp: 1050, speed: 15, damage: 100, attackEvery: 1 },
  // 伪装向日葵：潜伏期不动不攻击，现形后就是一只普通近战僵尸。
  { kind: "mimicsunflower", side: "zombies", cost: 150, cooldown: 18, hp: 470, speed: 19, damage: 100, attackEvery: 1 },
  { kind: "gargantuar", side: "zombies", cost: 300, cooldown: 24, hp: 3000, speed: 13, damage: 99999, attackEvery: 2.75 },
];

/** 小鬼只由巨人投出，不作为可选卡出现。 */
export const IMP_STATS: CardStats = {
  kind: "imp", side: "zombies", cost: 0, cooldown: 0, hp: 270, speed: 24, damage: 100, attackEvery: 1,
};

/** 伴舞只由舞王召唤，不作为可选卡出现。 */
export const BACKUP_DANCER_STATS: CardStats = {
  kind: "backupdancer", side: "zombies", cost: 0, cooldown: 0, hp: 270, speed: 17, damage: 100, attackEvery: 1,
};

/** 读报僵尸失去报纸后的暴走速度。 */
export const NEWSPAPER_RAGE_SPEED = 45;
/** 护具（路障/铁桶/铁门）耗尽的血量阈值，等于普通僵尸本体血量。 */
export const ARMOR_BREAK_HP = 270;

/**
 * 机关盾竹的三层护盾。总耐久 7000 = 三层各 1800 + 竹芯 1600；
 * 每层破掉时触发一个一次性效果，血线降到阈值以下即算破。
 */
export const BAMBOO = {
  /** 破盾阈值（剩余总生命）。依次对应震退、落钉、锁芯。 */
  thresholds: [5200, 3400, 1600],
  /** 外甲·震退：前方这么远内最多推 3 只僵尸。 */
  repulseRange: 145,
  repulseCount: 3,
  repulsePush: 68,
  /** 被震退的僵尸这么久之内啃不动东西；巨人只吃一半位移。 */
  repulseInterrupt: 0.8,
  repulseBossFactor: 0.5,
  /** 中甲·落钉：正前方一格地面留一组竹钉，只有一次充能。 */
  caltropAhead: 1,
  caltropDuration: 8,
  caltropDamage: 240,
  caltropRoot: 1.25,
  caltropBossRootFactor: 0.5,
  /** 内甲·锁芯：触发这一击后至少保留 800 竹芯血，并进入 4 秒减伤。 */
  coreFloor: 800,
  coreLockDuration: 4,
  coreLockReduction: 0.6,
} as const;

/** 影袭僵尸的隐身参数。隐身时更快，显形后放慢；第一击带伏击加成。 */
export const SHADOWSTRIKE = {
  cloakedSpeed: 26,
  revealedSpeed: 21,
  ambushDamage: 160,
} as const;

/** 钟馗僵尸的镇魂钩。前摇结束才结算位移，前摇中被冻结或打死则取消。 */
export const ZHONGKUI = {
  /** 入场后先等这么久才放第一钩，之后按 interval 循环；啃食时暂停计时。 */
  firstHookDelay: 3.5,
  interval: 11,
  windup: 1.2,
  /** 3 格 = 255 像素。 */
  range: 255,
  /** 被钩中的伏击植物反过来砸钟馗的伤害。 */
  backfireDamage: 1800,
  /** 寒冰顺铁链回传的冻结时长。 */
  snowFreeze: 4,
} as const;

/** 伪装向日葵。潜入植物方前六列的空格，装成向日葵偷阳光。 */
export const MIMIC = {
  /** 只能潜入第 0 至 5 列。 */
  maxCol: 5,
  /** 钻地到成形的时间，这期间僵尸方能看见土堆。 */
  burrow: 0.8,
  /** 每 9 秒偷 25 阳光。 */
  stealInterval: 9,
  stealAmount: 25,
  /** 累计偷到 100 就现形。 */
  revealAt: 100,
  /** 就算一直没被发现，45 秒也强制现形，给玩家一个损失上限。 */
  maxDisguise: 45,
} as const;

export const CARD_STATS = new Map<UnitKind, CardStats>(
  [...PLANT_STATS, ...ZOMBIE_STATS, IMP_STATS, BACKUP_DANCER_STATS].map((card) => [card.kind, card]),
);

export const PLANT_KINDS: readonly PlantKind[] = PLANT_STATS.map((c) => c.kind as PlantKind);
export const ZOMBIE_KINDS: readonly ZombieKind[] = ZOMBIE_STATS.map((c) => c.kind as ZombieKind);

// ---- 盘面几何。客户端渲染与服务器坐标计算共用同一套坐标系。 ----
export const W = 1400;
export const H = 600;
export const ROWS = 5;
export const COLS = 9;
export const GRID_X = 230;
export const GRID_Y = 75;
export const CELL_W = 85;
export const CELL_H = 100;
export const GRID_RIGHT = GRID_X + COLS * CELL_W;
/** 僵尸从草坪右侧人行道边缘入场，入场后立刻向左推进。 */
export const SPAWN_X = GRID_RIGHT + 45;
/** 割草机初始停放位置（草坪最左侧外）。 */
export const MOWER_X = 183;

/** 单局倒计时上限：10 分钟。本地练习和服务器权威对局共用这一份。 */
export const ROUND_SECONDS = 10 * 60;

// ---- 经济节奏（秒 / 每次 +25）。 ----
export const SUN_INTERVAL = 4;
export const BRAIN_INTERVAL = 3;
export const INCOME_STEP = 25;
export const RESOURCE_CAP = 999;
export const START_SUN = 250;
export const START_BRAINS = 250;

/**
 * 角色脚底线。原版角色向上生长/站立，放在格子 85% 高度处时，
 * 植物视觉中心与高个僵尸身体中心都落在该路线中部。
 */
export function laneY(row: number): number {
  return GRID_Y + row * CELL_H + CELL_H * 0.85;
}

/** 格子中心 X（种植物用）。 */
export function cellCenterX(col: number): number {
  return GRID_X + (col + 0.5) * CELL_W;
}
