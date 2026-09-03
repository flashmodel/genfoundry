import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { findClaudeCli } from './claude-agent';
import { findCodexCli } from './codex-agent';
import { findPiCli } from './pi-agent';
import { findOpenCodeCli } from './opencode-agent';

export type AgentId = 'claude' | 'codex' | 'opencode' | 'pi';

export const AGENT_LABEL: Record<AgentId, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    pi: 'Pi Agent',
};

export const AGENT_DOCS_URL: Record<AgentId, string> = {
    claude: 'https://code.claude.com/docs/en/setup',
    codex: 'https://developers.openai.com/codex/cli',
    opencode: 'https://opencode.ai/docs/',
    pi: 'https://pi.dev/',
};

const AGENT_CLI_NAME: Record<AgentId, string> = { claude: 'claude', codex: 'codex', opencode: 'opencode', pi: 'pi' };
const AGENT_FIND_FN: Record<AgentId, () => string> = {
    claude: findClaudeCli,
    codex: findCodexCli,
    opencode: findOpenCodeCli,
    pi: findPiCli,
};

/** Resolve a bare command name on PATH (cross-platform `which`). */
function whichSync(cmd: string): string | null {
    try {
        const flag = os.platform() === 'win32' ? 'where' : 'command -v';
        const out = execSync(`${flag} ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim().split(/\r?\n/)[0];
        return out || null;
    } catch {
        return null;
    }
}

/**
 * Return the path to an already-installed agent CLI, or null if not found.
 * Honours a user-configured custom command first.
 */
export function findExistingCli(agent: AgentId, customCommand?: string): string | null {
    if (customCommand) {
        const resolved = fs.existsSync(customCommand) ? customCommand : whichSync(customCommand);
        if (resolved) return resolved;
    }
    const onPath = whichSync(AGENT_CLI_NAME[agent]);
    if (onPath) return onPath;
    // Fall back to the agent's own candidate-path probe; ignore the bare-name fallback.
    const probed = AGENT_FIND_FN[agent]();
    if (probed && probed !== AGENT_CLI_NAME[agent] && fs.existsSync(probed)) return probed;
    return null;
}

export interface InstallInfo {
    displayName: string;
    /** Shell command that installs the CLI to a user-local location. */
    command: string | null;
    /** Whether an automated install is supported on this platform. */
    supported: boolean;
    /** Extra environment variables to inject for a non-interactive install. */
    extraEnv: Record<string, string>;
}

/**
 * Return the local (no-admin) install command for an agent. All *nix installers
 * drop the binary into ~/.local/bin; Windows uses per-user npm/powershell installers.
 */
export function getAgentInstallInfo(agent: AgentId): InstallInfo {
    const home = os.homedir();
    const isWin = os.platform() === 'win32';
    const displayName = AGENT_LABEL[agent];
    const localBin = path.join(home, '.local', 'bin');
    const pathWithLocal = localBin + path.delimiter + (process.env.PATH || '');

    if (agent === 'claude') {
        if (isWin) {
            return { displayName, command: 'npm install -g @anthropic-ai/claude-code', supported: true, extraEnv: {} };
        }
        return {
            displayName,
            command: 'curl -fsSL https://claude.ai/install.sh | bash',
            supported: true,
            extraEnv: { PATH: pathWithLocal },
        };
    }

    if (agent === 'codex') {
        if (isWin) {
            return {
                displayName,
                command: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
                supported: true,
                extraEnv: {},
            };
        }
        return {
            displayName,
            command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
            supported: true,
            extraEnv: { PATH: pathWithLocal, CODEX_NON_INTERACTIVE: '1' },
        };
    }

    if (agent === 'opencode') {
        if (isWin) {
            return { displayName, command: 'npm install -g opencode-ai', supported: true, extraEnv: {} };
        }
        const openCodeBin = path.join(home, '.opencode', 'bin');
        return {
            displayName,
            command: 'curl -fsSL https://opencode.ai/install | bash',
            supported: true,
            extraEnv: { PATH: openCodeBin + path.delimiter + (process.env.PATH || '') },
        };
    }

    if (agent === 'pi') {
        if (isWin) {
            const cmd =
                'powershell -ExecutionPolicy ByPass -c "' +
                'if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {' +
                ' winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements;' +
                " $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')" +
                ' };' +
                ' npm install -g --ignore-scripts --min-release-age=0 @earendil-works/pi-coding-agent' +
                '"';
            return { displayName, command: cmd, supported: true, extraEnv: {} };
        }
        return {
            displayName,
            command: 'curl -fsSL https://pi.dev/install.sh | sh',
            supported: true,
            extraEnv: { PATH: pathWithLocal, PI_NON_INTERACTIVE: '1', CI: '1' },
        };
    }

    return { displayName, command: null, supported: false, extraEnv: {} };
}
