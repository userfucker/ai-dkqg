// OpenWrt 上的 Docker 容器 ubuntu22（和 webui 一样用 pm2）：
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
//   pm2 logs ai-dkqg        # 看日志（插件口令也在里面）
module.exports = {
  apps: [{
    name: "ai-dkqg",
    script: "backend/dist/server.mjs",
    cwd: __dirname + "/..",
    env: { PORT: "8765", DATA_DIR: __dirname + "/../data" },
    max_restarts: 20,
    restart_delay: 3000,
  }],
};
