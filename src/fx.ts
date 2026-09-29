/**
 * 战斗表现层。这里只消费服务器已经确认的 SimEvent，绝不修改血量、位置或胜负。
 * 因而关闭粒子、手机掉帧、观战延迟都不会改变对局结果。
 */
import type { SimEvent } from "../shared/sim.ts";
import type { UnitKind } from "../shared/cards.ts";
import { type AssetBank, type SkinName, type UnitVisual } from "./render.ts";

type ParticleShape = "dot" | "shard" | "smoke" | "flame" | "spark";
interface Particle {
  x: number; y: number; vx: number; vy: number; gravity: number;
  age: number; life: number; size: number; color: string; shape: ParticleShape; rotation: number; spin: number;
}
interface Ring { x: number; y: number; age: number; life: number; from: number; to: number; color: string; width: number }
interface LabelFx { x: number; y: number; age: number; life: number; text: string; color: string; size: number }
interface UnitFx {
  type: "hit" | "shoot" | "flatten" | "burn" | "hide";
  age: number; life: number; delay: number;
}
interface Ghost {
  kind: UnitKind; x: number; y: number; age: number; life: number;
  type: "flatten" | "burn"; visual: UnitVisual;
}

export interface UnitFxStyle {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  alpha: number;
  filter: string;
}

export class FxSystem {
  private readonly particles: Particle[] = [];
  private readonly rings: Ring[] = [];
  private readonly labels: LabelFx[] = [];
  private readonly unitFx = new Map<number, UnitFx[]>();
  private readonly ghosts: Ghost[] = [];
  private shakeTime = 0;
  private shakeLife = 0;
  private shakeAmount = 0;

  clear(): void {
    this.particles.length = 0;
    this.rings.length = 0;
    this.labels.length = 0;
    this.unitFx.clear();
    this.ghosts.length = 0;
    this.shakeTime = 0; this.shakeLife = 0; this.shakeAmount = 0;
  }

  consume(event: SimEvent, tick: number, bank: AssetBank, targetStillVisible: boolean): void {
    const random = seededRandom((tick * 65537) ^ Math.round(event.x * 17) ^ Math.round(event.y * 31) ^ hash(event.kind));
    switch (event.kind) {
      case "plant":
      case "spawn":
      case "shovel":
        // 这些动作已有 burst 粒子；独立语义事件只用于音效与分析，避免重复画一遍。
        break;
      case "shoot":
        if (event.sourceId !== undefined) this.addUnitFx(event.sourceId, "shoot", .15);
        this.sparks(event.x, event.y, event.look === "wave" ? "#ffe879" : event.look === "snow" ? "#b8f5ff" : "#8bd14f", 5, random, 55);
        break;
      case "hit":
        if (event.targetId !== undefined) this.addUnitFx(event.targetId, "hit", .16);
        this.sparks(event.x, event.y, event.color ?? "#e7f7b0", event.look === "wave" ? 13 : 8, random, event.look === "wave" ? 115 : 80);
        this.rings.push({ x: event.x, y: event.y, age: 0, life: .24, from: 3, to: event.look === "wave" ? 33 : 19, color: event.color ?? "#fff", width: 3 });
        break;
      case "armorBreak":
        this.shards(event.x, event.y, event.color ?? "#d6cfb6", 12, random);
        this.labels.push({ x: event.x, y: event.y - 10, age: 0, life: .55, text: "咔嚓!", color: "#fff1c6", size: 19 });
        break;
      case "impact":
        this.dust(event.x, event.y + 18, 20, random);
        this.rings.push({ x: event.x, y: event.y + 15, age: 0, life: .38, from: 12, to: event.size ?? 95, color: event.color ?? "#e7d89a", width: 8 });
        this.shake(event.effect === "gargantuar" ? 12 : 9, .32);
        break;
      case "flatten": {
        const delay = event.delay ?? 0;
        if (event.fatal && event.targetKind) {
          if (event.targetId !== undefined && targetStillVisible) this.addUnitFx(event.targetId, "hide", 1.6, delay);
          const visual = bank.visual(event.targetKind as SkinName, "idle");
          this.ghosts.push({ kind: event.targetKind, x: event.x, y: event.y, age: -delay, life: .72, type: "flatten", visual });
        } else if (event.targetId !== undefined) {
          this.addUnitFx(event.targetId, "flatten", .72, delay);
        }
        break;
      }
      case "burn": {
        const delay = event.delay ?? 0;
        if (event.fatal && event.targetKind) {
          if (event.targetId !== undefined && targetStillVisible) this.addUnitFx(event.targetId, "hide", 1.6, delay);
          const visual = bank.visual(event.targetKind as SkinName, "death");
          this.ghosts.push({ kind: event.targetKind, x: event.x, y: event.y, age: -delay, life: .95, type: "burn", visual });
        } else if (event.targetId !== undefined) {
          this.addUnitFx(event.targetId, "burn", .95, delay);
        }
        break;
      }
      case "explode":
        if (event.effect === "jalapeno") this.fireWave(event.x, event.y + 45, event.row ?? 0, random);
        else this.cherryExplosion(event.x, event.y, random);
        break;
      case "death":
        if (event.effect === "normal") this.dust(event.x, event.y - 20, 7, random);
        break;
      case "mower":
        this.shake(7, .22);
        this.dust(event.x, event.y, 12, random);
        break;
      case "burst":
        this.rings.push({ x: event.x, y: event.y, age: 0, life: .34, from: 4, to: event.size ?? 26, color: event.color ?? "#fff", width: 5 });
        break;
      case "sun":
        this.sparks(event.x, event.y, "#ffe86a", 7, random, 50);
        break;
    }
  }

  update(dt: number): void {
    for (const p of this.particles) {
      p.age += dt; p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rotation += p.spin * dt;
    }
    removeExpired(this.particles);
    for (const ring of this.rings) ring.age += dt;
    removeExpired(this.rings);
    for (const label of this.labels) { label.age += dt; label.y -= 22 * dt; }
    removeExpired(this.labels);
    for (const [id, effects] of this.unitFx) {
      for (const effect of effects) effect.age += dt;
      const alive = effects.filter((effect) => effect.age < effect.life + effect.delay);
      if (alive.length) this.unitFx.set(id, alive); else this.unitFx.delete(id);
    }
    for (const ghost of this.ghosts) { ghost.age += dt; if (ghost.age >= 0) ghost.visual.advance(dt); }
    removeExpired(this.ghosts);
    this.shakeTime = Math.max(0, this.shakeTime - dt);
  }

  cameraOffset(clock: number): { x: number; y: number } {
    if (this.shakeTime <= 0 || this.shakeLife <= 0) return { x: 0, y: 0 };
    const fade = this.shakeTime / this.shakeLife;
    return {
      x: Math.sin(clock * 91) * this.shakeAmount * fade,
      y: Math.cos(clock * 73) * this.shakeAmount * .55 * fade,
    };
  }

  unitStyle(id: number): UnitFxStyle {
    const style: UnitFxStyle = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, alpha: 1, filter: "none" };
    for (const effect of this.unitFx.get(id) ?? []) {
      const local = effect.age - effect.delay;
      if (local < 0) continue;
      const t = Math.min(1, local / effect.life);
      if (effect.type === "hit") {
        style.offsetX += Math.sin(t * Math.PI * 4) * 4 * (1 - t);
        if (t < .55) style.filter = "brightness(2.4) saturate(.45)";
      } else if (effect.type === "shoot") {
        style.offsetX -= Math.sin(t * Math.PI) * 6;
      } else if (effect.type === "flatten") {
        const squash = easeOutBack(Math.min(1, t / .42));
        style.scaleY *= 1 - squash * .82;
        style.scaleX *= 1 + squash * .34;
        style.offsetY += squash * 6;
        if (t > .55) style.alpha *= 1 - (t - .55) / .45;
      } else if (effect.type === "burn") {
        style.filter = t < .2 ? "brightness(2.6) sepia(1) saturate(5) hue-rotate(330deg)" : "grayscale(1) brightness(.32) sepia(.7)";
        style.offsetY -= Math.sin(t * Math.PI * 7) * 2 * (1 - t);
        if (t > .58) style.alpha *= 1 - (t - .58) / .42;
      } else if (effect.type === "hide") {
        style.alpha = 0;
      }
    }
    return style;
  }

  drawBack(ctx: CanvasRenderingContext2D, bank: AssetBank): void {
    for (const ghost of this.ghosts) {
      if (ghost.age < 0 || ghost.age >= ghost.life) continue;
      const t = ghost.age / ghost.life;
      const style = ghost.type === "flatten"
        ? { sx: 1 + Math.min(1, t / .4) * .34, sy: 1 - Math.min(1, t / .4) * .82, alpha: t > .55 ? 1 - (t - .55) / .45 : 1, filter: "none" }
        : { sx: 1, sy: 1, alpha: t > .58 ? 1 - (t - .58) / .42 : 1, filter: "grayscale(1) brightness(.32) sepia(.7)" };
      ctx.save(); ctx.translate(ghost.x, ghost.y); ctx.scale(style.sx, style.sy); ctx.translate(-ghost.x, -ghost.y);
      ghost.visual.draw(ctx, bank, ghost.kind as SkinName, ghost.x, ghost.y, Math.max(0, style.alpha), style.filter);
      ctx.restore();
    }
  }

  drawFront(ctx: CanvasRenderingContext2D): void {
    for (const ring of this.rings) {
      const t = ring.age / ring.life;
      ctx.save(); ctx.globalAlpha = (1 - t) * .9; ctx.strokeStyle = ring.color; ctx.lineWidth = Math.max(1, ring.width * (1 - t));
      ctx.beginPath(); ctx.arc(ring.x, ring.y, ring.from + (ring.to - ring.from) * easeOut(t), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    for (const p of this.particles) this.drawParticle(ctx, p);
    for (const label of this.labels) {
      const t = label.age / label.life;
      ctx.save(); ctx.globalAlpha = 1 - t; ctx.fillStyle = label.color; ctx.strokeStyle = "#4b2418"; ctx.lineWidth = 4;
      ctx.font = `900 ${label.size + t * 8}px 'Microsoft YaHei',sans-serif`; ctx.textAlign = "center";
      ctx.strokeText(label.text, label.x, label.y); ctx.fillText(label.text, label.x, label.y); ctx.restore();
    }
  }

  private addUnitFx(id: number, type: UnitFx["type"], life: number, delay = 0): void {
    const effects = this.unitFx.get(id) ?? [];
    effects.push({ type, age: 0, life, delay });
    this.unitFx.set(id, effects);
  }

  private shake(amount: number, life: number): void {
    if (amount >= this.shakeAmount || this.shakeTime <= 0) this.shakeAmount = amount;
    this.shakeTime = Math.max(this.shakeTime, life); this.shakeLife = Math.max(this.shakeLife, life);
  }

  private cherryExplosion(x: number, y: number, random: () => number): void {
    this.shake(13, .38);
    this.rings.push({ x, y, age: 0, life: .42, from: 12, to: 175, color: "#fff1a1", width: 14 });
    this.rings.push({ x, y, age: 0, life: .55, from: 20, to: 145, color: "#ff4d2c", width: 24 });
    this.labels.push({ x, y: y + 12, age: 0, life: .62, text: "轰!", color: "#fff09b", size: 38 });
    this.sparks(x, y, "#ffdc62", 34, random, 250);
    for (let i = 0; i < 22; i++) this.addParticle(x, y, random, "smoke", i % 2 ? "#4b3228" : "#9a4130", 70, 26);
  }

  private fireWave(x: number, y: number, _row: number, random: () => number): void {
    this.shake(8, .3);
    for (let i = -15; i <= 15; i++) {
      const px = x + i * 42;
      const p = this.addParticle(px, y + random() * 18, random, "flame", i % 3 ? "#ff7a1b" : "#ffd64b", 75, 18);
      p.vx = Math.sign(i || 1) * (170 + random() * 180); p.vy = -110 - random() * 90; p.life = .55 + random() * .35;
    }
    this.labels.push({ x, y: y - 32, age: 0, life: .7, text: "呼——!", color: "#fff0a0", size: 30 });
  }

  private sparks(x: number, y: number, color: string, count: number, random: () => number, speed: number): void {
    for (let i = 0; i < count; i++) this.addParticle(x, y, random, "spark", color, speed, 7);
  }
  private shards(x: number, y: number, color: string, count: number, random: () => number): void {
    for (let i = 0; i < count; i++) this.addParticle(x, y, random, "shard", color, 150, 11);
  }
  private dust(x: number, y: number, count: number, random: () => number): void {
    for (let i = 0; i < count; i++) this.addParticle(x, y, random, "smoke", i % 2 ? "#9f8b67" : "#62543f", 90, 18);
  }
  private addParticle(x: number, y: number, random: () => number, shape: ParticleShape, color: string, speed: number, size: number): Particle {
    const angle = random() * Math.PI * 2;
    const velocity = speed * (.45 + random() * .75);
    const p: Particle = {
      x, y, vx: Math.cos(angle) * velocity, vy: Math.sin(angle) * velocity - (shape === "smoke" ? 30 : 0),
      gravity: shape === "shard" || shape === "dot" ? 220 : shape === "flame" ? -45 : 30,
      age: 0, life: .35 + random() * .45, size: size * (.45 + random() * .75), color, shape,
      rotation: random() * Math.PI, spin: (random() - .5) * 10,
    };
    if (this.particles.length >= 220) this.particles.shift();
    this.particles.push(p); return p;
  }
  private drawParticle(ctx: CanvasRenderingContext2D, p: Particle): void {
    const t = p.age / p.life;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.globalAlpha = Math.max(0, 1 - t); ctx.fillStyle = p.color;
    const size = p.size * (p.shape === "smoke" ? .5 + t : 1 - t * .35);
    if (p.shape === "shard") ctx.fillRect(-size / 2, -size / 5, size, size * .4);
    else if (p.shape === "flame") {
      ctx.beginPath(); ctx.moveTo(0, -size); ctx.quadraticCurveTo(size, 0, 0, size * .4); ctx.quadraticCurveTo(-size, 0, 0, -size); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(0, 0, size * .5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

function removeExpired<T extends { age: number; life: number }>(items: T[]): void {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.age >= items[i]!.life) items.splice(i, 1);
}
function easeOut(t: number): number { return 1 - Math.pow(1 - t, 3); }
function easeOutBack(t: number): number { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
function hash(text: string): number { let value = 2166136261; for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; }
function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = Math.imul(value ^ (value >>> 15), 1 | value); value ^= value + Math.imul(value ^ (value >>> 7), 61 | value); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
