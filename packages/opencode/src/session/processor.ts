import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { SessionExhaustion } from "./exhaustion"
import { notifyModelFallback, notifyModelRecovered, notifyAllModelsExhausted } from "@/cli/cmd/tui/event"
import { DebugFallback } from "./debug-fallback"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    models?: Agent.ModelInfo[]
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    let exhaustionState = SessionExhaustion.createExhaustionState()
    let currentModelIndex = 0
    let currentModel = input.model

    // Initialize debug fallback if enabled
    if (input.models && input.models.length > 1) {
      DebugFallback.init(input.models)
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            // Debug: Check if primary model was refreshed
            if (input.models && input.models.length > 1 && currentModelIndex > 0 && DebugFallback.isEnabled()) {
              const debugRefresh = DebugFallback.isPrimaryRefreshed()
              if (debugRefresh.refreshed && debugRefresh.modelId) {
                const primaryIdx = input.models.findIndex(
                  (m) => `${m.providerID}/${m.modelID}` === debugRefresh.modelId,
                )
                if (primaryIdx >= 0 && primaryIdx < currentModelIndex) {
                  const oldModelId = SessionExhaustion.modelId(input.models[currentModelIndex])
                  currentModelIndex = primaryIdx
                  currentModel = await Provider.getModel(
                    input.models[primaryIdx].providerID,
                    input.models[primaryIdx].modelID,
                  )
                  streamInput.model = currentModel
                  notifyModelRecovered(debugRefresh.modelId, oldModelId)
                  log.info("debug: switched back to refreshed primary", { model: debugRefresh.modelId })
                }
              }
            }

            // Check if a better model has refreshed (only if using fallback models)
            if (input.models && input.models.length > 1 && currentModelIndex > 0) {
              const better = SessionExhaustion.checkForBetterModel(currentModelIndex, input.models, exhaustionState)
              if (better) {
                const oldModelId = SessionExhaustion.modelId(input.models[currentModelIndex])
                const newModelId = SessionExhaustion.modelId(better.result.switchTo)
                exhaustionState = better.state
                currentModelIndex = better.result.switchToIndex
                currentModel = await Provider.getModel(
                  better.result.switchTo.providerID,
                  better.result.switchTo.modelID,
                )
                streamInput.model = currentModel
                notifyModelRecovered(newModelId, oldModelId)
                log.info("switched to better model", { from: oldModelId, to: newModelId })
              }
            }

            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

            // Debug: Check if we should simulate exhaustion
            if (input.models && input.models.length > 1 && DebugFallback.isEnabled()) {
              const currentModelId = SessionExhaustion.modelId(input.models[currentModelIndex])
              if (DebugFallback.shouldExhaust(currentModelId)) {
                const result = SessionExhaustion.handleExhaustionError(
                  currentModelIndex,
                  input.models,
                  exhaustionState,
                  new Error(`[DEBUG] Simulated exhaustion for ${currentModelId}`),
                )
                exhaustionState = result.state

                if ("error" in result) {
                  notifyAllModelsExhausted(result.models)
                  throw new Error(`All models exhausted: ${result.models.join(", ")}`)
                }

                const oldModelId = currentModelId
                const newModelId = SessionExhaustion.modelId(result.nextModel)
                currentModelIndex = result.nextIndex
                currentModel = await Provider.getModel(result.nextModel.providerID, result.nextModel.modelID)
                streamInput.model = currentModel
                notifyModelFallback(oldModelId, newModelId, result.reason)
                attempt = 0
                log.info("debug fallback triggered", { from: oldModelId, to: newModelId })
              }
            }

            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }

            // Debug: Consume credit after successful call
            if (input.models && input.models.length > 1 && DebugFallback.isEnabled()) {
              const currentModelId = SessionExhaustion.modelId(input.models[currentModelIndex])
              DebugFallback.consumeCredit(currentModelId)
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: currentModel.providerID })

            // Check if this is an exhaustion error and we have fallback models
            if (Provider.isExhaustionError(e) && input.models && input.models.length > 1) {
              const result = SessionExhaustion.handleExhaustionError(
                currentModelIndex,
                input.models,
                exhaustionState,
                e,
              )
              exhaustionState = result.state

              if ("error" in result) {
                // All models exhausted
                notifyAllModelsExhausted(result.models)
                input.assistantMessage.error = error
                Bus.publish(Session.Event.Error, {
                  sessionID: input.assistantMessage.sessionID,
                  error: input.assistantMessage.error,
                })
                break
              }

              // Switch to fallback model
              const oldModelId = SessionExhaustion.modelId(input.models[currentModelIndex])
              const newModelId = SessionExhaustion.modelId(result.nextModel)
              currentModelIndex = result.nextIndex
              currentModel = await Provider.getModel(result.nextModel.providerID, result.nextModel.modelID)
              streamInput.model = currentModel
              notifyModelFallback(oldModelId, newModelId, result.reason)
              log.info("fallback to next model", { from: oldModelId, to: newModelId, reason: result.reason })

              // Reset attempt counter for new model
              attempt = 0
              continue
            }

            // Check for retryable errors (transient issues)
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }

            // Non-retryable error
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
