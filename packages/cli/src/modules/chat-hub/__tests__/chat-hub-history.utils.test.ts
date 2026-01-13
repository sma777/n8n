import { buildMessageHistory, extractTurnIds } from '../chat-hub-history.utils';
import type { ChatHubMessage } from '../chat-hub-message.entity';

const createMessage = (
	overrides: Partial<ChatHubMessage> & Pick<ChatHubMessage, 'id'>,
): ChatHubMessage => {
	const { id, ...rest } = overrides;
	return {
		id,
		sessionId: 'session-1',
		name: 'Test',
		type: 'human',
		content: 'test message',
		status: 'success',
		createdAt: new Date('2025-01-01T00:00:00Z'),
		updatedAt: new Date('2025-01-01T00:00:00Z'),
		setUpdateDate: () => {},
		session: {} as ChatHubMessage['session'],
		previousMessageId: null,
		retryOfMessageId: null,
		revisionOfMessageId: null,
		turnId: null,
		provider: null,
		model: null,
		workflowId: null,
		agentId: null,
		executionId: null,
		attachments: null,
		...rest,
	};
};

describe('chat-hub-history.utils', () => {
	describe('buildMessageHistory', () => {
		it('should return empty array for empty messages', () => {
			const result = buildMessageHistory([], null);
			expect(result).toEqual([]);
		});

		it('should return single message when only one exists', () => {
			const messages = [createMessage({ id: 'msg-1', content: 'Hello' })];

			const result = buildMessageHistory(messages, null);

			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('msg-1');
			expect(result[0].content).toBe('Hello');
		});

		it('should build linear chain from messages using previousMessageId', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					content: 'Second',
					previousMessageId: 'msg-1',
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
				createMessage({
					id: 'msg-3',
					content: 'Third',
					previousMessageId: 'msg-2',
					createdAt: new Date('2025-01-01T00:02:00Z'),
				}),
			];

			const result = buildMessageHistory(messages, null);

			expect(result).toHaveLength(3);
			expect(result[0].id).toBe('msg-1');
			expect(result[1].id).toBe('msg-2');
			expect(result[2].id).toBe('msg-3');
		});

		it('should start from specified lastMessageId', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					content: 'Second',
					previousMessageId: 'msg-1',
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
				createMessage({
					id: 'msg-3',
					content: 'Third',
					previousMessageId: 'msg-2',
					createdAt: new Date('2025-01-01T00:02:00Z'),
				}),
			];

			// Start from msg-2, should only include msg-1 and msg-2
			const result = buildMessageHistory(messages, 'msg-2');

			expect(result).toHaveLength(2);
			expect(result[0].id).toBe('msg-1');
			expect(result[1].id).toBe('msg-2');
		});

		it('should filter out messages superseded by revision', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					type: 'ai',
					content: 'Original response',
					previousMessageId: 'msg-1',
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
				createMessage({
					id: 'msg-3',
					content: 'Edited question',
					previousMessageId: 'msg-1',
					revisionOfMessageId: 'msg-2', // Supersedes msg-2
					createdAt: new Date('2025-01-01T00:02:00Z'),
				}),
				createMessage({
					id: 'msg-4',
					type: 'ai',
					content: 'New response to edit',
					previousMessageId: 'msg-3',
					createdAt: new Date('2025-01-01T00:03:00Z'),
				}),
			];

			const result = buildMessageHistory(messages, 'msg-4');

			// msg-2 should be superseded by msg-3's revision
			expect(result).toHaveLength(3);
			expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-3', 'msg-4']);
		});

		it('should filter out messages superseded by retry', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'Question',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					type: 'ai',
					content: 'Bad response',
					previousMessageId: 'msg-1',
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
				createMessage({
					id: 'msg-3',
					type: 'ai',
					content: 'Better response',
					previousMessageId: 'msg-1',
					retryOfMessageId: 'msg-2', // Supersedes msg-2
					createdAt: new Date('2025-01-01T00:02:00Z'),
				}),
			];

			const result = buildMessageHistory(messages, 'msg-3');

			// msg-2 should be superseded by msg-3's retry
			expect(result).toHaveLength(2);
			expect(result.map((m) => m.id)).toEqual(['msg-1', 'msg-3']);
		});

		it('should handle complex branching with multiple edits', () => {
			// Scenario:
			// msg-1 (human)
			// |- msg-2 (ai, original)
			// │  |─ msg-3a (human, original follow-up)
			// │     |- msg-4a (ai)
			// |- msg-3b (human, edit of msg-3a, revision of msg-2)
			//    |- msg-4b (ai)

			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First question',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					type: 'ai',
					content: 'First response',
					previousMessageId: 'msg-1',
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
				createMessage({
					id: 'msg-3a',
					content: 'Follow-up A',
					previousMessageId: 'msg-2',
					createdAt: new Date('2025-01-01T00:02:00Z'),
				}),
				createMessage({
					id: 'msg-4a',
					type: 'ai',
					content: 'Response to A',
					previousMessageId: 'msg-3a',
					createdAt: new Date('2025-01-01T00:03:00Z'),
				}),
				createMessage({
					id: 'msg-3b',
					content: 'Follow-up B (edit)',
					previousMessageId: 'msg-2',
					revisionOfMessageId: 'msg-3a',
					createdAt: new Date('2025-01-01T00:04:00Z'),
				}),
				createMessage({
					id: 'msg-4b',
					type: 'ai',
					content: 'Response to B',
					previousMessageId: 'msg-3b',
					createdAt: new Date('2025-01-01T00:05:00Z'),
				}),
			];

			// When viewing from msg-4b (the edited branch)
			const resultB = buildMessageHistory(messages, 'msg-4b');
			expect(resultB).toHaveLength(4);
			expect(resultB.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-3b', 'msg-4b']);

			// When viewing from msg-4a (the original branch) - msg-3a is superseded
			const resultA = buildMessageHistory(messages, 'msg-4a');
			expect(resultA).toHaveLength(3);
			// msg-3a is filtered out because it was superseded by msg-3b
			expect(resultA.map((m) => m.id)).toEqual(['msg-1', 'msg-2', 'msg-4a']);
		});

		it('should use most recent message when lastMessageId is null', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					content: 'Second',
					previousMessageId: 'msg-1',
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
				createMessage({
					id: 'msg-3',
					content: 'Most recent',
					previousMessageId: 'msg-2',
					createdAt: new Date('2025-01-01T00:02:00Z'),
				}),
			];

			const result = buildMessageHistory(messages, null);

			expect(result).toHaveLength(3);
			expect(result[2].id).toBe('msg-3');
		});

		it('should handle missing previousMessageId gracefully', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First',
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					content: 'Second',
					previousMessageId: 'non-existent', // Points to non-existent message
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
			];

			const result = buildMessageHistory(messages, 'msg-2');

			// Should stop at msg-2 since non-existent message doesn't exist
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe('msg-2');
		});

		it('should return correct message format', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					type: 'human',
					content: 'Hello',
					name: 'User',
					createdAt: new Date('2025-01-01T00:00:00Z'),
					previousMessageId: null,
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-1',
				}),
			];

			const result = buildMessageHistory(messages, null);

			expect(result[0]).toEqual({
				id: 'msg-1',
				type: 'human',
				content: 'Hello',
				name: 'User',
				createdAt: new Date('2025-01-01T00:00:00Z'),
				previousMessageId: null,
				retryOfMessageId: null,
				revisionOfMessageId: null,
				turnId: 'turn-1',
			});
		});

		it('should prevent infinite loops with circular references', () => {
			// This shouldn't happen in practice, but the visited set should prevent infinite loops
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'First',
					previousMessageId: 'msg-2', // Circular
					createdAt: new Date('2025-01-01T00:00:00Z'),
				}),
				createMessage({
					id: 'msg-2',
					content: 'Second',
					previousMessageId: 'msg-1', // Circular
					createdAt: new Date('2025-01-01T00:01:00Z'),
				}),
			];

			// Should not hang, should complete
			const result = buildMessageHistory(messages, 'msg-2');

			// Should have at most 2 messages (visited set prevents revisiting)
			expect(result.length).toBeLessThanOrEqual(2);
		});
	});

	describe('extractTurnIds', () => {
		it('should return empty array for empty messages', () => {
			const result = extractTurnIds([]);
			expect(result).toEqual([]);
		});

		it('should extract turnIds from AI messages only', () => {
			const messages = [
				{
					id: 'msg-1',
					type: 'human' as const,
					content: 'Question',
					name: 'User',
					createdAt: new Date(),
					previousMessageId: null,
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-1', // Should be ignored (human message)
				},
				{
					id: 'msg-2',
					type: 'ai' as const,
					content: 'Response',
					name: 'AI',
					createdAt: new Date(),
					previousMessageId: 'msg-1',
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-2', // Should be included
				},
				{
					id: 'msg-3',
					type: 'human' as const,
					content: 'Follow-up',
					name: 'User',
					createdAt: new Date(),
					previousMessageId: 'msg-2',
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-3', // Should be ignored (human message)
				},
				{
					id: 'msg-4',
					type: 'ai' as const,
					content: 'Another response',
					name: 'AI',
					createdAt: new Date(),
					previousMessageId: 'msg-3',
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-4', // Should be included
				},
			];

			const result = extractTurnIds(messages);

			expect(result).toEqual(['turn-2', 'turn-4']);
		});

		it('should exclude AI messages with null turnId', () => {
			const messages = [
				{
					id: 'msg-1',
					type: 'ai' as const,
					content: 'Response without turnId',
					name: 'AI',
					createdAt: new Date(),
					previousMessageId: null,
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: null, // Should be excluded
				},
				{
					id: 'msg-2',
					type: 'ai' as const,
					content: 'Response with turnId',
					name: 'AI',
					createdAt: new Date(),
					previousMessageId: 'msg-1',
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-1', // Should be included
				},
			];

			const result = extractTurnIds(messages);

			expect(result).toEqual(['turn-1']);
		});

		it('should preserve chronological order of turnIds', () => {
			const messages = [
				{
					id: 'msg-1',
					type: 'ai' as const,
					content: 'First',
					name: 'AI',
					createdAt: new Date('2025-01-01T00:00:00Z'),
					previousMessageId: null,
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-a',
				},
				{
					id: 'msg-2',
					type: 'ai' as const,
					content: 'Second',
					name: 'AI',
					createdAt: new Date('2025-01-01T00:01:00Z'),
					previousMessageId: 'msg-1',
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-b',
				},
				{
					id: 'msg-3',
					type: 'ai' as const,
					content: 'Third',
					name: 'AI',
					createdAt: new Date('2025-01-01T00:02:00Z'),
					previousMessageId: 'msg-2',
					retryOfMessageId: null,
					revisionOfMessageId: null,
					turnId: 'turn-c',
				},
			];

			const result = extractTurnIds(messages);

			expect(result).toEqual(['turn-a', 'turn-b', 'turn-c']);
		});
	});
});
