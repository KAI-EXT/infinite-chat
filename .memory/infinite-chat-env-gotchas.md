---
name: infinite-chat-env-gotchas
description: infinite-chat 开发/测试环境的坑：Node26 cpSync mode、模型目录泄漏进测试、上游测试本就红
type: memory
---

# infinite-chat 环境坑

**Why**: 踩过的坑，避免重复排查。

**How to apply**:
- Node 26 的 `cpSync` 不接受 `mode: 0o700`（报 "mode out of range, must be <= 7"）——迁移复制时不要传 mode。
- 测试里 `ModelRuntime.create({ modelsStorePath: <不存在的文件> })` 会回退读本机真实的 `~/.pi/agent/models-store.json`，把 deepseek/minimax 等模型泄漏进 `registry.getAvailable()`；需要精确模型列表断言时先 `writeFileSync(modelsStorePath, '{}')`。
- 上游 pi-optchat 仓库（~/Code/ai/pi-optchat）本地被改过默认模型（magpie/zhipu/glm-5.3-flash）但没同步测试，settings/menu 两个测试在上游本来就是红的；infinite-chat 已改为对目录内容健壮的断言。
- macOS 上 sun_path 限制 103 字节，默认 tmpdir 前缀 ~49 字符：socket 相关测试的临时目录在 darwin 下要放 `/tmp`（support.ts 同款做法）。

**Related**: [[infinite-chat-plugin-design]]
