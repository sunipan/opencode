import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"

export const TuiEvent = {
  PromptAppend: BusEvent.define("tui.prompt.append", z.object({ text: z.string() })),
  CommandExecute: BusEvent.define(
    "tui.command.execute",
    z.object({
      command: z.union([
        z.enum([
          "session.list",
          "session.new",
          "session.share",
          "session.interrupt",
          "session.compact",
          "session.page.up",
          "session.page.down",
          "session.half.page.up",
          "session.half.page.down",
          "session.first",
          "session.last",
          "prompt.clear",
          "prompt.submit",
          "agent.cycle",
        ]),
        z.string(),
      ]),
    }),
  ),
  ToastShow: BusEvent.define(
    "tui.toast.show",
    z.object({
      title: z.string().optional(),
      message: z.string(),
      variant: z.enum(["info", "success", "warning", "error"]),
      duration: z.number().default(5000).optional().describe("Duration in milliseconds"),
    }),
  ),
  SessionSelect: BusEvent.define(
    "tui.session.select",
    z.object({
      sessionID: z.string().regex(/^ses/).describe("Session ID to navigate to"),
    }),
  ),
  ModelFallback: BusEvent.define(
    "tui.model.fallback",
    z.object({
      from: z.string().describe("Model that was exhausted"),
      to: z.string().describe("Fallback model now in use"),
      reason: z.string().describe("Why original was exhausted"),
    }),
  ),
  ModelRecovered: BusEvent.define(
    "tui.model.recovered",
    z.object({
      model: z.string().describe("Model that's available again"),
      from: z.string().describe("Model we were using before"),
    }),
  ),
  AllModelsExhausted: BusEvent.define(
    "tui.model.all_exhausted",
    z.object({
      models: z.array(z.string()).describe("List of exhausted models"),
    }),
  ),
}

// Helper functions to publish model events with toast notifications
export function notifyModelFallback(from: string, to: string, reason: string) {
  Bus.publish(TuiEvent.ModelFallback, { from, to, reason })
  Bus.publish(TuiEvent.ToastShow, {
    title: "Model Fallback",
    message: `⚠️ ${from} exhausted (${reason}), using ${to}`,
    variant: "warning",
    duration: 6000,
  })
}

export function notifyModelRecovered(model: string, from: string) {
  Bus.publish(TuiEvent.ModelRecovered, { model, from })
  Bus.publish(TuiEvent.ToastShow, {
    title: "Model Available",
    message: `✓ ${model} available again, switching back`,
    variant: "success",
    duration: 5000,
  })
}

export function notifyAllModelsExhausted(models: string[]) {
  Bus.publish(TuiEvent.AllModelsExhausted, { models })
  Bus.publish(TuiEvent.ToastShow, {
    title: "All Models Exhausted",
    message: `❌ No models available: ${models.join(", ")}`,
    variant: "error",
    duration: 10000,
  })
}
