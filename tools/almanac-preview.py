"""图鉴书页离线预览。

    python tools/almanac-preview.py

把真实书页底图、真实角色动画帧、原版版式坐标合成成一张 800x600 的图，
用来肉眼核对分格和详情页排版对不对。坐标必须和 src/almanac.ts 保持一致，
改了那边记得同步这里 —— 这是预览工具，不参与构建。
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from pack_assets import build_image_index                    # noqa: E402
from render_check import draw_frame, forward_fill            # noqa: E402
from almanac_preview_shared import unit_image                # noqa: E402

PAGE_W, PAGE_H = 800, 600
INK = (40, 50, 90)

# 与 src/almanac.ts 的 GRID 一致
GRID = {
    "plants": dict(cols=8, px=52, py=78, ox=26, oy=92, w=50, h=70),
    "zombies": dict(cols=5, px=85, py=80, ox=22, oy=86, w=76, h=76),
}
BANNER = {"plants": (396, 42), "zombies": (400, 50)}

PLANTS = ["sunflower", "peashooter", "snowpea", "threepeater", "wallnut",
          "tallnut", "potatomine", "squash", "cherrybomb", "jalapeno"]
ZOMBIES = ["zombie", "conehead", "buckethead", "screendoor", "newspaper",
           "polevaulter", "dancer", "football", "nailong", "gargantuar"]

FONT = "C:/Windows/Fonts/msyh.ttc"


def fit(im: Image.Image, w: int, h: int) -> Image.Image:
    scale = min(w / im.width, h / im.height)
    return im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                     Image.LANCZOS)


def build(side: str, skins: dict, anim_dir: Path, idx: dict, raw: Path) -> Image.Image:
    plants = side == "plants"
    page = Image.open(raw / f"Almanac_{'Plant' if plants else 'Zombie'}Back.jpg").convert("RGBA")
    d = ImageDraw.Draw(page, "RGBA")
    g = GRID[side]
    units = PLANTS if plants else ZOMBIES

    # 标题
    bx, by = BANNER[side]
    d.text((bx, by), "植物图鉴" if plants else "僵尸图鉴", anchor="mm",
           font=ImageFont.truetype(FONT, 26),
           fill=(255, 233, 168) if plants else (216, 242, 255))

    # 索引格
    window = None
    if not plants:
        wp = raw / "Almanac_ZombieWindow.png"
        if wp.exists():
            window = Image.open(wp).convert("RGBA")
    for i, unit in enumerate(units):
        x = (i % g["cols"]) * g["px"] + g["ox"]
        y = (i // g["cols"]) * g["py"] + g["oy"]
        if window is not None:
            page.alpha_composite(window, (x, y))
        art = unit_image(unit, skins, anim_dir, idx)
        if art is not None:
            art = fit(art, g["w"] - 4, g["h"] - 4)
            page.alpha_composite(art, (x + (g["w"] - art.width) // 2,
                                       y + g["h"] - art.height - 2))
        d.rectangle([x, y, x + g["w"] - 1, y + g["h"] - 1], outline=(200, 60, 60, 110))

    # 详情页：地面 -> 角色 -> 卡框
    if plants:
        ground = raw / "Almanac_GroundDay.jpg"
        if ground.exists():
            page.paste(Image.open(ground).convert("RGB"), (521, 107))
    hero = unit_image(units[0], skins, anim_dir, idx)
    if hero is not None:
        # 与 src/almanac.ts 同一套：中心 x + 脚底 y，高度按上限夹住
        ax, ay = (618, 242) if plants else (613, 285)
        target = 116 if plants else 168
        h = min(target, int(hero.height * 2.4))
        w = max(1, int(hero.width * h / hero.height))
        hero = hero.resize((w, int(h)), Image.LANCZOS)
        page.alpha_composite(hero, (ax - hero.width // 2, ay - hero.height))
    card = raw / f"Almanac_{'Plant' if plants else 'Zombie'}Card.png"
    if card.exists():
        page.alpha_composite(Image.open(card).convert("RGBA"), (459, 86) if plants else (455, 78))

    # 名字 + 定位同一行（和 src/almanac.ts 一致）
    cx = 617 if plants else 613
    ny = 288 if plants else 362
    fname = ImageFont.truetype(FONT, 20)
    frole = ImageFont.truetype(FONT, 12)
    name = "向日葵" if plants else "普通僵尸"
    role = "  经济" if plants else "  基础推进"
    nw = d.textlength(name, font=fname)
    rw = d.textlength(role, font=frole)
    cur = cx - (nw + rw) / 2
    d.text((cur, ny), name, font=fname, anchor="lm",
           fill=(255, 255, 255) if plants else (190, 255, 235))
    d.text((cur + nw, ny + 1), role, font=frole, anchor="lm",
           fill=(242, 217, 160) if plants else (158, 217, 198))

    # 描述 + 攻击方式 + 数值，下边界收在花费行上方
    TEXT_BOTTOM = 514
    bx, by = (485, 309) if plants else (484, 377)
    bw = 258
    f13 = ImageFont.truetype(FONT, 13)
    f12b = ImageFont.truetype(FONT, 12)
    f12 = ImageFont.truetype(FONT, 12)
    d.rectangle([bx, by, bx + bw, TEXT_BOTTOM], outline=(200, 60, 60, 140))

    def wrap(text, font):
        out, line = [], ""
        for ch in text:
            if d.textlength(line + ch, font=font) > bw and line:
                out.append(line); line = ch
            else:
                line += ch
        if line:
            out.append(line)
        return out

    y = by
    desc = ("花园的经济核心。越早种下，越能支撑后续高费用阵容。" if plants
            else "最普通的步兵，便宜、冷却短，适合持续施压。")
    attack = ("不攻击；每约 24 秒生产 50 阳光" if plants else "靠近植物后持续啃食")
    for line in wrap(desc, f13):
        if y + 17 > TEXT_BOTTOM:
            break
        d.text((bx, y), line, font=f13, fill=INK); y += 17
    y += 6
    if y + 17 <= TEXT_BOTTOM:
        d.text((bx, y), "攻击方式", font=f12b, fill=INK); y += 17
    for line in wrap(attack, f13):
        if y + 17 > TEXT_BOTTOM:
            break
        d.text((bx, y), line, font=f13, fill=INK); y += 17
    y += 4
    stats = (["生命 300", "冷却 7.5 秒"] if plants else ["生命 200　　伤害 20", "攻击间隔 1 秒　　移速 20 像素/秒"])
    for line in stats:
        if y + 15 > TEXT_BOTTOM:
            break
        d.text((bx, y), line, font=f12, fill=INK); y += 15

    # 花费和冷却：两边都用墨水蓝，浅色纸面上白字看不清
    f14 = ImageFont.truetype(FONT, 14)
    d.text((485, 520), ("阳光：50" if plants else "脑力：50"), font=f14, fill=INK)
    d.text((739, 520), "冷却：7.5 秒", font=f14, fill=INK, anchor="ra")
    return page


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    raw = root / "assets_raw" / "images"
    idx = build_image_index(root / "assets_raw")
    anim_dir = root / "public" / "assets" / "anim"
    skins = json.loads((root / "shared" / "skins.json").read_text(encoding="utf-8"))
    skins.pop("_comment", None)

    out = Image.new("RGB", (PAGE_W * 2 + 24, PAGE_H), (24, 28, 22))
    for i, side in enumerate(("plants", "zombies")):
        out.paste(build(side, skins, anim_dir, idx, raw).convert("RGB"),
                  (i * (PAGE_W + 24), 0))
    dest = root / "build" / "almanac-preview.png"
    dest.parent.mkdir(exist_ok=True)
    out.save(dest)
    print(f"输出 {dest}  （红框=索引格与描述框，用来核对分格）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
