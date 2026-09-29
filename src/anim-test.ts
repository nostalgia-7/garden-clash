/**
 * 动画自检页：把每个单位声明的每个状态都摆出来跑一遍。
 * 数据源是 shared/skins.json，和 tools/render_check.py 完全一致。
 */
import { Reanim, type Atlas, type ReanimDoc } from "./reanim.ts";
import { SKINS, type Skin } from "../shared/skins.ts";

const BASE = "/assets";
const CELL_W = 200;
const CELL_H = 200;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, err) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => err(new Error(`图片加载失败: ${src}`));
    im.src = src;
  });
}

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

interface Cell {
  anim: Reanim;
  ctx: CanvasRenderingContext2D;
}

function makeCell(label: string): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const wrap = document.createElement("div");
  wrap.className = "cell";
  const canvas = document.createElement("canvas");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = CELL_W * dpr;
  canvas.height = CELL_H * dpr;
  canvas.style.width = `${CELL_W}px`;
  canvas.style.height = `${CELL_H}px`;
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.textContent = label;
  wrap.append(canvas, cap);
  document.getElementById("grid")!.append(wrap);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  return { canvas, ctx };
}

/** 按 skins.json 的状态声明装配一个播放器实例。 */
function build(doc: ReanimDoc, sk: Skin, state: string): Reanim | null {
  const spec = sk.states[state];
  if (!spec) return null;
  const anim = new Reanim(doc)
    .setHidden(sk.hidden)
    .setParts([...sk.parts, ...(spec.parts ?? [])]);
  if (spec.range) {
    anim.playRange(spec.range[0], spec.range[1]);
  } else {
    const names = spec.sections ?? [];
    if (!names.every((n) => doc.sections[`anim_${n}`])) return null;
    anim.play(names);
  }
  return anim;
}

async function main() {
  const status = document.getElementById("status")!;
  try {
    const manifest = await json<{ atlasPages: number }>(`${BASE}/manifest.json`);
    const atlas = await json<Atlas>(`${BASE}/atlas.json`);
    const sheets = await Promise.all(
      Array.from({ length: manifest.atlasPages },
        (_, i) => loadImage(`${BASE}/atlas-${i}.png`)));

    // 同一份 reanim 会被多个单位复用（僵尸/路障/铁桶），缓存一下
    const docs = new Map<string, ReanimDoc>();
    const cells: Cell[] = [];
    for (const [unit, sk] of Object.entries(SKINS)) {
      let doc = docs.get(sk.anim);
      if (!doc) {
        doc = await json<ReanimDoc>(`${BASE}/anim/${sk.anim}.json`);
        docs.set(sk.anim, doc);
      }
      for (const state of Object.keys(sk.states)) {
        const anim = build(doc, sk, state);
        if (!anim) {
          console.warn(`跳过 ${unit}.${state}`);
          continue;
        }
        const { ctx } = makeCell(`${unit} · ${state}`);
        cells.push({ anim, ctx });
      }
    }

    status.textContent =
      `${Object.keys(SKINS).length} 个单位 / ${cells.length} 个状态 · 图集 ${manifest.atlasPages} 页`;

    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      for (const c of cells) {
        c.anim.advance(dt);
        c.ctx.clearRect(0, 0, CELL_W, CELL_H);
        c.ctx.save();
        // reanim 的坐标原点在素材左上角附近，往下偏一点好取景
        c.ctx.translate(CELL_W / 2 - 40, 30);
        c.anim.draw(c.ctx, sheets, atlas);
        c.ctx.restore();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } catch (e) {
    status.textContent = `出错: ${(e as Error).message}`;
    status.style.color = "#f66";
    throw e;
  }
}

void main();
