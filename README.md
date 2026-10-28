# InfiniteChat

A Pi extension that gives you one endless chat per profile, remembered through a summary tree instead of compaction — rebuilt from [pi-optchat](https://github.com/jonaslsaa/pi-optchat) with per-directory profiles, session binding, and first-class ohos support.

## What it changes from pi-optchat

| | pi-optchat | InfiniteChat |
| --- | --- | --- |
| Data home | `~/.optchat` | `~/.infinite-chat` (`INFINITE_CHAT_HOME` overrides; the old `OPTCHAT_HOME` spelling still works) |
| Profile scope | global | **per directory**: a profile belongs to the project directory it was created in |
| Picker | all profiles, last used first | this directory's profiles first, others behind `── Profiles from other directories…` |
| Session resume | remembers the binding | same, plus sessions bound by pi-optchat still resume (legacy `optchat.profile` entries are read) |
| Defaults | — | **subagents and compactor default to `zai-coding-cn/glm-5.3-flash`** (thinking: high / medium) |
| Global defaults | per profile only | `~/.infinite-chat/config.json` seeds every new profile and fills gaps when a profile loads |
| Sockets | `lock.sock` inside the profile, fail hard elsewhere | **candidate fallback**: profile dir → `<dataHome>/sock/` → temp dir, so ohos sandboxes that refuse unix sockets still lock and connect |
| Title | `π work · 2 agents` | `π work · glm-5.3-flash (sub high / cmp medium) · 2 agents` |
| Footer | `OptChat: work · 12 messages …` | `InfiniteChat: work · sub zai-coding-cn/glm-5.3-flash(high) · cmp zai-coding-cn/glm-5.3-flash(medium) · 12 messages …` |
| Command | `/optchat` | `/infinite-chat` (flags: `--infinite-chat-profile`, `--infinite-chat-connect`, `--infinite-chat-agent`; the `--optchat-*` spellings still work) |

Everything else — the OptChat recipe numbers, summary tree, zoom/date, subagents, imports, connected windows, usage and activity inspectors — works as in upstream. See the [upstream README](https://github.com/jonaslsaa/pi-optchat#readme) for the full tour.

## Install

```sh
pi remove npm:pi-optchat        # do this first: both extensions would fight over the same tools and hooks
pi install /path/to/infinite-chat
```

Restart Pi, run `/infinite-chat`, and choose **+ Create profile** — the profile is created for the directory you started Pi in.

### Coming from pi-optchat

On first run InfiniteChat copies `~/.optchat` into `~/.infinite-chat` (the original is kept untouched; stale lock sockets are not copied). Copied profiles have no recorded directory, so they appear in every directory's picker until you open one — opening it claims it for that directory. Set `INFINITE_CHAT_NO_MIGRATE=1` to skip the copy.

## Directory scoping

- `~/.infinite-chat/profiles/<name>/profile.json` records `cwd` (creation directory), `createdAt` and `lastUsedAt`.
- The picker shows profiles of the current directory (plus not-yet-claimed ones), most recently used first, and **Enter picks the last used one**.
- Other directories' profiles are one expansion away; each row shows its directory.
- Resuming a session always restores its bound profile, whatever directory you resume from — the scope only affects picking, never resuming.

## Global default config

`~/.infinite-chat/config.json` uses the same shape as a profile's own `config.json`:

```json
{
  "compactor": { "provider": "zai-coding-cn", "model": "glm-5.3-flash", "thinking": "medium" },
  "subagent": { "provider": "zai-coding-cn", "model": "glm-5.3-flash", "thinking": "high" },
  "subagentLevels": 2,
  "maxAgents": 8
}
```

- **Creating** a profile bakes these values into its `config.json` (instead of the code defaults).
- **Loading** a profile fills any key its own `config.json` leaves out from this file, then the built-in defaults.
- Invalid keys are dropped with a warning, never fatal.

## ohos notes

ohos app sandboxes may map the home directory onto storage that rejects unix domain sockets, which broke pi-optchat's profile lock (`listen`/`bind` failures). InfiniteChat resolves the socket path through an ordered candidate list, and both the owner and any connector compute the same list:

1. `$INFINITE_CHAT_SOCK_HOME` — explicit override; on ohos point this at a short, sandbox-writable directory.
2. `<profile>/lock.sock` (and `windows.sock`) — the classic layout when the path fits `sun_path` and the filesystem allows sockets.
3. `<dataHome>/sock/infinite-chat-<hash>-<purpose>.sock` — still inside your data home, but short.
4. `<tmpdir>/infinite-chat-<hash>-<purpose>.sock` — last resort.

A bind failure that means "this directory cannot hold a socket" (permissions, no socket support, path too long) tries the next candidate; a socket already held by a live owner is always reported as busy, never silently shadowed. If the home directory itself is not writable, set `INFINITE_CHAT_HOME` to one that is.

## Storage

```
~/.infinite-chat/
├── config.json              # global defaults (optional)
├── sock/                    # socket fallback directory
└── profiles/<name>/
    ├── profile.json         # cwd / createdAt / lastUsedAt (directory scoping)
    ├── config.json          # this profile's models and settings
    ├── AGENTS.md            # this profile's instructions
    ├── main/ tree/ view.json images/
    ├── active-memory.json memories/ imports/
    ├── runs/ usage.jsonl pending-*.json
    └── lock.sock            # when the profile dir can hold it
```

Each profile folder is a local Git repository, committed after each turn, exactly as upstream. Delete a profile by deleting its folder.

## Development

```sh
npm install
npm run check   # tsc --noEmit
npm test        # offline test suite (332 tests)
```

Licensed MIT; derived from pi-optchat by Jonas (see LICENSE and THIRD_PARTY_NOTICES of upstream).
