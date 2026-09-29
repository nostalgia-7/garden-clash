"""离线参考渲染：按与前端播放器相同的矩阵约定合成若干帧，导出成拼图。

用途是肉眼核对 reanim 解析结果和仿射变换的符号约定是否正确 —— 这是整条
视觉链路上最容易搞错、又最难靠单元测试发现的地方。

变换沿用原版 SexyAppFramework 的约定（skew 是角度）：
    a =  cos(skewX) * scaleX     c = -sin(skewY) * scaleY     e = x
    b =  sin(skewX) * scaleX     d =  cos(skewY) * scaleY     f = y
"""

import json
import math
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from pack_assets import build_image_index, resolve       # noqa: E402

FIELDS = ("x", "y", "skewX", "skewY", "scaleX", "scaleY", "alpha", "frame")
# frame 默认是「可见」：显式写 -1 才隐藏。僵尸的身体轨道在走路区间里
# 从不写 frame，只有跳舞段才写，说明未写过的轨道本就该画出来。
DEFAULTS = {"x": 0.0, "y": 0.0, "skewX": 0.0, "skewY": 0.0,
            "scaleX": 1.0, "scaleY": 1.0, "alpha": 1.0, "frame": 0.0}


def forward_fill(track: dict, length: int) -> list[dict]:
    cur = dict(DEFAULTS)
    cur["image"] = None
    out = []
    for i in range(length):
        f = track["frames"][i] if i < len(track["frames"]) else None
        if f:
            for k in (*FIELDS, "image"):
                if k in f:
                    cur[k] = f[k]
        out.append(dict(cur))
    return out


def draw_frame(doc: dict, filled: list[list[dict]], frame: int,
               groups: set[str], hidden: set[str], idx: dict,
               size: tuple[int, int], origin: tuple[int, int]) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    for track, states in zip(doc["tracks"], filled):
        st = states[frame]
        if st["frame"] < 0 or not st["image"]:
            continue
        name = track["name"]
        if name in hidden:
            continue
        if name.startswith("anim_") and name not in groups:
            continue                                    # 未点亮的外观部件组
        path = resolve(st["image"], idx)
        if path is None:
            continue
        part = Image.open(path).convert("RGBA")

        kx, ky = st["skewX"] * math.pi / 180, st["skewY"] * math.pi / 180
        a = math.cos(kx) * st["scaleX"]
        b = math.sin(kx) * st["scaleX"]
        c = -math.sin(ky) * st["scaleY"]
        d = math.cos(ky) * st["scaleY"]
        e = st["x"] + origin[0]
        f = st["y"] + origin[1]

        det = a * d - b * c
        if abs(det) < 1e-6:
            continue
        # PIL 的 AFFINE 要的是「输出 -> 输入」的逆变换
        inv = (d / det, -c / det, (c * f - d * e) / det,
               -b / det, a / det, (b * e - a * f) / det)
        layer = part.transform(size, Image.Transform.AFFINE, inv,
                               resample=Image.Resampling.BILINEAR)
        if st["alpha"] < 1:
            alpha = layer.getchannel("A").point(
                lambda v, s=st["alpha"]: int(v * s))
            layer.putalpha(alpha)
        canvas.alpha_composite(layer)
    return canvas


def main() -> int:
    idx = build_image_index(Path("assets_raw"))
    anim_dir = Path("public/assets/anim")
    skins = json.loads(Path("shared/skins.json").read_text(encoding="utf-8"))
    skins.pop("_comment", None)

    # 在大画布上以中心为锚点渲染，最后统一自动裁剪 —— 免得靠猜锚点，
    # 也保证没有任何部件被画布边缘切掉。
    PAD = 500
    CANVAS = (PAD * 2, PAD * 2)

    # 遍历每个单位声明的每个状态，全画一遍
    cols = 6
    rows: list[list[Image.Image]] = []
    labels: list[str] = []
    for unit, sk in skins.items():
        doc = json.loads((anim_dir / f"{sk['anim']}.json").read_text(encoding="utf-8"))
        length = max(len(t["frames"]) for t in doc["tracks"])
        filled = [forward_fill(t, length) for t in doc["tracks"]]
        hidden = set(sk["hidden"])

        for state, spec in sk["states"].items():
            if "range" in spec:
                lo, hi = spec["range"]
                layers = [(lo, hi)]
            else:
                layers = []
                for name in spec.get("sections", []):
                    rng = doc["sections"].get(f"anim_{name}")
                    if rng is None:
                        print(f"  [跳过] {unit}.{state} 找不到区间 anim_{name}")
                        layers = []
                        break
                    layers.append(tuple(rng))
            if not layers:
                continue

            groups = {f"anim_{g}" for g in (*sk["parts"], *spec.get("parts", []))}
            # 多层叠加时以第一层的长度为准取样
            lo, hi = layers[0]
            span = hi - lo + 1
            imgs = []
            for i in range(cols):
                off = (span * i) // cols
                frames = [a + min(off, b - a) for a, b in layers]
                im = draw_frame(doc, filled, frames[0], groups, hidden,
                                idx, CANVAS, (PAD, PAD))
                for fr in frames[1:]:
                    im.alpha_composite(draw_frame(doc, filled, fr, groups, hidden,
                                                  idx, CANVAS, (PAD, PAD)))
                imgs.append(im)

            # 整行共用一个裁剪框，这样同一动作各帧之间的位移能看出来
            boxes = [b for b in (im.getbbox() for im in imgs) if b]
            if not boxes:
                print(f"  [空] {unit}.{state} 一个部件都没画出来")
                continue
            box = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                   max(b[2] for b in boxes), max(b[3] for b in boxes))
            rows.append([im.crop(box) for im in imgs])
            labels.append(f"{unit}.{state}")
            print(f"  {labels[-1]:26s} 尺寸 {box[2]-box[0]:3d}x{box[3]-box[1]:3d}"
                  f"  锚点偏移 ({box[0]-PAD:4d},{box[1]-PAD:4d})")

    cw = max(im.width for row in rows for im in row) + 8
    ch = max(im.height for row in rows for im in row) + 8
    sheet = Image.new("RGBA", (cw * cols, ch * len(rows)), (30, 34, 28, 255))
    for r, row in enumerate(rows):
        for c, im in enumerate(row):
            sheet.paste(im, (c * cw + 4, r * ch + 4), im)
    out = Path("build/anim-check.png")
    sheet.save(out)
    print(f"\n输出 {out}  ({sheet.width}x{sheet.height})")
    print("每行一个动作，从左到右是该动作内均匀取的 6 帧：")
    for i, l in enumerate(labels):
        print(f"  第{i + 1}行  {l}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
