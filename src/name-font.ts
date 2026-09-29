// 主菜单木牌上的账号名，用游戏自带点阵字库 font5 渲染——就是「欢迎回来，我的朋友！」
// 那行字用的同一套。构建时 tools/build_selector_ui.py 把 ASCII 字形导成一张 alpha 横条
// NameFont.png，配一份字宽表 NameFont.json；这里按字宽切片、上绿色、加左下阴影，
// 拼成一张 canvas 盖到木板凹槽里。账号名限定字母数字下划线，ASCII 够用。

interface NameFont {
  height: number;
  green: [number, number, number];
  shadow: [number, number, number];
  shadowOffset: [number, number];
  glyphs: Record<string, [number, number]>; // 字符 -> [横条里的 x, 字宽]
}

let fontPromise: Promise<{ font: NameFont; strip: HTMLCanvasElement } | null> | null = null;

function rgb([r, g, b]: [number, number, number]): string {
  return `rgb(${r},${g},${b})`;
}

async function loadFont(): Promise<{ font: NameFont; strip: HTMLCanvasElement } | null> {
  const [font, image] = await Promise.all([
    fetch("/assets/selector/NameFont.json").then((r) => r.json() as Promise<NameFont>),
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = "/assets/selector/NameFont.png";
    }),
  ]);
  // 把整张字库画进一个离屏 canvas，后面按字形切片。
  const strip = document.createElement("canvas");
  strip.width = image.naturalWidth;
  strip.height = image.naturalHeight;
  strip.getContext("2d")!.drawImage(image, 0, 0);
  return { font, strip };
}

// 把一行字按某个颜色刻出来：先按 alpha 拼出字形，再 source-in 整体填色。
function tint(name: string, color: string, font: NameFont, strip: HTMLCanvasElement): { canvas: HTMLCanvasElement; width: number } {
  const space = font.glyphs[" "] ?? [0, 4];
  const width = [...name].reduce((sum, ch) => sum + (font.glyphs[ch] ?? space)[1], 0);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = font.height;
  const ctx = canvas.getContext("2d")!;
  let pen = 0;
  for (const ch of name) {
    const [sx, w] = font.glyphs[ch] ?? space;
    if (font.glyphs[ch]) ctx.drawImage(strip, sx, 0, w, font.height, pen, 0, w, font.height);
    pen += w;
  }
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, width };
}

/** 把账号名刻到木板凹槽里。字库还没加载完就先留空，加载完再补上。 */
export function renderPlayerName(host: HTMLElement, name: string): void {
  host.textContent = "";
  if (!name) return;
  fontPromise ??= loadFont();
  void fontPromise.then((loaded) => {
    if (!loaded || host.dataset.name !== name) return;
    const { font, strip } = loaded;
    const [ox, oy] = font.shadowOffset;
    const green = tint(name, rgb(font.green), font, strip);
    const shadow = tint(name, rgb(font.shadow), font, strip);

    // 阴影按 (ox,oy) 偏移，可能是负值，整体平移让两层都落在画布内。
    const shiftX = Math.max(0, -ox);
    const shiftY = Math.max(0, -oy);
    const out = document.createElement("canvas");
    out.width = green.width + Math.abs(ox);
    out.height = font.height + Math.abs(oy);
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(shadow.canvas, shiftX + ox, shiftY + oy);
    ctx.drawImage(green.canvas, shiftX, shiftY);

    out.className = "sign-name-canvas";
    host.appendChild(out);
  });
  host.dataset.name = name;
}
