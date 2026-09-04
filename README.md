# opencode-model-variants

Give your OpenCode **custom relay providers** the official treatment: reasoning
tiers, input capabilities and context windows from [models.dev](https://models.dev) —
with **zero per-model config**.

```text
Before                                   After
─────────────────────────────────────    ─────────────────────────────────────
dmx/kimi-k3        (no tiers)            dmx/kimi-k3        low/high/max
b/qwen3.8-flash    (no tiers)            b/qwen3.8-flash    low/medium/xhigh
dmx/gpt-5.6-terra  (text-only, ctx=0)    dmx/gpt-5.6-terra  image+pdf, ctx 254k
```

## The problem

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

## Install

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

## How it works

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

1. **Vendor entry** — `deepseek-v4-flash` uses DeepSeek's own entry, not what
   resellers advertise
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

## Configuration

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
        "excludeProviders": ["my-provider"], // skip these provider ids
        "vendorMap": { "yi": "01-ai" }// extend family -> vendor mapping
      }
    ]
  ]
}
```

`OPENCODE_MODEL_VARIANTS_DATA` env var overrides the snapshot path.

## Known limitations

- **Race with discovery plugins.** Models injected asynchronously by plugins
  like `opencode-models-discovery` may not be visible to this plugin's config
  hook on their very first session (slow upstream). The discovery cache makes
  subsequent startups synchronous, which self-heals the issue.
- **Core merge behavior.** Pruning core-computed tiers relies on OpenCode's
  `disabled: true` variant filtering. Guarded by tests against current
  OpenCode releases; file an issue if a core upgrade changes behavior.

## Development

```bash
npm install
npm test                 # 31 unit tests
npm run update           # refresh the bundled snapshot from models.dev
npm run update:check     # CI-friendly staleness check (exit 1 when stale)
```

## License

[MIT](./LICENSE)
