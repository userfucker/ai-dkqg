/** 启动：网页 + 接口 + 插件连接（同一个端口；插件连 ws://IP:端口/ext）。 */
import { serve } from "@hono/node-server";
import os from "node:os";
import type { Server } from "node:http";
import { HOST, PORT, VERSION, DATA_DIR } from "./config.ts";
import { createApp } from "./app.ts";
import { bridge } from "./bridge.ts";
import { extToken, hasPassword, setPassword } from "./auth.ts";
import { getDb } from "./db.ts";
import { recoverOnStartup, startWatcher } from "./meetings/runner.ts";

getDb();
if (!hasPassword() && process.env.ADMIN_PASSWORD) setPassword(process.env.ADMIN_PASSWORD);
recoverOnStartup();
startWatcher();

const server = serve({ fetch: createApp().fetch, port: PORT, hostname: HOST }) as unknown as Server;
server.on("upgrade", (req, socket, head) => {
  const path = (req.url || "").split("?")[0];
  if (path === "/ext") bridge.handleUpgrade(req, socket, head);
  else socket.destroy();
});

const ips = Object.values(os.networkInterfaces()).flat().filter((x) => x && x.family === "IPv4" && !x.internal).map((x) => x!.address);
console.log(`AI 多方会议中转站 ${VERSION} 已启动（数据目录 ${DATA_DIR}）`);
for (const ip of ips.length ? ips : ["127.0.0.1"]) console.log(`  网页：http://${ip}:${PORT}/      插件设置：IP ${ip}  端口 ${PORT}`);
console.log(`  插件口令：${extToken()}（网页“设置”里也能看到）`);
if (!hasPassword()) console.log("  还没设置管理密码：第一次打开网页时设置");

const stop = () => { server.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
