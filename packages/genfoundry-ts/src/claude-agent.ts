import { spawn, ChildProcess } from 'child_process';
import { BaseAgent, Message, PermissionResult, SessionInfo, SessionTail } from './base-agent';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { logger } from './logger';

// ── Session listing helpers ─────────────────────────────────────────────────

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _LITE_BUF = 65536;
const _SKIP_PROMPT_RE = /^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user[^\]]*\]|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/;
const _CMD_NAME_RE = /<command-name>(.*?)<\/command-name>/;

function _simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    h = Math.abs(h);
    if (h === 0) return '0';
    const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
    let out = ''; let n = h;
    while (n > 0) { out = digits[n % 36] + out; n = Math.floor(n / 36); }
    return out;
}

function _sanitizePath(name: string): string {
    const MAX_LEN = 200;
    const s = name.replace(/[^a-zA-Z0-9]/g, '-');
    return s.length <= MAX_LEN ? s : s.slice(0, MAX_LEN) + '-' + _simpleHash(name);
}

function _getProjectsDir(): string {
    const c = process.env['CLAUDE_CONFIG_DIR'];
    return c ? path.join(c, 'projects') : path.join(os.homedir(), '.claude', 'projects');
}

function _findProjectDir(cwd: string): string | null {
    const projectsDir = _getProjectsDir();
    const canonical = path.resolve(cwd);
    const sanitized = _sanitizePath(canonical);
    const exact = path.join(projectsDir, sanitized);
    if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return exact;
    // Long-path fallback: the raw sanitized string (before hash truncation) may exceed 200 chars,
    // meaning the CLI used a different hash. Scan for a dir with the shared 200-char prefix.
    const rawSanitized = canonical.replace(/[^a-zA-Z0-9]/g, '-');
    if (rawSanitized.length > 200) {
        const prefix = rawSanitized.slice(0, 200);
        try {
            for (const e of fs.readdirSync(projectsDir)) {
                if (e.startsWith(prefix + '-')) {
                    const full = path.join(projectsDir, e);
                    if (fs.statSync(full).isDirectory()) return full;
                }
            }
        } catch { /* ignore */ }
    }
    return null;
}

function _findSessionFile(sessionId: string, cwd?: string): string | null {
    const fileName = `${sessionId}.jsonl`;
    const tryDir = (dir: string): string | null => {
        const p = path.join(dir, fileName);
        try {
            if (fs.statSync(p).size > 0) return p;
        } catch { /* ignore */ }
        return null;
    };
    if (cwd) {
        const projDir = _findProjectDir(path.resolve(cwd));
        return projDir ? tryDir(projDir) : null;
    }
    const projectsDir = _getProjectsDir();
    try {
        for (const e of fs.readdirSync(projectsDir)) {
            const full = path.join(projectsDir, e);
            try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
            const hit = tryDir(full);
            if (hit) return hit;
        }
    } catch { /* ignore */ }
    return null;
}

// ── Rewind fork helpers ─────────────────────────────────────────────────────

const _TRANSCRIPT_TYPES = new Set(['user', 'assistant', 'system', 'progress']);

function _findSessionFileWithDir(sessionId: string, cwd?: string): { file: string, dir: string } | null {
    const fileName = `${sessionId}.jsonl`;
    const tryDir = (dir: string): { file: string, dir: string } | null => {
        const p = path.join(dir, fileName);
        try { if (fs.statSync(p).size > 0) return { file: p, dir }; } catch { /* ignore */ }
        return null;
    };
    if (cwd) {
        const projDir = _findProjectDir(path.resolve(cwd));
        return projDir ? tryDir(projDir) : null;
    }
    const projectsDir = _getProjectsDir();
    try {
        for (const e of fs.readdirSync(projectsDir)) {
            const full = path.join(projectsDir, e);
            try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
            const hit = tryDir(full);
            if (hit) return hit;
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Fork a Claude session up to (inclusive) the given user-message UUID, matching
 * claude-agent-sdk fork_session(). UUIDs are kept as-is so file checkpoints
 * (keyed by the original user-message UUID) remain reachable on later rewinds.
 * Returns the new session id.
 */
function forkSessionForRewind(sessionId: string, upToMessageUuid: string, cwd?: string): string {
    if (!_UUID_RE.test(sessionId)) throw new Error(`Invalid session_id: ${sessionId}`);
    if (!_UUID_RE.test(upToMessageUuid)) throw new Error(`Invalid up_to_message_uuid: ${upToMessageUuid}`);

    const found = _findSessionFileWithDir(sessionId, cwd);
    if (!found) throw new Error(`Session ${sessionId} not found`);

    const content = fs.readFileSync(found.file, 'utf8');
    if (!content) throw new Error(`Session ${sessionId} has no messages to fork`);

    // Parse transcript entries + content replacements.
    const transcript: any[] = [];
    const contentReplacements: any[] = [];
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object') continue;
        const etype = entry.type;
        if (_TRANSCRIPT_TYPES.has(etype) && typeof entry.uuid === 'string') {
            transcript.push(entry);
        } else if (etype === 'content-replacement' && entry.sessionId === sessionId && Array.isArray(entry.replacements)) {
            contentReplacements.push(...entry.replacements);
        }
    }

    let entries = transcript.filter(e => !e.isSidechain);
    if (entries.length === 0) throw new Error(`Session ${sessionId} has no messages to fork`);

    const cutoff = entries.findIndex(e => e.uuid === upToMessageUuid);
    if (cutoff === -1) throw new Error(`Message ${upToMessageUuid} not found in session ${sessionId}`);
    entries = entries.slice(0, cutoff + 1);

    const writable = entries.filter(e => e.type !== 'progress');
    if (writable.length === 0) throw new Error(`Session ${sessionId} has no messages to fork`);

    const forkedSessionId = randomUUID();
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const lines: string[] = [];

    for (let i = 0; i < writable.length; i++) {
        const original = writable[i];
        const timestamp = i === writable.length - 1 ? now : (original.timestamp || now);
        const forked: any = {
            ...original,
            sessionId: forkedSessionId,
            timestamp,
            isSidechain: false,
            forkedFrom: { sessionId, messageUuid: original.uuid },
        };
        for (const key of ['teamName', 'agentName', 'slug', 'sourceToolAssistantUUID']) {
            delete forked[key];
        }
        lines.push(JSON.stringify(forked));
    }

    if (contentReplacements.length > 0) {
        lines.push(JSON.stringify({
            type: 'content-replacement',
            sessionId: forkedSessionId,
            replacements: contentReplacements,
            uuid: randomUUID(),
            timestamp: now,
        }));
    }

    lines.push(JSON.stringify({
        type: 'custom-title',
        sessionId: forkedSessionId,
        customTitle: 'Rewind fork',
        uuid: randomUUID(),
        timestamp: now,
    }));

    const forkPath = path.join(found.dir, `${forkedSessionId}.jsonl`);
    const fd = fs.openSync(forkPath, 'wx', 0o600);
    try {
        fs.writeSync(fd, lines.join('\n') + '\n');
    } finally {
        fs.closeSync(fd);
    }

    logger.info(`[rewind] forked ${sessionId} -> ${forkedSessionId} (${lines.length} entries)`);
    return forkedSessionId;
}

function _extractJsonStr(text: string, key: string): string | null {
    let last: string | null = null;
    for (const pat of [`"${key}":"`, `"${key}": "`]) {
        let pos = 0;
        while (true) {
            const idx = text.indexOf(pat, pos);
            if (idx < 0) break;
            let i = idx + pat.length; let raw = '';
            while (i < text.length) {
                if (text[i] === '\\') { raw += text[i] + text[i + 1]; i += 2; continue; }
                if (text[i] === '"') { last = raw.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); break; }
                raw += text[i++];
            }
            pos = i + 1;
        }
    }
    return last;
}

function _extractFirstPrompt(head: string): string {
    let fallback = '';
    for (const line of head.split('\n')) {
        if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
        if (line.includes('"tool_result"') || line.includes('"isMeta":true') || line.includes('"isMeta": true')) continue;
        if (line.includes('"isCompactSummary":true') || line.includes('"isCompactSummary": true')) continue;
        let entry: any; try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || entry.type !== 'user') continue;
        const content = (entry.message || {}).content || '';
        const texts: string[] = typeof content === 'string' ? [content]
            : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text) : [];
        for (const raw of texts) {
            const result = raw.replace(/\n/g, ' ').trim();
            if (!result) continue;
            const m = _CMD_NAME_RE.exec(result);
            if (m) { if (!fallback) fallback = m[1]; continue; }
            if (_SKIP_PROMPT_RE.test(result)) continue;
            return result.slice(0, 200) + (result.length > 200 ? '…' : '');
        }
    }
    return fallback;
}

export function findClaudeCli(): string {
    const commonPaths: string[] = [];
    if (os.platform() === 'win32') {
        const appData = process.env.APPDATA;
        if (appData) {
            commonPaths.push(
                path.join(appData, 'npm', 'claude.cmd'),
                path.join(appData, 'npm', 'claude')
            );
        }
    } else {
        const home = os.homedir();
        commonPaths.push(
            path.join(home, '.local', 'bin', 'claude'),
            path.join(home, '.npm-global', 'bin', 'claude'),
            path.join(home, '.yarn', 'bin', 'claude'),
            path.join(home, '.bun', 'bin', 'claude'),
            '/usr/local/bin/claude',
            '/usr/bin/claude',
            '/opt/homebrew/bin/claude',
            '/home/linuxbrew/.linuxbrew/bin/claude'
        );
    }

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return 'claude'; // Fallback to PATH
}

export class ClaudeAgent extends BaseAgent {
    private process: ChildProcess | null = null;
    private isConnected: boolean = false;
    private cliPath: string;
    // The session id we were told to resume. After a rewind-fork the CLI may
    // echo the root session id in its init message (overwriting this.sessionId),
    // so this is the reliable pointer to the JSONL file on disk for forking.
    private resumeSessionId?: string;
    private systemPrompt?: string;
    private allowedTools: string[] = [];

    constructor(
        cwd: string,
        cliPath?: string,
        env?: Record<string, string>,
        addDirs?: string[],
        sessionId?: string,
        systemPrompt?: string,
        allowedTools?: string[]
    ) {
        super(cwd, env, addDirs, sessionId);
        this.resumeSessionId = sessionId;
        this.cliPath = cliPath || findClaudeCli();
        this.systemPrompt = systemPrompt;
        this.allowedTools = allowedTools || [];
    }

    public setSystemPrompt(prompt?: string): void {
        this.systemPrompt = prompt;
    }

    public getSystemPrompt(): string | undefined {
        return this.systemPrompt;
    }

    public setAllowedTools(tools?: string[]): void {
        this.allowedTools = tools || [];
    }

    public getAllowedTools(): string[] {
        return [...this.allowedTools];
    }

    protected spawnProcess(cmdArgs: string[], spawnEnv: NodeJS.ProcessEnv): ChildProcess {
        return spawn(this.cliPath, cmdArgs, {
            env: spawnEnv,
            cwd: this.cwd || process.cwd(),
            shell: process.platform === 'win32'
        });
    }

    async connect(prompt?: string): Promise<void> {
        if (this.isConnected) {
            return;
        }

        logger.info(`ClaudeAgent connecting with path: ${this.cliPath}`);

        const cmdArgs = [
            '--output-format=stream-json',
            '--input-format=stream-json',
            '--replay-user-messages',
            '--verbose',
            '--permission-prompt-tool=stdio',
        ];

        if (this.planMode) {
            cmdArgs.push('--permission-mode', 'plan');
        }

        if (this.sessionId) {
            cmdArgs.push('--resume', this.sessionId);
        }

        if (this.systemPrompt) {
            cmdArgs.push('--system-prompt', this.systemPrompt);
        }

        if (this.allowedTools && this.allowedTools.length > 0) {
            cmdArgs.push('--allowedTools', this.allowedTools.join(','));
        }

        if (this.addDirs && this.addDirs.length > 0) {
            for (const dir of this.addDirs) {
                cmdArgs.push('--add-dir', dir);
            }
        }

        const spawnEnv: Record<string, string> = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-js', ...this.env };
        // Enable SDK file checkpointing so rewind can restore on-disk files.
        spawnEnv['CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING'] = 'true';

        this.process = this.spawnProcess(cmdArgs, spawnEnv);

        this.process.on('error', (err) => {
            logger.error(`ClaudeAgent process error: ${err.message}`);
            this.emitError(err);
        });

        this.process.on('close', (code) => {
            logger.info(`ClaudeAgent process closed with code: ${code}`);
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
                    logger.error(`ClaudeAgent JSON parse error: ${e} Line: ${line}`);
                }
            });
        }

        if (this.process.stderr) {
            this.process.stderr.on('data', (data) => {
                logger.warn(`ClaudeAgent STDERR: ${data}`);
            });
        }

        this.isConnected = true;

        // Send initialization request
        await this.sendInitializeRequest();

        if (prompt) {
            await this.sendMessage(prompt);
        }
    }

    private handleIncomingData(data: any) {
        const type = data.type;
        const id = data.id || data.uuid || data.request_id;

        if (type === 'system' && data.subtype === 'init') {
            this.sessionId = data.session_id;
            logger.info(`ClaudeAgent session initialized: ${this.sessionId}`);
            this.emitMessage({ type: 'system', content: { ...data, subtype: 'session_started', session_id: this.sessionId }, id });
        } else if (type === 'system') {
            // Forward runtime status notifications such as context compaction and
            // thinking-token updates so the chat view can refine its loading text.
            this.emitMessage({ type: 'system', content: data, raw_data: data, id });
        } else if (type === 'control_request') {
            const request = data.request || {};
            if (request.subtype === 'can_use_tool') {
                const toolName = request.tool_name;
                if (this.disallowedTools.includes(toolName)) {
                    logger.info(`ClaudeAgent: Auto-denying disallowed tool ${toolName}`);
                    let message = `Tool '${toolName}' is disallowed in this session.`;
                    if (toolName === 'AskUserQuestion') {
                        message = 'This is an automated run. You must make the decision yourself. Do not use AskUserQuestion Tool.';
                    }
                    this.respondToControlRequest(id, { behavior: 'deny', message });
                    return;
                }
            }
            this.emitMessage({ type: 'control_request', content: data, id });
        } else if (type === 'assistant') {
            const messageData = data.message || {};
            const contentBlocks = messageData.content || [];

            for (const block of contentBlocks) {
                if (block.type === 'text') {
                    this.emitMessage({ type: 'text', content: block.text, id: messageData.id });
                } else if (block.type === 'tool_use') {
                    this.emitMessage({ type: 'tool_use', content: block, id: messageData.id });
                }
            }
        } else if (type === 'user') {
            // Echo of a user message (from --replay-user-messages). Expose its uuid
            // so the UI can map a prompt bubble to a rewind checkpoint.
            // Only real user prompts count: tool_result echoes carry list content,
            // prompts carry string content (mirrors the reference processor).
            const userUuid = data.uuid || (data.message && data.message.uuid);
            const msgContent = data.message ? data.message.content : undefined;
            const isToolResult = Array.isArray(msgContent);
            if (userUuid && !isToolResult && !data.isMeta) {
                this.emitMessage({ type: 'user_echo', content: { uuid: userUuid }, id: userUuid });
            }
            // Emit tool_result for Edit/Write so the processor can render line numbers
            if (isToolResult) {
                const toolUseResult = data.tool_use_result;
                if (toolUseResult && toolUseResult.filePath) {
                    this.emitMessage({ type: 'tool_result', content: toolUseResult, id });
                }
            }
        } else if (type === 'error') {
            logger.error(`ClaudeAgent data error: ${data.error || data.message}`);
            this.emitMessage({ type: 'error', content: data.error || data.message, id });
        } else if (type === 'stop' || type === 'result') {
            this.emitMessage({ type: 'stop', content: data, id });
        } else if (type === 'control_response') {
            this.emitMessage({ type: 'control_response', content: data, id });
        }
    }

    async sendMessage(content: string, parentToolUseId?: string, proceedPlan?: boolean): Promise<void> {
        logger.info(`ClaudeAgent sendMessage: ${content}`);
        if (!this.isConnected || !this.process || !this.process.stdin) {
            logger.error('Claude process is not running');
            throw new Error('Claude process is not running');
        }

        const payload: any = {
            type: 'user',
            message: {
                role: 'user',
                content: content
            }
        };

        if (parentToolUseId) {
            payload.parent_tool_use_id = parentToolUseId;
        }

        if (this.sessionId) {
            payload.session_id = this.sessionId;
        }

        this.writeJson(payload);
    }

    async steer(text: string, proceedPlan?: boolean): Promise<void> {
        logger.info(`ClaudeAgent steer: ${text}`);
        // Claude CLI doesn't have a specific "steer" yet, but we can send a message
        await this.sendMessage(text, undefined, proceedPlan);
    }

    async setModel(model: string | null): Promise<void> {
        if (this.isConnected) {
            await this.sendControlRequest({
                subtype: 'set_model',
                model: model || null
            });
        }
    }

    async setPlanMode(enabled: boolean): Promise<void> {
        this.planMode = enabled;
        if (this.isConnected) {
            await this.sendControlRequest({
                subtype: 'set_permission_mode',
                mode: enabled ? 'plan' : 'default'
            });
        }
    }

    async setApproveMode(mode: 'default' | 'accept-all' | 'allow-edit'): Promise<void> {
        this.approveMode = mode;
        if (this.isConnected) {
            let claudeMode = 'default';
            if (mode === 'accept-all') claudeMode = 'bypassPermissions';
            else if (mode === 'allow-edit') claudeMode = 'acceptEdits';

            await this.sendControlRequest({
                subtype: 'set_permission_mode',
                mode: claudeMode
            });
        }
    }

    async interrupt(): Promise<void> {
        if (this.isConnected) {
            logger.info('ClaudeAgent: Sending interrupt control request');
            await this.sendControlRequest({
                subtype: 'interrupt'
            });
        }
    }

    /**
     * Rewind to the given user message: restore files then fork the session.
     * Returns the new (forked) session id to resume from.
     */
    async rewind(userMessageId: string): Promise<string | null> {
        // 1. Restore on-disk files to their pre-message state (live subprocess).
        if (this.isConnected) {
            await this.sendControlRequest({
                subtype: 'rewind_files',
                user_message_id: userMessageId,
            });
            // Give the CLI a moment to apply the file checkpoint before we fork.
            await new Promise(res => setTimeout(res, 150));
        }

        // 2. Fork the JSONL transcript up to (inclusive) the user message.
        // Prefer the resume pointer: after a first rewind the CLI may echo the
        // root session id instead of the fork id in its init message.
        const sourceSessionId = this.resumeSessionId || this.sessionId;
        if (!sourceSessionId) {
            logger.warn('ClaudeAgent.rewind: no session id available for fork');
            return null;
        }

        const forkedId = forkSessionForRewind(sourceSessionId, userMessageId, this.cwd);
        logger.info(`ClaudeAgent rewind: forked ${sourceSessionId} -> ${forkedId}`);
        return forkedId;
    }

    async respondToControlRequest(requestId: string, result: PermissionResult): Promise<void> {
        logger.info(`ClaudeAgent respondToControlRequest: ${requestId}`, result);
        const response: any = {
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: requestId,
                response: {
                    behavior: result.behavior,
                    updatedInput: result.updatedInput
                }
            }
        };

        if (result.message) {
            response.response.response.message = result.message;
        }

        this.writeJson(response);
    }

    private async sendInitializeRequest() {
        const requestId = `req_init_${randomUUID().substring(0, 8)}`;
        this.writeJson({
            type: 'control_request',
            request_id: requestId,
            request: {
                subtype: 'initialize',
                hooks: null
            }
        });
    }

    private async sendControlRequest(request: any) {
        const requestId = `req_${randomUUID().substring(0, 8)}`;
        this.writeJson({
            type: 'control_request',
            request_id: requestId,
            request: request
        });
    }

    private writeJson(data: any) {
        if (this.process && this.process.stdin) {
            this.process.stdin.write(JSON.stringify(data) + '\n');
        }
    }

    disconnect(): void {
        if (this.process) {
            logger.info('ClaudeAgent disconnecting...');
            this.process.kill();
            this.process = null;
        }
        this.isConnected = false;
    }

    static listSessions(cwd?: string): SessionInfo[] {
        const projectsDir = _getProjectsDir();
        const results: SessionInfo[] = [];

        const scanDir = (dir: string) => {
            try {
                for (const name of fs.readdirSync(dir)) {
                    if (!name.endsWith('.jsonl')) continue;
                    const sessionId = name.slice(0, -6);
                    if (!_UUID_RE.test(sessionId)) continue;
                    const filePath = path.join(dir, name);
                    try {
                        const fd = fs.openSync(filePath, 'r');
                        const stat = fs.fstatSync(fd);
                        if (stat.size === 0) { fs.closeSync(fd); continue; }
                        const headBuf = Buffer.alloc(Math.min(_LITE_BUF, stat.size));
                        fs.readSync(fd, headBuf, 0, headBuf.length, 0);
                        const head = headBuf.toString('utf8');
                        let tail = head;
                        if (stat.size > _LITE_BUF) {
                            const tailBuf = Buffer.alloc(_LITE_BUF);
                            const read = fs.readSync(fd, tailBuf, 0, _LITE_BUF, Math.max(0, stat.size - _LITE_BUF));
                            tail = tailBuf.slice(0, read).toString('utf8');
                        }
                        fs.closeSync(fd);
                        const firstLine = head.split('\n', 1)[0];
                        if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) continue;
                        const summary =
                            _extractJsonStr(tail, 'customTitle') || _extractJsonStr(head, 'customTitle') ||
                            _extractJsonStr(tail, 'lastPrompt') ||
                            _extractJsonStr(tail, 'aiTitle') || _extractJsonStr(head, 'aiTitle') ||
                            _extractFirstPrompt(head);
                        if (summary) results.push({ session_id: sessionId, mtime: stat.mtimeMs / 1000, summary, agentType: 'claude' });
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        };

        if (cwd) {
            const projDir = _findProjectDir(cwd);
            if (projDir) scanDir(projDir);
        } else {
            try {
                for (const e of fs.readdirSync(projectsDir)) {
                    const full = path.join(projectsDir, e);
                    if (fs.statSync(full).isDirectory()) scanDir(full);
                }
            } catch { /* ignore */ }
        }

        results.sort((a, b) => b.mtime - a.mtime);
        return results;
    }

    /**
     * Return the last user prompt and last assistant text response for a session.
     * Skips tool_result-only user messages and meta/system messages.
     */
    static getSessionTail(sessionId: string, cwd?: string, historyLimit = 1): SessionTail | null {
        const fpath = _findSessionFile(sessionId, cwd);
        if (!fpath) return null;

        const messages: Array<{ role: 'user' | 'assistant', text: string }> = [];
        let content: string;
        try {
            content = fs.readFileSync(fpath, 'utf8');
        } catch {
            return null;
        }

        for (const rawLine of content.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            let entry: any;
            try { entry = JSON.parse(line); } catch { continue; }
            if (!entry || typeof entry !== 'object') continue;
            const etype = entry.type;
            if (etype === 'user') {
                if (entry.isMeta || entry.isCompactSummary) continue;
                const msg = entry.message || {};
                const c = msg.content;
                const texts: string[] = [];
                let hasToolResult = false;
                if (typeof c === 'string') {
                    texts.push(c);
                } else if (Array.isArray(c)) {
                    for (const blk of c) {
                        if (!blk || typeof blk !== 'object') continue;
                        if (blk.type === 'tool_result') hasToolResult = true;
                        else if (blk.type === 'text' && blk.text) texts.push(blk.text);
                    }
                }
                if (texts.length === 0 && hasToolResult) continue;
                const text = texts.join('').trim();
                if (text && !_SKIP_PROMPT_RE.test(text)) messages.push({ role: 'user', text });
            } else if (etype === 'assistant') {
                const msg = entry.message || {};
                const c = msg.content;
                const texts: string[] = [];
                if (typeof c === 'string') {
                    texts.push(c);
                } else if (Array.isArray(c)) {
                    for (const blk of c) {
                        if (blk && typeof blk === 'object' && blk.type === 'text' && blk.text) texts.push(blk.text);
                    }
                }
                const text = texts.join('').trim();
                if (text) messages.push({ role: 'assistant', text });
            }
        }

        const turns: Array<{ prompt: string | null, response: string | null }> = [];
        let current: { prompt: string | null, response: string | null } | null = null;
        for (const message of messages) {
            if (message.role === 'user') {
                if (current) turns.push(current);
                current = { prompt: message.text, response: null };
            } else if (current) {
                current.response = current.response ? `${current.response}\n\n${message.text}` : message.text;
            }
        }
        if (current) turns.push(current);
        const recent = historyLimit > 0 ? turns.slice(-historyLimit) : turns;
        const last = recent[recent.length - 1];
        return last ? { prompt: last.prompt, response: last.response, turns: recent } : null;
    }
}
