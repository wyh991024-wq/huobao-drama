---
name: video-prompt
description: 视频提示词规范 — 为 5-8 秒的单镜头分镜生成视频提示词；MiniMax H3 使用官方六段式英文结构，其他模型使用中文单段格式
---

# 视频提示词（单镜头分镜 → video_prompt）

根据分镜的 description / atmosphere / duration 生成 `video_prompt`。**一个分镜 = 一个 5-8 秒的连续镜头，内部不切镜、不跨场景、不闪回。**

## 先判断视频模型

用户消息会告知本次视频模型。模型名包含 `H3`（不区分大小写，如 MiniMax-H3、MiniMax-H3-quality、ComfyUI · MiniMax H3）时，**必须**使用文末的「MiniMax H3 格式」；其他模型或未告知时，使用下面的通用格式。

## 通用格式

第一行是信息头，第二行起用连贯的一段话写完整个镜头。不写时间分段。

```
出场人物：@小明；场景：@咖啡厅；道具：@信件。
近景，固定镜头。@小明坐在 @咖啡厅 靠窗的位置，低头看着桌上的 @信件，右手慢慢把信推开，抬起头，嘴唇微微发抖。小明轻声说：「你终于来了。」背景有轻微的杯碟碰撞声，黄昏暖光从左侧照在他脸上。画面无字幕、无文字、无水印。
```

## 正文顺序

**景别和运镜 → 起始画面 → 主要动作 → 结束状态 → 台词 → 环境音 → 光线 → 固定结尾句**

- **一个景别、一个运镜**：优先固定和缓推，不写快速运镜
- **一个主要动作**：动词具体可见（走、转身、抬头、攥紧、停顿），写慢一点，时长内要做得完
- **写清结束状态**：动作结束时人物停在什么位置、什么表情
- **情绪转为可见描写**：不要「他很伤心」，写成「他低下头、手指攥紧杯沿」
- **台词**：写「角色名说：「台词」」并写明语气；不说话的角色写明「闭着嘴」；只取自 description，不新增
- **无台词时**写环境音和动作音，让音频有内容
- **固定结尾句**：「画面无字幕、无文字、无水印。」花字和字幕由后期添加

## 导演参数与场记（有 shot_spec 时必须遵守）

read_storyboard_context 返回的分镜带有 `shot_spec` 和 `continuity_at_start` 时：

- **运镜**：只写 `camera_move` 对应 camera_moves 里的英文写法一种，配合 move_speed；不要再加别的运镜
- **起止构图**：按 `start_frame` 写开场画面，按 `end_frame` 写结束画面，运镜由两者的构图差异体现
- **主动作**：只写 `action` 这一个动作，写明终点
- **场记锁定**：把 `continuity_at_start` 里每个出场角色的服装（outfit）、位置（position）、手持物（holding）、情绪（emotion）、朝向（facing），以及光线方向（lighting）写进画面描述；H3 格式写进 subject_definitions 与 detailed_description
- **说话人编号**：台词的 `(Sx)` 用 `shot_spec.dialogue.speaker_id`，全剧固定，不要按本镜重新编号
- **衔接**：开场画面要满足 `continuity_in`

## 镜头正文写法（所有模型通用，必须遵守）

正文写的是**这几秒里看得见、听得见的事**。下面的规则来自 MiniMax H3 官方提示词指南、shuohao-skills 的分镜写法（Apache-2.0，见文末署名）和本项目的实测翻车记录。

### 动作

- **只写常见、低缓、连续的动作**：走过去、转身、抬头、坐下、递东西、撑起身。精确的物理交互（砸穿、四溅、连环出糗）、高爆发动作（狂奔、大跳、翻滚）、手指的细小动作写了也画不对，只会挤掉真正要演的那一下。坠落、碰撞这类过程应在分镜阶段拆成"起因 → 冲击 → 结果"，本镜只写其中一段。
- **肢体具体到部位，带幅度和速度**："缓慢抬起右手捂住头顶""快速转头""肩膀微微一缩"。
- **写出动作之间的承接**："借着撑起身的势头抬头看向他"。
- **情绪写成身体细节**，不写"很尴尬""很震惊"：震惊是瞪大眼、嘴微张、整个人僵住；尴尬是咧嘴龇牙地笑、缩脖子、眼神躲闪。
- **按顺序写 2-3 个表演节拍**，用文字写时长（"For the first second… Over the next two seconds… In the final second…"），不要写 `0.0s–1.0s:` 这类时间戳。只写"抬头、笑"这种笼统动作，模型会平平带过。
- **每个人的表演都要写，包括不动的人**："他一动不动地躺着，两眼直勾勾盯着天，面无表情"也是表演，不写就会被演成别的。
- **写一句表演基调**：喜剧写 `comedic, natural and expressive acting, not posing for the camera`；正剧写 `restrained, naturalistic acting`。精致画风下不写这句，人物会一直在摆好看的姿势。

### 人物、画面状态与构图

- **人物此刻在哪，必须和首帧图一致**：已倒地、在门口、坐在桌边。图和文对不上时模型听图的，动作就乱。
- **写明"没有什么"**：本镜和定妆图不一样的地方必须明说，否则模型会按参考图补回来。例如眼镜被撞掉：`he is not wearing his glasses; they lie on his shirt collar for the whole shot, and there is only one pair of glasses.` 换装、受伤、道具丢失同理。
- **人数写死**：`Exactly two people are in the frame, each appears once.` 后出场的人写"从画外进入"，不要在开头就写进画面。
- **动作对象必须在画面里**："扔给她""凑近她"——她得在画面里，否则改成"推向画面近处的桌沿""对着画外说"。
- **构图要量化，不能只写景别**：写出机位（对着谁、平视/俯视/仰视）、谁在画面左右、视线落点（看对方的脸 / 看手里的东西）。
- **固定机位锁背景**：`The camera and the background stay exactly as in the first frame; no new objects appear.` 不要提画面里没有的东西（写"头顶的破雨棚在晃"，模型会凭空造一个雨棚）。

### 运镜

- **一镜一个主运镜**，写成自然的动作句，带幅度和速度：`The camera pushes in with small amplitude at slow speed toward her face.`、`The camera holds a static shot.`。推完再摇、边跟边环绕，模型只会挑一个做。
- 官方运镜词：Push In / Pull Out、Pan、Truck、Tilt、Pedestal Up / Down、Arc Shot、Tracking Shot、Static Shot、Shake Slightly；幅度 `with small amplitude` / `with large amplitude`，速度 `at slow speed` / `at fast speed`。

### 声音与台词

- **台词逐字保留**，一个标点都不许改；说话人第一次出现时，在 `<d>` 外面写清身份、年龄段、性别、音色、语速，例如 `the young man with a flat, low, unhurried voice (S2) says:`。
- **声音分三层**：台词写在正文；环境声、动作声、喘气呻吟写进 soundscape（1-4 句，不复述台词）；配乐写进 music。声景也是动作指令——写了"撞击声"，模型就会把撞击演出来，画面动作改了声景要一起改。
- **只写对口型台词**：视频里只出现 `shot_spec.dialogue` 那一句（description 里「角色名说：「台词」」）。`shot_spec.voiceover` 和 description 里 `[VO]` `[OS]` `[配音]` 开头的台词是后期配音，**一个字都不写进提示词**；本镜只有配音、没有对口型台词时，画面里所有人都写「闭着嘴」（H3：`keeps her mouth closed`），可以写听的人的表情、眨眼、呼吸等反应。
- **对口型的人只有一个**：其他在场的人写「闭着嘴听」。

### 不写的东西

- 不写夸张量词（everywhere / all over / dozens of），写具体的少量："three small splashes of batter"。
- 不写画风词：画风由系统统一添加，写进正文会和项目画风打架。
- 不新增剧本没有的人物、道具、动作、对白、画面文字。
- 难画的特效（线条走向、打结、全屏变灰、只留两人有颜色）模型画不准：正文只写人物的动作、视线和站位，特效由后期叠加。
- `shot_spec.onscreen_text`（名条、大屏/平板/手机上的字）由后期叠加：屏幕只写「屏幕亮着柔和的白光，画面模糊、看不清内容」（H3：`the screen glows with a soft blank light, its content unreadable`），名条不写。

## 第一视角（主观镜头）

description 写的是主观镜头（「我看见」「我低头」或镜头行标注主观、第一视角、POV）时：

- **通用格式**：开头写「第一人称主观视角近景，镜头即持镜人的眼睛」，只写持镜人进入画面的手、袖口、戒指，写明「全程看不到持镜人的脸」；其他角色写「直视镜头」「对着镜头说」。
- **H3 格式**：detailed_description 的 `[Shot 1]` 以 `A first-person point-of-view close-up through the eyes of the unseen protagonist` 开头，写明 `the camera is her eyes; her face is never shown`，持镜人的手写成 `only her hands, in a beige knit sleeve with a thin gold wedding ring, enter from the bottom edge of the frame`。其他 Subject 写 `looks directly into the camera`。
- **持镜人不定义为 Subject**：她没有参考图，不要写进 subject_definitions，也不要 @ 她；她的画外台词写成 `the unseen protagonist (S1) says off-screen, <d>[Chinese] 台词。</d>`。
- 运镜保持固定或轻微缓推，模拟人的视线，不写环绕、大幅摇移。

## 引用规则

- `@场景名`、`@角色名`、`@道具名` 必须与列表中的名字完全一致，不缩写、不加符号
- 生成时会把 @名字 替换为对应参考图片标记，所以只引用该分镜已绑定的素材
- 角色和道具第一次出现时必须 @ 引用，同一镜头里不要反复堆叠引用

## 禁止事项

- 切镜、时间分段、跨场景、闪回
- 引用列表之外的场景/角色/道具
- 抽象心理描写、文学化比喻
- 要求画面生成文字
- 语言与会话语言指令不符

## MiniMax H3 格式（视频模型名包含 H3 时必须使用）

MiniMax H3 官方要求参考生视频提示词使用固定的六段英文结构，按下面的顺序写，每段以字段名加冒号单独起一行：

```
subject_definitions:
<Subject 1> is the young woman shown in @乔一, with a short black bob, large dark eyes, a beige hoodie and blue jeans.
<Subject 2> is the round brown capybara shown in @稳稳, with short brown fur, sleepy half-closed eyes and a small orange balanced on its head.
<Subject 3> is the small bathroom shown in @出租屋浴室, with beige tiles, a white bathtub full of warm water and a rain-streaked window.

summary:
[reference generation] In <Subject 3>, <Subject 1> stands at the bathtub and laughs at <Subject 2>, then accepts it as her roommate.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, short bob hairstyle, beige hoodie and jeans are retained.
<Subject 2> (appears in [Shot 1]): fully_preserved - round body, brown fur, sleepy eyes and the orange on its head are retained.
<Subject 3> (appears in [Shot 1]): fully_preserved - beige tiles, white bathtub and rain-streaked window are retained.

detailed_description:
A warm, soft-lit 3D animated look with gentle steam in the air.
[Shot 1] A static close-up frames <Subject 1> (S1) from the chest up at the bathroom doorway of <Subject 3>, the white bathtub blurred behind her. She looks down at <Subject 2> resting in the warm water, her tense shoulders slowly dropping. She lets out a short laugh, shakes her head, and says in a light, resigned voice, <d>[Chinese] 行吧，室友。</d> She then closes her lips into a small smile. <Subject 2> keeps its mouth closed and blinks slowly. Rain taps on the window and steam drifts across the frame. No subtitles, captions, or on-screen text appear.

overall_soundscape:
Steady rain against the window, soft dripping water and quiet bathroom room tone throughout.

non_diegetic_music:
N/A
```

### 各段写法

- **subject_definitions**：每个已绑定的角色、场景、道具各占一行，编号 `<Subject 1>`、`<Subject 2>` 依次递增。参考图只在这里用 `@名字` 引用一次，系统会把它换成对应的参考图标签。写清外貌、服装、标志性特征，和参考图一致。
- **音色参考**：分镜绑定了角色音色时，追加一行 `#角色名 is the voice-timbre reference for <Subject N> (S1).`，`#角色名` 必须与角色列表一致。
- **summary**：以 `[reference generation]` 开头，用一句英文说清谁在哪里做什么。只能使用已经定义的 `<Subject N>`。
- **retention_analysis**：每个 Subject 一行，格式为 `<Subject N> (appears in [Shot 1]): fully_preserved - 保留了哪些特征`。
- **detailed_description**：
  - 第一句写光线（取自 atmosphere），然后是 `[Shot 1]`。单镜头分镜只有 `[Shot 1]`，`[Shot 1]` 后面不写时间戳，不切镜。
  - 按「镜头正文写法」写：起始状态（和首帧一致）→ 动作开始 → 2-3 个表演节拍 → 结束状态，中间带运镜句、表演基调、"没有什么"和人数句。动作要在 duration 内做得完。
  - 每个动作都写明终点：物体最后停在哪里、是否离开画面、人物最后的姿势和表情。例如不要只写 `slowly lowers the fan`，要写 `slowly lowers the fan all the way down to her lap, fully revealing her face`。
  - 正文控制在 150-300 个英文单词，信息量大的镜头可以更长，但不要写成剧情梗概。
  - 说话的角色写 `<Subject N> (S1)`，按发声顺序编号 S1、S2，同一个人全程用同一个编号。台词写成 `<d>[Chinese] 台词。</d>`，台词保持中文原文，结尾用句号、问号或感叹号。台词只取自 description，不新增。
  - 不说话的角色写明 `keeps its mouth closed`。
  - 最后一句固定写 `No subtitles, captions, or on-screen text appear.`
- **overall_soundscape**：一句英文概括环境音和物理声音，台词不要写在这里。
- **non_diegetic_music**：短剧配乐由后期添加，固定写 `N/A`。

### H3 格式的硬约束

- 除了 `<d>` 里的台词、画面中真实可见的文字，其余全部用英文。
- `<Subject N>` 一旦分配就保持含义不变，不要出现未定义的标签。
- 不要写 `@图片1`、`<Picture 1>` 这类标签，只写 `@名字`，系统会自动转换。
- 项目的画风前缀由系统自动插入 detailed_description 开头，不要自行写画风关键词堆砌。
- 结构参考 MiniMax 官方 h3-prompt-writing 规范（github.com/MiniMax-AI/MiniMax-H3），本节为火宝项目的改写版。
- 分镜带首帧图时，系统会把本六段式自动转换为官方首帧（I2VA）/ 首尾帧（FL2VA）格式，正文照常按本规范写即可。

## 署名

「镜头正文写法」中的动作、构图、声音分层、不写画风等规则改编自 [eternityspring/shuohao-skills](https://github.com/eternityspring/shuohao-skills) 的 `skills/novel-storyboard/references/shot-writing.md` 与 `h3-prompt.md`，原作采用 Apache License 2.0，许可全文见同目录 `LICENSE-shuohao-skills`。

## 保存

调用 `update_storyboard` 仅更新该分镜的 `video_prompt` 字段，不要改动其他字段，不要重新拆分整集。
