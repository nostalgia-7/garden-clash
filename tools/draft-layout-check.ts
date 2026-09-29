/**
 * 选卡界面版式自检。用
 *   npx tsx tools/draft-layout-check.ts
 * 运行。
 *
 * 和图鉴那套一样：分格必须是原版那组数、格子不能重叠或越界、点击要能命中，
 * 而且确认按钮不能和卡池重叠——那会导致点卡变成点确认，是会直接毁掉一局的错。
 */

import {
  DRAFT_H, DRAFT_W, bankSlot, confirmRect, hitDraft, poolSlot, type DraftCardState,
} from "../src/draft-screen.ts";
import { PLANT_KINDS, ZOMBIE_KINDS } from "../shared/cards.ts";
import { DRAFT_PICK_COUNT } from "../shared/draft.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

console.log("选卡界面版式自检");

const POOL_SIZE = Math.max(PLANT_KINDS.length, ZOMBIE_KINDS.length);
const cards: DraftCardState[] = Array.from({ length: POOL_SIZE }, (_, i) => ({
  kind: (i < PLANT_KINDS.length ? PLANT_KINDS[i]! : ZOMBIE_KINDS[i]!),
  selected: false, banned: false, disabled: false,
}));

console.log(`\n卡池（${POOL_SIZE} 张）`);
const rects = cards.map((_, i) => poolSlot(i));

check("卡格都在画面内",
  rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= DRAFT_W && r.y + r.h <= DRAFT_H));

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
check("卡格互不重叠", overlap === "", overlap);

check("点每格中心命中对应卡",
  cards.every((card, i) => {
    const r = rects[i]!;
    return hitDraft(cards, r.x + r.w / 2, r.y + r.h / 2) === card.kind;
  }));

check("格子之外点不中",
  hitDraft(cards, rects[0]!.x - 12, rects[0]!.y - 12) === null);

console.log("\n分格参数（原版 SeedChooserScreen）");
const s0 = poolSlot(0), s1 = poolSlot(1), s8 = poolSlot(8);
check("列距 53", s1.x - s0.x === 53, `实际 ${s1.x - s0.x}`);
check("行距 73", s8.y - s0.y === 73, `实际 ${s8.y - s0.y}`);
check("一行 8 格", s8.x === s0.x, `第 8 格 x=${s8.x}，第 0 格 x=${s0.x}`);
check("卡包 50×70", s0.w === 50 && s0.h === 70);

console.log("\n卡组槽位");
const bank = Array.from({ length: DRAFT_PICK_COUNT }, (_, i) => bankSlot(i));
check("槽位都在画面内",
  bank.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= DRAFT_W && r.y + r.h <= DRAFT_H));
check("槽位横向间距 59（原版卡槽间距）", bank[1]!.x - bank[0]!.x === 59, `实际 ${bank[1]!.x - bank[0]!.x}`);

let bankOverlap = "";
for (let i = 0; i < bank.length && !bankOverlap; i++) {
  for (let j = i + 1; j < bank.length; j++) {
    const a = bank[i]!, b = bank[j]!;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
      bankOverlap = `槽 ${i} 与槽 ${j} 重叠`;
      break;
    }
  }
}
check("槽位互不重叠", bankOverlap === "", bankOverlap);

// 卡池格和卡组槽必须彻底分开：点错区域会直接选错卡，是会毁掉一局的错。
let crossOverlap = "";
for (const b of bank) {
  const clash = rects.findIndex((r) =>
    r.x < b.x + b.w && b.x < r.x + r.w && r.y < b.y + b.h && b.y < r.y + r.h);
  if (clash >= 0) { crossOverlap = `卡组槽压在第 ${clash} 个卡格上`; break; }
}
check("卡组槽不压在任何卡格上", crossOverlap === "", crossOverlap);

const btn = confirmRect();
check("点确认按钮返回 confirm",
  hitDraft(cards, btn.x + btn.w / 2, btn.y + btn.h / 2) === "confirm");
check("确认按钮不落在任何卡格上",
  rects.every((r) => !(btn.x + btn.w / 2 >= r.x && btn.x + btn.w / 2 < r.x + r.w
    && btn.y + btn.h / 2 >= r.y && btn.y + btn.h / 2 < r.y + r.h)));
check("确认按钮不压在卡组槽上",
  bank.every((r) => !(btn.x < r.x + r.w && r.x < btn.x + btn.w
    && btn.y < r.y + r.h && r.y < btn.y + btn.h)));

console.log(failures === 0 ? "\n全部通过 ✓" : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
