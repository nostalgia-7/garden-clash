"""把解析好的 reanim 与部件 PNG 打成前端可直接加载的产物。

输入：
    build/anim/*.json           parse_reanim.py 的输出
    assets_raw/{reanim,images,particles}/*.png|jpg
输出：
    build/dist/atlas-N.png      部件图集
    build/dist/atlas.json       图片名 -> {page,x,y,w,h,ox,oy}
    build/dist/anim/*.json      仅 MVP 角色，附动作区间表
    build/dist/manifest.json    图集页数、角色清单

每张部件图会裁掉四周全透明的边（省图集面积），裁掉多少记在 ox/oy 里，
渲染时把它加回去，画面位置不受影响。
"""

import json
import sys
from pathlib import Path

from PIL import Image

# 阵容。值是 reanim 文件名（不含 .json）。
PLANTS = {
    "sunflower": "SunFlower",
    "peashooter": "PeaShooter",
    "wallnut": "Wallnut",
    "snowpea": "SnowPea",
    "potatomine": "PotatoMine",
    "cherrybomb": "CherryBomb",
    "threepeater": "ThreePeater",
    "tallnut": "Tallnut",
    "jalapeno": "Jalapeno",
    "squash": "Squash",
}
# 普通/路障/铁桶/铁门 共用 Zombie.reanim，靠部件组开关区分，故只需打包一次。
# 奶龙僵尸是原创角色，用代码程序化绘制，不占 reanim。
ZOMBIES = {
    "zombie": "Zombie",
    "polevaulter": "Zombie_polevaulter",
    "football": "Zombie_football",
    "gargantuar": "Zombie_gargantuar",
    "imp": "Zombie_imp",
    "newspaper": "Zombie_paper",
    "dancer": "Zombie_dancer",
}
# 割草机也是 reanim，一并按角色处理
PROPS = {
    "lawnmower": "LawnMower",
}
# 场上零散贴图与 UI 小图
EXTRA_IMAGES = [
    "ProjectilePea", "ProjectileSnowPea", "pea_shadows",
    "Sun1", "Sun2", "Sun3",                 # 阳光的三帧旋转
    "plantshadow", "plantshadow2",           # 僵尸也复用这个投影
    "SeedPacket_Larger", "SunBank",
    # 图鉴书页上的部件：详情卡框、地面、僵尸格窗框
    "Almanac_PlantCard", "Almanac_ZombieCard",
    "Almanac_GroundDay", "Almanac_ZombieWindow",
    # 战前选卡界面：卡池面板、卡槽条、确认按钮、空卡包
    "SeedChooser_Background", "SeedBank",
    "SeedChooser_Button", "SeedChooser_Button_Disabled",
    "SeedPacketSilhouette",
]
# 尺寸太大、不适合塞进图集的整幅图，单独拷出去
STANDALONE = [
    "background1",           # 1400x600 白天草坪
    "Almanac_PlantBack",     # 800x600 图鉴植物页书页底图
    "Almanac_ZombieBack",    # 800x600 图鉴僵尸页书页底图
]

# 手上这份 main.pak 是改版包，草坪正中烤进了发布者的水印文字。
# 草地是重复纹理，把同一行、左移整数个格子的一块干净草皮羽化贴过来即可抹掉，
# 明暗条纹刚好对得上。放在打包流程里，重跑 npm run assets 也不会把水印带回来。
WATERMARK_BOX = (502, 292, 748, 378)
WATERMARK_SHIFT = 255                        # 3 个格子宽（3 * CELL_W）
WATERMARK_FEATHER = 10

ATLAS_SIZE = 2048
PADDING = 1


def strip_watermark(im: Image.Image) -> Image.Image:
    """把草坪中央的第三方水印用邻近草皮盖掉。"""
    left, top, right, bottom = WATERMARK_BOX
    if im.width < right or im.height < bottom:
        return im                            # 换了底图尺寸就不动它
    patch = im.crop((left - WATERMARK_SHIFT, top, right - WATERMARK_SHIFT, bottom))
    w, h = patch.size
    mask = Image.new("L", (w, h), 255)
    px = mask.load()
    for y in range(h):
        for x in range(w):
            d = min(x, y, w - 1 - x, h - 1 - y)
            if d < WATERMARK_FEATHER:
                px[x, y] = int(255 * d / WATERMARK_FEATHER)
    out = im.copy()
    out.paste(patch, (left, top), mask)
    return out


def build_image_index(root: Path) -> dict[str, Path]:
    """忽略大小写的图片索引，供 IMAGE_REANIM_XXX 这类 id 反查文件。"""
    idx: dict[str, Path] = {}
    for sub in ("reanim", "images", "particles"):
        for ext in ("*.png", "*.jpg"):
            for p in sorted((root / sub).glob(ext)):
                idx.setdefault(p.stem.lower(), p)
    return idx


def resolve(ref: str, idx: dict[str, Path]) -> Path | None:
    stem = ref.removeprefix("IMAGE_REANIM_").removeprefix("IMAGE_").lower()
    return idx.get(stem)


def _visible_range(track: dict) -> tuple[int, int] | None:
    """轨道可见的帧区间。

    frame 属性缺省意味着「沿用上一帧」，所以一旦被显式写成 0 就一直可见，
    直到被显式写回 -1。必须先前向填充才能读出真实区间。初值是「可见」——
    这一点要和渲染器保持一致，否则区间会算短。
    """
    cur, on = 0.0, []
    for i, f in enumerate(track["frames"]):
        if "frame" in f:
            cur = f["frame"]
        if cur >= 0:
            on.append(i)
    return (on[0], on[-1]) if on else None


def split_tracks(doc: dict) -> tuple[dict[str, list[int]], list[str]]:
    """把 anim_ 轨道分成「动作区间」和「可开关部件组」。

    两者都是普通轨道，区别是结构性的：动作区间恰好在下一个动作开始处结束，
    彼此首尾相接地铺满时间轴；部件组（anim_stem、anim_cone 这类）则会横跨
    多个动作，用来拼出同一角色的不同外观——比如 anim_cone 点亮就是路障僵尸。
    """
    cands = []
    for t in doc["tracks"]:
        if not t["name"].startswith("anim_"):
            continue
        rng = _visible_range(t)
        if rng:
            cands.append((rng[0], rng[1], t["name"]))
    cands.sort()

    total = max(len(t["frames"]) for t in doc["tracks"])
    starts = sorted({c[0] for c in cands})

    sections, groups = {}, []
    for start, end, name in cands:
        later = [s for s in starts if s > start]
        want = (later[0] - 1) if later else (total - 1)
        if end == want:
            sections[name] = [start, end]
        else:
            groups.append(name)
    return sections, groups


class ShelfPacker:
    """按高度降序做货架式排布，够用且不会算错。"""

    def __init__(self, size: int, pad: int):
        self.size, self.pad = size, pad
        self.pages: list[list[tuple[str, Image.Image, int, int]]] = []
        self._new_page()

    def _new_page(self) -> None:
        self.pages.append([])
        self.x = self.y = self.row_h = 0

    def add(self, name: str, im: Image.Image) -> tuple[int, int, int]:
        w, h = im.width + self.pad, im.height + self.pad
        if w > self.size or h > self.size:
            raise SystemExit(f"{name} 尺寸 {im.size} 超过图集 {self.size}")
        if self.x + w > self.size:                      # 换行
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        if self.y + h > self.size:                      # 换页
            self._new_page()
        page = len(self.pages) - 1
        x, y = self.x, self.y
        self.pages[page].append((name, im, x, y))
        self.x += w
        self.row_h = max(self.row_h, h)
        return page, x, y


def main() -> int:
    raw = Path("assets_raw")
    anim_dir = Path("build/anim")
    out = Path("public/assets")
    (out / "anim").mkdir(parents=True, exist_ok=True)

    idx = build_image_index(raw)
    roster = {**PLANTS, **ZOMBIES, **PROPS}

    # 收集所有需要的图片，并顺手为每个角色导出带区间表的 JSON
    needed: set[str] = set()
    chars: dict[str, dict] = {}
    for key, reanim in roster.items():
        src = anim_dir / f"{reanim}.json"
        if not src.exists():
            raise SystemExit(f"缺少 {src}")
        doc = json.loads(src.read_text(encoding="utf-8"))
        for t in doc["tracks"]:
            for f in t["frames"]:
                if "image" in f:
                    needed.add(f["image"])
        doc["sections"], doc["partGroups"] = split_tracks(doc)
        (out / "anim" / f"{key}.json").write_text(
            json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
        )
        chars[key] = {"reanim": reanim, "sections": list(doc["sections"]),
                      "partGroups": doc["partGroups"]}

    needed.update(EXTRA_IMAGES)               # 名字错了就让下面的未命中报出来

    # 大图单独拷，不进图集
    standalone = {}
    for name in STANDALONE:
        p = resolve(name, idx)
        if p is None:
            raise SystemExit(f"找不到 {name}")
        im = Image.open(p).convert("RGB")
        if name == "background1":
            im = strip_watermark(im)
        im.save(out / f"{name}.jpg", quality=88, optimize=True)
        standalone[name] = {"w": im.width, "h": im.height, "file": f"{name}.jpg"}

    # 裁透明边后打包
    packer = ShelfPacker(ATLAS_SIZE, PADDING)
    atlas: dict[str, dict] = {}
    missing, area_before, area_after = [], 0, 0
    entries = []
    for ref in sorted(needed):
        p = resolve(ref, idx)
        if p is None:
            missing.append(ref)
            continue
        im = Image.open(p).convert("RGBA")
        area_before += im.width * im.height
        box = im.getbbox()                      # 全透明时返回 None
        ox, oy = (box[0], box[1]) if box else (0, 0)
        im = im.crop(box) if box else im.crop((0, 0, 1, 1))
        area_after += im.width * im.height
        entries.append((ref, im, ox, oy))

    entries.sort(key=lambda e: -e[1].height)     # 高的先放，货架才紧凑
    for ref, im, ox, oy in entries:
        page, x, y = packer.add(ref, im)
        key = ref.removeprefix("IMAGE_REANIM_").removeprefix("IMAGE_")
        atlas[key] = {"p": page, "x": x, "y": y,
                      "w": im.width, "h": im.height, "ox": ox, "oy": oy}

    for i, items in enumerate(packer.pages):
        sheet = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
        for _, im, x, y in items:
            sheet.paste(im, (x, y))
        sheet.save(out / f"atlas-{i}.png", optimize=True)

    (out / "atlas.json").write_text(
        json.dumps(atlas, separators=(",", ":")), encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(
        {"atlasPages": len(packer.pages), "atlasSize": ATLAS_SIZE,
         "plants": list(PLANTS), "zombies": list(ZOMBIES), "props": list(PROPS),
         "standalone": standalone, "characters": chars},
        separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    saved = 100 * (1 - area_after / area_before) if area_before else 0
    print(f"打包 {len(atlas)} 张部件 -> {len(packer.pages)} 页 {ATLAS_SIZE}x{ATLAS_SIZE}")
    print(f"裁透明边省下 {saved:.1f}% 像素面积")
    for m in missing:
        print(f"  [未命中] {m}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
