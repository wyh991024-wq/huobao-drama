#!/usr/bin/env bash
# 在 ComfyUI 服务器上部署「体验版」Reelo（给朋友试用，和本机自用的那套数据完全分开）。
# 直接用 Node 跑，不用 Docker（OneThingAI 的实例本身是容器，里面起不了 Docker）。
#
# 本机先打包上传（在仓库根目录、Git Bash 里执行）：
#   (cd frontend && npm run generate)
#   tar czf /tmp/reelo-demo.tgz --exclude=node_modules backend frontend/.output/public docs/server/deploy_demo.sh
#   scp -P <端口> /tmp/reelo-demo.tgz root@<服务器>:/root/
#   # 可选：导出本机的 ComfyUI 视频/图片配置（工作流，不含任何 Key）一起传上去
#   (cd backend && node scripts/export-comfy-configs.cjs /tmp/comfy-configs.json) && scp -P <端口> /tmp/comfy-configs.json root@<服务器>:/root/
#
# 服务器上执行：
#   mkdir -p /root/reelo-demo && tar xzf /root/reelo-demo.tgz -C /root/reelo-demo
#   ACCESS_PASSWORD='给朋友的密码' bash /root/reelo-demo/docs/server/deploy_demo.sh
#
# 之后：浏览器打开 http://<对外地址>:<对外端口>，用户名随便填、密码填 ACCESS_PASSWORD；
# 文本模型的 Key 由你自己在「设置」页填（建议单独申请一个带额度上限的 DeepSeek Key）。
set -euo pipefail
APP=${APP:-/root/reelo-demo}
DATA=${DATA:-/root/reelo-demo-data}
PORT=${PORT:-5679}
NODE_VER=${NODE_VER:-v22.12.0}
NPM_REG=${NPM_REG:-https://registry.npmmirror.com}
: "${ACCESS_PASSWORD:?必须设置 ACCESS_PASSWORD（访问密码）}"

# Node：从 npmmirror 下二进制，装到 /root/node（不动系统环境）
if [ ! -x /root/node/bin/node ]; then
  curl -fsSL "https://registry.npmmirror.com/-/binary/node/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o /tmp/node.tar.xz
  mkdir -p /root/node && tar xJf /tmp/node.tar.xz -C /root/node --strip-components=1
fi
export PATH=/root/node/bin:$PATH

cd "$APP/backend"
# lockfile 里的 resolved 可能指向私有源：删掉让 npm 走镜像；原生模块二进制也走镜像，不现场编译
node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json'));for(const p of Object.values(l.packages||{}))delete p.resolved;fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2))"
npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 \
FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static \
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm_config_sharp_binary_host=https://registry.npmmirror.com/-/binary/sharp \
  npm ci --no-audit --no-fund --registry="$NPM_REG"

mkdir -p "$DATA"
[ -d "$DATA/workspace" ] || cp -r "$APP/backend/workspace" "$DATA/workspace"

cat > /root/start_reelo_demo.sh <<EOF
#!/bin/bash
# 体验版 Reelo 启动脚本（deploy_demo.sh 生成）
export PATH=/root/node/bin:\$PATH
export NODE_ENV=production PORT=$PORT ACCESS_PASSWORD='$ACCESS_PASSWORD'
export HUOBAO_DATA_DIR=$DATA SQLITE_PATH=$DATA/huobao.sqlite3 WORKSPACE_PATH=$DATA/workspace
export FRONTEND_DIST=$APP/frontend/.output/public
cd $APP/backend && exec npx tsx src/index.ts
EOF
chmod 700 /root/start_reelo_demo.sh

P=$(pgrep -f "tsx src/index.ts" || true); [ -n "$P" ] && kill $P && sleep 2
nohup setsid /root/start_reelo_demo.sh > /root/reelo-demo.log 2>&1 < /dev/null &
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/health" && break; sleep 2; done
curl -s "http://127.0.0.1:$PORT/api/v1/health" || { echo "没起来，看 /root/reelo-demo.log"; tail -n 20 /root/reelo-demo.log; exit 1; }
echo

# 导入 ComfyUI 配置（如果上传了 /root/comfy-configs.json）：地址改成本机 ComfyUI
if [ -f /root/comfy-configs.json ]; then
  COMFY_URL=${COMFY_URL:-http://127.0.0.1:7860} node - <<'JS'
const fs = require('fs')
const base = `http://127.0.0.1:${process.env.PORT || 5679}/api/v1/ai-configs`
const auth = 'Basic ' + Buffer.from('deploy:' + process.env.ACCESS_PASSWORD).toString('base64')
;(async () => {
  const have = (await (await fetch(base, { headers: { Authorization: auth } })).json()).data || []
  for (const c of JSON.parse(fs.readFileSync('/root/comfy-configs.json', 'utf8'))) {
    if (have.some(h => h.name === c.name)) { console.log('已有', c.name); continue }
    const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ ...c, base_url: process.env.COMFY_URL, api_key: '' }) })
    console.log(r.status, c.name)
  }
})()
JS
fi
echo "体验版已启动：本机 http://127.0.0.1:$PORT （对外访问要在云平台控制台开放端口）"
