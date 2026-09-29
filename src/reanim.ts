/**
 * 原版 PvZ reanim 骨骼动画的播放器。
 *
 * 一个角色是一条时间轴，上面并排若干轨道：每条轨道画一张部件图，逐帧给出
 * 平移、两轴斜切、缩放和透明度。tools/parse_reanim.py 已经把「沿用上一帧」
 * 的哨兵值剥掉了，所以这里要先前向填充，再线性插值。
 *
 * 时间轴被切成若干动作区间（走、吃、死…），另有一类横跨多区间的部件组，
 * 点亮就换外观 —— 路障僵尸和铁桶僵尸就是同一个僵尸开不同部件组。
 */

export interface ReanimFrame {
  x?: number; y?: number;
  skewX?: number; skewY?: number;
  scaleX?: number; scaleY?: number;
  frame?: number;          // < 0 表示该帧隐藏
  alpha?: number;
  image?: string;
}

export interface ReanimDoc {
  fps: number;
  tracks: { name: string; frames: ReanimFrame[] }[];
  sections: Record<string, [number, number]>;
  partGroups: string[];
}

/** 前向填充后的轨道，用 TypedArray 存，避免每帧都去翻对象。 */
interface Track {
  name: string;
  x: Float32Array; y: Float32Array;
  skewX: Float32Array; skewY: Float32Array;
  scaleX: Float32Array; scaleY: Float32Array;
  alpha: Float32Array;
  visible: Uint8Array;
  image: (string | null)[];
}

const DEG = Math.PI / 180;

function fill(doc: ReanimDoc): { tracks: Track[]; length: number } {
  const length = Math.max(...doc.tracks.map((t) => t.frames.length));
  const tracks = doc.tracks.map((src) => {
    const t: Track = {
      name: src.name,
      x: new Float32Array(length), y: new Float32Array(length),
      skewX: new Float32Array(length), skewY: new Float32Array(length),
      scaleX: new Float32Array(length), scaleY: new Float32Array(length),
      alpha: new Float32Array(length),
      visible: new Uint8Array(length),
      image: new Array<string | null>(length).fill(null),
    };
    // 从不设值的属性该有的默认：缩放和不透明度是 1，其余是 0。
    // frame 默认可见 —— 显式写 -1 才隐藏，僵尸的身体轨道整段走路都不写 frame。
    let x = 0, y = 0, kx = 0, ky = 0, sx = 1, sy = 1, a = 1, shown = 0;
    let img: string | null = null;
    for (let i = 0; i < length; i++) {
      const f = src.frames[i];
      if (f) {
        if (f.x !== undefined) x = f.x;
        if (f.y !== undefined) y = f.y;
        if (f.skewX !== undefined) kx = f.skewX;
        if (f.skewY !== undefined) ky = f.skewY;
        if (f.scaleX !== undefined) sx = f.scaleX;
        if (f.scaleY !== undefined) sy = f.scaleY;
        if (f.alpha !== undefined) a = f.alpha;
        if (f.frame !== undefined) shown = f.frame;
        if (f.image !== undefined) img = f.image;
      }
      t.x[i] = x; t.y[i] = y;
      t.skewX[i] = kx; t.skewY[i] = ky;
      t.scaleX[i] = sx; t.scaleY[i] = sy;
      t.alpha[i] = a;
      t.visible[i] = shown >= 0 ? 1 : 0;
      t.image[i] = img;
    }
    return t;
  });
  return { tracks, length };
}

/** 图集查表：名字 -> 在图集页里的位置，ox/oy 是打包时裁掉的透明边。 */
export interface AtlasEntry {
  p: number; x: number; y: number; w: number; h: number; ox: number; oy: number;
}
export type Atlas = Record<string, AtlasEntry>;

export function atlasKey(imageRef: string): string {
  return imageRef.replace(/^IMAGE_REANIM_/, "").replace(/^IMAGE_/, "");
}

/** 一个动作图层：在某个区间里循环，自带播放头。 */
interface Layer {
  from: number; to: number;
  loop: boolean;
  time: number;            // 单位是帧
  done: boolean;
}

/** 一条轨道在当前帧的变换，等价于 ctx.transform 的六个参数。 */
export interface TrackTransform {
  a: number; b: number; c: number; d: number; e: number; f: number;
  alpha: number;
}

export class Reanim {
  readonly fps: number;
  readonly sections: Record<string, [number, number]>;
  private readonly tracks: Track[];
  private readonly length: number;
  private layers: Layer[] = [];
  private groups = new Set<string>();
  private hidden = new Set<string>();

  constructor(doc: ReanimDoc) {
    this.fps = doc.fps;
    this.sections = doc.sections;
    const { tracks, length } = fill(doc);
    this.tracks = tracks;
    this.length = length;
  }

  /**
   * 设置当前播放的动作。可以叠加多层 —— 原版的豌豆射手就是
   * anim_idle 画茎叶、anim_shooting 画头部，两层同时跑。
   */
  play(names: string[], opts: { loop?: boolean; restart?: boolean } = {}): this {
    const loop = opts.loop ?? true;
    const next: Layer[] = [];
    for (const name of names) {
      const key = name.startsWith("anim_") ? name : `anim_${name}`;
      const range = this.sections[key];
      if (!range) continue;
      const prev = opts.restart ? undefined : this.layers.find(
        (l) => l.from === range[0] && l.to === range[1]);
      next.push({
        from: range[0], to: range[1], loop,
        time: prev?.time ?? 0, done: false,
      });
    }
    this.layers = next;
    return this;
  }

  /**
   * 直接指定帧区间播放，用于自动切分给不出合适区间的单位
   * （土豆雷的「已埋好」状态就只能手写帧号）。
   */
  playRange(from: number, to: number, opts: { loop?: boolean } = {}): this {
    this.layers = [{
      from, to: Math.min(to, this.length - 1),
      loop: opts.loop ?? true, time: 0, done: false,
    }];
    return this;
  }

  /** 点亮/熄灭部件组，用来切外观（cone = 路障，bucket = 铁桶）。 */
  setParts(names: string[]): this {
    this.groups = new Set(names.map((n) => n.startsWith("anim_") ? n : `anim_${n}`));
    return this;
  }

  /**
   * 强制隐藏若干轨道。同一份 Zombie.reanim 里塞了泳圈、铁门、旗子等各种
   * 可选装备，且它们默认可见 —— 原版是靠游戏代码逐个关掉的，这里同理：
   * 每个单位显式声明自己不要哪些部件。
   */
  setHidden(names: string[]): this {
    this.hidden = new Set(names);
    return this;
  }

  advance(dtSeconds: number): void {
    const df = dtSeconds * this.fps;
    for (const l of this.layers) {
      const span = l.to - l.from + 1;
      l.time += df;
      if (l.time >= span) {
        if (l.loop) l.time %= span;
        else { l.time = span - 1; l.done = true; }
      }
    }
  }

  get finished(): boolean {
    return this.layers.length > 0 && this.layers.every((l) => l.done);
  }

  /**
   * 取某条轨道在当前帧的变换，用来把配件挂到真实骨骼上。
   *
   * 影袭的兜帽、钟馗的官帽、伪装体的花盘面具都是自己画的图形，如果按固定局部
   * 坐标画，走路时本体在动、配件不动，几帧后就飘到脑袋外面去了。挂到骨骼上
   * 才会跟着一起晃。
   *
   * 轨道不存在、当前帧不可见，或者还没开始播放时返回 null。
   */
  trackTransform(name: string): TrackTransform | null {
    const layer = this.layers[0];
    if (!layer) return null;
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return null;

    // 帧号推算和 draw() 保持一致，否则配件会比本体差一帧。
    const span = layer.to - layer.from + 1;
    const local = Math.min(layer.time, span - 1);
    const i0 = layer.from + Math.floor(local);
    const i1 = i0 >= layer.to ? (layer.loop ? layer.from : layer.to) : i0 + 1;
    const frac = local - Math.floor(local);
    if (!track.visible[i0]) return null;

    const lerp = (arr: Float32Array) => arr[i0]! + (arr[i1]! - arr[i0]!) * frac;
    const kx = lerp(track.skewX) * DEG, ky = lerp(track.skewY) * DEG;
    const sx = lerp(track.scaleX), sy = lerp(track.scaleY);
    return {
      a: Math.cos(kx) * sx, b: Math.sin(kx) * sx,
      c: -Math.sin(ky) * sy, d: Math.cos(ky) * sy,
      e: lerp(track.x), f: lerp(track.y),
      alpha: lerp(track.alpha),
    };
  }

  /**
   * 画到 ctx 上，原点是角色的锚点。轨道顺序即图层顺序，与原版一致。
   * flip 为真时水平镜像；游戏中的原版植物和僵尸素材无需翻转。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    sheets: HTMLImageElement[],
    atlas: Atlas,
    opts: { flip?: boolean; alpha?: number } = {},
  ): void {
    if (this.layers.length === 0) return;
    const globalAlpha = opts.alpha ?? 1;

    ctx.save();
    if (opts.flip) ctx.scale(-1, 1);

    const drawn = new Set<string>();
    for (const layer of this.layers) {
      const span = layer.to - layer.from + 1;
      const local = Math.min(layer.time, span - 1);
      const i0 = layer.from + Math.floor(local);
      // 循环时最后一帧要插回区间开头，否则接缝会顿一下
      const i1 = i0 >= layer.to ? (layer.loop ? layer.from : layer.to) : i0 + 1;
      const frac = local - Math.floor(local);

      for (const t of this.tracks) {
        if (drawn.has(t.name)) continue;          // 跨区间的部件组只画一次
        if (this.hidden.has(t.name)) continue;
        if (!t.visible[i0]) continue;
        if (t.name.startsWith("anim_") && !this.groups.has(t.name)) {
          // anim_ 轨道里带图的是可选外观，没点亮就不画
          if (t.image[i0]) continue;
        }
        const ref = t.image[i0];
        if (!ref) continue;
        const e = atlas[atlasKey(ref)];
        if (!e) continue;
        const sheet = sheets[e.p];
        if (!sheet) continue;

        const lerp = (a: Float32Array) => a[i0]! + (a[i1]! - a[i0]!) * frac;
        const alpha = lerp(t.alpha) * globalAlpha;
        if (alpha <= 0.001) continue;

        const kx = lerp(t.skewX) * DEG, ky = lerp(t.skewY) * DEG;
        const sx = lerp(t.scaleX), sy = lerp(t.scaleY);

        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.transform(
          Math.cos(kx) * sx, Math.sin(kx) * sx,
          -Math.sin(ky) * sy, Math.cos(ky) * sy,
          lerp(t.x), lerp(t.y),
        );
        ctx.drawImage(sheet, e.x, e.y, e.w, e.h, e.ox, e.oy, e.w, e.h);
        ctx.restore();
        drawn.add(t.name);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

export async function loadReanim(url: string): Promise<Reanim> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载动画失败 ${url}: ${res.status}`);
  return new Reanim(await res.json() as ReanimDoc);
}
