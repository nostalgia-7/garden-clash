/**
 * 单位外观表的类型包装。数据在 shared/skins.json，Python 侧的
 * tools/render_check.py 读的是同一份文件，改数值只改 JSON。
 */
import raw from "./skins.json" with { type: "json" };

/** 一个游戏状态对应时间轴上的什么。sections 给多个表示叠加播放。 */
export interface SkinState {
  sections?: string[];
  /** 自动切分不出来时手写的帧区间 */
  range?: [number, number];
  /** 该状态额外点亮的部件组 */
  parts?: string[];
  /** false 表示动作只播放一次并停在末帧。 */
  loop?: boolean;
}

export interface Skin {
  /** public/assets/anim 下的文件名 */
  anim: string;
  /** 常驻点亮的 anim_ 外观部件组 */
  parts: string[];
  /** 强制隐藏的轨道 */
  hidden: string[];
  states: Record<string, SkinState>;
}

const { _comment, ...entries } = raw as Record<string, unknown>;

export const SKINS = entries as unknown as Record<string, Skin>;

export function skin(name: string): Skin {
  const s = SKINS[name];
  if (!s) throw new Error(`没有定义外观: ${name}`);
  return s;
}
