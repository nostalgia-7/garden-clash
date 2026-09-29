/** SQLite账号、邀请码、头像和Cookie会话。 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";

const SESSION_COOKIE = "garden_session";
const SESSION_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 180 * 1024;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILURES = 8;
const MAX_HASH_QUEUE = 12;
const DATA_DIR = normalize(process.env.GARDEN_DATA_DIR ?? join(import.meta.dirname, "..", "data"));
const DB_PATH = join(DATA_DIR, "garden-clash.sqlite");

export interface AuthUser { id: number; account: string; avatarHash: string }
interface UserRow {
  id: number; account: string; avatar_hash: string;
  password_hash?: Uint8Array; password_salt?: Uint8Array;
  avatar_mime?: string; avatar_blob?: Uint8Array;
}

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=3000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    account_key TEXT NOT NULL UNIQUE,
    password_hash BLOB NOT NULL,
    password_salt BLOB NOT NULL,
    avatar_mime TEXT NOT NULL,
    avatar_blob BLOB NOT NULL,
    avatar_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    disabled_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    used_by INTEGER REFERENCES users(id),
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS match_records (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL UNIQUE,
    room_code TEXT NOT NULL,
    plants_user_id INTEGER REFERENCES users(id),
    zombies_user_id INTEGER REFERENCES users(id),
    winner TEXT,
    reason TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
`);

const getUserByAccount = db.prepare("SELECT id,account,password_hash,password_salt,avatar_hash FROM users WHERE account_key=? AND disabled_at IS NULL");
const getUserById = db.prepare("SELECT id,account,avatar_hash FROM users WHERE id=? AND disabled_at IS NULL");
const getAvatar = db.prepare("SELECT avatar_mime,avatar_blob,avatar_hash FROM users WHERE id=? AND disabled_at IS NULL");
const getInvite = db.prepare("SELECT id,expires_at,used_at FROM invite_codes WHERE code_hash=?");
const insertUser = db.prepare("INSERT INTO users(account,account_key,password_hash,password_salt,avatar_mime,avatar_blob,avatar_hash,created_at) VALUES(?,?,?,?,?,?,?,?)");
const useInvite = db.prepare("UPDATE invite_codes SET used_by=?,used_at=? WHERE id=? AND used_at IS NULL");
const insertSession = db.prepare("INSERT INTO sessions(user_id,token_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)");
const sessionUser = db.prepare(`SELECT u.id,u.account,u.avatar_hash FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`);
const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash=?");
const touchSession = db.prepare("UPDATE sessions SET last_seen_at=? WHERE token_hash=?");
const insertInvite = db.prepare("INSERT INTO invite_codes(code_hash,created_at,expires_at) VALUES(?,?,?)");
const deleteUserSessions = db.prepare("DELETE FROM sessions WHERE user_id=?");

let hashQueue: Promise<void> = Promise.resolve();
let pendingHashes = 0;
function queuedHash(password: string, salt: Uint8Array): Promise<Buffer> {
  if (pendingHashes >= MAX_HASH_QUEUE) return Promise.reject(new Error("登录请求过多，请稍后再试"));
  pendingHashes++;
  const job = hashQueue.then(async () => Buffer.from(await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error); else resolve(derived);
    });
  })));
  hashQueue = job.then(() => undefined, () => undefined);
  return job.finally(() => { pendingHashes--; });
}

interface AuthFailures { count: number; firstAt: number }
const authFailures = new Map<string, AuthFailures>();
function requestIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}
function requestOriginAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // 同源表单、curl和WebSocket客户端可以没有Origin。
  try {
    const parsed = new URL(origin);
    const forwardedHost = request.headers["x-forwarded-host"]?.toString().split(",")[0]?.trim();
    const expectedHost = forwardedHost || request.headers.host;
    return !!expectedHost && parsed.host.toLowerCase() === expectedHost.toLowerCase();
  } catch { return false; }
}
function rateKey(request: IncomingMessage, account: string): string { return `${requestIp(request)}|${account}`; }
function assertAuthAllowed(key: string): void {
  const entry = authFailures.get(key), now = Date.now();
  if (!entry) return;
  if (now - entry.firstAt >= AUTH_WINDOW_MS) { authFailures.delete(key); return; }
  if (entry.count >= AUTH_MAX_FAILURES) throw new Error("登录尝试过多，请10分钟后再试");
}
function recordAuthFailure(key: string): void {
  const now = Date.now(), current = authFailures.get(key);
  if (!current || now - current.firstAt >= AUTH_WINDOW_MS) authFailures.set(key, { count: 1, firstAt: now });
  else current.count++;
  if (authFailures.size > 1000) {
    for (const [entryKey, entry] of authFailures) if (now - entry.firstAt >= AUTH_WINDOW_MS) authFailures.delete(entryKey);
  }
}

function sha(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new Error("请求格式不正确"); }
}

function cookies(request: IncomingMessage): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey) result.set(rawKey, decodeURIComponent(rest.join("=")));
  }
  return result;
}

function avatarFromDataUrl(value: unknown): { mime: string; bytes: Buffer; hash: string } {
  if (typeof value !== "string") throw new Error("请上传并裁剪头像");
  const match = /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error("头像只支持WebP、PNG或JPEG");
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length < 16 || bytes.length > 100 * 1024) throw new Error("头像必须小于100KB");
  const mime = match[1]!;
  const webp = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if ((mime === "image/webp" && !webp) || (mime === "image/png" && !png) || (mime === "image/jpeg" && !jpeg)) {
    throw new Error("头像文件内容与格式不符");
  }
  const dimensions = imageDimensions(bytes, mime);
  if (!dimensions || dimensions.width !== 128 || dimensions.height !== 128) throw new Error("头像必须裁剪为128×128像素");
  return { mime, bytes, hash: sha(bytes) };
}

function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === "image/webp" && bytes.length >= 30) {
    const kind = bytes.subarray(12, 16).toString("ascii");
    if (kind === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1]!; offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += size;
    }
  }
  return null;
}

function publicUser(row: UserRow): AuthUser {
  return { id: Number(row.id), account: row.account, avatarHash: row.avatar_hash };
}

function issueSession(userId: number, request: IncomingMessage): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  deleteUserSessions.run(userId); // 一个账号只保留一个网页登录会话。
  insertSession.run(userId, sha(token), now, now + SESSION_AGE_SECONDS * 1000, now);
  const secure = (request.headers["x-forwarded-proto"] ?? "").toString().split(",")[0] === "https";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function authenticate(request: IncomingMessage): AuthUser | null {
  const token = cookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const row = sessionUser.get(sha(token), Date.now()) as UserRow | undefined;
  if (!row) return null;
  touchSession.run(Date.now(), sha(token));
  return publicUser(row);
}

export async function handleAuthApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;
  try {
    if (request.method !== "GET" && !requestOriginAllowed(request)) {
      json(response, 403, { error: "请求来源不被允许" }); return true;
    }
    if (pathname === "/api/auth/me" && request.method === "GET") {
      const user = authenticate(request);
      json(response, user ? 200 : 401, user ? { user } : { error: "请先登录" });
      return true;
    }
    if (pathname === "/api/auth/register" && request.method === "POST") {
      const body = await readJson(request);
      const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
      const account = typeof body.account === "string" ? body.account.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const limiterKey = rateKey(request, account.toLowerCase());
      assertAuthAllowed(limiterKey);
      if (!/^[A-Za-z0-9_]{4,20}$/.test(account)) throw new Error("账号需要4～20位字母、数字或下划线");
      if (password.length < 8 || password.length > 64 || password.toLowerCase() === account.toLowerCase()) throw new Error("密码需要8～64位，且不能与账号相同");
      const invite = getInvite.get(sha(inviteCode)) as { id: number; expires_at: number | null; used_at: number | null } | undefined;
      if (!invite || invite.used_at !== null || (invite.expires_at !== null && invite.expires_at < Date.now())) {
        recordAuthFailure(limiterKey); throw new Error("邀请码无效、已使用或已过期");
      }
      if (getUserByAccount.get(account.toLowerCase())) throw new Error("这个账号已经被注册");
      const avatar = avatarFromDataUrl(body.avatar);
      const salt = randomBytes(32);
      const passwordHash = await queuedHash(password, salt);
      db.exec("BEGIN IMMEDIATE");
      try {
        const created = insertUser.run(account, account.toLowerCase(), passwordHash, salt, avatar.mime, avatar.bytes, avatar.hash, Date.now());
        const userId = Number(created.lastInsertRowid);
        if (useInvite.run(userId, Date.now(), invite.id).changes !== 1) throw new Error("邀请码刚刚已被使用");
        db.exec("COMMIT");
        const user = publicUser(getUserById.get(userId) as unknown as UserRow);
        json(response, 201, { user }, { "set-cookie": issueSession(userId, request) });
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return true;
    }
    if (pathname === "/api/auth/login" && request.method === "POST") {
      const body = await readJson(request);
      const account = typeof body.account === "string" ? body.account.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const limiterKey = rateKey(request, account);
      assertAuthAllowed(limiterKey);
      const row = getUserByAccount.get(account) as unknown as UserRow | undefined;
      const salt = row?.password_salt ?? randomBytes(32);
      const candidate = await queuedHash(password, salt);
      if (!row?.password_hash || row.password_hash.length !== candidate.length || !timingSafeEqual(Buffer.from(row.password_hash), candidate)) {
        recordAuthFailure(limiterKey);
        throw new Error("账号或密码错误");
      }
      authFailures.delete(limiterKey);
      db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(Date.now(), row.id);
      json(response, 200, { user: publicUser(row) }, { "set-cookie": issueSession(row.id, request) });
      return true;
    }
    if (pathname === "/api/auth/logout" && request.method === "POST") {
      const token = cookies(request).get(SESSION_COOKIE);
      if (token) deleteSession.run(sha(token));
      json(response, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
      return true;
    }
    const avatarMatch = /^\/api\/users\/(\d+)\/avatar$/.exec(pathname);
    if (avatarMatch && request.method === "GET") {
      const row = getAvatar.get(Number(avatarMatch[1])) as UserRow | undefined;
      if (!row?.avatar_blob || !row.avatar_mime) { response.writeHead(404).end(); return true; }
      response.writeHead(200, { "content-type": row.avatar_mime, "cache-control": "public,max-age=31536000,immutable", etag: `"${row.avatar_hash}"` });
      response.end(Buffer.from(row.avatar_blob));
      return true;
    }
    json(response, 404, { error: "接口不存在" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "操作失败";
    const status = message.includes("登录尝试过多") || message.includes("登录请求过多") ? 429 : message.includes("过大") ? 413 : 400;
    json(response, status, { error: message });
    return true;
  }
}

export function createInviteCode(days = 30): string {
  const code = randomBytes(6).toString("base64url").toUpperCase().replace(/[-_]/g, "A").slice(0, 8);
  const now = Date.now();
  insertInvite.run(sha(code), now, days > 0 ? now + days * 86400_000 : null);
  return code;
}

export function saveMatchRecord(record: {
  matchId: string; room: string; plantsUserId: number | null; zombiesUserId: number | null;
  winner: string | null; reason: string; startedAt: number; endedAt: number;
}): void {
  db.prepare(`INSERT OR IGNORE INTO match_records(match_id,room_code,plants_user_id,zombies_user_id,winner,reason,started_at,ended_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(record.matchId, record.room, record.plantsUserId, record.zombiesUserId, record.winner, record.reason, record.startedAt, record.endedAt);
}

export const authDatabasePath = DB_PATH;
