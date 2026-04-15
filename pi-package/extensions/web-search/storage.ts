import { randomUUID } from "node:crypto"

export type StoredSearchResult = {
  title: string
  url: string
  snippet?: string
}

export type StoredSearchQuery = {
  query: string
  results: StoredSearchResult[]
}

export type StoredFetchContent = {
  url: string
  title: string
  content: string
}

export type StoredWebResponse =
  | {
      type: "search"
      timestamp: number
      queries: StoredSearchQuery[]
    }
  | {
      type: "fetch"
      timestamp: number
      urls: StoredFetchContent[]
    }

export type StoredWebResponseInput =
  | {
      type: "search"
      queries: StoredSearchQuery[]
    }
  | {
      type: "fetch"
      urls: StoredFetchContent[]
    }

const storedResponses = new Map<string, StoredWebResponse>()

export function clearWebSearchStorage(): void {
  storedResponses.clear()
}

export function storeWebResponse(response: StoredWebResponseInput): string {
  const responseId = randomUUID()
  const timestamp = Date.now()
  const stored: StoredWebResponse =
    response.type === "search"
      ? {
          type: "search",
          timestamp,
          queries: response.queries,
        }
      : {
          type: "fetch",
          timestamp,
          urls: response.urls,
        }
  storedResponses.set(responseId, stored)
  return responseId
}

export function getWebResponse(responseId: string): StoredWebResponse | undefined {
  return storedResponses.get(responseId)
}
