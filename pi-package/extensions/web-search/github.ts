export type GitHubFetchPlan =
  | {
      kind: "none"
    }
  | {
      kind: "raw-file"
      rawUrl: string
    }
  | {
      kind: "repo-readme"
      owner: string
      repo: string
      readmeUrls: string[]
    }
  | {
      kind: "tree"
      owner: string
      repo: string
      path: string
      treeUrl: string
    }

function normalizeRepoSegment(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function resolveGitHubFetchPlan(url: string): GitHubFetchPlan {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: "none" }
  }

  if (parsed.hostname !== "github.com") return { kind: "none" }

  const segments = parsed.pathname.split("/").filter(Boolean)
  const owner = normalizeRepoSegment(segments[0])
  const repo = normalizeRepoSegment(segments[1])
  if (!owner || !repo) return { kind: "none" }

  if (segments.length === 2) {
    return {
      kind: "repo-readme",
      owner,
      repo,
      readmeUrls: [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`,
      ],
    }
  }

  if (segments[2] === "blob" && segments.length >= 5) {
    const ref = segments[3]
    const filePath = segments.slice(4).join("/")
    return {
      kind: "raw-file",
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
    }
  }

  if (segments[2] === "tree" && segments.length >= 5) {
    return {
      kind: "tree",
      owner,
      repo,
      path: segments.slice(4).join("/"),
      treeUrl: url,
    }
  }

  return { kind: "none" }
}
