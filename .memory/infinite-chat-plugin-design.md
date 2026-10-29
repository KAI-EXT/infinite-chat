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
- rename profile：picker 里 Rename profile 项改目录名（模型/记忆/历史不动）；锁被持有（含本 session 自己的 profile）拒改——profileOwner() 探 socket 候选，超时视作 busy。旧绑定自愈靠 `<dataHome>/renames.json`（old→new 链折叠、改回自清理）：openProfile 名字不存在先查映射再查 legacy；openProfile 返回解析后的名字，session_start 用它 appendEntry 重绑新名（session 只自愈一次，之后直连）。AGENTS.md 若仍是创建模板原文则刷新名字，用户改过则不动。
- 全局默认配置 `~/.infinite-chat/config.json`：创建 profile 时跑模型向导（subagent+compactor 逐个选，Esc=保留预填），预填取全局 config 缺省用内置默认；选中值烘进 profile config.json；全局文件**不存在时**才把本次选择写入全局（首次播种，notify 提示），之后永不覆写、只能手改；加载时只补缺失键（profile config.json 优先）；非法键逐个丢弃并 warn。向导仅 TUI（chooseProfile 非 TUI 提前返回）。
- socket 多候选回退（ohos 修复核心）：`socketCandidates()` = `INFINITE_CHAT_SOCK_HOME` > profile 目录（限 sun_path）> `<dataHome>/sock/<hash>` > tmpdir；owner/connector 用同一列表相遇；EADDRINUSE 永远不落到下一候选（不能遮蔽真实 owner）。
- 品牌全改 InfiniteChat：命令 `/infinite-chat`，flag `--infinite-chat-*`（旧 `--optchat-*` 仍注册为别名），绑定键 `infinite-chat.profile`（读旧 `optchat.profile` 兼容旧 session）。
- 旧 profile **不自动迁移**：留在 `~/.optchat`，picker 里 `Old profiles from ~/.optchat` 折叠菜单选中才转换（`importLegacyProfile` 复制、排除 .sock/.lock、补 profile.json、unscoped 待认领），另有 Convert all（必先弹 ui.confirm 列名单；子菜单 Esc=取消——曾因 `choice===undefined` 落入 convert-all 分支致 Esc 误触全量转换，已修 b65893e）；resume/flag/RPC 绑定按需自动转换；`INFINITE_CHAT_NO_LEGACY=1` 隐藏；自定义 INFINITE_CHAT_HOME 永不读宿主 ~/.optchat。
- 依赖必须用上游 package-lock.json 锁定（pi-coding-agent 1.0.2）；不带 lock 安装会因 `@earendil-works/pi-codemode` 导入缺失全挂。

**Related**: [[infinite-chat-env-gotchas]]
