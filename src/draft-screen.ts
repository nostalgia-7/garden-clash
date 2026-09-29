/**
 * 战前选卡界面（Ban / Pick）。
 *
 * 分格取自原版 SeedChooserScreen：
 *   卡池格   x = col * 53 + 22,  y = row * 73 + 128（相对选卡面板）
 *   卡包尺寸 50 × 70
 *   卡槽条   第 idx 张卡 x = idx * 59 + 85（≤7 张时的间距）
 *
 * 和图鉴一样按 800×600 画，再由 CSS 等比缩放。
 *
 * 这里只负责画和命中测试；选了什么、能不能选、什么时候提交，全都还在
 * game.ts 原来那套状态机里，服务器的 Ban/Pick 权威逻辑一行没动。
 */

import { CARD_VIEW } from "./entities.ts";
import { AssetBank, VISUAL_LAYOUT, type UnitVisual } from "./render.ts";
import type { UnitKind } from "../shared/cards.ts";

export const DRAFT_W = 800;
export const DRAFT_H = 600;

/** 卡包尺寸，原版 SEED_PACKET_WIDTH/HEIGHT。 */
const CARD_W = 50;
const CARD_H = 70;

/** 选卡面板在画面里的位置。面板本身是 465×513 的原版素材。 */
const PANEL = { x: 18, y: 80, w: 465, h: 513 };

/** 卡池分格：原版 8 列，列距 53、行距 73。 */
const POOL = { cols: 8, pitchX: 53, pitchY: 73, originX: PANEL.x + 22, originY: PANEL.y + 34 };

/**
 * 已选卡组那一条，摆在面板下半部分。
 * 用原版的 SeedBank 素材（446×87）打底，卡包间距沿用原版的 59——
 * 6 张正好排成一行，和原版顶部卡槽是同一个视觉语言。
 */
const BANK = { stripX: PANEL.x + 10, stripY: 300, x: PANEL.x + 30, y: 309, pitch: 59 };

/** 确认按钮，用原版 SeedChooser_Button（156×41）。 */
const CONFIRM = { x: PANEL.x + Math.round((PANEL.w - 156) / 2), y: 452, w: 156, h: 41 };

/** 右栏：展示本局被禁用的那张卡，放大到 2 倍卡包大小。 */
const BANNED_VIEW = { x: 560, y: 150, w: 100, h: 140 };

export interface DraftCardState {
  kind: UnitKind;
  selected: boolean;
  banned: boolean;
  disabled: boolean;
}

function sprite(ctx: CanvasRenderingContext2D, bank: AssetBank, name: string, x: number, y: number, w?: number, h?: number): void {
  const e = bank.atlas[name];
  if (!e) return;
  const sheet = bank.sheets[e.p];
  if (!sheet) return;
  if (w === undefined || h === undefined) {
    ctx.drawImage(sheet, e.x, e.y, e.w, e.h, x + e.ox, y + e.oy, e.w, e.h);
  } else {
    // 按目标框缩放时，裁边留下的 ox/oy 也要跟着缩放，否则会错位。
    const full = e.w + e.ox, fullH = e.h + e.oy;
    const sx = w / full, sy = h / fullH;
    ctx.drawImage(sheet, e.x, e.y, e.w, e.h, x + e.ox * sx, y + e.oy * sy, e.w * sx, e.h * sy);
  }
}

export function poolSlot(index: number): { x: number; y: number; w: number; h: number } {
  return {
    x: (index % POOL.cols) * POOL.pitchX + POOL.originX,
    y: Math.floor(index / POOL.cols) * POOL.pitchY + POOL.originY,
    w: CARD_W,
    h: CARD_H,
  };
}

export function bankSlot(index: number): { x: number; y: number; w: number; h: number } {
  return { x: BANK.x + index * BANK.pitch, y: BANK.y, w: CARD_W, h: CARD_H };
}

/** 确认按钮热区。导出给版式自检用，免得那边再抄一份常量抄错。 */
export function confirmRect(): { x: number; y: number; w: number; h: number } {
  return { ...CONFIRM };
}

/** 点击命中：返回点到的卡，或 "confirm"，都没点到就是 null。 */
export function hitDraft(cards: readonly DraftCardState[], px: number, py: number): UnitKind | "confirm" | null {
  if (px >= CONFIRM.x && px < CONFIRM.x + CONFIRM.w && py >= CONFIRM.y && py < CONFIRM.y + CONFIRM.h) {
    return "confirm";
  }
  for (let i = 0; i < cards.length; i++) {
    const r = poolSlot(i);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return cards[i]!.kind;
  }
  return null;
}

export class DraftScreen {
  /** 卡包缩略图缓存，key 是 kind。 */
  private readonly thumbs = new Map<UnitKind, HTMLCanvasElement>();

  constructor(private readonly bank: AssetBank) {}

  draw(
    ctx: CanvasRenderingContext2D,
    opts: {
      title: string;
      instruction: string;
      status: string;
      seconds: number;
      cards: readonly DraftCardState[];
      picks: readonly UnitKind[];
      /** 右栏展示的那张被禁用的卡，以及它的说明标题。 */
      banned: UnitKind | null;
      bannedLabel: string;
      /** Ban 阶段没有卡组可言，卡槽条整条隐藏。 */
      showBank: boolean;
      confirmLabel: string;
      confirmEnabled: boolean;
      showConfirm: boolean;
      spectator: boolean;
    },
  ): void {
    ctx.clearRect(0, 0, DRAFT_W, DRAFT_H);

    // 底：深色草地夜景，跟主菜单同一套色调
    const bg = ctx.createLinearGradient(0, 0, 0, DRAFT_H);
    bg.addColorStop(0, "#25402c");
    bg.addColorStop(1, "#0d160f");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, DRAFT_W, DRAFT_H);

    this.drawHeader(ctx, opts.title, opts.instruction, opts.seconds);

    sprite(ctx, this.bank, "SeedChooser_Background", PANEL.x, PANEL.y);

    if (opts.spectator) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = "#e6f0d4";
      ctx.font = "600 20px 'Segoe UI', 'Microsoft YaHei', sans-serif";
      ctx.fillText("观战席只读", PANEL.x + PANEL.w / 2, PANEL.y + 180);
      ctx.font = "15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
      ctx.fillText("等待双方完成 Ban / Pick…", PANEL.x + PANEL.w / 2, PANEL.y + 212);
      ctx.restore();
    } else {
      this.drawPool(ctx, opts.cards);
    }

    this.drawBank(ctx, opts.picks, opts.showBank);
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#cfe0bc";
    ctx.font = "13px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText(opts.status, PANEL.x + PANEL.w / 2, 428);
    ctx.restore();

    this.drawBannedView(ctx, opts.banned, opts.bannedLabel);

    if (opts.showConfirm) this.drawConfirm(ctx, opts.confirmLabel, opts.confirmEnabled);
  }

  /** 右栏：把本局被禁用的卡放大展示，提醒双方这张不能用。 */
  private drawBannedView(ctx: CanvasRenderingContext2D, kind: UnitKind | null, label: string): void {
    const v = BANNED_VIEW;
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#dbe8c6";
    ctx.font = "700 16px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText(label, v.x + v.w / 2, v.y - 18);
    ctx.restore();

    if (!kind) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "#ffffff33";
      ctx.lineWidth = 2;
      ctx.strokeRect(v.x, v.y, v.w, v.h);
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.fillStyle = "#8b9a82";
      ctx.font = "13px 'Segoe UI', 'Microsoft YaHei', sans-serif";
      ctx.fillText("尚未选择", v.x + v.w / 2, v.y + v.h / 2);
      ctx.restore();
      return;
    }

    // 复用卡包画法，整体放大到 2 倍
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.w / CARD_W, v.h / CARD_H);
    this.drawPacket(ctx, kind, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "#f4e5c4";
    ctx.font = "700 15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText(CARD_VIEW.get(kind)?.name ?? kind, v.x + v.w / 2, v.y + v.h + 22);
    ctx.restore();
  }

  private drawHeader(ctx: CanvasRenderingContext2D, title: string, instruction: string, seconds: number): void {
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#e9f5b8";
    ctx.font = "800 30px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText(title, PANEL.x, 46);
    ctx.fillStyle = "#b9cca9";
    ctx.font = "15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText(instruction, PANEL.x, 72);

    // 倒计时：最后 10 秒转红提醒
    const urgent = seconds <= 10;
    ctx.textAlign = "center";
    ctx.beginPath();
    ctx.arc(DRAFT_W - 74, 48, 36, 0, Math.PI * 2);
    ctx.fillStyle = urgent ? "#5c2320" : "#2c3a26";
    ctx.fill();
    ctx.fillStyle = urgent ? "#ffb4a8" : "#f6ed9f";
    ctx.font = "800 30px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.max(0, seconds)), DRAFT_W - 74, 52);
    ctx.font = "11px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = "#9fb094";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("剩余秒", DRAFT_W - 74, 22);
    ctx.restore();
  }

  private drawPool(ctx: CanvasRenderingContext2D, cards: readonly DraftCardState[]): void {
    for (let i = 0; i < cards.length; i++) {
      const state = cards[i]!;
      const r = poolSlot(i);
      this.drawPacket(ctx, state.kind, r.x, r.y, {
        dim: state.disabled || state.banned,
        selected: state.selected,
        banned: state.banned,
      });
    }
  }

  /** 一张卡包：底纹 + 角色缩略 + 费用数字，再叠状态。 */
  private drawPacket(
    ctx: CanvasRenderingContext2D,
    kind: UnitKind,
    x: number,
    y: number,
    flags: { dim?: boolean; selected?: boolean; banned?: boolean } = {},
  ): void {
    const card = CARD_VIEW.get(kind);
    ctx.save();
    if (flags.dim) ctx.globalAlpha = 0.42;

    sprite(ctx, this.bank, "SeedPacketSilhouette", x, y, CARD_W, CARD_H);
    // 卡面底色，压在剪影上，让角色更清楚
    ctx.fillStyle = "#efe2b4";
    ctx.fillRect(x + 3, y + 3, CARD_W - 6, CARD_H - 20);

    const thumb = this.thumb(kind);
    if (thumb) ctx.drawImage(thumb, x + 3, y + 2);

    // 费用条
    ctx.fillStyle = "#2f3a22";
    ctx.fillRect(x + 3, y + CARD_H - 17, CARD_W - 6, 14);
    ctx.fillStyle = "#f6f1c8";
    ctx.font = "700 11px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(card?.cost ?? ""), x + CARD_W / 2, y + CARD_H - 10);
    ctx.restore();

    if (flags.selected) {
      ctx.save();
      ctx.strokeStyle = "#b6e04f";
      ctx.lineWidth = 3;
      ctx.strokeRect(x - 1.5, y - 1.5, CARD_W + 3, CARD_H + 3);
      ctx.restore();
    }
    if (flags.banned) {
      ctx.save();
      ctx.strokeStyle = "#e2503f";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + CARD_W - 4, y + CARD_H - 4);
      ctx.moveTo(x + CARD_W - 4, y + 4); ctx.lineTo(x + 4, y + CARD_H - 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** 角色缩略图，画进卡包上半部分。 */
  private thumb(kind: UnitKind): HTMLCanvasElement | null {
    const cached = this.thumbs.get(kind);
    if (cached) return cached;

    const w = CARD_W - 6, h = CARD_H - 22;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const card = CARD_VIEW.get(kind);
    const state = kind === "nailong" ? "laugh" : card?.side === "plants" ? "idle" : "move";
    let visual: UnitVisual;
    try { visual = this.bank.visual(kind, state); } catch { return null; }

    const layout = VISUAL_LAYOUT[kind];
    const naturalH = (layout.bounds[3] - layout.bounds[1]) * layout.scale;
    const scale = Math.min(1.5, (h - 4) / Math.max(naturalH, 1));
    ctx.save();
    ctx.translate(w / 2, h - 2);
    ctx.scale(scale, scale);
    visual.draw(ctx, this.bank, kind, 0, 0);
    ctx.restore();

    this.thumbs.set(kind, canvas);
    return canvas;
  }

  private drawBank(ctx: CanvasRenderingContext2D, picks: readonly UnitKind[], show: boolean): void {
    if (!show) return;
    // 原版的卡槽条素材，宽 446，正好卡在面板里
    sprite(ctx, this.bank, "SeedBank", BANK.stripX, BANK.stripY);

    ctx.save();
    ctx.textAlign = "left";
    ctx.fillStyle = "#dbe8c6";
    ctx.font = "700 15px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillText("本局卡组", BANK.stripX, BANK.stripY - 12);
    ctx.restore();

    for (let i = 0; i < 6; i++) {
      const r = bankSlot(i);
      const kind = picks[i];
      if (kind) {
        this.drawPacket(ctx, kind, r.x, r.y);
      } else {
        ctx.save();
        ctx.globalAlpha = 0.28;
        sprite(ctx, this.bank, "SeedPacketSilhouette", r.x, r.y, CARD_W, CARD_H);
        ctx.restore();
      }
    }
  }

  private drawConfirm(ctx: CanvasRenderingContext2D, label: string, enabled: boolean): void {
    sprite(ctx, this.bank, enabled ? "SeedChooser_Button" : "SeedChooser_Button_Disabled",
      CONFIRM.x, CONFIRM.y, CONFIRM.w, CONFIRM.h);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 16px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = enabled ? "#22300f" : "#5c6350";
    ctx.fillText(label, CONFIRM.x + CONFIRM.w / 2, CONFIRM.y + CONFIRM.h / 2 + 1);
    ctx.restore();
  }
}
