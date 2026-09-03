import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAgent, findClaudeCli } from '../dist/index.js';
import type { AgentOptions } from '../dist/index.js';

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
        assert.equal(capturedArgs.includes('--model'), false);
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

    it('test_claude_agent_options_and_model', async () => {
        const options: AgentOptions = {
            cwd: '/workspace',
            model: 'claude-3-7-sonnet',
            systemPrompt: 'System prompt via options',
            allowedTools: ['Bash', 'Read'],
            planMode: true,
        };

        const agent = new ClaudeAgent(options);
        assert.equal(agent.getModel(), 'claude-3-7-sonnet');
        assert.equal(agent.getSystemPrompt(), 'System prompt via options');
        assert.deepEqual(agent.getAllowedTools(), ['Bash', 'Read']);

        let capturedArgs: string[] = [];
        (agent as any).spawnProcess = (cmdArgs: string[]) => {
            capturedArgs = cmdArgs;
            return { stdout: null, stderr: null, kill: () => {}, on: () => {} } as any;
        };

        await agent.connect();

        const modelIdx = capturedArgs.indexOf('--model');
        assert.ok(modelIdx !== -1, '--model flag should be present');
        assert.equal(capturedArgs[modelIdx + 1], 'claude-3-7-sonnet');

        const promptIdx = capturedArgs.indexOf('--system-prompt');
        assert.ok(promptIdx !== -1);
        assert.equal(capturedArgs[promptIdx + 1], 'System prompt via options');

        const toolsIdx = capturedArgs.indexOf('--allowedTools');
        assert.ok(toolsIdx !== -1);
        assert.equal(capturedArgs[toolsIdx + 1], 'Bash,Read');

        assert.ok(capturedArgs.includes('--permission-mode'));
        assert.ok(capturedArgs.includes('plan'));

        // Test setModel
        await agent.setModel('claude-3-5-haiku');
        assert.equal(agent.getModel(), 'claude-3-5-haiku');
    });

    it('test_claude_rewind_files', async () => {
        const agent = new ClaudeAgent('/workspace');

        // Should throw when not connected
        await assert.rejects(
            async () => {
                await agent.rewindFiles('user-msg-001');
            },
            {
                name: 'Error',
                message: 'Client is not connected. Call connect() first.'
            }
        );

        // When connected, sends control request
        (agent as any).isConnected = true;
        let sentRequest: any = null;
        (agent as any).sendControlRequest = async (req: any) => {
            sentRequest = req;
        };

        await agent.rewindFiles('user-msg-002');
        assert.deepEqual(sentRequest, {
            subtype: 'rewind_files',
            user_message_id: 'user-msg-002'
        });
    });

    it('test_claude_enable_file_checkpoint_env', async () => {
        const agent = new ClaudeAgent({
            cwd: '/workspace',
            enableFileCheckpoint: false
        });

        assert.equal(agent.getEnableFileCheckpoint(), false);

        let capturedEnv: Record<string, string> = {};
        (agent as any).spawnProcess = (_args: string[], env: Record<string, string>) => {
            capturedEnv = env;
            return { stdout: null, stderr: null, kill: () => {}, on: () => {} } as any;
        };

        await agent.connect();
        assert.equal(capturedEnv['CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING'], undefined);

        // Re-enable
        agent.setEnableFileCheckpoint(true);
        assert.equal(agent.getEnableFileCheckpoint(), true);
    });
});
