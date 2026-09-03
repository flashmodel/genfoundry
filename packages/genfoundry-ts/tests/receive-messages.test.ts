import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BaseAgent, ClaudeAgent, CodexAgent, PiAgent, OpenCodeAgent } from '../dist/index.js';
import type { Message, PermissionResult } from '../dist/index.js';

class MockAgent extends BaseAgent {
    async connect(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async steer(): Promise<void> {}
    disconnect(): void {
        this.emitClose(0);
    }
    async interrupt(): Promise<void> {}
    async setPlanMode(): Promise<void> {}
    async setApproveMode(): Promise<void> {}
    async setModel(): Promise<void> {}
    async respondToControlRequest(): Promise<void> {}

    public sendTestMessage(msg: Message): void {
        this.emitMessage(msg);
    }

    public sendTestError(err: Error): void {
        this.emitError(err);
    }

    public sendTestClose(code: number | null = 0): void {
        this.emitClose(code);
    }

    public getListenerCounts() {
        return {
            messages: this.messageCallbacks.length,
            errors: this.errorCallbacks.length,
            closes: this.closeCallbacks.length,
        };
    }
}

describe('receiveMessages and Symbol.asyncIterator tests', () => {
    it('test_receive_messages_yields_messages_until_close', async () => {
        const agent = new MockAgent();
        const received: Message[] = [];

        const consumerPromise = (async () => {
            for await (const msg of agent.receiveMessages()) {
                received.push(msg);
            }
        })();

        agent.sendTestMessage({ type: 'text', content: 'Hello' });
        agent.sendTestMessage({ type: 'thinking', content: 'Processing...' });
        agent.sendTestMessage({ type: 'tool_use', content: { name: 'Bash' } });
        agent.sendTestClose(0);

        await consumerPromise;

        assert.equal(received.length, 3);
        assert.equal(received[0].type, 'text');
        assert.equal(received[0].content, 'Hello');
        assert.equal(received[1].type, 'thinking');
        assert.equal(received[2].type, 'tool_use');
    });

    it('test_symbol_async_iterator_support', async () => {
        const agent = new MockAgent();
        const received: Message[] = [];

        const consumerPromise = (async () => {
            for await (const msg of agent) {
                received.push(msg);
            }
        })();

        agent.sendTestMessage({ type: 'text', content: 'Via Symbol.asyncIterator' });
        agent.sendTestClose(0);

        await consumerPromise;

        assert.equal(received.length, 1);
        assert.equal(received[0].content, 'Via Symbol.asyncIterator');
    });

    it('test_stop_on_turn_end_with_stop_message', async () => {
        const agent = new MockAgent();
        const received: Message[] = [];

        const consumerPromise = (async () => {
            for await (const msg of agent.receiveMessages({ stopOnTurnEnd: true })) {
                received.push(msg);
            }
        })();

        agent.sendTestMessage({ type: 'text', content: 'Answer text' });
        agent.sendTestMessage({ type: 'stop', content: null });
        // Emitted after stop - should not be received
        agent.sendTestMessage({ type: 'text', content: 'Ignored text' });

        await consumerPromise;

        assert.equal(received.length, 2);
        assert.equal(received[0].content, 'Answer text');
        assert.equal(received[1].type, 'stop');
    });

    it('test_stop_on_turn_end_with_result_message', async () => {
        const agent = new MockAgent();
        const received: Message[] = [];

        const consumerPromise = (async () => {
            for await (const msg of agent.receiveMessages({ stopOnTurnEnd: true })) {
                received.push(msg);
            }
        })();

        agent.sendTestMessage({ type: 'text', content: 'Work completed' });
        agent.sendTestMessage({ type: 'result', content: { success: true } });
        // Emitted after result - should not be received
        agent.sendTestMessage({ type: 'text', content: 'Ignored text' });

        await consumerPromise;

        assert.equal(received.length, 2);
        assert.equal(received[0].content, 'Work completed');
        assert.equal(received[1].type, 'result');
    });

    it('test_receive_messages_propagates_error', async () => {
        const agent = new MockAgent();
        const testError = new Error('Subprocess crash');

        await assert.rejects(
            async () => {
                const consumerPromise = (async () => {
                    for await (const _msg of agent.receiveMessages()) {
                        // wait for error
                    }
                })();

                agent.sendTestError(testError);
                await consumerPromise;
            },
            {
                name: 'Error',
                message: 'Subprocess crash'
            }
        );
    });

    it('test_early_break_cleans_up_listeners', async () => {
        const agent = new MockAgent();

        assert.deepEqual(agent.getListenerCounts(), { messages: 0, errors: 0, closes: 0 });

        const consumerPromise = (async () => {
            for await (const msg of agent.receiveMessages()) {
                if (msg.type === 'first') {
                    break;
                }
            }
        })();

        // Active iterator has registered listeners
        assert.deepEqual(agent.getListenerCounts(), { messages: 1, errors: 1, closes: 1 });

        // Send message to trigger early break
        agent.sendTestMessage({ type: 'first' });
        await consumerPromise;

        // Once the loop breaks, all listeners should be cleaned up
        assert.deepEqual(agent.getListenerCounts(), { messages: 0, errors: 0, closes: 0 });
    });

    it('test_concrete_agents_inherit_receive_messages', () => {
        const claude = new ClaudeAgent('/workspace');
        const codex = new CodexAgent('/workspace');
        const pi = new PiAgent('/workspace');
        const opencode = new OpenCodeAgent('/workspace');

        for (const agent of [claude, codex, pi, opencode]) {
            assert.equal(typeof agent.receiveMessages, 'function');
            assert.equal(typeof agent[Symbol.asyncIterator], 'function');
            assert.equal(typeof agent.offMessage, 'function');
            assert.equal(typeof agent.offError, 'function');
            assert.equal(typeof agent.offClose, 'function');
        }
    });
});
