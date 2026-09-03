import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAgent, findCodexCli } from '../dist/index.js';
import type { Message } from '../dist/index.js';

function createMockCodexAgent(initialSessionId?: string) {
    const agent = new CodexAgent('/workspace', undefined, undefined, undefined, initialSessionId);
    const rpcCalls: any[] = [];

    // Mock fake process so isConnected and writeJson function without child processes
    const fakeProcess = {
        stdin: { write: () => true },
        kill: () => {},
        on: () => {},
    };
    (agent as any).process = fakeProcess;
    (agent as any).isConnected = true;
    (agent as any).threadId = initialSessionId || 'thread-001';

    (agent as any).writeJson = (data: any) => {
        rpcCalls.push(data);
        if (data.id !== undefined && data.method) {
            const rid = data.id;
            const method = data.method;
            if (method === 'initialize') {
                queueMicrotask(() => {
                    (agent as any).handleIncomingData({ id: rid, result: { capabilities: {} } });
                });
            } else if (method === 'thread/start' || method === 'thread/resume') {
                queueMicrotask(() => {
                    (agent as any).handleIncomingData({ id: rid, result: { thread: { id: 'thread-001' } } });
                });
            } else if (method === 'model/list') {
                queueMicrotask(() => {
                    (agent as any).handleIncomingData({ id: rid, result: { models: [] } });
                });
            } else if (method === 'turn/start') {
                const turnId = `turn-${rid}`;
                queueMicrotask(() => {
                    (agent as any).handleIncomingData({ id: rid, result: {} });
                    (agent as any).handleIncomingData({ method: 'turn/started', params: { turnId } });
                    (agent as any).handleIncomingData({
                        method: 'item/agentMessage/delta',
                        params: { itemId: `msg-${rid}`, delta: `Reply to turn ${rid}` },
                    });
                    (agent as any).handleIncomingData({
                        method: 'item/completed',
                        params: { item: { type: 'agentMessage', id: `msg-${rid}`, text: `Reply to turn ${rid}` } },
                    });
                    (agent as any).handleIncomingData({ method: 'turn/completed', params: { turnId } });
                });
            }
        }
    };

    return { agent, rpcCalls };
}

function collectTurn(agent: CodexAgent): Promise<Message[]> {
    return new Promise((resolve) => {
        const messages: Message[] = [];
        const onMsg = (msg: Message) => {
            messages.push(msg);
            if (msg.type === 'stop') {
                const callbacks = (agent as any).messageCallbacks as ((m: Message) => void)[];
                const idx = callbacks.indexOf(onMsg);
                if (idx !== -1) callbacks.splice(idx, 1);
                resolve(messages);
            }
        };
        agent.onMessage(onMsg);
    });
}

describe('CodexAgent tests (parity with test_codex_msg.py)', () => {
    it('test_two_turn_conversation', async () => {
        const { agent } = createMockCodexAgent();

        // --- Turn 1 ---
        const turn1Promise = collectTurn(agent);
        await agent.sendMessage('Hello, first message');
        const msgs1 = await turn1Promise;

        const textMsgs1 = msgs1.filter(m => m.type === 'text');
        const stopMsgs1 = msgs1.filter(m => m.type === 'stop');

        assert.ok(textMsgs1.length > 0, 'Turn 1 should have at least one text message');
        assert.equal(stopMsgs1.length, 1, 'Turn 1 should have exactly one stop');
        assert.ok(textMsgs1[0].content.includes('Reply to turn'));

        // --- Turn 2 ---
        const turn2Promise = collectTurn(agent);
        await agent.sendMessage('Hello, second message');
        const msgs2 = await turn2Promise;

        const textMsgs2 = msgs2.filter(m => m.type === 'text');
        const stopMsgs2 = msgs2.filter(m => m.type === 'stop');

        assert.ok(textMsgs2.length > 0, 'Turn 2 should have at least one text message');
        assert.equal(stopMsgs2.length, 1, 'Turn 2 should have exactly one stop');
        assert.ok(textMsgs2[0].content.includes('Reply to turn'));

        // Verify replies differ
        assert.notEqual(textMsgs1[0].content, textMsgs2[0].content, 'Turns should produce different replies');

        // Verify threadId was reused
        assert.equal((agent as any).threadId, 'thread-001');
    });

    it('test_thread_id_persists_across_turns', async () => {
        const { agent } = createMockCodexAgent();
        const tidBefore = (agent as any).threadId;
        assert.equal(tidBefore, 'thread-001');

        const p1 = collectTurn(agent);
        await agent.sendMessage('First');
        await p1;
        assert.equal((agent as any).threadId, tidBefore);

        const p2 = collectTurn(agent);
        await agent.sendMessage('Second');
        await p2;
        assert.equal((agent as any).threadId, tidBefore);
    });

    it('test_steer_plan', async () => {
        const { agent, rpcCalls } = createMockCodexAgent();
        (agent as any).activeTurnId = 'turn-XYZ';

        await agent.steer('Implement this plan');

        const steerCall = rpcCalls.find(c => c.method === 'turn/start');
        assert.ok(steerCall, 'Should make turn/start RPC call');
        assert.equal(steerCall.params.input[0].text, 'Implement this plan');
        assert.equal(steerCall.params.expectedTurnId, 'turn-XYZ');
        assert.equal(steerCall.params.threadId, 'thread-001');
    });

    it('test_command_execution_handling', async () => {
        const { agent } = createMockCodexAgent();
        const messages: Message[] = [];
        agent.onMessage(msg => messages.push(msg));

        (agent as any).handleIncomingData({
            method: 'item/started',
            params: {
                item: {
                    type: 'commandExecution',
                    id: 'cmd-1',
                    command: "/bin/zsh -lc 'ls'",
                    commandActions: [{ type: 'listFiles', command: 'ls' }],
                },
            },
        });

        const toolUses = messages.filter(m => m.type === 'tool_use');
        assert.equal(toolUses.length, 1, 'Should emit one tool_use message');
        assert.equal(toolUses[0].content.name, 'command_execution');
        assert.equal(toolUses[0].content.command, "/bin/zsh -lc 'ls'");
        assert.equal(toolUses[0].content.status, 'in_progress');
    });

    it('test_completed_tool_items_are_forwarded_for_formatting', () => {
        const { agent } = createMockCodexAgent();
        const messages: Message[] = [];
        agent.onMessage(msg => messages.push(msg));

        const items = [
            {
                type: 'mcpToolCall',
                id: 'mcp-1',
                server: 'github',
                tool: 'search_repositories',
                arguments: { query: 'codex' },
                status: 'completed',
            },
            {
                type: 'dynamicToolCall',
                id: 'dynamic-1',
                namespace: 'design',
                tool: 'choose',
                arguments: { theme: 'editorial' },
                status: 'completed',
            },
            {
                type: 'collabAgentToolCall',
                id: 'collab-1',
                tool: 'spawnAgent',
                receiverThreadIds: ['thread-2'],
                prompt: 'Inspect tests',
                model: 'gpt-5',
                reasoningEffort: 'high',
                status: 'completed',
            },
            {
                type: 'webSearch',
                id: 'search-1',
                query: 'Codex app-server protocol',
                action: { type: 'search' },
                status: 'completed',
            },
            {
                type: 'fileChange',
                id: 'file-1',
                changes: [{ path: 'test.txt', diff: '+test' }],
                status: 'completed',
            },
        ];

        for (const item of items) {
            (agent as any).handleIncomingData({
                method: 'item/completed',
                params: { item },
            });
        }

        assert.equal(messages.length, 5);
        assert.equal(messages[0].content.name, 'github·search_repositories');
        assert.deepEqual(messages[0].content.input, { query: 'codex' });
        assert.equal(messages[0].content.status, 'completed');

        assert.equal(messages[1].content.name, 'design·choose');
        assert.deepEqual(messages[1].content.input, { theme: 'editorial' });

        assert.equal(messages[2].content.name, 'spawnAgent');
        assert.equal(messages[2].content.input.agents, 'thread-2');
        assert.equal(messages[2].content.input.prompt, 'Inspect tests');
        assert.equal(messages[2].content.input.model, 'gpt-5');
        assert.equal(messages[2].content.input.reasoning, 'high');

        assert.equal(messages[3].content.name, 'webSearch');
        assert.deepEqual(messages[3].content.input, { type: 'search' });

        assert.equal(messages[4].content.name, 'fileChange');
        assert.deepEqual(messages[4].content.changes, [{ path: 'test.txt', diff: '+test' }]);
    });

    it('test_find_codex_cli', () => {
        const cli = findCodexCli();
        assert.ok(typeof cli === 'string' && cli.length > 0);
    });
});
