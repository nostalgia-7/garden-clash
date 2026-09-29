/**
 * 客户端卡牌展示信息与渲染用实体表。
 *
 * 战斗数值在 shared/cards.ts（服务器与本地共用）；这里只放**展示层**信息
 * （中文名、图标）和一个把权威数据映射成可绘制实体的表。
 */

import {
  CARD_STATS, PLANT_STATS, ZOMBIE_STATS, type CardStats,
  type Side, type UnitKind,
} from "../shared/cards.ts";
import type { ProjectileLook } from "../shared/protocol.ts";
import type { AssetBank, SkinName, UnitVisual } from "./render.ts";
import { GARGANTUAR_IMP_TRACKS } from "./render.ts";
import { ShieldBambooVisual } from "./unit-art.ts";

export interface CardView extends CardStats {
  name: string;
  icon: string;
}

const DISPLAY: Record<string, { name: string; icon: string }> = {
  sunflower: { name: "向日葵", icon: "🌻" },
  peashooter: { name: "豌豆射手", icon: "🟢" },
  snowpea: { name: "寒冰射手", icon: "❄️" },
  threepeater: { name: "三线射手", icon: "🔱" },
  wallnut: { name: "坚果墙", icon: "🥜" },
  tallnut: { name: "高坚果", icon: "🧱" },
  potatomine: { name: "土豆雷", icon: "💥" },
  squash: { name: "窝瓜", icon: "🎃" },
  cherrybomb: { name: "樱桃炸弹", icon: "🍒" },
  jalapeno: { name: "火爆辣椒", icon: "🌶️" },
  shieldbamboo: { name: "机关盾竹", icon: "🛡️" },
  zombie: { name: "普通僵尸", icon: "🧟" },
  conehead: { name: "路障僵尸", icon: "🔶" },
  buckethead: { name: "铁桶僵尸", icon: "🪣" },
  screendoor: { name: "铁门僵尸", icon: "🚪" },
  newspaper: { name: "读报僵尸", icon: "📰" },
  polevaulter: { name: "撑杆僵尸", icon: "🤸" },
  dancer: { name: "舞王僵尸", icon: "🕺" },
  backupdancer: { name: "伴舞僵尸", icon: "💃" },
  football: { name: "橄榄球僵尸", icon: "🏈" },
  nailong: { name: "奶龙僵尸", icon: "🐲" },
  shadowstrike: { name: "影袭僵尸", icon: "🗡️" },
  zhongkui: { name: "钟馗僵尸", icon: "⛓️" },
  mimicsunflower: { name: "伪装向日葵", icon: "🌼" },
  gargantuar: { name: "巨人僵尸", icon: "🪨" },
  imp: { name: "小鬼僵尸", icon: "👶" },
};

function view(stats: CardStats): CardView {
  const d = DISPLAY[stats.kind] ?? { name: stats.kind, icon: "❔" };
  return { ...stats, name: d.name, icon: d.icon };
}

export const PLANT_CARDS: CardView[] = PLANT_STATS.map(view);
export const ZOMBIE_CARDS: CardView[] = ZOMBIE_STATS.map(view);
export const CARD_VIEW = new Map<UnitKind, CardView>(
  [...CARD_STATS.values()].map((s) => [s.kind, view(s)]),
);

export function cardName(kind: UnitKind): string {
  return CARD_VIEW.get(kind)?.name ?? kind;
}

/**
 * 一个可绘制单位。位置用 render/target 两套：权威数据写 target，
 * 每帧把 render 朝 target 插值，这样 10Hz 的快照也能画出平滑移动。
 */
export interface RenderUnit {
  id: number;
  kind: UnitKind;
  side: Side;
  row: number;
  renderX: number;
  renderY: number;
  targetX: number;
  targetY: number;
  hp: number;
  maxHp: number;
  frozen: boolean;
  dead: boolean;
  visual: UnitVisual;
  /** 已经不在最新一帧里，播完死亡动画后移除。 */
  stale: boolean;
}

export interface RenderProjectile {
  id: number;
  renderX: number;
  renderY: number;
  targetX: number;
  targetY: number;
  frozen: boolean;
  /** 绘制样式：豌豆、寒冰豆，或奶龙的光波。 */
  look: ProjectileLook;
  /** 最近一次权威位置，用来画有方向的短尾迹。 */
  previousX: number;
  stale: boolean;
}

export interface RenderMower {
  row: number;
  renderX: number;
  targetX: number;
  state: "idle" | "active" | "spent";
  visual: UnitVisual;
}

/** 单位表：按 id 复用 Visual，避免每帧重建动画导致抖动。 */
export class UnitTable {
  readonly units = new Map<number, RenderUnit>();

  constructor(private readonly bank: AssetBank) {}

  /**
   * 用权威数据更新一个单位。首次出现时建 Visual；kind 变化（护具被打掉）
   * 时换 Visual；state 变化时切动画。
   */
  upsert(data: {
    id: number; kind: UnitKind; side: Side; row: number; x: number; y: number;
    hp: number; maxHp: number; state: string; frozen: boolean; dead: boolean;
    impHidden?: boolean;
    /** 机关盾竹已破的护盾层数，决定画哪个形态。 */
    shieldsBroken?: number;
  }): void {
    let unit = this.units.get(data.id);
    if (!unit) {
      unit = {
        id: data.id, kind: data.kind, side: data.side, row: data.row,
        renderX: data.x, renderY: data.y, targetX: data.x, targetY: data.y,
        hp: data.hp, maxHp: data.maxHp, frozen: data.frozen, dead: data.dead,
        visual: this.bank.visual(data.kind as SkinName, data.state), stale: false,
      };
      this.units.set(data.id, unit);
    } else if (unit.kind !== data.kind) {
      // 路障/铁桶护具被打掉后变普通僵尸，换整套外观。
      unit.kind = data.kind;
      unit.visual = this.bank.visual(data.kind as SkinName, data.state);
    }
    unit.row = data.row;
    unit.targetX = data.x;
    unit.targetY = data.y;
    unit.hp = data.hp;
    unit.maxHp = data.maxHp;
    unit.frozen = data.frozen;
    unit.dead = data.dead;
    unit.stale = false;
    unit.visual.setState(data.state);
    if (data.impHidden) unit.visual.hideTracks(GARGANTUAR_IMP_TRACKS);
    // 机关盾竹的形态来自权威血量，不是动画状态，得单独同步过去。
    if (unit.visual instanceof ShieldBambooVisual) {
      unit.visual.setShields(data.shieldsBroken ?? 0);
    }
  }

  /** 标记全部为待确认；本帧没被 upsert 的即为已消失。 */
  markAll(): void {
    for (const unit of this.units.values()) unit.stale = true;
  }

  /** 移除本帧消失的单位。死亡动画由服务器的 death 状态驱动，这里直接删。 */
  sweep(): void {
    for (const [id, unit] of this.units) {
      if (unit.stale) this.units.delete(id);
    }
  }

  clear(): void {
    this.units.clear();
  }
}
