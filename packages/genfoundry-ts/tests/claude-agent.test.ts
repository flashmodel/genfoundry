import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAgent, findClaudeCli } from '../dist/index.js';

describe('ClaudeAgent tests', () => {
    it('test_find_claude_cli', () => {
        const cli = findClaudeCli();
        assert.ok(typeof cli === 'string' && cli.length > 0);
    });

    it('test_claude_default_cmd_args', async () => {
        const agent = new ClaudeAgent('/workspace');
        let capturedArgs: string[] = [];

        (agent as any).spawnProcess = (cmdArgs: string[]) => {
            capturedArgs = cmdArgs;
            return {
                stdout: null,
                stderr: null,
                kill: () => {},
                on: () => {},
            } as any;
        };

        await agent.connect();

        assert.ok(capturedArgs.includes('--output-format=stream-json'));
        assert.ok(capturedArgs.includes('--input-format=stream-json'));
        assert.ok(capturedArgs.includes('--replay-user-messages'));
        assert.ok(capturedArgs.includes('--verbose'));
        assert.ok(capturedArgs.includes('--permission-prompt-tool=stdio'));
        assert.equal(capturedArgs.includes('--system-prompt'), false);
        assert.equal(capturedArgs.includes('--allowedTools'), false);
    });

    it('test_claude_system_prompt_via_constructor_and_setter', async () => {
        const agent = new ClaudeAgent(
            '/workspace',
            undefined,
            undefined,
            undefined,
            undefined,
            'You are an expert pair programmer.'
        );

        assert.equal(agent.getSystemPrompt(), 'You are an expert pair programmer.');

        let capturedArgs: string[] = [];
        (agent as any).spawnProcess = (cmdArgs: string[]) => {
            capturedArgs = cmdArgs;
            return { stdout: null, stderr: null, kill: () => {}, on: () => {} } as any;
        };

        await agent.connect();

        const sysPromptIdx = capturedArgs.indexOf('--system-prompt');
        assert.ok(sysPromptIdx !== -1, '--system-prompt flag should be present');
        assert.equal(capturedArgs[sysPromptIdx + 1], 'You are an expert pair programmer.');

        // Test updating via setter
        agent.setSystemPrompt('New prompt');
        assert.equal(agent.getSystemPrompt(), 'New prompt');
    });

    it('test_claude_allowed_tools_via_constructor_and_setter', async () => {
        const agent = new ClaudeAgent(
            '/workspace',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ['Bash', 'FileRead', 'FileEdit']
        );

        assert.deepEqual(agent.getAllowedTools(), ['Bash', 'FileRead', 'FileEdit']);

        let capturedArgs: string[] = [];
        (agent as any).spawnProcess = (cmdArgs: string[]) => {
            capturedArgs = cmdArgs;
            return { stdout: null, stderr: null, kill: () => {}, on: () => {} } as any;
        };

        await agent.connect();

        const allowedToolsIdx = capturedArgs.indexOf('--allowedTools');
        assert.ok(allowedToolsIdx !== -1, '--allowedTools flag should be present');
        assert.equal(capturedArgs[allowedToolsIdx + 1], 'Bash,FileRead,FileEdit');

        // Test updating via setter
        agent.setAllowedTools(['Glob', 'Grep']);
        assert.deepEqual(agent.getAllowedTools(), ['Glob', 'Grep']);
    });

    it('test_claude_combined_system_prompt_and_allowed_tools', async () => {
        const agent = new ClaudeAgent('/workspace');
        agent.setSystemPrompt('Custom instruction');
        agent.setAllowedTools(['WebSearch', 'Bash']);

        let capturedArgs: string[] = [];
        (agent as any).spawnProcess = (cmdArgs: string[]) => {
            capturedArgs = cmdArgs;
            return { stdout: null, stderr: null, kill: () => {}, on: () => {} } as any;
        };

        await agent.connect();

        const sysPromptIdx = capturedArgs.indexOf('--system-prompt');
        assert.ok(sysPromptIdx !== -1);
        assert.equal(capturedArgs[sysPromptIdx + 1], 'Custom instruction');

        const allowedToolsIdx = capturedArgs.indexOf('--allowedTools');
        assert.ok(allowedToolsIdx !== -1);
        assert.equal(capturedArgs[allowedToolsIdx + 1], 'WebSearch,Bash');
    });
});
