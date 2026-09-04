#!/usr/bin/env node
// update.mjs — refresh the bundled models.dev snapshot.
//
//   node script/update.mjs            # fetch + write data/model-variants-data.json
//   node script/update.mjs --check    # exit 1 if a newer snapshot differs (CI-friendly)
//   MODELS_DEV_URL=... node ...       # mirror source
//
// Idempotent: identical snapshots are never written to disk.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { aggregate } from "../src/core.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_URL = process.env.MODELS_DEV_URL || "https://models.opencode.ai/api.json"
const DATA_FILE = path.resolve(here, "..", "data", "model-variants-data.json")
const CHECK_ONLY = process.argv.includes("--check")

async function main() {
  console.log(`fetching ${DATA_URL}`)
  const res = await fetch(DATA_URL, {
    headers: { "user-agent": "opencode-model-variants-updater" },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const raw = await res.json()

  const snapshot = aggregate(raw, { source: DATA_URL })
  const json = JSON.stringify(snapshot, null, 2) + "\n"

  let prev = null
  try {
    prev = await readFile(DATA_FILE, "utf8")
  } catch {
    // no existing snapshot
  }

  if (prev === json) {
    console.log(`up to date (${snapshot.count} models)`)
    return
  }

  if (CHECK_ONLY && prev !== null) {
    console.error("snapshot is stale: models.dev data differs from the bundled file")
    process.exit(1)
  }

  await mkdir(path.dirname(DATA_FILE), { recursive: true })
  await writeFile(DATA_FILE, json, "utf8")

  if (prev === null) {
    console.log(`created ${DATA_FILE} (${snapshot.count} models)`)
  } else {
    const prevCount = JSON.parse(prev).count
    console.log(`updated ${DATA_FILE}: ${prevCount} -> ${snapshot.count} models`)
  }
  console.log("restart OpenCode for the plugin to pick up the new snapshot.")
}

main().catch((err) => {
  console.error("failed:", err.message)
  process.exit(1)
})
