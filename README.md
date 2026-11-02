# InfiniteChat

简体中文 | [English](README.en.md)

一个 Pi 扩展,为每个配置档案 (profile) 提供一段无尽对话,通过摘要树 (summary tree) 而非上下文压缩 (compaction) 来记忆内容。本项目基于 [pi-optchat](https://github.com/jonaslsaa/pi-optchat) 重建,新增了按目录区分的配置档案、会话绑定,以及对 ohos 的一等公民支持。

## 与 pi-optchat 的差异

| | pi-optchat | InfiniteChat |
| --- | --- | --- |
| 数据主目录 | `~/.optchat` | `~/.infinite-chat`（`INFINITE_CHAT_HOME` 可覆盖;旧的 `OPTCHAT_HOME` 写法仍然有效） |
| 配置档案作用域 | 全局 | **按目录区分**:配置档案归属于创建它时所在的项目目录 |
| 选择器 | 显示全部配置档案,最近使用的在前 | 先显示本目录的配置档案,其他目录的收纳在 `── Profiles from other directories…` 之后 |
| 会话恢复 | 记住绑定关系 | 相同,并且 pi-optchat 绑定的会话仍可恢复（读取旧版 `optchat.profile` 条目;所绑定的配置档案按需转换） |
| 默认值 | — | **子代理和压缩器默认使用 `zai-coding-cn/glm-5.3-flash`**（thinking 为 high / medium） |
| 全局默认 | 仅限单个配置档案 | `~/.infinite-chat/config.json` 为每个新配置档案提供初始值,并在配置档案加载时补齐缺失项 |
| 套接字 | 配置档案目录内的 `lock.sock`,在其他位置直接失败 | **候选回退**:配置档案目录 → `<dataHome>/sock/` → 临时目录,拒绝 Unix 域套接字的 ohos 沙箱也能正常加锁和连接 |
| 标题栏 | `π work · 2 agents` | `π work · glm-5.3-flash (sub high / cmp medium) · 2 agents` |
| 底部状态栏 | `OptChat: work · 12 messages …` | `InfiniteChat: work · sub zai-coding-cn/glm-5.3-flash(high) · cmp zai-coding-cn/glm-5.3-flash(medium) · 12 messages …` |
| 命令 | `/optchat` | `/infinite-chat`（标志:`--infinite-chat-profile`、`--infinite-chat-connect`、`--infinite-chat-agent`;旧的 `--optchat-*` 写法仍然有效） |
| 记忆工具 | `zoom` 会加载整段文本 | **`ask(question, id, n)`**:由配置档案的压缩器模型读取该行内容（或某个子代理的完整运行记录）,只返回答案,海量历史内容不会进入上下文;`zoom` 和 `ask` 的结果还会标注在该行写入之后发生变更的文件 |

其余部分——OptChat 的配方数值 (recipe numbers)、摘要树、zoom/date、子代理、导入、连接的窗口、用量与活动检查器——均与上游一致。完整介绍见[上游 README](https://github.com/jonaslsaa/pi-optchat#readme)。

## 安装

先移除 pi-optchat 再安装本扩展:两个扩展会争抢相同的工具与钩子。安装前,将 `/path/to/infinite-chat` 替换为本仓库的实际路径。

```sh
pi remove npm:pi-optchat
pi install /path/to/infinite-chat
```

重启 Pi,运行 `/infinite-chat`,选择 **+ Create profile**（创建配置档案）——配置档案会创建在你启动 Pi 时所在的目录。

创建配置档案时会运行一个简短的向导:向导展示该配置档案将要使用的**子代理模型**和**压缩器模型**——若 `~/.infinite-chat/config.json` 存在则以其预填,否则使用内置默认值——并允许你在创建前逐项修改。所选结果会固化到新配置档案自己的 `config.json` 中。如果全局 `config.json` 尚不存在,你的选择也会写入其中,下一个配置档案便从这里起步;此后,全局配置只在你手动编辑时才会变化。

同一选择器中的 **Rename profile**（重命名配置档案）可将配置档案改为新名称（原地重命名目录——模型、记忆和历史保持不变）。重命名当前会话已打开的配置档案同样可行:它会释放锁、执行重命名,并以新名称重新打开该配置档案。被另一个 Pi 实例占用的配置档案会拒绝重命名;请先在那个窗口切换到其他配置档案。仍绑定旧名称的会话继续可用:恢复时通过 `~/.infinite-chat/renames.json` 将旧名称映射,并重新绑定到新名称。

### 从 pi-optchat 迁移

不会自动复制任何内容。旧配置档案保留在 `~/.optchat`,直到你手动转换:配置档案选择器 (`/infinite-chat profile`) 会显示一个 `── Old profiles from ~/.optchat (select to convert)…` 分区,列出尚未转换的配置档案。选中一项会将其复制到 `~/.infinite-chat`（原件保持不动;失效的锁套接字和锁文件不会被复制）并立即打开。同一菜单中还有一次性的「Convert all」（全部转换）入口。

恢复 pi-optchat 绑定的会话无需任何手动选择即可工作:恢复时按需转换所绑定的配置档案。转换后的配置档案没有记录所属目录,因此会出现在每个目录的选择器中,直到你打开其中一个——一旦打开,它就归属于该目录。设置 `INFINITE_CHAT_NO_LEGACY=1` 可完全隐藏旧配置档案。

## 目录作用域

- `~/.infinite-chat/profiles/<name>/profile.json` 记录 `cwd`（创建目录）、`createdAt` 和 `lastUsedAt`。
- 选择器显示当前目录的配置档案（以及尚未归属的配置档案）,最近使用的在前,**按 Enter 会选中最近使用的一个**。
- 切换配置档案会保留对话:旧配置档案被释放,新配置档案打开,会话在原地重新绑定——不会清空任何内容。一个例外:当会话仍绑定着一个正在被另一个窗口运行的配置档案时（在「Open a different profile instead」之后）,该会话属于那个窗口,此时切换会把对话记录分叉为一个绑定到所选配置档案的新会话——本窗口保留历史,另一个窗口的会话不受影响。
- 其他目录的配置档案一次展开即可看到;每一行都会显示其所属目录。
- 无论从哪个目录恢复,恢复会话总会还原其绑定的配置档案——目录作用域只影响选择,从不影响恢复。

## 恢复会话

- Pi 按目录存储会话,该目录下所有配置档案共享一个会话池。`pi -r` 恢复池中最近写入的会话——只要某个窗口仍打开并在对话,它的会话就总是最新的,因此直接执行 `pi -r` 会恢复到那里,而不是你上次使用的配置档案。
- 绑定关系仍然决定配置档案:无论 `pi -r` 选中哪个会话,打开的都是它所属的配置档案。如果该配置档案正被占用（其窗口仍然打开）,对话框会先提供 **Open a different profile instead**（改用其他配置档案）选项——该选项不会改动被恢复的会话;随后可用 `/infinite-chat profile` 把对话分叉到你选中的配置档案,因为当前会话仍绑定着被占用的那个。
- 在多配置档案目录中恢复某个特定对话时,使用 `/infinite-chat sessions`（也位于 `/infinite-chat` 菜单中）:它按最新在前列出该目录的会话,并标注每个会话绑定的配置档案、消息数、首条消息预览,以及该配置档案处于占用、旧版还是缺失状态。选中一项即切换到该会话并打开其绑定的配置档案（重命名会被自动跟随;被占用的配置档案会进入占用对话框）。`/resume` 同样可用,但没有这些标注。`pi --infinite-chat-profile <name>` 会启动一个绑定到指定配置档案的全新会话。

## 全局默认配置

`~/.infinite-chat/config.json` 与配置档案自身的 `config.json` 使用相同的结构:

```json
{
  "compactor": { "provider": "zai-coding-cn", "model": "glm-5.3-flash", "thinking": "medium" },
  "subagent": { "provider": "zai-coding-cn", "model": "glm-5.3-flash", "thinking": "high" },
  "subagentLevels": 2,
  "maxAgents": 8
}
```

- **创建**配置档案时,向导从这些值开始,并把最终选择固化到该配置档案的 `config.json`（而非代码内置默认值）。在此文件不存在时的首次创建,会依据向导中的选择生成这个文件。
- **加载**配置档案时,其自身 `config.json` 缺失的键先由这个文件补齐,再由内置默认值补齐。
- 无效的键会被丢弃并给出警告,绝不会导致致命错误。

## ohos 说明

ohos 应用沙箱可能把主目录映射到拒绝 Unix 域套接字的存储上,这曾导致 pi-optchat 的配置档案锁失效（`listen`/`bind` 失败）。InfiniteChat 通过一个有序的候选列表解析套接字路径,持有者与任何连接方计算出的都是同一份列表:

1. `$INFINITE_CHAT_SOCK_HOME` — 显式覆盖;在 ohos 上,把它指向一个路径短、沙箱内可写的目录。
2. `<profile>/lock.sock`（以及 `windows.sock`）— 路径能放进 `sun_path` 且文件系统允许套接字时的经典布局。
3. `<dataHome>/sock/infinite-chat-<hash>-<purpose>.sock` — 仍在数据主目录内,但路径更短。
4. `<tmpdir>/infinite-chat-<hash>-<purpose>.sock` — 最后的备选。

表示「此目录无法存放套接字」的绑定失败（权限不足、不支持套接字、路径过长）会尝试下一个候选;已被活跃持有者占用的套接字总是报告为「占用中」,绝不会静默地被顶替。如果主目录本身不可写,请将 `INFINITE_CHAT_HOME` 设置为一个可写的目录。

## 存储结构

```text
~/.infinite-chat/
├── config.json              # 全局默认值（可选）
├── renames.json             # 已重命名的配置档案:旧的会话绑定在新名称下恢复
├── sock/                    # 套接字回退目录
└── profiles/<name>/
    ├── profile.json         # cwd / createdAt / lastUsedAt（目录作用域）
    ├── config.json          # 此配置档案的模型与设置
    ├── AGENTS.md            # 此配置档案的指令
    ├── main/ tree/ view.json images/
    ├── active-memory.json memories/ imports/
    ├── runs/ usage.jsonl pending-*.json
    └── lock.sock            # 当配置档案目录可以存放套接字时
```

每个配置档案文件夹都是一个本地 Git 仓库,每轮对话结束后提交一次,与上游完全一致。删除配置档案所在的文件夹即可删除该配置档案。

## 开发

以下命令依次安装依赖、运行类型检查和离线测试:

```sh
npm install
npm run check   # tsc --noEmit
npm test        # 离线测试套件（332 个测试）
```

采用 MIT 许可证;衍生自 Jonas 的 pi-optchat（参见上游的 LICENSE 和 THIRD_PARTY_NOTICES）。
