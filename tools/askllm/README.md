# AskLLM

命令行直接调用大模型网关：查询模型目录、提问，或发送 Responses、Chat Completions、Messages 及其他原生 JSON、流式、上传请求。Python 3.11+，只用标准库。

## 连接哪个网关

设置了 `ASKLLM_BASE_URL`（或传 `--base-url`）时直接使用它：

```bash
export ASKLLM_BASE_URL=https://api.openai.com/v1
export ASKLLM_API_KEY=sk-...
export ASKLLM_WIRE_API=chat      # responses（默认）| chat | messages
```

没有设置时，读取 Codex 的 `~/.codex/config.toml` 与 `auth.json` 里选中的 provider（可用 `--codex-home`、`--config`、`--profile`、`--provider`、`-c KEY=VALUE` 调整）。

## 常用命令

```bash
python ask_llm.py info                       # 本次实际使用的网关与认证来源（不显示密钥）
python ask_llm.py models                     # 网关的模型目录
python ask_llm.py ask "只回复 OK" --model MODEL --effort low --max-tokens 1024 --text
python ask_llm.py ask --prompt-file prompt.txt --model MODEL --api chat --text
python ask_llm.py request /v1beta/models/MODEL:generateContent --json gemini.json
```

`ask` 必须显式指定 `--model`，推理强度和输出上限也不继承任何全局配置，批量调用前先用一个样本确认结果与用量。`--text` 只抽取非流式文本，失败或截断时返回非零退出码；需要工具调用、用量等信息时去掉 `--text` 读原始 JSON。`request` 原样发送请求体，`--set KEY=JSON` 改字段，`--stream` 原样输出 SSE，`--output` 保存原始响应。脚本拒绝重定向和绝对 URL，认证信息只发往选定的网关。

测试：`python -m unittest test_ask_llm`（本地假网关，不发真实请求）。
