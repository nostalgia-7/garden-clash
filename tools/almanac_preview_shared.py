"""预览工具共用的角色渲染。

almanac-preview.py 和 draft-preview.py 都要把一个角色的静止帧画出来，
逻辑一模一样，抽出来放这里，免得两份各改各的走样。
"""

import json
from pathlib import Path

from PIL import Image

from render_check import draw_frame, forward_fill


def unit_image(unit: str, skins: dict, anim_dir: Path, idx: dict) -> Image.Image | None:
    """把一个角色的静止帧渲染成带透明背景、已裁边的图。"""
    sk = skins.get(unit)
    if sk is None:
        return None
    doc = json.loads((anim_dir / f"{sk['anim']}.json").read_text(encoding="utf-8"))
    length = max(len(t["frames"]) for t in doc["tracks"])
    filled = [forward_fill(t, length) for t in doc["tracks"]]

    state = "idle" if "idle" in sk["states"] else next(iter(sk["states"]))
    spec = sk["states"][state]
    # 状态可能用 sections（区间名）也可能直接用 range（帧下标），两种都要认，
    # 否则像土豆雷这种只写 range 的角色会整格空白。
    frame = None
    if "range" in spec:
        frame = spec["range"][0]
    else:
        for name in spec.get("sections", []):
            rng = doc["sections"].get(f"anim_{name}")
            if rng:
                frame = rng[0]
                break
    if frame is None:
        return None

    groups = {f"anim_{g}" for g in (*sk["parts"], *spec.get("parts", []))}
    PAD = 400
    im = draw_frame(doc, filled, frame, groups, set(sk["hidden"]),
                    idx, (PAD * 2, PAD * 2), (PAD, PAD))
    box = im.getbbox()
    return im.crop(box) if box else None
