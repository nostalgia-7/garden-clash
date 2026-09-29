/**
 * 客户端 ↔ 服务器 消息协议，以及权威快照的紧凑编解码。
 *
 * 编解码放在共享模块里，服务器编码、客户端解码用的是同一张 kind/state 索引表，
 * 不会各写一套对不上。本轮先做「每 tick 全量快照」，正确性优先；delta 编码
 * 作为后续优化。
 */

import type { Side, UnitKind } from "./cards.ts";
import { laneY } from "./cards.ts";
import { type SimState, type SimEvent, zombieDrawY } from "./sim.ts";
import type { DraftPhase } from "./draft.ts";

export type NetSide = Side;
export type NetRole = NetSide | "spectator";

// ---- 上行：客户端 → 服务器 ----
export type Command =
  | { k: "plant"; row: number; col: number; kind: UnitKind }
  | { k: "zombie"; row: number; kind: UnitKind }
  | { k: "shovel"; row: number; col: number };

export type ClientMessage =
  | { type: "create"; preferred: NetRole }
  | { type: "join"; room: string; preferred: NetRole; reconnect?: string }
  | { type: "cmd"; seq: number; cmd: Command }
  | { type: "ban"; kind: UnitKind }
  | { type: "pick"; kinds: UnitKind[] }
  | { type: "rematch" }
  | { type: "surrender" }
  | { type: "pong" };

// ---- 快照。实体用数值元组压缩，kind/state 走索引表。 ----
/** 单位元组：[id, kindIdx, row, x, y, hp, maxHp, stateIdx, flags]。 */
export type UnitTuple = [number, number, number, number, number, number, number, number, number];
/** 投射物元组：[id, row, x, y, frozen, lookIdx, dir]。dir=1 向右（植物打僵尸），-1 向左（奶龙光波）。 */
export type ProjTuple = [number, number, number, number, 0 | 1, number, 1 | -1];
/** 割草机元组：[row, x, stateIdx]。 */
export type MowerTuple = [number, number, number];
/** 竹钉元组：[row, x]。y 由 row 推得，不用带。 */
export type CaltropTuple = [number, number];
/**
 * 钟馗钩锁元组：[zombieId, row, 钟馗 x, 目标 x, 目标 y]。
 * 铁链要横跨两个单位，光靠单位自己的局部坐标画不出来，所以把两端一起下发。
 */
export type HookTuple = [number, number, number, number, number];

export interface Snapshot {
  t: number;               // serverTick
  ack: number;             // 该玩家已处理到的命令 seq
  sun: number;
  brains: number;
  rem: number;             // 剩余秒（向上取整前的原始值）
  cd: [string, number][];  // 冷却（仅该玩家阵营相关，直接给全量也无妨）
  u: UnitTuple[];
  p: ProjTuple[];
  m: MowerTuple[];
  /** 机关盾竹落在地上的竹钉。 */
  c: CaltropTuple[];
  /** 正在抬钩的钟馗与它锁定的植物。 */
  hk: HookTuple[];
  ev: SimEvent[];          // 一次性粒子/音效事件，数量很少，直接原样带过去
  phase: "playing" | "ended";
  winner: NetSide | null;
}

export interface DraftView {
  phase: DraftPhase;
  deadline: number;
  /** 本阵营完整卡池；观战者为空。 */
  myPool: UnitKind[];
  /** 对手完整卡池，用于 Ban；观战者为空。 */
  opponentPool: UnitKind[];
  myBan: UnitKind | null;
  opponentBan: UnitKind | null;
  myPicks: UnitKind[];
  myReady: boolean;
  opponentReady: boolean;
  plantsReady: boolean;
  zombiesReady: boolean;
}

// ---- 下行：服务器 → 客户端 ----
export type ServerMessage =
  | { type: "welcome"; room: string; role: NetRole; reconnectToken: string }
  | { type: "room"; room: string; plants: boolean; zombies: boolean; spectator: boolean }
  | { type: "draft"; state: DraftView }
  | { type: "start"; at: number; matchId: string; plantsDeck: UnitKind[]; zombiesDeck: UnitKind[] }
  | { type: "snap"; s: Snapshot }
  | { type: "resume"; s: Snapshot; plantsDeck: UnitKind[]; zombiesDeck: UnitKind[] } // 重连恢复，同时恢复双方卡组
  | { type: "ended"; winner: NetSide | null; reason: string }
  | { type: "rematch"; plants: boolean; zombies: boolean }  // 谁已点了再来一局
  | { type: "ping" }
  | { type: "error"; message: string };

// ---- 索引表：整数 ↔ 字符串，两端共用，改动必须同步。 ----
export const KIND_INDEX: UnitKind[] = [
  "sunflower", "peashooter", "snowpea", "wallnut", "potatomine", "cherrybomb",
  "zombie", "conehead", "buckethead", "polevaulter", "football", "gargantuar", "imp",
  // V2 扩充卡池。只能往后追加，插到中间会让新旧客户端对不上号。
  "threepeater", "tallnut", "jalapeno", "squash",
  "screendoor", "newspaper", "dancer", "nailong", "backupdancer",
  "shieldbamboo", "shadowstrike", "zhongkui", "mimicsunflower",
];
const KIND_TO_IDX = new Map<UnitKind, number>(KIND_INDEX.map((k, i) => [k, i]));

export const STATE_INDEX: string[] = [
  "idle", "attack", "move", "eat", "jump", "moveAfterJump", "smash", "throw",
  "land", "thrown", "death", "buried", "rise", "explode", "normal",
  // V2 新增状态，同样只追加。
  "rage", "rageEat", "summon", "laugh",
  // 机关盾竹锁芯、影袭潜行、钟馗抬钩、伪装体钻地与拟态。
  "corelock", "cloak", "hook", "burrow", "disguise",
];
const STATE_TO_IDX = new Map<string, number>(STATE_INDEX.map((s, i) => [s, i]));

/** 投射物外观。pea/snow 是植物打出的豆子，wave 是奶龙的金色光波。 */
export const PROJECTILE_LOOK_INDEX = ["pea", "snow", "wave"] as const;
export type ProjectileLook = (typeof PROJECTILE_LOOK_INDEX)[number];

const MOWER_STATE_INDEX = ["idle", "active", "spent"] as const;

/** 单位标志位：bit0=frozen（减速中），bit1=dead（死亡动画中），bit2=impHidden。 */
const FLAG_FROZEN = 1;
const FLAG_DEAD = 2;
const FLAG_IMP_HIDDEN = 4;
/** bit3～4 存机关盾竹已破的护盾层数（0～3），客户端据此换形态。 */
const SHIELD_SHIFT = 3;

/** 伪装向日葵冒充的是一株刚种下的普通向日葵，血量按这个数报给植物方。 */
const SUNFLOWER_MAX_HP = 300;

/**
 * 把权威 SimState 编成一份发给客户端的快照。ack 由服务器按玩家填入。
 *
 * `viewer` 决定看不看得穿伪装向日葵：**植物方拿到的数据里它就是一株向日葵**
 * ——kind、血量、动画状态全都是向日葵的。这必须在服务端做掉，否则玩家扒一眼
 * 网络包就能识破伪装，这张卡也就没意义了。僵尸方和观战者看到真身。
 */
export function encodeSnapshot(sim: SimState, ack: number, viewer: NetRole = "spectator"): Snapshot {
  const hideMimic = viewer === "plants";
  const u: UnitTuple[] = [];
  for (const p of sim.plants) {
    // 机关盾竹的形态靠 flags 带过去，其它植物这几位恒为 0。
    const flags = p.kind === "shieldbamboo" ? p.shieldsBroken << SHIELD_SHIFT : 0;
    u.push([p.id, KIND_TO_IDX.get(p.kind)!, p.row, round(p.x), round(p.y),
            Math.ceil(p.hp), p.maxHp, STATE_TO_IDX.get(p.state) ?? 0, flags]);
  }
  for (const z of sim.zombies) {
    let flags = 0;
    if (z.slowTimer > 0) flags |= FLAG_FROZEN;
    if (z.deadTimer > 0) flags |= FLAG_DEAD;
    if (z.impHidden) flags |= FLAG_IMP_HIDDEN;

    if (z.disguised && hideMimic) {
      // 连血条都要装：按比例折算到向日葵的 300 血，免得满血 470 露馅。
      const faked = Math.ceil(z.hp / z.maxHp * SUNFLOWER_MAX_HP);
      u.push([z.id, KIND_TO_IDX.get("sunflower")!, z.row, round(z.x), round(laneY(z.row)),
              faked, SUNFLOWER_MAX_HP, STATE_TO_IDX.get("idle") ?? 0, flags]);
      continue;
    }
    u.push([z.id, KIND_TO_IDX.get(z.kind)!, z.row, round(z.x), round(zombieDrawY(z)),
            Math.ceil(z.hp), z.maxHp, STATE_TO_IDX.get(z.state) ?? 2, flags]);
  }
  const p: ProjTuple[] = sim.projectiles.map(
    (s) => [s.id, s.row, round(s.x), round(s.y), s.frozen ? 1 : 0,
            PROJECTILE_LOOK_INDEX.indexOf(s.look), s.dir],
  );
  const m: MowerTuple[] = sim.mowers.map(
    (mw) => [mw.row, round(mw.x), MOWER_STATE_INDEX.indexOf(mw.state)],
  );
  const c: CaltropTuple[] = sim.caltrops.map((k) => [k.row, round(k.x)]);
  // 抬钩中的钟馗：把它和目标植物的位置一起带上，客户端才画得出中间那条铁链。
  const hk: HookTuple[] = [];
  for (const z of sim.zombies) {
    if (z.kind !== "zhongkui" || z.hookWindup <= 0 || z.deadTimer > 0) continue;
    const prey = sim.plants.find((p) => p.id === z.hookTargetId);
    if (!prey) continue;
    hk.push([z.id, z.row, round(z.x), round(prey.x), round(prey.y)]);
  }
  const disguisedIds = hideMimic
    ? new Set(sim.zombies.filter((z) => z.disguised).map((z) => z.id))
    : null;
  return {
    t: sim.tick, ack,
    sun: Math.floor(sim.sun), brains: Math.floor(sim.brains), rem: sim.remaining,
    cd: Object.entries(sim.cooldowns).filter(([, v]) => v > 0).map(([k, v]) => [k, round1(v)]),
    u, p, m, c, hk,
    ev: sim.events.map((e) => maskEvent(e, disguisedIds)),
    phase: sim.phase, winner: sim.winner,
  };
}

/**
 * 事件里也不能露出伪装体。植物方看到的登场提示是「种下一株向日葵」，
 * 和真的种一株向日葵一模一样。
 */
function maskEvent(event: SimEvent, disguisedIds: Set<number> | null): SimEvent {
  if (!disguisedIds?.size) return { ...event };
  const masked = { ...event };
  if (masked.sourceId !== undefined && disguisedIds.has(masked.sourceId)) {
    if (masked.kind === "spawn") masked.kind = "plant";
    masked.sourceKind = "sunflower";
  }
  if (masked.targetId !== undefined && disguisedIds.has(masked.targetId)) {
    masked.targetKind = "sunflower";
  }
  return masked;
}

/** 客户端侧：把元组还原成好用的对象。 */
export interface DecodedUnit {
  id: number; kind: UnitKind; row: number; x: number; y: number;
  hp: number; maxHp: number; state: string;
  frozen: boolean; dead: boolean; impHidden: boolean;
  /** 机关盾竹已破的护盾层数（0～3），决定画哪个形态。 */
  shieldsBroken: number;
}
export interface DecodedProjectile {
  id: number; row: number; x: number; y: number; frozen: boolean;
  look: ProjectileLook; dir: 1 | -1;
}
export interface DecodedMower { row: number; x: number; state: "idle" | "active" | "spent" }
export interface DecodedCaltrop { row: number; x: number }
/** 一条正在放出的钩锁：从钟馗身上连到被钩的植物。 */
export interface DecodedHook {
  zombieId: number; row: number; x: number; targetX: number; targetY: number;
}

export function decodeUnit(t: UnitTuple): DecodedUnit {
  return {
    id: t[0], kind: KIND_INDEX[t[1]]!, row: t[2], x: t[3], y: t[4],
    hp: t[5], maxHp: t[6], state: STATE_INDEX[t[7]] ?? "idle",
    frozen: (t[8] & FLAG_FROZEN) !== 0,
    dead: (t[8] & FLAG_DEAD) !== 0,
    impHidden: (t[8] & FLAG_IMP_HIDDEN) !== 0,
    shieldsBroken: (t[8] >> SHIELD_SHIFT) & 0b11,
  };
}
export function decodeProjectile(t: ProjTuple): DecodedProjectile {
  return {
    id: t[0], row: t[1], x: t[2], y: t[3], frozen: t[4] === 1,
    look: PROJECTILE_LOOK_INDEX[t[5]] ?? "pea", dir: t[6] ?? 1,
  };
}
export function decodeMower(t: MowerTuple): DecodedMower {
  return { row: t[0], x: t[1], state: MOWER_STATE_INDEX[t[2]] ?? "idle" };
}
export function decodeCaltrop(t: CaltropTuple): DecodedCaltrop {
  return { row: t[0], x: t[1] };
}
export function decodeHook(t: HookTuple): DecodedHook {
  return { zombieId: t[0], row: t[1], x: t[2], targetX: t[3], targetY: t[4] };
}

function round(v: number): number { return Math.round(v); }
function round1(v: number): number { return Math.round(v * 10) / 10; }
