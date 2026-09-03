import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';

import { BaseAgent, PermissionResult, SessionInfo, SessionTail } from './base-agent';
import { logger } from './logger';

const SERVER_URL_RE = /opencode server listening on\s+(https?:\/\/[^\s]+)/i;
const TOOL_NAMES: Record<string, string> = {
    bash: 'Bash', edit: 'Edit', write: 'Write', apply_patch: 'Edit', patch: 'Edit',
    read: 'Read', glob: 'Glob', grep: 'Grep', list: 'Glob', webfetch: 'WebFetch',
    websearch: 'WebSearch', task: 'Task', skill: 'Skill', question: 'AskUserQuestion',
    external_directory: 'ExternalDirectory', doom_loop: 'DoomLoop',
};

export function findOpenCodeCli(): string {
    const candidates: string[] = [];
    if (process.platform === 'win32') {
        if (process.env.APPDATA) {
            candidates.push(
                path.join(process.env.APPDATA, 'npm', 'opencode.cmd'),
                path.join(process.env.APPDATA, 'npm', 'opencode'),
            );
        }
    } else {
        const home = os.homedir();
        candidates.push(
            path.join(home, '.opencode', 'bin', 'opencode'),
            path.join(home, '.local', 'bin', 'opencode'),
            path.join(home, '.npm-global', 'bin', 'opencode'),
            path.join(home, '.yarn', 'bin', 'opencode'),
            path.join(home, '.bun', 'bin', 'opencode'),
            '/usr/local/bin/opencode', '/usr/bin/opencode', '/opt/homebrew/bin/opencode',
            '/home/linuxbrew/.linuxbrew/bin/opencode',
        );
    }
    return candidates.find(candidate => fs.existsSync(candidate)) || 'opencode';
}

function permissionKey(tool: string): string | null {
    const aliases: Record<string, string> = {
        bash: 'bash', edit: 'edit', write: 'edit', applypatch: 'edit', read: 'read',
        glob: 'glob', grep: 'grep', webfetch: 'webfetch', websearch: 'websearch',
        task: 'task', skill: 'skill', todowrite: 'todowrite', todoread: 'todowrite',
        askuserquestion: 'question',
    };
    return aliases[tool.replace(/[_-]/g, '').toLowerCase()] || null;
}

function runtimeEnv(extraEnv: Record<string, string> = {}, addDirs: string[] = [],
    approveMode: string = 'default', disallowedTools: string[] = []): NodeJS.ProcessEnv {
    const env = { ...process.env, ...extraEnv };
    let inline: Record<string, any> = {};
    if (env.OPENCODE_CONFIG_CONTENT) {
        try { inline = JSON.parse(env.OPENCODE_CONFIG_CONTENT); } catch { /* ignore invalid user config */ }
    }
    const permission: Record<string, any> = { '*': 'ask' };
    if (approveMode === 'allow-edit' || approveMode === 'accept-all') permission.edit = 'allow';
    if (addDirs.length) {
        permission.external_directory = Object.fromEntries(addDirs.map(dir => [path.join(path.resolve(dir), '**'), 'allow']));
    }
    for (const tool of disallowedTools) {
        const key = permissionKey(tool);
        if (key) permission[key] = 'deny';
    }
    inline.permission = permission;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inline);
    return env;
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
    const password = env.OPENCODE_SERVER_PASSWORD;
    if (!password) return {};
    const username = env.OPENCODE_SERVER_USERNAME || 'opencode';
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

function requestJson(baseUrl: string, method: string, route: string, cwd: string | undefined,
    env: NodeJS.ProcessEnv, body?: any, includeDirectory = true): Promise<any> {
    const url = new URL(route, baseUrl);
    if (includeDirectory && cwd) url.searchParams.set('directory', cwd);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.request(url, {
            method,
            headers: {
                Accept: 'application/json', ...authHeaders(env),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
            },
        }, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if ((response.statusCode || 500) >= 400) {
                    const error: any = new Error(`OpenCode ${method} ${url.pathname} failed (${response.statusCode}): ${text}`);
                    error.statusCode = response.statusCode;
                    reject(error);
                    return;
                }
                if (!text) { resolve(undefined); return; }
                try {
                    const value = JSON.parse(text);
                    if (value && typeof value === 'object' && Object.keys(value).every(key => key === 'data' || key === 'error')) {
                        if (value.error) throw new Error(errorText(value.error));
                        resolve(value.data);
                    } else resolve(value);
                } catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => req.destroy(new Error('OpenCode request timed out')));
        if (payload) req.write(payload);
        req.end();
    });
}

function errorText(error: any): string {
    if (typeof error === 'string') return error;
    return String(error?.data?.message || error?.message || error?.name || JSON.stringify(error));
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
    if (!child || child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
        await new Promise<void>(resolve => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
            killer.once('close', () => resolve());
            killer.once('error', () => { child.kill(); resolve(); });
        });
    } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }
}

function stopProcessNow(child: ChildProcess | null): void {
    if (!child || child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 2_000,
        });
        if (child.exitCode === null) {
            try { child.kill(); } catch { /* already gone */ }
        }
    } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }
    }
}

function startServer(cliPath: string, cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess, url: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(cliPath, ['serve', '--hostname=127.0.0.1', '--port=0'], {
            cwd: cwd || process.cwd(), env, windowsHide: true, detached: process.platform !== 'win32', shell: process.platform === 'win32',
        });
        let output = '';
        let settled = false;
        const timeout = setTimeout(() => fail(new Error(`Timed out starting OpenCode server${output ? `: ${output.trim()}` : ''}`)), 10_000);
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            void stopProcess(child);
            reject(error);
        };
        const consume = (chunk: any) => {
            const text = String(chunk);
            output = (output + text).slice(-8000);
            const match = output.match(SERVER_URL_RE);
            if (match && !settled) {
                settled = true;
                clearTimeout(timeout);
                resolve({ child, url: match[1].replace(/\/$/, '') });
            }
        };
        child.stdout?.on('data', consume);
        child.stderr?.on('data', consume);
        child.once('error', fail);
        child.once('close', code => {
            if (!settled) fail(new Error(`OpenCode server exited with code ${code}${output ? `: ${output.trim()}` : ''}`));
        });
    });
}

export class OpenCodeAgent extends BaseAgent {
    private process: ChildProcess | null = null;
    private serverUrl: string | null = null;
    private connected = false;
    private eventRequest: http.ClientRequest | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 250;
    private eventEnv: NodeJS.ProcessEnv | null = null;
    private model: string | null = null;
    private turnActive = false;
    private turnPlanMode = false;
    private usesSessionStatus = false;
    private planText = '';
    private textCache = new Map<string, string>();
    private partTypes = new Map<string, string>();
    private messageRoles = new Map<string, string>();
    private userMessageIds = new Set<string>();
    private terminalTools = new Set<string>();
    private permissionSessions = new Map<string, string>();
    private seenPermissions = new Set<string>();
    private diffCache = new Map<string, string>();
    private cliPath: string;

    constructor(cwd: string, cliPath?: string, env?: Record<string, string>, addDirs?: string[], sessionId?: string) {
        super(cwd, env, addDirs, sessionId);
        this.cliPath = cliPath || findOpenCodeCli();
    }

    async connect(prompt?: string): Promise<void> {
        if (this.connected) return;
        const env = runtimeEnv(this.env, this.addDirs, this.approveMode, this.disallowedTools);
        logger.info(`Starting OpenCode server with path: ${this.cliPath}`);
        const server = await startServer(this.cliPath, this.cwd, env);
        this.process = server.child;
        this.serverUrl = server.url;
        this.process.on('close', code => {
            if (this.connected) {
                this.connected = false;
                this.emitClose(code);
            }
        });
        try {
            await this.http('GET', '/global/health', undefined, false);
            this.connected = true;
            await this.startEventStream(env);
            if (this.sessionId) {
                const session = await this.http('GET', `/session/${encodeURIComponent(this.sessionId)}`);
                if (!session?.id) throw new Error('OpenCode did not return a valid session');
                this.sessionId = session.id;
                this.emitMessage({ type: 'system', content: { subtype: 'session_started', session_id: this.sessionId } });
            }
            void this.fetchModels();
            if (prompt) await this.sendMessage(prompt);
        } catch (error) {
            this.disconnect();
            throw error;
        }
    }

    private http(method: string, route: string, body?: any, includeDirectory = true): Promise<any> {
        if (!this.serverUrl) return Promise.reject(new Error('OpenCode server is not available'));
        return requestJson(this.serverUrl, method, route, this.cwd, { ...process.env, ...this.env }, body, includeDirectory);
    }

    private startEventStream(env: NodeJS.ProcessEnv): Promise<void> {
        this.eventEnv = env;
        return this.openEventStream(env);
    }

    private openEventStream(env: NodeJS.ProcessEnv): Promise<void> {
        if (!this.serverUrl) return Promise.reject(new Error('OpenCode server is not available'));
        const url = new URL('/event', this.serverUrl);
        if (this.cwd) url.searchParams.set('directory', this.cwd);
        const transport = url.protocol === 'https:' ? https : http;
        return new Promise((resolve, reject) => {
            const req = transport.request(url, { headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...authHeaders(env) } });
            this.eventRequest = req;
            let established = false;
            let ended = false;
            const disconnected = (error?: Error) => {
                if (ended) return;
                ended = true;
                if (!established) reject(error || new Error('OpenCode event stream disconnected during startup'));
                else this.scheduleEventReconnect();
            };
            req.once('response', response => {
                if ((response.statusCode || 500) >= 400) {
                    response.resume();
                    disconnected(new Error(`OpenCode event stream failed (${response.statusCode})`));
                    return;
                }
                established = true;
                this.reconnectDelay = 250;
                let buffer = '';
                response.setEncoding('utf8');
                response.on('data', chunk => {
                    buffer += chunk;
                    let boundary: number;
                    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
                        const block = buffer.slice(0, boundary);
                        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length || 2;
                        buffer = buffer.slice(boundary + separator);
                        const raw = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                        if (raw) {
                            try { this.dispatchEvent(JSON.parse(raw)); } catch (error) { logger.warn(`Invalid OpenCode event: ${error}`); }
                        }
                    }
                });
                response.once('end', () => disconnected());
                response.once('aborted', () => disconnected(new Error('OpenCode event stream was aborted')));
                response.once('error', error => disconnected(error));
                response.once('close', () => disconnected());
                resolve();
            });
            req.once('error', error => disconnected(error));
            req.end();
        });
    }

    private scheduleEventReconnect() {
        if (!this.connected || !this.eventEnv || this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5_000);
        logger.warn(`OpenCode SSE disconnected; reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.connected || !this.eventEnv) return;
            void this.openEventStream(this.eventEnv).catch(error => {
                logger.warn(`OpenCode SSE reconnect failed: ${error}`);
                this.scheduleEventReconnect();
            });
        }, delay);
    }

    private belongsToSession(properties: any): boolean {
        let session = properties.sessionID || properties.sessionId;
        for (const key of ['part', 'info', 'permission']) {
            const nested = properties[key];
            if (nested && typeof nested === 'object') session ||= nested.sessionID || nested.sessionId;
        }
        return !session || session === this.sessionId;
    }

    private messageId(properties: any): string {
        const part = properties.part;
        return String(part?.messageID || part?.messageId || properties.messageID || properties.messageId || '');
    }

    private isUserPart(properties: any): boolean {
        const id = this.messageId(properties);
        return !!id && (this.userMessageIds.has(id) || this.messageRoles.get(id) === 'user');
    }

    private dispatchEvent(event: any) {
        const payload = event?.payload || event;
        const type = payload?.type || '';
        const properties = payload?.properties;
        if (!properties || typeof properties !== 'object' || !this.belongsToSession(properties)) return;

        if (type === 'message.part.delta') {
            if (this.isUserPart(properties) || (properties.field !== undefined && properties.field !== 'text')) return;
            const id = String(properties.partID || '');
            const delta = String(properties.delta || '');
            this.textCache.set(id, (this.textCache.get(id) || '') + delta);
            if (this.partTypes.get(id) === 'reasoning') this.emitMessage({ type: 'thinking', content: delta, id });
            else this.emitText(delta, id);
            return;
        }
        if (type === 'message.part.updated') {
            if (!this.isUserPart(properties)) this.handlePartUpdated(properties);
            return;
        }
        if (type === 'message.updated') {
            const info = properties.info || {};
            if (info.id && info.role) this.messageRoles.set(String(info.id), String(info.role));
            if (info.id && info.role === 'user' && !this.userMessageIds.has(String(info.id))) {
                this.userMessageIds.add(String(info.id));
                this.emitMessage({ type: 'user_echo', content: { uuid: String(info.id) }, id: String(info.id) });
            }
            return;
        }
        if (type === 'permission.asked' || type === 'permission.updated') { this.handlePermission(properties); return; }
        if (type === 'session.diff') { this.handleSessionDiff(properties.diff); return; }
        if (type === 'session.error') {
            this.emitMessage({ type: 'error', content: errorText(properties.error || properties) });
            this.finishTurn();
            return;
        }
        let idle = false;
        if (type === 'session.status') {
            this.usesSessionStatus = true;
            idle = properties.status?.type === 'idle';
        } else if (type === 'session.idle') idle = !this.usesSessionStatus;
        if (idle) this.finishTurn();
    }

    private handlePartUpdated(properties: any) {
        const part = properties.part;
        if (!part || typeof part !== 'object') return;
        const type = part.type;
        const id = String(part.id || properties.partID || '');
        if (id && type) this.partTypes.set(id, type);
        if (type === 'text' || type === 'reasoning') {
            if (part.ignored) return;
            const full = String(part.text || '');
            const previous = this.textCache.get(id) || '';
            const delta = full ? (full.startsWith(previous) ? full.slice(previous.length) : full) : String(properties.delta || '');
            this.textCache.set(id, full || previous + delta);
            if (type === 'reasoning') {
                if (delta) this.emitMessage({ type: 'thinking', content: delta, id });
            } else this.emitText(delta, id);
            return;
        }
        if (type === 'tool') {
            const state = part.state || {};
            if (!['completed', 'error'].includes(state.status) || this.terminalTools.has(id)) return;
            this.terminalTools.add(id);
            const rawName = String(part.tool || 'tool');
            const input = state.input && typeof state.input === 'object' ? state.input : { value: state.input };
            if (['bash', 'shell', 'command'].includes(rawName.toLowerCase())) {
                this.emitMessage({ type: 'tool_use', id, content: { name: 'command_execution', input: { command: input.command || input.cmd || state.title }, output: state.output || state.error, status: state.status } });
            } else {
                this.emitMessage({ type: 'tool_use', id, content: { name: rawName, input, title: state.title, output: state.output, error: state.error, metadata: state.metadata, status: state.status } });
            }
        }
    }

    private emitText(delta: string, id: string) {
        if (!delta) return;
        if (this.turnPlanMode) this.planText += delta;
        else this.emitMessage({ type: 'text', content: delta, id });
    }

    private handlePermission(properties: any) {
        const permission = properties.permission && typeof properties.permission === 'object' ? properties.permission : properties;
        const id = String(permission.id || permission.requestID || permission.permissionID || '');
        if (!id || this.seenPermissions.has(id)) return;
        this.seenPermissions.add(id);
        this.permissionSessions.set(id, String(permission.sessionID || properties.sessionID || this.sessionId || ''));
        const kind = String(permission.type || permission.permission || 'tool');
        this.emitMessage({ type: 'control_request', content: {
            request_id: id,
            request: { subtype: 'can_use_tool', tool_name: TOOL_NAMES[kind.toLowerCase()] || kind,
                input: { ...(permission.metadata || {}), title: permission.title || '', pattern: permission.patterns || permission.pattern, permission_type: kind } },
        } });
    }

    private handleSessionDiff(diffs: any) {
        if (!Array.isArray(diffs)) return;
        const changes: any[] = [];
        for (const item of diffs) {
            if (!item?.file) continue;
            const signature = `${item.before || ''}\0${item.after || ''}`;
            if (this.diffCache.get(item.file) === signature) continue;
            this.diffCache.set(item.file, signature);
            const diff = createTwoFilesPatch(item.file, item.file, item.before || '', item.after || '', '', '');
            changes.push({ path: item.file, oldText: item.before || '', newText: item.after || '', diff, additions: item.additions, deletions: item.deletions });
        }
        if (changes.length) this.emitMessage({ type: 'tool_use', content: { name: 'fileChange', changes, status: 'completed' } });
    }

    private finishTurn() {
        if (!this.turnActive) return;
        this.turnActive = false;
        if (this.turnPlanMode && this.planText) this.emitMessage({ type: 'plan_delta', content: this.planText });
        this.turnPlanMode = false;
        this.planText = '';
        this.emitMessage({ type: 'stop', content: null });
    }

    private async fetchModels() {
        try {
            const result = await this.http('GET', '/provider');
            const connected = new Set<string>(result?.connected || []);
            const models: any[] = [];
            for (const provider of result?.all || result?.providers || []) {
                if (!provider?.id || (connected.size && !connected.has(provider.id))) continue;
                const entries = Array.isArray(provider.models)
                    ? provider.models.map((m: any) => [m.id, m])
                    : Object.entries(provider.models || {});
                for (const [modelId, modelValue] of entries as any[]) {
                    if (!modelId) continue;
                    const model = modelValue || {};
                    models.push({ id: `${provider.id}/${modelId}`, name: `[${provider.name || provider.id}] ${model.name || modelId}` });
                }
            }
            if (models.length) this.emitMessage({ type: 'models_update', content: models });
        } catch (error) { logger.warn(`Failed to fetch OpenCode models: ${error}`); }
    }

    private async ensureSession(): Promise<string> {
        if (this.sessionId) return this.sessionId;
        const session = await this.http('POST', '/session', {});
        if (!session?.id) throw new Error('OpenCode did not return a valid session');
        this.sessionId = session.id;
        this.emitMessage({ type: 'system', content: { subtype: 'session_started', session_id: this.sessionId } });
        return this.sessionId!;
    }

    async sendMessage(content: string, _parentToolUseId?: string, proceedPlan = false): Promise<void> {
        if (!this.connected) throw new Error('OpenCode client is not connected');
        if (this.turnActive) throw new Error('Wait for the current OpenCode turn to finish');
        const sessionId = await this.ensureSession();
        const agent = proceedPlan || !this.planMode ? 'build' : 'plan';
        const body: any = { agent, parts: [{ type: 'text', text: content }] };
        if (this.model?.includes('/')) {
            const [providerID, ...rest] = this.model.split('/');
            body.model = { providerID, modelID: rest.join('/') };
        }
        const tools: Record<string, false> = {};
        for (const tool of this.disallowedTools) {
            const key = permissionKey(tool);
            if (key) tools[key] = false;
        }
        if (Object.keys(tools).length) body.tools = tools;
        this.turnActive = true;
        this.turnPlanMode = agent === 'plan';
        this.planText = '';
        this.emitMessage({ type: 'system', content: { subtype: 'turn_started' } });
        try { await this.http('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body); }
        catch (error) { this.turnActive = false; throw error; }
    }

    async steer(text: string, proceedPlan = false): Promise<void> { await this.sendMessage(text, undefined, proceedPlan); }

    async interrupt(): Promise<void> {
        if (this.connected && this.sessionId) await this.http('POST', `/session/${encodeURIComponent(this.sessionId)}/abort`, {});
        this.turnActive = false;
        this.turnPlanMode = false;
    }

    disconnect(): void {
        this.connected = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.eventEnv = null;
        this.eventRequest?.destroy();
        this.eventRequest = null;
        const child = this.process;
        this.process = null;
        this.serverUrl = null;
        stopProcessNow(child);
    }

    async setPlanMode(enabled: boolean): Promise<void> { this.planMode = enabled; if (!enabled) this.planText = ''; }
    async setApproveMode(mode: 'default' | 'accept-all' | 'allow-edit'): Promise<void> { this.approveMode = mode; }
    async setModel(model: string | null): Promise<void> { this.model = model; }

    async respondToControlRequest(requestId: string, result: PermissionResult): Promise<void> {
        const response = result.behavior === 'allow' ? 'once' : 'reject';
        try {
            await this.http('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { reply: response, ...(result.message ? { message: result.message } : {}) });
        } catch (error: any) {
            if (![404, 405].includes(error?.statusCode)) throw error;
            const sessionId = this.permissionSessions.get(requestId) || this.sessionId || '';
            await this.http('POST', `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`, { response });
        }
        this.permissionSessions.delete(requestId);
    }

    async rewind(messageId: string): Promise<string | null> {
        if (!this.sessionId) return null;
        await this.http('POST', `/session/${encodeURIComponent(this.sessionId)}/revert`, { messageID: messageId });
        this.turnActive = false;
        this.textCache.clear(); this.partTypes.clear(); this.messageRoles.clear(); this.userMessageIds.clear(); this.terminalTools.clear(); this.diffCache.clear();
        return this.sessionId;
    }

    private static async withServer<T>(cwd: string | undefined, cliPath: string | undefined,
        extraEnv: Record<string, string> | undefined, fn: (url: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
        const env = runtimeEnv(extraEnv);
        const server = await startServer(cliPath || findOpenCodeCli(), cwd, env);
        try { return await fn(server.url, env); } finally { await stopProcess(server.child); }
    }

    static async listSessions(cwd?: string, cliPath?: string, extraEnv?: Record<string, string>): Promise<SessionInfo[]> {
        return this.withServer(cwd, cliPath, extraEnv, async (url, env) => {
            const sessions = await requestJson(url, 'GET', '/session', cwd, env);
            return (Array.isArray(sessions) ? sessions : []).filter(s => s?.id).map(s => {
                let mtime = Number(s.time?.updated || 0);
                if (mtime > 100_000_000_000) mtime /= 1000;
                return { session_id: s.id, mtime, summary: s.title || s.id.slice(0, 8), agentType: 'opencode' as const };
            }).sort((a, b) => b.mtime - a.mtime);
        });
    }

    static async getSessionTail(sessionId: string, cwd?: string, cliPath?: string,
        extraEnv?: Record<string, string>, historyLimit = 1): Promise<SessionTail | null> {
        return this.withServer(cwd, cliPath, extraEnv, async (url, env) => {
            const messages = await requestJson(url, 'GET', `/session/${encodeURIComponent(sessionId)}/message`, cwd, env);
            const turns: Array<{ prompt: string | null, response: string | null }> = [];
            let current: { prompt: string | null, response: string | null } | null = null;
            for (const entry of Array.isArray(messages) ? messages : []) {
                const text = (entry.parts || []).filter((part: any) => part?.type === 'text' && !part.ignored).map((part: any) => part.text || '').join('').trim();
                if (entry.info?.role === 'user' && text) {
                    if (current) turns.push(current);
                    current = { prompt: text, response: null };
                } else if (entry.info?.role === 'assistant' && text && current) {
                    current.response = current.response ? `${current.response}\n\n${text}` : text;
                }
            }
            if (current) turns.push(current);
            const recent = historyLimit > 0 ? turns.slice(-historyLimit) : turns;
            const last = recent[recent.length - 1];
            return last ? { prompt: last.prompt, response: last.response, turns: recent } : null;
        });
    }
}
