/**
 * Credit-based debug mode for testing model fallback without real rate limits.
 * Enable with: OPENCODE_DEBUG_FALLBACK=true
 *
 * Flow:
 * - Each model starts with 1 credit
 * - Using a model consumes 1 credit
 * - When credits reach 0, next call triggers exhaustion → fallback
 * - After 3 total calls, primary model gets refreshed → auto-switch back
 */

export namespace DebugFallback {
  interface State {
    enabled: boolean;
    credits: Map<string, number>;
    totalCalls: number;
    primaryModel: string | null;
    refreshAfterCalls: number;
  }

  const state: State = {
    enabled: false,
    credits: new Map(),
    totalCalls: 0,
    primaryModel: null,
    refreshAfterCalls: 3,
  };

  export function isEnabled(): boolean {
    return (
      process.env.OPENCODE_DEBUG_FALLBACK === "true" ||
      process.env.OPENCODE_DEBUG_FALLBACK === "1"
    );
  }

  export function init(
    models: Array<{ providerID: string; modelID: string }>,
  ): void {
    if (!isEnabled()) return;

    state.enabled = true;
    state.credits.clear();
    state.totalCalls = 0;
    state.primaryModel = null;

    for (const model of models) {
      const id = `${model.providerID}/${model.modelID}`;
      state.credits.set(id, 1);
      if (!state.primaryModel) {
        state.primaryModel = id;
      }
    }

    console.log(
      `[DEBUG FALLBACK] Initialized: ${models.length} models, 1 credit each`,
    );
    console.log(`[DEBUG FALLBACK] Credits:`, Object.fromEntries(state.credits));
  }

  export function shouldExhaust(modelId: string): boolean {
    if (!state.enabled) return false;
    const credits = state.credits.get(modelId) ?? 0;
    const exhaust = credits <= 0;
    if (exhaust) {
      console.log(
        `[DEBUG FALLBACK] ${modelId} has 0 credits → simulating exhaustion`,
      );
    }
    return exhaust;
  }

  export function consumeCredit(modelId: string): void {
    if (!state.enabled) return;

    const current = state.credits.get(modelId) ?? 0;
    const next = Math.max(0, current - 1);
    state.credits.set(modelId, next);
    state.totalCalls++;

    console.log(
      `[DEBUG FALLBACK] ${modelId}: credit ${current}→${next}, total calls: ${state.totalCalls}`,
    );

    if (state.totalCalls >= state.refreshAfterCalls && state.primaryModel) {
      const primaryCredits = state.credits.get(state.primaryModel) ?? 0;
      if (primaryCredits === 0) {
        state.credits.set(state.primaryModel, 1);
        console.log(
          `[DEBUG FALLBACK] ✨ Primary ${state.primaryModel} REFRESHED! credit 0→1`,
        );
      }
    }
  }

  export function isPrimaryRefreshed(): {
    refreshed: boolean;
    modelId: string | null;
  } {
    if (!state.enabled || !state.primaryModel)
      return { refreshed: false, modelId: null };
    const credits = state.credits.get(state.primaryModel) ?? 0;
    return { refreshed: credits > 0, modelId: state.primaryModel };
  }

  export function reset(): void {
    state.enabled = false;
    state.credits.clear();
    state.totalCalls = 0;
    state.primaryModel = null;
  }
}
