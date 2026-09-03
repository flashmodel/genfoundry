import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeAgent, findOpenCodeCli } from '../dist/index.js';
import type { Message } from '../dist/index.js';

describe('OpenCodeAgent tests (parity with test_opencode_agent.py)', () => {
    let agent: OpenCodeAgent;
    let messages: Message[];

    beforeEach(() => {
        agent = new OpenCodeAgent('/workspace', undefined, undefined, undefined, 'ses_test');
        (agent as any).sessionId = 'ses_test';
        (agent as any).turnActive = true;
        messages = [];
        agent.onMessage(msg => messages.push(msg));
    });

    it('test_finds_opencode_cli', () => {
        const cli = findOpenCodeCli();
        assert.ok(typeof cli === 'string' && cli.length > 0);
    });

    it('test_text_delta_and_full_update_are_not_duplicated', () => {
        (agent as any).dispatchEvent({
            type: 'message.part.delta',
            properties: {
                sessionID: 'ses_test',
                messageID: 'msg_1',
                partID: 'part_1',
                field: 'text',
                delta: 'hello',
            },
        });

        (agent as any).dispatchEvent({
            type: 'message.part.updated',
            properties: {
                part: {
                    id: 'part_1',
                    sessionID: 'ses_test',
                    messageID: 'msg_1',
                    type: 'text',
                    text: 'hello world',
                },
            },
        });

        const textMessages = messages.filter(m => m.type === 'text');
        assert.deepEqual(
            textMessages.map(m => m.content),
            ['hello', ' world']
        );
    });

    it('test_user_text_part_is_not_emitted', () => {
        (agent as any).dispatchEvent({
            type: 'message.updated',
            properties: {
                info: {
                    id: 'msg_user',
                    sessionID: 'ses_test',
                    role: 'user',
                },
            },
        });

        (agent as any).dispatchEvent({
            type: 'message.part.updated',
            properties: {
                part: {
                    id: 'part_user',
                    sessionID: 'ses_test',
                    messageID: 'msg_user',
                    type: 'text',
                    text: 'about you',
                },
            },
        });

        const textMessages = messages.filter(m => m.type === 'text');
        assert.equal(textMessages.length, 0);
    });

    it('test_submitted_user_delta_is_ignored_before_role_event', () => {
        (agent as any).userMessageIds.add('msg_user');

        (agent as any).dispatchEvent({
            type: 'message.part.delta',
            properties: {
                sessionID: 'ses_test',
                messageID: 'msg_user',
                partID: 'part_user',
                field: 'text',
                delta: 'about you',
            },
        });

        const textMessages = messages.filter(m => m.type === 'text');
        assert.equal(textMessages.length, 0);
    });

    it('test_tool_is_emitted_only_once_at_terminal_state', () => {
        const basePart = {
            id: 'tool_1',
            sessionID: 'ses_test',
            messageID: 'msg_1',
            type: 'tool',
            tool: 'bash',
        };

        for (const status of ['pending', 'running', 'completed', 'completed']) {
            const part = {
                ...basePart,
                state: {
                    status,
                    input: { command: 'pwd' },
                    title: 'pwd',
                    output: '/tmp',
                },
            };
            (agent as any).dispatchEvent({
                type: 'message.part.updated',
                properties: { part },
            });
        }

        const toolMessages = messages.filter(m => m.type === 'tool_use');
        assert.equal(toolMessages.length, 1);
        assert.equal(toolMessages[0].content.status, 'completed');
        assert.equal(toolMessages[0].content.name, 'command_execution');
        assert.equal(toolMessages[0].content.input.command, 'pwd');
    });

    it('test_plan_text_is_flushed_when_session_becomes_idle', () => {
        (agent as any).turnPlanMode = true;

        (agent as any).dispatchEvent({
            type: 'message.part.delta',
            properties: {
                sessionID: 'ses_test',
                messageID: 'msg_1',
                partID: 'part_1',
                field: 'text',
                delta: '1. inspect\n2. edit',
            },
        });

        (agent as any).dispatchEvent({
            type: 'session.idle',
            properties: { sessionID: 'ses_test' },
        });

        const types = messages.map(m => m.type);
        assert.deepEqual(types, ['plan_delta', 'stop']);
        assert.equal(messages[0].content, '1. inspect\n2. edit');
    });

    it('test_permission_event_uses_termmate_control_shape', () => {
        (agent as any).dispatchEvent({
            type: 'permission.asked',
            properties: {
                requestID: 'perm_1',
                sessionID: 'ses_test',
                type: 'bash',
                title: 'Run tests',
                metadata: { command: 'npm test' },
            },
        });

        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, 'control_request');
        const req = messages[0].content.request;
        assert.equal(req.tool_name, 'Bash');
        assert.equal(req.input.command, 'npm test');
    });

    it('test_current_permission_event_with_string_kind_is_emitted', () => {
        (agent as any).dispatchEvent({
            type: 'permission.asked',
            properties: {
                id: 'perm_current',
                sessionID: 'ses_test',
                permission: 'bash',
                patterns: ['git status && git diff HEAD'],
                metadata: { command: 'git status && git diff HEAD' },
                always: ['git status*'],
                tool: {
                    messageID: 'msg_1',
                    callID: 'call_1',
                },
            },
        });

        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, 'control_request');
        const req = messages[0].content.request;
        assert.equal(req.tool_name, 'Bash');
        assert.deepEqual(req.input.pattern, ['git status && git diff HEAD']);
        assert.equal((agent as any).permissionSessions.get('perm_current'), 'ses_test');
    });

    it('test_session_filtering', () => {
        (agent as any).dispatchEvent({
            type: 'message.part.delta',
            properties: {
                sessionID: 'other_session',
                messageID: 'msg_other',
                partID: 'part_other',
                delta: 'ignored delta',
            },
        });

        assert.equal(messages.length, 0);
    });

    it('test_session_diff_generates_unified_patches', () => {
        (agent as any).dispatchEvent({
            type: 'session.diff',
            properties: {
                sessionID: 'ses_test',
                diff: [
                    {
                        file: 'index.ts',
                        before: 'const x = 1;\n',
                        after: 'const x = 2;\n',
                        additions: 1,
                        deletions: 1,
                    },
                ],
            },
        });

        const toolUses = messages.filter(m => m.type === 'tool_use');
        assert.equal(toolUses.length, 1);
        assert.equal(toolUses[0].content.name, 'fileChange');
        assert.equal(toolUses[0].content.changes[0].path, 'index.ts');
        assert.ok(toolUses[0].content.changes[0].diff.includes('-const x = 1;'));
        assert.ok(toolUses[0].content.changes[0].diff.includes('+const x = 2;'));
    });
});
