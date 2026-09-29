/**
 * 经典图鉴书页。
 *
 * 版式坐标全部取自原版（800×600 画布），和素材里的 Almanac_*.jpg 书页底图一一对应：
 *
 *   植物索引格   x = i % 8 * 52 + 26,  y = ⌊i / 8⌋ * 78 + 92,  卡片 50×70
 *   僵尸索引格   x = i % 5 * 85 + 22,  y = ⌊i / 5⌋ * 80 + 86,  格子 76×76
 *   植物详情     卡框 (459, 86)  地面 (521, 107)  角色锚点 (578, 140)
 *                名字 (617, 288) 居中   描述 (485, 309, 258, 230)
 *                花费 (485, 520, 134, 50) 左   冷却 (600, 520, 139, 50) 右
 *   僵尸详情     卡框 (455, 78)  角色锚点 (559, 175)
 *                名字 (613, 362) 居中   描述 (484, 377, 258, 170)
 *
 * 整页按 800×600 画，再由 CSS 统一缩放，所以在任何屏幕上比例都不会变形。
 */

import { CARD_VIEW, type CardView } from "./entities.ts";
import { AssetBank, VISUAL_LAYOUT, type UnitVisual } from "./render.ts";
import { ALMANAC_COPY } from "./almanac-data.ts";
import type { Side, UnitKind } from "../shared/cards.ts";

/** 书页画布尺寸，等于原版素材尺寸。 */
export const PAGE_W = 800;
export const PAGE_H = 600;

/** 描述正文的墨水蓝，取自原版 Color(40, 50, 90)。 */
const INK = "#28325a";

/** 详情页角色的放大上限；普通角色都会顶到这个值，从而保持彼此的真实大小关系。 */
const DETAIL_ZOOM = 2.4;

interface SlotLayout { x: number; y: number; w: number; h: number }

/** 索引格分格参数：两侧的列数和行距都不一样，不是同一套。 */
const GRID = {
  plants: { cols: 8, pitchX: 52, pitchY: 78, originX: 26, originY: 92, w: 50, h: 70 },
  zombies: { cols: 5, pitchX: 85, pitchY: 80, originX: 22, originY: 86, w: 76, h: 76 },
} as const;

/** 标题栏中心：两页底图的横幅位置不同，分开量过。 */
const BANNER = {
  plants: { x: 396, y: 42 },
  zombies: { x: 400, y: 50 },
} as const;

export function slotRect(side: Side, index: number): SlotLayout {
  const g = GRID[side];
  return {
    x: (index % g.cols) * g.pitchX + g.originX,
    y: Math.floor(index / g.cols) * g.pitchY + g.originY,
    w: g.w,
    h: g.h,
  };
}

/** 把画布上的点换算回 800×600 书页坐标，用于命中测试。 */
export function hitSlot(side: Side, cards: readonly CardView[], px: number, py: number): UnitKind | null {
  for (let i = 0; i < cards.length; i++) {
    const r = slotRect(side, i);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return cards[i]!.kind;
  }
  return null;
}

/** 按字宽断行，中英文都按实际测量宽度处理。 */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ch === "\n") { lines.push(line); line = ""; continue; }
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawSprite(ctx: CanvasRenderingContext2D, bank: AssetBank, name: string, x: number, y: number): void {
  const e = bank.atlas[name];
  if (!e) return;
  const sheet = bank.sheets[e.p];
  if (!sheet) return;
  ctx.drawImage(sheet, e.x, e.y, e.w, e.h, x + e.ox, y + e.oy, e.w, e.h);
}

export class AlmanacPage {
  /** 每个角色的索引格缩略图，开页时渲染一次后缓存。 */
  private readonly thumbs = new Map<UnitKind, HTMLCanvasElement>();

  constructor(private readonly bank: AssetBank) {}

  /**
   * 画一整页。selected 的角色会在索引格里高亮，并在右页显示详情。
   * visual 是详情页那只正在播动画的角色，由调用方持有并按帧推进。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    side: Side,
    cards: readonly CardView[],
    selected: UnitKind,
    visual: UnitVisual,
  ): void {
    const page = side === "plants" ? this.bank.almanacPlantBack : this.bank.almanacZombieBack;
    if (page) ctx.drawImage(page, 0, 0, PAGE_W, PAGE_H);
    else { ctx.fillStyle = "#e8c9a0"; ctx.fillRect(0, 0, PAGE_W, PAGE_H); }

    this.drawBanner(ctx, side);
    this.drawIndex(ctx, side, cards, selected);
    this.drawDetail(ctx, side, selected, visual);
  }

  private drawBanner(ctx: CanvasRenderingContext2D, side: Side): void {
    const b = BANNER[side];
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 26px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = side === "plants" ? "#ffe9a8" : "#d8f2ff";
    ctx.fillText(side === "plants" ? "植物图鉴" : "僵尸图鉴", b.x, b.y);
    ctx.restore();
  }

  private drawIndex(
    ctx: CanvasRenderingContext2D,
    side: Side,
    cards: readonly CardView[],
    selected: UnitKind,
  ): void {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i]!;
      const r = slotRect(side, i);

      // 僵尸格自带一圈窗框，植物格用书页上印好的虚线框。
      if (side === "zombies") drawSprite(ctx, this.bank, "Almanac_ZombieWindow", r.x, r.y);

      const thumb = this.thumb(card.kind, r.w, r.h);
      if (thumb) ctx.drawImage(thumb, r.x, r.y);

      if (card.kind === selected) {
        ctx.save();
        ctx.strokeStyle = side === "plants" ? "#7a4a1e" : "#3f5f8a";
        ctx.lineWidth = 3;
        ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3);
        ctx.restore();
      }
    }
  }

  /** 索引格缩略图：把角色静态画一帧到离屏画布，缩放到刚好塞进格子。 */
  private thumb(kind: UnitKind, w: number, h: number): HTMLCanvasElement | null {
    const cached = this.thumbs.get(kind);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const card = CARD_VIEW.get(kind);
    const state = kind === "nailong" ? "laugh" : card?.side === "plants" ? "idle" : "move";
    let visual: UnitVisual;
    try {
      visual = this.bank.visual(kind, state);
    } catch {
      return null;
    }

    // 角色原始尺寸大约 100~160px，缩到格子里再留一点边。
    const scale = Math.min(w / 110, h / 130) * 0.95;
    ctx.save();
    ctx.translate(w / 2, h * 0.86);
    ctx.scale(scale, scale);
    visual.draw(ctx, this.bank, kind, 0, 0);
    ctx.restore();

    this.thumbs.set(kind, canvas);
    return canvas;
  }

  private drawDetail(
    ctx: CanvasRenderingContext2D,
    side: Side,
    kind: UnitKind,
    visual: UnitVisual,
  ): void {
    const card = CARD_VIEW.get(kind);
    if (!card) return;
    const copy = ALMANAC_COPY[kind];
    const plants = side === "plants";

    // 右页整块单独裁剪，角色画大了也不会溢到左页索引上。
    ctx.save();
    ctx.beginPath();
    ctx.rect(455, 0, PAGE_W - 455, PAGE_H);
    ctx.clip();

    if (plants) drawSprite(ctx, this.bank, "Almanac_GroundDay", 521, 107);

    // 角色落位。
    //
    // 原版把角色锚点写成 (578,140)/(559,175)，那是一个 80×80 单元格的左上角，
    // 视觉中心在 +40 处；我们的 draw() 语义是「水平居中于 x、脚底落在 y」，
    // 所以换算成中心 x 和格子底边 y。
    //
    // 缩放不写死每个角色：从 VISUAL_LAYOUT 的包围盒算出原生高度，统一放大到
    // 书页该有的尺寸，再用上限夹住——这样普通角色之间保持真实大小关系，
    // 巨人这种超大个也不会顶穿卡框。
    const anchor = plants ? { x: 618, y: 242 } : { x: 613, y: 285 };
    const layout = VISUAL_LAYOUT[kind];
    const naturalH = (layout.bounds[3] - layout.bounds[1]) * layout.scale;
    // 卡框窗口内区约 100..250（植物）/ 110..290（僵尸），留出余量免得顶穿框。
    const scale = Math.min(DETAIL_ZOOM, (plants ? 116 : 168) / Math.max(naturalH, 1));
    ctx.save();
    ctx.translate(anchor.x, anchor.y);
    ctx.scale(scale, scale);
    visual.draw(ctx, this.bank, kind, 0, 0);
    ctx.restore();

    drawSprite(ctx, this.bank, plants ? "Almanac_PlantCard" : "Almanac_ZombieCard", plants ? 459 : 455, plants ? 86 : 78);
    ctx.restore();

    // 名字 + 定位排在同一行。
    //
    // 定位原本另起一行画在名字下面，但原版的描述框紧跟在名字下方（植物 309、
    // 僵尸 377），中间根本没有一行的空隙，必然压字。并到一行既不占额外高度，
    // 也不用改动原版那套文字框坐标。
    const centerX = plants ? 617 : 613;
    const nameY = plants ? 288 : 362;
    const nameFont = "700 20px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    const roleFont = "600 12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    const roleText = `  ${copy.role}`;
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = nameFont;
    const nameW = ctx.measureText(card.name).width;
    ctx.font = roleFont;
    const roleW = ctx.measureText(roleText).width;
    let cursor = centerX - (nameW + roleW) / 2;
    ctx.font = nameFont;
    ctx.fillStyle = plants ? "#ffffff" : "#beffeb";
    ctx.fillText(card.name, cursor, nameY);
    cursor += nameW;
    ctx.font = roleFont;
    ctx.fillStyle = plants ? "#f2d9a0" : "#9ed9c6";
    ctx.fillText(roleText, cursor, nameY + 1);
    ctx.restore();

    // 描述 + 攻击方式，都排在原版那个文字框里。
    // 原版这个框的高度会一直盖到 y=539，跟底部花费行（y=520）是重叠的——
    // 因为原版描述短，撞不上。我们还要多排攻击方式和数值，所以把下边界收到
    // 花费行上方，宁可截断也不压字。
    const TEXT_BOTTOM = 514;
    const box = plants
      ? { x: 485, y: 309, w: 258, h: TEXT_BOTTOM - 309 }
      : { x: 484, y: 377, w: 258, h: TEXT_BOTTOM - 377 };
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = INK;
    ctx.font = "13px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    let y = box.y;
    const lineH = 17;
    for (const line of wrapText(ctx, copy.description, box.w)) {
      if (y + lineH > box.y + box.h) break;
      ctx.fillText(line, box.x, y);
      y += lineH;
    }
    y += 6;
    ctx.font = "700 12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    if (y + lineH <= box.y + box.h) { ctx.fillText("攻击方式", box.x, y); y += lineH; }
    ctx.font = "13px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    for (const line of wrapText(ctx, copy.attack, box.w)) {
      if (y + lineH > box.y + box.h) break;
      ctx.fillText(line, box.x, y);
      y += lineH;
    }

    // 数值：原版这里只有花费和冷却，我们多几项，接着往下排
    y += 4;
    ctx.font = "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    for (const stat of statLines(card)) {
      if (y + 15 > box.y + box.h) break;
      ctx.fillText(stat, box.x, y);
      y += 15;
    }
    ctx.restore();

    // 花费和冷却按原版摆在书页底部两侧。
    // 两边都用描述正文那个墨水蓝——原版花费是白字，但那是配深色底纹的，
    // 我们这里底下是浅色纸面，白字会糊掉。
    ctx.save();
    ctx.textBaseline = "top";
    ctx.font = "700 14px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.fillText(`${plants ? "阳光" : "脑力"}：${card.cost}`, 485, 520);
    ctx.textAlign = "right";
    ctx.fillText(`冷却：${card.cooldown} 秒`, 739, 520);
    ctx.restore();
  }
}

function statLines(card: CardView): string[] {
  const out = [`生命 ${card.hp}`];
  if (card.damage !== undefined) out.push(`伤害 ${card.damage}`);
  if (card.attackEvery !== undefined) out.push(`攻击间隔 ${card.attackEvery} 秒`);
  if (card.speed !== undefined) out.push(`移速 ${card.speed} 像素/秒`);
  if (card.range !== undefined) out.push(`射程 ${card.range} 像素`);
  // 两项一行，省竖向空间
  const packed: string[] = [];
  for (let i = 0; i < out.length; i += 2) {
    packed.push(out.slice(i, i + 2).join("　　"));
  }
  return packed;
}
