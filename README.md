# AI 多方会议中转站（ai-dkqg）

让 **DeepSeek、智谱清言、Kimi** 的网页版（用免费额度）一起开会：2～3 个 AI 围绕一个议题讨论，共同写出一份结论（合并稿），你是主持人。（千问已停用：消息超过一万多字就用不了。）

会议的逻辑和架构来自 webui 项目的 **AI 会议**（`webui/backend/meetings`）。为了用在网页版 AI 上做了一些改动，见 [docs/design.md](docs/design.md)。

```
四个 AI 网页（Chrome）──浏览器插件 ai-web──WebSocket──▶ 中转站（本项目，Node.js）◀── 你的电脑 / 手机浏览器
```

## 功能

- **AI 会议**：
  1. **提问环节**：AI 先读议题，向你提问（只问不答）；没有问题就直接开始；
  2. **第 1 轮**：各自独立陈述；
  3. **第 2 轮起**：一位执笔写合并稿，其他人同时审阅；
  4. **达成一致**：除执笔人以外都同意、没有关键问题，就结束（绿色）。
- **主持人**：
  - 每轮结束后有倒计时，你一打字倒计时就停；你说的话所有 AI 都必须逐条回应；
  - 可以继续、定稿、暂停、终止、改执笔、改轮数、给某个席位换 AI。
- **自动结束**：达成一致 / 求同存异（连续两轮没进展）/ 条件不足 / 轮数用完（不同意的意见附在结论后面）。
- **长消息**：超过 100 行（可设置）的内容用 txt 附件上传。
- **出错处理**：
  - 插件断开 → 暂停，插件连上后自动继续；
  - 网站限流 / 额度用完 → 暂停，10 分钟后自动重试；
  - 服务重启 → 停在原处，点“继续”接着开。
- **会议纪要**：导出 Markdown。
- **会话管理**：会议在各网站上用过的对话、各网站的全部对话，都能打开、批量删除。
- **会议风格提示词**：在设置页增删改，新建会议时选一份。
- **一个管理密码**登录；页面适配手机；需要你处理时，网页标题会闪烁。
- **一次只能开一场会议。**

## 安装

需要 **Node.js 20 以上**（建议 22）。Ubuntu 22 自带的 Node 太旧，用 NodeSource 装：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v22.x
```

取代码、安装、构建：

```bash
git clone https://github.com/userfucker/ai-dkqg.git /opt/ai-dkqg
cd /opt/ai-dkqg
npm run setup        # 安装依赖 + 构建网页和后端
npm start            # 先手动跑一下试试，Ctrl+C 停止
```

启动后会打印：

- 网页地址：`http://<IP>:8765/`
- 插件要填的 IP、端口、口令

第一次打开网页时设置管理密码。

> better-sqlite3 一般会直接下载编译好的文件；下载不了、开始自己编译时，先装 `sudo apt install -y build-essential python3`。

### Ubuntu 22.04：开机自动启动（systemd）

```bash
sudo cp deploy/ai-dkqg.service /etc/systemd/system/
sudo nano /etc/systemd/system/ai-dkqg.service     # 改 User 和路径
sudo systemctl daemon-reload && sudo systemctl enable --now ai-dkqg
journalctl -u ai-dkqg -f                           # 看日志
```

### OpenWrt：Docker 容器 ubuntu22（pm2，和 webui 一样）

```bash
docker exec -it ubuntu22 bash
# 容器里：按上面装好 Node、取代码、npm run setup，然后
npm install -g pm2          # 已经装过就跳过
cd /opt/ai-dkqg
pm2 start deploy/ecosystem.config.cjs && pm2 save
pm2 logs ai-dkqg            # 看日志
```

**端口**：插件和浏览器要能从局域网访问到容器里的 8765 端口。在 OpenWrt 上查容器的网络：

```bash
docker inspect -f '{{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}' ubuntu22
```

- 显示 `host`：容器直接用 OpenWrt 的网络，什么都不用做。插件里填 OpenWrt 的局域网 IP 和 8765。
- 显示 `bridge`，而且没有映射 8765：端口映射只能在创建容器时加，有两个办法：
  1. 把中转站端口改成一个**已经映射好、又没在用**的端口：在 `deploy/ecosystem.config.cjs` 里改 `PORT`。
  2. 重建容器时加上 `-p 8765:8765`。

改端口后，插件里的端口也要跟着改。

## 设置插件

1. 浏览器插件用 [ai-web](https://github.com/userfucker/ai-web)（1.1.0 以上，需要附件功能）。
2. 打开插件的“设置”，填入以下内容：
   - 中转站 IP：中转站那台机器的局域网 IP（Docker 里就填 OpenWrt 的 IP）；
   - 端口：8765；
   - 口令：中转站网页“设置”里的“插件口令”。
3. 点“保存并连接”。
4. 中转站网页右上角显示“插件已连接 · 4/4 就绪”就可以开会了。没打开的网站，插件会自动单独开一个窗口。
5. 四个网站各登录一次。网站上的模式（深度思考、联网搜索、模型）以网页当前的设置为准，需要的话自己在网站上设。

## 使用

1. **新建会议**：
   - 填议题；
   - 选会议风格；
   - 按顺序点选 2～4 个 AI（顺序就是甲乙丙丁）；
   - 选执笔方式（轮流 / 固定）、最大轮数、每轮等你多久。
2. **提问环节**：AI 有问题时会议停下来等你。你可以逐题点选项或填写，也可以跳过；跳过就按 AI 写的默认假设进行。
3. **每轮结束后**：在下面的输入框写意见，所有 AI 都会看到。“定稿”让执笔人马上写最终稿，其他人确认后结束。
4. **结束后**：可以导出纪要。在“会话”页可以批量删除会议在网站上用过的对话。

## 开发

```bash
npm run dev --prefix backend     # 后端 8765（tsx watch）
npm run dev --prefix frontend    # 网页 5173，接口自动转给 8765
npm test                         # 后端测试：会议流程 + 用假插件跑完整场会议
npm run typecheck
```

## 目录

```
backend/src/
  index.ts            启动（网页 + 接口 + 插件 WebSocket /ext，同一个端口）
  app.ts              接口
  bridge.ts           和插件的连接（命令按网站排队）
  auth.ts             管理密码登录、插件口令
  db.ts               SQLite（data/relay.sqlite）
  meetings/protocol.ts  会议规则、拼消息、解析状态块、决定下一步、结束判定（纯函数）
  meetings/runner.ts    会议推进（后台运行）、主持人操作
  meetings/store.ts     会议的数据库读写
  meetings/minutes.ts   导出纪要
backend/test/         测试
frontend/src/         网页（React + Vite + Tailwind）
deploy/               systemd / pm2 配置
docs/design.md        设计说明（和 webui AI 会议的对应关系）
```
