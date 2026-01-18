import { Log } from "@/util/log"

export namespace ModelFallback {
  const log = Log.create({ service: "model.fallback" })

  interface ModelRef {
    providerID: string
    modelID: string
  }

  interface ExhaustedEntry {
    since: number
    refreshAt: number
    reason: string
  }

  const REFRESH_INTERVAL_MS = 10 * 60 * 1000
  const MAX_CONSECUTIVE_FAILURES = 3

  const exhaustedModels = new Map<string, ExhaustedEntry>()
  const failureCounts = new Map<string, number>()

  export function getModelKey(model: ModelRef): string {
    return `${model.providerID}/${model.modelID}`
  }

  export function isExhausted(model: ModelRef): boolean {
    checkRecovery()
    return exhaustedModels.has(getModelKey(model))
  }

  export function markExhausted(model: ModelRef, reason: string): void {
    const key = getModelKey(model)
    const now = Date.now()
    exhaustedModels.set(key, {
      since: now,
      refreshAt: now + REFRESH_INTERVAL_MS,
      reason,
    })
    failureCounts.delete(key)
    log.info("model exhausted", { model: key, reason, refreshAt: new Date(now + REFRESH_INTERVAL_MS).toISOString() })
  }

  export function recordFailure(model: ModelRef): boolean {
    const key = getModelKey(model)
    const count = (failureCounts.get(key) ?? 0) + 1
    failureCounts.set(key, count)
    log.info("model failure recorded", { model: key, consecutiveFailures: count })
    return count >= MAX_CONSECUTIVE_FAILURES
  }

  export function recordSuccess(model: ModelRef): void {
    const key = getModelKey(model)
    if (failureCounts.has(key)) {
      failureCounts.delete(key)
      log.info("model success, failures reset", { model: key })
    }
  }

  export function checkRecovery(): string[] {
    const now = Date.now()
    const recovered: string[] = []
    for (const [key, entry] of exhaustedModels) {
      if (now >= entry.refreshAt) {
        exhaustedModels.delete(key)
        recovered.push(key)
        log.info("model recovered", { model: key })
      }
    }
    return recovered
  }

  export function getActiveModel(models: ModelRef[]): { model: ModelRef; index: number } | undefined {
    checkRecovery()
    for (let i = 0; i < models.length; i++) {
      if (!isExhausted(models[i])) {
        return { model: models[i], index: i }
      }
    }
    return undefined
  }

  export function getExhaustionInfo(model: ModelRef): ExhaustedEntry | undefined {
    return exhaustedModels.get(getModelKey(model))
  }

  export function getState(): {
    exhausted: Array<{ key: string; entry: ExhaustedEntry }>
    failures: Array<{ key: string; count: number }>
  } {
    return {
      exhausted: Array.from(exhaustedModels.entries()).map(([key, entry]) => ({ key, entry })),
      failures: Array.from(failureCounts.entries()).map(([key, count]) => ({ key, count })),
    }
  }

  export function reset(): void {
    exhaustedModels.clear()
    failureCounts.clear()
  }
}
