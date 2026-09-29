"""解包 PvZ 1.0 的 main.pak。

格式（全文件字节先 XOR 0xF7）：
    uint32  magic   = 0xBAC04AC0
    uint32  version = 0
    循环:
        uint8   flag        0x80 表示文件表结束
        uint8   nameLen
        bytes   name        (GBK, 路径用反斜杠)
        int32   fileSize
        int64   fileTime    (Windows FILETIME)
    文件表结束后按同样顺序紧跟各文件的原始数据。
"""

import struct
import sys
from pathlib import Path

XOR_KEY = 0xF7
MAGIC = 0xBAC04AC0


def unpack(pak_path: Path, out_dir: Path) -> list[tuple[str, int]]:
    data = bytearray(b ^ XOR_KEY for b in pak_path.read_bytes())

    magic, version = struct.unpack_from("<II", data, 0)
    if magic != MAGIC:
        raise SystemExit(f"magic 不匹配: 0x{magic:08X}，这不是 PvZ main.pak")
    if version != 0:
        print(f"[warn] 未见过的 version={version}，继续尝试", file=sys.stderr)

    pos = 8
    entries: list[tuple[str, int]] = []
    while True:
        flag = data[pos]
        pos += 1
        if flag == 0x80:
            break
        if flag != 0x00:
            raise SystemExit(f"offset {pos - 1} 处出现未知 flag 0x{flag:02X}")
        name_len = data[pos]
        pos += 1
        name = bytes(data[pos:pos + name_len]).decode("gbk", errors="replace")
        pos += name_len
        size = struct.unpack_from("<i", data, pos)[0]
        pos += 4 + 8  # size + FILETIME
        entries.append((name, size))

    for name, size in entries:
        rel = name.replace("\\", "/")
        dest = out_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(bytes(data[pos:pos + size]))
        pos += size

    if pos != len(data):
        print(f"[warn] 尾部剩余 {len(data) - pos} 字节未消费", file=sys.stderr)
    return entries


if __name__ == "__main__":
    pak = Path(sys.argv[1])
    out = Path(sys.argv[2])
    got = unpack(pak, out)
    print(f"解出 {len(got)} 个文件 -> {out}")
