// Core Base Agent & Protocol Types
export {
    BaseAgent,
    MessageType,
    SessionInfo,
    SessionTail,
    SessionTurn,
    Message,
    TextBlock,
    AssistantMessage,
    PermissionResult,
} from './base-agent';

// Agent Implementations & CLI Discovery
export { ClaudeAgent, findClaudeCli } from './claude-agent';
export { CodexAgent, findCodexCli, findGitDirs } from './codex-agent';
export type { CodexSandboxMode } from './codex-agent';
export { OpenCodeAgent, findOpenCodeCli } from './opencode-agent';
export { PiAgent, findPiCli } from './pi-agent';

// Logging Adapter
export { ILogger, logger, setLogger } from './logger';

// Agent Detection & Installation
export {
    AgentId,
    AGENT_LABEL,
    AGENT_DOCS_URL,
    InstallInfo,
    findExistingCli,
    getAgentInstallInfo,
} from './install';
