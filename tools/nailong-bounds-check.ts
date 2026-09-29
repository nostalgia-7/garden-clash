/**
 * 奶龙程序化外观的落位自检。用
 *   npx tsx tools/nailong-bounds-check.ts
 * 运行（要走 tsx，因为它 import 的 src/render.ts 用了构造函数参数属性，
 * node 的 --experimental-strip-types 处理不了）。
 *
 * 奶龙不是 reanim 角色，render_check.py 检不到它。这里用一个假的
 * CanvasRenderingContext2D 录下所有绘制点并换算到世界坐标，验证：
 * 脚底压在路线上、水平居中、整体落在 VISUAL_LAYOUT 声明的包围盒里。
 * 这三条错了，奶龙在草坪上就会浮空、下沉或者偏出格子。
 */

import { NailongVisual, VISUAL_LAYOUT } from "../src/render.ts";

/** 2x3 仿射矩阵，跟 canvas 的 transform 语义一致。 */
interface M { a: number; b: number; c: number; d: number; e: number; f: number }

const unit = (): M => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
const mul = (m: M, n: M): M => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});

class MockCtx {
  private m: M = unit();
  private readonly stack: M[] = [];
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;

  // 绘制状态属性，只需要能被赋值即可。
  filter = "none";
  globalAlpha = 1;
  fillStyle: unknown = "";
  strokeStyle: unknown = "";
  lineWidth = 1;

  save(): void { this.stack.push({ ...this.m }); }
  restore(): void { this.m = this.stack.pop() ?? unit(); }
  translate(x: number, y: number): void { this.m = mul(this.m, { ...unit(), e: x, f: y }); }
  scale(x: number, y: number): void { this.m = mul(this.m, { ...unit(), a: x, d: y }); }
  rotate(r: number): void {
    this.m = mul(this.m, { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 });
  }

  private mark(x: number, y: number): void {
    const wx = this.m.a * x + this.m.c * y + this.m.e;
    const wy = this.m.b * x + this.m.d * y + this.m.f;
    this.minX = Math.min(this.minX, wx); this.maxX = Math.max(this.maxX, wx);
    this.minY = Math.min(this.minY, wy); this.maxY = Math.max(this.maxY, wy);
  }

  beginPath(): void { /* 只统计坐标，不需要真的建路径 */ }
  closePath(): void { /* 同上 */ }
  fill(): void { /* 同上 */ }
  stroke(): void { /* 同上 */ }
  moveTo(x: number, y: number): void { this.mark(x, y); }
  lineTo(x: number, y: number): void { this.mark(x, y); }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void { this.mark(cx, cy); this.mark(x, y); }
  rect(x: number, y: number, w: number, h: number): void { this.mark(x, y); this.mark(x + w, y + h); }
  arc(x: number, y: number, r: number): void { this.mark(x - r, y - r); this.mark(x + r, y + r); }
  ellipse(x: number, y: number, rx: number, ry: number): void {
    this.mark(x - rx, y - ry); this.mark(x + rx, y + ry);
  }
  createRadialGradient(): { addColorStop(): void } { return { addColorStop() { /* 颜色不影响几何 */ } }; }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const FEET_X = 700;
const FEET_Y = 400;
const { bounds, scale } = VISUAL_LAYOUT.nailong;
const boxW = (bounds[2] - bounds[0]) * scale;
const boxH = (bounds[3] - bounds[1]) * scale;

console.log("奶龙落位自检");
for (const state of ["move", "laugh"]) {
  const visual = new NailongVisual(state);
  visual.advance(0.35);
  const ctx = new MockCtx();
  visual.draw(ctx as unknown as CanvasRenderingContext2D, null as never, "nailong", FEET_X, FEET_Y);

  const w = ctx.maxX - ctx.minX;
  const h = ctx.maxY - ctx.minY;
  const centerX = (ctx.minX + ctx.maxX) / 2;

  // 脚底允许几像素余量：走路起伏本来就会让身体上下动。
  check(`${state}：脚底压在路线上`, Math.abs(ctx.maxY - FEET_Y) <= 6,
    `底边 ${ctx.maxY.toFixed(1)}，路线 ${FEET_Y}`);
  check(`${state}：水平居中于落点`, Math.abs(centerX - FEET_X) <= 10,
    `中心 ${centerX.toFixed(1)}，落点 ${FEET_X}`);
  check(`${state}：整体不超出声明的包围盒`, w <= boxW + 12 && h <= boxH + 12,
    `实际 ${w.toFixed(1)}x${h.toFixed(1)}，声明 ${boxW.toFixed(1)}x${boxH.toFixed(1)}`);
  check(`${state}：体型与普通僵尸同量级`, h > 60 && h < 120, `高 ${h.toFixed(1)}px`);
}

// 死亡时向后倒，不该还站得笔直。
const dying = new NailongVisual("death");
dying.advance(0.6);
const dctx = new MockCtx();
dying.draw(dctx as unknown as CanvasRenderingContext2D, null as never, "nailong", FEET_X, FEET_Y);
check("death：倒地后重心明显偏离站姿", dctx.maxY - FEET_Y > -2 && dctx.minY > FEET_Y - boxH,
  `顶边 ${dctx.minY.toFixed(1)}`);

console.log("");
if (failures === 0) {
  console.log("全部通过 ✓");
  process.exit(0);
}
console.log(`${failures} 项失败 ✗`);
process.exit(1);
