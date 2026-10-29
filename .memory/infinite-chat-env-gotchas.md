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
- 独立 tsx 脚本调试时不要 `--import ./test/support.ts`：support 会把 INFINITE_CHAT_HOME/PI_CODING_AGENT_DIR 重定向到它自己的 mkdtemp 沙盒，createProfile 看似成功实际建到别处（readdirSync 打印的是 support 的目录）。直接 `npx tsx script.mts` 即可。
- pi -p 下扩展 session_start 抛错时 pi 仍 exit 0，只在 stderr/会话里留 extension_error——冒烟脚本不能只看退出码。pi -r 是交互式 resume picker（列出当前目录会话），非严格自动选最新；无 UI 时才自动取 mtime 最新。
- macOS 上 sun_path 限制 103 字节，默认 tmpdir 前缀 ~49 字符：socket 相关测试的临时目录在 darwin 下要放 `/tmp`（support.ts 同款做法）。

**Related**: [[infinite-chat-plugin-design]]
