# video-knowledge-forge

把一批创作者的视频教程，整理成可以系统学习的知识图谱网站。

给定一组来源（B 站关注分组、UP 主、收藏夹，YouTube 频道或播放列表，本地视频文件夹），它会：

1. 抓取全部视频的标题、简介和播放互动数据；
2. 用便宜的模型按你的主题筛掉无关和过时的视频，再在每位作者内部按互动率和发布时间排序，挑出值得精读的；
3. 让 Gemini 逐条看视频，产出带时间戳的逐句转录和结构化总结（画面上的参数、文件名也会记下来）；
4. 抓取置顶和热门评论，整理出作者答疑、报错解法、观众实测和纠错；
5. 用强模型把每期视频拆成知识点，再按章节归并、重写成知识卡片，生成学习路线和“我想……”场景入口；
6. 输出一个静态网站：星图、章节、路线、版图、术语，可以直接打开，也可以一条命令发布到 GitHub Pages。

示例成品：[影像炼金 · 开源生图生视频知识图谱](https://reekin.github.io/comfyui-knowledge-map/)，由 [topics/comfyui](topics/comfyui/topic.mjs) 这份配置从 13 位 B 站 UP 主的 3600 多条投稿中生成。

## 准备

- Node.js 20+、Python 3.11+、ffmpeg（在 PATH 上）
- B 站来源需要 [BBDown](https://github.com/nilaoda/BBDown)：`dotnet tool install --global BBDown`
- YouTube 来源需要 [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- 一个 Gemini API key（视频理解），以及一个 OpenAI 兼容网关（文本模型）

```bash
git clone https://github.com/Reekin/video-knowledge-forge
cd video-knowledge-forge
npm install            # 安装视频理解工具的依赖
cp .env.example .env   # 填入 key，说明见文件内注释
node forge.mjs login   # B 站来源：终端扫码登录，抓取和下载共用这份登录
```

`.env` 里的 `ASKLLM_BASE_URL` 留空时，会沿用本机 Codex 的网关配置（`~/.codex/config.toml`）。视频默认以内联方式直接发给 Gemini，不需要 Google Cloud 账号；需要走 GCS 时见 [tools/video-understand/SETUP.md](tools/video-understand/SETUP.md)。

## 用法

先复制一份主题配置，改成你自己的：

```bash
cp -r topics/comfyui topics/my-topic   # 编辑 topics/my-topic/topic.mjs
node forge.mjs check --topic topics/my-topic
node forge.mjs run --topic topics/my-topic
node forge.mjs open --topic topics/my-topic
```

`run` 依次执行下面的阶段，每个阶段也能单独运行。所有阶段都会跳过已经完成的部分，中断后重跑即可续上；`run --from <阶段>` 从某一步开始。

| 阶段 | 做什么 | 产出（`work/<主题>/` 下） |
|---|---|---|
| `crawl` | 列出作者和全部视频及数据；`--limit 20` 每位作者只取最新 20 条 | `_data/videos/` |
| `classify` | 按主题的保留、剔除规则粗筛 | `_data/class/` |
| `rank` | 每位作者内部打分，选出精读视频；`--line 0.4` 放宽分数线 | `notes/<作者>/00-ranking.md`、`overview.md` |
| `comments` | 抓置顶、热评和楼中楼 | `notes/<作者>/<视频>/comments.json` |
| `understand` | 视频理解：逐句转录 + 结构化总结 | `transcript.md` |
| `observe` | 把评论区整理成可读笔记 | `comment-notes.md` |
| `extract` | 每期视频拆成带章节标签的知识点 | `_data/atoms/` |
| `synth` | 规划节点、写知识卡片、章节导读、路线与入口 | `_data/synth/` |
| `build` | 生成静态网站 | `site/index.html` |
| `publish` | 推到 GitHub 公开仓库并开启 Pages（需要 `gh` 已登录） | 网址 |

`notes/` 本身就是一套可读的学习资料：每期视频一个目录，有转录、评论原文和评论笔记。

## 主题配置

[topics/comfyui/topic.mjs](topics/comfyui/topic.mjs) 是带注释的完整示例，主要字段：

- `audience` / `domain`：材料写给谁、讲什么领域，所有提示词都围绕这两句展开；
- `sources`：来源列表，支持 `bilibili-follow-tag`、`bilibili-up`、`bilibili-fav`、`youtube`、`local`；
- `filter`：保留、剔除规则和分类标签，以及“核心依赖”指什么（如模型、软件版本），用于识别过时内容；
- `rank`：分数线、时间衰减半衰期、起始日期，`newModelSince` 之前就出现的依赖视为旧版本；
- `understandPrompt`：附加给视频理解的要求，比如让它照抄画面上的参数；
- `models`：每个文本阶段用哪个模型。筛选和评论笔记可以用便宜模型，拆解和综合决定成品质量，建议用最强的；
- `parts` / `chapters`：知识结构，知识点按章节归类，网站按板块配色；
- `site`：网站标题、副标题、版图页的名称与分组、发布用的仓库名。

## 排序怎么算

得分只在同一位作者的视频之间比较：质量分 = 0.6 × 互动率百分位（B 站按收藏、投币、点赞、评论加权，YouTube 按点赞和评论）+ 0.4 × 与发布时间相近视频比的播放百分位，再乘以时间衰减（原理类内容有衰减下限）。精读范围是得分不低于该作者最高分一定比例的视频。本地视频没有数据，筛选后全部精读。

## 目录

```
forge.mjs              命令行入口
src/stages/            各阶段
src/sources/           来源适配：bilibili、youtube、local
site/                  网站模板
tools/video-understand 视频理解 CLI（自带守护进程，B 站下载、预处理分段、字幕对齐、Gemini 调用）
tools/askllm           文本模型调用 CLI（Responses / Chat Completions / Messages）
topics/                主题配置
```

两个工具都能脱离本项目单独使用，说明见各自目录。

## 使用须知

本项目用于个人学习研究。抓取的视频、转录和评论只保存在本地 `work/` 目录；生成的网站只包含重写后的知识内容和原视频链接。请遵守各平台的使用条款，控制抓取频率，不要再分发视频与评论原文。
