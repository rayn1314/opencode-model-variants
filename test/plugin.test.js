import { describe, it, expect } from "vitest"
import plugin from "../src/index.js"

function makeConfigHook(options) {
  const hook = plugin(undefined, options).config
  return (cfg) => hook(cfg)
}

describe("plugin config hook", () => {
  it("injects data-file tiers, caps and limit for bare custom-provider entries", () => {
    const cfg = {
      provider: {
        r4: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            // bare hand-written entry, present in the bundled snapshot
            "deepseek-v4-flash": { name: "deepseek" },
            // known reasoning family but absent from the data file
            // -> heuristic fallback
            "qwen-totally-unknown": { name: "?" },
            // not a reasoning family at all -> untouched
            test: { name: "test" },
          },
        },
      },
    }
    makeConfigHook()(cfg)

    const ds = cfg.provider.r4.models["deepseek-v4-flash"]
    expect(ds.variants.low).toEqual({ reasoningEffort: "low" })
    expect(ds.variants.medium).toEqual({ reasoningEffort: "medium", disabled: true })
    expect(ds.variants.max).toEqual({ reasoningEffort: "max" })
    expect(ds.reasoning).toBe(true)
    expect(ds.limit).toEqual({ context: 1000000, output: 384000 })

    const unknown = cfg.provider.r4.models["qwen-totally-unknown"]
    expect(unknown.variants).toEqual({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh", disabled: true },
      max: { reasoningEffort: "max", disabled: true },
    })

    // "test" is not a reasoning family and absent from the data file
    expect(cfg.provider.r4.models.test.variants).toBeUndefined()
    expect(cfg.provider.r4.models.test.limit).toBeUndefined()
  })

  it("never overrides explicit user config", () => {
    const cfg = {
      provider: {
        mine: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            "deepseek-v4-flash": {
              name: "mine",
              limit: { context: 300000, output: 131072 },
              reasoning: false,
              attachment: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              variants: { high: { reasoningEffort: "high" } },
            },
          },
        },
      },
    }
    makeConfigHook()(cfg)
    const m = cfg.provider.mine.models["deepseek-v4-flash"]
    // explicit limit/reasoning/attachment/modalities untouched
    expect(m.limit).toEqual({ context: 300000, output: 131072 })
    expect(m.reasoning).toBe(false)
    expect(m.attachment).toBe(true)
    expect(m.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    // explicit variants kept as-is
    expect(m.variants).toEqual({ high: { reasoningEffort: "high" } })
  })

  it("skips official models.dev providers by default", () => {
    const cfg = {
      provider: {
        deepseek: {
          npm: "@ai-sdk/openai-compatible",
          models: { "deepseek-v4-flash": { name: "official" } },
        },
      },
    }
    makeConfigHook()(cfg)
    const m = cfg.provider.deepseek.models["deepseek-v4-flash"]
    expect(m.variants).toBeUndefined()
    expect(m.limit).toBeUndefined()
    expect(m.reasoning).toBeUndefined()
  })

  it("syncs caps for relay models the discovery plugin marked text-only", () => {
    const cfg = {
      provider: {
        relay: {
          npm: "@ai-sdk/openai-compatible",
          models: {
            // discovery writes this synthetic default for discovered models
            "gpt-5.6-luna": {
              name: "gpt-5.6-luna",
              modalities: { input: ["text"], output: ["text"] },
            },
          },
        },
      },
    }
    makeConfigHook()(cfg)
    const m = cfg.provider.relay.models["gpt-5.6-luna"]
    // official data says image+pdf input — synthetic text-only is overridden
    expect(m.modalities.input).toContain("image")
    expect(m.modalities.input).toContain("pdf")
    expect(m.reasoning).toBe(true)
  })

  it("honors enabled: false", () => {
    const cfg = {
      provider: {
        r4: {
          npm: "@ai-sdk/openai-compatible",
          models: { "deepseek-v4-flash": { name: "x" } },
        },
      },
    }
    makeConfigHook({ enabled: false })(cfg)
    const m = cfg.provider.r4.models["deepseek-v4-flash"]
    expect(m.variants).toBeUndefined()
    expect(m.limit).toBeUndefined()
  })

  it("honors excludeProviders", () => {
    const cfg = {
      provider: {
        r4: {
          npm: "@ai-sdk/openai-compatible",
          models: { "deepseek-v4-flash": { name: "x" } },
        },
        other: {
          npm: "@ai-sdk/openai-compatible",
          models: { "deepseek-v4-flash": { name: "y" } },
        },
      },
    }
    makeConfigHook({ excludeProviders: ["r4"] })(cfg)
    expect(cfg.provider.r4.models["deepseek-v4-flash"].variants).toBeUndefined()
    // other providers still processed
    expect(cfg.provider.other.models["deepseek-v4-flash"].variants).toBeDefined()
  })

  it("survives an empty provider config", () => {
    expect(() => makeConfigHook()({})).not.toThrow()
    expect(() => makeConfigHook()({ provider: {} })).not.toThrow()
  })
})
