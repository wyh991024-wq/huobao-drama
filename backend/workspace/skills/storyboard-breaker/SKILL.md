---
name: storyboard-breaker
description: 分镜拆解专业规范 — 导演规则、运镜模板库与场记表，把剧本拆成 5-8 秒的单镜头分镜
---

# 分镜拆解指南

## 核心定义：单镜头分镜

一个分镜 = 一个连续镜头 = 一个视频生成任务。

- 每个分镜 **5-8 秒**，只有一个景别、一种运镜、一个主动作，内部不切镜
- 镜头之间的切换由后期剪辑完成，所以要按剪辑思维设计景别轮换、反应镜头和动作衔接

## 拆分流程

1. 调用 `read_storyboard_context` 读取剧本、角色（含 speaker_id）、场景、道具、运镜模板库
2. 按剧本的场划分 `scene_code`（E01-S01…），调用 `save_scene_continuity` 保存每场场记
3. 按导演规则拆分镜，每个分镜填写 `shot_spec`，分批调用 `save_storyboards`
4. 调用 `check_storyboard_rules`，按违规项修正后再检查

## 场记表（解决跳戏）

每场开始时写一份状态，后续每镜的 `end_state` 只写变化：

```json
{
  "scene_code": "E01-S02",
  "location": "出租屋客厅",
  "time_of_day": "night",
  "lighting": "主光来自画左的台灯，暖黄；窗外冷蓝",
  "characters_state": {
    "乔一": { "outfit": "芥末黄卫衣", "position": "沙发左侧", "holding": "手机", "emotion": "疲惫", "facing": "面向画右" }
  },
  "props_state": { "茶几上的外卖盒": "已打开" }
}
```

- 人物服装、所在位置、手持物、光线方向是跳戏的主要来源，必须写全
- 本镜改变了位置、手持物、情绪或朝向时，在 `shot_spec.end_state.characters` 里按角色名写出变化
- 系统会把「本镜开始时的场记」交给提示词 agent 写进 video_prompt

## 导演参数 shot_spec

| 字段 | 说明 |
|---|---|
| scene_code / shot_id | 所属场、镜号，如 E01-S02 / E01-S02-05 |
| shot_size | CU / MCU / MS / MWS / WS / EWS |
| camera_move | 运镜模板 ID，只能一个 |
| move_speed | slow / medium / fast |
| start_frame / end_frame | 镜头开始、结束时谁在哪、什么姿势、看向哪里 |
| action | 本镜单一主动作 |
| dialogue | speaker_id（用角色列表的固定编号）、speaker、text、tone |
| continuity_in | 必须与上一镜 end_frame 一致的要素 |
| purpose | 建立 / 推进 / 反应 / 揭示 / 转场 / 情绪落点 |
| end_state | 本镜结束时人物、道具状态的变化 |

## 导演规则（违反任一条就重拆）

1. **一镜一个主动作、一种运镜**；复杂动作拆成两镜
2. **景别轮换**：相邻两镜景别不同；每场第一镜用 WS 或 MWS 建立空间，之后再进入 MS/CU
3. **反应镜头**：A 说完重要台词，下一镜给 B 的反应（CU），不连续两镜同一人说话
4. **180 度轴线**：两人对话时摄像机始终在同一侧，越轴前先插正面镜头或空镜
5. **视线匹配**：A 看向画右，下一镜 B 看向画左
6. **动作衔接**：上一镜 end_frame 的动作在下一镜 start_frame 继续
7. **时长**：每镜 5-8 秒；对白镜时长 ≥ 台词字数 × 0.25 秒 + 1 秒
8. **情绪落点**：每场最后一镜给 CU 表情或意象空镜，不以对白直接切场
9. **揭示镜头**：每集至少 1 个，PUSH_SLOW 或 PUSH_FAST 推到 CU，放在反转处
10. **集时长**：用户指定了每集总时长上限（如 90 秒）时严格遵守；超了就合并或删掉信息重复的镜头、精简台词，不要压缩单镜到 5 秒以下

## 可拍性规则（视频模型照字面画、照字面演，违反就重拆）

1. **一镜一件事**：坠落、碰撞、摔倒、连环出糗这类物理过程拆成"起因 → 冲击 → 结果"几镜，每镜只写其中一段；不要在一镜里写"从天而降＋砸穿＋压倒＋四溅"。
2. **只用常见、低缓、连续的动作**：走、转身、抬头、坐下、递东西、撑起身。精确物理交互和高爆发动作（狂奔、翻滚）尽量避开。
3. **起始画面只写那一刻真在画面里的人**，后出场的人写"从画外进入"；character_ids 只绑定画面里看得见的人。
4. **动作对象必须在画面里**："扔给她""凑近她"——她得入画，否则改成"推向画面近处""朝画外说"。
5. **不写夸张量词**（满地、到处、几十张），写具体的少量。
6. **画面里的字留空**：报名表、账单、名牌、屏幕上的字写"空白"，在 description 里注明"后期贴"。
7. **难画的特效交后期**：线条走向、打结、全屏变灰、只留两人有颜色这类效果，镜头里只写人物的动作、视线和站位，在 description 里注明"后期叠加"。
8. **换装要有对应定妆图**：角色换装（卧底、换衣服）时绑定对应的角色变体（如「阿缘·保洁装」），不要绑定原装角色。

## 运镜模板库

每镜只选一个，H3 提示词用对应英文写法，起止构图由 start_frame / end_frame 体现（首帧中景、尾帧特写 = 推）：

| ID | 运镜 | H3 写法 | 用途 |
|---|---|---|---|
| STATIC | 固定 | camera locked | 对白、表演 |
| PUSH_SLOW | 慢推 | slow push-in from medium to close-up | 情绪积累 |
| PUSH_FAST | 急推 | fast push-in to extreme close-up | 揭示、震惊 |
| PULL | 拉远 | slow pull-back revealing the room | 孤独、揭示环境 |
| TRUCK | 横移 | camera trucks left alongside her | 跟随行走 |
| FOLLOW | 背跟 | camera follows behind her at shoulder height | 进入新空间 |
| CRANE_UP | 升 | camera cranes up and away | 结尾、抽离 |
| CRANE_DOWN | 降 | camera cranes down into the scene | 开场建立 |
| ORBIT | 半环绕 | slow half orbit around them | 关系确立、高光 |
| TILT | 摇 | slow tilt up from her shoes to her face | 角色登场 |
| RACK | 变焦点 | rack focus from foreground object to her face | 信息转移 |
| HANDHELD | 手持 | subtle handheld shake | 紧张、混乱 |
| WHIP | 甩镜 | quick whip pan to the right | 转场、喜剧节奏 |
| DOLLY_ZOOM | 希区柯克变焦 | dolly zoom | 全集最大反转，最多一次 |

- 不要一镜写多个运镜（如「推近然后环绕」），H3 容易乱动或不动
- 对白镜优先 STATIC 或 PUSH_SLOW，口型最稳

## 第一视角（主观镜头）

剧本【拍摄要求】或镜头行写了「主观」「第一视角」或「POV」时，镜头就是某个角色（持镜人）的眼睛。此时不要求每场以全景建立空间，其余导演规则照常：

- **不绑定持镜人**：持镜人看不到自己的脸，`character_ids` 里不要放他；description 只写进入画面的手、袖口、戒指等部分
- **其他角色正对镜头**：与镜头对视、对着镜头说话，description 写清「看着我」「对我说」
- **景别和运镜**：保持原镜头行的近景/特写和固定/缓推，不要改成全景或客观视角
- **持镜人说话**：写成「（画外）角色名说：「台词」」，画面里不出现他的嘴

## 镜头要素

1. **镜头标题**：3-5字概括段落核心内容（如"噩梦惊醒"）
2. **时间**：具体时分 + 光线描述
3. **地点**：场景完整描述 + 空间布局 + 环境细节
4. **景别**：只写一个景别，与 shot_spec.shot_size 一致
5. **角度**：平视/仰视/俯视/侧面/背面
6. **运镜**：只选一个运镜模板 ID，与 shot_spec.camera_move 一致
7. **画面描述** `description`：只写一个 `【镜头1】`，描述观众实际看到和听到的内容——画面（谁 + 具体动作 + 肢体细节 + 表情）写在前；有台词时写「角色名说：「台词」」，旁白写「旁白：内容」
8. **画面结果** `result`：段落结尾的即时后果 + 视觉细节
9. **氛围** `atmosphere`：光线 + 色调 + 声音 + 整体氛围
10. **时长** `duration`：5-8 秒，且满足对白时长规则
11. **场景关联**：若能匹配已有场景，必须填写 `scene_id`
12. **角色关联**：填写 `character_ids`，绑定当前段落涉及的 0 到多个角色
13. **道具关联**：填写 `prop_ids`，绑定当前段落出现的关键道具（0 到多个）

## 场景关联规则

- 优先使用 `read_storyboard_context` 返回的 `scenes`
- `location + time` 可明确匹配时，必须回填正确 `scene_id`
- 不要凭空生成不存在的场景 ID
- 如果剧本内容明显落在已有场景中，不要重复创造新场景描述

## 角色绑定规则

- `character_ids` 必须从 `read_storyboard_context` 返回的角色列表中选择
- 一个段落可以没有角色，也可以绑定多个角色
- 只绑定画面里看得见的角色；声音从画外传来的角色不绑定
- 一个分镜尽量不超过 2 个角色和 1 个道具，参考图越少越不容易认错
- 纯环境段落、空镜、物件特写可以传空数组

## 道具绑定规则

- `prop_ids` 必须从 `read_storyboard_context` 返回的道具列表（`props`）中选择
- 道具被角色使用、交接、特写，或在画面中明显可见且对叙事有意义时，必须绑定到该段落
- 道具特写段落（无角色）也应绑定道具，`character_ids` 可为空
- 与剧情无关的背景物品、场景陈设不要绑定；没有道具出现的段落传空数组
- 绑定的道具会作为视频生成的参考图（白底单品图），保证道具外观跨段落一致

## 质量要求

- `description` 要适合人读，详细描述观众实际看到和听到的内容；台词/旁白直接写在 `【镜头1】` 内
- `image_prompt` 要突出单帧构图、角色外观、环境和光线
- `bgm_prompt` 和 `sound_effect` 用简洁短语即可，但不能空泛到只有“紧张”“悲伤”
- 如需调整，调用 `update_storyboard` 修改具体段落
