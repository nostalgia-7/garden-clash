/**
 * 花园攻防战：服务器权威对战服务。
 *
 * 所有房间共用一个 10Hz 定步循环（绝不为每房间开计时器）。服务器持有权威
 * SimState，客户端只上报命令意图；服务器每 tick 广播全量快照。改浏览器数据
 * 无法作弊，两端也不会像帧同步那样漂移不同步。
 *
 * 还负责：房间匹配、命令限流、断线 60 秒席位保留 + 重连令牌、投降、再来一局、
 * 心跳，以及给 dist/ 提供静态文件（生产用；开发走 Vite 5173）。
 */

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { PLANT_KINDS, ZOMBIE_KINDS, type UnitKind } from "../shared/cards.ts";
import {
  createSim, step, enqueueCommand, type SimState, type Command as SimCommand,
} from "../shared/sim.ts";
import { encodeSnapshot, type ClientMessage, type ServerMessage, type NetRole, type NetSide } from "../shared/protocol.ts";
import {
  advanceDraft, allowedCards, createDraft, draftReady, opposite, poolFor, submitBan, submitPicks,
  type DraftState,
} from "../shared/draft.ts";
import { authenticate, handleAuthApi, saveMatchRecord, type AuthUser } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const DIST = normalize(join(import.meta.dirname, "..", "dist"));

const TICK_MS = 100;               // 10Hz
const DT = 0.1;
const START_DELAY_MS = 1500;
const RECONNECT_GRACE_MS = 60_000; // 掉线后保留席位
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const REMATCH_WINDOW_MS = 20_000;
const MAX_MSG_BYTES = 4096;
const CMD_PER_SEC = 10;
const CMD_BURST = 20;
const MAX_PLAYER_SEATS = 20;
const MAX_CONNECTIONS = 30;
const PLANT_KIND_SET = new Set<UnitKind>(PLANT_KINDS);
const ZOMBIE_KIND_SET = new Set<UnitKind>(ZOMBIE_KINDS);

interface Player {
  role: NetRole;
  user: AuthUser;
  socket: WebSocket | null;        // 掉线期间为 null，席位仍保留
  reconnectToken: string;
  cmdSeq: number;                  // 已处理到的命令 seq，用于去重与 ack
  cmdBudget: number;               // 限流令牌桶
  lastPong: number;
  disconnectedAt: number | null;
  rematchReady: boolean;
}

interface Room {
  id: string;
  matchId: string;
  players: Map<NetRole, Player>;
  sim: SimState | null;            // 未开局为 null
  phase: "waiting" | "draft" | "countdown" | "playing" | "ended";
  draft: DraftState | null;
  startAt: number;
  endedAt: number;
  startedAt: number;
}

const rooms = new Map<string, Room>();
/** socket → 它所属的房间与玩家，便于消息与断线处理快速定位。 */
const conns = new Map<WebSocket, { room: Room; player: Player }>();

function occupiedSeats(): number {
  let total = 0;
  for (const room of rooms.values()) total += room.players.size;
  return total;
}

function sendMsg(socket: WebSocket | null, message: ServerMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(room: Room, message: ServerMessage): void {
  for (const player of room.players.values()) sendMsg(player.socket, message);
}

function roomStatus(room: Room): void {
  broadcast(room, {
    type: "room", room: room.id,
    plants: room.players.has("plants"), zombies: room.players.has("zombies"),
    spectator: room.players.has("spectator"),
  });
}

function normalizeRoom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const room = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return room.length >= 4 && room.length <= 8 ? room : null;
}

function unusedRoomCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    if (!rooms.has(code)) return code;
  }
  throw new Error("暂时无法生成房间号，请稍后重试。");
}

function userHasSeat(userId: number): boolean {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) if (player.user.id === userId) return true;
  }
  return false;
}

function createRoom(socket: WebSocket, preferred: NetRole): void {
  if (conns.has(socket)) return;
  joinRoom(socket, { type: "join", room: unusedRoomCode(), preferred });
}

function beginCountdown(room: Room): void {
  room.phase = "countdown";
  room.startAt = Date.now() + START_DELAY_MS;
  room.matchId = randomUUID();
  for (const p of room.players.values()) p.rematchReady = false;
  broadcast(room, {
    type: "start", at: room.startAt, matchId: room.matchId,
    plantsDeck: [...(room.draft?.plants.picks ?? [])],
    zombiesDeck: [...(room.draft?.zombies.picks ?? [])],
  });
}

function beginDraft(room: Room): void {
  room.phase = "draft";
  room.sim = null;
  room.draft = createDraft(Date.now());
  for (const p of room.players.values()) p.rematchReady = false;
  broadcastDraft(room);
}

function sendDraft(room: Room, player: Player): void {
  const draft = room.draft;
  if (!draft) return;
  if (player.role === "spectator") {
    sendMsg(player.socket, { type: "draft", state: {
      phase: draft.phase, deadline: draft.deadline,
      myPool: [], opponentPool: [], myBan: null, opponentBan: null, myPicks: [],
      myReady: false, opponentReady: false,
      plantsReady: draft.plants.ready, zombiesReady: draft.zombies.ready,
    } });
    return;
  }
  const side = player.role;
  const opponent = opposite(side);
  sendMsg(player.socket, { type: "draft", state: {
    phase: draft.phase, deadline: draft.deadline,
    myPool: [...poolFor(side)], opponentPool: [...poolFor(opponent)],
    myBan: draft[side].ban, opponentBan: draft[opponent].ban,
    myPicks: [...draft[side].picks], myReady: draft[side].ready,
    opponentReady: draft[opponent].ready,
    plantsReady: draft.plants.ready, zombiesReady: draft.zombies.ready,
  } });
}

function broadcastDraft(room: Room): void {
  for (const player of room.players.values()) sendDraft(room, player);
}

function joinRoom(socket: WebSocket, raw: ClientMessage & { type: "join" }): void {
  if (conns.has(socket)) return;
  const user = socketUsers.get(socket);
  if (!user) { sendMsg(socket, { type: "error", message: "请先登录账号。" }); return; }
  const id = normalizeRoom(raw.room);
  if (!id || (raw.preferred !== "plants" && raw.preferred !== "zombies" && raw.preferred !== "spectator")) {
    sendMsg(socket, { type: "error", message: "房间码需要 4～8 位字母或数字。" });
    return;
  }
  const room = rooms.get(id) ?? {
    id, matchId: randomUUID(), players: new Map<NetRole, Player>(),
    sim: null, phase: "waiting" as const, draft: null, startAt: 0, endedAt: 0, startedAt: 0,
  };
  rooms.set(id, room);

  // 重连：令牌命中某个已掉线的席位 → 恢复它，回发当前快照。
  if (raw.reconnect) {
    for (const player of room.players.values()) {
      if (player.reconnectToken === raw.reconnect && player.socket === null) {
        if (player.user.id !== user.id) continue;
        player.socket = socket;
        player.disconnectedAt = null;
        player.lastPong = Date.now();
        conns.set(socket, { room, player });
        sendMsg(socket, { type: "welcome", room: id, role: player.role, reconnectToken: player.reconnectToken });
        roomStatus(room);
        if (room.sim && room.phase === "playing") {
          sendMsg(socket, {
            type: "resume", s: encodeSnapshot(room.sim, player.cmdSeq, player.role),
            plantsDeck: [...(room.draft?.plants.picks ?? [])], zombiesDeck: [...(room.draft?.zombies.picks ?? [])],
          });
        } else if (room.phase === "draft") {
          sendDraft(room, player);
        } else if (room.phase === "countdown") {
          sendMsg(socket, {
            type: "start", at: room.startAt, matchId: room.matchId,
            plantsDeck: [...(room.draft?.plants.picks ?? [])], zombiesDeck: [...(room.draft?.zombies.picks ?? [])],
          });
        } else if (room.phase === "ended") {
          sendMsg(socket, {
            type: "ended", winner: room.sim?.winner ?? null,
            reason: room.sim?.endReason ?? "over",
          });
        }
        return;
      }
    }
  }

  if (userHasSeat(user.id)) {
    sendMsg(socket, { type: "error", message: "这个账号已经在一个房间里；请回到原页面或等待原席位释放。" });
    if (room.players.size === 0) rooms.delete(room.id);
    return;
  }

  const role = raw.preferred;
  for (const existing of room.players.values()) {
    if (existing.user.id === user.id && existing.role !== role) {
      sendMsg(socket, { type: "error", message: "同一账号不能占用多个房间席位。" });
      return;
    }
  }
  if (room.players.has(role)) {
    const message = role === "spectator"
      ? "这个房间的观战席已经有人了。"
      : `这个房间的${role === "plants" ? "植物方" : "僵尸方"}已经有人，请重新选择。`;
    sendMsg(socket, { type: "error", message });
    return;
  }
  if (occupiedSeats() >= MAX_PLAYER_SEATS) {
    sendMsg(socket, { type: "error", message: "服务器当前已满20人，请稍后再试。" });
    return;
  }
  const player: Player = {
    role, user, socket, reconnectToken: randomUUID(),
    cmdSeq: 0, cmdBudget: CMD_BURST, lastPong: Date.now(),
    disconnectedAt: null, rematchReady: false,
  };
  room.players.set(role, player);
  conns.set(socket, { room, player });
  sendMsg(socket, { type: "welcome", room: id, role, reconnectToken: player.reconnectToken });
  roomStatus(room);
  if (room.players.has("plants") && room.players.has("zombies") && room.phase === "waiting") beginDraft(room);
  // 观战者可以中途入场，立即收到当前对局状态；绝不触发或参与战斗逻辑。
  if (role === "spectator") {
    if (room.sim && room.phase === "playing") {
      sendMsg(socket, {
        type: "resume", s: encodeSnapshot(room.sim, 0),
        plantsDeck: [...(room.draft?.plants.picks ?? [])], zombiesDeck: [...(room.draft?.zombies.picks ?? [])],
      });
    } else if (room.phase === "draft") {
      sendDraft(room, player);
    } else if (room.phase === "countdown") {
      sendMsg(socket, {
        type: "start", at: room.startAt, matchId: room.matchId,
        plantsDeck: [...(room.draft?.plants.picks ?? [])], zombiesDeck: [...(room.draft?.zombies.picks ?? [])],
      });
    } else if (room.phase === "ended") {
      sendMsg(socket, { type: "ended", winner: room.sim?.winner ?? null, reason: room.sim?.endReason ?? "over" });
    }
  }
}

function handleBan(socket: WebSocket, msg: ClientMessage & { type: "ban" }): void {
  const conn = conns.get(socket);
  if (!conn || conn.room.phase !== "draft" || !conn.room.draft || conn.player.role === "spectator") return;
  if (!submitBan(conn.room.draft, conn.player.role, msg.kind, Date.now())) {
    sendMsg(socket, { type: "error", message: "这张卡不能在当前 Ban 阶段选择。" });
    return;
  }
  broadcastDraft(conn.room);
}

function handlePick(socket: WebSocket, msg: ClientMessage & { type: "pick" }): void {
  const conn = conns.get(socket);
  if (!conn || conn.room.phase !== "draft" || !conn.room.draft || conn.player.role === "spectator") return;
  if (!submitPicks(conn.room.draft, conn.player.role, msg.kinds)) {
    sendMsg(socket, { type: "error", message: "请选择 6 张合法且未被禁用的卡。" });
    return;
  }
  broadcastDraft(conn.room);
}

function handleCommand(socket: WebSocket, msg: ClientMessage & { type: "cmd" }): void {
  const conn = conns.get(socket);
  if (!conn || !conn.room.sim || conn.room.phase !== "playing") return;
  const { room, player } = conn;
  const sim = conn.room.sim;
  if (!Number.isSafeInteger(msg.seq) || msg.seq <= player.cmdSeq) return;  // 去重/乱序丢弃
  if (player.cmdBudget < 1) return;                                     // 限流
  player.cmdBudget -= 1;
  player.cmdSeq = msg.seq;

  const cmd = msg.cmd;
  if (!cmd || typeof cmd !== "object" || typeof cmd.k !== "string") return;
  // 归属校验：只能操作自己阵营。命令类型 → SimCommand。
  let simCmd: SimCommand | null = null;
  if (cmd.k === "plant" && player.role === "plants" && PLANT_KIND_SET.has(cmd.kind)
      && !!room.draft && allowedCards(room.draft, "plants").has(cmd.kind)
      && Number.isInteger(cmd.row) && Number.isInteger(cmd.col)) {
    simCmd = { k: "plant", row: cmd.row, col: cmd.col, kind: cmd.kind as never };
  } else if (cmd.k === "zombie" && player.role === "zombies" && ZOMBIE_KIND_SET.has(cmd.kind)
      && !!room.draft && allowedCards(room.draft, "zombies").has(cmd.kind)
      && Number.isInteger(cmd.row)) {
    simCmd = { k: "zombie", row: cmd.row, kind: cmd.kind as never };
  } else if (cmd.k === "shovel" && player.role === "plants"
      && Number.isInteger(cmd.row) && Number.isInteger(cmd.col)) {
    simCmd = { k: "shovel", row: cmd.row, col: cmd.col };
  }
  if (simCmd) {
    const result = enqueueCommand(sim, simCmd);
    if (!result.ok) sendMsg(socket, { type: "error", message: result.reason ?? "操作未被服务器接受。" });
  }
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string") return false;
  if (message.type === "join") {
    return typeof message.room === "string"
      && (message.preferred === "plants" || message.preferred === "zombies" || message.preferred === "spectator")
      && (message.reconnect === undefined || typeof message.reconnect === "string");
  }
  if (message.type === "create") {
    return message.preferred === "plants" || message.preferred === "zombies" || message.preferred === "spectator";
  }
  if (message.type === "cmd") {
    return Number.isSafeInteger(message.seq) && !!message.cmd && typeof message.cmd === "object";
  }
  if (message.type === "ban") return typeof message.kind === "string";
  if (message.type === "pick") return Array.isArray(message.kinds) && message.kinds.length <= 10
    && message.kinds.every((kind) => typeof kind === "string");
  return message.type === "surrender" || message.type === "rematch" || message.type === "pong";
}

function handleSurrender(socket: WebSocket): void {
  const conn = conns.get(socket);
  if (!conn || !conn.room.sim || conn.room.phase !== "playing") return;
  if (conn.player.role !== "spectator") enqueueCommand(conn.room.sim, { k: "surrender", side: conn.player.role });
}

function handleRematch(socket: WebSocket): void {
  const conn = conns.get(socket);
  if (!conn || conn.room.phase !== "ended") return;
  const { room, player } = conn;
  if (Date.now() - room.endedAt > REMATCH_WINDOW_MS) return;
  if (player.role === "spectator") return;
  player.rematchReady = true;
  broadcast(room, {
    type: "rematch",
    plants: room.players.get("plants")?.rematchReady ?? false,
    zombies: room.players.get("zombies")?.rematchReady ?? false,
  });
  const both = room.players.get("plants")?.rematchReady && room.players.get("zombies")?.rematchReady;
  if (both) {
    // 默认交换阵营开新局。
    const swapped = new Map<NetRole, Player>();
    for (const p of room.players.values()) {
      if (p.role !== "spectator") p.role = p.role === "plants" ? "zombies" : "plants";
      p.cmdSeq = 0; p.rematchReady = false;
      swapped.set(p.role, p);
      sendMsg(p.socket, { type: "welcome", room: room.id, role: p.role, reconnectToken: p.reconnectToken });
    }
    room.players = swapped;
    room.sim = null;
    beginDraft(room);
  }
}

function dropPlayer(socket: WebSocket): void {
  const conn = conns.get(socket);
  if (!conn) return;
  conns.delete(socket);
  const { room, player } = conn;
  if (player.socket === socket) player.socket = null;

  if (room.phase === "playing" || room.phase === "countdown" || room.phase === "draft") {
    // 保留席位，等待重连；超时在主循环里判负。
    player.disconnectedAt = Date.now();
    roomStatus(room);
  } else {
    room.players.delete(player.role);
    roomStatus(room);
    if (room.players.size === 0) rooms.delete(room.id);
  }
}

function endMatch(room: Room, winner: NetSide | null, reason: string): void {
  room.phase = "ended";
  room.endedAt = Date.now();
  broadcast(room, { type: "ended", winner, reason });
  saveMatchRecord({
    matchId: room.matchId, room: room.id,
    plantsUserId: room.players.get("plants")?.user.id ?? null,
    zombiesUserId: room.players.get("zombies")?.user.id ?? null,
    winner, reason, startedAt: room.startedAt || room.startAt, endedAt: room.endedAt,
  });
}

function destroyRoom(room: Room): void {
  for (const player of room.players.values()) {
    const socket = player.socket;
    if (socket) {
      conns.delete(socket);
      sendMsg(socket, { type: "error", message: "再来一局确认已超时，请重新进入房间。" });
      socket.close(1000, "room expired");
    }
  }
  rooms.delete(room.id);
}

// ---- 单一 10Hz 主循环：推进所有对局并广播快照 ----
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 补充限流令牌桶（每 tick 给回 CMD_PER_SEC/10 个，上限 CMD_BURST）。
    for (const p of room.players.values()) {
      p.cmdBudget = Math.min(CMD_BURST, p.cmdBudget + CMD_PER_SEC / (1000 / TICK_MS));
    }

    if (room.phase === "ended" && now - room.endedAt > REMATCH_WINDOW_MS) {
      destroyRoom(room);
      continue;
    }

    if (room.phase === "draft" && room.draft) {
      const before = `${room.draft.phase}:${room.draft.deadline}:${room.draft.plants.ready}:${room.draft.zombies.ready}`;
      advanceDraft(room.draft, now);
      const after = `${room.draft.phase}:${room.draft.deadline}:${room.draft.plants.ready}:${room.draft.zombies.ready}`;
      if (before !== after) broadcastDraft(room);
      if (draftReady(room.draft)) beginCountdown(room);
    }

    // 草案/倒计时阶段也保留席位，但必须处理 60 秒未重连，否则房间会永久卡住。
    if (room.phase === "draft" || room.phase === "countdown") {
      let expired = false;
      for (const player of room.players.values()) {
        if (player.disconnectedAt === null || now - player.disconnectedAt <= RECONNECT_GRACE_MS) continue;
        if (player.role === "spectator") {
          room.players.delete("spectator");
          roomStatus(room);
        } else {
          sendMsg(room.players.get(opposite(player.role))?.socket ?? null, {
            type: "error", message: "对手在选卡阶段断线超时，房间已关闭。",
          });
          destroyRoom(room);
          expired = true;
          break;
        }
      }
      if (expired) continue;
    }

    if (room.phase === "countdown" && now >= room.startAt) {
      room.sim = createSim();
      room.phase = "playing";
      room.startedAt = now;
    }

    if (room.phase !== "playing" || !room.sim) continue;

    // 断线超时判负：某方掉线超过保留时限，则判对方胜。
    let forfeit: NetSide | null = null;
    for (const p of room.players.values()) {
      if (p.disconnectedAt !== null && now - p.disconnectedAt > RECONNECT_GRACE_MS) {
        if (p.role === "spectator") {
          room.players.delete("spectator");
          roomStatus(room);
        } else {
          forfeit = p.role === "plants" ? "zombies" : "plants";
        }
      }
    }
    if (forfeit) { endMatch(room, forfeit, "disconnect"); continue; }

    step(room.sim, DT);
    for (const p of room.players.values()) {
      // 观战只需要 5Hz，减少一半广播流量；玩家仍保持 10Hz。
      if (p.role !== "spectator" || room.sim.tick % 2 === 0) {
        sendMsg(p.socket, { type: "snap", s: encodeSnapshot(room.sim, p.cmdSeq, p.role) });
      }
    }
    // 本 tick 的一次性事件已随快照发出，下一 tick 前清空，避免重复播放。
    room.sim.events.length = 0;
    if (room.sim.phase === "ended") {
      endMatch(room, room.sim.winner, room.sim.endReason ?? "over");
    }
  }
}, TICK_MS);

// ---- 心跳：定期 ping，超时判掉线 ----
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (!p.socket) continue;
      if (now - p.lastPong > HEARTBEAT_TIMEOUT_MS) {
        p.socket.terminate();   // 触发 close → dropPlayer 保留席位
        continue;
      }
      sendMsg(p.socket, { type: "ping" });
    }
  }
}, HEARTBEAT_MS);

// ---- 静态文件（生产）。开发环境没有 dist，返回提示。 ----
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
};

const server = createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
  if (await handleAuthApi(request, response, requestPath)) return;
  if (!existsSync(DIST)) {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("Garden Clash server running. Use the Vite dev server on port 5173 during development.");
    return;
  }
  const pathname = requestPath;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = normalize(join(DIST, relative));
  if (!file.startsWith(DIST)) { response.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG_BYTES });
const socketUsers = new Map<WebSocket, AuthUser>();
function socketOriginAllowed(request: import("node:http").IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const forwardedHost = request.headers["x-forwarded-host"]?.toString().split(",")[0]?.trim();
    const expectedHost = forwardedHost || request.headers.host;
    return !!expectedHost && parsed.host.toLowerCase() === expectedHost.toLowerCase();
  } catch { return false; }
}
wss.on("connection", (socket, request) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    sendMsg(socket, { type: "error", message: "服务器连接数已满，请稍后再试。" });
    socket.close(1013, "server busy");
    return;
  }
  const user = authenticate(request);
  if (!user) {
    sendMsg(socket, { type: "error", message: "请先登录账号。" });
    socket.close(1008, "login required");
    return;
  }
  if (!socketOriginAllowed(request)) {
    sendMsg(socket, { type: "error", message: "连接来源不被允许。" }); socket.close(1008, "bad origin"); return;
  }
  for (const [otherSocket, otherUser] of socketUsers) {
    if (otherSocket !== socket && otherUser.id === user.id && otherSocket.readyState === WebSocket.OPEN) {
      sendMsg(socket, { type: "error", message: "这个账号已在另一台设备或页面连接游戏。" });
      socket.close(1008, "account already connected"); return;
    }
  }
  socketUsers.set(socket, user);
  socket.on("message", (data) => {
    if (data.toString().length > MAX_MSG_BYTES) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString()) as unknown;
    } catch {
      sendMsg(socket, { type: "error", message: "收到无法识别的消息。" });
      return;
    }
    if (!isClientMessage(parsed)) {
      sendMsg(socket, { type: "error", message: "收到无法识别的消息。" });
      return;
    }
    const msg = parsed;
    switch (msg.type) {
      case "create": createRoom(socket, msg.preferred); break;
      case "join": joinRoom(socket, msg); break;
      case "cmd": handleCommand(socket, msg); break;
      case "ban": handleBan(socket, msg); break;
      case "pick": handlePick(socket, msg); break;
      case "surrender": handleSurrender(socket); break;
      case "rematch": handleRematch(socket); break;
      case "pong": {
        const conn = conns.get(socket);
        if (conn) conn.player.lastPong = Date.now();
        break;
      }
    }
  });
  socket.on("close", () => { dropPlayer(socket); socketUsers.delete(socket); });
  socket.on("error", () => { dropPlayer(socket); socketUsers.delete(socket); });
});

server.listen(PORT, HOST, () => {
  console.log(`Garden Clash authoritative server on http://${HOST}:${PORT} (10Hz)`);
});
