---
name: infinite-chat-plugin-design
description: infinite-chat (~/Code/ai/infinite-chat) 是用户自建的 pi 记忆插件，从 pi-optchat 分叉；关键设计决策与兼容约定
type: decision
---

# infinite-chat 插件的关键设计决策

**Why**: 用户要替换 npm:pi-optchat，目标：ohos 兼容、profile 按目录隔离、session 绑定恢复、全局默认配置、UI 显示子 agent/压缩模型、默认模型 zai-coding-cn/glm-5.3-flash。

**How to apply**:
- 数据根目录 `~/.infinite-chat`（env `INFINITE_CHAT_HOME`，旧 `OPTCHAT_HOME` 仍兼容；测试沙盒靠它）。
- profile 目录作用域存在 `profiles/<name>/profile.json`（cwd/createdAt/lastUsedAt）；无 cwd 的 profile 在所有目录可见，首次打开即认领当前目录。resume 永远以 session 绑定为准，不受目录过滤影响。
- rename profile：picker 里 Rename profile 项改目录名（模型/记忆/历史不动）；锁被**其他** Pi 持有时拒改——profileOwner() 探 socket 候选，超时视作 busy。本 session 打开的 profile 可就地改名：先预检名字非法/重名（免得白拆），再复用 profile 切换的 stop() 全套拆除释放锁，renameProfile 后返回新名让调用方重开（switch 走 newSession 重启、startup 直接 openProfile）；stop() 后须 stopping=false（同一 session_start 内继续）。旧绑定自愈靠 `<dataHome>/renames.json`（old→new 链折叠、改回自清理）：openProfile 名字不存在先查映射再查 legacy；openProfile 返回解析后的名字，session_start 用它 appendEntry 重绑新名（session 只自愈一次，之后直连）。AGENTS.md 若仍是创建模板原文则刷新名字，用户改过则不动。
- 全局默认配置 `~/.infinite-chat/config.json`：创建 profile 时跑模型向导（subagent+compactor 逐个选，Esc=保留预填），预填取全局 config 缺省用内置默认；选中值烘进 profile config.json；全局文件**不存在时**才把本次选择写入全局（首次播种，notify 提示），之后永不覆写、只能手改；加载时只补缺失键（profile config.json 优先）；非法键逐个丢弃并 warn。向导仅 TUI（chooseProfile 非 TUI 提前返回）。
- socket 多候选回退（ohos 修复核心）：`socketCandidates()` = `INFINITE_CHAT_SOCK_HOME` > profile 目录（限 sun_path）> `<dataHome>/sock/<hash>` > tmpdir；owner/connector 用同一列表相遇；EADDRINUSE 永远不落到下一候选（不能遮蔽真实 owner）。
- 品牌全改 InfiniteChat：命令 `/infinite-chat`，flag `--infinite-chat-*`（旧 `--optchat-*` 仍注册为别名），绑定键 `infinite-chat.profile`（读旧 `optchat.profile` 兼容旧 session）。
- 旧 profile **不自动迁移**：留在 `~/.optchat`，picker 里 `Old profiles from ~/.optchat` 折叠菜单选中才转换（`importLegacyProfile` 复制、排除 .sock/.lock、补 profile.json、unscoped 待认领），另有 Convert all（必先弹 ui.confirm 列名单；子菜单 Esc=取消——曾因 `choice===undefined` 落入 convert-all 分支致 Esc 误触全量转换，已修 b65893e）；resume/flag/RPC 绑定按需自动转换；`INFINITE_CHAT_NO_LEGACY=1` 隐藏；自定义 INFINITE_CHAT_HOME 永不读宿主 ~/.optchat。
- 依赖必须用上游 package-lock.json 锁定（pi-coding-agent 1.0.2）；不带 lock 安装会因 `@earendil-works/pi-codemode` 导入缺失全挂。
- 会话选择器（a231c38）：`/infinite-chat sessions`（TUI-only，治 pi -r 共池问题的本）——src/sessions.ts 的 listSessions(cwd) 读 pi 会话池（agentDir=PI_CODING_AGENT_DIR~~/.pi/agent，munge `--${resolve(cwd).replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`），逐文件解析 jsonl：首行 header cwd 过滤（防 munge 碰撞，resolve+realpath 双比）、末条 binding（infinite-chat/optchat 皆认）经 renamedProfile 解链、数 user 消息、抽首条预览（60字）；再按 resolved 去重探 profileOwner 标 busy。标签 `MM-DD HH:MM · profile · busy/legacy/missing · N msgs · 预览`，当前会话按 getSessionFile() 排除。选中走 ctx.switchSession(path)（命令 ctx 有，:1669）：session_shutdown→stop() 释本窗锁，新 session_start 按绑定开 profile（改名/legacy 转换/busy 弹窗全复用）。注意：pi 1.4.0 无参 TUI 启动也自动恢复池里最新会话（不只 pi -r），fresh busy 弹窗 Esc=抛错（既有语义）。
- resume/busy 撞锁语义（04453f6）：pi 的 session 按目录共池（`~/.pi/agent/sessions/<munged-cwd>/`），`pi -r` 取 mtime 最新（session-manager findMostRecentSession）——开着的窗口对话持续刷新 mtime，永远压住别的 profile，resume 常落 busy profile；这是 pi 核心行为，扩展改不了选 session。busy 弹窗 settled（有对话）时菜单 `[Open a different profile instead, CONNECT]`（出口置顶防顺手 Enter 连进别窗对话），SWITCH＝干净退出不重绑（session_start 的 ctx 没有 newSession——只有命令 ctx 有；原地重绑会改写别窗的 session）＋提示 /infinite-chat profile（新会话）或 /resume（选特定会话）；fresh 会话仍 `[CONNECT,…,BACK]`（原地重绑安全）。弹窗标题用 `renamedProfile(name) ?? name` 显示解析后新名（旧绑定不再显示旧名）。
- ask 工具（49e066e，源启微信文章 pi-episodes 的 ask）：`ask(question, id, n)` 把行 id+n（n 2 的幂，同 zoom）或子 agent 整个 run（字符串 id）发给 profile 的 compactor 模型（复用 reasoningFor/retryTransient，sessionId 'infinite-chat-ask'，无自定义 cache marks——cachePayload 只认 view 壳），只回答案，usage 记 'ask' 角色。工具 execute 第 5 参才有 ctx.modelRegistry（签名 toolCallId, params, signal, onUpdate, ctx）。超大归档 ASK_CAP=200k 字符首尾各留（头=任务、尾=结论）。zoom/ask 结果附带过期文件注解（正则抽绝对/相对路径含裸文件名，裸名按 process.cwd() 解析；statSync mtime 比行 date+2s，≤3 个列出、余 '+N more'）——故意拉取式：推进 view 会破坏字节稳定前缀毁缓存。加新常改提示词文本时，ZOOM_ONLY/ZOOM_AND_SEARCH 常量必须与 VIEW_DOC 正文同步改，否则 allowSearch 的 replace 失效（settings 两测会红）。

**Related**: [[infinite-chat-env-gotchas]]
