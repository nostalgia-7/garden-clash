/**
 * 四个新单位的外观。
 *
 * 机关盾竹没有对应的原版素材，用 canvas 从头画（照 NailongVisual 的路子）。
 * 三只僵尸则以原版普通僵尸的 reanim 为本体，只把配件画在上面——纯程序化拼出来
 * 的四肢在游戏里像机器人，用真身体才像僵尸，而且走路啃食都是原版动作。
 * 造型依据 unit-design-library/models 里的 V1.2 设定稿。
 *
 * 盾竹的包围盒和绘制代码放在同一个文件里：绘制用的是包围盒内的局部坐标，两者
 * 分家就会互相漂。render.ts 把 PROCEDURAL_LAYOUT 并进 VISUAL_LAYOUT。
 */

// 只引类型，不引运行时值：render.ts 反过来要 import 这个文件里的类，
// 两边都取值就成了真正的循环依赖。本体需要的包围盒由构造参数传进来。
import type { AssetBank, SkinName, UnitVisual, Visual, VisualLayout } from "./render.ts";
import type { TrackTransform } from "./reanim.ts";

/**
 * 需要自带包围盒的单位。三只僵尸不在这里——它们直接用普通僵尸的框，
 * 这样本体和原版僵尸严丝合缝地对齐。
 */
export const PROCEDURAL_LAYOUT: Record<"shieldbamboo", VisualLayout> = {
  // 有护盾时比坚果高一截，撑杆跳不过去；破到只剩竹芯就矮下来。
  shieldbamboo: { bounds: [0, 0, 84, 118], scale: .74 },
};

/** 把十六进制色按比例调暗（>1 则调亮），用来从主色推出阴影和叶脉色。 */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, Math.round(v * factor))));
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/** 描边风格：原版角色都是深色粗描边，程序化的也照这个来才不显得脱节。 */
function outline(ctx: CanvasRenderingContext2D, color: string, width = 3): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
}

/** 填一个多边形并描边。 */
function poly(
  ctx: CanvasRenderingContext2D,
  points: readonly [number, number][],
  fill: string,
  stroke?: string,
): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    outline(ctx, stroke);
    ctx.stroke();
  }
}

/** 正多边形顶点，用来画竹甲的六边形护片。 */
function hexPoints(cx: number, cy: number, r: number, squash = 1): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * squash]);
  }
  return pts;
}

/** 圆＋描边。 */
function disc(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  fill: string, stroke?: string, width = 3,
): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    outline(ctx, stroke, width);
    ctx.stroke();
  }
}

/** 僵尸那对一大一小、不对称的眼白＋瞳孔。三个新僵尸共用，保证一眼是同一族。 */
function zombieEyes(
  ctx: CanvasRenderingContext2D,
  leftX: number, rightX: number, y: number,
  ink: string,
): void {
  disc(ctx, leftX, y, 7, "#f4f1e0", ink, 2.4);
  disc(ctx, rightX, y + 1.5, 5.4, "#f4f1e0", ink, 2.4);
  disc(ctx, leftX + 1.6, y + 0.6, 2.6, ink);
  disc(ctx, rightX + 1, y + 2, 2, ink);
}

/** 外露的下颌与缺牙。 */
function zombieJaw(
  ctx: CanvasRenderingContext2D,
  cx: number, y: number, skin: string, ink: string,
): void {
  poly(ctx, [[cx - 9, y], [cx + 9, y], [cx + 7, y + 8], [cx - 7, y + 8]], skin, ink);
  ctx.fillStyle = "#f4f1e0";
  // 故意缺一颗，别排整齐。
  for (const [tx, tw] of [[-6, 3.4], [-1, 3], [5, 3.2]] as const) {
    ctx.fillRect(cx + tx, y - 3.4, tw, 4.2);
  }
}

/** 所有程序化单位共用的绘制外壳：对齐脚底、死亡时后倒、走路上下起伏。 */
abstract class ProceduralVisual implements UnitVisual {
  protected state: string;
  protected phase = 0;

  constructor(initial: string, fallback: string) {
    this.state = initial || fallback;
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

  /** 子类只管在局部坐标里画，位移、缩放、倒地都由这里处理。 */
  protected abstract paint(ctx: CanvasRenderingContext2D): void;

  /** 走路起伏幅度；站桩类单位覆盖成 0。 */
  protected bob(): number {
    return Math.sin(this.phase * 6) * 1.6;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    _bank: AssetBank,
    kind: SkinName,
    x: number,
    y: number,
    alpha = 1,
    filter = "none",
  ): void {
    const layout = PROCEDURAL_LAYOUT[kind as keyof typeof PROCEDURAL_LAYOUT];
    if (!layout) return;
    const { bounds, scale } = layout;
    const centerX = (bounds[0] + bounds[2]) / 2;
    const dying = this.state === "death";

    ctx.save();
    ctx.filter = filter;
    ctx.globalAlpha = alpha * (dying ? Math.max(0, 1 - this.phase / 1.4) : 1);
    ctx.translate(x - centerX * scale, y - bounds[3] * scale);
    ctx.scale(scale, scale);
    if (dying) {
      // 以脚为轴向后倒，和其它单位的死亡表现一致。
      ctx.translate(centerX, bounds[3]);
      ctx.rotate(Math.min(this.phase * 1.6, 1.35));
      ctx.translate(-centerX, -bounds[3]);
    }
    ctx.translate(0, dying ? 0 : this.bob());
    this.paint(ctx);
    ctx.restore();
  }
}

// ---- 机关盾竹 ----

/** 四个形态的配色：玄甲、弹簧架、竹钉拒马、赤芯锁城。 */
const BAMBOO_PHASES = [
  { plate: "#2f6b32", plateDark: "#1f4a24", trim: "#8fc25a" },
  { plate: "#4c8c36", plateDark: "#33642a", trim: "#a8d466" },
  { plate: "#7fa93c", plateDark: "#5d8130", trim: "#c6e07f" },
  { plate: "#c0392b", plateDark: "#8e2a20", trim: "#f0a05a" },
] as const;
const BAMBOO_INK = "#14260f";
const BAMBOO_STALK = "#3d7a2e";

/**
 * 机关盾竹。形态由已破护盾层数决定（0～3），不是由动画状态决定——
 * 血量是权威数据，客户端据此换轮廓，双方看到的阶段永远一致。
 */
export class ShieldBambooVisual extends ProceduralVisual {
  private shields = 0;

  constructor(initial: string) {
    super(initial, "idle");
  }

  /** 由 UnitTable 每帧同步；来自快照里的护盾层数。 */
  setShields(broken: number): void {
    this.shields = Math.max(0, Math.min(3, broken));
  }

  /** 站桩植物，只做很轻的呼吸感。 */
  protected override bob(): number {
    return Math.sin(this.phase * 2.2) * 0.8;
  }

  protected paint(ctx: CanvasRenderingContext2D): void {
    const skin = BAMBOO_PHASES[this.shields]!;
    const locked = this.state === "corelock";
    // 锁芯期间竹芯一亮一暗地搏动，提示正处在减伤窗口。
    const pulse = locked ? 0.5 + 0.5 * Math.sin(this.phase * 9) : 0;

    this.paintRoots(ctx);

    // 竹节主干，从根部往上，每个形态露出的高度不同。
    const stalkTop = [34, 40, 46, 66][this.shields]!;
    poly(ctx, [[36, 106], [48, 106], [50, stalkTop], [34, stalkTop]], BAMBOO_STALK, BAMBOO_INK);
    outline(ctx, BAMBOO_INK, 2);
    for (let y = stalkTop + 14; y < 104; y += 16) {
      ctx.beginPath();
      ctx.moveTo(35, y);
      ctx.lineTo(49, y);
      ctx.stroke();
    }

    if (this.shields === 3) this.paintCore(ctx, skin, pulse);
    else this.paintArmoured(ctx, skin);

    this.paintLeaves(ctx, skin);
  }

  /** 根部的三爪，四个形态都一样。 */
  private paintRoots(ctx: CanvasRenderingContext2D): void {
    for (const [dx, dy] of [[-20, -4], [0, 0], [20, -4]] as const) {
      poly(ctx, [
        [42 + dx * 0.35, 100],
        [42 + dx, 112 + dy],
        [42 + dx * 1.3, 116 + dy],
        [42 + dx * 0.2, 108],
      ], BAMBOO_STALK, BAMBOO_INK);
    }
  }

  /** 还有护盾的三个形态：一层层六边竹甲，破掉的层换成弹簧或落地竹钉。 */
  private paintArmoured(ctx: CanvasRenderingContext2D, skin: typeof BAMBOO_PHASES[number]): void {
    // 由外到内三层，越靠外越大；已经破掉的层不再画护片。
    const layers = [
      { cy: 54, r: 30, gone: this.shields >= 1 },
      { cy: 62, r: 24, gone: this.shields >= 2 },
      { cy: 70, r: 18, gone: false },
    ];

    if (this.shields >= 1) this.paintSprings(ctx, skin);
    if (this.shields >= 2) this.paintGroundSpikes(ctx);

    for (const layer of layers) {
      if (layer.gone) continue;
      poly(ctx, hexPoints(42, layer.cy, layer.r, 1.04), skin.plate, BAMBOO_INK);
      // 护片上的一道高光，让它看起来是硬壳不是色块。
      poly(ctx, hexPoints(42, layer.cy - 3, layer.r * 0.62, 1.04), skin.plateDark);
      poly(ctx, hexPoints(42, layer.cy - 5, layer.r * 0.34, 1.04), skin.trim);
    }

    // 甲片之间的铜铆钉。
    for (const [rx, ry] of [[19, 48], [65, 48], [24, 76], [60, 76]] as const) {
      disc(ctx, rx, ry, 3.2, "#d9a13b", BAMBOO_INK, 2);
    }
  }

  /** 外甲弹开后露出的黄铜弹簧与横向推杆。 */
  private paintSprings(ctx: CanvasRenderingContext2D, skin: typeof BAMBOO_PHASES[number]): void {
    outline(ctx, "#b8860b", 3);
    for (const side of [-1, 1]) {
      const baseX = 42 + side * 26;
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const px = baseX + side * Math.sin(t * Math.PI * 3) * 5;
        const py = 44 + t * 26;
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
      // 推杆头
      poly(ctx, [
        [baseX + side * 4, 40], [baseX + side * 13, 36],
        [baseX + side * 15, 44], [baseX + side * 6, 47],
      ], skin.trim, BAMBOO_INK);
    }
  }

  /** 中甲落地成为竹钉拒马（造型上的，实际的定身竹钉是独立实体）。 */
  private paintGroundSpikes(ctx: CanvasRenderingContext2D): void {
    for (const bx of [22, 42, 62]) {
      poly(ctx, [[bx - 6, 104], [bx, 88], [bx + 6, 104]], "#c6e07f", BAMBOO_INK);
    }
  }

  /** 赤芯锁城：红竹芯与锁扣外露，低姿态死守。 */
  private paintCore(
    ctx: CanvasRenderingContext2D,
    skin: typeof BAMBOO_PHASES[number],
    pulse: number,
  ): void {
    // 竹芯仍然用六边形，和前三个形态保持同一族的轮廓。
    // 早先画成尖顶的「火箭」形，结果整株看着像一团火，认不出还是那株竹子。
    const plate = hexPoints(42, 74, 21, 1.06);
    poly(ctx, plate, skin.plate, BAMBOO_INK);
    poly(ctx, hexPoints(42, 71, 13, 1.06), skin.plateDark);
    poly(ctx, hexPoints(42, 69, 7, 1.06), skin.trim);

    // 锁芯搏动时整块芯泛红光。
    if (pulse > 0) {
      ctx.save();
      ctx.globalAlpha = 0.3 + pulse * 0.35;
      poly(ctx, plate, "#ff8a5c");
      ctx.restore();
    }

    // 两侧锁扣
    for (const side of [-1, 1]) {
      const cx = 42 + side * 22;
      disc(ctx, cx, 74, 7, "#d9a13b", BAMBOO_INK, 2.6);
      disc(ctx, cx, 74, 2.8, BAMBOO_INK);
      // 锁扣咬住竹芯的短链
      outline(ctx, "#8e6521", 2.4);
      ctx.beginPath();
      ctx.moveTo(cx - side * 5, 74);
      ctx.lineTo(42 + side * 15, 74);
      ctx.stroke();
    }
    // 落地的碎甲残片，说明外面三层已经全没了。
    this.paintGroundSpikes(ctx);
  }

  /** 顶部竹叶。形态越靠后叶子越少，视觉上「被打秃了」。 */
  private paintLeaves(ctx: CanvasRenderingContext2D, skin: typeof BAMBOO_PHASES[number]): void {
    const count = 3 - Math.min(2, this.shields);
    const top = this.shields === 3 ? 48 : [34, 40, 46, 66][this.shields]!;
    // 叶子要斜着往上挑。平铺成横的就成了螺旋桨叶片，在草地上还发白，
    // 一眼认不出是竹叶——所以用陡角度、细长带尖的形状，并压暗一档。
    const leaf = shade(skin.trim, 0.82);
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const angle = (i === 0 ? 62 : 46) * (Math.PI / 180);
      const len = 30 - i * 3;
      const baseY = top - 1 - i * 5;
      const dirX = side * Math.cos(angle);
      const dirY = -Math.sin(angle);
      const tipX = 42 + dirX * len;
      const tipY = baseY + dirY * len;
      // 法线方向鼓出去，叶子才有宽度；太细就成了竹签。
      const nx = -dirY, ny = dirX;
      const w = 8.5 - i * 0.8;
      ctx.beginPath();
      ctx.moveTo(42, baseY);
      ctx.quadraticCurveTo(
        42 + dirX * len * 0.5 + nx * w, baseY + dirY * len * 0.5 + ny * w,
        tipX, tipY,
      );
      ctx.quadraticCurveTo(
        42 + dirX * len * 0.5 - nx * w * 0.55, baseY + dirY * len * 0.5 - ny * w * 0.55,
        42, baseY,
      );
      ctx.closePath();
      ctx.fillStyle = leaf;
      ctx.fill();
      outline(ctx, BAMBOO_INK, 2.4);
      ctx.stroke();
      // 叶脉
      outline(ctx, shade(skin.trim, 0.55), 1.6);
      ctx.beginPath();
      ctx.moveTo(42, baseY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
    }
  }
}

// ---- 三只僵尸：以原版普通僵尸为本体 ----

/**
 * 以原版普通僵尸 reanim 为本体，再叠自己画的配件。
 *
 * 早先这三只是纯程序化画的，方块拼出来的四肢在游戏里像机器人，不像僵尸。
 * 现在本体直接用 Zombie.reanim：走路、啃食、倒地都是原版的动作曲线，配件挂在
 * 真实骨骼上跟着晃，所以一眼就是「同一族僵尸换了身装备」。
 *
 * 配件画在本体之后，坐标系和 reanim 的锚点一致（原点在脚下、y 向上为负）。
 */
abstract class ZombieBasedVisual implements UnitVisual {
  /** 本体用的 kind；配件超出包围盒也不裁剪，所以不必为帽子额外加高。 */
  protected static readonly BODY: SkinName = "zombie";

  /**
   * @param body   原版普通僵尸的 reanim 外观，负责走路/啃食/倒地
   * @param layout 普通僵尸的包围盒，用来把配件对齐到同一个坐标系
   */
  constructor(
    protected readonly body: Visual,
    private readonly layout: VisualLayout,
  ) {}

  get currentState(): string { return this.body.currentState; }

  advance(dt: number): void { this.body.advance(dt); }

  hideTracks(names: string[]): void { this.body.hideTracks(names); }

  setState(state: string, restart = false): void {
    this.body.setState(state, restart);
  }

  /** 本体的整体色调；影袭要压成暗青色，其余保持原样。 */
  protected bodyFilter(filter: string): string { return filter; }

  /** 本体的透明度倍数；影袭潜行时压低。 */
  protected bodyAlpha(): number { return 1; }

  /** 这一帧要不要画本体。伪装体在拟态/钻地时整只盖掉。 */
  protected showBody(): boolean { return true; }

  /**
   * 画配件。ctx 已经对齐到 reanim 的锚点并缩放好，直接用素材坐标。
   * bone(name) 取骨骼当前变换，返回 null 表示这一帧该部件不可见。
   */
  protected abstract paintExtras(
    ctx: CanvasRenderingContext2D,
    bone: (name: string) => TrackTransform | null,
  ): void;

  draw(
    ctx: CanvasRenderingContext2D,
    bank: AssetBank,
    _kind: SkinName,
    x: number,
    y: number,
    alpha = 1,
    filter = "none",
  ): void {
    const layout = this.layout;
    if (this.showBody()) {
      this.body.draw(
        ctx, bank, ZombieBasedVisual.BODY, x, y,
        alpha * this.bodyAlpha(), this.bodyFilter(filter),
      );
    }

    // 复刻 Visual.draw 的变换，配件才和本体处在同一个坐标系里。
    const { bounds, scale } = layout;
    const centerX = (bounds[0] + bounds[2]) / 2;
    ctx.save();
    ctx.filter = filter;
    ctx.globalAlpha = alpha * this.bodyAlpha();
    ctx.translate(x - centerX * scale, y - bounds[3] * scale);
    ctx.scale(scale, scale);
    this.paintExtras(ctx, (name) => this.body.trackTransform(name));
    ctx.restore();
  }
}

/**
 * 把 ctx 挪到某根骨骼上；骨骼这一帧不可见就跳过整段绘制。
 *
 * 进到回调里之后，坐标就是那块素材自己的像素坐标：(0,0) 是素材左上角，
 * 单位是素材原始像素（骨骼变换里已经含了 0.8 左右的缩放）。各部件的尺寸见
 * build/parts-grid.mjs 生成的带网格对照图：
 *   头 53×48（脸朝左，眼睛在 (14,26) 与 (30,22)，嘴 y 36..47）
 *   身 53×62（领口 y 0..16，下摆 y 50..62）
 *   手 25×27（手腕在上，手指朝下）
 */
function onBone(
  ctx: CanvasRenderingContext2D,
  bone: TrackTransform | null,
  paint: () => void,
): void {
  if (!bone || bone.alpha <= 0.01) return;
  ctx.save();
  ctx.transform(bone.a, bone.b, bone.c, bone.d, bone.e, bone.f);
  paint();
  ctx.restore();
}

// ---- 影袭僵尸 ----

const SHADOW = {
  ink: "#0d1f26",
  hood: "#23203a",
  hoodLip: "#171528",
  cloth: "#17454e",
  clothDark: "#0e2f36",
  scarf: "#2f8f88",
  blade: "#a9cf8f",
  bladeEdge: "#e2f2cd",
  grip: "#7a5a30",
  cyan: "#5cf0e6",
} as const;

/**
 * 影袭僵尸：普通僵尸 + 兜帽面罩、短斗篷、叶刃。
 *
 * 潜行（cloak）时把本体压成暗青色并降低不透明度，只留一个能看出所在行的残影
 * ——完全隐形的话植物方连「有东西过来了」都判断不了。
 */
export class ShadowstrikeVisual extends ZombieBasedVisual {
  private cloakGlow = 0;

  advance(dt: number): void {
    super.advance(dt);
    this.cloakGlow += dt;
  }

  protected override bodyFilter(filter: string): string {
    if (filter !== "none") return filter;
    // 潜行时整只压成冷青色；显形后也保留一点暗调，跟普通僵尸区分开。
    return this.currentState === "cloak"
      ? "grayscale(.65) sepia(1) hue-rotate(135deg) saturate(2.6) brightness(.72)"
      : "sepia(.35) hue-rotate(135deg) saturate(1.5) brightness(.82)";
  }

  protected override bodyAlpha(): number {
    return this.currentState === "cloak" ? 0.4 : 1;
  }

  protected paintExtras(
    ctx: CanvasRenderingContext2D,
    bone: (name: string) => TrackTransform | null,
  ): void {
    const cloaked = this.currentState === "cloak";

    // 短斗篷：搭在肩上，下摆撕成尖角。
    onBone(ctx, bone("Zombie_body"), () => {
      poly(ctx, [
        [1, 8], [26, 2], [51, 8], [52, 40],
        [44, 34], [36, 46], [26, 34], [16, 46], [8, 34], [0, 40],
      ], SHADOW.cloth, SHADOW.ink);
      poly(ctx, [[10, 14], [42, 14], [38, 34], [14, 34]], SHADOW.clothDark);
      // 斜挎的刀带
      poly(ctx, [[6, 12], [44, 34], [40, 42], [2, 20]], SHADOW.clothDark, SHADOW.ink);
    });

    // 兜帽 + 面罩：兜帽罩住头顶和后脑，留出脸；面罩只遮那张咧开的嘴。
    onBone(ctx, bone("anim_head1"), () => {
      poly(ctx, [
        [1, 26], [5, 7], [24, -3], [46, 5], [51, 25],
        [45, 19], [30, 9], [14, 14], [8, 26],
      ], SHADOW.hood, SHADOW.ink);
      // 帽檐压在额头上
      poly(ctx, [[6, 11], [30, 5], [47, 13], [45, 20], [29, 11], [9, 18]], SHADOW.hoodLip);
      // 面罩：只盖 y 34 以下的嘴和牙，不能压到 (14,26)、(30,22) 那两只眼睛，
      // 压上去就成了蒙眼布，不是刺客面罩。
      poly(ctx, [[4, 34], [35, 32], [33, 47], [10, 48]], SHADOW.clothDark, SHADOW.ink);
      poly(ctx, [[7, 37], [31, 35], [30, 41], [9, 43]], SHADOW.cloth);
      // 围巾绕在颈上，垂到身后
      poly(ctx, [[6, 46], [34, 44], [33, 54], [8, 56]], SHADOW.scarf, SHADOW.ink);
      poly(ctx, [[30, 46], [50, 51], [46, 63], [31, 54]], SHADOW.scarf, SHADOW.ink);

      if (cloaked) {
        // 影幕里只剩两点青光，落在原本的眼位上。
        disc(ctx, 14, 26, 3.2, SHADOW.cyan);
        disc(ctx, 30, 22, 2.6, SHADOW.cyan);
      }
    });

    // 叶刃：握在外侧手里，刀尖朝身前（左下）。
    onBone(ctx, bone("Zombie_outerarm_hand"), () => {
      poly(ctx, [[7, 8], [19, 11], [17, 21], [5, 18]], SHADOW.grip, SHADOW.ink);
      poly(ctx, [[7, 16], [-16, 30], [-20, 40], [11, 24]], SHADOW.blade, SHADOW.ink);
      poly(ctx, [[7, 20], [-14, 32], [-16, 36], [9, 23]], SHADOW.bladeEdge);
    });

    if (cloaked) this.paintSmoke(ctx);
    else this.paintRevealBurst(ctx);
  }

  /** 潜行时脚下飘的影幕。画在锚点坐标系里：y=126 是脚底。 */
  private paintSmoke(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha *= 0.5;
    for (let i = 0; i < 3; i++) {
      const drift = (this.cloakGlow * 24 + i * 15) % 36;
      disc(ctx, 34 + i * 9 + drift * 0.35, 120 - drift * 0.22, 8 - i * 1.6, SHADOW.cyan);
    }
    ctx.restore();
  }

  /** 刚显形那一下，身周炸一圈青色碎片。 */
  private paintRevealBurst(ctx: CanvasRenderingContext2D): void {
    if (this.cloakGlow > 0.4) return;
    ctx.save();
    ctx.globalAlpha *= 1 - this.cloakGlow / 0.4;
    outline(ctx, SHADOW.cyan, 3);
    for (const [sx, sy] of [[8, 40], [74, 44], [12, 96], [72, 98]] as const) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (sx < 44 ? -9 : 9), sy - 7);
      ctx.stroke();
    }
    ctx.restore();
  }

  setState(state: string, restart = false): void {
    // 从潜行切到显形时重新计时，破影特效才只在那一下出现。
    if (state !== this.currentState) this.cloakGlow = 0;
    super.setState(state, restart);
  }
}

// ---- 钟馗僵尸 ----

const ZK = {
  ink: "#161310",
  hat: "#1c1a17",
  hatTrim: "#d08a2c",
  robe: "#7d2429",
  robeDark: "#5a171c",
  robeTrim: "#c8a24a",
  collar: "#22201c",
  gold: "#c79438",
  goldDark: "#8e6521",
  chain: "#b9bfc6",
  chainDark: "#6f767e",
} as const;

/**
 * 钟馗僵尸：普通僵尸 + 破损官帽、残破红官服、腰间收链盘。
 *
 * 钩锁的链节和钩头不在这里画——它要一路连到被钩的植物身上，属于跨单位的东西，
 * 由 game.ts 在世界坐标里画（见 drawHookChains）。这里只画收链盘和抬钩的手臂。
 */
export class ZhongkuiVisual extends ZombieBasedVisual {
  protected paintExtras(
    ctx: CanvasRenderingContext2D,
    bone: (name: string) => TrackTransform | null,
  ): void {
    // 残破官服：盖住整块躯干，下摆一直到腿根才撕成尖角。
    onBone(ctx, bone("Zombie_body"), () => {
      poly(ctx, [
        [0, 6], [26, 0], [52, 6], [53, 56],
        [45, 47], [37, 62], [26, 48], [15, 62], [7, 47], [-1, 56],
      ], ZK.robe, ZK.ink);
      poly(ctx, [[10, 14], [42, 14], [38, 48], [14, 48]], ZK.robeDark);
      // 腰带 + 铜扣
      poly(ctx, [[0, 32], [52, 32], [52, 40], [0, 40]], ZK.robeTrim, ZK.ink);
      disc(ctx, 22, 36, 5, ZK.gold, ZK.ink, 2);
      // 领口：贴着脖子的一圈，别做成横跨前胸的大尖角。
      poly(ctx, [[9, 3], [26, -2], [43, 3], [40, 14], [26, 9], [12, 14]], ZK.collar, ZK.ink);
      // 胸前的收链盘——铁链就是从这里放出去的。
      this.paintReel(ctx, 38, 24);
    });

    // 官帽：帽体压在头顶，两侧帽翅，右翅缺一角。
    onBone(ctx, bone("anim_head1"), () => {
      poly(ctx, [[3, 10], [7, -8], [45, -8], [49, 10]], ZK.hat, ZK.ink);
      poly(ctx, [[-12, -4], [3, 0], [3, 10], [-10, 6]], ZK.hat, ZK.ink);
      poly(ctx, [[49, -2], [64, -8], [60, 8], [49, 10]], ZK.hat, ZK.ink);
      // 帽顶宝顶
      poly(ctx, [[26, -22], [33, -10], [26, -4], [19, -10]], ZK.hatTrim, ZK.ink);
    });
  }

  /** 腰间的收链盘：一个铜盘加两圈盘好的链。 */
  private paintReel(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    disc(ctx, cx, cy, 8, ZK.chainDark, ZK.ink, 2.4);
    disc(ctx, cx, cy, 3.4, ZK.gold, ZK.ink, 2);
    outline(ctx, ZK.chain, 2.6);
    ctx.beginPath();
    ctx.arc(cx - 2, cy + 9, 6, -0.4, Math.PI * 1.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - 4, cy + 16, 5, -0.2, Math.PI * 1.2);
    ctx.stroke();
  }
}

// ---- 伪装向日葵 ----

const MIMIC_ART = {
  ink: "#3a2a14",
  petal: "#f5b731",
  petalDark: "#d9971f",
  face: "#6b4423",
  faceDark: "#4d3018",
  stem: "#4f8f34",
  zink: "#161310",
  vest: "#7a4a28",
  vestDark: "#5b3419",
  pouch: "#ffd94a",
} as const;

/**
 * 伪装向日葵。
 *
 * 潜伏期植物方在协议层就被换成了真向日葵，所以这里的 disguise 形态只有僵尸方
 * （和观战者）看得到：一株几乎一样的向日葵，花盘上一道虚线接缝提示自己人
 * 「这是我们的卧底」。现形后是普通僵尸戴着半张破裂花盘面具。
 */
export class MimicSunflowerVisual extends ZombieBasedVisual {
  private phase = 0;

  advance(dt: number): void {
    super.advance(dt);
    this.phase += dt;
  }

  setState(state: string, restart = false): void {
    if (state !== this.currentState) this.phase = 0;
    super.setState(state, restart);
  }

  /** 拟态和钻地时整只盖掉僵尸本体。 */
  protected override showBody(): boolean {
    const s = this.currentState;
    return s !== "disguise" && s !== "burrow";
  }

  protected paintExtras(
    ctx: CanvasRenderingContext2D,
    bone: (name: string) => TrackTransform | null,
  ): void {
    if (this.currentState === "burrow") { this.paintBurrow(ctx); return; }
    if (this.currentState === "disguise") { this.paintDisguise(ctx); return; }

    // 现形：麻布背心 + 偷来的阳光袋挂在躯干上。
    onBone(ctx, bone("Zombie_body"), () => {
      poly(ctx, [
        [0, 8], [26, 2], [52, 8], [52, 46],
        [44, 38], [35, 52], [26, 39], [16, 52], [8, 38], [0, 46],
      ], MIMIC_ART.vest, MIMIC_ART.zink);
      poly(ctx, [[10, 14], [42, 14], [38, 38], [14, 38]], MIMIC_ART.vestDark);
      ctx.save();
      ctx.globalAlpha *= 0.72 + 0.28 * Math.sin(this.phase * 5);
      disc(ctx, 38, 28, 8, MIMIC_ART.pouch, MIMIC_ART.zink, 2.2);
      ctx.restore();
    });

    // 破裂的花盘面具：挂在后脑那半边（x 30 往右），前面那张僵尸脸完整露出来。
    onBone(ctx, bone("anim_head1"), () => {
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (Math.PI / 5) * i;
        ctx.save();
        ctx.translate(42 + Math.cos(a) * 19, 20 + Math.sin(a) * 19);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.ellipse(0, 0, 9, 5.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 ? MIMIC_ART.petalDark : MIMIC_ART.petal;
        ctx.fill();
        outline(ctx, MIMIC_ART.ink, 2);
        ctx.stroke();
        ctx.restore();
      }
      // 花盘只留右半边，断口是条锯齿线。
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(34, -2);
      ctx.lineTo(60, 2);
      ctx.lineTo(58, 40);
      ctx.lineTo(32, 42);
      ctx.closePath();
      ctx.clip();
      disc(ctx, 42, 20, 14, MIMIC_ART.face, MIMIC_ART.ink, 3);
      disc(ctx, 42, 20, 7, MIMIC_ART.faceDark);
      ctx.restore();
      outline(ctx, MIMIC_ART.ink, 2.4);
      ctx.beginPath();
      ctx.moveTo(34, -1);
      ctx.lineTo(40, 20);
      ctx.lineTo(33, 41);
      ctx.stroke();
    });
  }

  /** 钻地：只有一个土堆和探出来的手。画在锚点坐标系里，y=126 是脚底。 */
  private paintBurrow(ctx: CanvasRenderingContext2D): void {
    const rise = Math.min(1, this.phase / 0.8);
    poly(ctx, [[16, 126], [44, 106 - rise * 6], [72, 126]], "#6b4a2a", MIMIC_ART.ink);
    disc(ctx, 30, 118, 5, "#7d5731");
    disc(ctx, 58, 120, 4, "#7d5731");
    poly(ctx, [[38, 110], [34, 96 - rise * 8], [45, 94 - rise * 8], [49, 110]],
      "#7a9153", MIMIC_ART.zink);
  }

  /** 拟态：一株向日葵，花盘上一道虚线接缝当自己人的识别标记。 */
  private paintDisguise(ctx: CanvasRenderingContext2D): void {
    const sway = Math.sin(this.phase * 1.8) * 2;
    const cx = 44 + sway;
    const cy = 48;

    // 茎：从脚底一直长到花盘底下。
    poly(ctx, [[41, 126], [48, 126], [cx + 4, cy + 18], [cx - 5, cy + 18]],
      MIMIC_ART.stem, MIMIC_ART.ink);
    // 两片弧形叶
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(44, 100);
      ctx.quadraticCurveTo(44 + side * 16, 82, 44 + side * 30, 89);
      ctx.quadraticCurveTo(44 + side * 18, 98, 44, 100);
      ctx.closePath();
      ctx.fillStyle = MIMIC_ART.stem;
      ctx.fill();
      outline(ctx, MIMIC_ART.ink, 2.4);
      ctx.stroke();
    }
    // 花瓣
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * 27, cy + Math.sin(a) * 27);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.ellipse(0, 0, 12, 7.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? MIMIC_ART.petalDark : MIMIC_ART.petal;
      ctx.fill();
      outline(ctx, MIMIC_ART.ink, 2.4);
      ctx.stroke();
      ctx.restore();
    }
    // 花盘与笑脸，跟真向日葵一致。
    disc(ctx, cx, cy, 20, MIMIC_ART.face, MIMIC_ART.ink, 3);
    disc(ctx, cx - 7, cy - 3, 2.8, "#2a1a0c");
    disc(ctx, cx + 7, cy - 3, 2.8, "#2a1a0c");
    outline(ctx, "#2a1a0c", 2.4);
    ctx.beginPath();
    ctx.arc(cx, cy + 3, 7.5, 0.25, Math.PI - 0.25);
    ctx.stroke();

    // 破绽：花盘右上一道虚线接缝。
    ctx.save();
    ctx.setLineDash([3, 3]);
    outline(ctx, "#c8952f", 2);
    ctx.beginPath();
    ctx.arc(cx, cy, 20, -1.5, -0.1);
    ctx.stroke();
    ctx.restore();
  }
}
