# @genfoundry/ts

TypeScript / Node.js agent supervisor SDK for interacting with CLI-based AI coding agents.

## Installation

```bash
npm install @genfoundry/ts
```

## Quick Start

```typescript
import { ClaudeAgent, CodexAgent, setLogger } from '@genfoundry/ts';

// Optional: inject custom logger (defaults to console)
setLogger({
    debug: (msg, ...args) => console.debug(msg, ...args),
    info: (msg, ...args) => console.info(msg, ...args),
    warn: (msg, ...args) => console.warn(msg, ...args),
    error: (msg, ...args) => console.error(msg, ...args),
});

// Initialize Claude Code Agent
const agent = new ClaudeAgent(process.cwd());

// Listen for normalized streaming events
agent.onMessage((msg) => {
    switch (msg.type) {
        case 'text_delta':
            process.stdout.write(msg.content);
            break;
        case 'tool_use':
            console.log('\n[Tool Use]:', msg.content.name, msg.content.input);
            break;
        case 'control_request':
            // Handle permission approval
            agent.respondToControlRequest(msg.id!, { behavior: 'allow' });
            break;
        case 'result':
            console.log('\n[Finished Turn]');
            break;
    }
});

// Start session
await agent.connect('Explain how the supervisor works');
```

## Supported Agents

- `ClaudeAgent`: Claude Code streaming JSON stdio supervisor.
- `CodexAgent`: OpenAI Codex `app-server` JSON-RPC stdio supervisor.
- `OpenCodeAgent`: OpenCode ACP & HTTP/stdio agent supervisor.
- `PiAgent`: Pi Agent JSON-RPC / stdio supervisor.

## Agent Lifecycle Methods

- `connect(prompt?: string): Promise<void>`: Spawns the CLI child process and starts the session.
- `sendMessage(content: string, parentToolUseId?: string, proceedPlan?: boolean): Promise<void>`: Sends user prompt or turn message.
- `steer(text: string, proceedPlan?: boolean): Promise<void>`: Steers in-flight agent processing.
- `interrupt(): Promise<void>`: Interrupts current turn without closing the process.
- `disconnect(): void`: Terminates the child process and cleans up resources.
- `respondToControlRequest(requestId: string, result: PermissionResult): Promise<void>`: Approves or denies requested tool execution.
- `setPlanMode(enabled: boolean): Promise<void>`: Toggles plan-only mode.
- `setApproveMode(mode: 'default' | 'accept-all' | 'allow-edit'): Promise<void>`: Controls automatic tool execution permissions.
- `rewind(checkpoint: string): Promise<string | null>`: Rolls back the conversation to a previous turn or message ID.
