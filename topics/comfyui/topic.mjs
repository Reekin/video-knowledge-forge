// Example topic: open-source AI image/video generation (ComfyUI), learned from a Bilibili follow group.
// The published result of this config: https://reekin.github.io/comfyui-knowledge-map/
export default {
  id: 'comfyui',

  // Who the material is for and what it covers; every prompt is written around these two lines.
  audience: '想精通 ComfyUI 与开源 AI 生图/生视频的人',
  domain: '开源 AI 生图/生视频（ComfyUI）',

  sources: [
    // Replace with your own follow group (uid + tag id from the URL .../relation/follow?tagid=<tag>), or use
    // { type: 'bilibili-up', mids: ['...'] }, { type: 'bilibili-fav', mediaId: '...' },
    // { type: 'youtube', urls: ['https://www.youtube.com/@...'] }, { type: 'local', dir: '...' }.
    { type: 'bilibili-follow-tag', mid: '314790', tag: '389461361' },
  ],

  // Coarse filter on title and description.
  filter: {
    keep: `- ComfyUI 或其他本地/开源工具链的实操教程与工作流讲解；开源图像/视频/3D 模型的上手、测评、调参；LoRA/微调训练；内容控制（ControlNet、姿态、深度、构图、局部重绘、扩图）；角色一致性、换脸换人、角色替换、风格迁移/替换；视频生成、首尾帧、动作迁移、口型、超分补帧；提示词与参数经验；节点/插件开发、环境部署、显存优化与报错排查。开源模型配合在线平台跑同一套工作流也算保留。
- 闭源模型或平台上的分享，如果核心价值是可迁移到任何模型的创作方法（分镜设计、运镜组合、提示词结构与写法、表演/镜头语言、影视制作流程），也保留，category 标为对应方法。`,
    drop: `- Stable Diffusion WebUI / Forge / Fooocus 等 WebUI 工具，以及 SD1.5、SDXL、SD3 时代模型与插件的教程，这些都已过时。
- Agent 编排类内容：Agent 驱动 ComfyUI 的自动化流水线、n8n、MCP/Skill 编排与 Agent 入门。
- 闭源模型或商业产品的单纯使用、功能介绍、效果展示与宣传，没有可迁移方法的。
- 与 AI 生成无关的传统影视后期教程（AE、PR、剪辑、调色、PV 模板），category 标为 传统后期。
- 与图像视频无关的方向（纯 LLM、编程、音乐、TTS/声音克隆）；非技术内容（资讯快报、行业观点、闲聊、成片展示、抽奖、带货、招生、直播预告、动态转发）。`,
    categories: '工作流教程/模型上手/LoRA训练/内容控制/角色一致性/风格迁移/视频生成/环境部署/原理讲解/分镜运镜/提示词方法/制作流程/闭源产品/WebUI过时/Agent编排/非图像/非技术',
    // What "core dependency" means here; drives the stale-version rule in rank.
    dependency: { label: '模型', hint: '写规范名（家族 + 版本，如 "Qwen-Image 2.1"、"Wan 2.2"、"Flux.2 Klein"、"SDXL"）' },
    evergreen: 'LoRA 训练原理、采样原理、ComfyUI 基础机制、分镜运镜方法',
  },

  rank: {
    line: 0.5,              // study videos scoring >= 50% of the creator's best
    halfLifeDays: 180,      // the field moves fast; older videos fade
    evergreenFloor: 0.3,
    since: '2025-01-01',    // earlier uploads are the SD/WebUI era and are not ranked
    newModelSince: '2026-01-01', // model-bound videos survive only if a model first appears on/after this date
  },

  understandPrompt: `this is a Chinese tutorial about AI image/video generation (ComfyUI, open-source models, prompting, shot design). Write the summary half in Chinese. Many key details only appear on screen, so in the transcript's visual notes and in a dedicated summary section, record exactly as displayed every node name, model / LoRA / checkpoint / VAE / text-encoder file name, parameter value (steps, CFG, sampler, scheduler, denoise, shift, resolution, frame count, fps, LoRA strength, seed settings, etc.), plugin or repository name, prompt text, hardware and VRAM figure, and the overall workflow structure that is shown or mentioned. Also list every tip, pitfall, comparison result and troubleshooting advice the creator gives, and where the creator says the workflow or files can be obtained.`,

  // Models per LLM stage (names as your gateway lists them). Filtering and comment notes can use a
  // cheap model; extraction and synthesis decide the quality of the map.
  models: {
    classify: 'deepseek-flash',
    observe: 'deepseek-flash',
    extract: 'claude-opus-5',
    synth: 'claude-opus-5',
  },

  // Knowledge structure: parts group chapters; atoms are tagged with chapter ids.
  parts: [
    { id: 'base', name: '地基', desc: '把 ComfyUI 跑起来、跑得快、不报错', color: 'var(--teal)' },
    { id: 'image', name: '图像', desc: '出图、改图、控图、保人、换风格、放大、训 LoRA', color: 'var(--red)' },
    { id: 'video', name: '视频', desc: '生成、提质提速、编辑替换、数字人、长片', color: 'var(--blue)' },
    { id: 'craft', name: '创作', desc: '提示词、镜头语言与整套影视流程', color: 'var(--ochre)' },
  ],
  chapters: [
    { id: 'env', part: 'base', name: '环境、显存与提速', scope: 'ComfyUI 安装与整合包、插件管理、注意力加速（Sage/Kitchen 等）、量化（fp8/nvfp4/4bit/GGUF）、显存与内存优化、分块采样、常见报错排查、云端平台（RunningHub）' },
    { id: 'img-models', part: 'image', name: '图像模型与出图', scope: '主力开源图像模型（Krea 2、Qwen-Image 2.1、Flux.2 Klein、Z-Image 等）的特点与选择、文生图参数、采样器调度器、步数 CFG、写实度与审美' },
    { id: 'img-edit', part: 'image', name: '图像编辑与重绘', scope: '指令编辑模型、多图参考、局部重绘、扩图、换背景、重打光、调色、产品图合成' },
    { id: 'control', part: 'image', name: '构图与姿态控制', scope: 'ControlNet、OpenPose、深度、线稿、姿势迁移、交互姿态、构图与布局控制、区域控制' },
    { id: 'identity', part: 'image', name: '角色一致性与换人', scope: '保持人物身份、换头换脸、换装与虚拟试穿、角色卡/多视图设定、人物替换（图像侧）' },
    { id: 'style', part: 'image', name: '风格、质感与洗图', scope: '风格迁移与融合、去 AI 感/洗图/写实化、皮肤毛孔质感、去油腻、反推提示词' },
    { id: 'upscale', part: 'image', name: '高清修复与超分', scope: '图像与视频超分模型（SeedVR2、FlashVSR、VOSR 等）、潜空间放大、分块放大、细节增强、人脸修复' },
    { id: 'lora', part: 'image', name: 'LoRA 训练与使用', scope: 'LoRA/微调训练方法、数据集准备与打标、训练参数、LoRA 选择与权重叠加、加速 LoRA 与风格 LoRA 的取舍' },
    { id: 'vid-models', part: 'video', name: '视频模型与生成方式', scope: '主力开源视频模型（MiniMax H3、LTX 2.x、Bernini、Wan 等）、文生/图生/参考生/首尾帧、分辨率时长帧率、模型版本与融合底模选择' },
    { id: 'vid-quality', part: 'video', name: '视频画质与提速', scope: '一采二采/两段式采样、潜空间放大、加速 LoRA 与蒸馏、步数分配、去油腻去糊、高动态不崩、运动质量' },
    { id: 'vid-edit', part: 'video', name: '视频编辑与人物替换', scope: '视频人物替换、动作迁移、遮罩追踪、局部视频重绘、换装换道具、视频延长与插帧' },
    { id: 'avatar', part: 'video', name: '数字人、口型与声音', scope: '数字人/口播、音频驱动口型、音画同步、配音与 TTS 在流程中的衔接' },
    { id: 'longform', part: 'video', name: '长视频与多镜头', scope: '长视频生成与续帧、多镜头/分镜直出、故事板转视频、导演台/时间线插件、跨镜头一致性' },
    { id: 'prompt', part: 'craft', name: '提示词与镜头语言', scope: '提示词结构与写法、运镜术语与组合、表演/微表情描述、去字幕等负面约束、提示词增强与 Skill' },
    { id: 'production', part: 'craft', name: 'AI 影视制作流程', scope: '从剧本、角色定妆、分镜到生成、剪辑后期的完整流程、白模预演、成本控制、团队与工具分工' },
  ],

  site: {
    title: '影像炼金',
    accentChars: 2,                      // trailing characters of the title drawn in the accent colour
    mark: '影',
    subtitle: '开源生图 · 生视频知识图谱',
    eyebrow: '2026 · 开源影像创作',
    repo: 'comfyui-knowledge-map',       // GitHub repo for `publish`
    landscape: {
      label: '模型',
      title: '该用哪个模型？',
      desc: '当下主力模型的定位、长处和门槛，闭源模型也列出来作对照。',
      groups: [
        { id: 'image', name: '图像', en: 'IMAGE', part: 'image' },
        { id: 'video', name: '视频', en: 'VIDEO', part: 'video' },
      ],
    },
  },

  synth: {
    paths: '4 条（零基础入门出图、图像进阶控制与一致性、视频生成从入门到出片、AI 短片完整制作）',
  },
};
