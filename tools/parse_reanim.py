"""解析 PvZ 1.0 的 *.reanim.compiled（骨骼动画定义），输出紧凑 JSON。

外层容器：
    uint32  magic = 0xDEADFED4
    uint32  解压后长度
    bytes   zlib 流

内层（解压后）：
    ---- 头部 24 字节 ----
    uint32  magic2 = 0xB393B4C0
    uint32  junk 指针
    int32   trackCount
    float   fps
    int32   0
    int32   12                  单条轨道表项的大小
    ---- 轨道表 trackCount × 12 ----
    { uint32 junk, uint32 junk, int32 transformCount }
    ---- 逐条轨道 ----
    int32   nameLen; char name[nameLen]
    int32   44                  单个 transform 的大小
    transform[transformCount] × 44:
        float x, y, skewX, skewY, scaleX, scaleY, frame, alpha
        uint32 imagePtr, fontPtr, textPtr    原进程里的野指针，直接丢弃
    紧随其后是字符串区：按 transform 顺序、字段顺序(image/font/text)，
    每个字段都无条件占一条 int32 长度前缀的字符串，没有值的就是 len=0。

原版用 -10000.0 表示「该帧不设置此属性，沿用上一帧」，mFrame = -1 表示隐藏。
名字以 anim_ 开头的轨道不是身体部件，而是「动作区间标记」：它在哪些帧上
mFrame >= 0，就代表该动作占用时间轴的哪一段。
"""

import json
import struct
import sys
import zlib
from pathlib import Path

OUTER_MAGIC = 0xDEADFED4
INNER_MAGIC = 0xB393B4C0
TRANSFORM_SIZE = 44
TRACK_ENTRY_SIZE = 12
UNSET = -10000.0

FIELDS = ("x", "y", "skewX", "skewY", "scaleX", "scaleY", "frame", "alpha")


class ReanimError(Exception):
    pass


class _Cursor:
    def __init__(self, buf: bytes):
        self.buf = buf
        self.pos = 0

    def i32(self) -> int:
        v = struct.unpack_from("<i", self.buf, self.pos)[0]
        self.pos += 4
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.buf, self.pos)[0]
        self.pos += 4
        return v

    def f32(self) -> float:
        v = struct.unpack_from("<f", self.buf, self.pos)[0]
        self.pos += 4
        return v

    def string(self) -> str:
        n = self.i32()
        if not 0 <= n <= 1 << 16:
            raise ReanimError(f"offset {self.pos - 4} 处字符串长度不合理: {n}")
        s = self.buf[self.pos:self.pos + n].decode("latin1")
        self.pos += n
        return s

    def expect(self, want: int, what: str) -> None:
        got = self.i32()
        if got != want:
            raise ReanimError(f"offset {self.pos - 4} 处 {what} 应为 {want}，实为 {got}")


def parse(path: Path) -> dict:
    blob = path.read_bytes()
    magic, dsize = struct.unpack_from("<II", blob, 0)
    if magic != OUTER_MAGIC:
        raise ReanimError(f"外层 magic 不匹配: 0x{magic:08X}")
    raw = zlib.decompress(blob[8:])
    if len(raw) != dsize:
        raise ReanimError(f"解压长度不符: 声明 {dsize}，实际 {len(raw)}")

    c = _Cursor(raw)
    if c.u32() != INNER_MAGIC:
        raise ReanimError("内层 magic 不匹配")
    c.u32()                                     # junk 指针
    track_count = c.i32()
    fps = c.f32()
    c.i32()                                     # 保留 0
    c.expect(TRACK_ENTRY_SIZE, "轨道表项大小")

    counts = []
    for _ in range(track_count):
        c.u32()
        c.u32()
        counts.append(c.i32())

    tracks = []
    for n_transforms in counts:
        name = c.string()
        c.expect(TRANSFORM_SIZE, "transform 结构体大小")

        frames = []
        for _ in range(n_transforms):
            vals = {f: c.f32() for f in FIELDS}
            c.pos += 12                         # image/font/text 野指针，丢弃
            # 丢掉哨兵值，让 JSON 只保留真正发生变化的属性
            frames.append({k: round(v, 4) for k, v in vals.items() if v != UNSET})

        for frame in frames:
            for key in ("image", "font", "text"):
                s = c.string()                  # 每个字段都有一条，空的就是 len=0
                if s:
                    frame[key] = s

        tracks.append({"name": name, "frames": frames})

    if c.pos != len(raw):
        raise ReanimError(f"尾部残留 {len(raw) - c.pos} 字节未消费")

    return {"fps": fps, "tracks": tracks}


def main() -> int:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    files = sorted(src.glob("*.reanim.compiled"))
    dst.mkdir(parents=True, exist_ok=True)

    ok, failed = 0, []
    for f in files:
        name = f.name.removesuffix(".reanim.compiled")
        try:
            doc = parse(f)
        except (ReanimError, zlib.error, struct.error) as e:
            failed.append((name, str(e)))
            continue
        (dst / f"{name}.json").write_text(
            json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8"
        )
        ok += 1

    print(f"解析成功 {ok}/{len(files)}")
    for name, err in failed:
        print(f"  [FAIL] {name}: {err}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
