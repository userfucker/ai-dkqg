# 在 OpenWrt 的 Docker 容器 ubuntu22 里部署中转站

适用：OpenWrt（iStoreOS，x86_64）上跑着 Docker 容器 `ubuntu22`（bridge 网络，只映射了 webui 的 3000 端口），容器里有普通用户 `claudeuser`，webui 也在里面用 pm2 跑。

做法：中转站在容器里用 pm2 跑 8765 端口；OpenWrt 本机用 socat 把 8765 转发进容器（不用重建容器、不动 webui）。

## 一、容器里：装环境（root，只需一次）

```bash
# 在 OpenWrt 上
docker exec -it ubuntu22 bash

# 容器里（root）
apt update && apt install -y git build-essential python3 curl
node -v                      # 要 v20 以上；没有或太低就执行下一行
# curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
which pm2 || npm install -g pm2
```

## 二、容器里：取代码、构建、启动（claudeuser）

```bash
su - claudeuser
cd ~
git clone -b claude/gracious-maxwell-p5lfva https://github.com/userfucker/ai-dkqg.git
cd ~/ai-dkqg
npm run setup                # 安装依赖 + 构建，几分钟
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 logs ai-dkqg --lines 30  # 看到“插件口令：…”就成功了，Ctrl+C 退出
exit                         # 退出 claudeuser
exit                         # 退出容器
```

私有仓库要输 GitHub 用户名和 Personal Access Token。

## 三、OpenWrt 本机：装 socat（root@OpenWrt）

软件源坏了时直接装 ipk：

```bash
curl -sL "https://downloads.openwrt.org/releases/23.05.5/packages/x86_64/packages/socat_1.7.4.4-1_x86_64.ipk" -o /tmp/socat.ipk && ls -la /tmp/socat.ipk
opkg install /tmp/socat.ipk
socat -V | head -1           # 能打出版本号就装好了
```

## 四、OpenWrt 本机：8765 端口转发进容器（root@OpenWrt）

```bash
cat > /root/ai-dkqg-forward.sh <<'EOF'
#!/bin/sh
# 局域网访问 OpenWrt:8765 → 转发到容器 ubuntu22 里的中转站
while :; do
  IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ubuntu22 2>/dev/null)
  [ -n "$IP" ] && break
  sleep 5
done
exec socat TCP-LISTEN:8765,fork,reuseaddr TCP:$IP:8765
EOF
chmod +x /root/ai-dkqg-forward.sh

cat > /etc/init.d/ai-dkqg-forward <<'EOF'
#!/bin/sh /etc/rc.common
START=99
USE_PROCD=1
start_service() {
  procd_open_instance
  procd_set_param command /bin/sh /root/ai-dkqg-forward.sh
  procd_set_param respawn
  procd_close_instance
}
EOF
chmod +x /etc/init.d/ai-dkqg-forward
/etc/init.d/ai-dkqg-forward enable
/etc/init.d/ai-dkqg-forward start
```

检查：

```bash
sleep 2
netstat -lnt | grep 8765                                  # 有 0.0.0.0:8765 LISTEN
wget -qO- http://127.0.0.1:8765/api/auth/state; echo      # 返回 {"setup":...} 这样的 JSON
```

## 五、网页和插件

1. 浏览器打开 `http://<OpenWrt局域网IP>:8765/`，第一次设置管理密码
2. 网页“设置”里复制“插件口令”
3. Chrome 插件 AI Web → 设置：中转站 IP = OpenWrt 局域网 IP，端口 = 8765，口令 = 插件口令
4. 网页右上角显示“插件已连接”就好了

## 日常

```bash
# 更新中转站（OpenWrt 上执行）
docker exec -it ubuntu22 su - claudeuser -c "cd ~/ai-dkqg && git pull && npm run setup && pm2 restart ai-dkqg"

# 重启了容器 ubuntu22 之后（容器 IP 可能变）
/etc/init.d/ai-dkqg-forward restart
docker exec -it ubuntu22 su - claudeuser -c "pm2 resurrect"   # 中转站没自己起来时

# 看状态 / 日志
docker exec ubuntu22 su - claudeuser -c "pm2 status"
docker exec -it ubuntu22 su - claudeuser -c "pm2 logs ai-dkqg"
```

数据（会议记录、设置、密码）在容器里的 `/home/claudeuser/ai-dkqg/data/`，备份这个文件夹即可。

## 卸载

```bash
/etc/init.d/ai-dkqg-forward stop; /etc/init.d/ai-dkqg-forward disable
rm -f /etc/init.d/ai-dkqg-forward /root/ai-dkqg-forward.sh
docker exec ubuntu22 su - claudeuser -c "pm2 delete ai-dkqg && pm2 save"
```
