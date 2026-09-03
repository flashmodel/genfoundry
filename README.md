# GenFoundry

GenFoundry is a lightweight, cross-platform agent supervisor and process orchestration SDK designed to supervise, bridge, and control external CLI-based AI coding agents.

## Overview

Modern AI coding agents (such as Claude Code, Codex, OpenCode, and Pi) are packaged as standalone command-line tools that interact through various protocols (streaming NDJSON, JSON-RPC over stdio, or ACP/HTTP). 

GenFoundry acts as the **Supervisor Layer** between client applications (such as VS Code extensions, Sublime Text plugins, IDEs, or automated pipelines) and these agent CLI subprocesses.

### Core Supervisor Capabilities

- **Process Lifecycle Management**: Non-blocking child process spawning, graceful termination, signal-based interrupts, and automatic reconnects.
- **Protocol Normalization**: Unifies streaming event protocols into standard typed event streams (`text`, `tool_use`, `tool_result`, `thinking`, `plan_delta`, `error`, `result`).
- **Control & Permission Arbitration**: Handles interactive tool approvals (`allow` / `deny` / edits) and user intervention requests asynchronously.
- **Mode & State Control**: Manages agent operational modes including Plan Mode (`setPlanMode`), Approval Mode (`setApproveMode`), Model selection (`setModel`), and disallowed tools configuration.
- **Session Continuity**: Discovers workspace session histories, extracts session tails, and supports stateful turn rewinds.
- **Environment & CLI Discovery**: Cross-platform resolution of agent binaries and non-interactive automated installation scripts.

## Repository Structure

To support multi-language implementations while keeping the top-level directory clean and extensible, implementations reside under `packages/`:

```
genfoundry/
├── packages/
│   ├── genfoundry-ts/       # TypeScript / Node.js supervisor implementation
│   └── (genfoundry-py/)     # Python supervisor implementation (future)
├── .gitignore
└── README.md
```

## Packages

- **[`@genfoundry/ts`](./packages/genfoundry-ts)**: Pure Node.js implementation with minimal dependencies, fully typed with TypeScript.

## Supported Agents

| Agent | CLI / Binary | Communication Protocol | Key Features |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `claude` | Streaming JSON over stdio | Turn-level streaming, tool approvals, session tail inspection, rewinding |
| **Codex** | `codex app-server` | JSON-RPC over stdio | `thread/start`, `thread/turn`, plan mode updates, execution approval |
| **OpenCode** | `opencode` | HTTP / ACP / stdio | Agent Client Protocol (ACP), file diff generation, tool execution |
| **Pi Agent** | `pi` | JSON-RPC / stdio | Interactive session streaming, tool control, local command execution |
