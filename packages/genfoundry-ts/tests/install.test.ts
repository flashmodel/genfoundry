import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentId } from '../dist/index.js';
import {
    AGENT_LABEL,
    AGENT_DOCS_URL,
    getAgentInstallInfo,
    findExistingCli,
} from '../dist/index.js';

describe('Install & CLI Discovery tests', () => {
    const agents: AgentId[] = ['claude', 'codex', 'opencode', 'pi'];

    it('test_agent_labels_and_docs', () => {
        for (const agent of agents) {
            assert.ok(AGENT_LABEL[agent], `Missing label for ${agent}`);
            assert.ok(AGENT_DOCS_URL[agent].startsWith('https://'), `Missing docs URL for ${agent}`);
        }
    });

    it('test_get_agent_install_info', () => {
        for (const agent of agents) {
            const info = getAgentInstallInfo(agent);
            assert.equal(info.displayName, AGENT_LABEL[agent]);
            assert.equal(typeof info.supported, 'boolean');
            assert.ok(info.extraEnv !== undefined);
            if (info.supported) {
                assert.ok(info.command !== null && info.command.length > 0);
            }
        }
    });

    it('test_find_existing_cli_honours_custom_command', () => {
        // An existing custom command path is returned directly
        const custom = findExistingCli('codex', process.execPath);
        assert.equal(custom, process.execPath);

        // When custom command is not supplied, it probes the system
        const detected = findExistingCli('codex');
        assert.ok(detected === null || typeof detected === 'string');
    });
});
