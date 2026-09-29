/**
 * 四个新单位的机制自检。用
 *   npx tsx tools/newunits-selfcheck.ts
 * 运行。每个用例只验证一条机制，失败信息里带上实际数值，方便定位是数值问题
 * 还是逻辑问题。
 *
 * 这里同时验证「植物方看不见伪装体真身」——那是靠协议层按观战方编码实现的，
 * 属于对局公平性，必须有自动化兜底。
 */

import {
  createSim, step, enqueueCommand, type SimEvent, type SimState, type SimZombie,
} from "../shared/sim.ts";
import { BAMBOO, MIMIC, SHADOWSTRIKE, ZHONGKUI, CARD_STATS, cellCenterX, laneY } from "../shared/cards.ts";
import { encodeSnapshot, decodeUnit, KIND_INDEX } from "../shared/protocol.ts";

const DT = 0.1;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`);
  }
}

/** 推进若干秒。 */
function advance(sim: SimState, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(sim, DT);
}

/**
 * 推进若干秒，并收集途中的所有事件。
 *
 * step() 自己不清 events——真实调用方（服务器广播后、客户端消费后）才清。
 * 所以这里每 tick 收完必须自己清掉，否则同一个事件会被重复计数。
 */
function advanceCollecting(sim: SimState, seconds: number): SimEvent[] {
  const seen: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    step(sim, DT);
    seen.push(...sim.events.map((e) => ({ ...e })));
    sim.events.length = 0;
  }
  return seen;
}

/** 直接给足资源，免得用例被经济节奏拖住。注意 RESOURCE_CAP 是 999，别写超。 */
function rich(): SimState {
  const sim = createSim();
  sim.sun = 900;
  sim.brains = 900;
  return sim;
}

// ---- 机关盾竹 ----
console.log("机关盾竹");
{
  // 盾竹放靠右，僵尸几秒就能咬上，用例不用干等它走过整条草坪。
  // 但不能放在最后一列：那样「正前方一格」不存在，落钉这一段就测不到了。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 2, col: 7, kind: "shieldbamboo" });
  const plant = sim.plants[0]!;
  check("总耐久 7000", plant.maxHp === 7000, `实际 ${plant.maxHp}`);
  check("初始三层护盾都在", plant.shieldsBroken === 0);

  enqueueCommand(sim, { k: "zombie", row: 2, kind: "zombie" });
  // 先让僵尸走到跟前开咬。
  for (let i = 0; i < 300 && sim.zombies[0]!.state !== "eat"; i++) step(sim, DT);
  const zombie = sim.zombies[0]!;
  check("僵尸已经咬上盾竹", zombie.state === "eat", `state=${zombie.state}`);

  // 护盾只在「伤害穿过阈值」时才破，所以要把血放到阈值上方一点，
  // 让下一口啃咬真的打穿它——直接改血是不会触发破盾的。
  const bite = CARD_STATS.get("zombie")!.damage!;
  plant.hp = BAMBOO.thresholds[0]! + bite / 2;
  const beforeX = zombie.x;
  advance(sim, 1.5);
  check("啃咬打穿第一道阈值后破外甲", plant.shieldsBroken >= 1, `层数 ${plant.shieldsBroken}`);
  check("外甲破时把身前僵尸震退", zombie.x > beforeX, `${beforeX.toFixed(1)} → ${zombie.x.toFixed(1)}`);

  // 震退后它得重新走回来，再打穿第二道阈值。
  for (let i = 0; i < 300 && sim.zombies[0]!.state !== "eat"; i++) step(sim, DT);
  plant.hp = BAMBOO.thresholds[1]! + bite / 2;
  // 竹钉正好落在啃咬中的僵尸脚下，同一 tick 就被踩掉，所以看列表长度是看不到的，
  // 得看落钉和触发这两个事件。
  const events = advanceCollecting(sim, 1.5);
  check("啃咬打穿第二道阈值后破中甲", plant.shieldsBroken >= 2, `层数 ${plant.shieldsBroken}`);
  const dropped = events.filter((e) => e.kind === "burst" && e.color === "#dcc98a");
  check("中甲破时只落一组竹钉", dropped.length === 1, `落钉事件 ${dropped.length} 个`);
  check("竹钉落在盾竹正前方一格",
    dropped[0] !== undefined
      && Math.abs(dropped[0].x - cellCenterX(plant.col + BAMBOO.caltropAhead)) < 1,
    `落钉 x=${dropped[0]?.x}，应为 ${cellCenterX(plant.col + BAMBOO.caltropAhead)}`);

  for (let i = 0; i < 300 && sim.zombies[0]!.state !== "eat"; i++) step(sim, DT);
  plant.hp = BAMBOO.thresholds[2]! + bite / 2;
  advance(sim, 1.5);
  check("啃咬打穿第三道阈值后进入锁芯", plant.shieldsBroken === 3 && plant.coreLockTimer > 0,
    `层数 ${plant.shieldsBroken}，锁芯 ${plant.coreLockTimer.toFixed(1)}s`);
  check("锁芯保底至少留 800 竹芯血", plant.hp >= BAMBOO.coreFloor, `实际 ${plant.hp}`);
}
{
  // 竹钉本身：定住并伤害踩上来的僵尸。这里直接放一组竹钉，不绕破盾流程，
  // 免得竹钉落在啃咬中的僵尸脚下当场被消耗掉，测不到「新来的僵尸踩上去」。
  const sim = rich();
  sim.caltrops.push({
    id: 1, row: 3, col: 8, x: cellCenterX(8), y: laneY(3), timer: BAMBOO.caltropDuration,
  });
  enqueueCommand(sim, { k: "zombie", row: 3, kind: "buckethead" });
  const zombie = sim.zombies[0]!;
  const hpBefore = zombie.hp;
  // 竹钉只存在 8 秒，所以要放在僵尸这段时间内走得到的位置。
  for (let i = 0; i < 600 && sim.caltrops.length; i++) step(sim, DT);
  check("僵尸踩到竹钉会掉血", zombie.hp === hpBefore - BAMBOO.caltropDamage,
    `${hpBefore} → ${zombie.hp}，应扣 ${BAMBOO.caltropDamage}`);
  check("踩到竹钉会被定住", zombie.stunTimer > 0, `stunTimer=${zombie.stunTimer.toFixed(2)}`);
  check("竹钉只有一次充能，触发后消失", sim.caltrops.length === 0, `剩余 ${sim.caltrops.length}`);
}
{
  // 没人踩的话，竹钉到时间自然消失。
  const sim = rich();
  sim.caltrops.push({
    id: 1, row: 0, col: 4, x: cellCenterX(4), y: laneY(0), timer: BAMBOO.caltropDuration,
  });
  advance(sim, BAMBOO.caltropDuration + 0.5);
  check("没人踩的竹钉到时间自然消失", sim.caltrops.length === 0, `剩余 ${sim.caltrops.length}`);
}
{
  // 巨人第一锤打不死，第二锤才行——这是设计里明确写的期望。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 1, col: 1, kind: "shieldbamboo" });
  const plant = sim.plants[0]!;
  plant.hp = BAMBOO.thresholds[2]! + 5;   // 已破两层，下一击触发锁芯
  plant.shieldsBroken = 2;
  enqueueCommand(sim, { k: "zombie", row: 1, kind: "gargantuar" });
  const smashes: number[] = [];
  for (let i = 0; i < 900 && sim.plants.length; i++) {
    step(sim, DT);
    if (sim.events.some((e) => e.effect === "gargantuar" && e.kind === "flatten")) {
      smashes.push(Math.ceil(plant.hp));
    }
    // step() 不清 events，这里必须自己清，否则一次巨锤会被数成很多次。
    sim.events.length = 0;
  }
  check("巨人第一锤砸不死锁芯状态的盾竹", smashes.length >= 1 && smashes[0]! > 0,
    `第一锤后剩血 ${smashes[0]}`);
  check("巨人第二锤把它处决掉", smashes.length >= 2 && sim.plants.length === 0,
    `锤了 ${smashes.length} 次，剩余植物 ${sim.plants.length}`);
}
{
  // 有护盾时撑杆跳不过去；只剩竹芯时可以。
  const tall = rich();
  enqueueCommand(tall, { k: "plant", row: 0, col: 3, kind: "shieldbamboo" });
  enqueueCommand(tall, { k: "zombie", row: 0, kind: "polevaulter" });
  advance(tall, 20);
  check("有护盾时撑杆僵尸跳不过盾竹", tall.zombies[0]?.jumped === false,
    `jumped=${tall.zombies[0]?.jumped}`);

  const low = rich();
  enqueueCommand(low, { k: "plant", row: 0, col: 3, kind: "shieldbamboo" });
  low.plants[0]!.shieldsBroken = 3;
  low.plants[0]!.hp = 900;
  enqueueCommand(low, { k: "zombie", row: 0, kind: "polevaulter" });
  advance(low, 20);
  check("破到只剩竹芯后撑杆可以跳过去", low.zombies[0]?.jumped === true,
    `jumped=${low.zombies[0]?.jumped}`);
}

// ---- 影袭僵尸 ----
console.log("\n影袭僵尸");
{
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 3, col: 0, kind: "peashooter" });
  enqueueCommand(sim, { k: "zombie", row: 3, kind: "shadowstrike" });
  const shadow = sim.zombies[0]!;
  check("出生即隐身", shadow.cloaked === true);
  advance(sim, 6);
  check("隐身期间豌豆射手打不到它", shadow.hp === shadow.maxHp,
    `剩血 ${shadow.hp}/${shadow.maxHp}`);
  check("隐身期间射手不进入攻击状态", sim.plants[0]!.state === "idle",
    `state=${sim.plants[0]!.state}`);
  check("隐身移动速度用的是潜行速度", shadow.state === "cloak");
}
{
  // 寒冰能看穿影幕，命中即破隐。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 3, col: 0, kind: "snowpea" });
  enqueueCommand(sim, { k: "zombie", row: 3, kind: "shadowstrike" });
  const shadow = sim.zombies[0]!;
  advance(sim, 14);
  check("寒冰射手能锁定隐身的影袭", shadow.hp < shadow.maxHp,
    `剩血 ${shadow.hp}/${shadow.maxHp}`);
  check("被寒冰命中后立刻显形", shadow.cloaked === false);
}
{
  // 第一口是伏击加成，咬完显形。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 4, col: 8, kind: "wallnut" });
  enqueueCommand(sim, { k: "zombie", row: 4, kind: "shadowstrike" });
  const nut = sim.plants[0]!;
  const shadow = sim.zombies[0]!;
  for (let i = 0; i < 600 && shadow.cloaked; i++) step(sim, DT);
  const afterFirstBite = nut.maxHp - nut.hp;
  check("破影一击造成 160 伤害", afterFirstBite === SHADOWSTRIKE.ambushDamage,
    `实际 ${afterFirstBite}`);
  check("咬第一口后立刻显形", shadow.cloaked === false);
  advance(sim, 1.2);
  check("显形后恢复普通咬伤", nut.maxHp - nut.hp === SHADOWSTRIKE.ambushDamage + CARD_STATS.get("shadowstrike")!.damage!,
    `累计 ${nut.maxHp - nut.hp}`);
}
{
  // 土豆雷和窝瓜不靠锁定，能收拾隐身的影袭。
  const mine = rich();
  enqueueCommand(mine, { k: "plant", row: 2, col: 6, kind: "potatomine" });
  advance(mine, 15);
  enqueueCommand(mine, { k: "zombie", row: 2, kind: "shadowstrike" });
  advance(mine, 25);
  check("土豆雷能炸掉隐身的影袭", mine.zombies.every((z) => z.deadTimer > 0 || z.hp <= 0),
    `剩余存活 ${mine.zombies.filter((z) => z.deadTimer === 0).length}`);

  const squash = rich();
  enqueueCommand(squash, { k: "plant", row: 2, col: 6, kind: "squash" });
  enqueueCommand(squash, { k: "zombie", row: 2, kind: "shadowstrike" });
  advance(squash, 30);
  check("窝瓜能砸死隐身的影袭", squash.zombies.every((z) => z.deadTimer > 0 || z.hp <= 0),
    `剩余存活 ${squash.zombies.filter((z) => z.deadTimer === 0).length}`);
}

// ---- 钟馗僵尸 ----
console.log("\n钟馗僵尸");
{
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 1, col: 2, kind: "peashooter" });
  enqueueCommand(sim, { k: "zombie", row: 1, kind: "zhongkui" });
  const shooter = sim.plants[0]!;
  const zk = sim.zombies[0]!;
  const startCol = shooter.col;
  check("入场后要等一段时间才放第一钩", zk.hookTimer === ZHONGKUI.firstHookDelay,
    `hookTimer=${zk.hookTimer}`);

  let sawWindup = false;
  for (let i = 0; i < 1200 && shooter.col === startCol; i++) {
    step(sim, DT);
    if (zk.hookWindup > 0) sawWindup = true;
  }
  check("抬钩有可见前摇", sawWindup);
  check("植物被向右拖动一格", shooter.col === startCol + 1,
    `${startCol} → ${shooter.col}`);
  check("植物坐标跟着格子走", shooter.x === cellCenterX(shooter.col),
    `x=${shooter.x}，应为 ${cellCenterX(shooter.col)}`);
}
{
  // 坚果抗第一钩。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 1, col: 2, kind: "wallnut" });
  enqueueCommand(sim, { k: "zombie", row: 1, kind: "zhongkui" });
  const nut = sim.plants[0]!;
  const startCol = nut.col;
  // 跑到第一钩结算完。
  for (let i = 0; i < 1200 && nut.hookedCount === 0; i++) step(sim, DT);
  check("坚果抵抗第一钩，原地不动", nut.col === startCol && nut.hookedCount === 1,
    `col=${nut.col}，被钩次数=${nut.hookedCount}`);
}
{
  // 右边一格被占住就钩不动。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 1, col: 2, kind: "peashooter" });
  enqueueCommand(sim, { k: "plant", row: 1, col: 3, kind: "sunflower" });
  enqueueCommand(sim, { k: "zombie", row: 1, kind: "zhongkui" });
  const shooter = sim.plants.find((p) => p.kind === "peashooter")!;
  advance(sim, 20);
  check("落点被占住时钩不动那株植物", shooter.col === 2, `col=${shooter.col}`);
}
{
  // 钩到窝瓜被反杀。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 1, col: 3, kind: "squash" });
  enqueueCommand(sim, { k: "zombie", row: 1, kind: "zhongkui" });
  const zk = sim.zombies[0]!;
  advance(sim, 40);
  check("钩到窝瓜会被反过来砸死", zk.deadTimer > 0 || zk.hp <= 0,
    `剩血 ${zk.hp}`);
}
{
  // 钩到寒冰射手被冻住，但位移仍然完成。
  const sim = rich();
  enqueueCommand(sim, { k: "plant", row: 1, col: 3, kind: "snowpea" });
  enqueueCommand(sim, { k: "zombie", row: 1, kind: "zhongkui" });
  const pea = sim.plants[0]!;
  const zk = sim.zombies[0]!;
  for (let i = 0; i < 1200 && pea.col === 3; i++) step(sim, DT);
  check("钩到寒冰射手时位移仍然完成", pea.col === 4, `col=${pea.col}`);
  check("寒冰顺铁链回传冻住钟馗", zk.slowTimer > 0, `slowTimer=${zk.slowTimer.toFixed(1)}`);
}

// ---- 伪装向日葵 ----
console.log("\n伪装向日葵");
{
  const sim = rich();
  enqueueCommand(sim, { k: "zombie", row: 2, kind: "mimicsunflower" });
  const mimic = sim.zombies[0]!;
  check("潜入植物方前六列", mimic.col >= 0 && mimic.col <= MIMIC.maxCol, `col=${mimic.col}`);
  check("不从右侧人行道进场", mimic.x === cellCenterX(mimic.col), `x=${mimic.x}`);
  check("初始处于潜伏状态", mimic.disguised === true);

  // 自然收入也在涨，直接比前后差值会把收入算进来。跑一份没有伪装体的
  // 对照 sim，两者之差才是真正被偷掉的量。
  // 偷阳光的计时从「钻地成形」之后才开始走，所以要留出 burrow 的 0.8 秒。
  const control = rich();
  const span = MIMIC.burrow + MIMIC.stealInterval + 0.3;
  for (let i = 0; i < Math.round(span / DT); i++) { step(sim, DT); step(control, DT); }
  check("每个周期偷走 25 阳光", control.sun - sim.sun === MIMIC.stealAmount,
    `对照 ${control.sun}，实际 ${sim.sun}，差 ${control.sun - sim.sun}`);
  check("偷阳光计入累计量", mimic.stolenSun === MIMIC.stealAmount, `累计 ${mimic.stolenSun}`);

  // 偷够 100 就现形。
  for (let i = 0; i < 2000 && mimic.disguised; i++) step(sim, DT);
  check("累计偷到 100 后现形", mimic.stolenSun >= MIMIC.revealAt && !mimic.disguised,
    `偷了 ${mimic.stolenSun}`);
  check("现形后开始向左推进", mimic.state === "move" || mimic.state === "eat");
}
{
  // 占着格子：植物种不进去，但提示不能泄露真身。
  const sim = rich();
  enqueueCommand(sim, { k: "zombie", row: 2, kind: "mimicsunflower" });
  const mimic = sim.zombies[0]!;
  const result = enqueueCommand(sim, { k: "plant", row: 2, col: mimic.col, kind: "peashooter" });
  check("伪装体占着的格子种不下植物", result.ok === false);
  check("拒绝理由不泄露真身", result.reason === "这个格子已经有植物了", `理由：${result.reason}`);
}
{
  // 铲子能直接铲掉它。
  const sim = rich();
  enqueueCommand(sim, { k: "zombie", row: 2, kind: "mimicsunflower" });
  const mimic = sim.zombies[0]!;
  const sunBefore = sim.sun;
  const result = enqueueCommand(sim, { k: "shovel", row: 2, col: mimic.col });
  check("铲子能铲掉潜伏中的伪装体", result.ok === true && (mimic.deadTimer > 0 || mimic.hp <= 0),
    `剩血 ${mimic.hp}`);
  check("铲掉不返还阳光", sim.sun === sunBefore);
}
{
  // 范围爆炸能打到它，没打死就强制现形。
  const sim = rich();
  enqueueCommand(sim, { k: "zombie", row: 2, kind: "mimicsunflower" });
  const mimic = sim.zombies[0]!;
  enqueueCommand(sim, { k: "plant", row: 2, col: mimic.col, kind: "cherrybomb" });
  // 上一格被占，樱桃种在旁边一格。
  enqueueCommand(sim, { k: "plant", row: 2, col: Math.min(8, mimic.col + 1), kind: "cherrybomb" });
  advance(sim, 2);
  check("范围爆炸能打到潜伏中的伪装体", mimic.hp < mimic.maxHp || mimic.deadTimer > 0,
    `剩血 ${mimic.hp}/${mimic.maxHp}`);
}
{
  // 一直没人管，45 秒也要强制现形，给玩家一个损失上限。
  const sim = rich();
  enqueueCommand(sim, { k: "zombie", row: 4, kind: "mimicsunflower" });
  const mimic = sim.zombies[0]!;
  sim.sun = 0;   // 没阳光可偷，只能靠时间上限现形
  advance(sim, MIMIC.maxDisguise + 1);
  check("最长潜伏 45 秒后强制现形", mimic.disguised === false,
    `潜伏了 ${mimic.disguiseAge.toFixed(1)}s`);
  check("偷不到阳光时不会把资源栏偷成负数", sim.sun >= 0, `阳光 ${sim.sun}`);
}

// ---- 分方可见：植物方必须看不见伪装体真身 ----
console.log("\n伪装体的分方可见");
{
  const sim = rich();
  enqueueCommand(sim, { k: "zombie", row: 2, kind: "mimicsunflower" });
  const mimic = sim.zombies[0]!;
  advance(sim, 1.5);

  const asPlants = encodeSnapshot(sim, 0, "plants").u.map(decodeUnit);
  const asZombies = encodeSnapshot(sim, 0, "zombies").u.map(decodeUnit);
  const seenByPlants = asPlants.find((u) => u.id === mimic.id)!;
  const seenByZombies = asZombies.find((u) => u.id === mimic.id)!;

  check("植物方看到的是向日葵", seenByPlants.kind === "sunflower", `看到 ${seenByPlants.kind}`);
  check("植物方看到的血量也是向日葵的", seenByPlants.maxHp === 300, `maxHp=${seenByPlants.maxHp}`);
  check("植物方看到的动画状态是向日葵待机", seenByPlants.state === "idle", `state=${seenByPlants.state}`);
  check("僵尸方看到真身", seenByZombies.kind === "mimicsunflower", `看到 ${seenByZombies.kind}`);
  check("快照里完全不含伪装体的真实 kind",
    !encodeSnapshot(sim, 0, "plants").u.some((t) => KIND_INDEX[t[1]] === "mimicsunflower"));

  // 登场事件也不能露：植物方应该看到「种下一株向日葵」。
  const fresh = rich();
  enqueueCommand(fresh, { k: "zombie", row: 3, kind: "mimicsunflower" });
  const spawnEvents = encodeSnapshot(fresh, 0, "plants").ev;
  check("登场事件对植物方伪装成种植",
    spawnEvents.every((e) => e.sourceKind !== "mimicsunflower")
      && spawnEvents.some((e) => e.kind === "plant" && e.sourceKind === "sunflower"),
    JSON.stringify(spawnEvents.map((e) => [e.kind, e.sourceKind])));
  check("僵尸方的登场事件是真实的钻地",
    encodeSnapshot(fresh, 0, "zombies").ev.some((e) => e.kind === "spawn" && e.sourceKind === "mimicsunflower"));

  // 现形之后就不再遮掩了。
  reveal(sim, mimic);
  const afterReveal = encodeSnapshot(sim, 0, "plants").u.map(decodeUnit)
    .find((u) => u.id === mimic.id)!;
  check("现形后植物方看到真身", afterReveal.kind === "mimicsunflower", `看到 ${afterReveal.kind}`);
}

/** 用例里手动破除伪装（sim 内部的 reveal 不导出，这里复制它的可见效果）。 */
function reveal(sim: SimState, zombie: SimZombie): void {
  zombie.disguised = false;
  zombie.cloaked = false;
  zombie.state = "move";
}

// ---- 确定性：新单位混战也必须逐位一致 ----
console.log("\n确定性");
{
  const script = (sim: SimState) => {
    sim.sun = 900; sim.brains = 900;
    const steps: Array<[number, () => void]> = [
      [2, () => enqueueCommand(sim, { k: "plant", row: 0, col: 3, kind: "shieldbamboo" })],
      [4, () => enqueueCommand(sim, { k: "plant", row: 1, col: 1, kind: "snowpea" })],
      [6, () => enqueueCommand(sim, { k: "plant", row: 2, col: 4, kind: "squash" })],
      [8, () => enqueueCommand(sim, { k: "zombie", row: 0, kind: "shadowstrike" })],
      [10, () => enqueueCommand(sim, { k: "zombie", row: 1, kind: "zhongkui" })],
      [12, () => enqueueCommand(sim, { k: "zombie", row: 2, kind: "mimicsunflower" })],
      [40, () => enqueueCommand(sim, { k: "zombie", row: 0, kind: "gargantuar" })],
    ];
    const byTick = new Map(steps);
    for (let t = 0; t < 900 && sim.phase === "playing"; t++) {
      byTick.get(t)?.();
      step(sim, DT);
    }
    return JSON.stringify(sim);
  };
  const a = script(createSim());
  const b = script(createSim());
  check("四个新单位混战下逐位确定", a === b);
}

console.log("");
if (failures === 0) {
  console.log("全部通过 ✓");
  process.exit(0);
} else {
  console.log(`${failures} 项失败 ✗`);
  process.exit(1);
}
