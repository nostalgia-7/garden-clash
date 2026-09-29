"""选卡界面离线预览。

    python tools/draft-preview.py

用真实面板素材、真实角色帧和原版分格合成 800x600，肉眼核对排版。
坐标要和 src/draft-screen.ts 保持一致，改了那边记得同步这里。
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from pack_assets import build_image_index                    # noqa: E402
from render_check import draw_frame, forward_fill            # noqa: E402
from almanac_preview_shared import unit_image                # noqa: E402

W, H = 800, 600
CARD_W, CARD_H = 50, 70
PANEL = (18, 80)
POOL_ORIGIN = (PANEL[0] + 22, PANEL[1] + 34)
PITCH = (53, 73)
COLS = 8
BANK_STRIP = (28, 300)
BANK = (48, 309)
BANK_PITCH = 59
CONFIRM = (18 + (465 - 156) // 2, 452, 156, 41)
BANNED_VIEW = (560, 150, 100, 140)

FONT = "C:/Windows/Fonts/msyh.ttc"

POOL = ["zombie", "conehead", "buckethead", "screendoor", "newspaper",
        "polevaulter", "dancer", "football", "nailong", "gargantuar"]
PICKS = ["zombie", "conehead", "buckethead", "polevaulter", "football"]
COSTS = {"zombie": 50, "conehead": 75, "buckethead": 125, "screendoor": 125,
         "newspaper": 100, "polevaulter": 125, "dancer": 150, "football": 200,
         "nailong": 250, "gargantuar": 300}


def packet(base: Image.Image, art, x: int, y: int, cost, dim=False,
           selected=False, banned=False, silhouette=None, big=None):
    layer = Image.new("RGBA", (CARD_W, CARD_H), (0, 0, 0, 0))
    if silhouette is not None:
        layer.alpha_composite(silhouette.resize((CARD_W, CARD_H), Image.LANCZOS))
    d = ImageDraw.Draw(layer, "RGBA")
    d.rectangle([3, 3, CARD_W - 4, CARD_H - 21], fill=(239, 226, 180, 255))
    if art is not None:
        inner_w, inner_h = CARD_W - 6, CARD_H - 22
        scale = min(1.5, (inner_h - 4) / max(art.height, 1))
        a = art.resize((max(1, int(art.width * scale)), max(1, int(art.height * scale))),
                       Image.LANCZOS)
        layer.alpha_composite(a, (3 + (inner_w - a.width) // 2, 2 + inner_h - a.height))
    d.rectangle([3, CARD_H - 17, CARD_W - 4, CARD_H - 4], fill=(47, 58, 34, 255))
    d.text((CARD_W // 2, CARD_H - 10), str(cost), anchor="mm",
           font=ImageFont.truetype(FONT, 11), fill=(246, 241, 200))
    if dim:
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * 0.42)))
    if big is not None:
        layer = layer.resize(big, Image.LANCZOS)
    base.alpha_composite(layer, (x, y))
    d2 = ImageDraw.Draw(base, "RGBA")
    if selected:
        d2.rectangle([x - 2, y - 2, x + CARD_W + 1, y + CARD_H + 1],
                     outline=(182, 224, 79, 255), width=3)
    if banned:
        d2.line([x + 4, y + 4, x + CARD_W - 4, y + CARD_H - 4], fill=(226, 80, 63, 255), width=3)
        d2.line([x + CARD_W - 4, y + 4, x + 4, y + CARD_H - 4], fill=(226, 80, 63, 255), width=3)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    raw = root / "assets_raw" / "images"
    idx = build_image_index(root / "assets_raw")
    anim_dir = root / "public" / "assets" / "anim"
    skins = json.loads((root / "shared" / "skins.json").read_text(encoding="utf-8"))
    skins.pop("_comment", None)

    page = Image.new("RGBA", (W, H))
    for y in range(H):
        t = y / H
        page.paste((int(37 + (13 - 37) * t), int(64 + (22 - 64) * t),
                    int(44 + (15 - 44) * t), 255), (0, y, W, y + 1))
    d = ImageDraw.Draw(page, "RGBA")

    d.text((PANEL[0], 46), "选择本局携带的 6 张卡", font=ImageFont.truetype(FONT, 30),
           fill=(233, 245, 184), anchor="ls")
    d.text((PANEL[0], 72), "被禁用：舞王僵尸。从剩余卡牌中选择 6 张。",
           font=ImageFont.truetype(FONT, 15), fill=(185, 204, 169), anchor="ls")
    d.ellipse([W - 110, 12, W - 38, 84], fill=(44, 58, 38, 255))
    d.text((W - 74, 52), "31", anchor="mm", font=ImageFont.truetype(FONT, 30), fill=(246, 237, 159))
    d.text((W - 74, 22), "剩余秒", anchor="ms", font=ImageFont.truetype(FONT, 11), fill=(159, 176, 148))

    panel = Image.open(raw / "SeedChooser_Background.png").convert("RGBA")
    page.alpha_composite(panel, PANEL)

    sil_path = raw / "SeedPacketSilhouette.png"
    sil = Image.open(sil_path).convert("RGBA") if sil_path.exists() else None

    for i, unit in enumerate(POOL):
        x = (i % COLS) * PITCH[0] + POOL_ORIGIN[0]
        y = (i // COLS) * PITCH[1] + POOL_ORIGIN[1]
        art = unit_image(unit, skins, anim_dir, idx)
        packet(page, art, x, y, COSTS[unit],
               banned=(unit == "dancer"), dim=(unit == "dancer"),
               selected=(unit in PICKS), silhouette=sil)
        d.rectangle([x, y, x + CARD_W - 1, y + CARD_H - 1], outline=(200, 60, 60, 110))

    strip = raw / "SeedBank.png"
    if strip.exists():
        page.alpha_composite(Image.open(strip).convert("RGBA"), BANK_STRIP)
    d.text((BANK_STRIP[0], BANK_STRIP[1] - 12), "本局卡组", font=ImageFont.truetype(FONT, 15),
           fill=(219, 232, 198), anchor="ls")
    for i in range(6):
        x = BANK[0] + i * BANK_PITCH
        y = BANK[1]
        if i < len(PICKS):
            packet(page, unit_image(PICKS[i], skins, anim_dir, idx), x, y,
                   COSTS[PICKS[i]], silhouette=sil)
        elif sil is not None:
            ghost = sil.resize((CARD_W, CARD_H), Image.LANCZOS)
            ghost.putalpha(ghost.getchannel("A").point(lambda v: int(v * 0.28)))
            page.alpha_composite(ghost, (x, y))
        d.rectangle([x, y, x + CARD_W - 1, y + CARD_H - 1], outline=(200, 60, 60, 110))

    bv = BANNED_VIEW
    d.text((bv[0] + bv[2] // 2, bv[1] - 18), "对手已禁用", anchor="ms",
           font=ImageFont.truetype(FONT, 16), fill=(219, 232, 198))
    packet(page, unit_image("dancer", skins, anim_dir, idx), bv[0], bv[1], COSTS["dancer"],
           silhouette=sil, big=(bv[2], bv[3]))
    d.text((bv[0] + bv[2] // 2, bv[1] + bv[3] + 22), "舞王僵尸", anchor="ms",
           font=ImageFont.truetype(FONT, 15), fill=(244, 229, 196))

    d.text((18 + 465 // 2, 428), "已选 5/6 · 对手选择中", font=ImageFont.truetype(FONT, 13),
           fill=(207, 224, 188), anchor="ms")

    btn = raw / "SeedChooser_Button_Disabled.png"
    if btn.exists():
        page.alpha_composite(Image.open(btn).convert("RGBA").resize(
            (CONFIRM[2], CONFIRM[3]), Image.LANCZOS), (CONFIRM[0], CONFIRM[1]))
    d.text((CONFIRM[0] + CONFIRM[2] // 2, CONFIRM[1] + CONFIRM[3] // 2 + 1), "确认卡组",
           anchor="mm", font=ImageFont.truetype(FONT, 16), fill=(92, 99, 80))
    d.rectangle([CONFIRM[0], CONFIRM[1], CONFIRM[0] + CONFIRM[2], CONFIRM[1] + CONFIRM[3]],
                outline=(200, 60, 60, 140))

    dest = root / "build" / "draft-preview.png"
    dest.parent.mkdir(exist_ok=True)
    page.convert("RGB").save(dest)
    print(f"输出 {dest}  （红框=卡格/槽位/按钮热区）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
