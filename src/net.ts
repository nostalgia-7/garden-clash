/**
 * 联机客户端：只负责收发消息，不含任何战斗规则或渲染。
 *
 * 上行是「操作意图」（带递增 seq，服务器去重），下行是服务器权威快照。
 * 断线后按 1/2/4/8 秒退避重连，并带上 reconnectToken 恢复原席位。
 */

import type {
  ClientMessage, Command, DraftView, NetRole, NetSide, ServerMessage, Snapshot,
} from "../shared/protocol.ts";
import type { UnitKind } from "../shared/cards.ts";

export interface NetHandlers {
  onWelcome(room: string, role: NetRole): void;
  onRoom(room: string, plants: boolean, zombies: boolean, spectator: boolean): void;
  onDraft(state: DraftView): void;
  onStart(at: number, matchId: string, plantsDeck: UnitKind[], zombiesDeck: UnitKind[]): void;
  onSnapshot(snap: Snapshot, isResume: boolean, plantsDeck?: UnitKind[], zombiesDeck?: UnitKind[]): void;
  onEnded(winner: NetSide | null, reason: string): void;
  onRematch(plants: boolean, zombies: boolean): void;
  onStatus(message: string, error?: boolean): void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000];
const RESUME_KEY = "garden-clash-resume";

interface StoredResume { room: string; preferred: NetRole; token: string }

export class NetClient {
  private socket: WebSocket | null = null;
  private seq = 0;
  private reconnectToken: string | null = null;
  private attempt = 0;
  private retryTimer = 0;
  private closedByUs = false;

  room: string | null = null;
  role: NetRole | null = null;
  /** 服务器最后确认处理到的命令 seq，用于判断本地预览能否落地。 */
  ack = 0;

  constructor(private readonly handlers: NetHandlers) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(room: string, preferred: NetRole): void {
    this.closedByUs = false;
    this.room = room;
    this.role = null;
    this.seq = 0;
    this.ack = 0;
    this.attempt = 0;
    const stored = this.readStoredResume();
    this.reconnectToken = stored?.room === room && stored.preferred === preferred ? stored.token : null;
    this.open(preferred);
  }

  create(preferred: NetRole): void {
    this.startFresh(preferred, { type: "create", preferred });
  }

  canResume(room: string, preferred: NetRole): boolean {
    const stored = this.readStoredResume();
    return stored?.room === room && stored.preferred === preferred;
  }

  private open(preferred: NetRole): void {
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      const join: ClientMessage = this.reconnectToken
        ? { type: "join", room: this.room!, preferred, reconnect: this.reconnectToken }
        : { type: "join", room: this.room!, preferred };
      socket.send(JSON.stringify(join));
    });

    socket.addEventListener("message", (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(message, socket, preferred);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.closedByUs) return;
      // 已经入座过才值得自动重连；否则交由 UI 提示。
      if (this.role && this.reconnectToken) this.scheduleRetry(preferred);
      else this.handlers.onStatus("连接已断开，请重新连接。", true);
    });

    socket.addEventListener("error", () => {
      if (this.socket === socket && !this.role) {
        this.handlers.onStatus("无法连接游戏服务器；请确认服务端已启动。", true);
      }
    });
  }

  private dispatch(message: ServerMessage, socket: WebSocket, preferred: NetRole): void {
    if (this.socket !== socket) return;
    switch (message.type) {
      case "welcome":
        this.role = message.role;
        this.room = message.room;
        this.reconnectToken = message.reconnectToken;
        sessionStorage.setItem(RESUME_KEY, JSON.stringify({
          room: message.room, preferred: message.role, token: message.reconnectToken,
        } satisfies StoredResume));
        this.handlers.onWelcome(message.room, message.role);
        break;
      case "room":
        this.handlers.onRoom(message.room, message.plants, message.zombies, message.spectator);
        break;
      case "draft":
        this.handlers.onDraft(message.state);
        break;
      case "start":
        this.handlers.onStart(message.at, message.matchId, message.plantsDeck, message.zombiesDeck);
        break;
      case "snap":
        this.ack = message.s.ack;
        this.handlers.onSnapshot(message.s, false);
        break;
      case "resume":
        this.ack = message.s.ack;
        this.handlers.onSnapshot(message.s, true, message.plantsDeck, message.zombiesDeck);
        break;
      case "ended":
        this.handlers.onEnded(message.winner, message.reason);
        break;
      case "rematch":
        this.handlers.onRematch(message.plants, message.zombies);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "error":
        this.handlers.onStatus(message.message, true);
        break;
    }
    void preferred;
  }

  private scheduleRetry(preferred: NetRole): void {
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.handlers.onStatus(`连接中断，${wait / 1000} 秒后重连…`, true);
    this.retryTimer = window.setTimeout(() => this.open(preferred), wait);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /** 发一条操作意图，返回它的 seq（用于本地半透明预览的对账）。 */
  sendCommand(cmd: Command): number {
    this.seq++;
    this.send({ type: "cmd", seq: this.seq, cmd });
    return this.seq;
  }

  ban(kind: UnitKind): void { this.send({ type: "ban", kind }); }
  pick(kinds: UnitKind[]): void { this.send({ type: "pick", kinds }); }

  private startFresh(preferred: NetRole, firstMessage: ClientMessage): void {
    this.closedByUs = false; this.room = null; this.role = null; this.reconnectToken = null;
    this.seq = 0; this.ack = 0; this.attempt = 0;
    this.socket?.close();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws`); this.socket = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify(firstMessage)));
    socket.addEventListener("message", (event) => { try { this.dispatch(JSON.parse(String(event.data)) as ServerMessage, socket, preferred); } catch { /* ignore */ } });
    socket.addEventListener("close", () => {
      if (this.socket !== socket || this.closedByUs) return;
      if (this.role && this.reconnectToken) this.scheduleRetry(this.role);
      else this.handlers.onStatus("连接已关闭，请重试。", true);
    });
  }

  surrender(): void { this.send({ type: "surrender" }); }
  rematch(): void { this.send({ type: "rematch" }); }

  disconnect(): void {
    this.closedByUs = true;
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
    this.role = null;
    this.room = null;
    this.reconnectToken = null;
    sessionStorage.removeItem(RESUME_KEY);
  }

  private readStoredResume(): StoredResume | null {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? "null") as Partial<StoredResume> | null;
      if (parsed && typeof parsed.room === "string" && typeof parsed.token === "string"
          && (parsed.preferred === "plants" || parsed.preferred === "zombies" || parsed.preferred === "spectator")) {
        return parsed as StoredResume;
      }
    } catch { /* 损坏的本地恢复信息直接忽略。 */ }
    return null;
  }
}
