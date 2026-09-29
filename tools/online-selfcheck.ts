/**
 * 对正在运行的服务器做一次端到端联调。只在 GARDEN_TEST=1 时运行，
 * 必须配合独立的临时 GARDEN_DATA_DIR，避免产生正式账号。
 */
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const base = process.env.GARDEN_TEST_URL ?? "http://127.0.0.1:8181";
if (process.env.GARDEN_TEST !== "1") throw new Error("必须设置 GARDEN_TEST=1，并只连接临时测试实例");
const invites = (process.env.GARDEN_TEST_INVITES ?? "").split(",").filter(Boolean);
if (invites.length !== 3) throw new Error("需要3个逗号分隔的邀请码");
const avatar = `data:image/png;base64,${readFileSync(process.env.GARDEN_TEST_AVATAR ?? "/tmp/garden-test-avatar.png").toString("base64")}`;

interface UserSession { account: string; cookie: string }
async function post(path: string, body: unknown, cookie = ""): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}
function cookieOf(response: Response): string { return response.headers.get("set-cookie")?.split(";")[0] ?? ""; }
async function register(index: number): Promise<UserSession> {
  const account = `selfcheck_${index}_${Date.now().toString(36)}`;
  const response = await post("/api/auth/register", { inviteCode: invites[index], account, password: `Garden-${index}-Pass!`, avatar });
  if (response.status !== 201) throw new Error(`注册${index}失败：${response.status} ${await response.text()}`);
  return { account, cookie: cookieOf(response) };
}
function open(cookie: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = base.replace(/^http/, "ws") + "/ws";
    const socket = new WebSocket(url, { headers: { cookie } });
    socket.once("open", () => resolve(socket)); socket.once("error", reject);
  });
}
function receive(socket: WebSocket, wanted: string, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待${wanted}超时`)); }, timeout);
    const onMessage = (raw: WebSocket.RawData) => { const msg = JSON.parse(raw.toString()); if (msg.type === wanted) { cleanup(); resolve(msg); } };
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); };
    socket.on("message", onMessage);
  });
}
function receiveWhere(socket: WebSocket, wanted: string, predicate: (message: any) => boolean, timeout = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待${wanted}条件消息超时`)); }, timeout);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === wanted && predicate(msg)) { cleanup(); resolve(msg); }
    };
    const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); };
    socket.on("message", onMessage);
  });
}
async function sendAndReceive(socket: WebSocket, message: unknown, wanted: string): Promise<any> {
  const pending = receive(socket, wanted); socket.send(JSON.stringify(message)); return pending;
}

const unauth = await open("");
const unauthError = await receive(unauth, "error");
if (!String(unauthError.message).includes("登录")) throw new Error("未登录WebSocket未被拦截");
unauth.close();

const users = await Promise.all([register(0), register(1), register(2)]);
const reuse = await post("/api/auth/register", { inviteCode: invites[0], account: "reuse_test", password: "Garden-Reuse-Pass!", avatar });
if (reuse.status === 201) throw new Error("邀请码被重复使用");

const plants = await open(users[0]!.cookie);
const plantWelcome = await sendAndReceive(plants, { type: "create", preferred: "plants" }, "welcome");
const room = plantWelcome.room as string;
const zombies = await open(users[1]!.cookie);
const spectator = await open(users[2]!.cookie);
const zombieWelcome = await sendAndReceive(zombies, { type: "join", room, preferred: "zombies" }, "welcome");
const spectatorWelcome = await sendAndReceive(spectator, { type: "join", room, preferred: "spectator" }, "welcome");
if (zombieWelcome.room !== room || spectatorWelcome.role !== "spectator") throw new Error("三人没有进入同一房间");

// 双方必须先走服务器权威 Ban → Pick，观战者只能收到只读进度。
const banStates = Promise.all([
  receiveWhere(plants, "draft", (message) => message.state.phase === "picking"),
  receiveWhere(zombies, "draft", (message) => message.state.phase === "picking"),
  receiveWhere(spectator, "draft", (message) => message.state.phase === "picking"),
]);
plants.send(JSON.stringify({ type: "ban", kind: "nailong" }));
zombies.send(JSON.stringify({ type: "ban", kind: "cherrybomb" }));
const [plantPick, zombiePick, spectatorPick] = await banStates;
if (plantPick.state.phase !== "picking" || plantPick.state.opponentBan !== "cherrybomb"
    || zombiePick.state.opponentBan !== "nailong") throw new Error("Ban 阶段未正确切换到 Pick");
if (spectatorPick.state.myPool.length !== 0) throw new Error("观战者不应拿到可操作卡池");
const plantDeck = ["sunflower", "peashooter", "snowpea", "threepeater", "wallnut", "tallnut"];
const zombieDeck = ["zombie", "conehead", "buckethead", "screendoor", "newspaper", "gargantuar"];
const starts = Promise.all([receive(plants, "start"), receive(zombies, "start"), receive(spectator, "start")]);
plants.send(JSON.stringify({ type: "pick", kinds: plantDeck }));
zombies.send(JSON.stringify({ type: "pick", kinds: zombieDeck }));
const [plantStart] = await starts;
if (plantStart.plantsDeck.length !== 6 || plantStart.zombiesDeck.includes("nailong")) throw new Error("服务器下发卡组不正确");

await Promise.all([receive(plants, "snap", 5000), receive(zombies, "snap", 5000), receive(spectator, "snap", 5000)]);

// 未入选卡即使伪造命令也不能落地；入选卡可以正常落地。
const verifiedPromise = receiveWhere(plants, "snap", (message) => message.s.u.some((unit: number[]) => unit[1] === 0 && unit[2] === 0));
plants.send(JSON.stringify({ type: "cmd", seq: 1, cmd: { k: "plant", row: 0, col: 0, kind: "cherrybomb" } }));
plants.send(JSON.stringify({ type: "cmd", seq: 2, cmd: { k: "plant", row: 0, col: 0, kind: "sunflower" } }));
const verified = await verifiedPromise;
const hasSunflower = verified.s.u.some((unit: number[]) => unit[1] === 0 && unit[2] === 0);
const hasCherry = verified.s.u.some((unit: number[]) => unit[1] === 5 && unit[2] === 0);
if (!hasSunflower || hasCherry) throw new Error("服务器没有严格执行已选卡白名单");

// 观战者伪造投降不得结束比赛；随后由植物方真正投降。
spectator.send(JSON.stringify({ type: "surrender" }));
await new Promise((resolve) => setTimeout(resolve, 350));
const ended = receive(plants, "ended", 3000); plants.send(JSON.stringify({ type: "surrender" }));
const result = await ended;
if (result.winner !== "zombies") throw new Error("服务器投降判定不正确");

// 已掉线的观战席可用同一账号和令牌恢复。
spectator.close(); await new Promise((resolve) => setTimeout(resolve, 100));
const resumed = await open(users[2]!.cookie);
const restored = await sendAndReceive(resumed, { type: "join", room, preferred: "spectator", reconnect: spectatorWelcome.reconnectToken }, "welcome");
if (restored.role !== "spectator") throw new Error("观战重连失败");

for (const socket of [plants, zombies, resumed]) socket.close();
console.log(JSON.stringify({ ok: true, room, users: users.map((user) => user.account), inviteReuseRejected: true, roles: ["plants", "zombies", "spectator"], draft: "ban-1-pick-6", deckWhitelist: true, spectatorReadOnly: true, spectatorReconnect: true }));
