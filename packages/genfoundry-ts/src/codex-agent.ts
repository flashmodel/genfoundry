import { spawn, ChildProcess } from 'child_process';
import { BaseAgent, Message, PermissionResult, SessionInfo, SessionTail } from './base-agent';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';

export function findCodexCli(): string {
    const commonPaths: string[] = [];
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA;
        if (appData) {
            commonPaths.push(
                path.join(appData, 'npm', 'codex.cmd'),
                path.join(appData, 'npm', 'codex')
            );
        }
    } else {
        const home = os.homedir();
        commonPaths.push(
            path.join(home, '.local', 'bin', 'codex'),
            path.join(home, '.npm-global', 'bin', 'codex'),
            path.join(home, '.yarn', 'bin', 'codex'),
            path.join(home, '.bun', 'bin', 'codex'),
            '/usr/local/bin/codex',
            '/usr/bin/codex',
            '/opt/homebrew/bin/codex',
            '/home/linuxbrew/.linuxbrew/bin/codex'
        );
    }

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return 'codex'; // Fallback to PATH
}

export class CodexAgent extends BaseAgent {
    private process: ChildProcess | null = null;
    private isConnected: boolean = false;
    private threadId: string | null = null;
    private activeTurnId: string | null = null;
    private turnCount: number = 0;
    private rpcId: number = 0;
    private pendingResponses: Map<number, { resolve: (result: any) => void, reject: (err: any) => void }> = new Map();
    private itemCache: Map<string, any> = new Map();
    private planText: string = "";
    private model: string | null = null;
    private cliPath: string;

    constructor(cwd: string, cliPath?: string, env?: Record<string, string>, addDirs?: string[], sessionId?: string) {
        super(cwd, env, addDirs, sessionId);
        this.cliPath = cliPath || findCodexCli();
        if (this.sessionId) {
            this.threadId = this.sessionId;
        }
    }

    async connect(prompt?: string): Promise<void> {
        if (this.isConnected) {
            return;
        }

        const cmdArgs = ['app-server'];
        const spawnEnv = { ...process.env, ...this.env };

        try {
            this.process = spawn(this.cliPath, cmdArgs, {
                env: spawnEnv,
                cwd: this.cwd || process.cwd(),
                shell: process.platform === 'win32'
            });
        } catch (e: any) {
            this.emitError(new Error(`Failed to spawn codex at ${this.cliPath}: ${e.message}`));
            return;
        }

        this.process.on('error', (err) => {
            logger.error(`CodexAgent process error: ${err.message}`);
            this.emitError(err);
        });

        this.process.on('close', (code) => {
            logger.info(`CodexAgent process closed with code: ${code}`);
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
                    logger.error(`CodexAgent JSON parse error: ${e} Line: ${line}`);
                }
            });
        }

        this.isConnected = true;

        logger.info('CodexAgent initializing...');
        // JSON-RPC initialize handshake
        await this.rpcRequest("initialize", {
            clientInfo: { name: "termmate-vs", title: "TermMate VS", version: "0.1.0" },
            capabilities: { experimentalApi: true }
        });
        await this.rpcNotify("initialized");

        // Fetch models
        this.fetchModels();

        // Create a thread
        const threadParams: any = { cwd: this.cwd || process.cwd() };
        if (this.approveMode === 'accept-all') {
            threadParams.approvalPolicy = 'never';
        } else {
            threadParams.approvalPolicy = 'untrusted';
        }

        if (this.sessionId) {
            threadParams.threadId = this.sessionId;
        }

        // Configuration overrides
        const configOverrides: any = {};
        if (this.addDirs && this.addDirs.length > 0) {
            configOverrides["sandbox_workspace_write.writable_roots"] = this.addDirs;
        }
        if (this.disallowedTools.includes('AskUserQuestion')) {
            configOverrides["features.default_mode_request_user_input"] = false;
        }

        if (Object.keys(configOverrides).length > 0) {
            threadParams.config = configOverrides;
        }

        logger.info('CodexAgent starting thread', threadParams);
        let method = this.sessionId ? "thread/resume" : "thread/start";
        let result;
        try {
            result = await this.rpcRequest(method, threadParams);
        } catch (err: any) {
            logger.warn(`Failed to resume thread: ${err.message}. Falling back to thread/start.`);
            method = "thread/start";
            delete threadParams.threadId;
            this.sessionId = undefined;
            result = await this.rpcRequest(method, threadParams);
        }
        
        if (result && result.thread) {
            this.threadId = result.thread.id;
            this.sessionId = this.threadId || undefined;

            // Capture the default model assigned by the server
            if (result.model && !this.model) {
                this.model = result.model;
            }

            // Sync turn count from the resumed thread so rewind math stays correct.
            const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
            if (turns.length > 0) {
                this.turnCount = turns.length;
                logger.info(`CodexAgent thread resumed: ${this.threadId} (${this.turnCount} turns)`);
                // Stamp the replayed last-turn bubble with its absolute turn index
                // so rewinding a just-resumed thread targets the right checkpoint.
                this.emitMessage({ type: 'user_echo', content: { turn: this.turnCount } });
            } else {
                logger.info(`CodexAgent thread started: ${this.threadId}`);
            }
            this.emitMessage({ type: 'system', content: { subtype: 'session_started', session_id: this.sessionId } });
        }

        if (prompt) {
            await this.sendMessage(prompt);
        }
    }

    private async fetchModels() {
        try {
            const result = await this.rpcRequest("model/list", {});
            let dataArray: any[] = [];
            if (Array.isArray(result)) {
                dataArray = result;
            } else if (result && Array.isArray(result.data)) {
                dataArray = result.data;
            }

            if (dataArray.length > 0) {
                const models = dataArray
                    .filter((m: any) => m.id && !m.hidden)
                    .map((m: any) => ({
                        id: m.id,
                        name: m.displayName || m.id
                    }));
                this.emitMessage({ type: 'models_update', content: models });
            }
        } catch (e) {
            logger.error("Failed to fetch models", e);
        }
    }

    private parseCodexError(error: any): string {
        if (!error) return 'Unknown error';
        let message = error.message || (typeof error === 'string' ? error : JSON.stringify(error));
        try {
            const parsed = JSON.parse(message);
            if (parsed.error && parsed.error.message) {
                return parsed.error.message;
            }
            if (parsed.message) {
                return parsed.message;
            }
        } catch (e) {
            // Not JSON or parsing failed, use original message
        }
        return message;
    }

    private handleIncomingData(data: any) {
        // RPC response
        if (data.id !== undefined && data.method === undefined) {
            const handlers = this.pendingResponses.get(data.id);
            if (handlers) {
                this.pendingResponses.delete(data.id);
                if (data.error) {
                    handlers.reject(new Error(data.error.message || 'RPC Error'));
                } else {
                    handlers.resolve(data.result);
                }
            }
            return;
        }

        const method = data.method;
        const params = data.params || {};

        if (method === 'turn/started') {
            this.activeTurnId = params.turn?.id || params.turnId;
            this.turnCount++;
            // Absolute 1-based turn index — the rewind checkpoint for the prompt
            // that started this turn (stays correct across thread/resume).
            this.emitMessage({ type: 'user_echo', content: { turn: this.turnCount } });
            this.emitMessage({ type: 'system', content: { subtype: 'turn_started', turnId: this.activeTurnId } });
        } else if (method === 'turn/completed') {
            if (this.planMode && this.planText) {
                this.emitMessage({ type: 'plan_delta', content: this.planText });
                this.planText = "";
            }
            this.activeTurnId = null;
            this.emitMessage({ type: 'stop', content: null });
        } else if (method === 'error' || method === 'codex/event/error') {
            const error = params.error || params.msg || params;
            const errorMessage = this.parseCodexError(error);
            this.emitMessage({ type: 'error', content: errorMessage });
        } else if (method === 'item/plan/delta') {
            this.planText += params.delta || "";
        } else if (method === 'item/agentMessage/delta') {
            this.emitMessage({ type: 'text', content: params.delta, id: params.itemId });
        } else if (method === 'item/started') {
            const item = params.item || {};
            if (item.id) this.itemCache.set(item.id, item);
            if (item.type === 'commandExecution') {
                this.emitMessage({
                    type: 'tool_use',
                    content: { name: 'command_execution', command: item.command, commandActions: item.commandActions, status: 'in_progress' },
                    id: item.id
                });
            }
        } else if (method === 'item/completed') {
            const item = params.item || {};
            if (item.type === 'agentMessage') {
                this.emitMessage({ type: 'text', content: item.text, id: item.id });
            } else if (item.type === 'fileChange') {
                this.emitMessage({
                    type: 'tool_use',
                    content: { name: 'fileChange', changes: item.changes, status: item.status },
                    id: item.id
                });
            } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
                const namespace = item.server || item.namespace;
                const toolName = item.tool || item.name || item.type;
                this.emitMessage({
                    type: 'tool_use',
                    content: {
                        name: namespace ? `${namespace}·${toolName}` : toolName,
                        input: item.arguments ?? item.input ?? {},
                        status: item.status
                    },
                    id: item.id
                });
            } else if (item.type === 'collabAgentToolCall') {
                const input: Record<string, any> = {};
                if (item.receiverThreadIds?.length) input.agents = item.receiverThreadIds.join(', ');
                if (item.prompt) input.prompt = item.prompt;
                if (item.model) input.model = item.model;
                if (item.reasoningEffort) input.reasoning = item.reasoningEffort;
                this.emitMessage({
                    type: 'tool_use',
                    content: {
                        name: item.tool || item.name || item.type,
                        input,
                        status: item.status
                    },
                    id: item.id
                });
            } else if (item.type === 'webSearch') {
                this.emitMessage({
                    type: 'tool_use',
                    content: { name: 'webSearch', input: item.action || { query: item.query }, status: item.status },
                    id: item.id
                });
            } else if (item.type === 'imageView' || item.type === 'imageGeneration') {
                this.emitMessage({
                    type: 'tool_use',
                    content: { name: item.type, input: item.path ? { path: item.path } : {}, status: item.status },
                    id: item.id
                });
            } else if (item.type &&
                       item.type !== 'commandExecution' &&
                       item.type !== 'reasoning' &&
                       item.type !== 'userMessage') {
                // Preserve newly introduced/extension-defined Codex tools even
                // before TermMate knows their schema. Prefer their explicit tool
                // name and input, then fall back to useful item fields.
                const toolName = item.toolName || item.tool || item.name || item.type;
                let toolInput = item.input ?? item.arguments ?? item.params;
                if (toolInput === undefined) {
                    toolInput = Object.fromEntries(Object.entries(item).filter(([key]) =>
                        !['id', 'type', 'name', 'tool', 'toolName', 'status', 'result', 'error'].includes(key)
                    ));
                }
                this.emitMessage({
                    type: 'tool_use',
                    content: { name: toolName, input: toolInput, itemType: item.type, status: item.status },
                    id: item.id
                });
            }
        } else if (method.endsWith('/requestApproval')) {
            // Reformat as control_request for BaseAgent/ChatView
            let toolName = 'unknown';
            if (method.includes('commandExecution')) toolName = 'command_execution';
            else if (method.includes('fileChange')) toolName = 'fileChange';

            this.emitMessage({
                type: 'control_request',
                content: {
                    request_id: data.id.toString(),
                    request: {
                        subtype: 'can_use_tool',
                        tool_name: toolName,
                        input: params
                    }
                },
                id: data.id.toString()
            });
        } else if (method === 'item/tool/requestUserInput') {
            if (this.disallowedTools.includes('AskUserQuestion')) {
                logger.info(`CodexAgent: Auto-denying AskUserQuestion (requestUserInput)`);
                const formattedResponse: any = {};
                for (const q of (params.questions || [])) {
                    const qId = q.id || q.question || '';
                    formattedResponse[qId] = {
                        answers: [
                            "This is an automated run. You are running in non-interactive mode. " +
                            "Do not use requestUserInput Tool. " +
                            "You must choose the reasonable recommended option and proceed without asking."
                        ]
                    };
                }
                this.writeJson({ id: data.id, result: { answers: formattedResponse } });
                return;
            }

            this.emitMessage({
                type: 'control_request',
                content: {
                    request_id: data.id.toString(),
                    request: {
                        subtype: 'can_use_tool',
                        tool_name: 'AskUserQuestion',
                        input: { questions: params.questions }
                    }
                },
                id: data.id.toString()
            });
        }
    }

    async sendMessage(content: string, parentToolUseId?: string, proceedPlan?: boolean): Promise<void> {
        logger.info(`CodexAgent sendMessage: ${content}`);
        if (!this.isConnected || !this.threadId) {
            logger.error(`CodexAgent not ready. isConnected: ${this.isConnected}, threadId: ${this.threadId}`);
            throw new Error('Codex is not connected or thread not started');
        }

        this.planText = "";
        const params: any = {
            threadId: this.threadId,
            input: [{ type: 'text', text: content }]
        };

        if (this.model) {
            params.model = this.model;
        }

        if (this.activeTurnId) {
            params.expectedTurnId = this.activeTurnId;
        }

        if (this.planMode && !proceedPlan) {
            params.collaborationMode = { 
                mode: 'plan',
                settings: {
                    model: this.model,
                    developer_instructions: null
                }
            };
        } else if (proceedPlan) {
            params.collaborationMode = { 
                mode: 'default',
                settings: {
                    model: this.model,
                    developer_instructions: null
                }
            };
        }

        logger.info('CodexAgent starting turn', params);
        const result = await this.rpcRequest("turn/start", params);
        if (result && (result.turn?.id || result.turnId)) {
            this.activeTurnId = result.turn?.id || result.turnId;
        }
    }

    async steer(text: string, proceedPlan?: boolean): Promise<void> {
        await this.sendMessage(text, undefined, proceedPlan);
    }

    async setModel(model: string | null): Promise<void> {
        this.model = model || null;
    }

    async setPlanMode(enabled: boolean): Promise<void> {
        this.planMode = enabled;
        // Codex handles plan mode per turn/start, so we just update the flag
    }

    async setApproveMode(mode: 'default' | 'accept-all' | 'allow-edit'): Promise<void> {
        this.approveMode = mode;
        // In a real implementation, you might want to update the thread policy via an RPC if Codex supports it at runtime
    }

    async interrupt(): Promise<void> {
        if (this.isConnected && this.threadId && this.activeTurnId) {
            logger.info(`CodexAgent: Interrupting turn ${this.activeTurnId} on thread ${this.threadId}`);
            await this.rpcRequest('turn/interrupt', {
                threadId: this.threadId,
                turnId: this.activeTurnId
            });
        } else {
            logger.warn(`CodexAgent: Cannot interrupt - isConnected: ${this.isConnected}, threadId: ${this.threadId}, activeTurnId: ${this.activeTurnId}`);
        }
    }

    /**
     * Roll the thread back to just before the turn at the given 1-based index,
     * dropping that turn and everything after it. Returns the (unchanged) thread id.
     */
    async rewind(checkpoint: string): Promise<string | null> {
        if (!this.isConnected || !this.threadId) {
            logger.warn('CodexAgent.rewind: not connected or no active thread');
            return null;
        }
        const targetIndex = parseInt(checkpoint, 10);
        if (isNaN(targetIndex)) return this.threadId;

        const numTurns = this.turnCount - (targetIndex - 1);
        if (numTurns < 1) return this.threadId;

        logger.info(`CodexAgent rewind: thread/rollback numTurns=${numTurns} (turnCount=${this.turnCount}, target=${targetIndex})`);
        const result = await this.rpcRequest('thread/rollback', {
            threadId: this.threadId,
            numTurns,
        });
        if (result === undefined || result === null) {
            throw new Error('thread/rollback RPC failed or timed out');
        }
        this.turnCount = targetIndex - 1;
        this.activeTurnId = null;
        return this.threadId;
    }

    async respondToControlRequest(requestId: string, result: PermissionResult): Promise<void> {
        logger.info(`CodexAgent respondToControlRequest: ${requestId}`, result);
        const id = parseInt(requestId);
        let decision = result.behavior === 'allow' ? 'accept' : 'decline';

        // Handle User Input Response
        if (result.updatedInput && result.updatedInput.answers) {
            const formattedAnswers: any = {};
            for (const [k, v] of Object.entries(result.updatedInput.answers)) {
                formattedAnswers[k] = { answers: Array.isArray(v) ? v : [String(v)] };
            }
            this.writeJson({ id, result: { answers: formattedAnswers } });
        } else {
            this.writeJson({ id, result: { decision } });
        }
    }

    private async rpcRequest(method: string, params: any): Promise<any> {
        const id = ++this.rpcId;
        const promise = new Promise((resolve, reject) => {
            this.pendingResponses.set(id, { resolve, reject });
        });

        this.writeJson({ method, id, params });
        return promise;
    }

    private async rpcNotify(method: string, params?: any) {
        this.writeJson({ method, params });
    }

    private writeJson(data: any) {
        if (this.process && this.process.stdin) {
            this.process.stdin.write(JSON.stringify(data) + '\n');
        } else {
            logger.error('CodexAgent STDIN not available');
        }
    }

    disconnect(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        for (const handlers of this.pendingResponses.values()) {
            handlers.reject(new Error('Agent disconnected'));
        }
        this.pendingResponses.clear();
        this.isConnected = false;
    }

    static async listSessions(cwd?: string): Promise<SessionInfo[]> {
        const cli = findCodexCli();
        if (!cli) return [];

        return new Promise((resolve) => {
            const proc = spawn(cli, ['app-server'], { cwd: cwd || process.cwd(), shell: process.platform === 'win32' });
            const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
            let rpcId = 0;
            const pending = new Map<number, (r: any) => void>();
            const results: SessionInfo[] = [];
            let done = false;

            const writeJson = (data: any) => proc.stdin?.write(JSON.stringify(data) + '\n');
            const finish = () => {
                if (done) return;
                done = true;
                try { proc.kill(); } catch { /* ignore */ }
                resolve(results);
            };

            const timeout = setTimeout(finish, 10000);
            rl.on('line', (line) => {
                if (!line.trim()) return;
                try {
                    const data = JSON.parse(line);
                    if (data.id !== undefined && data.method === undefined) {
                        const handler = pending.get(data.id);
                        if (handler) { pending.delete(data.id); handler(data.result); }
                    }
                } catch { /* ignore */ }
            });
            proc.on('error', () => { clearTimeout(timeout); finish(); });
            proc.on('close', () => { clearTimeout(timeout); finish(); });

            const rpc = (method: string, params: any): Promise<any> => {
                const id = ++rpcId;
                return new Promise(res => { pending.set(id, res); writeJson({ method, id, params }); });
            };

            (async () => {
                try {
                    await rpc('initialize', { clientInfo: { name: 'termmate-vs', version: '0.1.0' }, capabilities: { experimentalApi: true } });
                    writeJson({ method: 'initialized', params: {} });
                    const listResult = await rpc('thread/list', {
                        cwd: cwd || process.cwd(),
                        sortKey: 'updated_at',
                        sortDirection: 'desc',
                        archived: false,
                        useStateDbOnly: true
                    });
                    const threads = Array.isArray(listResult) ? listResult : (listResult?.threads || listResult?.data || []);
                    for (const t of threads) {
                        const tid = t.id || t.threadId;
                        // Current Codex app-server exposes the conversation title
                        // as `name` and the first user-message preview as `preview`.
                        const summary = t.name || t.preview || t.title || t.summary || t.description || tid?.slice(0, 8) || 'Untitled';
                        const rawUpdatedAt = t.updatedAt ?? t.updated_at;
                        const updatedAt = typeof rawUpdatedAt === 'number'
                            ? rawUpdatedAt
                            : (rawUpdatedAt ? new Date(rawUpdatedAt).getTime() / 1000 : 0);
                        if (tid && !t.ephemeral) results.push({ session_id: tid, mtime: updatedAt, summary, agentType: 'codex' });
                    }
                    results.sort((a, b) => b.mtime - a.mtime);
                } catch { /* ignore */ } finally { clearTimeout(timeout); finish(); }
            })();
        });
    }

    static async getSessionTail(sessionId: string, cwd?: string, historyLimit = 1): Promise<SessionTail | null> {
        const cli = findCodexCli();
        if (!cli) return null;

        return new Promise((resolve) => {
            const proc = spawn(cli, ['app-server'], { cwd: cwd || process.cwd(), shell: process.platform === 'win32' });
            const rl = readline.createInterface({ input: proc.stdout!, crlfDelay: Infinity });
            let rpcId = 0;
            const pending = new Map<number, (r: any) => void>();
            let done = false;
            let result: SessionTail | null = null;

            const writeJson = (data: any) => proc.stdin?.write(JSON.stringify(data) + '\n');
            const finish = () => {
                if (done) return;
                done = true;
                try { proc.kill(); } catch { /* ignore */ }
                resolve(result);
            };

            const timeout = setTimeout(finish, 10000);
            rl.on('line', (line) => {
                if (!line.trim()) return;
                try {
                    const data = JSON.parse(line);
                    if (data.id !== undefined && data.method === undefined) {
                        const handler = pending.get(data.id);
                        if (handler) { pending.delete(data.id); handler(data.result); }
                    }
                } catch { /* ignore */ }
            });
            proc.on('error', () => { clearTimeout(timeout); finish(); });
            proc.on('close', () => { clearTimeout(timeout); finish(); });

            const rpc = (method: string, params: any): Promise<any> => {
                const id = ++rpcId;
                return new Promise(res => { pending.set(id, res); writeJson({ method, id, params }); });
            };

            (async () => {
                try {
                    await rpc('initialize', { clientInfo: { name: 'termmate-vs', version: '0.1.0' }, capabilities: { experimentalApi: true } });
                    writeJson({ method: 'initialized', params: {} });

                    // thread/read with includeTurns gives the conversation tail in one call.
                    const readResult = await rpc('thread/read', { threadId: sessionId, includeTurns: true });
                    const thread = (readResult && typeof readResult === 'object') ? (readResult.thread || {}) : {};
                    const turns: any[] = Array.isArray(thread.turns) ? thread.turns : [];

                    const parsed = turns.map(turn => {
                        const items: any[] = Array.isArray(turn?.items) ? turn.items : [];
                        let prompt: string | null = null;
                        const responses: string[] = [];
                        for (const item of items) {
                            if (item?.type === 'userMessage' && prompt === null) {
                                const text = (Array.isArray(item.content) ? item.content : [])
                                    .filter((input: any) => input?.type === 'text')
                                    .map((input: any) => input.text || '').join('').trim();
                                if (text) prompt = text;
                            } else if (item?.type === 'agentMessage') {
                                const text = String(item.text || '').trim();
                                if (text) responses.push(text);
                            }
                        }
                        return { prompt, response: responses.length ? responses.join('\n\n') : null };
                    }).filter(turn => turn.prompt || turn.response);
                    const recent = historyLimit > 0 ? parsed.slice(-historyLimit) : parsed;
                    const last = recent[recent.length - 1];
                    result = last ? { prompt: last.prompt, response: last.response, turns: recent } : null;
                } catch { /* ignore */ } finally { clearTimeout(timeout); finish(); }
            })();
        });
    }
}
