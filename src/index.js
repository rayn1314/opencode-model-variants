// index.js — OpenCode plugin entry.
//
// Loads a models.dev snapshot (bundled, cached, or user-provided), then at
// config-hook time gives custom relay providers what OpenCode core cannot
// know:
//
//   1. reasoning variants — official effort tiers from models.dev
//   2. capabilities       — modalities / attachment / reasoning
//   3. context window     — so auto-compaction actually works
//      (core skips overflow detection when limit.context === 0)
//
// Explicit user config always wins: fields the user wrote are never touched.
// Providers listed in the snapshot (i.e. real models.dev providers) are
// skipped — core already has live data for those.
//
// Data freshness: the bundled snapshot works offline. When `refresh` is on
// (default), the plugin kicks off a background fetch on startup and caches
// the result in the XDG data dir; the next startup picks it up. The config
// hook itself never blocks on the network.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { homedir, tmpdir } from "node:os"
import {
  ANTHROPIC_NPMS,
  NON_REASONING_ID,
  buildEffortVariants,
  fallbackEfforts,
  lookupModel,
  aggregate,
} from "./core.js"

function fileURLToDir(url) {
  return decodeURIComponent(new URL(".", url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
}

// package root = parent of src/, where data/ lives
const PLUGIN_DIR = path.resolve(fileURLToDir(import.meta.url), "..")
const BUNDLED_DATA = path.join(PLUGIN_DIR, "data", "model-variants-data.json")

const DEFAULT_OPTIONS = {
  /** master switch */
  enabled: true,
  /** absolute path to a custom snapshot */
  dataFile: undefined,
  /** models.dev source (or a mirror) */
  dataUrl: "https://models.opencode.ai/api.json",
  /** background-refresh the local cache on startup */
  refresh: true,
  /** cache considered fresh for this many hours */
  refreshTtlHours: 24,
  /** family-prefix -> models.dev vendor provider mappings (extensible) */
  vendorMap: {},
  /** sync official modalities/attachment/reasoning onto custom models */
  syncCaps: true,
  /** fill limit.context/output when a model has none (auto-compaction) */
  syncLimit: true,
  /** provider ids to never touch */
  excludeProviders: [],
  /** also process official models.dev providers (rarely wanted) */
  includeCoreProviders: false,
}

function parseOptions(options) {
  return { ...DEFAULT_OPTIONS, ...(options ?? {}) }
}

// ---- data resolution -------------------------------------------------

function cacheDir() {
  // XDG-ish cache, portable across platforms
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "opencode-model-variants")
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || tmpdir(), "opencode-model-variants")
  return path.join(homedir(), ".cache", "opencode-model-variants")
}

function cacheFile() {
  return path.join(cacheDir(), "model-variants-data.json")
}

function parseJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/**
 * Snapshot search order (first hit wins):
 *   1. user-provided dataFile / OPENCODE_MODEL_VARIANTS_DATA env
 *   2. local cache (refreshed in the background when stale)
 *   3. bundled snapshot shipped with the package
 */
function resolveData(options) {
  const explicit = options.dataFile ?? process.env.OPENCODE_MODEL_VARIANTS_DATA
  if (explicit && existsSync(explicit)) return { data: parseJsonSafe(explicit), file: explicit, source: "explicit" }

  const cached = cacheFile()
  if (existsSync(cached)) {
    const ageMs = Date.now() - statSync(cached).mtimeMs
    const fresh = ageMs < options.refreshTtlHours * 3600 * 1000
    const cachedData = parseJsonSafe(cached)
    if (cachedData?.models) return { data: cachedData, file: cached, source: "cache", fresh }
  }

  if (existsSync(BUNDLED_DATA)) {
    const bundled = parseJsonSafe(BUNDLED_DATA)
    if (bundled?.models) return { data: bundled, file: BUNDLED_DATA, source: "bundled", fresh: false }
  }
  return { data: null, file: null, source: "none" }
}

/**
 * Background refresh: fetch models.dev, aggregate, write to the local cache.
 * Never throws into the caller's startup path; failures are logged only.
 */
function refreshInBackground(options, vendorMap) {
  const url = options.dataUrl
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  fetch(url, { headers: { "user-agent": "opencode-model-variants" }, signal: controller.signal })
    .then((res) => {
      clearTimeout(timeout)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then((raw) => {
      const snapshot = aggregate(raw, { source: url, vendorMap })
      mkdirSync(cacheDir(), { recursive: true })
      writeFileSync(cacheFile(), JSON.stringify(snapshot, null, 2) + "\n", "utf8")
      console.log(`[opencode-model-variants] cache refreshed: ${snapshot.count} models from ${url}`)
    })
    .catch((err) => {
      clearTimeout(timeout)
      console.log(`[opencode-model-variants] background refresh skipped: ${err.message}`)
    })
}

// ---- config-hook helpers ---------------------------------------------

const DISCOVERY_DEFAULT_MODALITIES = JSON.stringify({ input: ["text"], output: ["text"] })

function hasExplicitModalities(model) {
  const m = model.modalities
  if (!m || !Array.isArray(m.input) || m.input.length === 0) return false
  const shape = JSON.stringify({ input: m.input, output: m.output })
  return shape !== DISCOVERY_DEFAULT_MODALITIES
}

/**
 * OpenCode's own variants() only fires for reasoning:true models whose family
 * matches its hardcoded rules. For those, core produces a good ladder and we
 * must not override it. (Data-file hits take priority over this check — see
 * config hook below.)
 */
function coreHandles(id, npm, model) {
  if (model.reasoning !== true) return false
  const lower = id.toLowerCase()
  const isAnthropic = ANTHROPIC_NPMS.includes(npm ?? "")
  if (/kimi|moonshot/.test(lower) && isAnthropic) return true
  if (/glm-5\.2|glm-5-2|glm-5p2/.test(lower)) return true
  if (/minimax-m3/.test(lower)) return true
  if (/deepseek-v4/.test(lower)) return true
  if (/gpt|g5\./.test(lower)) return true
  if (/\bgrok\b/.test(lower)) return true
  if (/\bgemini\b/.test(lower)) return true
  if (/\bclaude\b/.test(lower)) return true
  if (/\bo[13]\b|\bo\d+-mini\b/.test(lower)) return true
  return false
}

function thinkingBudgetLadder() {
  return {
    high: { thinking: { type: "enabled", budgetTokens: 16000 } },
    max: { thinking: { type: "enabled", budgetTokens: 31999 } },
  }
}

function toggleLadder() {
  return {
    none: { thinking: { type: "disabled" } },
    thinking: { thinking: { type: "adaptive" } },
  }
}

// ---- plugin -----------------------------------------------------------

// OpenCode calls plugin factories as (input, options): `input` is the
// PluginInput (client/project/...), `options` is the tuple-form config from
// `"plugin": [["pkg", { ... }]]`.
export default function ModelVariantsPlugin(input, options) {
  const opts = parseOptions(options)
  const resolved = resolveData(opts)
  const DATA = resolved.data
  const vendorMap = { ...opts.vendorMap }

  if (opts.enabled && opts.refresh && resolved.source !== "explicit") {
    const needsRefresh = !resolved.file || resolved.source === "bundled" || resolved.fresh === false
    if (needsRefresh) refreshInBackground(opts, vendorMap)
  }

  return {
    config: (cfg) => {
      if (!opts.enabled || !DATA?.models) return
      const coreProviderSet = new Set(DATA.providers ?? [])
      const excluded = new Set(opts.excludeProviders ?? [])

      for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
        if (excluded.has(providerID)) continue
        const isCustomProvider = opts.includeCoreProviders || !coreProviderSet.has(providerID)
        if (!isCustomProvider) continue
        const npm = provider.npm

        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          if (!model) continue

          // ---- capability sync ----
          if (opts.syncCaps || opts.syncLimit) {
            const capsInfo = lookupModel(DATA.models, model.api?.id ?? modelID)
            if (capsInfo?.caps) {
              if (opts.syncCaps) {
                if (!hasExplicitModalities(model)) model.modalities = structuredClone(capsInfo.caps.modalities)
                if (model.attachment === undefined) model.attachment = capsInfo.caps.attachment
                if (model.reasoning === undefined) model.reasoning = capsInfo.caps.reasoning
              }
              if (opts.syncLimit && model.limit === undefined && capsInfo.caps.limit) {
                model.limit = structuredClone(capsInfo.caps.limit)
              }
            }
          }

          // ---- variants injection ----
          if (model.variants && Object.keys(model.variants).length > 0) continue
          const id = model.api?.id ?? modelID
          if (NON_REASONING_ID.test(id)) continue

          // data first: official tiers beat core's own computation
          const info = lookupModel(DATA.models, id)
          if (info) {
            if (info.efforts?.length > 0) {
              model.variants = ANTHROPIC_NPMS.includes(npm ?? "")
                ? thinkingBudgetLadder()
                : buildEffortVariants(info.efforts)
            } else if (info.toggle) {
              model.variants = toggleLadder()
            }
            continue
          }

          // fallback: family heuristic for unknown models
          if (coreHandles(id, npm, model)) continue
          const fb = fallbackEfforts(id)
          if (!fb) continue
          model.variants = ANTHROPIC_NPMS.includes(npm ?? "")
            ? thinkingBudgetLadder()
            : buildEffortVariants(fb)
        }
      }
    },
  }
}
