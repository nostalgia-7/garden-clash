/**
 * 花园攻防战：纯确定性战斗模拟。
 *
 * 服务器以 10Hz 权威运行这份逻辑；浏览器的同屏双人模式也跑同一份。它**不依赖
 * DOM / Canvas / Reanim / window / Date.now / Math.random**——时间只来自 step(dt)
 * 的固定 dt，单位遍历顺序即插入顺序，因此两端逐 tick 结果完全一致。
 *
 * 逻辑忠实移植自原 src/game.ts 的 update* 系列方法，唯一区别是每个单位用一个
 * state 字符串字段记录动画状态（原本是 visual.setState 的参数），随快照下发，
 * 客户端据此播放对应动画，自身不再推断。
 */

import {
  CARD_STATS, IMP_STATS, BACKUP_DANCER_STATS, ARMOR_BREAK_HP, NEWSPAPER_RAGE_SPEED,
  BAMBOO, SHADOWSTRIKE, ZHONGKUI, MIMIC,
  type PlantKind, type Side, type UnitKind, type ZombieKind,
  ROWS, COLS, GRID_X, CELL_W, CELL_H, GRID_RIGHT, SPAWN_X, MOWER_X, ROUND_SECONDS,
  SUN_INTERVAL, BRAIN_INTERVAL, INCOME_STEP, RESOURCE_CAP, START_SUN, START_BRAINS,
  laneY, cellCenterX,
} from "./cards.ts";

/** 巨人投鬼时要隐藏的小鬼挂件轨道（渲染细节，但 sim 需要把它随快照告知客户端）。 */
export const GARGANTUAR_IMP_TRACKS = [
  "Zombie_imp_innerarm_upper", "Zombie_imp_innerarm_lower",
  "Zombie_imp_outerarm_upper", "Zombie_imp_outerarm_lower",
  "Zombie_imp_innerleg_foot", "Zombie_imp_innerleg_lower", "Zombie_imp_innerleg_upper",
  "Zombie_imp_outerleg_foot", "Zombie_imp_outerleg_lower", "Zombie_imp_outerleg_upper",
  "Zombie_imp_body1", "Zombie_imp_body2", "Zombie_imp_head", "Zombie_imp_jaw",
];

export interface SimPlant {
  id: number;
  kind: PlantKind;
  row: number;
  col: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  timer: number;
  attackTimer: number;
  armed: boolean;
  rising: boolean;
  triggered: boolean;
  /** 机关盾竹已经破掉几层护盾（0～3）。客户端据此换形态。 */
  shieldsBroken: number;
  /** 锁芯减伤的剩余时间。 */
  coreLockTimer: number;
  /** 已经被钟馗钩中过几次；坚果类靠它抵抗第一钩。 */
  hookedCount: number;
}

export interface SimZombie {
  id: number;
  kind: ZombieKind;
  row: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  state: string;
  attackTimer: number;
  slowTimer: number;
  jumped: boolean;
  jumpTimer: number;
  jumpDuration: number;
  jumpStartX: number;
  jumpEndX: number;
  impThrown: boolean;
  impReleased: boolean;
  armorLost: boolean;
  throwTimer: number;
  airTimer: number;
  airDuration: number;
  airStartX: number;
  airEndX: number;
  landTimer: number;
  deadTimer: number;
  /** 巨人释放小鬼后置真，告诉客户端隐藏挂件小鬼。 */
  impHidden: boolean;
  /** 舞王已经召唤过几波伴舞。 */
  summonCount: number;
  /** 舞王正在播放召唤动作的剩余时间。 */
  summonTimer: number;
  /** 伴舞已经落位（召唤动画放完），开始正常推进。 */
  summoned: boolean;
  /** 奶龙正在大笑蓄力的剩余时间；> 0 表示这一发光波还没脱手。 */
  laughTimer: number;
  /** 影袭还在影幕里；第一次咬到植物或吃到寒冰/范围伤害就变假。 */
  cloaked: boolean;
  /** 被震退或竹钉定住，这段时间内啃不动也走不动。 */
  stunTimer: number;
  /** 钟馗距离下一次可以放钩还有多久。 */
  hookTimer: number;
  /** 钟馗抬钩前摇的剩余时间；> 0 表示这一钩还没结算。 */
  hookWindup: number;
  /** 钟馗这一钩锁定的植物 id。 */
  hookTargetId: number;
  /** 伪装向日葵潜伏中：占着植物格、装成向日葵、不动不攻击。 */
  disguised: boolean;
  /** 伪装体所占的格子；现形后不再有意义。 */
  col: number;
  /** 钻地到成形的剩余时间。 */
  burrowTimer: number;
  /** 距离下一次偷阳光还有多久。 */
  stealTimer: number;
  /** 累计已经偷到的阳光，到 100 就现形。 */
  stolenSun: number;
  /** 伪装已经维持了多久，到上限强制现形。 */
  disguiseAge: number;
}

/** 机关盾竹落在地上的竹钉。定身一次就用完，或者到时间自然消失。 */
export interface SimCaltrop {
  id: number;
  row: number;
  col: number;
  x: number;
  y: number;
  /** 剩余存在时间。 */
  timer: number;
}

export interface SimProjectile {
  id: number;
  row: number;
  x: number;
  lastX: number;
  y: number;
  damage: number;
  frozen: boolean;
  /** 1 = 向右（植物打僵尸），-1 = 向左（奶龙光波打植物）。 */
  dir: 1 | -1;
  /** 客户端据此选择绘制样式。 */
  look: "pea" | "snow" | "wave";
}

export interface SimMower {
  row: number;
  x: number;
  state: "idle" | "active" | "spent";
}

/** 一 tick 内产生的一次性视觉/音效提示，客户端据此放粒子，不影响模拟。 */
export interface SimEvent {
  kind:
    | "burst" | "sun" | "explode" | "mower"
    | "shoot" | "hit" | "impact" | "flatten" | "burn" | "armorBreak" | "death"
    | "plant" | "spawn" | "shovel";
  x: number;
  y: number;
  color?: string;
  size?: number;
  row?: number;
  /** 语义事件的施放者/承受者。客户端据此给现存单位加短补间。 */
  sourceId?: number;
  targetId?: number;
  sourceKind?: UnitKind;
  targetKind?: UnitKind;
  /** 弹丸与大招外观，不参与伤害计算。 */
  look?: "pea" | "snow" | "wave";
  effect?: "normal" | "squash" | "gargantuar" | "cherry" | "jalapeno" | "potato" | "mower" | "wave";
  /** 这次表现是否伴随目标死亡；幸存单位只短暂受击，不生成替身退场。 */
  fatal?: boolean;
  /** 火浪从辣椒位置向两侧传播时使用；单位已在服务端立即结算伤害。 */
  delay?: number;
}

export interface SimState {
  tick: number;
  plants: SimPlant[];
  zombies: SimZombie[];
  projectiles: SimProjectile[];
  /** 机关盾竹破中甲时落下的竹钉。 */
  caltrops: SimCaltrop[];
  mowers: SimMower[];
  sun: number;
  brains: number;
  sunIncome: number;
  brainIncome: number;
  /** 分方独立的卡牌冷却（同一 kind 全场共享一个冷却，非每格）。 */
  cooldowns: Record<string, number>;
  remaining: number;
  phase: "playing" | "ended";
  winner: Side | null;
  endReason: string | null;
  nextId: number;
  /** 每 tick 开头清空；step 内累积，供快照下发后客户端消费。 */
  events: SimEvent[];
}

export type Command =
  | { k: "plant"; row: number; col: number; kind: PlantKind }
  | { k: "zombie"; row: number; kind: ZombieKind }
  | { k: "shovel"; row: number; col: number }
  | { k: "surrender"; side: Side };

export interface CommandResult {
  ok: boolean;
  reason?: string;
}

const PROJECTILE_SPEED = 300;
const MOWER_SPEED = 430;
/** 舞王的两次召唤位置：刚踏上草坪、推进到中场。 */
const SUMMON_AT = [GRID_RIGHT - 30, GRID_X + CELL_W * 5];

export function createSim(): SimState {
  return {
    tick: 0,
    plants: [],
    zombies: [],
    projectiles: [],
    caltrops: [],
    mowers: Array.from({ length: ROWS }, (_, row) => ({ row, x: MOWER_X, state: "idle" as const })),
    sun: START_SUN,
    brains: START_BRAINS,
    sunIncome: 0,
    brainIncome: 0,
    cooldowns: {},
    remaining: ROUND_SECONDS,
    phase: "playing",
    winner: null,
    endReason: null,
    nextId: 1,
    events: [],
  };
}

function burst(sim: SimState, x: number, y: number, color: string, size: number): void {
  sim.events.push({ kind: "burst", x, y, color, size });
}

function semantic(sim: SimState, event: SimEvent): void {
  sim.events.push(event);
}

function shootEvent(sim: SimState, source: SimPlant | SimZombie, look: SimProjectile["look"], x: number, y: number): void {
  semantic(sim, {
    kind: "shoot", x, y, row: source.row, sourceId: source.id, sourceKind: source.kind, look,
  });
}

/**
 * 校验并落地一条玩家命令。资源、冷却、占格、边界都在这里判定——客户端改数据无效，
 * 因为服务器持有权威 SimState。返回是否接受，便于服务器回执与客户端提示。
 */
export function enqueueCommand(sim: SimState, cmd: Command): CommandResult {
  if (sim.phase !== "playing") return { ok: false, reason: "对局已结束" };

  if (cmd.k === "surrender") {
    end(sim, cmd.side === "plants" ? "zombies" : "plants", "surrender");
    return { ok: true };
  }

  if (cmd.k === "shovel") {
    if (!inRow(cmd.row) || !inCol(cmd.col)) return { ok: false, reason: "位置非法" };
    // 伪装向日葵占着植物格，看起来就是一株向日葵，所以铲子必须先看它。
    // 认出来直接铲掉，不返还阳光——这是识破伪装的唯一手段。
    const mimic = disguisedAt(sim, cmd.row, cmd.col);
    if (mimic) {
      damageZombie(sim, mimic, mimic.hp + 1);
      semantic(sim, {
        kind: "shovel", x: mimic.x, y: mimic.y - 35, row: mimic.row,
        targetId: mimic.id, targetKind: mimic.kind,
      });
      return { ok: true };
    }
    const index = sim.plants.findIndex((p) => p.row === cmd.row && p.col === cmd.col);
    if (index < 0) return { ok: false, reason: "这个格子没有植物" };
    const plant = sim.plants[index]!;
    sim.plants.splice(index, 1);
    burst(sim, plant.x, plant.y - 35, "#d9c49b", 42);
    semantic(sim, {
      kind: "shovel", x: plant.x, y: plant.y - 35, row: plant.row,
      targetId: plant.id, targetKind: plant.kind,
    });
    return { ok: true };
  }

  const stats = CARD_STATS.get(cmd.kind);
  if (!stats) return { ok: false, reason: "未知卡牌" };
  if ((sim.cooldowns[cmd.kind] ?? 0) > 0) return { ok: false, reason: "冷却中" };

  if (cmd.k === "plant") {
    if (stats.side !== "plants") return { ok: false, reason: "阵营不符" };
    if (!inRow(cmd.row) || !inCol(cmd.col)) return { ok: false, reason: "植物只能种在草坪格子里" };
    if (sim.plants.some((p) => p.row === cmd.row && p.col === cmd.col)) {
      return { ok: false, reason: "这个格子已经有植物了" };
    }
    // 伪装体占着格子。理由写成「已经有植物了」，不能让玩家靠试种识破伪装。
    if (disguisedAt(sim, cmd.row, cmd.col)) {
      return { ok: false, reason: "这个格子已经有植物了" };
    }
    if (sim.sun < stats.cost) return { ok: false, reason: "阳光不够" };
    sim.sun -= stats.cost;
    sim.cooldowns[cmd.kind] = stats.cooldown;
    spawnPlant(sim, cmd.kind, cmd.row, cmd.col);
    return { ok: true };
  }

  // cmd.k === "zombie"
  if (stats.side !== "zombies") return { ok: false, reason: "阵营不符" };
  if (!inRow(cmd.row)) return { ok: false, reason: "请选择一条有效路线" };
  if (sim.brains < stats.cost) return { ok: false, reason: "脑力不够" };
  // 伪装向日葵要有空格才潜得进去。没有就当这条命令没发生：不扣脑力、不进冷却。
  if (cmd.kind === "mimicsunflower" && mimicTile(sim, cmd.row) === null) {
    return { ok: false, reason: "这条路线前六格没有可以潜入的空位" };
  }
  sim.brains -= stats.cost;
  sim.cooldowns[cmd.kind] = stats.cooldown;
  spawnZombie(sim, cmd.kind, cmd.row);
  return { ok: true };
}

/** 该格上潜伏着的伪装向日葵。植物方看它就是一株向日葵，所以占格判定要带上它。 */
function disguisedAt(sim: SimState, row: number, col: number): SimZombie | undefined {
  return sim.zombies.find(
    (z) => z.disguised && z.deadTimer === 0 && z.row === row && z.col === col,
  );
}

/**
 * 给伪装向日葵挑一个潜入格：优先贴着真向日葵（藏在同类里最不容易被数出来），
 * 否则取该行前六列里最靠右的空格。没有空格返回 null。
 */
function mimicTile(sim: SimState, row: number): number | null {
  const free: number[] = [];
  for (let col = 0; col <= MIMIC.maxCol; col++) {
    if (sim.plants.some((p) => p.row === row && p.col === col)) continue;
    if (disguisedAt(sim, row, col)) continue;
    free.push(col);
  }
  if (!free.length) return null;
  const beside = free.filter((col) =>
    sim.plants.some((p) => p.kind === "sunflower"
      && ((p.row === row && Math.abs(p.col - col) === 1)
        || (p.col === col && Math.abs(p.row - row) === 1))),
  );
  const pool = beside.length ? beside : free;
  return pool[pool.length - 1]!;
}

function inRow(row: number): boolean {
  return Number.isInteger(row) && row >= 0 && row < ROWS;
}
function inCol(col: number): boolean {
  return Number.isInteger(col) && col >= 0 && col < COLS;
}

/**
 * 这只僵尸能不能被「主动锁定」类攻击选中。
 *
 * 影袭在影幕里躲得过普通豌豆，但寒冰能看穿它；伪装体在拟态期间谁都锁不住，
 * 只有铲子和范围伤害能碰到它。范围伤害不走这里——它们不锁定目标，直接按坐标算。
 */
function targetable(zombie: SimZombie, piercesCloak: boolean): boolean {
  if (zombie.disguised) return false;
  if (zombie.cloaked && !piercesCloak) return false;
  return true;
}

function spawnPlant(sim: SimState, kind: PlantKind, row: number, col: number): void {
  const stats = CARD_STATS.get(kind)!;
  const x = cellCenterX(col);
  const y = laneY(row);
  sim.plants.push({
    id: sim.nextId++, kind, row, col, x, y,
    hp: stats.hp, maxHp: stats.hp,
    state: kind === "potatomine" ? "buried" : "idle",
    timer: 0, attackTimer: 0.25, armed: false, rising: false, triggered: false,
    shieldsBroken: 0, coreLockTimer: 0, hookedCount: 0,
  });
  burst(sim, x, y, "#b7ef68", 34);
  semantic(sim, {
    kind: "plant", x, y, row, sourceId: sim.nextId - 1, sourceKind: kind,
  });
}

function spawnZombie(sim: SimState, kind: ZombieKind, row: number): void {
  const stats = CARD_STATS.get(kind)!;
  // 伪装向日葵不从右侧人行道走进来，直接钻到植物阵地里的空格上。
  const mimicCol = kind === "mimicsunflower" ? mimicTile(sim, row) : null;
  const x = mimicCol === null ? SPAWN_X : cellCenterX(mimicCol);
  sim.zombies.push({
    id: sim.nextId++, kind, row, x, y: laneY(row),
    hp: stats.hp, maxHp: stats.hp, state: mimicCol === null ? "move" : "burrow",
    attackTimer: 0.2, slowTimer: 0,
    jumped: false, jumpTimer: 0, jumpDuration: 0, jumpStartX: x, jumpEndX: x,
    impThrown: false, impReleased: false, armorLost: false, throwTimer: 0,
    airTimer: 0, airDuration: 0, airStartX: x, airEndX: x, landTimer: 0,
    deadTimer: 0, impHidden: false,
    summonCount: 0, summonTimer: 0, summoned: true, laughTimer: 0,
    ...idleAbilities(),
    cloaked: kind === "shadowstrike",
    // 钟馗入场先走一段才抬钩，别一落地就锁植物。
    hookTimer: kind === "zhongkui" ? ZHONGKUI.firstHookDelay : 0,
    disguised: mimicCol !== null,
    col: mimicCol ?? -1,
    burrowTimer: mimicCol === null ? 0 : MIMIC.burrow,
  });
  // 伪装体是钻地进来的，不放右侧入场的尘土；它的登场提示只走 semantic 事件，
  // 这样协议层能按观战方把它改写成「种下一株向日葵」，不泄露真身。
  if (mimicCol === null) burst(sim, x, laneY(row), "#bda98e", 30);
  semantic(sim, {
    kind: "spawn", x, y: laneY(row), row,
    sourceId: sim.nextId - 1, sourceKind: kind,
  });
}

/** 固定步长推进一 tick。dt 恒为 0.1（服务器与本地累加器都保证这一点）。 */
export function step(sim: SimState, dt: number): void {
  if (sim.phase !== "playing") return;
  sim.tick++;

  sim.remaining -= dt;
  if (sim.remaining <= 0) {
    sim.remaining = 0;
    end(sim, "plants", "timeout");
    return;
  }

  sim.sunIncome += dt;
  sim.brainIncome += dt;
  if (sim.sunIncome >= SUN_INTERVAL) {
    sim.sunIncome -= SUN_INTERVAL;
    sim.sun = Math.min(RESOURCE_CAP, sim.sun + INCOME_STEP);
  }
  if (sim.brainIncome >= BRAIN_INTERVAL) {
    sim.brainIncome -= BRAIN_INTERVAL;
    sim.brains = Math.min(RESOURCE_CAP, sim.brains + INCOME_STEP);
  }
  for (const kind of Object.keys(sim.cooldowns)) {
    sim.cooldowns[kind] = Math.max(0, (sim.cooldowns[kind] ?? 0) - dt);
  }

  updatePlants(sim, dt);
  updateCaltrops(sim, dt);
  updateZombies(sim, dt);
  if (sim.phase !== "playing") return;   // 割草机用尽后僵尸破门可能已结束对局
  updateProjectiles(sim, dt);
  updateMowers(sim, dt);
}

/** 竹钉：踩上来的第一只僵尸吃一次伤害并被定住，然后这组钉子就用完了。 */
function updateCaltrops(sim: SimState, dt: number): void {
  const alive: SimCaltrop[] = [];
  for (const spike of sim.caltrops) {
    spike.timer -= dt;
    if (spike.timer <= 0) continue;

    const victim = sim.zombies.find(
      (z) => z.deadTimer === 0 && z.airTimer === 0 && z.row === spike.row
        && !z.disguised && Math.abs(z.x - spike.x) < CELL_W / 2,
    );
    if (!victim) {
      alive.push(spike);
      continue;
    }
    const rootFactor = victim.kind === "gargantuar" ? BAMBOO.caltropBossRootFactor : 1;
    victim.stunTimer = Math.max(victim.stunTimer, BAMBOO.caltropRoot * rootFactor);
    damageZombie(sim, victim, BAMBOO.caltropDamage);
    semantic(sim, {
      kind: "impact", x: spike.x, y: spike.y - 12, row: spike.row,
      targetId: victim.id, targetKind: victim.kind, color: "#dcc98a", size: 56,
    });
  }
  sim.caltrops = alive;
}

function updatePlants(sim: SimState, dt: number): void {
  const removed = new Set<number>();
  for (const plant of sim.plants) {
    plant.timer += dt;
    plant.attackTimer -= dt;

    if (plant.kind === "sunflower" && plant.timer >= 9) {
      // 第一份阳光较快产出，之后按原版约 24 秒一个周期。
      plant.timer -= 24;
      sim.sun = Math.min(RESOURCE_CAP, sim.sun + 50);
      sim.events.push({ kind: "sun", x: plant.x, y: plant.y - 55 });
    }

    if (plant.kind === "shieldbamboo") {
      plant.coreLockTimer = Math.max(0, plant.coreLockTimer - dt);
      // 形态由 shieldsBroken 决定，state 只区分「有盾待机」和「锁芯死守」。
      plant.state = plant.coreLockTimer > 0 ? "corelock" : "idle";
    }

    if (plant.kind === "peashooter" || plant.kind === "snowpea") {
      // 寒冰能看穿影幕（并且命中即破隐），普通豌豆不行。
      const target = sim.zombies.find(
        (z) => z.deadTimer === 0 && z.row === plant.row && z.x > plant.x - 10
          && targetable(z, plant.kind === "snowpea"),
      );
      plant.state = target ? "attack" : "idle";
      if (target && plant.attackTimer <= 0) {
        const stats = CARD_STATS.get(plant.kind)!;
        plant.attackTimer = stats.attackEvery!;
        sim.projectiles.push({
          id: sim.nextId++, row: plant.row, x: plant.x + 33, lastX: plant.x + 33,
          y: plant.y - 38, damage: stats.damage!, frozen: plant.kind === "snowpea",
          dir: 1, look: plant.kind === "snowpea" ? "snow" : "pea",
        });
        shootEvent(sim, plant, plant.kind === "snowpea" ? "snow" : "pea", plant.x + 33, plant.y - 38);
      }
    }

    if (plant.kind === "threepeater") {
      // 只要自己这行或相邻行有僵尸就开火，一次三路齐射。
      const rows = [plant.row - 1, plant.row, plant.row + 1].filter(inRow);
      const target = sim.zombies.find(
        (z) => z.deadTimer === 0 && rows.includes(z.row) && z.x > plant.x - 10
          && targetable(z, false),
      );
      plant.state = target ? "attack" : "idle";
      if (target && plant.attackTimer <= 0) {
        const stats = CARD_STATS.get("threepeater")!;
        plant.attackTimer = stats.attackEvery!;
        for (const row of rows) {
          sim.projectiles.push({
            id: sim.nextId++, row, x: plant.x + 33, lastX: plant.x + 33,
            // 斜射的两发从头顶发出，落到目标行的高度上。
            y: laneY(row) - 38, damage: stats.damage!, frozen: false,
            dir: 1, look: "pea",
          });
        }
        shootEvent(sim, plant, "pea", plant.x + 33, plant.y - 38);
      }
    }

    if (plant.kind === "squash") {
      // 窝瓜等最近的僵尸靠到跟前，跳起来砸下去，砸完自己也没了。
      if (!plant.triggered) {
        // 窝瓜的近距离感知能发现影袭（隐身挡不住它），但发现不了装成植物的伪装体。
        const victim = sim.zombies.find(
          (z) => z.deadTimer === 0 && z.row === plant.row
            && z.x > plant.x - 20 && z.x - plant.x < 75
            && targetable(z, true),
        );
        if (victim) {
          plant.triggered = true;
          plant.timer = 0;
          plant.state = "jump";
        }
      } else if (plant.timer >= 0.7 && plant.state === "jump") {
        plant.state = "smash";
        // 砸击范围要盖住起跳那一刻的触发距离——僵尸在滞空这 0.7 秒里还在往前走。
        for (const z of sim.zombies) {
          if (z.deadTimer === 0 && z.row === plant.row && Math.abs(z.x - plant.x) < 90) {
            damageZombie(sim, z, CARD_STATS.get("squash")!.damage!, "flatten");
            semantic(sim, {
              kind: "flatten", x: z.x, y: z.y, row: z.row,
              sourceId: plant.id, sourceKind: plant.kind, targetId: z.id, targetKind: z.kind,
              effect: "squash",
              fatal: z.deadTimer > 0,
            });
          }
        }
        semantic(sim, {
          kind: "impact", x: plant.x, y: plant.y - 20, row: plant.row,
          sourceId: plant.id, sourceKind: plant.kind, color: "#c9e08d", size: 90, effect: "squash",
        });
      } else if (plant.timer >= 1.3) {
        removed.add(plant.id);
      }
    }

    if (plant.kind === "potatomine") {
      // 原版约 14 秒准备：先埋地，最后 1 秒钻出，之后武装。
      if (!plant.rising && plant.timer >= 13) {
        plant.rising = true;
        plant.state = "rise";
      }
      if (!plant.armed && plant.timer >= 14) {
        plant.armed = true;
        plant.state = "idle";
        burst(sim, plant.x, plant.y - 12, "#ffdb61", 36);
      }
      const victim = plant.armed && sim.zombies.find(
        (z) => z.deadTimer === 0
          && z.row === plant.row
          && Math.abs(z.x - plant.x) < 58
          // 地雷是踩发的，隐身踩上去照样炸；但伪装体一直站着不动，不算踩雷。
          && targetable(z, true)
          // 有杆时先越过第一株植物；不能让地雷在起跳判定前抢先爆炸。
          && !(z.kind === "polevaulter" && (!z.jumped || z.jumpTimer > 0)),
      );
      if (victim) {
        for (const z of sim.zombies) {
          if (z.deadTimer === 0 && z.row === plant.row && Math.abs(z.x - plant.x) < 62) {
            damageZombie(sim, z, CARD_STATS.get("potatomine")!.damage!, "normal");
          }
        }
        removed.add(plant.id);
        burst(sim, plant.x, plant.y - 35, "#ff9d38", 100);
      }
    }

    if (plant.kind === "cherrybomb" && plant.timer >= 0.75 && !plant.triggered) {
      plant.triggered = true;
      plant.state = "explode";
      for (const z of sim.zombies) {
        if (z.deadTimer === 0 && Math.abs(z.row - plant.row) <= 1 && Math.abs(z.x - plant.x) < 150) {
          damageZombie(sim, z, CARD_STATS.get("cherrybomb")!.damage!, "burn");
          semantic(sim, {
            kind: "burn", x: z.x, y: z.y, row: z.row, sourceId: plant.id, sourceKind: plant.kind,
            targetId: z.id, targetKind: z.kind, effect: "cherry", fatal: z.deadTimer > 0,
          });
        }
      }
      semantic(sim, {
        kind: "explode", x: plant.x, y: plant.y - 55, row: plant.row,
        sourceId: plant.id, sourceKind: plant.kind, color: "#ff563f", size: 155, effect: "cherry",
      });
    }
    if (plant.kind === "jalapeno" && plant.timer >= 0.75 && !plant.triggered) {
      plant.triggered = true;
      plant.state = "explode";
      // 辣椒烧穿整整一行，不管离得多远。
      for (const z of sim.zombies) {
        if (z.deadTimer === 0 && z.row === plant.row) {
          damageZombie(sim, z, CARD_STATS.get("jalapeno")!.damage!, "burn");
          semantic(sim, {
            kind: "burn", x: z.x, y: z.y, row: z.row, sourceId: plant.id, sourceKind: plant.kind,
            targetId: z.id, targetKind: z.kind, effect: "jalapeno",
            delay: Math.abs(z.x - plant.x) / 700,
            fatal: z.deadTimer > 0,
          });
        }
      }
      semantic(sim, {
        kind: "explode", x: plant.x, y: plant.y - 55, row: plant.row,
        sourceId: plant.id, sourceKind: plant.kind, color: "#ff7a1f", size: 420, effect: "jalapeno",
      });
    }
    if (plant.kind === "jalapeno" && plant.triggered && plant.timer >= 1.55) removed.add(plant.id);

    // 给爆炸动画留出绘制时间，不能在切换状态的同一帧就删掉。
    if (plant.kind === "cherrybomb" && plant.triggered && plant.timer >= 1.55) removed.add(plant.id);
  }
  sim.plants = sim.plants.filter((p) => !removed.has(p.id) && p.hp > 0);
}

function updateZombies(sim: SimState, dt: number): void {
  for (const zombie of sim.zombies) {
    if (zombie.deadTimer > 0) {
      zombie.deadTimer += dt;
      continue;
    }
    const slowed = zombie.slowTimer > 0;
    zombie.slowTimer = Math.max(0, zombie.slowTimer - dt);
    // 寒冰同时降低移动速度和啃食频率。
    zombie.attackTimer -= dt * (slowed ? 0.5 : 1);
    const stats = CARD_STATS.get(zombie.kind)!;

    // 伪装向日葵：装成植物蹲着偷阳光，偷够了或者被拖太久就现形。
    if (zombie.disguised) {
      if (zombie.burrowTimer > 0) {
        zombie.burrowTimer = Math.max(0, zombie.burrowTimer - dt);
        if (zombie.burrowTimer === 0) zombie.state = "disguise";
        continue;
      }
      zombie.state = "disguise";
      zombie.disguiseAge += dt;
      zombie.stealTimer -= dt;
      if (zombie.stealTimer <= 0) {
        zombie.stealTimer += MIMIC.stealInterval;
        // 只偷得到实际存在的阳光，不会把资源栏偷成负数。
        const taken = Math.min(MIMIC.stealAmount, sim.sun);
        sim.sun -= taken;
        zombie.stolenSun += taken;
        // 生产动作照放，但光团在花盘里收缩消失——这是唯一的视觉破绽。
        sim.events.push({ kind: "sun", x: zombie.x, y: zombie.y - 55, color: "#6b5a2a" });
      }
      if (zombie.stolenSun >= MIMIC.revealAt || zombie.disguiseAge >= MIMIC.maxDisguise) {
        reveal(sim, zombie);
      }
      continue;
    }

    // 被震退或钉住：站在原地，既走不动也啃不动。
    if (zombie.stunTimer > 0) {
      zombie.stunTimer = Math.max(0, zombie.stunTimer - dt);
      zombie.state = "move";
      continue;
    }

    // 钟馗抬钩：前摇走完才结算位移。
    //
    // 设计稿写「前摇期间被冻结则取消」，但这套模拟里寒冰只有一个 slowTimer，
    // 而寒冰射手 1.5 秒一发、前摇只有 1.2 秒——照字面实现的话，同行只要有一株
    // 寒冰射手，钟馗就永远抬不起钩，连设计稿自己写的「钩到寒冰射手会被冻住」
    // 都触发不了。所以这里不因减速取消：减速本身已经让它移动和啃食都减半。
    // 前摇期间死亡自然会被上面的 deadTimer 分支挡掉，目标失效则在结算时作废。
    if (zombie.kind === "zhongkui" && zombie.hookWindup > 0) {
      zombie.hookWindup = Math.max(0, zombie.hookWindup - dt);
      zombie.state = "hook";
      if (zombie.hookWindup === 0) resolveHook(sim, zombie);
      continue;
    }

    // 巨人投出的小鬼先在空中飞行，再播放一次落地动作。
    if (zombie.airTimer > 0) {
      zombie.airTimer = Math.max(0, zombie.airTimer - dt);
      const progress = 1 - zombie.airTimer / zombie.airDuration;
      zombie.x = zombie.airStartX + (zombie.airEndX - zombie.airStartX) * progress;
      if (zombie.airTimer === 0) {
        zombie.landTimer = 0.5;
        zombie.state = "land";
      }
      continue;
    }
    if (zombie.landTimer > 0) {
      zombie.landTimer = Math.max(0, zombie.landTimer - dt);
      if (zombie.landTimer === 0) zombie.state = "move";
      continue;
    }

    // 巨人降到半血后只投一次小鬼；完整 throw 动画约 2.8 秒。
    if (zombie.kind === "gargantuar" && zombie.throwTimer > 0) {
      zombie.throwTimer = Math.max(0, zombie.throwTimer - dt);
      if (!zombie.impReleased && zombie.throwTimer <= 1.4) {
        zombie.impReleased = true;
        zombie.impHidden = true;
        spawnImp(sim, zombie);
      }
      if (zombie.throwTimer === 0) zombie.state = "move";
      continue;
    }

    // 舞王正在举手召唤：站定播完动作，动作过半时伴舞落位。
    if (zombie.kind === "dancer" && zombie.summonTimer > 0) {
      zombie.summonTimer = Math.max(0, zombie.summonTimer - dt);
      if (!zombie.summoned && zombie.summonTimer <= 1) {
        zombie.summoned = true;
        spawnBackupDancers(sim, zombie);
      }
      if (zombie.summonTimer === 0) zombie.state = "move";
      continue;
    }
    // 踏上草坪时召唤一次，推进到中场再召唤一次，最多两次。
    if (zombie.kind === "dancer" && zombie.summonCount < 2
        && zombie.x <= SUMMON_AT[zombie.summonCount]!) {
      zombie.summonCount++;
      zombie.summoned = false;
      zombie.summonTimer = 24 / 12;
      zombie.state = "summon";
      continue;
    }

    const target = closestPlant(sim, zombie);

    // 钟馗每 11 秒抬一次钩。啃食时不计时——正在咬东西就不腾手甩钩。
    if (zombie.kind === "zhongkui") {
      const eating = target !== undefined && zombie.x - target.x <= 48;
      if (!eating) {
        zombie.hookTimer = Math.max(0, zombie.hookTimer - dt);
        if (zombie.hookTimer === 0) {
          const prey = hookTarget(sim, zombie);
          if (prey) {
            zombie.hookTimer = ZHONGKUI.interval;
            zombie.hookWindup = ZHONGKUI.windup;
            zombie.hookTargetId = prey.id;
            zombie.state = "hook";
            // 目标格亮起暗红锁圈，给植物方 1.2 秒反应时间。
            semantic(sim, {
              kind: "impact", x: prey.x, y: prey.y - 30, row: prey.row,
              sourceId: zombie.id, sourceKind: zombie.kind, targetId: prey.id, targetKind: prey.kind,
              color: "#c0392b", size: 60,
            });
            continue;
          }
        }
      }
    }

    // 高坚果太高，撑杆僵尸跳不过去，只能老老实实啃。
    // 机关盾竹还有护盾时也是一样的高型障碍；破到只剩竹芯就矮下去，可以跳过。
    const tooTall = target?.kind === "tallnut"
      || (target?.kind === "shieldbamboo" && target.shieldsBroken < 3);
    if (zombie.kind === "polevaulter" && !zombie.jumped && target
        && zombie.x > target.x && zombie.x - target.x < 110 && !tooTall) {
      zombie.jumped = true;
      zombie.jumpDuration = 43 / 12; // anim_jump 共 43 帧，按素材 12fps 完整播放
      zombie.jumpTimer = zombie.jumpDuration;
      zombie.jumpStartX = zombie.x;
      zombie.jumpEndX = target.x - 60;
      zombie.state = "jump";
    }
    if (zombie.jumpTimer > 0) {
      zombie.jumpTimer = Math.max(0, zombie.jumpTimer - dt);
      const progress = 1 - zombie.jumpTimer / zombie.jumpDuration;
      zombie.x = zombie.jumpStartX + (zombie.jumpEndX - zombie.jumpStartX) * progress;
      if (zombie.jumpTimer === 0) {
        zombie.x = zombie.jumpEndX;
        zombie.state = "moveAfterJump";
      }
      continue;
    }

    if (zombie.kind === "nailong") {
      // 奶龙是远程单位：站在射程外大笑发光波，不近身啃植物。
      if (target && zombie.x - target.x <= stats.range!) {
        zombie.state = "laugh";
        if (zombie.attackTimer <= 0) {
          zombie.attackTimer = stats.attackEvery!;
          const muzzleX = zombie.x - 26;
          const muzzleY = zombie.y - 62;
          sim.projectiles.push({
            id: sim.nextId++, row: zombie.row, x: muzzleX, lastX: muzzleX,
            y: muzzleY, damage: stats.damage!, frozen: false, dir: -1, look: "wave",
          });
          shootEvent(sim, zombie, "wave", muzzleX, muzzleY);
          burst(sim, muzzleX, muzzleY, "#ffe680", 26);
        }
      } else {
        zombie.state = "move";
        zombie.x -= stats.speed! * (slowed ? 0.5 : 1) * dt;
      }
    } else if (target && zombie.x - target.x <= 48) {
      zombie.state = zombie.kind === "gargantuar" ? "smash"
        : zombie.kind === "newspaper" && zombie.armorLost ? "rageEat"
        : "eat";
      if (zombie.attackTimer <= 0) {
        zombie.attackTimer = stats.attackEvery!;
        // 巨人的锤击直接摧毁普通植物；已武装土豆雷会在这里之前触发。
        if (zombie.kind === "gargantuar") {
          damagePlant(sim, target, 0, true);
          semantic(sim, {
            kind: "flatten", x: target.x, y: target.y, row: target.row,
            sourceId: zombie.id, sourceKind: zombie.kind, targetId: target.id, targetKind: target.kind,
            effect: "gargantuar",
          });
          semantic(sim, {
            kind: "impact", x: target.x, y: target.y - 20, row: target.row,
            sourceId: zombie.id, sourceKind: zombie.kind, targetId: target.id, targetKind: target.kind,
            color: "#e8d083", size: 105, effect: "gargantuar",
          });
        } else {
          // 影袭在隐身状态下的第一口是伏击加成，咬完立刻显形。
          const ambush = zombie.kind === "shadowstrike" && zombie.cloaked;
          damagePlant(sim, target, ambush ? SHADOWSTRIKE.ambushDamage : stats.damage!);
          if (ambush) reveal(sim, zombie);
          semantic(sim, {
            kind: "hit", x: target.x, y: target.y - 50, row: target.row,
            sourceId: zombie.id, sourceKind: zombie.kind, targetId: target.id, targetKind: target.kind,
            color: ambush ? "#7fe8de" : "#e8d083", size: ambush ? 30 : 18, effect: "normal",
          });
        }
      }
    } else {
      zombie.state = zombie.kind === "polevaulter" && zombie.jumped ? "moveAfterJump"
        : zombie.kind === "newspaper" && zombie.armorLost ? "rage"
        : zombie.kind === "shadowstrike" && zombie.cloaked ? "cloak"
        : "move";
      const speed = zombie.kind === "polevaulter" && zombie.jumped ? 19
        : zombie.kind === "newspaper" && zombie.armorLost ? NEWSPAPER_RAGE_SPEED
        // 影袭在影幕里走得快，显形后放慢——潜行是它唯一的接近手段。
        : zombie.kind === "shadowstrike"
          ? (zombie.cloaked ? SHADOWSTRIKE.cloakedSpeed : SHADOWSTRIKE.revealedSpeed)
        : stats.speed!;
      zombie.x -= speed * (slowed ? 0.5 : 1) * dt;
    }

    if (zombie.x < GRID_X - 32) {
      const mower = sim.mowers[zombie.row];
      if (mower?.state === "idle") {
        mower.state = "active";
        damageZombie(sim, zombie, 99999);
        sim.events.push({ kind: "mower", x: mower.x, y: laneY(zombie.row), row: zombie.row });
      } else if (!mower || mower.state === "spent") {
        end(sim, "zombies", "breach");
        return;
      }
    }
  }
  sim.zombies = sim.zombies.filter((z) => z.deadTimer === 0 || z.deadTimer < 1.5);
}

/**
 * 新机制字段的默认值（都是「没在用」的状态）。
 * 三处 spawn 都要带上，抽出来免得漏一个字段就编译不过。
 */
function idleAbilities() {
  return {
    cloaked: false,
    stunTimer: 0,
    hookTimer: 0,
    hookWindup: 0,
    hookTargetId: 0,
    disguised: false,
    col: -1,
    burrowTimer: 0,
    stealTimer: MIMIC.stealInterval,
    stolenSun: 0,
    disguiseAge: 0,
  };
}

function spawnImp(sim: SimState, gargantuar: SimZombie): void {
  const stats = IMP_STATS;
  const startX = gargantuar.x - 10;
  const endX = Math.max(GRID_X + CELL_W * 2.5, gargantuar.x - CELL_W * 3.5);
  const duration = 16 / 12;
  sim.zombies.push({
    id: sim.nextId++, kind: "imp", row: gargantuar.row, x: startX, y: laneY(gargantuar.row),
    hp: stats.hp, maxHp: stats.hp, state: "thrown",
    attackTimer: 0.3, slowTimer: 0,
    jumped: false, jumpTimer: 0, jumpDuration: 0, jumpStartX: startX, jumpEndX: endX,
    impThrown: true, impReleased: true, armorLost: false, throwTimer: 0,
    airTimer: duration, airDuration: duration, airStartX: startX, airEndX: endX, landTimer: 0,
    deadTimer: 0, impHidden: false,
    summonCount: 0, summonTimer: 0, summoned: true, laughTimer: 0,
    ...idleAbilities(),
  });
  burst(sim, startX, laneY(gargantuar.row) - 105, "#b9a28b", 34);
}

/**
 * 舞王召唤伴舞：在自己所在行的上下两行、身前一点的位置各起一个。
 * 行不存在（在边缘）就跳过那一侧，不会把伴舞塞出草坪。
 */
function spawnBackupDancers(sim: SimState, dancer: SimZombie): void {
  const stats = BACKUP_DANCER_STATS;
  for (const offset of [-1, 1]) {
    const row = dancer.row + offset;
    if (!inRow(row)) continue;
    const x = Math.min(SPAWN_X, dancer.x + 30);
    sim.zombies.push({
      id: sim.nextId++, kind: "backupdancer", row, x, y: laneY(row),
      hp: stats.hp, maxHp: stats.hp, state: "move",
      attackTimer: 0.3, slowTimer: 0,
      jumped: false, jumpTimer: 0, jumpDuration: 0, jumpStartX: x, jumpEndX: x,
      impThrown: false, impReleased: false, armorLost: false, throwTimer: 0,
      airTimer: 0, airDuration: 0, airStartX: x, airEndX: x, landTimer: 0,
      deadTimer: 0, impHidden: false,
      summonCount: 0, summonTimer: 0, summoned: true, laughTimer: 0,
      ...idleAbilities(),
    });
    burst(sim, x, laneY(row) - 40, "#ff7ad9", 40);
  }
}

/**
 * 挑一个可以钩的植物：前方三格内、离钟馗最近、且右边一格是空的。
 *
 * 右边必须空着才能拖过来——不然没地方放。这也给了植物方一个应对手段：
 * 把关键植物后面塞满，钟馗就钩不动它。
 */
function hookTarget(sim: SimState, zombie: SimZombie): SimPlant | undefined {
  let best: SimPlant | undefined;
  for (const plant of sim.plants) {
    if (plant.row !== zombie.row) continue;
    const distance = zombie.x - plant.x;
    if (distance <= 0 || distance > ZHONGKUI.range) continue;
    const landing = plant.col + 1;
    if (!inCol(landing)) continue;
    if (sim.plants.some((p) => p.row === plant.row && p.col === landing)) continue;
    if (disguisedAt(sim, plant.row, landing)) continue;
    if (!best || plant.x > best.x) best = plant;
  }
  return best;
}

/**
 * 前摇结束，结算这一钩。
 *
 * 坚果类（含机关盾竹）第一次被钩会崩掉铁链，白耗掉钟馗一个周期；第二次才拖得动。
 * 拖过来的伏击植物会立刻反过来收拾钟馗——这就是「钩错了」。
 */
function resolveHook(sim: SimState, zombie: SimZombie): void {
  const prey = sim.plants.find((p) => p.id === zombie.hookTargetId);
  zombie.hookTargetId = 0;
  zombie.state = "move";
  if (!prey || prey.hp <= 0) return;

  // 目标可能在这 1.2 秒里被种了东西堵住落点，那这一钩也白费。
  const landing = prey.col + 1;
  if (!inCol(landing)
      || sim.plants.some((p) => p.row === prey.row && p.col === landing)
      || disguisedAt(sim, prey.row, landing)) {
    return;
  }

  const warded = prey.kind === "wallnut" || prey.kind === "tallnut" || prey.kind === "shieldbamboo";
  if (warded && prey.hookedCount === 0) {
    prey.hookedCount++;
    // 铁链崩出金色火花，植物原地不动。
    semantic(sim, {
      kind: "impact", x: prey.x, y: prey.y - 30, row: prey.row,
      sourceId: zombie.id, sourceKind: zombie.kind, targetId: prey.id, targetKind: prey.kind,
      color: "#ffd94a", size: 52,
    });
    return;
  }

  prey.hookedCount++;
  prey.col = landing;
  prey.x = cellCenterX(landing);
  burst(sim, prey.x, prey.y - 30, "#c0392b", 46);
  semantic(sim, {
    kind: "impact", x: prey.x, y: prey.y - 30, row: prey.row,
    sourceId: zombie.id, sourceKind: zombie.kind, targetId: prey.id, targetKind: prey.kind,
    color: "#8e6b4a", size: 44,
  });

  // 钩错了：伏击和控制类植物被拖到跟前，反过来让钟馗付代价。
  if (prey.kind === "squash") {
    // 倭瓜在落点直接处决钟馗。不能指望它平时那套「近处有僵尸才起跳」的判定——
    // 钟馗是从三格外甩钩的，砸击范围根本够不到，得点对点结算。
    damageZombie(sim, zombie, ZHONGKUI.backfireDamage, "flatten");
    semantic(sim, {
      kind: "flatten", x: zombie.x, y: zombie.y, row: zombie.row,
      sourceId: prey.id, sourceKind: prey.kind, targetId: zombie.id, targetKind: zombie.kind,
      effect: "squash", fatal: zombie.deadTimer > 0,
    });
    semantic(sim, {
      kind: "impact", x: zombie.x, y: zombie.y - 20, row: zombie.row,
      sourceId: prey.id, sourceKind: prey.kind, color: "#c9e08d", size: 90, effect: "squash",
    });
    prey.hp = 0;
  } else if (prey.kind === "potatomine") {
    // 土豆雷不管原来武装没武装，落点接触就炸。
    prey.armed = true;
    damageZombie(sim, zombie, ZHONGKUI.backfireDamage);
    for (const z of sim.zombies) {
      if (z.deadTimer === 0 && z.row === prey.row && Math.abs(z.x - prey.x) < 62) {
        damageZombie(sim, z, ZHONGKUI.backfireDamage);
      }
    }
    prey.hp = 0;
    burst(sim, prey.x, prey.y - 35, "#ff9d38", 100);
  } else if (prey.kind === "snowpea") {
    // 寒冰顺着铁链回传，冻住钟馗——位移仍然完成了。
    zombie.slowTimer = ZHONGKUI.snowFreeze;
    burst(sim, zombie.x, zombie.y - 50, "#8cecff", 54);
  }
}

function closestPlant(sim: SimState, zombie: SimZombie): SimPlant | undefined {
  let target: SimPlant | undefined;
  for (const plant of sim.plants) {
    if (plant.row !== zombie.row || plant.x > zombie.x + 12) continue;
    if (!target || plant.x > target.x) target = plant;
  }
  return target;
}

function updateProjectiles(sim: SimState, dt: number): void {
  const alive: SimProjectile[] = [];
  for (const shot of sim.projectiles) {
    shot.lastX = shot.x;
    shot.x += PROJECTILE_SPEED * shot.dir * dt;

    if (shot.dir === -1) {
      // 奶龙光波向左飞，打中同行最靠右的那株植物。
      let victim: SimPlant | undefined;
      for (const plant of sim.plants) {
        if (plant.row !== shot.row) continue;
        if (plant.x <= shot.lastX + 15 && plant.x >= shot.x - 20) {
          if (!victim || plant.x > victim.x) victim = plant;
        }
      }
      if (victim) {
        damagePlant(sim, victim, shot.damage);
        semantic(sim, {
          kind: "hit", x: victim.x, y: victim.y - 40, row: victim.row,
          targetId: victim.id, targetKind: victim.kind, look: "wave", color: "#ffe680", size: 20,
          effect: "wave",
        });
      } else if (shot.x > GRID_X - 60) {
        alive.push(shot);
      }
      continue;
    }

    let hit: SimZombie | undefined;
    for (const zombie of sim.zombies) {
      if (zombie.deadTimer > 0 || zombie.airTimer > 0 || zombie.row !== shot.row) continue;
      // 豌豆穿过影袭；寒冰豆能命中它并当场破隐。
      if (!targetable(zombie, shot.frozen)) continue;
      if (zombie.x >= shot.lastX - 15 && zombie.x <= shot.x + 20) {
        if (!hit || zombie.x < hit.x) hit = zombie;
      }
    }
    if (hit) {
      damageZombie(sim, hit, shot.damage);
      if (shot.frozen) hit.slowTimer = 10;
      semantic(sim, {
        kind: "hit", x: hit.x, y: hit.y - 74, row: hit.row,
        targetId: hit.id, targetKind: hit.kind, look: shot.look,
        color: shot.frozen ? "#8cecff" : "#83c84a", size: 14, effect: "normal",
      });
    } else if (shot.x < 1430) {
      alive.push(shot);
    }
  }
  sim.projectiles = alive;
}

/**
 * 对植物结算一次伤害。所有伤害来源都必须走这里，机关盾竹的三段护盾才不会被绕过。
 *
 * 机关盾竹的血是一条 7000 的总量，三个阈值把它切成三层护盾＋竹芯。每次伤害
 * 跨过一个阈值就破一层，触发对应的一次性效果；`shieldsBroken` 随快照下发，
 * 客户端据此换形态。锁芯（第三层）会给这一击加一个保底，让它至少留 800 竹芯血，
 * 这样巨人的第一锤打不死它——第二锤才行。
 */
function damagePlant(sim: SimState, plant: SimPlant, amount: number, lethal = false): void {
  if (plant.hp <= 0) return;

  if (plant.kind !== "shieldbamboo") {
    plant.hp = lethal ? 0 : plant.hp - amount;
    return;
  }

  // 锁芯期间的减伤。
  let incoming = plant.coreLockTimer > 0 ? amount * (1 - BAMBOO.coreLockReduction) : amount;
  // 巨锤这类「直接摧毁」的伤害，对还有护盾/锁芯的盾竹按当前层耐久结算，不是秒杀。
  if (lethal) incoming = plant.hp;

  const before = plant.hp;
  let after = before - incoming;

  const nextThreshold = BAMBOO.thresholds[plant.shieldsBroken];
  if (nextThreshold !== undefined && after <= nextThreshold) {
    plant.shieldsBroken++;
    if (plant.shieldsBroken === 3) {
      // 内甲·锁芯：触发这一击留下保底竹芯血，并进入减伤窗口。
      after = Math.max(after, BAMBOO.coreFloor);
      plant.coreLockTimer = BAMBOO.coreLockDuration;
      semantic(sim, {
        kind: "impact", x: plant.x, y: plant.y - 30, row: plant.row,
        sourceId: plant.id, sourceKind: plant.kind, color: "#e8503a", size: 74,
      });
    } else if (plant.shieldsBroken === 1) {
      bambooRepulse(sim, plant);
    } else {
      bambooCaltrop(sim, plant);
    }
  }

  plant.hp = after;
}

/** 外甲·震退：把前方最近的几只僵尸往右推一段，并打断它们的啃食。 */
function bambooRepulse(sim: SimState, plant: SimPlant): void {
  const inFront = sim.zombies
    .filter((z) => z.deadTimer === 0 && z.row === plant.row && z.airTimer === 0
      && z.x >= plant.x - 20 && z.x - plant.x <= BAMBOO.repulseRange)
    .sort((a, b) => a.x - b.x)
    .slice(0, BAMBOO.repulseCount);
  for (const zombie of inFront) {
    const factor = zombie.kind === "gargantuar" ? BAMBOO.repulseBossFactor : 1;
    zombie.x += BAMBOO.repulsePush * factor;
    zombie.stunTimer = Math.max(zombie.stunTimer, BAMBOO.repulseInterrupt);
    zombie.state = "move";
    burst(sim, zombie.x, zombie.y - 40, "#cfe9a0", 40);
  }
  semantic(sim, {
    kind: "impact", x: plant.x + 40, y: plant.y - 30, row: plant.row,
    sourceId: plant.id, sourceKind: plant.kind, color: "#b7ef68", size: 86,
  });
}

/** 中甲·落钉：正前方一格地面留一组竹钉，踩到的第一只僵尸被定住并吃伤害。 */
function bambooCaltrop(sim: SimState, plant: SimPlant): void {
  const col = plant.col + BAMBOO.caltropAhead;
  if (!inCol(col)) return;
  sim.caltrops.push({
    id: sim.nextId++, row: plant.row, col,
    x: cellCenterX(col), y: plant.y, timer: BAMBOO.caltropDuration,
  });
  burst(sim, cellCenterX(col), plant.y - 10, "#dcc98a", 44);
}

/**
 * 让隐藏中的僵尸现形。影袭的影幕和伪装体的拟态都在这里破掉。
 *
 * 伪装体现形后就是一只普通近战僵尸，从它潜伏的那个格子开始往左推进——那已经
 * 是植物阵地深处，所以它是个真威胁，不是白送。
 */
function reveal(sim: SimState, zombie: SimZombie): void {
  if (!zombie.cloaked && !zombie.disguised) return;
  const wasDisguised = zombie.disguised;
  zombie.cloaked = false;
  zombie.disguised = false;
  zombie.burrowTimer = 0;
  zombie.state = "move";
  semantic(sim, {
    kind: "armorBreak", x: zombie.x, y: zombie.y - 60, row: zombie.row,
    targetId: zombie.id, targetKind: zombie.kind,
    color: wasDisguised ? "#ffd94a" : "#7fe8de", size: 48,
  });
}

function damageZombie(sim: SimState, zombie: SimZombie, amount: number, deathEffect: "normal" | "flatten" | "burn" = "normal"): void {
  if (zombie.deadTimer > 0) return;
  // 范围伤害和寒冰都能打到隐身的影袭与潜伏的伪装体，打完就藏不住了。
  reveal(sim, zombie);
  zombie.hp -= amount;
  if (zombie.hp <= 0) {
    zombie.hp = 0;
    zombie.deadTimer = 0.001;
    zombie.state = "death";
    semantic(sim, {
      kind: "death", x: zombie.x, y: zombie.y, row: zombie.row,
      targetId: zombie.id, targetKind: zombie.kind,
      color: deathEffect === "burn" ? "#ff8b38" : "#806b55", size: 38,
      effect: deathEffect === "burn" ? "cherry" : deathEffect === "flatten" ? "squash" : "normal",
    });
  } else if (zombie.kind === "gargantuar" && zombie.hp <= zombie.maxHp / 2 && !zombie.impThrown) {
    zombie.impThrown = true;
    zombie.throwTimer = 34 / 12;
    zombie.state = "throw";
  } else if ((zombie.kind === "conehead" || zombie.kind === "buckethead"
              || zombie.kind === "screendoor")
             && zombie.hp <= ARMOR_BREAK_HP && !zombie.armorLost) {
    // 护具耐久耗尽后保留普通僵尸本体，并切回无护具外观。
    zombie.armorLost = true;
    semantic(sim, {
      kind: "armorBreak", x: zombie.x, y: zombie.y - 70, row: zombie.row,
      targetId: zombie.id, targetKind: zombie.kind, color: "#c8c1a8", size: 46,
    });
    zombie.kind = "zombie";
    zombie.state = "move";
  } else if (zombie.kind === "newspaper" && zombie.hp <= ARMOR_BREAK_HP && !zombie.armorLost) {
    // 报纸被打烂，读报僵尸暴走：换成无报外观并大幅加速。
    zombie.armorLost = true;
    zombie.state = "rage";
    semantic(sim, {
      kind: "armorBreak", x: zombie.x, y: zombie.y - 70, row: zombie.row,
      targetId: zombie.id, targetKind: zombie.kind, color: "#f2ead4", size: 44,
    });
  }
}

function updateMowers(sim: SimState, dt: number): void {
  for (const mower of sim.mowers) {
    if (mower.state !== "active") continue;
    mower.x += MOWER_SPEED * dt;
    for (const zombie of sim.zombies) {
      if (zombie.row === mower.row && zombie.deadTimer === 0 && zombie.airTimer === 0
          && Math.abs(zombie.x - mower.x) < 55) {
        damageZombie(sim, zombie, 99999);
      }
    }
    if (mower.x > 1480) mower.state = "spent";
  }
}

function end(sim: SimState, winner: Side, reason: string): void {
  sim.phase = "ended";
  sim.winner = winner;
  sim.endReason = reason;
}

/**
 * 僵尸的绘制 Y。巨人投出的小鬼在空中走一条正弦抛物线；把这段升高折进 Y，
 * 让服务器编码（联机）与浏览器本地渲染用同一条公式，两端画面一致。
 */
export function zombieDrawY(z: SimZombie): number {
  if (z.airTimer > 0 && z.airDuration > 0) {
    const progress = 1 - z.airTimer / z.airDuration;
    return z.y - Math.sin(progress * Math.PI) * 105;
  }
  return z.y;
}
