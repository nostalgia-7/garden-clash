/**
 * 渲染层：把 reanim 动画画到画布上。这里只管画，不含任何战斗规则
 * （规则在 shared/sim.ts，服务器与本地共用）。
 *
 * 内容原样来自改造前的 src/game.ts，行为不变：
 * - VISUAL_LAYOUT：各单位动画的真实包围盒与缩放，用于换算绘制原点。
 * - Visual：按 shared/skins.json 的状态声明播放动画。
 * - AssetBank：加载图集、背景与各角色动画数据。
 */

import { Reanim, type Atlas, type ReanimDoc, type TrackTransform } from "./reanim.ts";
import { SKINS, type Skin, type SkinState } from "../shared/skins.ts";
import type { UnitKind } from "../shared/cards.ts";
import {
  PROCEDURAL_LAYOUT, MimicSunflowerVisual, ShadowstrikeVisual, ShieldBambooVisual, ZhongkuiVisual,
} from "./unit-art.ts";

/** 巨人投出小鬼后要隐藏的挂件轨道。 */
export const GARGANTUAR_IMP_TRACKS = [
  "Zombie_imp_innerarm_upper", "Zombie_imp_innerarm_lower",
  "Zombie_imp_outerarm_upper", "Zombie_imp_outerarm_lower",
  "Zombie_imp_innerleg_foot", "Zombie_imp_innerleg_lower", "Zombie_imp_innerleg_upper",
  "Zombie_imp_outerleg_foot", "Zombie_imp_outerleg_lower", "Zombie_imp_outerleg_upper",
  "Zombie_imp_body1", "Zombie_imp_body2", "Zombie_imp_head", "Zombie_imp_jaw",
];

export type SkinName = UnitKind | "lawnmower";

export interface VisualLayout {
  /** 离线渲染得到的原始动画包围盒 [left, top, right, bottom]。 */
  bounds: readonly [number, number, number, number];
  scale: number;
}

/**
 * reanim 的 (0, 0) 不是角色中心：豌豆射手的图像位于原点右下方，
 * 撑杆僵尸甚至会跨到原点左侧。用真实包围盒换算绘制原点，避免共用一组
 * 猜出来的 translate 导致单位跑到格子左上角。
 */
export const VISUAL_LAYOUT: Record<SkinName, VisualLayout> = {
  sunflower:   { bounds: [6, 5, 80, 79], scale: .70 },
  peashooter:  { bounds: [3, 10, 81, 79], scale: .70 },
  snowpea:     { bounds: [6, 9, 80, 79], scale: .70 },
  threepeater: { bounds: [6, -1, 79, 77], scale: .70 },
  wallnut:     { bounds: [11, 4, 75, 76], scale: .70 },
  tallnut:     { bounds: [-1, -37, 80, 82], scale: .70 },
  potatomine:  { bounds: [-9, 28, 85, 80], scale: .70 },
  squash:      { bounds: [5, -5, 77, 80], scale: .70 },
  cherrybomb:  { bounds: [-2, 4, 86, 71], scale: .70 },
  jalapeno:    { bounds: [16, 3, 64, 79], scale: .70 },
  zombie:      { bounds: [0, 2, 89, 126], scale: .70 },
  conehead:    { bounds: [0, -17, 89, 126], scale: .70 },
  buckethead:  { bounds: [-5, -15, 89, 126], scale: .70 },
  screendoor:  { bounds: [-16, 2, 89, 131], scale: .70 },
  newspaper:   { bounds: [-12, -5, 89, 133], scale: .70 },
  dancer:      { bounds: [19, -14, 101, 132], scale: .70 },
  backupdancer: { bounds: [19, -14, 101, 132], scale: .70 },
  polevaulter: { bounds: [-88, -11, 116, 139], scale: .70 },
  football:    { bounds: [-24, -20, 133, 140], scale: .70 },
  gargantuar:  { bounds: [-55, -63, 160, 146], scale: .74 },
  imp:         { bounds: [18, -18, 134, 129], scale: .70 },
  // 奶龙没有 reanim 素材，由 NailongVisual 程序化绘制，包围盒即绘制用的局部坐标框。
  nailong:     { bounds: [0, 0, 80, 112], scale: .80 },
  // 这三只僵尸以原版普通僵尸为本体，所以用和它一模一样的框，本体才能严丝合缝对齐。
  shadowstrike:   { bounds: [0, 2, 89, 126], scale: .70 },
  zhongkui:       { bounds: [0, 2, 89, 126], scale: .70 },
  mimicsunflower: { bounds: [0, 2, 89, 126], scale: .70 },
  lawnmower:   { bounds: [-4, 3, 81, 72], scale: .76 },
  // 机关盾竹是程序化绘制，包围盒和画法一起放在 unit-art.ts。
  ...PROCEDURAL_LAYOUT,
};

/** 单位视觉顶端的 Y，用于把血条放在头顶。 */
export function visualTop(kind: SkinName, feetY: number): number {
  const { bounds, scale } = VISUAL_LAYOUT[kind];
  return feetY - (bounds[3] - bounds[1]) * scale;
}

function loadImage(src: string): Promise<HTMLImageElement> {  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败：${src}`));
    image.src = src;
  });
}

async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json() as Promise<T>;
}

/**
 * 一个可播放的单位外观。绝大多数单位是 reanim 驱动的 Visual；
 * 奶龙没有原版素材，用 NailongVisual 程序化画，两者对外接口一致。
 */
export interface UnitVisual {
  readonly currentState: string;
  setState(state: string, restart?: boolean): void;
  advance(dt: number): void;
  hideTracks(names: string[]): void;
  draw(
    ctx: CanvasRenderingContext2D,
    bank: AssetBank,
    kind: SkinName,
    x: number,
    y: number,
    alpha?: number,
    filter?: string,
  ): void;
}

export class Visual implements UnitVisual {
  private animation: Reanim;
  private state = "";
  private extraHidden: string[] = [];
  constructor(
    private readonly doc: ReanimDoc,
    private readonly skin: Skin,
    initial: string,
  ) {
    this.animation = new Reanim(doc);
    this.setState(initial, true);
  }

  get currentState(): string { return this.state; }

  setState(state: string, restart = false): void {
    if (this.state === state && !restart) return;
    const spec = this.skin.states[state] ?? this.skin.states[Object.keys(this.skin.states)[0] ?? ""];
    if (!spec) return;
    this.state = state;
    this.animation = new Reanim(this.doc);
    this.apply(spec, restart);
  }

  private apply(spec: SkinState, restart: boolean): void {
    this.animation
      .setHidden([...this.skin.hidden, ...this.extraHidden])
      .setParts([...this.skin.parts, ...(spec.parts ?? [])]);
    const loop = spec.loop ?? true;
    if (spec.range) this.animation.playRange(spec.range[0], spec.range[1], { loop });
    else this.animation.play(spec.sections ?? [], { restart, loop });
  }

  advance(dt: number): void { this.animation.advance(dt); }

  /** 某条骨骼在当前帧的变换，供叠加配件的外观对齐用。 */
  trackTransform(name: string): TrackTransform | null {
    return this.animation.trackTransform(name);
  }

  hideTracks(names: string[]): void {
    const before = this.extraHidden.length;
    this.extraHidden = [...new Set([...this.extraHidden, ...names])];
    if (this.extraHidden.length !== before) {
      this.animation.setHidden([...this.skin.hidden, ...this.extraHidden]);
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    bank: AssetBank,
    kind: SkinName,
    x: number,
    y: number,
    alpha = 1,
    filter = "none",
  ): void {
    const { bounds, scale } = VISUAL_LAYOUT[kind];
    const centerX = (bounds[0] + bounds[2]) / 2;
    ctx.save();
    ctx.filter = filter;
    // 原版植物朝右、僵尸朝左，素材方向正好符合战场，不需要额外镜像。
    ctx.translate(x - centerX * scale, y - bounds[3] * scale);
    ctx.scale(scale, scale);
    this.animation.draw(ctx, bank.sheets, bank.atlas, { alpha });
    ctx.restore();
  }
}

/**
 * 奶龙僵尸的程序化外观。
 *
 * 原版素材里没有这个角色，网上那张参考图带水印且分辨率很低，不适合直接进游戏，
 * 所以这里用 Canvas 路径画一只黄色小龙：站着走、大笑蓄力时张嘴发光、倒下时后仰。
 * 全部是我们自己画的图形，没有任何版权素材依赖。
 */
export class NailongVisual implements UnitVisual {
  private state = "move";
  private phase = 0;

  constructor(initial: string) {
    this.state = initial || "move";
  }

  get currentState(): string { return this.state; }

  setState(state: string, restart = false): void {
    if (this.state === state && !restart) return;
    this.state = state;
    this.phase = 0;
  }

  advance(dt: number): void { this.phase += dt; }

  /** 程序化角色没有可隐藏的骨骼轨道，留空实现以满足统一接口。 */
  hideTracks(): void { /* 无挂件可隐藏 */ }

  draw(
    ctx: CanvasRenderingContext2D,
    _bank: AssetBank,
    kind: SkinName,
    x: number,
    y: number,
    alpha = 1,
    filter = "none",
  ): void {
    const { bounds, scale } = VISUAL_LAYOUT[kind];
    const centerX = (bounds[0] + bounds[2]) / 2;
    const laughing = this.state === "laugh";
    const dying = this.state === "death";
    // 走路上下轻微起伏；大笑时抖得更快，看起来在“哈哈哈”。
    const bob = dying ? 0 : Math.sin(this.phase * (laughing ? 14 : 6)) * (laughing ? 2.5 : 1.8);

    ctx.save();
    ctx.filter = filter;
    ctx.globalAlpha = alpha * (dying ? Math.max(0, 1 - this.phase / 1.4) : 1);
    ctx.translate(x - centerX * scale, y - bounds[3] * scale);
    ctx.scale(scale, scale);
    if (dying) {
      // 死亡时以脚为轴向后倒。
      ctx.translate(40, 112);
      ctx.rotate(Math.min(this.phase * 1.6, 1.35));
      ctx.translate(-40, -112);
    }
    ctx.translate(0, bob);

    const YELLOW = "#ffd84a";
    const YELLOW_DARK = "#f0b81f";
    const BELLY = "#fff2b8";

    // 尾巴（身后，朝右）
    ctx.fillStyle = YELLOW_DARK;
    ctx.beginPath();
    ctx.moveTo(58, 92);
    ctx.quadraticCurveTo(80, 88, 76, 68);
    ctx.quadraticCurveTo(70, 82, 56, 82);
    ctx.closePath();
    ctx.fill();

    // 双脚
    ctx.fillStyle = YELLOW_DARK;
    for (const fx of [28, 50]) {
      ctx.beginPath();
      ctx.ellipse(fx, 106, 11, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 身体
    ctx.fillStyle = YELLOW;
    ctx.beginPath();
    ctx.ellipse(40, 82, 25, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BELLY;
    ctx.beginPath();
    ctx.ellipse(37, 86, 15, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    // 小翅膀（身后）
    ctx.fillStyle = YELLOW_DARK;
    ctx.beginPath();
    ctx.moveTo(60, 70);
    ctx.quadraticCurveTo(74, 60, 70, 78);
    ctx.closePath();
    ctx.fill();

    // 头
    ctx.fillStyle = YELLOW;
    ctx.beginPath();
    ctx.ellipse(40, 40, 30, 28, 0, 0, Math.PI * 2);
    ctx.fill();

    // 头顶小角
    ctx.fillStyle = "#ff9c2a";
    ctx.beginPath();
    ctx.moveTo(36, 14);
    ctx.lineTo(43, 14);
    ctx.lineTo(40, 4);
    ctx.closePath();
    ctx.fill();

    // 眼睛（朝左，也就是朝植物）
    ctx.fillStyle = "#2b2118";
    for (const ex of [22, 38]) {
      ctx.beginPath();
      ctx.ellipse(ex, 36, laughing ? 3.6 : 4.2, laughing ? 2.2 : 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#ffffff";
    for (const ex of [21, 37]) {
      ctx.beginPath();
      ctx.ellipse(ex - 1, 34, 1.5, 1.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 腮红
    ctx.fillStyle = "rgba(255,120,120,.55)";
    ctx.beginPath();
    ctx.ellipse(15, 46, 6, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // 嘴：平时咧嘴笑，大笑时张成圆口并透出光
    ctx.fillStyle = "#7a2b2b";
    ctx.beginPath();
    if (laughing) {
      const open = 6 + Math.abs(Math.sin(this.phase * 14)) * 4;
      ctx.ellipse(24, 52, 11, open, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.rect(14, 52 - open, 20, 3.2);
      ctx.fill();
    } else {
      ctx.ellipse(26, 50, 10, 5, 0, 0, Math.PI);
      ctx.fill();
    }

    // 大笑时嘴前的蓄能光晕
    if (laughing) {
      const glow = 8 + Math.abs(Math.sin(this.phase * 10)) * 6;
      const grad = ctx.createRadialGradient(10, 52, 1, 10, 52, glow);
      grad.addColorStop(0, "rgba(255,246,180,.95)");
      grad.addColorStop(1, "rgba(255,214,64,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(10, 52, glow, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

export class AssetBank {
  atlas: Atlas = {};
  sheets: HTMLImageElement[] = [];
  background!: HTMLImageElement;
  /** 图鉴书页底图，800×600，与原版版式坐标一一对应。 */
  almanacPlantBack?: HTMLImageElement;
  almanacZombieBack?: HTMLImageElement;
  private readonly docs = new Map<string, ReanimDoc>();

  async load(): Promise<void> {
    const manifest = await loadJson<{ atlasPages: number }>("/assets/manifest.json");
    this.atlas = await loadJson<Atlas>("/assets/atlas.json");
    this.background = await loadImage("/assets/background1.jpg");
    this.sheets = await Promise.all(
      Array.from({ length: manifest.atlasPages }, (_, i) => loadImage(`/assets/atlas-${i}.png`)),
    );
    // 书页底图缺失不该拖垮整局游戏，图鉴那边会退回纯色底。
    [this.almanacPlantBack, this.almanacZombieBack] = await Promise.all([
      loadImage("/assets/Almanac_PlantBack.jpg").catch(() => undefined),
      loadImage("/assets/Almanac_ZombieBack.jpg").catch(() => undefined),
    ]);
    const names = [...new Set(Object.values(SKINS).map((entry) => entry.anim))];
    await Promise.all(names.map(async (name) => {
      this.docs.set(name, await loadJson<ReanimDoc>(`/assets/anim/${name}.json`));
    }));
  }

  visual(kind: SkinName, state: string): UnitVisual {
    // 盾竹没有 reanim，整只程序化画。
    if (kind === "nailong") return new NailongVisual(state);
    if (kind === "shieldbamboo") return new ShieldBambooVisual(state);
    // 这三只以原版普通僵尸为本体（skins.json 里 anim 都是 zombie），再叠配件。
    if (kind === "shadowstrike" || kind === "zhongkui" || kind === "mimicsunflower") {
      const body = this.base(kind, state);
      const layout = VISUAL_LAYOUT.zombie;
      if (kind === "shadowstrike") return new ShadowstrikeVisual(body, layout);
      if (kind === "zhongkui") return new ZhongkuiVisual(body, layout);
      return new MimicSunflowerVisual(body, layout);
    }
    return this.base(kind, state);
  }

  /** 按 skins.json 造一个 reanim 驱动的外观。 */
  private base(kind: SkinName, state: string): Visual {
    const entry = SKINS[kind];
    if (!entry) throw new Error(`缺少 ${kind} 的动画外观`);
    const doc = this.docs.get(entry.anim);
    if (!doc) throw new Error(`缺少 ${entry.anim} 动画数据`);
    return new Visual(doc, entry, state);
  }
}
