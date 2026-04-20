# 🛠️ MCP Session Recovery Implementation Guide

This document outlines the technical strategies for resolving the "Session not
found" error in the `gemini-cli`. This error typically occurs when a remote MCP
server restarts, invalidating the active session ID while the CLI client remains
attached to a stale transport.

---

## 🛑 Problem Statement

The `gemini-cli`'s `McpClient` implementation is currently passive. When a
connection drops or a server restarts:

1.  The transport (Stdio or SSE) is broken.
2.  The `McpClient` marks itself as `DISCONNECTED`.
3.  The `McpCallableTool` (which the agent holds) continues to use a stale
    reference to the underlying SDK `Client`.
4.  Tool calls fail with "Session not found" or `ECONNRESET`.

---

## 🧪 Strategy 1: The Surgical Patch (Minimal Churn)

**Goal:** The fastest possible fix with minimal changes to the existing
architecture.

### Logic & Flow

This approach adds a "reconnect callback" to the `McpCallableTool`. Instead of
refactoring the entire client wrapper, we catch the specific session error
directly during tool execution and trigger a single-retry reconnection.

### Key Code Changes

#### 1. Update `McpCallableTool`

Modify `packages/core/src/tools/mcp-client.ts` to allow updating the internal
`client` and accepting a reconnect closure.

```typescript
class McpCallableTool implements CallableTool {
  constructor(
    private client: Client, // Remove 'readonly'
    private readonly toolDef: McpTool,
    private readonly timeout: number,
    private readonly progressReporter?: McpProgressReporter,
    private readonly reconnectAndGetClient?: () => Promise<Client>, // NEW
  ) {}

  async callTool(functionCalls: FunctionCall[]): Promise<Part[]> {
    const call = functionCalls[0];
    const progressToken = randomUUID();
    let retries = 1;

    while (retries >= 0) {
      try {
        const result = await this.client.callTool(
          {
            name: call.name!,
            arguments: call.args as Record<string, unknown>,
            _meta: { progressToken },
          },
          undefined,
          { timeout: this.timeout },
        );
        return [{ functionResponse: { name: call.name, response: result } }];
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isSessionError =
          errorMsg.includes('Session not found') ||
          errorMsg.includes('ECONNRESET');

        if (isSessionError && retries > 0 && this.reconnectAndGetClient) {
          debugLogger.warn(
            `Caught session error for ${call.name}, attempting reconnect...`,
          );
          try {
            this.client = await this.reconnectAndGetClient();
            retries--;
            continue;
          } catch (reconnectError) {
            return [
              {
                functionResponse: {
                  name: call.name,
                  response: {
                    error: {
                      message: `Reconnect failed: ${String(reconnectError)}`,
                      isError: true,
                    },
                  },
                },
              },
            ];
          }
        }
        return [
          {
            functionResponse: {
              name: call.name,
              response: { error: { message: errorMsg, isError: true } },
            },
          },
        ];
      }
    }
  }
}
```

#### 2. Inject Callback during Discovery

In `discoverTools()`, pass a closure that handles the `disconnect()` and
`connect()` sequence.

### Pros & Cons

- **Pros:** Very localized; extremely low risk of regression for non-tool
  components.
- **Cons:** Leaks connection management into the tool layer. Risk of "thundering
  herd" reconnects if multiple tools fail simultaneously.

---

## 🏛️ Strategy 2: The Architectural Fix (Robust Solution)

**Goal:** A resilient, long-term fix that treats the `McpClient` as a reliable
"Always-On" wrapper.

### Logic & Flow

Refactor `McpClient` to use the **Promise Coalescing** pattern. The
`McpCallableTool` no longer holds a brittle network socket (the SDK `Client`)
but instead holds the `McpClient` wrapper. Every tool call starts by asking the
wrapper for a guaranteed healthy connection.

### Key Code Changes

#### 1. Resilient `McpClient` (The Gatekeeper)

Update `packages/core/src/tools/mcp-client.ts`.

```typescript
private reconnectPromise: Promise<Client> | null = null;

async ensureConnected(): Promise<Client> {
  // 1. Fast path: Already healthy
  if (this.status === MCPServerStatus.CONNECTED && this.client) {
    return this.client;
  }

  // 2. Thundering Herd Protection: Coalesce concurrent reconnects
  if (this.reconnectPromise) {
    return this.reconnectPromise;
  }

  this.reconnectPromise = (async () => {
    try {
      await this.disconnect(); // Kill stale processes/streams
      await this.connect();    // Rebuild transport and re-auth (handles OAuth automatically)

      // 3. Refresh registries for future turns
      const currentRegistries = Array.from(this.registeredRegistries);
      for (const registries of currentRegistries) {
        await this.discoverInto(this.cliConfig, registries);
      }
      return this.client!;
    } finally {
      this.reconnectPromise = null;
    }
  })();

  return this.reconnectPromise;
}

invalidateConnection(): void {
  this.updateStatus(MCPServerStatus.DISCONNECTED);
}
```

#### 2. Refactored `McpCallableTool` (The Consumer)

The tool calls `ensureConnected()` before every execution.

```typescript
class McpCallableTool implements CallableTool {
  constructor(
    private readonly mcpWrapper: McpClient, // Hold the wrapper instead of the raw client
    // ...
  ) {}

  async callTool(functionCalls: FunctionCall[]): Promise<Part[]> {
    let retries = 1;
    while (retries >= 0) {
      try {
        const activeClient = await this.mcpWrapper.ensureConnected();
        const result = await activeClient.callTool(/* ... */);
        return [{ functionResponse: { name: call.name, response: result } }];
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (
          (errorMsg.includes('Session not found') ||
            errorMsg.includes('ECONNRESET')) &&
          retries > 0
        ) {
          this.mcpWrapper.invalidateConnection();
          retries--;
          continue;
        }
        // ... error handling ...
      }
    }
  }
}
```

### Pros & Cons

- **Pros:** Highly resilient. Prevents race conditions. Reuses existing robust
  `connectToMcpServer` logic (Auth, Transport).
- **Cons:** Requires more significant refactoring of the `McpClient` and tool
  instantiation logic.

---

## 🛡️ Safety & Reliability

- **Circuit Breaker:** Both strategies MUST implement a strict `retries = 1`
  limit to avoid infinite loops if a server is permanently down.
- **Authentication:** The `connectToMcpServer` function already handles OAuth
  token retrieval and header injection. Re-running `connect()` natively handles
  authentication refreshes.
- **State Sync:** `McpClient` calls the global `updateMCPServerStatus` function,
  ensuring the CLI UI and `McpClientManager` stay perfectly in sync during
  background reconnections.
