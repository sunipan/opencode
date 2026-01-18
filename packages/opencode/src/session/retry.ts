import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    if (typeof error.data?.message === "string") {
      try {
        const json = JSON.parse(error.data.message)
        if (json.type === "error" && json.error?.type === "too_many_requests") {
          return "Too Many Requests"
        }
        if (json.code.includes("exhausted") || json.code.includes("unavailable")) {
          return "Provider is overloaded"
        }
        if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
          return "Rate Limited"
        }
        if (
          json.error?.message?.includes("no_kv_space") ||
          (json.type === "error" && json.error?.type === "server_error") ||
          !!json.error
        ) {
          return "Provider Server Error"
        }
      } catch {}
    }

    return undefined
  }

  /** Error classification for fallback decisions */
  export enum ErrorClass {
    QUOTA_EXCEEDED = "quota", // Switch immediately - account limit hit
    RATE_LIMITED = "rate_limit", // Retry 3x, then switch - temporary limit
    NETWORK_ERROR = "network", // Retry 3x, then switch - connection issue
    AUTH_ERROR = "auth", // Skip to next model - invalid credentials
    UNKNOWN = "unknown", // Don't switch, show error to user
  }

  export interface ErrorClassification {
    class: ErrorClass
    shouldRetry: boolean // Should retry with same model?
    maxRetries: number // How many retries before switching
    shouldSwitch: boolean // Should switch to fallback model?
    message: string // Human-readable description
  }

  /** Classify an error for fallback decision making */
  export function classifyError(error: ReturnType<NamedError["toObject"]>): ErrorClassification {
    const message = error.data?.message?.toLowerCase() ?? ""
    const responseBody = (error.data?.responseBody ?? "").toLowerCase()
    const statusCode = error.data?.statusCode
    const combined = `${message} ${responseBody}`

    // Auth errors - skip to next model immediately
    if (
      combined.includes("invalid_api_key") ||
      combined.includes("unauthorized") ||
      combined.includes("authentication") ||
      statusCode === 401
    ) {
      return {
        class: ErrorClass.AUTH_ERROR,
        shouldRetry: false,
        maxRetries: 0,
        shouldSwitch: true,
        message: "Authentication failed",
      }
    }

    // Quota/plan limit errors - switch immediately (won't recover soon)
    if (
      (combined.includes("exceed") && combined.includes("plan")) ||
      (combined.includes("exceed") && combined.includes("limit")) ||
      combined.includes("credit balance") ||
      combined.includes("insufficient_quota") ||
      combined.includes("billing") ||
      statusCode === 402
    ) {
      return {
        class: ErrorClass.QUOTA_EXCEEDED,
        shouldRetry: false,
        maxRetries: 0,
        shouldSwitch: true,
        message: "Quota exceeded",
      }
    }

    // Rate limit errors - retry a few times, might recover
    if (
      combined.includes("rate_limit") ||
      combined.includes("too_many_requests") ||
      combined.includes("resource_exhausted") ||
      combined.includes("exceeded quota") ||
      statusCode === 429
    ) {
      return {
        class: ErrorClass.RATE_LIMITED,
        shouldRetry: true,
        maxRetries: 3,
        shouldSwitch: true,
        message: "Rate limited",
      }
    }

    // Network errors - retry, might be transient
    if (
      combined.includes("econnreset") ||
      combined.includes("etimedout") ||
      combined.includes("enotfound") ||
      combined.includes("network") ||
      combined.includes("connection")
    ) {
      return {
        class: ErrorClass.NETWORK_ERROR,
        shouldRetry: true,
        maxRetries: 3,
        shouldSwitch: true,
        message: "Network error",
      }
    }

    // Unknown - don't trigger fallback, let existing error handling deal with it
    return {
      class: ErrorClass.UNKNOWN,
      shouldRetry: error.data?.isRetryable ?? false,
      maxRetries: error.data?.isRetryable ? 3 : 0,
      shouldSwitch: false,
      message: error.data?.message ?? "Unknown error",
    }
  }
}
