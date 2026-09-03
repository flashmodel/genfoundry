import { logger } from './logger';

export type MessageType = 'text' | 'tool_use' | 'tool_result' | 'error' | 'stop' | 'thinking' | 'plan_delta' | 'control_request' | 'control_response' | 'system' | 'models_update' | 'text_delta' | 'extension_ui_request' | 'text_end' | 'thinking_start' | 'thinking_delta' | 'result' | 'proposed-plan' | 'user_echo' | 'plan_action';

export interface SessionInfo {
    session_id: string;
    mtime: number;
    summary: string;
    agentType: 'claude' | 'codex' | 'opencode' | 'pi';
}

export interface SessionTail {
    prompt: string | null;   // last user text
    response: string | null; // last assistant text response
    turns?: SessionTurn[];   // recent turns, oldest first
}

export interface SessionTurn {
    prompt: string | null;
    response: string | null;
}

export interface Message {
    type: MessageType;
    content: any;
    id?: string;
    raw_data?: any;
}

export interface TextBlock {
    type: 'text';
    text: string;
}

export interface AssistantMessage extends Message {
    type: 'text'; // We treat assistant message as text for simplicity in VS Code UI, or we can use content blocks
    content: string;
}

export interface PermissionResult {
    behavior: 'allow' | 'deny';
    updatedInput?: any;
    message?: string;
}

export interface AgentOptions {
    cwd?: string;
    cliPath?: string;
    systemPrompt?: string;
    maxTurns?: number;
    allowedTools?: string[];
    disallowedTools?: string[];
    permissionMode?: string;
    model?: string | null;
    planMode?: boolean;
    sandboxMode?: string;
    approveMode?: 'default' | 'accept-all' | 'allow-edit';
    sessionId?: string;
    extraEnv?: Record<string, string>;
    env?: Record<string, string>;
    addDirs?: string[];
    debugAgentMessage?: boolean;
    enableFileCheckpoint?: boolean;
}

export abstract class BaseAgent {
    protected messageCallbacks: ((msg: Message) => void)[] = [];
    protected errorCallbacks: ((err: Error) => void)[] = [];
    protected closeCallbacks: ((code: number | null) => void)[] = [];

    protected cwd?: string;
    protected env?: Record<string, string>;
    protected addDirs: string[] = [];
    protected sessionId?: string;
    protected model: string | null = null;
    protected planMode: boolean = false;
    protected approveMode: 'default' | 'accept-all' | 'allow-edit' = 'default';
    protected disallowedTools: string[] = [];
    protected enableFileCheckpoint: boolean = true;

    constructor(
        cwdOrOptions?: string | AgentOptions,
        env?: Record<string, string>,
        addDirs?: string[],
        sessionId?: string,
        model?: string | null
    ) {
        if (typeof cwdOrOptions === 'object' && cwdOrOptions !== null) {
            const opts = cwdOrOptions;
            this.cwd = opts.cwd;
            this.env = opts.extraEnv || opts.env;
            this.addDirs = opts.addDirs ? [...opts.addDirs] : [];
            this.sessionId = opts.sessionId;
            this.model = opts.model || null;
            this.planMode = opts.planMode || false;
            this.approveMode = opts.approveMode || 'default';
            this.disallowedTools = opts.disallowedTools ? [...opts.disallowedTools] : [];
            if (opts.enableFileCheckpoint !== undefined) {
                this.enableFileCheckpoint = opts.enableFileCheckpoint;
            }
        } else {
            this.cwd = cwdOrOptions;
            this.env = env;
            this.addDirs = addDirs ? [...addDirs] : [];
            this.sessionId = sessionId;
            this.model = model || null;
        }
    }

    public getModel(): string | null {
        return this.model;
    }

    public getEnableFileCheckpoint(): boolean {
        return this.enableFileCheckpoint;
    }

    public setEnableFileCheckpoint(enable: boolean): void {
        this.enableFileCheckpoint = enable;
    }

    abstract connect(prompt?: string): Promise<void>;
    abstract sendMessage(content: string, parentToolUseId?: string, proceedPlan?: boolean): Promise<void>;
    abstract steer(text: string, proceedPlan?: boolean): Promise<void>;
    abstract disconnect(): void;
    abstract interrupt(): Promise<void>;

    // Control methods
    abstract setPlanMode(enabled: boolean): Promise<void>;
    abstract setApproveMode(mode: 'default' | 'accept-all' | 'allow-edit'): Promise<void>;
    abstract setModel(model: string | null): Promise<void>;
    
    public setDisallowedTools(tools: string[]) {
        this.disallowedTools = tools;
    }

    public onMessage(callback: (msg: Message) => void) {
        this.messageCallbacks.push(callback);
    }

    public offMessage(callback: (msg: Message) => void) {
        this.messageCallbacks = this.messageCallbacks.filter(cb => cb !== callback);
    }

    public onError(callback: (err: Error) => void) {
        this.errorCallbacks.push(callback);
    }

    public offError(callback: (err: Error) => void) {
        this.errorCallbacks = this.errorCallbacks.filter(cb => cb !== callback);
    }

    public onClose(callback: (code: number | null) => void) {
        this.closeCallbacks.push(callback);
    }

    public offClose(callback: (code: number | null) => void) {
        this.closeCallbacks = this.closeCallbacks.filter(cb => cb !== callback);
    }

    private static readonly CLOSE_SENTINEL = Symbol('CLOSE_SENTINEL');

    /**
     * Receive messages as an async iterable stream.
     * Supports `for await (const msg of agent.receiveMessages())` or `for await (const msg of agent)`.
     *
     * @param options Optional configuration:
     *   - `stopOnTurnEnd`: if true, finishes iteration after receiving a 'stop' or 'result' message.
     */
    public async *receiveMessages(options?: { stopOnTurnEnd?: boolean }): AsyncIterableIterator<Message> {
        const queue: (Message | Error | typeof BaseAgent.CLOSE_SENTINEL)[] = [];
        let notify: (() => void) | null = null;
        let closed = false;

        const messageHandler = (msg: Message) => {
            queue.push(msg);
            if (notify) {
                const fn = notify;
                notify = null;
                fn();
            }
        };

        const errorHandler = (err: Error) => {
            queue.push(err);
            if (notify) {
                const fn = notify;
                notify = null;
                fn();
            }
        };

        const closeHandler = (_code: number | null) => {
            closed = true;
            queue.push(BaseAgent.CLOSE_SENTINEL);
            if (notify) {
                const fn = notify;
                notify = null;
                fn();
            }
        };

        this.onMessage(messageHandler);
        this.onError(errorHandler);
        this.onClose(closeHandler);

        try {
            while (true) {
                while (queue.length > 0) {
                    const item = queue.shift()!;
                    if (item === BaseAgent.CLOSE_SENTINEL) {
                        return;
                    }
                    if (item instanceof Error) {
                        throw item;
                    }
                    yield item;
                    if (options?.stopOnTurnEnd && (item.type === 'stop' || item.type === 'result')) {
                        return;
                    }
                }

                if (closed) {
                    return;
                }

                await new Promise<void>((resolve) => {
                    notify = resolve;
                });
            }
        } finally {
            this.offMessage(messageHandler);
            this.offError(errorHandler);
            this.offClose(closeHandler);
        }
    }

    public [Symbol.asyncIterator](): AsyncIterableIterator<Message> {
        return this.receiveMessages();
    }

    protected emitMessage(msg: Message) {
        if (BaseAgent.debugMessages) {
            logger.info(`received: ${JSON.stringify(msg)}`);
        }
        this.messageCallbacks.forEach(cb => cb(msg));
    }

    static debugMessages: boolean = false;

    protected emitError(err: Error) {
        this.errorCallbacks.forEach(cb => cb(err));
    }

    protected emitClose(code: number | null) {
        this.closeCallbacks.forEach(cb => cb(code));
    }

    // Response to control requests (like permission)
    abstract respondToControlRequest(requestId: string, result: PermissionResult): Promise<void>;

    /**
     * Rewind the conversation to the given checkpoint.
     * @param checkpoint  For Claude: the user-message UUID to fork up to (inclusive).
     *                    For Codex: the 1-based turn index to roll back to.
     * @returns the session id to resume from after rewinding, or null if the
     *          agent does not support a stateful rewind (caller falls back to a
     *          fresh restart).
     */
    public async rewind(_checkpoint: string): Promise<string | null> {
        return null;
    }
}
