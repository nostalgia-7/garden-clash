/**
 * 浏览器主程序。
 *
 * 本地同屏：浏览器以 10Hz 推进 shared/sim.ts。
 * 在线房间：浏览器只发送操作意图，画面完全由服务器权威快照驱动。
 */

import {
  CELL_H, CELL_W, COLS, GRID_RIGHT, GRID_X, GRID_Y, H, ROWS, ROUND_SECONDS, SPAWN_X, W,
  laneY, type PlantKind, type Side, type UnitKind, type ZombieKind,
} from "../shared/cards.ts";
import {
  decodeMower, decodeProjectile, decodeUnit, encodeSnapshot, decodeCaltrop, decodeHook,
  type DecodedCaltrop, type DecodedHook, type DraftView, type NetRole, type NetSide, type Snapshot,
} from "../shared/protocol.ts";
import {
  createSim, enqueueCommand, step, type Command as SimCommand, type SimState,
} from "../shared/sim.ts";
import {
  CARD_VIEW, PLANT_CARDS, ZOMBIE_CARDS, UnitTable,
  type CardView, type RenderMower, type RenderProjectile,
} from "./entities.ts";
import { NetClient, type NetHandlers } from "./net.ts";
import { AssetBank, visualTop, type UnitVisual } from "./render.ts";
import { requireAuthentication } from "./auth.ts";
import QRCode from "qrcode";
import { FxSystem } from "./fx.ts";
import { AlmanacPage, PAGE_H, PAGE_W, hitSlot } from "./almanac.ts";
import { DRAFT_H, DRAFT_W, DraftScreen, hitDraft, type DraftCardState } from "./draft-screen.ts";
import { AudioManager } from "./audio.ts";
import { LATEST_NOTE } from "./changelog.ts";

interface Point { x: number; y: number }
interface CardButton { def: CardView; button: HTMLButtonElement; shade: HTMLElement }

const PLANT_SET = new Set<UnitKind>(PLANT_CARDS.map((card) => card.kind));
const FIXED_DT = 0.1;

/**
 * 复制一段文本，返回是否成功。
 *
 * navigator.clipboard 只在**安全上下文**（HTTPS 或 localhost）里存在。电脑端
 * 常用局域网 IP（http://192.168.x.x:5173）打开，这时它是 undefined，直接
 * await 会抛错，表现就是「点了没反应」；平板多半走 https 或 localhost，所以能用。
 * 这里先探测再退回 execCommand，两条都不通才交给调用方兜底。
 */
async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 用户拒权或浏览器拦截，继续走下面的老办法 */ }
  }
  // 老办法：塞进一个屏幕外的 textarea，选中后 execCommand("copy")。
  try {
    const holder = document.createElement("textarea");
    holder.value = text;
    holder.setAttribute("readonly", "");
    holder.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.append(holder);
    holder.select();
    holder.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    holder.remove();
    return ok;
  } catch {
    return false;
  }
}

class Game implements NetHandlers {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly net: NetClient;
  private readonly unitTable: UnitTable;
  private readonly projectiles = new Map<number, RenderProjectile>();
  private readonly mowers = new Map<number, RenderMower>();
  /** 机关盾竹落在地上的竹钉，纯地面装饰，每帧照快照整份替换。 */
  private caltrops: DecodedCaltrop[] = [];
  /** 正在放出的钟馗钩锁，铁链横跨两个单位，也照快照整份替换。 */
  private hooks: DecodedHook[] = [];
  private readonly fx = new FxSystem();
  private readonly audio = new AudioManager();
  private readonly cooldowns = new Map<UnitKind, number>();
  private readonly cardButtons: CardButton[] = [];
  private readonly onlineDecks: Record<Side, Set<UnitKind>> = {
    plants: new Set(PLANT_CARDS.map((card) => card.kind)),
    zombies: new Set(ZOMBIE_CARDS.map((card) => card.kind)),
  };

  private sim: SimState = createSim();
  private localAccumulator = 0;
  private mode: "local" | "online" = "local";
  private onlineSide: NetRole | null = null;
  private onlineRoom: string | null = null;
  private selected: UnitKind = "peashooter";
  private selectedSide: Side = "plants";
  private shovelMode = false;
  private pointer: Point | null = null;
  private sun = 250;
  private brains = 250;
  private remaining = ROUND_SECONDS;
  private running = true;
  private lastFrame = performance.now();
  /** 累计运行秒数，只用于纯装饰的呼吸动画，不参与任何规则计算。 */
  private clock = 0;
  private lastAppliedTick = -1;
  private toastTimer = 0;
  private view: "menu" | "almanac" | "battle" = "menu";
  private almanacSide: Side = "plants";
  private almanacKind: UnitKind = "sunflower";
  private almanacVisual: UnitVisual;
  private readonly almanacPage: AlmanacPage;
  private readonly draftScreen: DraftScreen;
  private draftState: DraftView | null = null;
  private draftSelection = new Set<UnitKind>();
  /** 当前画在选卡界面上的卡，顺序即格子顺序，点击命中要靠它。 */
  private draftCards: DraftCardState[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bank: AssetBank,
  ) {
    const hasInviteRoom = new URLSearchParams(location.search).has("room");
    this.ctx = canvas.getContext("2d")!;
    this.almanacVisual = bank.visual("sunflower", "idle");
    this.almanacPage = new AlmanacPage(bank);
    this.draftScreen = new DraftScreen(bank);
    this.unitTable = new UnitTable(bank);
    this.net = new NetClient(this);
    this.audio.bindControls(
      document.querySelector<HTMLButtonElement>("#audio-toggle")!,
      document.querySelector<HTMLInputElement>("#audio-volume")!,
    );
    // 先建立本地初始快照，但保留邀请 URL；随后 bindLobby 才能读到 room 并自动恢复。
    this.resetLocal(true);
    this.bindUi();
    this.updateUi();
    // 邀请链接必须直接落在对战页并保留已打开的房间对话框；普通访问才显示主菜单。
    this.showView(hasInviteRoom ? "battle" : "menu");
  }

  private bindUi(): void {
    const plants = document.querySelector<HTMLDivElement>("#plant-cards")!;
    const zombies = document.querySelector<HTMLDivElement>("#zombie-cards")!;
    for (const def of [...PLANT_CARDS, ...ZOMBIE_CARDS]) {
      const button = document.createElement("button");
      button.className = "card";
      button.type = "button";
      button.innerHTML = `<span class="card-icon">${def.icon}</span><b>${def.name}</b><small>${def.cost} ${def.side === "plants" ? "阳光" : "脑力"}</small><i class="cooldown"></i>`;
      const shade = button.querySelector<HTMLElement>(".cooldown")!;
      button.addEventListener("click", () => this.choose(def));
      (def.side === "plants" ? plants : zombies).append(button);
      this.cardButtons.push({ def, button, shade });
    }

    this.canvas.addEventListener("pointermove", (event) => { this.pointer = this.eventPoint(event); });
    this.canvas.addEventListener("pointerleave", () => { this.pointer = null; });
    this.canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.place(this.eventPoint(event));
    });
    document.querySelector<HTMLButtonElement>("#shovel")!.addEventListener("click", () => {
      if (this.mode === "online" && this.onlineSide !== "plants") return;
      this.shovelMode = !this.shovelMode;
      this.selectedSide = "plants";
      this.updateUi();
    });
    document.querySelector<HTMLButtonElement>("#restart")!.addEventListener("click", () => {
      if (this.mode === "online") {
        this.net.rematch();
        document.querySelector<HTMLElement>("#result-detail")!.textContent = "已申请再来一局，等待对手确认…";
      } else {
        this.resetLocal();
      }
    });
    document.querySelector<HTMLCanvasElement>("#draft-canvas")!.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.clickDraft(event);
    });

    window.addEventListener("keydown", (event) => {
      // 植物用 1~9、0 选前十张；僵尸用 QWERTYUIOP。
      const plantIndex = "1234567890".indexOf(event.key);
      if (plantIndex >= 0 && plantIndex < PLANT_CARDS.length) this.choose(PLANT_CARDS[plantIndex]!);
      const zombieIndex = "qwertyuiop".indexOf(event.key.toLowerCase());
      if (zombieIndex >= 0 && zombieIndex < ZOMBIE_CARDS.length) this.choose(ZOMBIE_CARDS[zombieIndex]!);
    });
    this.bindLobby();
    this.bindMainMenu();
  }

  private bindMainMenu(): void {
    document.querySelector<HTMLButtonElement>("#menu-online")!.addEventListener("click", () => {
      this.audio.ui("grave");
      this.showView("battle");
      document.querySelector<HTMLDialogElement>("#lobby")!.showModal();
    });
    document.querySelector<HTMLButtonElement>("#menu-local")!.addEventListener("click", () => {
      this.audio.ui("grave");
      this.showView("battle"); this.resetLocal();
    });
    document.querySelector<HTMLButtonElement>("#menu-almanac")!.addEventListener("click", () => { this.audio.ui("grave"); this.openAlmanac("plants"); });
    // 菜单上的花瓶和战斗页的齿轮开同一个设置面板。
    const settings = document.querySelector<HTMLDialogElement>("#settings-dialog")!;
    document.querySelector<HTMLButtonElement>("#menu-settings")!.addEventListener("click", () => { this.audio.ui(); settings.showModal(); });
    document.querySelector<HTMLButtonElement>("#battle-settings")!.addEventListener("click", () => { this.audio.ui(); settings.showModal(); });
    document.querySelector<HTMLButtonElement>("#settings-close")!.addEventListener("click", () => { this.audio.ui(); settings.close(); });
    // 左边那只花瓶开版本更新公告，正文来自 src/changelog.ts。
    const update = document.querySelector<HTMLDialogElement>("#update-dialog")!;
    document.querySelector<HTMLButtonElement>("#menu-update")!.addEventListener("click", () => {
      this.audio.ui("grave");
      this.fillReleaseNote();
      update.showModal();
    });
    document.querySelector<HTMLButtonElement>("#update-close")!.addEventListener("click", () => { this.audio.ui(); update.close(); });
    // 第二块木牌原版刻的就是「如果这不是你的存档，请点我」，正好接账号面板。
    document.querySelector<HTMLButtonElement>("#menu-account")!.addEventListener("click", () => {
      this.audio.ui();
      const account = document.querySelector<HTMLButtonElement>("#account-button")!;
      if (!account.hidden) account.click();
      else document.querySelector<HTMLDialogElement>("#auth-dialog")!.showModal();
    });
    document.querySelector<HTMLButtonElement>("#almanac-plants")!.addEventListener("click", () => { this.audio.ui(); this.openAlmanac("plants"); });
    document.querySelector<HTMLButtonElement>("#almanac-zombies")!.addEventListener("click", () => { this.audio.ui(); this.openAlmanac("zombies"); });
    document.querySelector<HTMLButtonElement>("#almanac-back")!.addEventListener("click", () => { this.audio.ui(); this.showView("menu"); });
    document.querySelector<HTMLCanvasElement>("#almanac-canvas")!.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      this.clickAlmanac(event);
    });
    document.querySelector<HTMLButtonElement>("#back-to-menu")!.addEventListener("click", () => {
      this.audio.ui(); this.net.disconnect(); this.showView("menu");
    });
    // 主菜单 800×600 画板随窗口 letterbox 缩放，跟图鉴/选卡同一套思路。
    fitSelectorBoard();
  }

  /** 公告正文每次打开时重填一遍，改 changelog.ts 就能换内容，不用动这里。 */
  private fillReleaseNote(): void {
    document.querySelector<HTMLElement>("#update-version")!.textContent = LATEST_NOTE.version;
    const date = document.querySelector<HTMLTimeElement>("#update-date")!;
    date.dateTime = LATEST_NOTE.date;
    date.textContent = LATEST_NOTE.date;
    document.querySelector<HTMLUListElement>("#update-items")!.replaceChildren(
      ...LATEST_NOTE.items.map((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        return item;
      }),
    );
  }

  private showView(view: "menu" | "almanac" | "battle"): void {
    this.view = view;
    document.querySelector<HTMLElement>("#main-menu")!.hidden = view !== "menu";
    document.querySelector<HTMLElement>("#almanac")!.hidden = view !== "almanac";
    document.querySelector<HTMLElement>("#battle-view")!.hidden = view !== "battle";
    if (view !== "battle") document.querySelector<HTMLDialogElement>("#lobby")!.close();
    this.audio.setScene(view === "battle" ? "battle" : "menu");
    if (view === "menu") fitSelectorBoard();
  }

  private openAlmanac(side: Side): void {
    this.almanacSide = side;
    const cards = side === "plants" ? PLANT_CARDS : ZOMBIE_CARDS;
    if (!cards.some((card) => card.kind === this.almanacKind)) this.almanacKind = cards[0]!.kind;
    document.querySelector<HTMLButtonElement>("#almanac-plants")!.classList.toggle("active", side === "plants");
    document.querySelector<HTMLButtonElement>("#almanac-zombies")!.classList.toggle("active", side === "zombies");
    this.selectAlmanac(this.almanacKind);
    this.showView("almanac");
  }

  private selectAlmanac(kind: UnitKind): void {
    if (this.view === "almanac" && kind !== this.almanacKind) this.audio.ui();
    const card = CARD_VIEW.get(kind)!;
    this.almanacKind = kind;
    this.almanacVisual = this.bank.visual(kind as UnitKind, kind === "nailong" ? "laugh" : card.side === "plants" ? "idle" : "move");
  }

  /** 书页是按 800×600 画的，点击要先换算回这套坐标再做命中测试。 */
  private clickAlmanac(event: PointerEvent): void {
    const canvas = document.querySelector<HTMLCanvasElement>("#almanac-canvas")!;
    const rect = canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (PAGE_W / rect.width);
    const py = (event.clientY - rect.top) * (PAGE_H / rect.height);
    const cards = this.almanacSide === "plants" ? PLANT_CARDS : ZOMBIE_CARDS;
    const hit = hitSlot(this.almanacSide, cards, px, py);
    if (hit) this.selectAlmanac(hit);
  }

  private bindLobby(): void {
    const dialog = document.querySelector<HTMLDialogElement>("#lobby")!;
    const input = document.querySelector<HTMLInputElement>("#room-code")!;
    document.querySelector<HTMLButtonElement>("#online-button")!.addEventListener("click", () => dialog.showModal());
    document.querySelector<HTMLButtonElement>("#create-room")!.addEventListener("click", () => {
      const role = document.querySelector<HTMLInputElement>('input[name="side"]:checked')!.value as NetRole;
      this.mode = "online"; this.onlineSide = null; this.running = false; this.clearRenderState();
      this.setLobbyStatus("正在由服务器创建房间…"); this.net.create(role);
    });
    document.querySelector<HTMLButtonElement>("#join-room")!.addEventListener("click", () => {
      const side = document.querySelector<HTMLInputElement>('input[name="side"]:checked')!.value as NetRole;
      this.connect(input.value, side);
    });
    document.querySelector<HTMLButtonElement>("#share-room")!.addEventListener("click", async () => {
      if (!this.onlineRoom) return;
      const url = new URL(location.href); url.search = ""; url.searchParams.set("room", this.onlineRoom);
      const link = url.toString();
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: `花园攻防战 · 房间 ${this.onlineRoom}`, text: `加入房间 ${this.onlineRoom}`, url: link });
          this.setLobbyStatus(`已打开系统分享，房间 ${this.onlineRoom} 等你朋友加入。`);
          return;
        } catch (error) {
          // 用户主动取消不算错误；仍把二维码/长按链接显示出来，方便换一种方式分享。
          if (error instanceof DOMException && error.name !== "AbortError") console.warn("系统分享失败", error);
        }
      }
      if (await copyText(link)) {
        if (matchMedia("(pointer: coarse)").matches) {
          await this.showShareFallback(link);
          this.setLobbyStatus(`已尝试复制；也可长按链接或扫描二维码分享。`);
        } else {
          this.setLobbyStatus(`房间 ${this.onlineRoom} 的邀请链接已复制。`);
        }
      } else {
        await this.showShareFallback(link);
        this.setLobbyStatus(`无法自动复制：手机请长按链接，或让朋友扫描二维码。`);
      }
    });
    document.querySelector<HTMLButtonElement>("#select-share-link")!.addEventListener("click", () => {
      const field = document.querySelector<HTMLInputElement>("#share-link")!;
      field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
      this.setLobbyStatus("链接已选中：手机长按选择“复制”，电脑按 Ctrl+C。 ");
    });
    document.querySelector<HTMLButtonElement>("#local-mode")!.addEventListener("click", () => {
      dialog.close();
      this.net.disconnect();
      this.resetLocal();
    });
    const params = new URLSearchParams(location.search);
    const room = params.get("room");
    const side = params.get("side");
    if (room) {
      input.value = room;
      if (side === "plants" || side === "zombies" || side === "spectator") {
        const radio = document.querySelector<HTMLInputElement>(`input[name="side"][value="${side}"]`);
        if (radio) radio.checked = true;
        if (this.net.canResume(room, side)) { this.connect(room, side); return; }
      }
      this.setLobbyStatus(`准备加入朋友的房间 ${room}，请选择身份。`);
      dialog.showModal();
    }
  }

  private connect(rawRoom: string, preferred: NetRole): void {
    const room = rawRoom.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (room.length < 4 || room.length > 8) {
      this.setLobbyStatus("房间码需要4～8位字母或数字。", true);
      return;
    }
    this.mode = "online";
    this.onlineSide = null;
    this.onlineRoom = room;
    this.running = false;
    this.clearRenderState();
    this.setLobbyStatus("正在连接服务器…");
    document.querySelector<HTMLElement>("#phase")!.textContent = "正在连接房间";
    this.net.connect(room, preferred);
    this.updateUi();
  }

  onWelcome(room: string, side: NetRole): void {
    this.mode = "online";
    this.onlineRoom = room;
    this.onlineSide = side;
    if (side !== "spectator") this.selectFirstCard(side);
    const sideName = side === "plants" ? "植物方" : side === "zombies" ? "僵尸方" : "观战者";
    this.setLobbyStatus(`已进入 ${room}，你是${sideName}；正在等对手。`);
    document.querySelector<HTMLElement>("#phase")!.textContent = `房间 ${room} · 等待对手`;
    document.querySelector<HTMLElement>("#mode-label")!.textContent = `联机房间 ${room} · 你操作${sideName}`;
    const button = document.querySelector<HTMLButtonElement>("#online-button")!;
    button.textContent = `房间 ${room}`;
    button.classList.add("connected");
    const input = document.querySelector<HTMLInputElement>("#room-code")!; input.value = room;
    document.querySelector<HTMLButtonElement>("#share-room")!.hidden = false;
    history.replaceState(null, "", `?room=${encodeURIComponent(room)}&side=${side}`);
    this.updateUi();
  }

  onRoom(room: string, plants: boolean, zombies: boolean, spectator: boolean): void {
    if (plants && zombies) this.setLobbyStatus(`房间 ${room}：双方已到，观战席${spectator ? "已占用" : "空闲"}，准备开局…`);
    else this.setLobbyStatus(`房间 ${room}：${plants ? "植物方已到" : "缺植物方"}，${zombies ? "僵尸方已到" : "缺僵尸方"}，观战席${spectator ? "已占用" : "空闲"}。`);
  }

  onDraft(state: DraftView): void {
    const phaseChanged = this.draftState?.phase !== state.phase;
    this.draftState = state;
    if (phaseChanged) this.draftSelection.clear();
    if (state.phase === "banning" && state.myBan) this.draftSelection = new Set([state.myBan]);
    if (state.phase === "picking" && state.myPicks.length) this.draftSelection = new Set(state.myPicks);
    document.querySelector<HTMLDialogElement>("#lobby")!.close();
    document.querySelector<HTMLElement>("#draft")!.hidden = false;
    this.showView("battle");
    this.renderDraft();
  }

  onStart(at: number, _matchId: string, plantsDeck: UnitKind[], zombiesDeck: UnitKind[]): void {
    this.setOnlineDecks(plantsDeck, zombiesDeck);
    document.querySelector<HTMLElement>("#draft")!.hidden = true;
    this.draftState = null;
    this.running = false;
    this.clearRenderState();
    this.setLobbyStatus("双方已到齐，马上开战！");
    document.querySelector<HTMLElement>("#phase")!.textContent = "双方已到齐 · 准备";
    window.setTimeout(() => {
      this.running = true;
      this.lastAppliedTick = -1;
      this.remaining = ROUND_SECONDS;
      document.querySelector<HTMLElement>("#result")!.hidden = true;
      document.querySelector<HTMLDialogElement>("#lobby")!.close();
      document.querySelector<HTMLElement>("#phase")!.textContent = "战斗进行中";
      this.toast(this.onlineSide === "spectator" ? "观战开始" : `你是${this.onlineSide === "plants" ? "植物方" : "僵尸方"}，开始！`);
      this.updateUi();
    }, Math.max(0, at - Date.now()));
  }

  onSnapshot(snap: Snapshot, isResume: boolean, plantsDeck?: UnitKind[], zombiesDeck?: UnitKind[]): void {
    if (plantsDeck && zombiesDeck) this.setOnlineDecks(plantsDeck, zombiesDeck);
    document.querySelector<HTMLElement>("#draft")!.hidden = true;
    if (isResume) {
      this.clearRenderState();
      this.toast("已恢复对局状态");
      document.querySelector<HTMLDialogElement>("#lobby")!.close();
    }
    this.running = snap.phase === "playing";
    this.applySnapshot(snap);
  }

  onEnded(winner: NetSide | null, reason: string): void {
    this.running = false;
    this.showResult(winner, reason);
  }

  onRematch(plants: boolean, zombies: boolean): void {
    const detail = document.querySelector<HTMLElement>("#result-detail")!;
    detail.textContent = `再来一局：植物方${plants ? "已确认" : "等待"}，僵尸方${zombies ? "已确认" : "等待"}。`;
  }

  onStatus(message: string, error = false): void {
    this.setLobbyStatus(message, error);
    if (error && this.mode === "online") document.querySelector<HTMLElement>("#phase")!.textContent = "正在重新连接";
  }

  private setLobbyStatus(message: string, error = false): void {
    const status = document.querySelector<HTMLElement>("#lobby-status")!;
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  /** 自动复制失败时，提供移动端可长按的链接、打开按钮和二维码。 */
  private async showShareFallback(link: string): Promise<void> {
    const panel = document.querySelector<HTMLElement>("#share-fallback")!;
    const field = document.querySelector<HTMLInputElement>("#share-link")!;
    const open = document.querySelector<HTMLAnchorElement>("#open-share-link")!;
    const qr = document.querySelector<HTMLCanvasElement>("#share-qr")!;
    panel.hidden = false;
    field.value = link;
    open.href = link;
    try {
      await QRCode.toCanvas(qr, link, { width: 180, margin: 1, errorCorrectionLevel: "M" });
    } catch (error) {
      console.warn("二维码生成失败", error);
      qr.hidden = true;
    }
  }

  private resetLocal(preserveUrl = false): void {
    this.mode = "local";
    this.onlineSide = null;
    this.onlineRoom = null;
    this.onlineDecks.plants = new Set(PLANT_CARDS.map((card) => card.kind));
    this.onlineDecks.zombies = new Set(ZOMBIE_CARDS.map((card) => card.kind));
    document.querySelector<HTMLElement>("#draft")!.hidden = true;
    this.sim = createSim();
    this.localAccumulator = 0;
    this.selected = "peashooter";
    this.selectedSide = "plants";
    this.shovelMode = false;
    this.running = true;
    this.lastAppliedTick = -1;
    this.clearRenderState();
    this.applySnapshot(encodeSnapshot(this.sim, 0));
    document.querySelector<HTMLElement>("#result")!.hidden = true;
    document.querySelector<HTMLElement>("#phase")!.textContent = "战斗进行中";
    document.querySelector<HTMLElement>("#mode-label")!.textContent = "同屏双人：植物方操作上排，僵尸方操作下排";
    const online = document.querySelector<HTMLButtonElement>("#online-button")!;
    online.textContent = "联机房间";
    online.classList.remove("connected");
    if (!preserveUrl) history.replaceState(null, "", location.pathname);
    this.updateUi();
  }

  private clearRenderState(): void {
    this.unitTable.clear();
    this.projectiles.clear();
    this.mowers.clear();
    this.fx.clear();
    this.cooldowns.clear();
  }

  private selectFirstCard(side: Side): void {
    const first = side === "plants" ? PLANT_CARDS[0]! : ZOMBIE_CARDS[0]!;
    this.selected = first.kind;
    this.selectedSide = side;
    this.shovelMode = false;
  }

  private choose(def: CardView): void {
    if (this.mode === "online" && this.onlineSide !== def.side) return;
    if (this.mode === "online" && !this.onlineDecks[def.side].has(def.kind)) return;
    this.selected = def.kind;
    this.selectedSide = def.side;
    this.shovelMode = false;
    this.updateUi();
  }

  private place(point: Point): void {
    if (!this.running) return;
    const row = Math.floor((point.y - GRID_Y) / CELL_H);
    if (row < 0 || row >= ROWS) { this.toast("请选择一条有效路线"); return; }
    if (this.shovelMode) {
      const col = Math.floor((point.x - GRID_X) / CELL_W);
      if (col < 0 || col >= COLS) { this.toast("请点击要铲除的植物"); return; }
      this.issue({ k: "shovel", row, col });
      return;
    }

    const def = CARD_VIEW.get(this.selected)!;
    if (this.mode === "online" && def.side !== this.onlineSide) return;
    if (this.mode === "online" && !this.onlineDecks[def.side].has(def.kind)) return;
    if ((this.cooldowns.get(def.kind) ?? 0) > 0) { this.toast(`${def.name}还在冷却`); return; }
    const resource = def.side === "plants" ? this.sun : this.brains;
    if (resource < def.cost) { this.toast(def.side === "plants" ? "阳光不够" : "脑力不够"); return; }

    if (def.side === "plants") {
      const col = Math.floor((point.x - GRID_X) / CELL_W);
      if (col < 0 || col >= COLS) { this.toast("植物只能种在草坪格子里"); return; }
      if (this.occupied(row, col)) { this.toast("这个格子已经有植物了"); return; }
      this.issue({ k: "plant", row, col, kind: def.kind as PlantKind });
    } else {
      if (point.x < GRID_RIGHT + 15) { this.toast("请点击草坪右侧道路上的一条路线"); return; }
      this.issue({ k: "zombie", row, kind: def.kind as ZombieKind });
    }
  }

  private issue(command: Exclude<SimCommand, { k: "surrender" }>): void {
    if (this.mode === "online") {
      this.net.sendCommand(command);
      return;
    }
    const result = enqueueCommand(this.sim, command);
    if (!result.ok) this.toast(result.reason ?? "操作失败");
    this.applySnapshot(encodeSnapshot(this.sim, 0));
    this.sim.events.length = 0;
  }

  private occupied(row: number, col: number): boolean {
    const left = GRID_X + col * CELL_W;
    const right = left + CELL_W;
    return [...this.unitTable.units.values()].some(
      (unit) => unit.side === "plants" && unit.row === row && unit.targetX >= left && unit.targetX < right,
    );
  }

  private applySnapshot(snap: Snapshot): void {
    this.sun = snap.sun;
    this.brains = snap.brains;
    this.remaining = snap.rem;
    this.cooldowns.clear();
    for (const [kind, value] of snap.cd) this.cooldowns.set(kind as UnitKind, value);

    this.unitTable.markAll();
    for (const tuple of snap.u) {
      const unit = decodeUnit(tuple);
      this.unitTable.upsert({
        ...unit,
        side: PLANT_SET.has(unit.kind) ? "plants" : "zombies",
      });
    }
    this.unitTable.sweep();

    for (const projectile of this.projectiles.values()) projectile.stale = true;
    for (const tuple of snap.p) {
      const data = decodeProjectile(tuple);
      const current = this.projectiles.get(data.id);
      if (current) {
        current.previousX = current.targetX;
        current.targetX = data.x; current.targetY = data.y;
        current.frozen = data.frozen; current.stale = false;
      } else {
        this.projectiles.set(data.id, {
          id: data.id, renderX: data.x, renderY: data.y,
          targetX: data.x, targetY: data.y, frozen: data.frozen,
          look: data.look, previousX: data.x, stale: false,
        });
      }
    }
    for (const [id, projectile] of this.projectiles) if (projectile.stale) this.projectiles.delete(id);

    for (const tuple of snap.m) {
      const data = decodeMower(tuple);
      const current = this.mowers.get(data.row);
      if (current) {
        current.targetX = data.x;
        if (current.state !== data.state) current.visual.setState(data.state === "spent" ? "idle" : data.state);
        current.state = data.state;
      } else {
        this.mowers.set(data.row, {
          row: data.row, renderX: data.x, targetX: data.x, state: data.state,
          visual: this.bank.visual("lawnmower", data.state === "spent" ? "idle" : data.state),
        });
      }
    }

    // 竹钉是没有动画的地面物件，直接照快照替换整份列表。
    this.caltrops = snap.c.map(decodeCaltrop);
    // 钩锁同理；`?? []` 是为了兼容旧版服务器发来的快照。
    this.hooks = (snap.hk ?? []).map(decodeHook);

    if (snap.t > this.lastAppliedTick) {
      for (const event of snap.ev) {
        const targetStillVisible = event.targetId !== undefined && this.unitTable.units.has(event.targetId);
        this.fx.consume(event, snap.t, this.bank, targetStillVisible);
        this.audio.consume(event);
        if (event.kind === "mower" && event.row !== undefined) this.toast(`第 ${event.row + 1} 路割草机启动！`);
      }
      this.lastAppliedTick = snap.t;
    }
    if (snap.phase === "ended" && snap.winner) this.showResult(snap.winner, "over");
    this.updateUi();
  }

  start(): void {
    const frame = (now: number) => {
      const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
      this.lastFrame = now;
      this.clock += dt;
      if (this.view === "battle" && this.mode === "local" && this.running) {
        this.localAccumulator += dt;
        while (this.localAccumulator >= FIXED_DT) {
          this.localAccumulator -= FIXED_DT;
          step(this.sim, FIXED_DT);
          this.applySnapshot(encodeSnapshot(this.sim, 0));
          this.sim.events.length = 0;
          if (this.sim.phase === "ended") {
            this.running = false;
            this.showResult(this.sim.winner, this.sim.endReason ?? "over");
            break;
          }
        }
      }
      this.animate(dt);
      if (this.view === "almanac") this.almanacVisual.advance(dt);
      if (this.draftState) this.updateDraftTimer();
      this.draw();
      if (this.view === "almanac") this.drawAlmanacPortrait();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private animate(dt: number): void {
    const amount = 1 - Math.exp(-18 * dt);
    for (const unit of this.unitTable.units.values()) {
      unit.renderX += (unit.targetX - unit.renderX) * amount;
      unit.renderY += (unit.targetY - unit.renderY) * amount;
      unit.visual.advance(dt);
    }
    for (const projectile of this.projectiles.values()) {
      projectile.renderX += (projectile.targetX - projectile.renderX) * amount;
      projectile.renderY += (projectile.targetY - projectile.renderY) * amount;
    }
    for (const mower of this.mowers.values()) {
      mower.renderX += (mower.targetX - mower.renderX) * amount;
      mower.visual.advance(dt);
    }
    this.fx.update(dt);
    this.toastTimer = Math.max(0, this.toastTimer - dt);
    if (this.toastTimer === 0) document.querySelector("#toast")!.classList.remove("show");
  }

  private draw(): void {
    if (this.view !== "battle") return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    const camera = this.fx.cameraOffset(this.clock);
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.drawImage(this.bank.background, 0, 0, W, H);
    this.drawBoardOverlay(ctx);

    this.fx.drawBack(ctx, this.bank);

    // 竹钉铺在地上，画在单位之前，免得挡住踩上来的僵尸。
    for (const spike of this.caltrops) {
      const y = laneY(spike.row);
      ctx.save();
      ctx.strokeStyle = "#14260f";
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      for (const dx of [-22, -7, 8, 23]) {
        ctx.beginPath();
        ctx.moveTo(spike.x + dx - 5, y);
        ctx.lineTo(spike.x + dx, y - 15);
        ctx.lineTo(spike.x + dx + 5, y);
        ctx.closePath();
        ctx.fillStyle = "#c6e07f";
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    const units = [...this.unitTable.units.values()].sort((a, b) => a.row - b.row || a.renderX - b.renderX);
    for (const unit of units) {
      const style = this.fx.unitStyle(unit.id);
      const frozen = unit.frozen ? "sepia(1) saturate(3.2) hue-rotate(145deg) brightness(1.12)" : "none";
      const filter = style.filter !== "none" ? style.filter : frozen;
      const x = unit.renderX + style.offsetX;
      const y = unit.renderY + style.offsetY;
      ctx.save(); ctx.translate(x, y); ctx.scale(style.scaleX, style.scaleY); ctx.translate(-x, -y);
      unit.visual.draw(ctx, this.bank, unit.kind, x, y, (unit.dead ? 0.72 : 1) * style.alpha, filter);
      ctx.restore();
      if (style.alpha > .45) this.drawHealth(ctx, x, visualTop(unit.kind, y) - 8, unit.hp, unit.maxHp, unit.kind === "wallnut" ? 64 : 54);
    }
    // 钩锁画在单位之后：铁链要压在钟馗和被钩植物两端上面才连得住。
    this.drawHookChains(ctx);

    for (const mower of this.mowers.values()) {
      if (mower.state !== "spent") mower.visual.draw(ctx, this.bank, "lawnmower", mower.renderX, laneY(mower.row) - 10);
    }
    for (const shot of this.projectiles.values()) {
      ctx.save();
      if (shot.look === "wave") {
        // 奶龙光波：一道朝左推进的金色弧形能量。
        const grad = ctx.createRadialGradient(shot.renderX, shot.renderY, 1, shot.renderX, shot.renderY, 22);
        grad.addColorStop(0, "rgba(255,250,205,.95)");
        grad.addColorStop(.55, "rgba(255,214,64,.65)");
        grad.addColorStop(1, "rgba(255,184,32,0)");
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(shot.renderX, shot.renderY, 22, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#fff7c4";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(shot.renderX + 8, shot.renderY, 13, Math.PI * 0.62, Math.PI * 1.38);
        ctx.stroke();
      } else {
        const tail = shot.look === "snow" ? "rgba(174,241,255,0)" : "rgba(137,207,77,0)";
        const head = shot.look === "snow" ? "rgba(174,241,255,.75)" : "rgba(137,207,77,.7)";
        const gradient = ctx.createLinearGradient(shot.renderX - 34, shot.renderY, shot.renderX, shot.renderY);
        gradient.addColorStop(0, tail); gradient.addColorStop(1, head);
        ctx.strokeStyle = gradient; ctx.lineWidth = 7; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(shot.renderX - 30, shot.renderY); ctx.lineTo(shot.renderX - 4, shot.renderY); ctx.stroke();
        ctx.shadowBlur = 9;
        ctx.shadowColor = shot.frozen ? "#75e9ff" : "#b8f16d";
        ctx.fillStyle = shot.frozen ? "#b8f5ff" : "#69b83c";
        ctx.beginPath(); ctx.arc(shot.renderX, shot.renderY, 8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    this.fx.drawFront(ctx);
    ctx.restore();
  }

  private drawAlmanacPortrait(): void {
    const canvas = document.querySelector<HTMLCanvasElement>("#almanac-canvas")!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, PAGE_W, PAGE_H);
    const cards = this.almanacSide === "plants" ? PLANT_CARDS : ZOMBIE_CARDS;
    this.almanacPage.draw(ctx, this.almanacSide, cards, this.almanacKind, this.almanacVisual);
  }

  private drawBoardOverlay(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = "#15201542";
    for (let row = 0; row < ROWS; row++) if (row % 2 === 1) ctx.fillRect(GRID_X, GRID_Y + row * CELL_H, COLS * CELL_W, CELL_H);
    if (this.pointer && this.running) {
      const row = Math.floor((this.pointer.y - GRID_Y) / CELL_H);
      const col = Math.floor((this.pointer.x - GRID_X) / CELL_W);
      if (this.selectedSide === "plants" && row >= 0 && row < ROWS && col >= 0 && col < COLS) {
        const occupied = this.occupied(row, col);
        ctx.fillStyle = this.shovelMode ? (occupied ? "#f3d18a70" : "#9b8d7550") : (occupied ? "#ef4f4768" : "#f4ec8760");
        ctx.fillRect(GRID_X + col * CELL_W + 2, GRID_Y + row * CELL_H + 2, CELL_W - 4, CELL_H - 4);
      } else if (this.selectedSide === "zombies" && row >= 0 && row < ROWS && this.pointer.x > GRID_RIGHT) {
        ctx.fillStyle = "#a783c55a";
        ctx.fillRect(GRID_RIGHT, GRID_Y + row * CELL_H + 2, W - GRID_RIGHT, CELL_H - 4);
      }
    }
    ctx.setLineDash([6, 8]); ctx.strokeStyle = "#fff2"; ctx.lineWidth = 1;
    for (let row = 1; row < ROWS; row++) {
      ctx.beginPath(); ctx.moveTo(GRID_X, GRID_Y + row * CELL_H); ctx.lineTo(W, GRID_Y + row * CELL_H); ctx.stroke();
    }
    ctx.restore();

    this.drawSignature(ctx);
    this.drawSpawnLine(ctx);
  }

  /** 草坪中央的署名。原图那条第三方水印已在打包时抹掉，这里画我们自己的。 */
  private drawSignature(ctx: CanvasRenderingContext2D): void {
    const x = GRID_X + (COLS * CELL_W) / 2;
    const y = GRID_Y + (ROWS * CELL_H) / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1c3a1445";
    ctx.fillStyle = "#ffffff26";
    ctx.lineWidth = 2.5;
    ctx.font = "700 30px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.strokeText("夏俊喆的草坪", x, y - 16);
    ctx.fillText("夏俊喆的草坪", x, y - 16);
    ctx.lineWidth = 2;
    ctx.font = "600 22px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.strokeText("作者：czt_7", x, y + 18);
    ctx.fillText("作者：czt_7", x, y + 18);
    ctx.restore();
  }

  /**
   * 草坪右侧的红线：僵尸就是从这条线进场的。
   * 位置直接取 SPAWN_X，跟服务器刷新僵尸用的是同一个常数，不会画偏。
   */
  private drawSpawnLine(ctx: CanvasRenderingContext2D): void {
    const top = GRID_Y;
    const bottom = GRID_Y + ROWS * CELL_H;
    // 用累计帧时间做呼吸，不引入随机数，联机两端表现一致。
    const pulse = 0.55 + Math.sin(this.clock * 3) * 0.2;
    ctx.save();
    ctx.strokeStyle = `rgba(255,64,52,${pulse.toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#ff3b2f";
    ctx.beginPath();
    ctx.moveTo(SPAWN_X, top);
    ctx.lineTo(SPAWN_X, bottom);
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(255,64,52,${(pulse + 0.25).toFixed(3)})`;
    // 顶端小三角，指明僵尸从这里往左推进。
    ctx.beginPath();
    ctx.moveTo(SPAWN_X, top - 2);
    ctx.lineTo(SPAWN_X + 9, top - 12);
    ctx.lineTo(SPAWN_X - 9, top - 12);
    ctx.closePath();
    ctx.fill();

    ctx.font = "600 12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("僵尸入场线", SPAWN_X, top - 15);
    ctx.restore();
  }

  private updateUi(): void {
    document.querySelector<HTMLOutputElement>("#sun")!.value = `☀ ${Math.floor(this.sun)}`;
    document.querySelector<HTMLOutputElement>("#brains")!.value = `🧠 ${Math.floor(this.brains)}`;
    const total = Math.max(0, Math.ceil(this.remaining));
    document.querySelector<HTMLElement>("#timer")!.textContent = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    for (const view of this.cardButtons) {
      const cooldown = this.cooldowns.get(view.def.kind) ?? 0;
      const resource = view.def.side === "plants" ? this.sun : this.brains;
      view.button.disabled = !this.running || cooldown > 0 || resource < view.def.cost;
      if (this.mode === "online" && view.def.side !== this.onlineSide) view.button.disabled = true;
      if (this.mode === "online" && !this.onlineDecks[view.def.side].has(view.def.kind)) view.button.disabled = true;
      view.button.hidden = this.mode === "online" && !this.onlineDecks[view.def.side].has(view.def.kind);
      view.button.classList.toggle("selected", view.def.kind === this.selected && view.def.side === this.selectedSide && !this.shovelMode);
      view.shade.style.height = `${Math.min(100, cooldown / view.def.cooldown * 100)}%`;
      view.button.title = cooldown > 0 ? `冷却 ${cooldown.toFixed(1)} 秒` : `${view.def.name}：${view.def.cost}`;
    }
    document.querySelector(".plants-panel")!.classList.toggle("locked", this.mode === "online" && this.onlineSide !== "plants");
    document.querySelector(".zombies-panel")!.classList.toggle("locked", this.mode === "online" && this.onlineSide !== "zombies");
    const shovel = document.querySelector<HTMLButtonElement>("#shovel")!;
    shovel.disabled = !this.running || (this.mode === "online" && this.onlineSide !== "plants");
    shovel.classList.toggle("selected", this.shovelMode);
    shovel.setAttribute("aria-pressed", String(this.shovelMode));
    this.canvas.classList.toggle("shovel-cursor", this.shovelMode);
  }

  private showResult(winner: Side | null, reason: string): void {
    this.running = false;
    this.audio.result(winner);
    const plantWin = winner === "plants";
    document.querySelector<HTMLElement>("#phase")!.textContent = "本局结束";
    document.querySelector<HTMLElement>("#result-kicker")!.textContent = winner
      ? (plantWin ? "花园守住了最后一道防线" : "一只僵尸闯进了屋子")
      : "本局作废";
    document.querySelector<HTMLElement>("#result-title")!.textContent = winner ? (plantWin ? "植物方胜利" : "僵尸方胜利") : "对局结束";
    const reasonText = reason === "disconnect" ? "对手断线超过60秒。" : reason === "surrender" ? "一方选择了投降。" : "可以调整阵容再来一局。";
    document.querySelector<HTMLElement>("#result-detail")!.textContent = reasonText;
    const restart = document.querySelector<HTMLButtonElement>("#restart")!;
    restart.textContent = this.mode === "online" ? "申请再来一局" : "再战一局";
    restart.hidden = this.mode === "online" && this.onlineSide === "spectator";
    document.querySelector<HTMLElement>("#result")!.hidden = false;
    this.updateUi();
  }

  private setOnlineDecks(plants: UnitKind[], zombies: UnitKind[]): void {
    this.onlineDecks.plants = new Set(plants);
    this.onlineDecks.zombies = new Set(zombies);
    if (this.onlineSide === "plants" && !this.onlineDecks.plants.has(this.selected)) this.selectFirstDeckCard("plants");
    if (this.onlineSide === "zombies" && !this.onlineDecks.zombies.has(this.selected)) this.selectFirstDeckCard("zombies");
    this.updateUi();
  }

  private renderDraft(): void {
    const state = this.draftState;
    if (!state) return;
    const spectator = this.onlineSide === "spectator";
    const pool = spectator ? [] : state.phase === "banning" ? state.opponentPool : state.myPool;
    const locked = state.phase === "banning" ? state.myBan !== null : state.myReady;

    const title = spectator ? "观战 · 双方正在组建卡组"
      : state.phase === "banning" ? "禁用对手 1 张卡" : "选择本局携带的 6 张卡";
    const instruction = spectator
      ? "观战席只读，双方完成后自动进入战斗。"
      : state.phase === "banning"
        ? "从对方卡池选择 1 张；确认后本局对方无法携带。"
        : `被禁用：${state.opponentBan ? CARD_VIEW.get(state.opponentBan)?.name ?? state.opponentBan : "无"}。从剩余卡牌中选择 6 张。`;
    const status = spectator
      ? `植物方${state.plantsReady ? "已完成" : "选择中"} · 僵尸方${state.zombiesReady ? "已完成" : "选择中"}`
      : locked ? "你已确认，等待对手…"
        : state.phase === "banning" ? "Ban 确认后不能更换。"
          : `已选 ${this.draftSelection.size}/6 · 对手${state.opponentReady ? "已完成" : "选择中"}`;

    this.draftCards = pool.map((kind) => ({
      kind,
      selected: this.draftSelection.has(kind),
      banned: state.phase === "picking" && kind === state.opponentBan,
      disabled: locked,
    }));

    const canvas = document.querySelector<HTMLCanvasElement>("#draft-canvas")!;
    const ctx = canvas.getContext("2d")!;
    this.draftScreen.draw(ctx, {
      title, instruction, status,
      seconds: Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000)),
      cards: this.draftCards,
      // Ban 阶段还没有卡组，卡槽条整条不画；Pick 阶段实时反映当前勾选。
      picks: state.phase === "picking" ? [...this.draftSelection] : [],
      showBank: state.phase === "picking",
      // 右栏展示被禁用的卡：Ban 阶段是你正要禁的，Pick 阶段是对手禁掉你的。
      banned: state.phase === "banning" ? ([...this.draftSelection][0] ?? null) : state.opponentBan,
      bannedLabel: state.phase === "banning" ? "你要禁用" : "对手已禁用",
      confirmLabel: locked ? "已确认" : state.phase === "banning" ? "确认禁用" : "确认卡组",
      confirmEnabled: !locked && (state.phase === "banning" ? this.draftSelection.size === 1 : this.draftSelection.size === 6),
      showConfirm: !spectator,
      spectator,
    });
  }

  /** 选卡界面同样按 800×600 画，点击要先换算回这套坐标。 */
  private clickDraft(event: PointerEvent): void {
    const state = this.draftState;
    if (!state || this.onlineSide === "spectator") return;
    const locked = state.phase === "banning" ? state.myBan !== null : state.myReady;
    const canvas = document.querySelector<HTMLCanvasElement>("#draft-canvas")!;
    const rect = canvas.getBoundingClientRect();
    const px = (event.clientX - rect.left) * (DRAFT_W / rect.width);
    const py = (event.clientY - rect.top) * (DRAFT_H / rect.height);
    const hit = hitDraft(this.draftCards, px, py);
    if (hit === null) return;

    if (hit === "confirm") {
      if (locked) return;
      this.audio.ui();
      if (state.phase === "banning") {
        const kind = [...this.draftSelection][0];
        if (kind) this.net.ban(kind);
      } else if (this.draftSelection.size === 6) {
        this.net.pick([...this.draftSelection]);
      }
      return;
    }

    const card = this.draftCards.find((c) => c.kind === hit);
    if (!card || card.disabled || card.banned) return;
    this.audio.ui();
    if (this.draftSelection.has(hit)) this.draftSelection.delete(hit);
    else {
      if (state.phase === "banning") this.draftSelection.clear();
      if (state.phase === "picking" && this.draftSelection.size >= 6) return;
      this.draftSelection.add(hit);
    }
    this.renderDraft();
  }

  private updateDraftTimer(): void {
    if (!this.draftState) return;
    this.renderDraft();
  }

  private selectFirstDeckCard(side: Side): void {
    const kind = [...this.onlineDecks[side]][0];
    if (!kind) return;
    this.selected = kind;
    this.selectedSide = side;
    this.shovelMode = false;
  }

  private eventPoint(event: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * W / rect.width, y: (event.clientY - rect.top) * H / rect.height };
  }

  private toast(message: string): void {
    const toast = document.querySelector<HTMLElement>("#toast")!;
    toast.textContent = message;
    toast.classList.add("show");
    this.toastTimer = 1.6;
  }

  /**
   * 钟馗的钩锁：从胸前收链盘一路画到被钩植物，末端是钩头。
   *
   * 链节必须连续，中间不能断——之前只在钟馗身上画了几个环，钩子却出现在植物
   * 那边，看着就是「无链钩子」。这里按抛物线均匀铺链节，两端都咬死。
   */
  private drawHookChains(ctx: CanvasRenderingContext2D): void {
    for (const hook of this.hooks) {
      const unit = this.unitTable.units.get(hook.zombieId);
      // 用插值后的绘制坐标，链子才不会比钟馗本人晚一帧。
      const fromX = (unit?.renderX ?? hook.x) - 12;
      const fromY = (unit?.renderY ?? laneY(hook.row)) - 52;
      const toX = hook.targetX + 14;
      const toY = hook.targetY - 30;

      const span = Math.hypot(toX - fromX, toY - fromY);
      const links = Math.max(4, Math.round(span / 15));
      // 链子略微下垂，绷成直线会像根棍子。
      const sag = Math.min(26, span * 0.16);

      for (let i = 0; i <= links; i++) {
        const t = i / links;
        const lx = fromX + (toX - fromX) * t;
        const ly = fromY + (toY - fromY) * t + Math.sin(Math.PI * t) * sag;
        // 链节朝着链子的走向躺下。
        const nt = Math.min(1, t + 0.06);
        const nx = fromX + (toX - fromX) * nt;
        const ny = fromY + (toY - fromY) * nt + Math.sin(Math.PI * nt) * sag;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(Math.atan2(ny - ly, nx - lx));
        ctx.beginPath();
        ctx.ellipse(0, 0, 6.5, 4, 0, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 ? "#8f979f" : "#c3cad1";
        ctx.fill();
        ctx.strokeStyle = "#2b2f33";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // 钩头咬在植物上：一枚弯月形的爪钩，钩尖朝回勾住目标。
      ctx.save();
      ctx.translate(toX, toY);
      ctx.rotate(Math.atan2(toY - fromY, toX - fromX) + Math.PI);
      ctx.fillStyle = "#8f979f";
      ctx.strokeStyle = "#22262a";
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // 弯月主体：外圈顺时针、内圈逆时针，中间掏空成钩状。
      ctx.beginPath();
      ctx.arc(0, 0, 12, Math.PI * 0.15, Math.PI * 1.5);
      ctx.arc(0, 0, 5.5, Math.PI * 1.5, Math.PI * 0.15, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 钩尖
      ctx.beginPath();
      ctx.moveTo(11, 3);
      ctx.lineTo(17, 12);
      ctx.lineTo(6, 10);
      ctx.closePath();
      ctx.fillStyle = "#6f767e";
      ctx.fill();
      ctx.stroke();
      // 连链子的那只环
      ctx.beginPath();
      ctx.arc(-9, -9, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawHealth(ctx: CanvasRenderingContext2D, x: number, y: number, hp: number, maxHp: number, width: number): void {
    if (hp >= maxHp || hp <= 0) return;
    const ratio = Math.max(0, hp / maxHp);
    ctx.fillStyle = "#1b1916c9"; ctx.fillRect(x - width / 2 - 1, y - 1, width + 2, 7);
    ctx.fillStyle = ratio > 0.55 ? "#7ed14e" : ratio > 0.25 ? "#f1c64e" : "#e55245";
    ctx.fillRect(x - width / 2, y, width * ratio, 5);
  }
}

/**
 * 主菜单是固定 800×600 的原版画板，靠等比 letterbox 缩放铺满窗口。
 * 放在模块级立刻执行：菜单在 HTML 里默认可见，不能等资源加载完才对齐。
 */
function fitSelectorBoard(): void {
  const board = document.querySelector<HTMLElement>("#selector-board");
  if (!board) return;
  const scale = Math.min(window.innerWidth / 800, window.innerHeight / 600);
  board.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
fitSelectorBoard();
window.addEventListener("resize", fitSelectorBoard);

/**
 * 手机上的横竖屏切换。锁定方向必须先进全屏，且只有部分浏览器支持
 * （安卓 Chrome 可以，iOS Safari 不行），所以失败要如实提示，不要假装成功。
 */
function setupOrientationControls(): void {
  const row = document.querySelector<HTMLElement>("#orientation-row");
  const hint = document.querySelector<HTMLElement>("#settings-hint");
  if (!row || !hint) return;
  // 只认「触屏为主」的设备：带触摸屏的 Windows 桌面 maxTouchPoints 也大于 0，
  // 单看它会误判，所以要连 hover 能力一起判断。
  const touchOnly = matchMedia("(pointer: coarse) and (hover: none)");
  const sync = () => { row.hidden = !touchOnly.matches; };
  sync();
  touchOnly.addEventListener("change", sync);

  type Lockable = ScreenOrientation & { lock?: (o: "landscape" | "portrait") => Promise<void>; unlock?: () => void };
  const orientation = screen.orientation as Lockable | undefined;
  const buttons: Record<string, HTMLButtonElement | null> = {
    landscape: document.querySelector<HTMLButtonElement>("#orient-landscape"),
    portrait: document.querySelector<HTMLButtonElement>("#orient-portrait"),
    auto: document.querySelector<HTMLButtonElement>("#orient-auto"),
  };
  const mark = (active: string) => {
    for (const [key, button] of Object.entries(buttons)) button?.classList.toggle("active", key === active);
  };

  const apply = async (mode: "landscape" | "portrait" | "auto") => {
    hint.textContent = "";
    try {
      if (mode === "auto") {
        orientation?.unlock?.();
        if (document.fullscreenElement) await document.exitFullscreen();
        mark("auto");
        return;
      }
      if (!orientation?.lock) throw new Error("此浏览器不支持锁定方向，请用系统的屏幕旋转");
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      await orientation.lock(mode);
      mark(mode);
    } catch (error) {
      hint.textContent = (error as Error).message || "锁定方向失败，请用系统的屏幕旋转";
      mark("auto");
    }
  };

  buttons.landscape?.addEventListener("click", () => void apply("landscape"));
  buttons.portrait?.addEventListener("click", () => void apply("portrait"));
  buttons.auto?.addEventListener("click", () => void apply("auto"));
  mark("auto");
}
setupOrientationControls();

async function main(): Promise<void> {
  const loading = document.querySelector<HTMLElement>("#loading")!;
  try {
    await requireAuthentication();
    const bank = new AssetBank();
    await bank.load();
    const game = new Game(document.querySelector<HTMLCanvasElement>("#game")!, bank);
    loading.classList.add("done");
    game.start();
  } catch (error) {
    loading.textContent = `启动失败：${(error as Error).message}`;
    loading.style.color = "#ff9388";
    throw error;
  }
}

void main();
