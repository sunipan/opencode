import { describe, expect, test } from "bun:test"
import { SessionExhaustion } from "../../src/session/exhaustion"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import path from "path"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Helper to run tests that need Instance context
async function withInstance<T>(fn: () => T | Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn: async () => fn(),
  })
}

describe("session.exhaustion.createExhaustionState", () => {
  test("creates empty state", () => {
    const state = SessionExhaustion.createExhaustionState()
    expect(state.exhaustedModels).toEqual([])
  })
})

describe("session.exhaustion.modelId", () => {
  test("formats model ID correctly", () => {
    const model = { providerID: "anthropic", modelID: "claude-3-opus" }
    const id = SessionExhaustion.modelId(model)
    expect(id).toBe("anthropic/claude-3-opus")
  })
})

describe("session.exhaustion.markExhausted", () => {
  test("adds model to exhausted list", async () => {
    await withInstance(() => {
      const state = SessionExhaustion.createExhaustionState()
      const result = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 5000, "Rate limited")

      expect(result.exhaustedModels).toHaveLength(1)
      expect(result.exhaustedModels[0].modelId).toBe("anthropic/claude-3-opus")
      expect(result.exhaustedModels[0].reason).toBe("Rate limited")
      expect(result.exhaustedModels[0].refreshAfter).toBe(5000)
    })
  })

  test("updates existing exhausted model", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 5000, "first")
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 10000, "second")

    expect(state.exhaustedModels).toHaveLength(1)
    expect(state.exhaustedModels[0].reason).toBe("second")
    expect(state.exhaustedModels[0].refreshAfter).toBe(10000)
    })
  })
  test("marks model without refresh time", async () => {
    await withInstance(() => {
    const state = SessionExhaustion.createExhaustionState()
    const result = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", undefined, "Manual exhaustion")

    expect(result.exhaustedModels).toHaveLength(1)
    expect(result.exhaustedModels[0].refreshAfter).toBeUndefined()
    })
  })
  test("publishes ModelExhausted event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventData: any
        const unsub = Bus.subscribe(SessionExhaustion.Event.ModelExhausted, (event) => {
          eventData = event.properties
        })

        const state = SessionExhaustion.createExhaustionState()
        SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 5000, "Rate limited")

        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventData?.modelId).toBe("anthropic/claude-3-opus")
        expect(eventData?.reason).toBe("Rate limited")
      },
    })
  })
})

describe("session.exhaustion.isExhausted", () => {
  test("returns true for exhausted model without refresh", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", undefined, "manual")
    expect(SessionExhaustion.isExhausted(state, "anthropic/claude-3-opus")).toBe(true)
    })
  })
  test("returns false for model not in list", () => {
    const state = SessionExhaustion.createExhaustionState()
    expect(SessionExhaustion.isExhausted(state, "anthropic/claude-3-opus")).toBe(false)
  })

  test("returns true for exhausted model with future refresh", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1000000, "quota")
    expect(SessionExhaustion.isExhausted(state, "anthropic/claude-3-opus")).toBe(true)
    })
  })})

describe("session.exhaustion.hasRefreshed", () => {
  test("returns false if refreshAfter not elapsed", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1000000, "quota")
    expect(SessionExhaustion.hasRefreshed(state, "anthropic/claude-3-opus")).toBe(false)
    })
  })
  test("returns true if refreshAfter has elapsed", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))
    expect(SessionExhaustion.hasRefreshed(state, "anthropic/claude-3-opus")).toBe(true)
    })
  })
  test("returns false for model without refreshAfter", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", undefined, "manual")
    expect(SessionExhaustion.hasRefreshed(state, "anthropic/claude-3-opus")).toBe(false)
    })
  })
  test("returns false for model not in list", () => {
    const state = SessionExhaustion.createExhaustionState()
    expect(SessionExhaustion.hasRefreshed(state, "anthropic/claude-3-opus")).toBe(false)
  })
})

describe("session.exhaustion.clearExhausted", () => {
  test("removes model from exhausted list", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 5000, "quota")
    state = SessionExhaustion.clearExhausted(state, "anthropic/claude-3-opus")

    expect(state.exhaustedModels).toHaveLength(0)
    })
  })
  test("does nothing if model not in list", async () => {
    await withInstance(() => {
    const state = SessionExhaustion.createExhaustionState()
    const result = SessionExhaustion.clearExhausted(state, "anthropic/claude-3-opus")
    expect(result.exhaustedModels).toHaveLength(0)
    })
  })})

describe("session.exhaustion.getRefreshedModels", () => {
  test("returns empty array when no models refreshed", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1000000, "quota")
    expect(SessionExhaustion.getRefreshedModels(state)).toEqual([])
    })
  })
  test("returns refreshed model IDs", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    state = SessionExhaustion.markExhausted(state, "openai/gpt-4", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))

    const refreshed = SessionExhaustion.getRefreshedModels(state)
    expect(refreshed).toHaveLength(2)
    expect(refreshed).toContain("anthropic/claude-3-opus")
    expect(refreshed).toContain("openai/gpt-4")
    })
  })
  test("does not return models without refreshAfter", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", undefined, "manual")
    await new Promise((r) => setTimeout(r, 5))

    expect(SessionExhaustion.getRefreshedModels(state)).toEqual([])
    })
  })})

describe("session.exhaustion.clearAllRefreshed", () => {
  test("clears all refreshed models", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    state = SessionExhaustion.markExhausted(state, "openai/gpt-4", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))

    const result = SessionExhaustion.clearAllRefreshed(state)
    expect(result.state.exhaustedModels).toHaveLength(0)
    expect(result.cleared).toHaveLength(2)
    expect(result.cleared).toContain("anthropic/claude-3-opus")
    expect(result.cleared).toContain("openai/gpt-4")
    })
  })
  test("does not clear models that have not refreshed", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1000000, "quota")

    const result = SessionExhaustion.clearAllRefreshed(state)
    expect(result.state.exhaustedModels).toHaveLength(1)
    expect(result.cleared).toHaveLength(0)
    })
  })
  test("publishes ModelRefreshed events", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: any[] = []
        const unsub = Bus.subscribe(SessionExhaustion.Event.ModelRefreshed, (event) => {
          events.push(event.properties)
        })

        let state = SessionExhaustion.createExhaustionState()
        state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
        await new Promise((r) => setTimeout(r, 5))

        SessionExhaustion.clearAllRefreshed(state)

        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(events).toHaveLength(1)
        expect(events[0]?.modelId).toBe("anthropic/claude-3-opus")
      },
    })
  })
})

describe("session.exhaustion.selectModel", () => {
  const models = [
    { providerID: "anthropic", modelID: "claude-3-opus", refreshAfter: 5000 },
    { providerID: "openai", modelID: "gpt-4" },
    { providerID: "google", modelID: "gemini-pro" },
  ]

  test("selects first model when none exhausted", () => {
    const state = SessionExhaustion.createExhaustionState()
    const result = SessionExhaustion.selectModel(models, state)
    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.index).toBe(0)
      expect(result.model.modelID).toBe("claude-3-opus")
    }
  })

  test("skips exhausted model", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 100000, "quota")
    const result = SessionExhaustion.selectModel(models, state)
    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.index).toBe(1)
      expect(result.model.modelID).toBe("gpt-4")
    }
    })
  })
  test("skips multiple exhausted models", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 100000, "quota")
    state = SessionExhaustion.markExhausted(state, "openai/gpt-4", 100000, "billing")
    const result = SessionExhaustion.selectModel(models, state)
    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.index).toBe(2)
      expect(result.model.modelID).toBe("gemini-pro")
    }
    })
  })
  test("returns error when all exhausted", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", undefined, "quota")
    state = SessionExhaustion.markExhausted(state, "openai/gpt-4", undefined, "billing")
    state = SessionExhaustion.markExhausted(state, "google/gemini-pro", undefined, "daily limit")
    const result = SessionExhaustion.selectModel(models, state)
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toBe("all_exhausted")
    }
    })
  })
  test("selects refreshed model", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))

    const result = SessionExhaustion.selectModel(models, state)
    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.index).toBe(0)
      expect(result.model.modelID).toBe("claude-3-opus")
    }
    })
  })})

describe("session.exhaustion.checkForBetterModel", () => {
  const models = [
    { providerID: "anthropic", modelID: "claude-3-opus", refreshAfter: 1 },
    { providerID: "openai", modelID: "gpt-4" },
    { providerID: "google", modelID: "gemini-pro" },
  ]

  test("returns null when already on primary", () => {
    const state = SessionExhaustion.createExhaustionState()
    const result = SessionExhaustion.checkForBetterModel(0, models, state)
    expect(result).toBeNull()
  })

  test("returns null when no better model available", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 100000, "quota")
    const result = SessionExhaustion.checkForBetterModel(1, models, state)
    expect(result).toBeNull()
    })
  })
  test("detects when primary has refreshed", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))

    const result = SessionExhaustion.checkForBetterModel(1, models, state)
    expect(result).not.toBeNull()
    if (result) {
      expect(result.result.switchToIndex).toBe(0)
      expect(result.result.switchTo.modelID).toBe("claude-3-opus")
    }
    })
  })
  test("detects when higher priority model has refreshed", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    state = SessionExhaustion.markExhausted(state, "openai/gpt-4", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))

    const result = SessionExhaustion.checkForBetterModel(2, models, state)
    expect(result).not.toBeNull()
    if (result) {
      expect(result.result.switchToIndex).toBe(0)
      expect(result.result.switchTo.modelID).toBe("claude-3-opus")
    }
    })
  })
  test("clears refreshed models from state", async () => {
    await withInstance(async () => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "anthropic/claude-3-opus", 1, "quota")
    await new Promise((r) => setTimeout(r, 5))

    const result = SessionExhaustion.checkForBetterModel(1, models, state)
    expect(result).not.toBeNull()
    if (result) {
      expect(result.state.exhaustedModels).toHaveLength(0)
    }
    })
  })})

describe("session.exhaustion.handleExhaustionError", () => {
  const models = [
    { providerID: "anthropic", modelID: "claude-3-opus", refreshAfter: 5000 },
    { providerID: "openai", modelID: "gpt-4" },
    { providerID: "google", modelID: "gemini-pro" },
  ]

  test("switches to next available model", async () => {
    await withInstance(() => {
    const state = SessionExhaustion.createExhaustionState()
    const error = new Error("You have exceeded your plan's limit")
    const result = SessionExhaustion.handleExhaustionError(0, models, state, error)

    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.nextIndex).toBe(1)
      expect(result.nextModel.modelID).toBe("gpt-4")
      expect(result.state.exhaustedModels).toHaveLength(1)
      expect(result.state.exhaustedModels[0].modelId).toBe("anthropic/claude-3-opus")
    }
    })
  })

  test("uses model refreshAfter when available", async () => {
    await withInstance(() => {
    const state = SessionExhaustion.createExhaustionState()
    const error = new Error("You have exceeded your plan's limit")
    const result = SessionExhaustion.handleExhaustionError(0, models, state, error)

    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(result.state.exhaustedModels[0].refreshAfter).toBe(5000)
    }
    })
  })

  test("returns no_fallback when all models exhausted", async () => {
    await withInstance(() => {
    let state = SessionExhaustion.createExhaustionState()
    state = SessionExhaustion.markExhausted(state, "openai/gpt-4", undefined, "billing")
    state = SessionExhaustion.markExhausted(state, "google/gemini-pro", undefined, "daily limit")

    const error = new Error("You have exceeded your plan's limit")
    const result = SessionExhaustion.handleExhaustionError(0, models, state, error)

    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toBe("all_exhausted")
    }
    })
  })
  test("marks current model as exhausted", async () => {
    await withInstance(() => {
    const state = SessionExhaustion.createExhaustionState()
    const error = new Error("Quota exceeded")
    const result = SessionExhaustion.handleExhaustionError(0, models, state, error)

    expect("error" in result).toBe(false)
    if (!("error" in result)) {
      expect(SessionExhaustion.isExhausted(result.state, "anthropic/claude-3-opus")).toBe(true)
    }
    })
  })

  test("publishes ModelExhausted event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventData: any
        const unsub = Bus.subscribe(SessionExhaustion.Event.ModelExhausted, (event) => {
          eventData = event.properties
        })

        const state = SessionExhaustion.createExhaustionState()
        const error = new Error("You have exceeded your plan's limit")
        SessionExhaustion.handleExhaustionError(0, models, state, error)

        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventData?.modelId).toBe("anthropic/claude-3-opus")
      },
    })
  })
})
