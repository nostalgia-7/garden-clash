import { DatabaseSync } from "node:sqlite";

const filename = process.argv[2];
if (!filename) throw new Error("用法：db-counts.ts <sqlite文件>");
const database = new DatabaseSync(filename);
for (const table of ["users", "invite_codes", "sessions", "match_records"]) {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  console.log(`${table}=${row.count}`);
}
database.close();
