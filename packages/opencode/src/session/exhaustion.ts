import { z } from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"

export namespace SessionExhaustion {
  // Schema definitions
  export const ExhaustedModel = z
    .object({
      modelId: z.string(), // "provider/model-id"
      exhaustedAt: z.number(), // timestamp in ms
      refreshAfter: z.number().optional(), // duration in ms (undefined = manual only)
      reason: z.string(), // human-readable reason
    })
    .meta({ ref: "ExhaustedModel" })
  export type ExhaustedModel = z.infer<typeof ExhaustedModel>

  export const Info = z
    .object({
      exhaustedModels: z.array(ExhaustedModel),
    })
    .meta({ ref: "SessionExhaustion" })
  export type Info = z.infer<typeof Info>

  // Event definitions
  export const Event = {
    Updated: BusEvent.define(
      "session.exhaustion.updated",
      z.object({
        state: Info,
      }),
    ),
    ModelExhausted: BusEvent.define(
      "session.exhaustion.model-exhausted",
      z.object({
        modelId: z.string(),
        reason: z.string(),
      }),
    ),
    ModelRefreshed: BusEvent.define(
      "session.exhaustion.model-refreshed",
      z.object({
        modelId: z.string(),
      }),
    ),
  }

  // In-memory state
  const state = Instance.state(() => {
    const data: Info = { exhaustedModels: [] }
    return data
  })

  // Create empty state
  export function createExhaustionState(): Info {
    return { exhaustedModels: [] }
  }

  // Get current state
  export function get(): Info {
    return state()
  }

  // Mark a model as exhausted
  export function markExhausted(
    current: Info,
    modelId: string,
    refreshAfter: number | undefined,
    reason: string,
  ): Info {
    // Remove existing entry for this model if present
    const filtered = current.exhaustedModels.filter((m) => m.modelId !== modelId)

    const updated: Info = {
      exhaustedModels: [
        ...filtered,
        {
          modelId,
          exhaustedAt: Date.now(),
          refreshAfter,
          reason,
        },
      ],
    }

    // Update in-memory state
    state().exhaustedModels = updated.exhaustedModels

    // Publish events
    Bus.publish(Event.ModelExhausted, { modelId, reason })
    Bus.publish(Event.Updated, { state: updated })

    return updated
  }

  // Check if a model is currently exhausted (and hasn't refreshed)
  export function isExhausted(current: Info, modelId: string): boolean {
    const model = current.exhaustedModels.find((m) => m.modelId === modelId)
    if (!model) return false

    // Manual refresh only (no auto-refresh)
    if (model.refreshAfter === undefined) return true

    // Check if refresh time has passed
    const elapsed = Date.now() - model.exhaustedAt
    return elapsed < model.refreshAfter
  }

  // Check if a specific model has refreshed (ready to use again)
  export function hasRefreshed(current: Info, modelId: string): boolean {
    const model = current.exhaustedModels.find((m) => m.modelId === modelId)
    if (!model) return false

    // Manual refresh only - never auto-refreshes
    if (model.refreshAfter === undefined) return false

    // Check if refresh time has passed
    const elapsed = Date.now() - model.exhaustedAt
    return elapsed >= model.refreshAfter
  }

  // Get all models that have refreshed since being marked exhausted
  export function getRefreshedModels(current: Info): string[] {
    const now = Date.now()
    return current.exhaustedModels
      .filter((m) => {
        // Skip manual-only models
        if (m.refreshAfter === undefined) return false

        // Check if refresh time has passed
        const elapsed = now - m.exhaustedAt
        return elapsed >= m.refreshAfter
      })
      .map((m) => m.modelId)
  }

  // Clear exhausted status for a model
  export function clearExhausted(current: Info, modelId: string): Info {
    const updated: Info = {
      exhaustedModels: current.exhaustedModels.filter((m) => m.modelId !== modelId),
    }

    // Update in-memory state
    state().exhaustedModels = updated.exhaustedModels

    // Publish events
    Bus.publish(Event.ModelRefreshed, { modelId })
    Bus.publish(Event.Updated, { state: updated })

    return updated
  }

  // Clear all models that have refreshed
  export function clearRefreshed(current: Info): Info {
    const now = Date.now()
    const refreshed: string[] = []

    const updated: Info = {
      exhaustedModels: current.exhaustedModels.filter((m) => {
        // Keep manual-only models
        if (m.refreshAfter === undefined) return true

        // Keep models that haven't refreshed yet
        const elapsed = now - m.exhaustedAt
        const stillExhausted = elapsed < m.refreshAfter

        if (!stillExhausted) {
          refreshed.push(m.modelId)
        }

        return stillExhausted
      }),
    }

    // Update in-memory state
    state().exhaustedModels = updated.exhaustedModels

    // Publish events for each refreshed model
    for (const modelId of refreshed) {
      Bus.publish(Event.ModelRefreshed, { modelId })
    }
    Bus.publish(Event.Updated, { state: updated })

    return updated
  }

  // Clear exhausted status for all models that have refreshed
  export function clearAllRefreshed(state: Info): {
    state: Info
    cleared: string[]
  } {
    const refreshed = getRefreshedModels(state)
    let newState = state

    for (const id of refreshed) {
      newState = clearExhausted(newState, id)
    }

    return { state: newState, cleared: refreshed }
  }

  // Result type for checkForBetterModel
  export interface ModelSwitchResult {
    switchTo: Agent.ModelInfo
    switchToIndex: number
    clearedModels: string[] // Models that were cleared (for UI notification)
  }

  // Check if any higher-priority model has refreshed and is available again
  export function checkForBetterModel(
    currentIndex: number,
    models: Agent.ModelInfo[],
    state: Info,
  ): { result: ModelSwitchResult; state: Info } | null {
    // If already using primary (index 0), no better model exists
    if (currentIndex === 0) return null

    const cleared: string[] = []
    let newState = state

    // Check models with index < currentIndex (higher priority)
    for (let i = 0; i < currentIndex; i++) {
      const model = models[i]
      const id = modelId(model)

      // Check if this model has refreshed
      if (hasRefreshed(newState, id)) {
        // Clear its exhausted status
        newState = clearExhausted(newState, id)
        cleared.push(id)
      }
    }

    // If any models were cleared, try to select the best one
    if (cleared.length === 0) return null

    // Find the highest priority (lowest index) that's now available
    const result = selectModel(models, newState)

    // If still no better model or same/worse, don't switch
    if ("error" in result) return null
    if (result.index >= currentIndex) return null

    return {
      result: {
        switchTo: result.model,
        switchToIndex: result.index,
        clearedModels: cleared,
      },
      state: newState,
    }
  }

  // Helper to get model ID string
  export function modelId(model: Agent.ModelInfo): string {
    return `${model.providerID}/${model.modelID}`
  }

  // Result types for selectModel
  export interface SelectModelResult {
    model: Agent.ModelInfo
    index: number
  }

  export interface AllExhaustedError {
    error: "all_exhausted"
    models: string[] // List of exhausted model IDs for error message
  }

  // Select best available model from fallback list
  export function selectModel(models: Agent.ModelInfo[], state: Info): SelectModelResult | AllExhaustedError {
    // Iterate through models in priority order (index 0 = highest priority)
    for (let i = 0; i < models.length; i++) {
      const model = models[i]
      const id = modelId(model)

      // Skip if exhausted and hasn't refreshed
      if (isExhausted(state, id)) continue

      return { model, index: i }
    }

    // All models exhausted
    return {
      error: "all_exhausted",
      models: models.map((m) => modelId(m)),
    }
  }

  // Result types for handleExhaustionError
  export interface FallbackResult {
    nextModel: Agent.ModelInfo
    nextIndex: number
    state: Info
    reason: string
  }

  export interface NoFallbackResult {
    error: "all_exhausted"
    state: Info
    models: string[]
  }

  // Handle exhaustion error and switch to fallback model
  export function handleExhaustionError(
    currentIndex: number,
    models: Agent.ModelInfo[],
    state: Info,
    error: unknown,
  ): FallbackResult | NoFallbackResult {
    const current = models[currentIndex]
    const id = modelId(current)
    const reason = Provider.getExhaustionReason(error) ?? "Model exhausted"

    // Mark current model as exhausted
    const newState = markExhausted(state, id, current.refreshAfter, reason)

    // Try to select next available model
    const result = selectModel(models, newState)

    if ("error" in result) {
      return {
        error: "all_exhausted",
        state: newState,
        models: result.models,
      }
    }

    return {
      nextModel: result.model,
      nextIndex: result.index,
      state: newState,
      reason,
    }
  }
}
