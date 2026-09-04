import { describe, it, expect } from "vitest"
import {
  normalizeBaseKey,
  lookupModel,
  buildEffortVariants,
  fallbackEfforts,
  aggregate,
  vendorOf,
  sortEfforts,
} from "../src/core.js"

describe("normalizeBaseKey", () => {
  it("strips provider prefixes and tag suffixes", () => {
    expect(normalizeBaseKey("z-ai/glm-5.3:thinking")).toBe("glm-5.3")
    expect(normalizeBaseKey("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash")
    expect(normalizeBaseKey("@cf/moonshotai/kimi-k2.7-code")).toBe("kimi-k2.7-code")
  })

  it("lowercases and trims", () => {
    expect(normalizeBaseKey("  Kimi-K3 \r\n")).toBe("kimi-k3")
  })

  it("handles bare ids and null-ish input", () => {
    expect(normalizeBaseKey("glm-5.3")).toBe("glm-5.3")
    expect(normalizeBaseKey(null)).toBe("")
    expect(normalizeBaseKey(undefined)).toBe("")
  })
})

describe("lookupModel", () => {
  const models = {
    "gpt-5.6-luna": { efforts: ["low", "high", "max"] },
    "glm-5.2": { efforts: ["high", "max"] },
  }

  it("exact-matches normalized keys", () => {
    expect(lookupModel(models, "gpt-5.6-luna")).toEqual({ efforts: ["low", "high", "max"] })
    expect(lookupModel(models, "openai/gpt-5.6-luna:thinking")).toEqual({ efforts: ["low", "high", "max"] })
  })

  it("strips relay suffixes before retrying", () => {
    expect(lookupModel(models, "glm-5.2-count")).toEqual({ efforts: ["high", "max"] })
  })

  it("returns null for unknown models and empty data", () => {
    expect(lookupModel(models, "qwen3.8-flash")).toBeNull()
    expect(lookupModel(undefined, "glm-5.2")).toBeNull()
    expect(lookupModel({}, "glm-5.2")).toBeNull()
  })

  it("does not false-match partial ids", () => {
    // "gpt-5.6-sol" must not inherit "gpt-5.6-luna" tiers
    expect(lookupModel(models, "gpt-5.6-sol")).toBeNull()
  })
})

describe("buildEffortVariants", () => {
  it("injects official efforts and disables core-computable extras", () => {
    const v = buildEffortVariants(["low", "high", "max"])
    expect(v.low).toEqual({ reasoningEffort: "low" })
    expect(v.high).toEqual({ reasoningEffort: "high" })
    expect(v.max).toEqual({ reasoningEffort: "max" })
    // core would compute medium for deepseek-v4 — marked disabled so core's
    // merge prunes it
    expect(v.medium).toEqual({ reasoningEffort: "medium", disabled: true })
    expect(v.xhigh).toEqual({ reasoningEffort: "xhigh", disabled: true })
  })

  it("keeps every official effort enabled", () => {
    const v = buildEffortVariants(["none", "low", "medium", "high", "xhigh", "max"])
    for (const e of ["none", "low", "medium", "high", "xhigh", "max"]) {
      expect(v[e].disabled).toBeUndefined()
    }
  })
})

describe("fallbackEfforts", () => {
  it("adds max for deepseek-v4", () => {
    expect(fallbackEfforts("deepseek-v4-flash")).toEqual(["low", "medium", "high", "max"])
  })
  it("gives 3 tiers to known families", () => {
    expect(fallbackEfforts("kimi-k9")).toEqual(["low", "medium", "high"])
    expect(fallbackEfforts("qwen-unknown")).toEqual(["low", "medium", "high"])
  })
  it("returns null for unknown families", () => {
    expect(fallbackEfforts("test")).toBeNull()
    expect(fallbackEfforts("some-random-name")).toBeNull()
  })
})

describe("sortEfforts", () => {
  it("orders by canonical effort ladder", () => {
    expect(sortEfforts(["max", "low", "none", "high"])).toEqual(["none", "low", "high", "max"])
  })
  it("puts unknown efforts last", () => {
    expect(sortEfforts(["weird", "low"])).toEqual(["low", "weird"])
  })
})

describe("vendorOf", () => {
  it("maps family prefixes to vendor providers", () => {
    expect(vendorOf("deepseek-v4-flash")).toBe("deepseek")
    expect(vendorOf("kimi-k3")).toBe("moonshotai")
    expect(vendorOf("glm-5.3")).toBe("zhipuai")
  })
  it("respects a custom vendor map", () => {
    expect(vendorOf("yi-lightning", { yi: "01-ai" })).toBe("01-ai")
    expect(vendorOf("glm-5.3", { yi: "01-ai" })).toBeNull()
  })
})

describe("aggregate", () => {
  const raw = {
    // official vendor
    deepseek: {
      models: {
        "deepseek-v4-flash": {
          reasoning: true,
          attachment: false,
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
          limit: { context: 1000000, output: 384000 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
    // resellers with divergent opinions
    "relay-a": {
      models: {
        "deepseek/deepseek-v4-flash": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] }],
          limit: { context: 500000, output: 100000 },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    },
    "relay-b": {
      models: {
        "deepseek-v4-flash": {
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
          limit: { context: 200000, output: 80000 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
    // vendor with only a toggle
    minimax: {
      models: {
        "MiniMax-M3": {
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
          limit: { context: 204800, output: 131072 },
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
    // non-reasoning model with a limit only
    openai: {
      models: {
        "gpt-image-1": {
          limit: { context: 0, output: 0 },
          modalities: { input: ["text", "image"], output: ["image"] },
        },
      },
    },
  }

  const snap = aggregate(raw, { source: "test://" })

  it("prefers the vendor entry for tiers (no union pollution)", () => {
    expect(snap.models["deepseek-v4-flash"].efforts).toEqual(["low", "high", "max"])
  })

  it("keeps the vendor limit, not the largest reseller one", () => {
    expect(snap.models["deepseek-v4-flash"].caps.limit).toEqual({ context: 1000000, output: 384000 })
  })

  it("aggregates capabilities by majority within the vendor pool", () => {
    const caps = snap.models["deepseek-v4-flash"].caps
    expect(caps.reasoning).toBe(true)
    expect(caps.modalities.input).toEqual(["text"]) // reseller image vote is outvoted
  })

  it("treats vendor toggle-only models as toggle-only", () => {
    expect(snap.models["minimax-m3"]).toMatchObject({ efforts: [], toggle: true })
  })

  it("includes non-reasoning models for caps/limit sync", () => {
    expect(snap.models["gpt-image-1"].caps).toBeDefined()
    expect(snap.models["gpt-image-1"].efforts).toBeUndefined()
  })

  it("uses mode fallback when no vendor entry exists", () => {
    const raw2 = {
      x: { models: { m1: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] } } },
      y: { models: { m1: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] } } },
      z: { models: { m1: { reasoning: true, reasoning_options: [{ type: "effort", values: ["max"] }] } } },
    }
    const snap2 = aggregate(raw2)
    expect(snap2.models["m1"].efforts).toEqual(["low", "high"])
  })

  it("ignores a lone outlier when everyone else is toggle-only", () => {
    const raw2 = {
      a: { models: { mm: { reasoning: true, reasoning_options: [{ type: "toggle" }] } } },
      b: { models: { mm: { reasoning: true, reasoning_options: [{ type: "toggle" }] } } },
      c: { models: { mm: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low"] }] } } },
    }
    expect(aggregate(raw2).models["mm"]).toMatchObject({ efforts: [], toggle: true })
  })

  it("falls back to the smallest set when the mode ties", () => {
    const raw2 = {
      a: { models: { mm: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] } } },
      b: { models: { mm: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] } } },
    }
    expect(aggregate(raw2).models["mm"].efforts).toEqual(["low", "high"])
  })

  it("lists all providers for the core-provider skip list", () => {
    expect(snap.providers).toContain("deepseek")
    expect(snap.providers).toContain("relay-a")
  })
})
