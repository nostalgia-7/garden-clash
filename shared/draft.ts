import {
  PLANT_KINDS, ZOMBIE_KINDS,
  type Side, type UnitKind,
} from "./cards.ts";

export const DRAFT_PICK_COUNT = 6;
export const DRAFT_SECONDS = 45;
export type DraftPhase = "banning" | "picking";

export interface DraftSideState {
  ban: UnitKind | null;
  picks: UnitKind[];
  ready: boolean;
}

export interface DraftState {
  phase: DraftPhase;
  deadline: number;
  plants: DraftSideState;
  zombies: DraftSideState;
}

export function createDraft(now: number): DraftState {
  return {
    phase: "banning", deadline: now + DRAFT_SECONDS * 1000,
    plants: { ban: null, picks: [], ready: false },
    zombies: { ban: null, picks: [], ready: false },
  };
}

export function poolFor(side: Side): readonly UnitKind[] {
  return side === "plants" ? PLANT_KINDS : ZOMBIE_KINDS;
}

export function opposite(side: Side): Side {
  return side === "plants" ? "zombies" : "plants";
}

export function submitBan(draft: DraftState, side: Side, kind: UnitKind, now: number): boolean {
  if (draft.phase !== "banning" || now >= draft.deadline) return false;
  if (draft[side].ban !== null) return false;
  if (!poolFor(opposite(side)).includes(kind)) return false;
  draft[side].ban = kind;
  advanceDraft(draft, now);
  return true;
}

export function submitPicks(draft: DraftState, side: Side, kinds: UnitKind[]): boolean {
  if (draft.phase !== "picking" || draft[side].ready) return false;
  const unique = [...new Set(kinds)];
  const banned = draft[opposite(side)].ban;
  if (unique.length !== DRAFT_PICK_COUNT || (banned !== null && unique.includes(banned))) return false;
  if (!unique.every((kind) => poolFor(side).includes(kind))) return false;
  draft[side].picks = unique;
  draft[side].ready = true;
  return true;
}

export function advanceDraft(draft: DraftState, now: number): void {
  if (draft.phase === "banning" && (bothBanned(draft) || now >= draft.deadline)) {
    if (!draft.plants.ban) draft.plants.ban = poolFor("zombies")[0]!;
    if (!draft.zombies.ban) draft.zombies.ban = poolFor("plants")[0]!;
    draft.phase = "picking";
    draft.deadline = now + DRAFT_SECONDS * 1000;
  }
  if (draft.phase === "picking" && now >= draft.deadline) {
    autoPick(draft, "plants");
    autoPick(draft, "zombies");
  }
}

/** 测试和服务端自检使用；生产请求仍必须走 submitBan/submitPicks。 */
export function autoCompleteDraft(draft: DraftState, now: number): void {
  if (draft.phase === "banning") advanceDraft(draft, Math.max(now, draft.deadline));
  if (draft.phase === "picking") advanceDraft(draft, Math.max(now, draft.deadline));
}

export function draftReady(draft: DraftState): boolean {
  return draft.phase === "picking" && draft.plants.ready && draft.zombies.ready;
}

export function allowedCards(draft: DraftState, side: Side): ReadonlySet<UnitKind> {
  return new Set(draft[side].picks);
}

function bothBanned(draft: DraftState): boolean {
  return draft.plants.ban !== null && draft.zombies.ban !== null;
}

function autoPick(draft: DraftState, side: Side): void {
  if (draft[side].ready) return;
  const banned = draft[opposite(side)].ban;
  draft[side].picks = poolFor(side).filter((kind) => kind !== banned).slice(0, DRAFT_PICK_COUNT);
  draft[side].ready = true;
}
