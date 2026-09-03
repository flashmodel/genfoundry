import { spawn, ChildProcess, exec } from 'child_process';
import { BaseAgent, Message, PermissionResult, SessionInfo, SessionTail } from './base-agent';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { logger } from './logger';

export function findPiCli(): string {
    const commonPaths: string[] = [];
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA;
        if (appData) {
            commonPaths.push(
                path.join(appData, 'npm', 'pi.cmd'),
                path.join(appData, 'npm', 'pi')
            );
        }
    } else {
        const home = os.homedir();
        commonPaths.push(
            path.join(home, '.local', 'bin', 'pi'),
            path.join(home, '.npm-global', 'bin', 'pi'),
            path.join(home, '.yarn', 'bin', 'pi'),
            path.join(home, '.bun', 'bin', 'pi'),
            '/usr/local/bin/pi',
            '/usr/bin/pi',
            '/opt/homebrew/bin/pi',
            '/home/linuxbrew/.linuxbrew/bin/pi'
        );
    }

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return 'pi'; // Fallback to PATH
}

function versionGreaterOrEqual(versionStr: string, targetStr: string): boolean {
    try {
        const parseVersion = (v: string) => v.split('.').map(x => parseInt(x, 10));
        const v = parseVersion(versionStr);
        const t = parseVersion(targetStr);
        for (let i = 0; i < Math.max(v.length, t.length); i++) {
            const vPart = v[i] || 0;
            const tPart = t[i] || 0;
            if (vPart > tPart) return true;
            if (vPart < tPart) return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

export class PiAgent extends BaseAgent {
    private process: ChildProcess | null = null;
    private isConnected: boolean = false;
    private cliPath: string;

    constructor(cwd: string, cliPath?: string, env?: Record<string, string>, addDirs?: string[], sessionId?: string) {
        super(cwd, env, addDirs, sessionId);
        this.cliPath = cliPath || findPiCli();
    }

    private async getSessionFlag(): Promise<string> {
        try {
            const versionOut = await new Promise<string>((resolve, reject) => {
                exec(`${this.cliPath} --version`, { encoding: 'utf-8', windowsHide: true }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve((stdout.toString() + '\n' + stderr.toString()).trim());
                    }
                });
            });
            const match = versionOut.match(/(\d+\.\d+\.\d+)/);
            if (match) {
                if (!versionGreaterOrEqual(match[1], '0.76.0')) {
                    return '--session';
                }
            }
        } catch (e) {
            logger.error(`Failed to check pi version: ${e}`);
        }
        return '--session-id';
    }

    async connect(prompt?: string): Promise<void> {
        if (this.isConnected) {
            return;
        }

        logger.info(`PiAgent connecting with path: ${this.cliPath}`);

        const cmdArgs = ['--mode', 'rpc'];

        if (this.sessionId) {
            const flag = await this.getSessionFlag();
            cmdArgs.push(flag, this.sessionId);
        }

        const extRoot = path.join(__dirname, '..', 'termmate-lib', 'extensions');
        for (const extName of ['pi-plan-mode', 'termchat']) {
            const extPath = path.join(extRoot, extName);
            if (fs.existsSync(extPath)) {
                cmdArgs.push('--extension', extPath);
            }
        }

        if (this.planMode) {
            cmdArgs.push('--plan');
        }

        let systemPrompt = '';
        if (this.addDirs && this.addDirs.length > 0) {
            const dirsStr = this.addDirs.map(d => `- ${d}`).join('\n');
            systemPrompt += `\n\nYou also have access to the following additional workspace directories:\n${dirsStr}\nYou can read, write, search, or run shell commands in these directories using their absolute paths.`;
        }

        if (systemPrompt) {
            cmdArgs.push('--append-system-prompt', systemPrompt);
        }

        const spawnEnv = { ...process.env, ...this.env, PI_TERMMATE_APPROVE_MODE: this.approveMode };

        this.process = spawn(this.cliPath, cmdArgs, {
            env: spawnEnv,
            cwd: this.cwd || process.cwd(),
            shell: process.platform === 'win32'
        });

        this.process.on('error', (err) => {
            logger.error(`PiAgent process error: ${err.message}`);
            this.emitError(err);
        });

        this.process.on('close', (code) => {
            logger.info(`PiAgent process closed with code: ${code}`);
            this.isConnected = false;
            this.emitClose(code);
        });

        if (this.process.stdout) {
            const rl = readline.createInterface({
                input: this.process.stdout,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (!line.trim()) return;
                try {
                    const data = JSON.parse(line);
                    this.handleIncomingData(data);
                } catch (e) {
                    logger.error(`PiAgent JSON parse error: ${e} Line: ${line}`);
                }
            });
        }

        if (this.process.stderr) {
            this.process.stderr.on('data', (data) => {
                logger.warn(`PiAgent STDERR: ${data}`);
            });
        }

        this.isConnected = true;

        if (prompt) {
            await this.sendMessage(prompt);
        }

        // Request available models
        this.writeJson({
            type: 'get_available_models',
            id: randomUUID()
        });

        // Request state to capture sessionId
        this.writeJson({
            type: 'get_state',
            id: randomUUID()
        });
    }

    private extractError(errStr: any): string {
        if (!errStr) return "Unknown error";
        let extracted = errStr;
        for (let i = 0; i < 3; i++) {
            try {
                let parsed = typeof extracted === 'string' ? JSON.parse(extracted) : extracted;
                if (typeof parsed === 'object' && parsed !== null) {
                    if (parsed.error && typeof parsed.error === 'object') {
                        extracted = parsed.error.message || extracted;
                    } else if (parsed.message) {
                        extracted = parsed.message;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
        }
        return String(extracted).trim() || String(errStr);
    }

    private handleIncomingData(data: any) {
        const msgType = data.type || 'unknown';
        const msgId = data.id || data.uuid;

        logger.debug(`PiAgent incoming: type=${msgType}, id=${msgId}`);

        if (msgType === 'auto_retry_start') {
            const attempt = data.attempt;
            const maxAttempts = data.maxAttempts;
            const delay = (data.delayMs || 0) / 1000.0;
            const errMsg = this.extractError(data.errorMessage || '');
            const msg = `\n⚠️ Request failed (${errMsg}). Retrying (attempt ${attempt}/${maxAttempts}) in ${delay}s...\n`;
            this.emitMessage({ type: 'text_delta', content: msg, id: msgId });
            return;
        }

        if (msgType === 'auto_retry_end') {
            if (!data.success) {
                const err = this.extractError(data.finalError || '');
                this.emitMessage({ type: 'error', content: `Auto retry failed after ${data.attempt} attempts.\n${err}`, id: msgId });
            }
            return;
        }

        if (msgType === 'response') {
            if (!data.success) {
                this.emitMessage({ type: 'error', content: data.error || 'Unknown RPC error', id: msgId });
                return;
            }

            if (data.command === 'get_available_models') {
                const modelsData = data.data?.models || [];
                const termModels = modelsData.map((m: any) => {
                    const provider = m.provider || 'unknown';
                    const modelId = m.id || 'unknown';
                    return {
                        displayName: `[${provider}]${m.name || modelId}`,
                        description: m.description || '',
                        value: `${provider}/${modelId}`
                    };
                });
                this.emitMessage({ type: 'models_update', content: { models: termModels }, id: msgId });
                return;
            }

            if (data.command === 'get_state') {
                const sessionId = data.data?.sessionId;
                if (sessionId) {
                    this.sessionId = sessionId;
                    this.emitMessage({ type: 'system', content: { subtype: 'session_started', session_id: sessionId }, id: msgId });
                }
                return;
            }

            return; // Silently ignore other successful RPC responses (like set_model, steer, abort)
        }

        if (msgType === 'extension_ui_request') {
            const method = data.method || 'unknown';
            const reqId = data.id || msgId;
            let toolName = `extension_ui_${method}`;
            let input = data;

            // The termchat extension encodes tool permission requests as a
            // confirm with title "Tool Permission: <tool>" and a JSON message
            // { toolName, input }. Unwrap it here (mirroring codeform's
            // chatprocessor.py) so the approve-mode gate and the UI both see
            // the real tool call. Capitalize built-in names to match the
            // Claude/Codex conventions used by riskyTools and the renderer.
            if (method === 'confirm' && typeof data.title === 'string' && data.title.startsWith('Tool Permission: ')) {
                try {
                    const parsed = JSON.parse(data.message || '{}');
                    if (parsed.toolName) {
                        const builtins = ['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls'];
                        toolName = builtins.includes(parsed.toolName)
                            ? parsed.toolName.charAt(0).toUpperCase() + parsed.toolName.slice(1)
                            : parsed.toolName;
                        input = parsed.input || {};
                    }
                } catch (e) {
                    logger.error(`Failed to parse termchat tool permission request: ${e}`);
                }
            }

            this.emitMessage({
                type: 'control_request' as const,
                content: {
                    request_id: reqId,
                    request: {
                        tool_name: toolName,
                        input
                    }
                },
                id: msgId
            });
            return;
        }

        if (msgType === 'message_update') {
            const eventType = data.assistantMessageEvent?.type;
            if (eventType === 'text_delta') {
                const deltaText = data.assistantMessageEvent?.delta || '';
                if (deltaText) {
                    this.emitMessage({ type: 'text_delta', content: deltaText, id: msgId });
                }
            } else if (eventType === 'text_end') {
                this.emitMessage({ type: 'text_end', content: '', id: msgId });
            } else if (eventType === 'thinking_start') {
                this.emitMessage({ type: 'thinking_start', content: '', id: msgId });
            } else if (eventType === 'thinking_delta') {
                const deltaText = data.assistantMessageEvent?.delta || '';
                this.emitMessage({ type: 'thinking_delta', content: deltaText, id: msgId });
            }
            return;
        }

        if (msgType === 'message_end') {
            const role = data.message?.role;
            if (role === 'assistant') {
                const contentBlocks = data.message?.content || [];
                const blocks: any[] = [];
                for (const block of contentBlocks) {
                    if (block.type === 'toolCall') {
                        blocks.push({ ...block, type: 'tool_use' });
                    }
                }

                for (const block of blocks) {
                    if (block.type === 'tool_use') {
                        this.emitMessage({ type: 'tool_use', content: block, id: data.message?.id });
                    }
                }
            } else if (role === 'toolResult') {
                const toolName = data.message?.toolName;
                if (toolName === 'edit' || toolName === 'write') {
                    this.emitMessage({ type: 'tool_result', content: {
                        toolCallId: data.message?.toolCallId,
                        toolName,
                        isError: data.message?.isError,
                        details: data.message?.details,
                    }, id: msgId });
                }
            }

            // Check for proposed-plan custom messages from pi-plan-mode
            if (data.message?.customType === 'proposed-plan') {
                this.emitMessage({ type: 'proposed-plan', content: data.message?.content || '', id: data.message?.id || msgId });
            }

            return;
        }

        if (msgType === 'agent_end') {
            if (data.errorMessage) {
                logger.info(`PiAgent ended with error: ${data.errorMessage}`);
            } else {
                logger.info(`PiAgent ended successfully.`);
            }
            this.emitMessage({ type: 'result', content: { success: !data.errorMessage }, id: msgId });
            return;
        }
        
        // Pass control requests from tool calls handled by pi natively? Pi handles permissions via standard pi CLI stdio, but 
        // wait, `pi` CLI natively prompts for permissions on its stdout/stdin when NOT in MCP mode unless configured otherwise.
        // Actually pi `--mode rpc` handles permissions automatically? In `codeform`, it seems pi agent doesn't send `control_request` to the extension, 
        // instead `pi` might prompt in the terminal, but since we are using rpc, it probably either uses `extension_ui_request` or has auto-approval.
        // `pi_agent.py` does not handle `control_request`.

        const content = data.content || data.message || data;
        this.emitMessage({ type: msgType, content, id: msgId });
    }

    async sendMessage(content: string, parentToolUseId?: string, proceedPlan?: boolean): Promise<void> {
        logger.info(`PiAgent sendMessage: ${content}`);
        if (!this.isConnected || !this.process || !this.process.stdin) {
            logger.error('Pi process is not running');
            throw new Error('Pi process is not running');
        }

        const message: any = {
            type: 'prompt',
            message: content,
            id: randomUUID()
        };

        if (parentToolUseId) {
            message.parent_tool_use_id = parentToolUseId;
        }

        if (this.sessionId) {
            message.session_id = this.sessionId;
        }

        this.writeJson(message);
    }

    async steer(text: string, proceedPlan?: boolean): Promise<void> {
        logger.info(`PiAgent steer: ${text}`);
        if (!this.isConnected) return;
        
        if (proceedPlan) {
            this.planMode = false;
            const message: any = {
                type: 'prompt',
                message: '/plan implement',
                id: randomUUID()
            };
            if (this.sessionId) {
                message.session_id = this.sessionId;
            }
            this.writeJson(message);
            return;
        }

        this.writeJson({
            type: 'steer',
            message: text
        });
    }

    async setModel(model: string | null): Promise<void> {
        if (!this.isConnected || !model) return;
        
        let provider = 'anthropic';
        let modelId = model;
        
        if (model.includes('/')) {
            const parts = model.split('/');
            provider = parts[0];
            modelId = parts.slice(1).join('/');
        } else if (model.includes(':')) {
            const parts = model.split(':');
            provider = parts[0];
            modelId = parts.slice(1).join(':');
        }
        
        this.writeJson({
            type: 'set_model',
            provider,
            modelId,
            id: randomUUID()
        });
    }

    async setPlanMode(enabled: boolean): Promise<void> {
        if (!enabled && this.planMode && this.isConnected) {
            this.planMode = false;
            const message: any = {
                type: 'prompt',
                message: '/plan exit',
                id: randomUUID()
            };
            if (this.sessionId) {
                message.session_id = this.sessionId;
            }
            this.writeJson(message);
        } else {
            this.planMode = enabled;
        }
    }

    async setApproveMode(mode: 'default' | 'accept-all' | 'allow-edit'): Promise<void> {
        this.approveMode = mode;
        if (this.isConnected) {
            await this.sendMessage(`/termchat-setting approve_mode=${mode}`);
        }
    }

    async interrupt(): Promise<void> {
        if (this.isConnected) {
            logger.info('PiAgent: Sending abort command');
            this.writeJson({ type: 'abort' });
        }
    }

    async respondToControlRequest(requestId: string, result: PermissionResult): Promise<void> {
        logger.info(`PiAgent respondToControlRequest: ${requestId}`, result);
        // Map common control_request approval format to Pi's extension_ui_response
        const confirmed = result.behavior === 'allow';
        this.writeJson({
            type: 'extension_ui_response',
            id: requestId,
            confirmed: confirmed,
            cancelled: !confirmed,
            value: result.updatedInput ? result.updatedInput : undefined
        });
    }

    private writeJson(data: any) {
        if (this.process && this.process.stdin) {
            this.process.stdin.write(JSON.stringify(data) + '\n');
        }
    }

    disconnect(): void {
        if (this.process) {
            logger.info('PiAgent disconnecting...');
            this.process.kill();
            this.process = null;
        }
        this.isConnected = false;
    }

    static listSessions(cwd?: string): SessionInfo[] {
        const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');
        if (!fs.existsSync(sessionsRoot)) return [];

        const results: SessionInfo[] = [];
        let searchDirs: string[];
        if (cwd) {
            const sanitized = cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
            searchDirs = [path.join(sessionsRoot, `--${sanitized}--`)];
        } else {
            try {
                searchDirs = fs.readdirSync(sessionsRoot)
                    .map(e => path.join(sessionsRoot, e))
                    .filter(e => { try { return fs.statSync(e).isDirectory(); } catch { return false; } });
            } catch { return []; }
        }

        for (const dir of searchDirs) {
            try {
                for (const name of fs.readdirSync(dir)) {
                    if (!name.endsWith('.jsonl') && !name.endsWith('.json')) continue;
                    const filePath = path.join(dir, name);
                    try {
                        const stat = fs.statSync(filePath);
                        if (name.endsWith('.jsonl')) {
                            let sessionId: string | null = null;
                            let sessionName: string | null = null;
                            let firstPrompt: string | null = null;
                            let mtime = stat.mtimeMs / 1000;

                            for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
                                if (!rawLine.trim()) continue;
                                let entry: any;
                                try { entry = JSON.parse(rawLine); } catch { continue; }
                                if (entry.type === 'session' && !sessionId) {
                                    sessionId = entry.id;
                                } else if (entry.type === 'session_info') {
                                    const value = (entry.name || '').trim();
                                    sessionName = value || null;
                                } else if (entry.type === 'message') {
                                    const message = entry.message || {};
                                    const timestamp = message.timestamp;
                                    if (typeof timestamp === 'number' && timestamp > 0) {
                                        mtime = Math.max(mtime, timestamp / 1000);
                                    }
                                    if (!firstPrompt && message.role === 'user') {
                                        const content = message.content;
                                        const text = typeof content === 'string'
                                            ? content
                                            : (Array.isArray(content)
                                                ? content.filter((block: any) => block?.type === 'text').map((block: any) => block.text || '').join('')
                                                : '');
                                        firstPrompt = text.trim() || null;
                                    }
                                }
                            }

                            if (sessionId) {
                                const summary = sessionName || firstPrompt || sessionId.slice(0, 8);
                                results.push({ session_id: sessionId, mtime, summary, agentType: 'pi' });
                            }
                        } else {
                            // Backward compatibility with the older single-JSON format.
                            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                            const sessionId = data.id || data.sessionId || name.slice(0, -5);
                            const firstUserMessage = Array.isArray(data.messages)
                                ? data.messages.find((message: any) => message.role === 'user')
                                : undefined;
                            const firstContent = firstUserMessage?.content;
                            const firstPrompt = typeof firstContent === 'string'
                                ? firstContent
                                : (Array.isArray(firstContent)
                                    ? firstContent.filter((block: any) => block?.type === 'text').map((block: any) => block.text || '').join('')
                                    : '');
                            const summary = data.title || data.summary || firstPrompt || sessionId.slice(0, 8);
                            results.push({ session_id: sessionId, mtime: stat.mtimeMs / 1000, summary, agentType: 'pi' });
                        }
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        }

        results.sort((a, b) => b.mtime - a.mtime);
        return results;
    }

    static getSessionTail(sessionId: string, cwd?: string, historyLimit = 1): SessionTail | null {
        const sessionsRoot = path.join(os.homedir(), '.pi', 'agent', 'sessions');
        if (!fs.existsSync(sessionsRoot)) return null;

        let searchDirs: string[];
        if (cwd) {
            const sanitized = cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-');
            searchDirs = [path.join(sessionsRoot, `--${sanitized}--`)];
        } else {
            try {
                searchDirs = fs.readdirSync(sessionsRoot)
                    .map(e => path.join(sessionsRoot, e))
                    .filter(e => { try { return fs.statSync(e).isDirectory(); } catch { return false; } });
            } catch { return null; }
        }

        const extractText = (msgContent: any): string => {
            if (typeof msgContent === 'string') return msgContent;
            if (Array.isArray(msgContent)) {
                return msgContent
                    .filter((b: any) => b && typeof b === 'object' && b.type === 'text')
                    .map((b: any) => b.text || '')
                    .join('');
            }
            return '';
        };

        const makeHistory = (rawMsgs: any[]): SessionTail | null => {
            const turns: Array<{ prompt: string | null, response: string | null }> = [];
            let current: { prompt: string | null, response: string | null } | null = null;
            for (const raw of rawMsgs) {
                const message = raw?.message || raw || {};
                const role = message.role || raw?.role;
                const content = message.content !== undefined ? message.content : raw?.content;
                const text = extractText(content).trim();
                if (!text) continue;
                if (role === 'user') {
                    if (current) turns.push(current);
                    current = { prompt: text, response: null };
                } else if (role === 'assistant' && current) {
                    current.response = current.response ? `${current.response}\n\n${text}` : text;
                }
            }
            if (current) turns.push(current);
            const recent = historyLimit > 0 ? turns.slice(-historyLimit) : turns;
            const last = recent[recent.length - 1];
            return last ? { prompt: last.prompt, response: last.response, turns: recent } : null;
        };

        for (const dir of searchDirs) {
            if (!fs.existsSync(dir)) continue;
            for (const name of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
                if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
                const filePath = path.join(dir, name);
                if (name.endsWith('.jsonl')) {
                    const entries: any[] = [];
                    let id: string | null = null;
                    try {
                        for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
                            if (!line.trim()) continue;
                            const entry = JSON.parse(line);
                            if (entry.type === 'session' && !id) id = entry.id;
                            else if (entry.type === 'message') entries.push(entry);
                        }
                    } catch { continue; }
                    if (id === sessionId) return makeHistory(entries);
                } else {
                    let data: any;
                    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
                    const id = data.id || data.sessionId || name.slice(0, -5);
                    if (id === sessionId) return makeHistory(Array.isArray(data.messages) ? data.messages : []);
                }
            }
        }
        return null;
    }
}
