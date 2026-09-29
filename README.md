# Garden Clash

基于 TypeScript、Vite 和 WebSocket 的多人联机游戏项目。

## 开发

    npm ci
    npm run dev

联机服务器：

    npm run dev:server

## 构建与检查

    npm run check
    npm run build

仓库保留了服务器现有的 dist 部署产物，因为完整素材由仓库外的游戏资源包生成。

运行数据默认保存在 data 目录，不纳入版本控制。生产环境可以通过 GARDEN_DATA_DIR 指定独立目录。
