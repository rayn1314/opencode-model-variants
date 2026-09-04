// core.js — pure, shared logic for both the plugin (runtime) and the
// update script (build time). No I/O, no OpenCode imports: everything here
// is trivially unit-testable.

/**
 * Normalize a models.dev model ID into a base key:
 *   "z-ai/glm-5.3:thinking"  -> "glm-5.3"
 *   "deepseek/deepseek-v4-flash" -> "deepseek-v4-flash"
 *   "@cf/moonshotai/kimi-k2.7-code" -> "kimi-k2.7-code"
 */
export function normalizeBaseKey(id) {
  let k = String(id ?? "").toLowerCase().trim()
  k = k.split("/").pop() || k
  k = k.replace(/:.*$/, "")
  return k
}

/**
 * Relay vendors love composite IDs ("deepseek-v4-flash-free"). Strip known
 * suffixes one at a time to hit the canonical base key.
 */
export const RELAY_SUFFIXES = [
  "-free",
  "-count",
  "-pro",
  "-flash",
  "-fast",
  "-highspeed",
  "-latest",
  "-exp",
  "-turbo",
]

export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Model family prefix -> models.dev provider key of the ORIGINAL vendor.
 * Extensible via config (see DEFAULT_OPTIONS in index.js).
 */
export const VENDOR_PROVIDER = {
  deepseek: "deepseek",
  kimi: "moonshotai",
  glm: "zhipuai",
  qwen: "alibaba",
  minimax: "minimax",
  gpt: "openai",
  gemini: "google",
  grok: "xai",
  claude: "anthropic",
}

export function vendorOf(baseKey, vendorMap = VENDOR_PROVIDER) {
  for (const [prefix, vendor] of Object.entries(vendorMap)) {
    if (baseKey.startsWith(prefix)) return vendor
  }
  return null
}

export function sortEfforts(efforts, order = EFFORT_ORDER) {
  return [...efforts].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/**
 * Effort values OpenCode core may compute on its own for a model. When we
 * inject variants we explicitly mark everything OUTSIDE the official set as
 * disabled, so core's mergeDeep union gets pruned (core filters
 * `disabled: true` variants after merging).
 */
export const CORE_POSSIBLE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]

export const ANTHROPIC_NPMS = ["@ai-sdk/anthropic", "@ai-sdk/google-vertex/anthropic"]

export const NON_REASONING_ID =
  /embed|tts|stt|whisper|dall|flux|sdxl|stable-diff|image|video|audio|rerank|moderation|reward|classif|ocr/i

/**
 * Build the variant record for a model with the given official efforts.
 * Core-computable efforts that the official data does NOT list are injected
 * as `disabled: true` so core's merge prunes them.
 */
export function buildEffortVariants(efforts) {
  const out = {}
  const known = new Set(efforts)
  for (const e of efforts) out[e] = { reasoningEffort: e }
  for (const e of CORE_POSSIBLE_EFFORTS) {
    if (!known.has(e)) out[e] = { reasoningEffort: e, disabled: true }
  }
  return out
}

/**
 * Data-file lookup with relay-suffix stripping.
 * @param {Record<string, any>|undefined} models data-file models map
 */
export function lookupModel(models, modelID) {
  if (!models) return null
  const base = normalizeBaseKey(modelID)
  if (models[base]) return models[base]
  for (const suffix of RELAY_SUFFIXES) {
    if (base.endsWith(suffix)) {
      const hit = models[base.slice(0, -suffix.length)]
      if (hit) return hit
    }
  }
  return null
}

/**
 * Family-heuristic fallback for models absent from the data file.
 * Returns an efforts array, or null when the family is unknown.
 */
export function fallbackEfforts(modelID) {
  const id = String(modelID ?? "").toLowerCase()
  const family =
    /kimi|moonshot|qwen|glm|minimax|deepseek/.test(id) ||
    /gpt|g5\./.test(id) ||
    /\bgemini\b|\bgrok\b|\bclaude\b|\bo[13]\b/.test(id)
  if (!family) return null
  return id.includes("deepseek-v4") ? ["low", "medium", "high", "max"] : ["low", "medium", "high"]
}

// ============ build-time aggregation (update script) ============

/**
 * Aggregate raw models.dev data into the data-file shape.
 * Priority for tiers: vendor entry > mode (most common set) > smallest set.
 * Toggle-only vendors are respected (no fabricated effort ladders).
 * Limits: vendor entry first, else the largest advertised context.
 *
 * @param {object} raw parsed https://models.opencode.ai/api.json
 * @param {object} [opts] { vendorMap }
 * @returns {{ source: string, count: number, providers: string[], models: Record<string, ModelRecord> }}
 */
export function aggregate(raw, opts = {}) {
  const vendorMap = opts.vendorMap ?? VENDOR_PROVIDER
  const source = opts.source ?? ""
  const entries = new Map()

  const ensure = (key) => {
    if (!entries.has(key))
      entries.set(key, {
        vendorEfforts: null,
        vendorToggle: false,
        vendorSeen: false,
        all: [],
        caps: [],
        limits: [],
      })
    return entries.get(key)
  }

  for (const [providerID, provider] of Object.entries(raw)) {
    for (const [mid, m] of Object.entries(provider.models ?? {})) {
      const key = normalizeBaseKey(mid)
      if (!key) continue
      const e = ensure(key)

      // capability votes: every model participates (not just reasoning ones)
      const input = m.modalities?.input ?? []
      e.caps.push({
        provider: providerID,
        attachment: m.attachment === true,
        reasoning: m.reasoning === true,
        image: input.includes("image"),
        audio: input.includes("audio"),
        video: input.includes("video"),
        pdf: input.includes("pdf"),
      })

      // context window votes: any model with a real limit participates
      if (m.limit && m.limit.context > 0) {
        e.limits.push({
          provider: providerID,
          context: m.limit.context,
          output: m.limit.output || 0,
        })
      }

      // tier votes: reasoning models only
      if (m.reasoning !== true) continue
      const opts2 = m.reasoning_options ?? []
      const efforts = sortEfforts(
        opts2.flatMap((o) => (o.type === "effort" ? o.values ?? [] : [])),
        EFFORT_ORDER,
      )
      const toggle = opts2.some((o) => o.type === "toggle")
      if (!efforts.length && !toggle) continue
      e.all.push({ provider: providerID, efforts, toggle })

      const vendor = vendorOf(key, vendorMap)
      if (providerID === vendor) {
        e.vendorSeen = true
        if (toggle) e.vendorToggle = true
        if (!e.vendorEfforts || efforts.length > e.vendorEfforts.length) {
          e.vendorEfforts = efforts
        }
      }
    }
  }

  function mergeCaps(key, entry) {
    const vendor = vendorOf(key, vendorMap)
    const vendorCaps = vendor ? entry.caps.filter((c) => c.provider === vendor) : []
    const pool = vendorCaps.length > 0 ? vendorCaps : entry.caps
    const majority = (pick) => pool.filter(pick).length > pool.length / 2
    return {
      attachment: majority((c) => c.attachment),
      reasoning: majority((c) => c.reasoning),
      image: majority((c) => c.image),
      audio: majority((c) => c.audio),
      video: majority((c) => c.video),
      pdf: majority((c) => c.pdf),
    }
  }

  function mergeLimit(key, entry) {
    const vendor = vendorOf(key, vendorMap)
    const vendorLimits = vendor ? entry.limits.filter((l) => l.provider === vendor) : []
    if (vendorLimits.length > 0) {
      const best = vendorLimits.reduce((a, b) => (b.context > a.context ? b : a))
      return { context: best.context, output: best.output || 0 }
    }
    if (entry.limits.length > 0) {
      const best = entry.limits.reduce((a, b) => (b.context > a.context ? b : a))
      return { context: best.context, output: best.output || 0 }
    }
    return null
  }

  // tier selection
  const tiers = {}
  for (const [key, entry] of entries) {
    const hasToggle = entry.all.some((x) => x.toggle)

    if (entry.vendorEfforts && entry.vendorEfforts.length > 0) {
      tiers[key] = { efforts: entry.vendorEfforts, toggle: hasToggle }
      continue
    }
    // vendor exists but only supports a toggle (e.g. minimax-m3)
    if (entry.vendorSeen && entry.vendorToggle) {
      tiers[key] = { efforts: [], toggle: true }
      continue
    }

    const nonEmpty = entry.all.filter((x) => x.efforts.length > 0)
    if (nonEmpty.length === 0) {
      if (hasToggle) tiers[key] = { efforts: [], toggle: true }
      continue
    }
    // a lone vendor advertising efforts while everyone else is toggle-only:
    // treat as toggle-only so one outlier doesn't skew the result
    const toggleOnlyCount = entry.all.filter((x) => x.efforts.length === 0 && x.toggle).length
    if (toggleOnlyCount > nonEmpty.length && nonEmpty.length <= 1) {
      if (hasToggle) tiers[key] = { efforts: [], toggle: true }
      continue
    }

    const freq = new Map()
    for (const x of nonEmpty) {
      const sig = x.efforts.join(",")
      freq.set(sig, (freq.get(sig) || 0) + 1)
    }
    const maxFreq = Math.max(...freq.values())
    const candidates = [...freq.keys()].filter((k) => freq.get(k) === maxFreq)
    const chosen =
      candidates.length === 1
        ? candidates[0].split(",")
        : candidates.map((c) => c.split(",")).sort((a, b) => a.length - b.length)[0]
    tiers[key] = { efforts: chosen, toggle: hasToggle }
  }

  const models = {}
  const allKeys = new Set([...Object.keys(tiers), ...entries.keys()])
  for (const key of allKeys) {
    const rec = { ...(tiers[key] ?? {}) }
    const entry = entries.get(key)
    if (entry && entry.caps.length > 0) {
      const caps = mergeCaps(key, entry)
      rec.caps = {
        attachment: caps.attachment,
        reasoning: caps.reasoning,
        modalities: {
          input: ["text", ...["image", "audio", "video", "pdf"].filter((m) => caps[m])],
          output: ["text"],
        },
      }
      const limit = mergeLimit(key, entry)
      if (limit) rec.caps.limit = limit
    }
    models[key] = rec
  }

  return {
    source,
    count: Object.keys(models).length,
    providers: Object.keys(raw).sort(),
    models,
  }
}
