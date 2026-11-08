#!/usr/bin/env bash
# 在 ComfyUI 服务器上安装 IndexTTS2 配音节点（snicolast/ComfyUI-IndexTTS2）+ IndexTTS-2 模型
# 用法：bash install_indextts2.sh            （ComfyUI 在 /root/ComfyUI，conda python 在 /root/miniconda3）
# 服务器连 GitHub 不稳定时：本机 git clone 后 scp 到 /root/ComfyUI/custom_nodes/ComfyUI-IndexTTS2，再跑本脚本（会跳过 clone）
set -euo pipefail
COMFY=${COMFY:-/root/ComfyUI}
PY=${PY:-/root/miniconda3/bin/python}
PIP_INDEX=${PIP_INDEX:-https://repo.huaweicloud.com/repository/pypi/simple}
NODE=$COMFY/custom_nodes/ComfyUI-IndexTTS2

if [ ! -d "$NODE" ]; then
  git clone --depth 1 https://github.com/snicolast/ComfyUI-IndexTTS2 "$NODE"
fi
$PY -m pip install -i "$PIP_INDEX" wetext modelscope
$PY -m pip install -i "$PIP_INDEX" -r "$NODE/requirements.txt"

# 模型：ModelScope 国内镜像（与 HuggingFace IndexTeam/IndexTTS-2 相同）
mkdir -p "$NODE/checkpoints"
$PY - <<PYEOF
from modelscope import snapshot_download
snapshot_download('IndexTeam/IndexTTS-2', local_dir='$NODE/checkpoints')
PYEOF
ls -la "$NODE/checkpoints"
echo "装好了：重启 ComfyUI（/root/start_comfyui.sh）后节点列表里应有 IndexTTS2Simple / IndexTTS2EmotionVector / IndexTTS2SaveAudio"
