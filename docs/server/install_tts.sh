#!/usr/bin/env bash
# 在 ComfyUI 服务器上安装台词配音用的两个节点和模型（国内服务器，连不上 GitHub / HuggingFace 也能装）：
#   - IndexTTS2（snicolast/ComfyUI-IndexTTS2）：按角色音色克隆、带情绪向量，逐句配音
#   - Qwen3-TTS（1038lab/ComfyUI-QwenTTS）：VoiceDesign 按文字描述设计角色音色（角色没有音色样本时自动用）
#
# 用法：bash install_tts.sh        （ComfyUI 在 /root/ComfyUI，conda python 在 /root/miniconda3）
# 服务器 git clone GitHub 经常失败（HTTP2 framing / TLS 断开）：脚本会先试 clone，失败就退出并提示——
#   在本机逐文件下载节点代码（跳过 images/、*.jpg 和 IndexTTS2 仓库里没用到的 21MB bst.t7），打包 scp 到
#   custom_nodes/<节点目录> 后重跑本脚本（目录已存在就跳过 clone）。
set -euo pipefail
COMFY=${COMFY:-/root/ComfyUI}
PY=${PY:-/root/miniconda3/bin/python}
PIP_INDEX=${PIP_INDEX:-https://repo.huaweicloud.com/repository/pypi/simple}
IDX=$COMFY/custom_nodes/ComfyUI-IndexTTS2
QWEN=$COMFY/custom_nodes/ComfyUI-QwenTTS
QWEN_MODELS=$COMFY/models/TTS/Qwen3-TTS

clone() {  # clone <repo> <dir>
  [ -d "$2" ] && [ -f "$2/__init__.py" ] && return 0
  if ! timeout 180 git -c http.version=HTTP/1.1 clone --depth 1 "https://github.com/$1" "$2"; then
    rm -rf "$2"
    echo "!! 服务器 clone $1 失败：请在本机下载代码后 scp 到 $2 再重跑本脚本" >&2
    exit 1
  fi
}
clone snicolast/ComfyUI-IndexTTS2 "$IDX"
clone 1038lab/ComfyUI-QwenTTS "$QWEN"

# ── 依赖：锁住已装的 torch / transformers / numpy / protobuf 等，避免把视频节点的环境改坏 ──
CONS=/tmp/tts_constraints.txt
$PY -m pip freeze 2>/dev/null | grep -iE "^(protobuf|torch|torchaudio|torchvision|transformers|numpy|tokenizers|accelerate|librosa|opencv-python|keras|tensorboard|pandas|numba|scipy)==" > $CONS || true
# IndexTTS2 的 requirements 去掉：audiotools（指向 GitHub，改用 PyPI 的 descript-audiotools 单独 --no-deps 装，
# 因为它要求 protobuf<3.20，会把服务器的 protobuf 4.x 降级）、pynini / wetext（Linux 上由 WeTextProcessing 带 pynini 轮子）
REQ=/tmp/tts_req.txt
grep -v -E "audiotools|pynini|WeTextProcessing|wetext|^\s*$" "$IDX/requirements.txt" > $REQ
printf "WeTextProcessing>=1.0.3\nargbind\nffmpy\nflatten-dict\nmarkdown2\nrandomname\npystoi\ntorch-stoi\npyloudnorm\njulius\neinops\n" >> $REQ
$PY -m pip install -i "$PIP_INDEX" -c $CONS -r $REQ
$PY -m pip install -i "$PIP_INDEX" --no-deps descript-audiotools==0.7.2
# Qwen3-TTS 节点运行时只用到 torch / transformers / einops / librosa（都已装），不跑它的 requirements（会升级 accelerate、librosa）

# ── 模型：全部走 ModelScope（hf-mirror 的大文件会跳到 HuggingFace 海外 CDN，经常卡死） ──
$PY - <<PYEOF
import os, shutil
from modelscope import snapshot_download
C = "$IDX/checkpoints"
snapshot_download("IndexTeam/IndexTTS-2", local_dir=C)
snapshot_download("AI-ModelScope/w2v-bert-2.0", local_dir=C + "/w2v-bert-2.0")
snapshot_download("nv-community/bigvgan_v2_22khz_80band_256x", allow_patterns=["config.json", "bigvgan_generator.pt"],
                  local_dir=C + "/nvidia/bigvgan_v2_22khz_80band_256x")
# 这两个文件 IndexTTS2 用 hf_hub_download 取，放到 checkpoints/hf/<repo>/<file>，下面的补丁让它先找本地
for repo, pat, dst in [("amphion/MaskGCT", "semantic_codec/model.safetensors", "amphion/MaskGCT/semantic_codec/model.safetensors"),
                       ("iic/speech_campplus_sv_zh-cn_16k-common", "campplus_cn_common.bin", "funasr/campplus/campplus_cn_common.bin")]:
    target = os.path.join(C, "hf", dst)
    if os.path.isfile(target):
        continue
    tmp = "/tmp/ms_" + repo.replace("/", "_")
    snapshot_download(repo, allow_patterns=[pat], local_dir=tmp)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.move(os.path.join(tmp, pat), target)
Q = "$QWEN_MODELS"
for name in ["Qwen3-TTS-12Hz-1.7B-VoiceDesign", "Qwen3-TTS-Tokenizer-12Hz"]:
    snapshot_download("Qwen/" + name, local_dir=os.path.join(Q, name))

# 补丁：IndexTTS2 的 _hf_download 先用 checkpoints/hf/ 里预先下好的文件（幂等）
p = "$IDX/indextts/infer_v2.py"
s = open(p, encoding="utf-8").read()
old = "def _hf_download(repo_id, filename, **kwargs):\n"
if 'checkpoints", "hf"' not in s:
    assert s.count(old) == 1, "infer_v2.py 结构变了，补丁要重写"
    s = s.replace(old, old
        + "    # 国内服务器连不上 HuggingFace：优先用 checkpoints/hf/<repo_id>/<filename> 里预先下好的文件\n"
        + "    _local = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), \"checkpoints\", \"hf\", repo_id, filename)\n"
        + "    if os.path.isfile(_local):\n"
        + "        return _local\n")
    open(p, "w", encoding="utf-8").write(s)
print("models ok")
PYEOF

# ComfyUI 启动脚本加 HF 镜像（兜底：节点若还要从 HuggingFace 拉别的小文件）
if [ -f /root/start_comfyui.sh ] && ! grep -q HF_ENDPOINT /root/start_comfyui.sh; then
  sed -i 's|^cd /root/ComfyUI|export HF_ENDPOINT=${HF_ENDPOINT:-https://hf-mirror.com}\ncd /root/ComfyUI|' /root/start_comfyui.sh
fi
$PY -m pip freeze 2>/dev/null | grep -iE "^(protobuf|transformers|numpy)=="
echo "装好了：重启 ComfyUI（bash /root/mode_gen.sh，先停掉正在跑的 ComfyUI）后节点列表里应有 IndexTTS2Simple / AILab_Qwen3TTSVoiceDesign"
