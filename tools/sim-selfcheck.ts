/**
 * 模拟自检：确定性 + 完整对局不崩。用
 *   node --experimental-strip-types tools/sim-selfcheck.ts
 * 运行，这是本项目对模拟层的主要自动化验证手段（浏览器只能手测）。
 */

import {
  createSim, step, enqueueCommand, type Command, type SimState,
} from "../shared/sim.ts";
import { ROUND_SECONDS, SPAWN_X } from "../shared/cards.ts";

const DT = 0.1;

/** 一条按 tick 排定的脚本命令。 */
interface Scripted {
  tick: number;
  cmd: Command;
}

/** 完整跑一场：每到指定 tick 就下命令，直到对局结束或达到上限。 */
function run(script: Scripted[], maxTicks: number): SimState {
  const sim = createSim();
  const byTick = new Map<number, Command[]>();
  for (const s of script) {
    const list = byTick.get(s.tick) ?? [];
    list.push(s.cmd);
    byTick.set(s.tick, list);
  }
  for (let t = 0; t < maxTicks && sim.phase === "playing"; t++) {
    for (const cmd of byTick.get(t) ?? []) enqueueCommand(sim, cmd);
    step(sim, DT);
  }
  return sim;
}

/** 稳定序列化：events 是每 tick 瞬时数据，最终态里应为空，纳入比较无妨。 */
function fingerprint(sim: SimState): string {
  return JSON.stringify(sim);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`);
  }
}

// ---- 用例 1：确定性。同一串命令跑两遍，最终态必须逐位一致。 ----
// 覆盖多兵种、土豆雷、寒冰减速、巨人投小鬼、割草机触发。
const mixedScript: Scripted[] = [
  { tick: 2, cmd: { k: "plant", row: 0, col: 0, kind: "sunflower" } },
  { tick: 3, cmd: { k: "plant", row: 0, col: 2, kind: "peashooter" } },
  { tick: 5, cmd: { k: "plant", row: 1, col: 2, kind: "snowpea" } },
  { tick: 6, cmd: { k: "plant", row: 1, col: 1, kind: "wallnut" } },
  { tick: 8, cmd: { k: "plant", row: 2, col: 3, kind: "potatomine" } },
  { tick: 10, cmd: { k: "zombie", row: 0, kind: "zombie" } },
  { tick: 12, cmd: { k: "zombie", row: 1, kind: "conehead" } },
  { tick: 30, cmd: { k: "zombie", row: 2, kind: "polevaulter" } },
  { tick: 45, cmd: { k: "zombie", row: 3, kind: "gargantuar" } },
  { tick: 60, cmd: { k: "plant", row: 3, col: 5, kind: "cherrybomb" } },
  { tick: 90, cmd: { k: "zombie", row: 4, kind: "football" } },
  { tick: 120, cmd: { k: "zombie", row: 3, kind: "buckethead" } },
];

console.log("用例 1：确定性（同命令跑两遍）");
const a = run(mixedScript, 1600);
const b = run(mixedScript, 1600);
check("两遍最终 tick 相同", a.tick === b.tick, `${a.tick} vs ${b.tick}`);
check("两遍最终态逐位一致", fingerprint(a) === fingerprint(b));
if (fingerprint(a) !== fingerprint(b)) {
  // 定位首个分叉 tick，便于排查
  const s1 = createSim(), s2 = createSim();
  const byTick = new Map<number, Command[]>();
  for (const s of mixedScript) (byTick.get(s.tick) ?? byTick.set(s.tick, []).get(s.tick)!).push(s.cmd);
  for (let t = 0; t < 1600; t++) {
    for (const c of byTick.get(t) ?? []) { enqueueCommand(s1, c); enqueueCommand(s2, c); }
    step(s1, DT); step(s2, DT);
    if (fingerprint(s1) !== fingerprint(s2)) { console.log(`    首个分叉发生在 tick ${t}`); break; }
  }
}

// ---- 用例 2：僵尸破门取胜。一路狂出僵尸、不种植物，割草机用完后应判僵尸胜。 ----
console.log("用例 2：僵尸破门（僵尸方胜）");
const rushScript: Scripted[] = [];
for (let i = 0; i < 30; i++) rushScript.push({ tick: i * 20, cmd: { k: "zombie", row: 2, kind: "zombie" } });
const rush = run(rushScript, ROUND_SECONDS * 10 + 50);
check("对局已结束", rush.phase === "ended");
check("僵尸方获胜", rush.winner === "zombies", `winner=${rush.winner} reason=${rush.endReason}`);

// ---- 用例 3：植物拖到超时取胜。只种向日葵攒资源、不出僵尸，到 600 秒判植物胜。 ----
console.log("用例 3：拖到超时（植物方胜）");
const timeoutScript: Scripted[] = [
  { tick: 2, cmd: { k: "plant", row: 0, col: 0, kind: "sunflower" } },
  { tick: 4, cmd: { k: "plant", row: 2, col: 0, kind: "sunflower" } },
];
const timeout = run(timeoutScript, ROUND_SECONDS * 10 + 50);
check("对局已结束", timeout.phase === "ended");
check("植物方获胜", timeout.winner === "plants", `winner=${timeout.winner} reason=${timeout.endReason}`);
check("恰在约 600 秒结束", Math.abs(timeout.tick - ROUND_SECONDS * 10) <= 1, `tick=${timeout.tick}`);

// ---- 用例 4：服务器校验。资源不足 / 占用格子 / 越界应被拒。 ----
console.log("用例 4：命令校验");
const guard = createSim();
step(guard, DT);
const okPlant = enqueueCommand(guard, { k: "plant", row: 0, col: 0, kind: "sunflower" });
check("合法种植被接受", okPlant.ok);
const dupPlant = enqueueCommand(guard, { k: "plant", row: 0, col: 0, kind: "peashooter" });
check("重复占格被拒", !dupPlant.ok, dupPlant.reason);
const poor = createSim();
poor.sun = 0;
const noSun = enqueueCommand(poor, { k: "plant", row: 0, col: 1, kind: "cherrybomb" });
check("阳光不足被拒", !noSun.ok, noSun.reason);
const oob = enqueueCommand(guard, { k: "zombie", row: 9, kind: "zombie" });
check("越界路线被拒", !oob.ok, oob.reason);

// ---- 用例 5：V2 新单位的机制。资源和冷却在这些用例里不设限，
//      只验证战斗规则本身。 ----
console.log("用例 5：V2 新单位");

/** 跑一场并每 tick 回调，资源与冷却拉满，专测机制。 */
function runRich(
  script: Scripted[],
  maxTicks: number,
  watch?: (sim: SimState, tick: number) => void,
): SimState {
  const sim = createSim();
  const byTick = new Map<number, Command[]>();
  for (const s of script) {
    const list = byTick.get(s.tick) ?? [];
    list.push(s.cmd);
    byTick.set(s.tick, list);
  }
  for (let t = 0; t < maxTicks && sim.phase === "playing"; t++) {
    sim.sun = 9999;
    sim.brains = 9999;
    sim.cooldowns = {};
    for (const cmd of byTick.get(t) ?? []) enqueueCommand(sim, cmd);
    step(sim, DT);
    watch?.(sim, t);
  }
  return sim;
}

// 奶龙：停在射程外大笑发光波，光波向左飞并削坚果，全程不贴脸。
let sawWave = false;
let minGap = Infinity;
const nailong = runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 0, col: 0, kind: "wallnut" } },
    { tick: 2, cmd: { k: "zombie", row: 0, kind: "nailong" } },
  ],
  600,
  (sim) => {
    if (sim.projectiles.some((p) => p.dir === -1 && p.look === "wave")) sawWave = true;
    const dragon = sim.zombies.find((z) => z.kind === "nailong");
    const nut = sim.plants.find((p) => p.kind === "wallnut");
    if (dragon && nut) minGap = Math.min(minGap, dragon.x - nut.x);
  },
);
const dragon = nailong.zombies.find((z) => z.kind === "nailong");
const nut = nailong.plants.find((p) => p.kind === "wallnut");
check("奶龙发出了向左的光波", sawWave);
check("奶龙全程停在射程外（不贴脸啃）", minGap > 300, `最近距离 ${minGap.toFixed(1)}px`);
check("奶龙保持大笑状态", dragon?.state === "laugh", `state=${dragon?.state}`);
check("坚果被光波削血", !!nut && nut.hp < 4000, `hp=${nut?.hp}`);

// 语义特效事件：规则层只声明发生了什么，客户端再负责画尾迹/命中。
const fxProbe = createSim();
fxProbe.sun = 9999; fxProbe.brains = 9999;
enqueueCommand(fxProbe, { k: "plant", row: 0, col: 0, kind: "peashooter" });
enqueueCommand(fxProbe, { k: "zombie", row: 0, kind: "zombie" });
let sawShootEvent = false, sawHitEvent = false;
for (let t = 0; t < 500 && fxProbe.phase === "playing"; t++) {
  step(fxProbe, DT);
  sawShootEvent ||= fxProbe.events.some((event) => event.kind === "shoot" && event.sourceKind === "peashooter");
  sawHitEvent ||= fxProbe.events.some((event) => event.kind === "hit" && event.targetKind === "zombie");
  fxProbe.events.length = 0;
  if (sawShootEvent && sawHitEvent) break;
}
check("射手发射产生语义事件", sawShootEvent);
check("弹丸命中产生语义事件", sawHitEvent);

// 三线射手：一次齐射覆盖上中下三行。僵尸挨完打会被清出场，
// 所以在每 tick 的回调里记录「曾经掉过血」的行，而不是看最终态。
const hurtRows = new Set<number>();
runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 2, col: 0, kind: "threepeater" } },
    { tick: 2, cmd: { k: "zombie", row: 1, kind: "zombie" } },
    { tick: 3, cmd: { k: "zombie", row: 2, kind: "zombie" } },
    { tick: 4, cmd: { k: "zombie", row: 3, kind: "zombie" } },
  ],
  400,
  (sim) => {
    for (const z of sim.zombies) if (z.hp < z.maxHp) hurtRows.add(z.row);
  },
);
check("三线射手同时打到 1/2/3 三行", [1, 2, 3].every((r) => hurtRows.has(r)),
  `受伤行=${[...hurtRows]}`);

// 火爆辣椒：点燃整行，无视距离。
const spicy = runRich(
  [
    { tick: 1, cmd: { k: "zombie", row: 0, kind: "zombie" } },
    { tick: 2, cmd: { k: "zombie", row: 0, kind: "conehead" } },
    { tick: 3, cmd: { k: "zombie", row: 1, kind: "zombie" } },
    { tick: 5, cmd: { k: "plant", row: 0, col: 0, kind: "jalapeno" } },
  ],
  40,
);
check("辣椒烧光了整行僵尸",
  spicy.zombies.filter((z) => z.row === 0 && z.deadTimer === 0).length === 0);
check("辣椒不波及其它行",
  spicy.zombies.some((z) => z.row === 1 && z.deadTimer === 0 && z.hp === z.maxHp));

// 高坚果挡住撑杆僵尸：不许起跳，只能啃。
const vaultTall = runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 0, col: 6, kind: "tallnut" } },
    { tick: 2, cmd: { k: "zombie", row: 0, kind: "polevaulter" } },
  ],
  260,
);
const vaulterA = vaultTall.zombies.find((z) => z.kind === "polevaulter");
check("撑杆僵尸跳不过高坚果", vaulterA?.jumped === false, `jumped=${vaulterA?.jumped}`);
// 对照组：普通坚果墙照样能跳过去。
const vaultWall = runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 0, col: 6, kind: "wallnut" } },
    { tick: 2, cmd: { k: "zombie", row: 0, kind: "polevaulter" } },
  ],
  260,
);
const vaulterB = vaultWall.zombies.find((z) => z.kind === "polevaulter");
check("对照：撑杆僵尸能跳过普通坚果", vaulterB?.jumped === true, `jumped=${vaulterB?.jumped}`);

// 铁门僵尸：铁门被打烂后退化成普通僵尸。
let doorBroke = false;
runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 0, col: 0, kind: "peashooter" } },
    { tick: 2, cmd: { k: "plant", row: 0, col: 1, kind: "peashooter" } },
    { tick: 3, cmd: { k: "plant", row: 0, col: 2, kind: "peashooter" } },
    { tick: 4, cmd: { k: "zombie", row: 0, kind: "screendoor" } },
  ],
  600,
  (sim) => {
    if (sim.zombies.some((z) => z.kind === "zombie" && z.armorLost)) doorBroke = true;
  },
);
check("铁门被打掉后变普通僵尸", doorBroke);

// 读报僵尸：报纸没了就暴走加速。
let sawRage = false;
let rageSpeedOk = false;
runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 0, col: 0, kind: "peashooter" } },
    { tick: 2, cmd: { k: "zombie", row: 0, kind: "newspaper" } },
  ],
  900,
  (sim) => {
    const paper = sim.zombies.find((z) => z.kind === "newspaper");
    if (paper?.armorLost && paper.state === "rage") {
      sawRage = true;
      const before = paper.x;
      // 再推一帧看位移是否明显大于原速 19px/s。
      step(sim, DT);
      if (before - paper.x > 19 * DT * 1.5) rageSpeedOk = true;
    }
  },
);
check("读报僵尸失去报纸后进入暴走", sawRage);
check("暴走后速度明显提升", rageSpeedOk);

// 舞王僵尸：踏上草坪后召唤上下两名伴舞。
const disco = runRich(
  [{ tick: 1, cmd: { k: "zombie", row: 2, kind: "dancer" } }],
  200,
);
const backups = disco.zombies.filter((z) => z.kind === "backupdancer");
check("舞王召唤出伴舞", backups.length >= 2, `伴舞数=${backups.length}`);
check("伴舞落在上下相邻行",
  backups.some((z) => z.row === 1) && backups.some((z) => z.row === 3),
  `行=${backups.map((z) => z.row)}`);

// 窝瓜：僵尸走近就跳起来砸死它，砸完自己消失。
const smash = runRich(
  [
    { tick: 1, cmd: { k: "plant", row: 0, col: 4, kind: "squash" } },
    { tick: 2, cmd: { k: "zombie", row: 0, kind: "zombie" } },
  ],
  320,
);
check("窝瓜砸死了走近的僵尸",
  smash.zombies.filter((z) => z.deadTimer === 0).length === 0);
check("窝瓜砸完自己也消失", !smash.plants.some((p) => p.kind === "squash"));

const flattenProbe = createSim();
flattenProbe.sun = 9999; flattenProbe.brains = 9999;
enqueueCommand(flattenProbe, { k: "plant", row: 0, col: 8, kind: "squash" });
enqueueCommand(flattenProbe, { k: "zombie", row: 0, kind: "zombie" });
let sawFlatten = false, sawImpact = false;
for (let t = 0; t < 100 && flattenProbe.phase === "playing"; t++) {
  step(flattenProbe, DT);
  sawFlatten ||= flattenProbe.events.some((event) => event.kind === "flatten" && event.effect === "squash");
  sawImpact ||= flattenProbe.events.some((event) => event.kind === "impact" && event.effect === "squash");
  flattenProbe.events.length = 0;
}
check("窝瓜砸击产生压扁事件", sawFlatten);
check("窝瓜落地产生冲击事件", sawImpact);

const burnProbe = createSim();
burnProbe.sun = 9999; burnProbe.brains = 9999;
enqueueCommand(burnProbe, { k: "zombie", row: 0, kind: "zombie" });
enqueueCommand(burnProbe, { k: "plant", row: 0, col: 4, kind: "jalapeno" });
let sawBurn = false, sawFireWave = false;
for (let t = 0; t < 20; t++) {
  step(burnProbe, DT);
  sawBurn ||= burnProbe.events.some((event) => event.kind === "burn" && event.effect === "jalapeno");
  sawFireWave ||= burnProbe.events.some((event) => event.kind === "explode" && event.effect === "jalapeno");
  burnProbe.events.length = 0;
}
check("辣椒产生逐目标燃烧事件", sawBurn);
check("辣椒产生整行火浪事件", sawFireWave);

// 扩池后确定性依旧成立。
const v2Script: Scripted[] = [
  { tick: 2, cmd: { k: "plant", row: 0, col: 1, kind: "threepeater" } },
  { tick: 4, cmd: { k: "plant", row: 2, col: 2, kind: "tallnut" } },
  { tick: 6, cmd: { k: "plant", row: 3, col: 3, kind: "squash" } },
  { tick: 20, cmd: { k: "zombie", row: 0, kind: "screendoor" } },
  { tick: 30, cmd: { k: "zombie", row: 1, kind: "newspaper" } },
  { tick: 40, cmd: { k: "zombie", row: 2, kind: "dancer" } },
  { tick: 55, cmd: { k: "zombie", row: 3, kind: "nailong" } },
  { tick: 80, cmd: { k: "plant", row: 1, col: 5, kind: "jalapeno" } },
];
const v2a = runRich(v2Script, 900);
const v2b = runRich(v2Script, 900);
check("新单位混战下仍逐位确定", fingerprint(v2a) === fingerprint(v2b));

// 入场线是渲染层按 SPAWN_X 画的，这里确认僵尸确实从这个 X 进场，
// 保证那条红线跟真实刷新位置对得上。
const spawnCheck = createSim();
step(spawnCheck, DT);
enqueueCommand(spawnCheck, { k: "zombie", row: 0, kind: "zombie" });
enqueueCommand(spawnCheck, { k: "zombie", row: 3, kind: "conehead" });
check("僵尸都从 SPAWN_X 进场（红线位置有依据）",
  spawnCheck.zombies.length === 2 && spawnCheck.zombies.every((z) => z.x === SPAWN_X),
  `x=${spawnCheck.zombies.map((z) => z.x)}，SPAWN_X=${SPAWN_X}`);

console.log("");
if (failures === 0) {
  console.log("全部通过 ✓");
  process.exit(0);
} else {
  console.log(`${failures} 项失败 ✗`);
  process.exit(1);
}
