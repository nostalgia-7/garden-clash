import type { SimEvent } from "../shared/sim.ts";

type MusicScene = "menu" | "battle" | "silent";
type SoundName = keyof typeof SOUND_URLS;

const MUSIC_URLS: Record<Exclude<MusicScene, "silent">, string> = {
  menu: "/assets/audio/menu-map.mp3",
  battle: "/assets/audio/grasswalk.mp3",
};

const SOUND_URLS = {
  button: "/assets/audio/buttonclick.ogg",
  grave: "/assets/audio/gravebutton.ogg",
  plant: "/assets/audio/plant.ogg",
  shovel: "/assets/audio/shovel.ogg",
  throw: "/assets/audio/throw.ogg",
  frozen: "/assets/audio/frozen.ogg",
  chomp: "/assets/audio/chomp.ogg",
  chomp2: "/assets/audio/chomp2.ogg",
  splat: "/assets/audio/splat.ogg",
  splat2: "/assets/audio/splat2.ogg",
  cherry: "/assets/audio/cherrybomb.ogg",
  jalapeno: "/assets/audio/jalapeno.ogg",
  thump: "/assets/audio/gargantuar_thump.ogg",
  paper: "/assets/audio/newspaper_rip.ogg",
  shield: "/assets/audio/shieldhit.ogg",
  mower: "/assets/audio/lawnmower.ogg",
  points: "/assets/audio/points.ogg",
  groan1: "/assets/audio/groan.ogg",
  groan2: "/assets/audio/groan2.ogg",
  groan3: "/assets/audio/groan3.ogg",
  laugh: "/assets/audio/evillaugh.ogg",
  wave: "/assets/audio/fume.ogg",
  win: "/assets/audio/winmusic.ogg",
  lose: "/assets/audio/losemusic.ogg",
} as const;

const VOLUME_KEY = "garden-clash-volume";
const MUTED_KEY = "garden-clash-muted";
const MUSIC_GAIN = 0.34;

/**
 * 轻量浏览器音频层。它只消费权威模拟发来的语义事件，不参与伤害、冷却或随机数。
 * 同一个短音效维护 4 个播放器，连续命中时不会互相截断。
 */
export class AudioManager {
  private readonly pools = new Map<SoundName, HTMLAudioElement[]>();
  private readonly music = new Map<Exclude<MusicScene, "silent">, HTMLAudioElement>();
  private readonly lastPlayed = new Map<SoundName, number>();
  private wantedScene: MusicScene = "menu";
  private activeMusic: HTMLAudioElement | null = null;
  private unlocked = false;
  private volume = this.loadVolume();
  private muted = localStorage.getItem(MUTED_KEY) === "1";

  constructor() {
    for (const [scene, url] of Object.entries(MUSIC_URLS) as [Exclude<MusicScene, "silent">, string][]) {
      const audio = new Audio(url);
      audio.loop = true;
      audio.preload = "metadata";
      audio.volume = this.effectiveVolume(MUSIC_GAIN);
      this.music.set(scene, audio);
    }

    const unlock = () => this.unlock();
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
  }

  bindControls(toggle: HTMLButtonElement, range: HTMLInputElement): void {
    range.value = String(Math.round(this.volume * 100));
    const refresh = () => {
      toggle.textContent = this.muted || this.volume === 0 ? "🔇" : this.volume < 0.45 ? "🔉" : "🔊";
      toggle.setAttribute("aria-label", this.muted ? "开启声音" : "静音");
      toggle.setAttribute("aria-pressed", String(this.muted));
      range.setAttribute("aria-valuetext", `${Math.round(this.volume * 100)}%`);
    };
    toggle.addEventListener("click", () => {
      this.unlock();
      this.muted = !this.muted;
      localStorage.setItem(MUTED_KEY, this.muted ? "1" : "0");
      this.applyVolume();
      if (!this.muted) this.play("button", .55);
      refresh();
    });
    range.addEventListener("input", () => {
      this.unlock();
      this.volume = Math.max(0, Math.min(1, Number(range.value) / 100));
      localStorage.setItem(VOLUME_KEY, String(this.volume));
      if (this.volume > 0 && this.muted) {
        this.muted = false;
        localStorage.setItem(MUTED_KEY, "0");
      }
      this.applyVolume();
      refresh();
    });
    range.addEventListener("change", () => this.play("button", .45));
    refresh();
  }

  setScene(scene: MusicScene): void {
    this.wantedScene = scene;
    if (this.unlocked) this.syncMusic();
  }

  ui(kind: "button" | "grave" = "button"): void {
    this.play(kind, kind === "grave" ? .75 : .48, 45);
  }

  consume(event: SimEvent): void {
    const delayed = (name: SoundName, gain = 1, minGap = 0) => {
      if ((event.delay ?? 0) > 0) window.setTimeout(() => this.play(name, gain, minGap), event.delay! * 1000);
      else this.play(name, gain, minGap);
    };
    switch (event.kind) {
      case "plant": delayed("plant", .75); break;
      case "shovel": delayed("shovel", .72); break;
      case "spawn": delayed(event.sourceKind === "nailong" ? "laugh" : "groan1", .48, 180); break;
      case "sun": delayed("points", .5, 90); break;
      case "shoot":
        if (event.look === "wave") { delayed("laugh", .58, 360); delayed("wave", .7, 90); }
        else delayed(event.look === "snow" ? "frozen" : "throw", event.look === "snow" ? .38 : .48, 32);
        break;
      case "hit":
        if (event.sourceKind && event.sourceKind !== "nailong" && !event.look) {
          delayed((event.sourceId ?? 0) % 2 ? "chomp" : "chomp2", .48, 75);
        } else if (event.look !== "wave") {
          delayed((event.targetId ?? 0) % 2 ? "splat" : "splat2", .48, 35);
        }
        break;
      case "impact": delayed("thump", event.effect === "gargantuar" ? 1 : .72, 90); break;
      case "flatten": delayed("splat2", .9, 60); break;
      case "explode": delayed(event.effect === "jalapeno" ? "jalapeno" : "cherry", 1, 90); break;
      case "armorBreak": delayed(event.targetKind === "newspaper" ? "paper" : "shield", .9, 80); break;
      case "mower": delayed("mower", .9, 100); break;
      case "death":
        if (event.effect !== "cherry" && event.effect !== "squash") {
          const variant = ((event.targetId ?? 0) % 3 + 1) as 1 | 2 | 3;
          delayed(`groan${variant}` as SoundName, .5, 80);
        }
        break;
    }
  }

  result(winner: "plants" | "zombies" | null): void {
    this.setScene("silent");
    this.play(winner === "plants" ? "win" : "lose", .9, 1200);
  }

  private unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.syncMusic();
  }

  private syncMusic(): void {
    const wanted = this.wantedScene === "silent" ? null : this.music.get(this.wantedScene) ?? null;
    if (this.activeMusic === wanted) return;
    if (this.activeMusic) {
      this.activeMusic.pause();
      this.activeMusic.currentTime = 0;
    }
    this.activeMusic = wanted;
    if (!wanted || this.muted || this.volume === 0) return;
    wanted.volume = this.effectiveVolume(MUSIC_GAIN);
    void wanted.play().catch(() => { /* 下一次用户手势会再次解锁/播放。 */ });
  }

  private play(name: SoundName, gain = 1, minGapMs = 0): void {
    if (!this.unlocked || this.muted || this.volume === 0) return;
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? -Infinity) < minGapMs) return;
    this.lastPlayed.set(name, now);
    let pool = this.pools.get(name);
    if (!pool) {
      pool = Array.from({ length: 4 }, () => {
        const audio = new Audio(SOUND_URLS[name]);
        audio.preload = "auto";
        return audio;
      });
      this.pools.set(name, pool);
    }
    const audio = pool.find((item) => item.paused || item.ended) ?? pool[0]!;
    audio.pause();
    audio.currentTime = 0;
    audio.volume = this.effectiveVolume(gain);
    void audio.play().catch(() => {});
  }

  private applyVolume(): void {
    for (const audio of this.music.values()) audio.volume = this.effectiveVolume(MUSIC_GAIN);
    for (const pool of this.pools.values()) for (const audio of pool) audio.volume = this.effectiveVolume(1);
    if (this.muted || this.volume === 0) {
      this.activeMusic?.pause();
    } else if (this.unlocked) {
      this.syncMusic();
      if (this.activeMusic?.paused) void this.activeMusic.play().catch(() => {});
    }
  }

  private effectiveVolume(gain: number): number {
    return this.muted ? 0 : Math.max(0, Math.min(1, this.volume * gain));
  }

  private loadVolume(): number {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : .72;
  }
}
