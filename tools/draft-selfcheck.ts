import {
  DRAFT_PICK_COUNT, allowedCards, autoCompleteDraft, createDraft, draftReady,
  submitBan, submitPicks,
} from "../shared/draft.ts";

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
}

console.log("选卡 Ban 状态机自检");
const now = 1_000_000;
const draft = createDraft(now);
check("开局先进入 banning", draft.phase === "banning");
check("植物只能禁僵尸卡", !submitBan(draft, "plants", "sunflower", now + 1));
check("植物禁用奶龙", submitBan(draft, "plants", "nailong", now + 2));
check("同一方不能反复改 Ban", !submitBan(draft, "plants", "gargantuar", now + 3));
check("僵尸禁用樱桃炸弹", submitBan(draft, "zombies", "cherrybomb", now + 4));
check("双方 Ban 后进入 picking", draft.phase === "picking");

const plantDeck = ["sunflower", "peashooter", "snowpea", "threepeater", "wallnut", "tallnut"] as const;
const zombieDeck = ["zombie", "conehead", "buckethead", "screendoor", "newspaper", "gargantuar"] as const;
check("不能携带被禁用的樱桃", !submitPicks(draft, "plants", ["sunflower", "peashooter", "snowpea", "wallnut", "tallnut", "cherrybomb"]));
check("植物可确认 6 张", submitPicks(draft, "plants", [...plantDeck]));
check("不能用重复卡凑够 6 张", !submitPicks(draft, "zombies", ["zombie", "zombie", "conehead", "buckethead", "newspaper", "gargantuar"]));
check("僵尸可确认 6 张", submitPicks(draft, "zombies", [...zombieDeck]));
check("双方确认后草案完成", draftReady(draft));
check("服务器白名单恰为 6 张", allowedCards(draft, "plants").size === DRAFT_PICK_COUNT && allowedCards(draft, "plants").has("threepeater"));
check("被禁奶龙不在僵尸白名单", !allowedCards(draft, "zombies").has("nailong"));

const timeout = createDraft(now);
autoCompleteDraft(timeout, now + 100_000);
check("超时自动 Ban + 自动选 6 张", draftReady(timeout) && timeout.plants.picks.length === 6 && timeout.zombies.picks.length === 6);
check("超时卡组不含自动禁用卡", !timeout.plants.picks.includes(timeout.zombies.ban!) && !timeout.zombies.picks.includes(timeout.plants.ban!));

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过 ✓");
