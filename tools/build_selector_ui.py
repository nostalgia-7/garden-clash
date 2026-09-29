"""重建主菜单里需要二次加工的几张素材。

原始 main.pak 是汉化改版包，石碑底座上刻着发布者的「汉化第二版」。
这里把那行字磨掉换成「在线测试版」，并把左右两只花瓶抠成可点的按钮
（左＝版本更新，右＝设置），另外画一块正面视角的墓碑做更新公告底板。

输入 assets_raw/reanim/SelectorScreen_BG_Right.jpg + 同名 _.png 透明蒙版
输出 public/assets/selector/{BG_Right,Vase_Settings,Vase_Update,UpdateBoard}*.png

每次都从 assets_raw 重算，反复跑结果一致；npm run assets 不会把旧刻字带回来。
"""

import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW = Path("assets_raw/reanim")
OUT = Path("public/assets/selector")

# BG_Right 贴在 800×600 画板的 (71,41)，脚本内部一律用图内局部坐标。
BOARD_OFF = (71, 41)

# 底座那块石板是斜的：沿 x 每前进 1px，表面下沉 0.26px。
# 抹字和刻字都要跟着这个斜率走，否则字会浮在石板外面。
SLAB_SLOPE = 0.26
SLAB_REF_X = 344

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def compose_bg_right() -> Image.Image:
    """原图的 RGB 和 alpha 是分开两个文件存的，合回 RGBA。"""
    rgb = Image.open(RAW / "SelectorScreen_BG_Right.jpg").convert("RGB")
    alpha = Image.open(RAW / "SelectorScreen_BG_Right_.png").convert("L")
    out = rgb.copy()
    out.putalpha(alpha)
    return out


def shear_u(x: int, y: int) -> float:
    """把像素换算到「沿石板方向拉平」的坐标，同一条 u 上颜色基本一致。"""
    return y - SLAB_SLOPE * (x - SLAB_REF_X)


def ink_colour(im: Image.Image) -> tuple[int, int, int]:
    """取原刻字最深的那一档颜色，新字照抄，才像同一把凿子刻的。"""
    n = np.asarray(im.convert("RGB")).astype(int)
    band = []
    for x in range(337, 445):
        for u in range(371, 389):
            y = int(round(u + SLAB_SLOPE * (x - SLAB_REF_X)))
            band.append(n[y, x])
    band = np.array(band)
    darkest = band[band.mean(axis=1).argsort()[: len(band) // 12]]
    return tuple(int(v) for v in darkest.mean(axis=0))


def erase_engraving(im: Image.Image) -> None:
    """磨掉「汉化第二版」。

    石板表面在 shear 后是横向平铺的，所以逐条 u 取左右两侧干净石面的中位色，
    再沿 x 线性过渡填回去——石板本身从左到右会变暗，纯取一侧会留下色阶。
    """
    n = np.asarray(im).astype(float)

    def sample(x_lo: int, x_hi: int, u: int) -> np.ndarray:
        rows = []
        for x in range(x_lo, x_hi):
            y = int(round(u + SLAB_SLOPE * (x - SLAB_REF_X)))
            rows.append(n[y, x, :3])
        return np.median(np.array(rows), axis=0)

    fill_x0, fill_x1 = 334, 457
    for u in range(367, 394):
        left = sample(318, 334, u)
        right = sample(462, 479, u)
        for x in range(fill_x0, fill_x1):
            t = (x - fill_x0) / (fill_x1 - 1 - fill_x0)
            y = int(round(u + SLAB_SLOPE * (x - SLAB_REF_X)))
            n[y, x, :3] = left * (1 - t) + right * t

    im.paste(Image.fromarray(n.astype("uint8"), "RGBA"))


def engrave(im: Image.Image, text: str, colour: tuple[int, int, int]) -> None:
    """按原刻字的位置、字号和倾角刻上新的一行。"""
    size = 20
    font = ImageFont.truetype(FONT_BOLD, size)

    pad = 12
    strip = Image.new("RGBA", (size * len(text) + pad * 2, size + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(strip).text((pad, pad), text, font=font, fill=(*colour, 255))
    # 石头上的字边缘是糊的，稍微软化一下才不像贴纸。
    strip = strip.filter(ImageFilter.GaussianBlur(0.45))

    angle = np.degrees(np.arctan(SLAB_SLOPE))
    rotated = strip.rotate(-angle, resample=Image.BICUBIC, expand=True)

    # 原字左上角在 (337,367)，旋转后画布变大，按中心对齐还原到同一处。
    cx = 337 + (strip.width - 2 * pad) / 2 * np.cos(np.radians(angle))
    cy = 367 + (strip.width - 2 * pad) / 2 * np.sin(np.radians(angle)) + size / 2
    im.alpha_composite(rotated, (int(cx - rotated.width / 2), int(cy - rotated.height / 2)))


# 图鉴那本书上「图鉴」二字的深棕，花瓶和更新公告上的字统一用它。
LABEL_INK = (77, 49, 0)

# 三只花瓶里最左、最右那两只做成按钮。box/seeds 写的都是 800×600 画板坐标，
# 抠图时再减去 BOARD_OFF；seeds 落在瓶身和花簇上，漫水法顺着连通区域取轮廓。
VASES = [
    {
        "file": "Vase_Update",
        "label": "版本更新",
        "lines": ["版本", "更新"],
        "size": 20,
        "box": (545, 419, 105, 130),
        "seeds": [(595, 505), (600, 512), (570, 440), (595, 445)],
    },
    {
        "file": "Vase_Settings",
        "label": "设置",
        "lines": ["设置"],
        "size": 25,
        "box": (699, 439, 89, 117),
        "seeds": [(742, 515), (735, 525), (722, 458), (760, 460)],
    },
]


def object_mask(im: Image.Image, box, seeds) -> Image.Image:
    """从种子点漫水，取出花瓶＋花簇的轮廓。

    花瓶和花都是浅色的，背后的石头偏暗——一条亮度线就能把它们分开，比手描
    轮廓稳。中间穿过花簇的褐色枝条会在蒙版里留下细缝，后面闭运算一起补掉。
    """
    n = np.asarray(im).astype(int)
    lum = n[..., :3].mean(axis=2)
    solid = (lum > 110) & (n[..., 3] > 128)

    bx, by, bw, bh = box
    x0, y0 = bx - BOARD_OFF[0], by - BOARD_OFF[1]
    inside = np.zeros(solid.shape, bool)
    inside[y0 : y0 + bh, x0 : x0 + bw] = True
    solid &= inside

    h, w = solid.shape
    seen = np.zeros(solid.shape, bool)
    stack = []
    for sx, sy in seeds:
        px, py = sx - BOARD_OFF[0], sy - BOARD_OFF[1]
        if solid[py, px] and not seen[py, px]:
            seen[py, px] = True
            stack.append((px, py))
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = x + dx, y + dy
            if 0 <= a < w and 0 <= b < h and solid[b, a] and not seen[b, a]:
                seen[b, a] = True
                stack.append((a, b))

    mask = Image.fromarray((seen[y0 : y0 + bh, x0 : x0 + bw] * 255).astype("uint8"))
    # 描边和高光会在轮廓内留空洞：先外扩补掉，再收一点，最后羽化边缘。
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))
    return mask.filter(ImageFilter.GaussianBlur(0.6))


def draw_label(cut: Image.Image, alpha: Image.Image, vase) -> None:
    """把名字刻在瓶肚上——花簇在上半截，所以只按靠下的部分找中心。"""
    solid = np.asarray(alpha) > 140
    rows = np.nonzero(solid.any(axis=1))[0]
    waist = rows[0] + int(len(rows) * 0.45)
    ys, xs = np.nonzero(solid[waist:])
    cx, cy = int(xs.mean()), waist + int(ys.mean())

    font = ImageFont.truetype(FONT_BOLD, vase["size"])
    draw = ImageDraw.Draw(cut)
    line_h = vase["size"] + 2
    top = cy - line_h * len(vase["lines"]) / 2
    for i, line in enumerate(vase["lines"]):
        draw.text((cx, top + line_h * (i + 0.5)), line,
                  font=font, fill=(*LABEL_INK, 255), anchor="mm")


def cut_vase(bg: Image.Image, vase) -> Image.Image:
    """按 box 裁一块，再用轮廓蒙版把石头背景挖掉，最后刻上名字。"""
    bx, by, bw, bh = vase["box"]
    x0, y0 = bx - BOARD_OFF[0], by - BOARD_OFF[1]
    cut = bg.crop((x0, y0, x0 + bw, y0 + bh))

    mask = object_mask(bg, vase["box"], vase["seeds"])
    alpha = Image.fromarray(
        (np.asarray(cut)[..., 3].astype(int) * np.asarray(mask) // 255).astype("uint8")
    )
    cut.putalpha(alpha)
    draw_label(cut, alpha, vase)
    return cut


def highlight(im: Image.Image) -> Image.Image:
    """鼠标悬停用的提亮版，档位跟原来那只设置花瓶一致。"""
    n = np.asarray(im).astype(float)
    n[..., :3] = np.clip(n[..., :3] * 1.057 + 44, 0, 255)
    return Image.fromarray(n.astype("uint8"), "RGBA")


# 更新公告的底板：一块正面视角的墓碑，配色照着主菜单那块斜的取。
BOARD_SIZE = (520, 600)
STONE_TOP = (139, 141, 156)
STONE_BOTTOM = (78, 80, 101)
STONE_EDGE = (29, 32, 48)
PLAQUE_TOP = (176, 179, 194)
PLAQUE_BOTTOM = (146, 149, 167)
# 正文和标题各占一块浅色内嵌板，跟主菜单那块碑上的两块牌子一个路子。
# CSS 里的文字区要和这两个框对齐。
TITLE_BOX = (74, 90, 446, 176)
PLAQUE_BOX = (54, 196, 466, 534)


def gradient(size, top, bottom) -> Image.Image:
    """竖直渐变，再压一层从左上打过来的光——纯上下渐变会显得像塑料片。"""
    w, h = size
    ys = np.linspace(0, 1, h)[:, None, None]
    xs = np.linspace(0, 1, w)[None, :, None]
    mix = np.array(top, float) * (1 - ys) + np.array(bottom, float) * ys
    mix = mix + (0.45 - xs) * 26 + (0.5 - ys) * 10
    return Image.fromarray(np.clip(np.broadcast_to(mix, (h, w, 3)), 0, 255).astype("uint8"), "RGB")


def wobbly_outline(mask: Image.Image, center, count=200):
    """把规整的轮廓抖成手绘感：从中心朝各个方向量到边，再叠几段正弦。

    正弦相位是写死的，所以每次跑出来的碑形完全一样，不会一 build 换一个样。
    """
    solid = np.asarray(mask) > 127
    h, w = solid.shape
    cx, cy = center
    points = []
    for i in range(count):
        th = 2 * np.pi * i / count
        dx, dy = np.cos(th), np.sin(th)
        r = 0
        while True:
            x, y = int(cx + dx * (r + 1)), int(cy + dy * (r + 1))
            if not (0 <= x < w and 0 <= y < h) or not solid[y, x]:
                break
            r += 1
        r += 4 * np.sin(3 * th + 0.7) + 2.4 * np.sin(7 * th + 2.1) + 1.3 * np.sin(13 * th + 4.3)
        points.append((cx + dx * r, cy + dy * r))
    return points


def build_update_board() -> Image.Image:
    w, h = BOARD_SIZE

    # 碑形＝上面一个椭圆拱顶 ∪ 下面一个圆角方身，再抖一圈边。
    base = Image.new("L", BOARD_SIZE, 0)
    bd = ImageDraw.Draw(base)
    bd.ellipse([34, 18, w - 34, 300], fill=255)
    bd.rounded_rectangle([34, 150, w - 34, h - 22], radius=26, fill=255)
    outline = wobbly_outline(base, (w // 2, h // 2 - 40))

    shape = Image.new("L", BOARD_SIZE, 0)
    ImageDraw.Draw(shape).polygon(outline, fill=255)
    shape = shape.filter(ImageFilter.GaussianBlur(0.7))

    board = Image.new("RGBA", BOARD_SIZE, (0, 0, 0, 0))
    stone = gradient(BOARD_SIZE, STONE_TOP, STONE_BOTTOM)
    # 撒一点噪点当石头颗粒，纯渐变看着像塑料。种子固定，产物可复现。
    grain = np.asarray(stone).astype(float)
    rng = np.random.default_rng(20260817)
    grain += rng.normal(0, 4.5, grain.shape[:2])[..., None]
    stone = Image.fromarray(np.clip(grain, 0, 255).astype("uint8"), "RGB")
    stone = stone.filter(ImageFilter.SMOOTH)
    board.paste(stone, (0, 0), shape)

    draw = ImageDraw.Draw(board)
    draw.line(outline + [outline[0]], fill=(*STONE_EDGE, 255), width=5, joint="curve")

    # 拱顶上几道水痕，跟主菜单那块碑一样的点缀；只敢做得很淡，重了像铆钉。
    for x, y, rx, ry in ((132, 62, 4, 7), (392, 70, 3, 6), (260, 44, 3, 5),
                         (44, 300, 3, 8), (478, 330, 3, 7)):
        draw.ellipse([x - rx, y - ry, x + rx, y + ry], fill=(70, 72, 92, 55))
        draw.ellipse([x - rx, y - ry + 2, x + rx, y + ry + 2],
                     outline=(206, 209, 220, 45), width=1)

    # 两块浅色内嵌牌：深棕刻字压在深灰石头上会糊，垫浅底才读得清。
    for box, radius in ((TITLE_BOX, 14), (PLAQUE_BOX, 16)):
        plaque = Image.new("L", BOARD_SIZE, 0)
        ImageDraw.Draw(plaque).rounded_rectangle(box, radius=radius, fill=255)
        board.paste(gradient(BOARD_SIZE, PLAQUE_TOP, PLAQUE_BOTTOM), (0, 0), plaque)
        draw.rounded_rectangle(box, radius=radius, outline=(*STONE_EDGE, 235), width=4)
        draw.line([box[0] + 12, box[1] + 4, box[2] - 12, box[1] + 4],
                  fill=(216, 219, 230, 150), width=2)

    return board


def _runs(flags) -> list[tuple[int, int]]:
    """一维布尔数组里连续 True 的区间，用来逐段修补而不是整行一刀切。"""
    out, start = [], None
    for i, on in enumerate(flags):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(flags) - 1))
    return out


def erase_vases(bg: Image.Image, masks) -> None:
    """把两只花瓶从背景里抹掉。

    花瓶是抠成精灵原位盖回去的，鼠标悬停时精灵抬起 5px，背景里那只就露出来了
    ——所以背景这边必须留一个干净的洞。

    补法是从洞的边界往里长：每轮把「还空着但紧邻已知像素」的点取邻居均值填上，
    重复到填满。等于把周围的石块颜色顺着边界推进去，越靠边越准——而悬停时真正
    露出来的也就是贴着轮廓那 5～8px，所以这个方向的精度正好用在刀刃上。

    洞要比精灵蒙版大一圈（先闭合内部缝隙再外扩），否则花瓶那圈深色描边会剩下
    一道鬼影；蒙版内部若留缝，缝里的瓶身亮色会被当成「周围颜色」抹开成亮斑。
    """
    src = np.asarray(bg).astype(float)
    h, w = src.shape[:2]

    # 三只花瓶和花簇都是奶白高亮色，把它们整体挡在取样源之外——否则中间那只
    # 不做按钮的花瓶会被当成「周围颜色」，顺 8 邻域扩散成一个 X 形亮斑。
    lum = src[..., :3].mean(axis=2)
    bright = lum > 150

    hole = np.zeros((h, w), bool)
    for vase, mask in masks:
        bx, by, bw, bh = vase["box"]
        x0, y0 = bx - BOARD_OFF[0], by - BOARD_OFF[1]
        # 闭运算在 box 内做，先把描边和高光造成的内部缝隙封掉。
        sealed = mask.filter(ImageFilter.MaxFilter(15)).filter(ImageFilter.MinFilter(15))
        canvas = Image.new("L", (w, h), 0)
        canvas.paste(sealed, (x0, y0))
        grown = np.asarray(canvas.filter(ImageFilter.MaxFilter(9))) > 24
        # 外扩不许越过 box 太多，免得啃到中间那只不做按钮的花瓶。
        clip = np.zeros((h, w), bool)
        clip[max(0, y0 - 4) : y0 + bh + 4, max(0, x0 - 4) : x0 + bw + 4] = True
        hole |= grown & clip

    # 取样源＝既不在洞里、也不是任何花瓶亮色的像素（即纯石面/泥土）。这些点
    # 当作扩散的固定边界；洞和所有亮色区都算未知，一起被石色漫进去。
    fixed = ~hole & ~bright

    # 扩散式填充：反复高斯模糊、每轮把固定边界钉回原值。均值向内推进会在方形
    # 洞里留一条中轴接缝（X 形），各向同性的扩散不会。中间那只花瓶在工作缓冲里
    # 也被石色盖掉，但最后只把洞内结果写回，所以它原样保留。
    work = Image.fromarray(src[..., :3].astype("uint8"), "RGB")
    boundary = src[..., :3].copy()
    for _ in range(80):
        work = work.filter(ImageFilter.GaussianBlur(4))
        buf = np.asarray(work).astype(float)
        buf[fixed] = boundary[fixed]
        work = Image.fromarray(buf.astype("uint8"), "RGB")
    fill = np.asarray(work).astype(float)

    # fill 只在洞内有效（亮色处是 0），所以仅把洞内像素写回，洞外一律保留原图。
    out = src.copy()
    out[hole, :3] = fill[hole]
    patched = Image.fromarray(out.astype("uint8"), "RGBA")
    # 生长填充会留下细微的放射状纹路，轻轻糊一下；只糊洞内，别动周围。
    soft = np.asarray(patched.filter(ImageFilter.GaussianBlur(1.1))).astype(float)
    blended = np.asarray(patched).astype(float)
    blended[hole] = soft[hole]
    blended[..., 3] = src[..., 3]
    bg.paste(Image.fromarray(blended.astype("uint8"), "RGBA"))


# 木牌上那行「欢迎回来，我的朋友！」用的是游戏自带点阵字库 font5
# （已对比过点阵：font5 渲染 14×144，素材 14×142，字形逐像素一致）。
# 账号名只允许字母数字下划线，所以只导 ASCII 部分够用。
GAME_FONT = Path("../联机版260430/font/font5")
NAME_GREEN = (86, 226, 0)
NAME_SHADOW = (24, 46, 12)
NAME_SHADOW_OFF = (-1, 2)


def export_name_font() -> None:
    """把 font5 的 ASCII 字形拼成一张横条图，附 JSON 字宽表给前端用。"""
    raw = GAME_FONT.with_suffix(".bin").read_bytes()
    count = struct.unpack("<6I", raw[:24])[2]
    table = {}
    for k in range(count):
        o = 24 + k * 18
        ch, gw, gh, gx, gy = struct.unpack("<HIIII", raw[o : o + 18])
        table[ch] = (gw, gh, gx, gy)

    atlas = np.asarray(Image.open(GAME_FONT.with_suffix(".dds")).convert("RGBA"))[..., 3]
    wanted = [c for c in range(0x20, 0x7F) if c in table]
    height = max(table[c][1] for c in wanted)
    sheet = Image.new("L", (sum(table[c][0] for c in wanted), height), 0)

    glyphs, pen = {}, 0
    for c in wanted:
        gw, gh, gx, gy = table[c]
        sheet.paste(Image.fromarray(atlas[gy : gy + gh, gx : gx + gw]), (pen, 0))
        glyphs[chr(c)] = [pen, gw]
        pen += gw

    # 只存 alpha：前端拿它当蒙版，绿色和阴影都在 canvas 里上色。
    out = Image.new("RGBA", sheet.size, (255, 255, 255, 0))
    out.putalpha(sheet)
    out.save(OUT / "NameFont.png", optimize=True)
    (OUT / "NameFont.json").write_text(
        json.dumps(
            {
                "height": height,
                "green": list(NAME_GREEN),
                "shadow": list(NAME_SHADOW),
                "shadowOffset": list(NAME_SHADOW_OFF),
                "glyphs": glyphs,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"NameFont.png 导出 {len(glyphs)} 个字形，字高 {height}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    bg = compose_bg_right()
    colour = ink_colour(bg)
    erase_engraving(bg)
    engrave(bg, "在线测试版", colour)

    # 先在完整背景上抠花瓶，再把花瓶从背景里抹掉——顺序反了就抠到空洞。
    cuts = []
    for vase in VASES:
        mask = object_mask(bg, vase["box"], vase["seeds"])
        cuts.append((vase, mask, cut_vase(bg, vase)))

    erase_vases(bg, [(v, m) for v, m, _ in cuts])
    bg.save(OUT / "BG_Right.png", optimize=True)
    print(f"BG_Right.png 重刻完成，刻字色 {colour}，两只花瓶已从背景抹除")

    for vase, _, cut in cuts:
        cut.save(OUT / f"{vase['file']}.png", optimize=True)
        highlight(cut).save(OUT / f"{vase['file']}_hl.png", optimize=True)
        print(f"{vase['file']}.png 抠图完成，刻字「{vase['label']}」")

    build_update_board().save(OUT / "UpdateBoard.png", optimize=True)
    print("UpdateBoard.png 画好了")

    export_name_font()


if __name__ == "__main__":
    main()
