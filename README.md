# opencode-model-variants

[![CI](https://github.com/rayn1314/opencode-model-variants/actions/workflows/ci.yml/badge.svg)](https://github.com/rayn1314/opencode-model-variants/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**English** | [简体中文](#简体中文)

Give your OpenCode **custom relay providers** the official treatment: reasoning
tiers, input capabilities and context windows from [models.dev](https://models.dev) —
with **zero per-model config**.

```text
Before                                      After
────────────────────────────────────────    ─────────────────────────────────────
custom1/kimi-k3        (no tiers)           custom1/kimi-k3        low/high/max
custom2/qwen3.8-flash  (no tiers)           custom2/qwen3.8-flash  low/medium/xhigh
custom3/gpt-5.6-terra  (text-only, ctx=0)   custom3/gpt-5.6-terra  image+pdf, ctx 254k
```

## English

### The problem

OpenCode knows a lot about models listed on
[models.dev](https://models.dev) — reasoning effort tiers, input modalities,
context windows. But models served through **custom OpenAI-compatible /
Anthropic-compatible relays** (new-api, one-api, …) are invisible to that
catalog:

- Reasoning tiers come from hardcoded family rules in OpenCode core; relayed
  models (or models with unusual casing) fall through and get **no tiers**.
- Discovered relay models are hardcoded **text-only**, so image/PDF input
  gets rejected even when the underlying model supports it.
- Hand-written entries without a `limit` get `context: 0`, which makes
  OpenCode **skip overflow detection entirely** — auto-compaction never fires
  until the upstream API errors out.

This plugin bridges the gap using the same official data source OpenCode
itself relies on.

### Install

Add the plugin to your OpenCode config:

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-model-variants"]
}
```

That's it. The package ships with a prebuilt snapshot; restart OpenCode and
your custom models get official tiers, capabilities and context windows.

### How it works

```text
models.dev official data
   │  npm run update (or automatic background refresh)
   ▼
data/model-variants-data.json        ← shipped snapshot, idempotent updates
   │  read once at startup
   ▼
config hook: for every model on your custom providers
   ├── caps sync      modalities / attachment / reasoning — fill if absent
   ├── limit sync     context window — fill if absent
   └── variants       official effort tiers, with core-only tiers pruned
```

Selection priority for tiers and limits:

1. **Vendor entry** — `kimi-k3` on `custom1` uses Moonshot's own entry, not
   what resellers advertise
2. **Mode** — most common set across providers when there is no vendor entry
3. **Conservative** — smallest set on ties; toggle-only vendors stay
   toggle-only

Safety rules:

- Anything you explicitly wrote in `opencode.json` is **never overridden**
- Models on real models.dev providers (where core already has live data) are
  skipped
- Non-LLM ids (embedding, image, tts, …) are skipped
- Efforts the official data does not list are injected as `disabled: true`, so
  OpenCode's variant merge prunes them instead of showing bogus tiers

### Configuration

Pass options via the plugin tuple form:

```jsonc
{
  "plugin": [
    [
      "opencode-model-variants",
      {
        "enabled": true,              // set false to disable everything
        "dataFile": "/path/to.json",  // custom snapshot (default: bundled)
        "dataUrl": "https://models.opencode.ai/api.json",
        "refresh": true,              // background-refresh the local cache
        "refreshTtlHours": 24,
        "syncCaps": true,             // modalities / attachment / reasoning
        "syncLimit": true,            // context window
        "includeCoreProviders": false,// also touch official providers (rarely wanted)
        "excludeProviders": ["custom1"], // skip these provider ids
        "vendorMap": { "yi": "01-ai" }// extend family -> vendor mapping
      }
    ]
  ]
}
```

`OPENCODE_MODEL_VARIANTS_DATA` env var overrides the snapshot path.

### Known limitations

- **Race with discovery plugins.** Models injected asynchronously by plugins
  like `opencode-models-discovery` may not be visible to this plugin's config
  hook on their very first session (slow upstream). The discovery cache makes
  subsequent startups synchronous, which self-heals the issue.
- **Core merge behavior.** Pruning core-computed tiers relies on OpenCode's
  `disabled: true` variant filtering. Guarded by tests against current
  OpenCode releases; file an issue if a core upgrade changes behavior.

### Development

```bash
npm install
npm test                 # 32 unit tests
npm run update           # refresh the bundled snapshot from models.dev
npm run update:check     # CI-friendly staleness check (exit 1 when stale)
```

---

**[English](#opencode-model-variants) | 简体中文**

## 简体中文

### 问题背景

OpenCode 对 [models.dev](https://models.dev) 上收录的模型知根知底——推理档位、输入模态、上下文窗口一应俱全。但通过**自定义 OpenAI-compatible / Anthropic-compatible 中转**（new-api、one-api 等）提供的模型对这套目录是不可见的：

- 推理档位来自 OpenCode 核心里硬编码的家族规则，中转模型（或大小写不寻常的 ID）会漏出规则网，**拿不到任何档位**
- 自动发现的模型被硬编码为 **text-only**，即使底层模型支持图片/PDF 输入也会被拒
- 手写条目不写 `limit` 就得到 `context: 0`，这让 OpenCode **完全跳过溢出检测**——自动压缩直到上游 API 报错才触发

本插件用 OpenCode 自己依赖的同一个官方数据源补上这个缺口。

### 安装

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-model-variants"]
}
```

装完即可。npm 包自带预构建快照，重启 OpenCode 后自定义模型自动获得官方档位、能力与窗口。

### 工作原理

```text
models.dev 官方数据
   │  npm run update（后台自动刷新）
   ▼
data/model-variants-data.json        ← 随包快照，幂等更新
   │  启动时读取一次
   ▼
config 钩子：遍历自定义 provider 的每个模型
   ├── 能力同步   modalities / attachment / reasoning —— 缺了才补
   ├── 窗口同步   上下文窗口 —— 缺了才补
   └── 档位注入   官方 effort 档位，核心多算的会被剪掉
```

档位与窗口的选择优先级：

1. **原厂条目** —— `custom1` 上的 `kimi-k3` 用 Moonshot 自家的数据，不采信中转商
2. **众数** —— 无原厂条目时取各供应商中出现最多的集合
3. **保守** —— 平票取最小集；纯开关模型（toggle-only）保持开关式

安全规则：

- 你在 `opencode.json` 里显式写过的字段**永不覆盖**
- models.dev 官方 provider（核心已有实时数据）跳过
- 非 LLM 的 ID（embedding、图像、tts 等）跳过
- 官方数据没列的档位以 `disabled: true` 注入，OpenCode 合并变体时会剪掉，不会显示虚晃的档位

### 配置

用插件元组形式传选项：

```jsonc
{
  "plugin": [
    [
      "opencode-model-variants",
      {
        "enabled": true,              // false 关闭全部行为
        "dataFile": "/path/to.json",  // 自定义快照（默认随包）
        "dataUrl": "https://models.opencode.ai/api.json",
        "refresh": true,              // 后台刷新本地缓存
        "refreshTtlHours": 24,
        "syncCaps": true,             // modalities / attachment / reasoning
        "syncLimit": true,            // 上下文窗口
        "includeCoreProviders": false,// 也处理官方 provider（一般不需要）
        "excludeProviders": ["custom1"], // 跳过这些 provider
        "vendorMap": { "yi": "01-ai" }// 扩展 家族→原厂 映射
      }
    ]
  ]
}
```

环境变量 `OPENCODE_MODEL_VARIANTS_DATA` 可覆盖快照路径。

### 已知限制

- **与 discovery 插件的竞态**。`opencode-models-discovery` 之类插件异步注入的模型，在首次会话（上游较慢时）可能对本插件的 config 钩子不可见。discovery 缓存会让后续启动变成同步，问题自愈。
- **核心合并行为依赖**。剪掉核心多算档位依赖 OpenCode 的 `disabled: true` 变体过滤机制，已针对当前 OpenCode 版本用测试护栏；若核心升级改变了行为请提 issue。

### 开发

```bash
npm install
npm test                 # 32 个单元测试
npm run update           # 从 models.dev 刷新随包快照
npm run update:check     # CI 用的过期检查（过期退出码 1）
```

## 许可

[MIT](./LICENSE)
