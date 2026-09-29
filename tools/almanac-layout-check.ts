/**
 * 图鉴书页版式自检。用
 *   npx tsx tools/almanac-layout-check.ts
 * 运行（走 tsx，因为它 import 的 src/ 用了 node 的 strip-types 处理不了的语法）。
 *
 * 这些是版式的硬约束：格子不能重叠、不能跑出书页、点击要能命中对应角色、
 * 文字块不能压到底部的花费行。错了在浏览器里是「看起来怪但说不清哪怪」，
 * 这里能直接指出来。
 */

import { PAGE_H, PAGE_W, hitSlot, slotRect } from "../src/almanac.ts";
import { PLANT_CARDS, ZOMBIE_CARDS } from "../src/entities.ts";
import type { Side } from "../shared/cards.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

console.log("图鉴版式自检");

/** 原版的详情页卡框左边界；索引格不能越过它，否则会压到右页。 */
const DETAIL_LEFT = 455;
/** 底部花费/冷却那一行的基线。 */
const COST_ROW_Y = 520;

for (const side of ["plants", "zombies"] as Side[]) {
  const cards = side === "plants" ? PLANT_CARDS : ZOMBIE_CARDS;
  console.log(`\n${side === "plants" ? "植物页" : "僵尸页"}（${cards.length} 个角色）`);

  const rects = cards.map((_, i) => slotRect(side, i));

  check("索引格都在书页内",
    rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= PAGE_W && r.y + r.h <= PAGE_H),
    JSON.stringify(rects.find((r) => r.x < 0 || r.y < 0 || r.x + r.w > PAGE_W || r.y + r.h > PAGE_H)));

  check("索引格不越界到右页详情区",
    rects.every((r) => r.x + r.w <= DETAIL_LEFT),
    `最右格右边界 ${Math.max(...rects.map((r) => r.x + r.w))}，详情卡框从 ${DETAIL_LEFT} 开始`);

  let overlap = "";
  for (let i = 0; i < rects.length && !overlap; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!, b = rects[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlap = `第 ${i} 格与第 ${j} 格重叠`;
        break;
      }
    }
  }
  check("索引格互不重叠", overlap === "", overlap);

  // 点击每格中心，应该正好命中那个角色
  const roundTrip = cards.every((card, i) => {
    const r = rects[i]!;
    return hitSlot(side, cards, r.x + r.w / 2, r.y + r.h / 2) === card.kind;
  });
  check("点每格中心都命中对应角色", roundTrip);

  // 格子外的空白处不该命中任何角色
  const last = rects[rects.length - 1]!;
  check("格子之外点不中角色",
    hitSlot(side, cards, last.x + last.w + 20, last.y + last.h + 40) === null);

  const textTop = side === "plants" ? 309 : 377;
  check("描述区留在花费行上方", textTop < COST_ROW_Y - 20,
    `描述从 ${textTop} 开始，花费行在 ${COST_ROW_Y}`);
}

// 两侧共用同一块右页详情区，分格参数却必须不同——这是原版的设定，
// 写反了会导致僵尸格挤成一团，所以专门钉一下。
const p0 = slotRect("plants", 0), p1 = slotRect("plants", 1);
const z0 = slotRect("zombies", 0), z1 = slotRect("zombies", 1);
console.log("\n分格参数");
check("植物列距 52（原版）", p1.x - p0.x === 52, `实际 ${p1.x - p0.x}`);
check("僵尸列距 85（原版）", z1.x - z0.x === 85, `实际 ${z1.x - z0.x}`);
check("植物一行 8 格", slotRect("plants", 8).y - p0.y === 78 && slotRect("plants", 8).x === p0.x);
check("僵尸一行 5 格", slotRect("zombies", 5).y - z0.y === 80 && slotRect("zombies", 5).x === z0.x);
check("植物格 50×70", p0.w === 50 && p0.h === 70);
check("僵尸格 76×76", z0.w === 76 && z0.h === 76);

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
