import { defineConfig } from "vite";

export default defineConfig({
  // 素材由 tools/pack_assets.py 生成到 public/assets，Vite 原样服务
  publicDir: "public",
  server: {
    host: true,
    port: 5173,
    proxy: {
      // 开发时把对局连接转给本地游戏服务器
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: "index.html", animTest: "anim-test.html" },
    },
  },
});
