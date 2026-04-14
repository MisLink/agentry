---
name: go-code-style
description: >
  Go code style and formatting conventions for writing clean, idiomatic Go.
  Covers line length (120), gofumpt formatting, three-group import ordering
  (stdlib/third-party/local module), receiver naming (≤2 chars), error handling,
  type assertions, error wrapping, function complexity, struct layout, and
  table-driven test patterns. MUST be loaded whenever writing, editing, reviewing,
  or refactoring Go code (.go files). Also trigger when the user asks about Go
  code style, Go formatting, Go naming conventions, Go lint rules, golangci-lint
  configuration, revive rules, or staticcheck settings. This skill applies to ALL
  Go code tasks — even if the user just says "write a function" or "fix this bug"
  in a Go project, load this skill to ensure the output follows consistent style.
  Complements use-modern-go (version-specific language features).
---

# Go Code Style Guide

Idiomatic Go style conventions. Follow these when writing or reviewing Go code.

## Formatting

### Line Length

Keep lines ≤ **120 characters**. Break long lines at natural boundaries:

```go
// Good: break at parameters
func processItems(
    ctx context.Context,
    items []Item,
    opts ...Option,
) (Result, error) {

// Good: break at chained conditions
if err != nil &&
    !errors.Is(err, ErrNotFound) &&
    !errors.Is(err, ErrTimeout) {
```

### Formatter: gofumpt

Use `gofumpt` (stricter superset of `gofmt`) with extra rules enabled. Key differences from `gofmt`:

- No empty lines at the start/end of function bodies
- No empty lines around a lone statement in a block
- `//` comment directives must have no leading space
- Composite literals with only one field per line must have trailing commas
- `interface{}` → `any` (Go 1.18+)

### Import Grouping

Group imports in three blocks separated by blank lines, in this order:

1. **Standard library** (`fmt`, `os`, `net/http`, ...)
2. **Third-party** — everything outside stdlib and your own module (`github.com/...`, `golang.org/x/...`)
3. **Local module** — packages under your own module path (as declared in `go.mod`)

```go
import (
    "context"
    "fmt"
    "os"

    "github.com/spf13/cobra"
    "golang.org/x/sync/errgroup"

    "github.com/yourorg/yourproject/internal/config"
    "github.com/yourorg/yourproject/pkg/util"
)
```

The distinction between group 2 and 3: if the import path starts with your `go.mod` module path, it's group 3. Everything else external is group 2.

Never mix groups. Never use dot imports except in test files using a testing DSL.

## Naming

### Receiver Names

Receiver names must be **1-2 characters**, typically an abbreviation of the type name. Never use `self` or `this`.

```go
// Good
func (s *Server) Start() error { ... }
func (c *Client) Do(req *Request) (*Response, error) { ... }
func (tx *Tx) Commit() error { ... }

// Bad
func (server *Server) Start() error { ... }
func (this *Client) Do(req *Request) (*Response, error) { ... }
```

Use the same receiver name consistently across all methods of a type.

### General Naming

- **Packages**: short, lowercase, single-word. No underscores, no camelCase. The package name is part of the API: `http.Client`, not `httputil.HTTPClient`.
- **Interfaces**: name by the method they expose. Single-method interfaces use `-er` suffix: `Reader`, `Writer`, `Closer`, `Stringer`.
- **Local variables**: short names for small scopes (`i`, `n`, `err`, `ctx`, `buf`). Longer names for larger scopes.
- **Exported symbols**: descriptive but not redundant with the package name. `config.Server`, not `config.ConfigServer`.
- **Acronyms**: all-caps for short ones (`ID`, `URL`, `HTTP`, `API`), title-case for long ones or when readability suffers.
- **Error variables**: `Err` prefix for sentinel errors: `var ErrNotFound = errors.New("not found")`.
- **Error types**: `Error` suffix: `type ValidationError struct { ... }`.

## Error Handling

### Always Check Errors

Check every returned error. The only exceptions where ignoring is acceptable:

```go
// OK to ignore: fmt print family (output side effects only)
fmt.Println("starting server")
fmt.Fprintf(w, "hello %s", name)

// OK to ignore: explicit discard with comment explaining why
_ = conn.Close() // best-effort cleanup, error already logged
```

Everything else: **check the error**.

### Type Assertions

Always use the two-value form unless you're certain the type is correct:

```go
// Good: safe assertion
v, ok := x.(string)
if !ok {
    return fmt.Errorf("expected string, got %T", x)
}

// Acceptable: when the result is intentionally discarded
_ = x.(io.Closer) // just checking interface satisfaction
```

### Error Wrapping

Wrap errors with context using `fmt.Errorf("...: %w", err)`. The message should describe what the current function was doing, not repeat what failed:

```go
// Good
func (s *Store) GetUser(id string) (*User, error) {
    u, err := s.db.QueryUser(id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return u, nil
}

// Bad: redundant, doesn't add context
if err != nil {
    return nil, fmt.Errorf("QueryUser failed: %w", err)
}
```

## Struct & Interface Design

### Keep Interfaces Small

Prefer small, focused interfaces. Accept interfaces, return concrete types:

```go
// Good: small, composable
type Reader interface { Read(p []byte) (n int, err error) }
type Closer interface { Close() error }

// Good: compose when needed
type ReadCloser interface {
    Reader
    Closer
}
```

### Struct Field Order

Group fields logically, not alphabetically. Put the most important / most accessed fields first. Separate groups with blank lines:

```go
type Server struct {
    addr    string
    handler http.Handler

    mu       sync.Mutex
    conns    map[string]*Conn
    shutdown bool

    logger *slog.Logger
}
```

## Function Design

### Keep Functions Focused

Functions should do one thing and do it well. As a practical guideline, watch for these signs that a function is too complex:

- **Deep nesting** (3+ levels of `if`/`for`/`switch`) — extract inner blocks into helper functions
- **Multiple unrelated responsibilities** — split into separate functions
- **Hard to name** — if you can't summarize what it does in a short phrase, it's doing too much

When a function grows complex, prefer extracting well-named helpers over adding comments to explain the flow:

```go
// Bad: one big function with deep nesting
func (s *Syncer) Sync(ctx context.Context) error {
    for _, src := range s.sources {
        items, err := src.List(ctx)
        if err != nil { ... }
        for _, item := range items {
            if item.NeedsUpdate() {
                if err := s.update(ctx, item); err != nil {
                    // deeply nested error handling...
                }
            }
        }
    }
}

// Good: flat, each step is a named function
func (s *Syncer) Sync(ctx context.Context) error {
    for _, src := range s.sources {
        if err := s.syncSource(ctx, src); err != nil {
            return fmt.Errorf("sync %s: %w", src.Name(), err)
        }
    }
    return nil
}
```

### Named Returns

Use named returns sparingly and only when they genuinely improve readability (e.g., documenting what two `int` return values mean). Bare returns are acceptable in short functions with named return values.

```go
// Named returns helpful: clarifies what two ints mean
func ParseSize(s string) (width, height int, err error) { ... }

// Don't bother: obvious from context
func Open(path string) (*File, error) { ... }
```

### Option Pattern

For functions with many optional parameters, use the functional options pattern:

```go
type Option func(*config)

func WithTimeout(d time.Duration) Option {
    return func(c *config) { c.timeout = d }
}

func New(addr string, opts ...Option) *Client { ... }
```

## Testing

### Table-Driven Tests

Prefer table-driven tests for cases with multiple inputs/outputs:

```go
func TestParseDuration(t *testing.T) {
    tests := []struct {
        name    string
        input   string
        want    time.Duration
        wantErr bool
    }{
        {name: "seconds", input: "5s", want: 5 * time.Second},
        {name: "empty", input: "", wantErr: true},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := ParseDuration(tt.input)
            if (err != nil) != tt.wantErr {
                t.Fatalf("ParseDuration(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
            }
            if got != tt.want {
                t.Errorf("ParseDuration(%q) = %v, want %v", tt.input, got, tt.want)
            }
        })
    }
}
```

### Test Naming

- Test functions: `TestFunctionName_Scenario`
- Subtests: short, descriptive: `"empty input"`, `"negative value"`, `"with timeout"`
- Test files: `*_test.go` in the same package (white-box) or `_test` package (black-box)

## Comments

Don't require doc comments on every exported symbol — comment when it adds value. Avoid comments that just repeat the name:

```go
// Bad: adds nothing
// Start starts the server.
func (s *Server) Start() error { ... }

// Good: explains non-obvious behavior
// Start begins listening on the configured address. It blocks until
// the context is cancelled or an unrecoverable error occurs.
func (s *Server) Start(ctx context.Context) error { ... }
```

Package-level comments are optional. When present, put them in `doc.go`.

## Summary Checklist

When writing or reviewing Go code, verify:

- [ ] Lines ≤ 120 characters
- [ ] Imports grouped: stdlib → third-party → local module
- [ ] Receiver names 1-2 chars, consistent across type
- [ ] Errors checked (except fmt.Print family)
- [ ] Type assertions use two-value form
- [ ] Errors wrapped with context via `%w`
- [ ] Functions are focused — avoid deep nesting, extract helpers
- [ ] Interfaces are small and focused
- [ ] Test cases use table-driven pattern where appropriate
