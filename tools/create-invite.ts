import { authDatabasePath, createInviteCode } from "../server/auth.ts";

const count = Math.max(1, Math.min(100, Number(process.argv[2] ?? 1)));
const days = Math.max(0, Number(process.argv[3] ?? 30));
console.log(`数据库：${authDatabasePath}`);
console.log(`邀请码（${days === 0 ? "永不过期" : `${days}天有效`}）：`);
for (let index = 0; index < count; index++) console.log(createInviteCode(days));
