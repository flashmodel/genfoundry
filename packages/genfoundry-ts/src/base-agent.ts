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

export abstract class BaseAgent {
    protected messageCallbacks: ((msg: Message) => void)[] = [];
    protected errorCallbacks: ((err: Error) => void)[] = [];
    protected closeCallbacks: ((code: number | null) => void)[] = [];

    protected planMode: boolean = false;
    protected approveMode: 'default' | 'accept-all' | 'allow-edit' = 'default';
    protected addDirs: string[] = [];
    protected disallowedTools: string[] = [];

    constructor(protected cwd?: string, protected env?: Record<string, string>, addDirs?: string[], protected sessionId?: string) {
        this.addDirs = addDirs || [];
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

    public onError(callback: (err: Error) => void) {
        this.errorCallbacks.push(callback);
    }

    public onClose(callback: (code: number | null) => void) {
        this.closeCallbacks.push(callback);
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
