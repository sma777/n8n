import { testDb, testModules } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';

import { ChatHubMemoryRepository } from '../chat-hub-memory.repository';
import { ChatHubSessionRepository } from '../chat-session.repository';

beforeAll(async () => {
	await testModules.loadModules(['chat-hub']);
	await testDb.init();
});

beforeEach(async () => {
	await testDb.truncate(['ChatHubMemory', 'ChatHubSession']);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('ChatHubMemoryRepository', () => {
	let memoryRepository: ChatHubMemoryRepository;
	let sessionRepository: ChatHubSessionRepository;

	beforeAll(() => {
		memoryRepository = Container.get(ChatHubMemoryRepository);
		sessionRepository = Container.get(ChatHubSessionRepository);
	});

	const createTestSession = async (id?: string) => {
		const sessionId = id ?? crypto.randomUUID();
		await sessionRepository.createChatSession({
			id: sessionId,
			ownerId: null,
			title: 'Test Session',
			lastMessageAt: new Date(),
			tools: [],
		});
		return sessionId;
	};

	describe('createMemoryEntry', () => {
		it('should create a memory entry', async () => {
			const sessionId = await createTestSession();
			const entryId = crypto.randomUUID();
			const turnId = crypto.randomUUID();

			const id = await memoryRepository.createMemoryEntry({
				id: entryId,
				sessionId,
				turnId,
				role: 'human',
				content: { content: 'Hello' },
				name: 'User',
			});

			expect(id).toBe(entryId);

			const entry = await memoryRepository.findOne({ where: { id: entryId } });
			expect(entry).not.toBeNull();
			expect(entry?.role).toBe('human');
			expect(entry?.content).toEqual({ content: 'Hello' });
		});

		it('should throw error if id is missing', async () => {
			const sessionId = await createTestSession();
			const turnId = crypto.randomUUID();

			await expect(
				memoryRepository.createMemoryEntry({
					id: '',
					sessionId,
					turnId,
					role: 'human',
					content: { content: 'Hello' },
					name: 'User',
				}),
			).rejects.toThrow('Memory entry ID is required');
		});

		it('should throw error if sessionId is missing', async () => {
			const turnId = crypto.randomUUID();

			await expect(
				memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId: '',
					turnId,
					role: 'human',
					content: { content: 'Hello' },
					name: 'User',
				}),
			).rejects.toThrow('Session ID is required');
		});

		it('should store expiresAt when provided', async () => {
			const sessionId = await createTestSession();
			const entryId = crypto.randomUUID();
			const turnId = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 3600000);

			await memoryRepository.createMemoryEntry({
				id: entryId,
				sessionId,
				turnId,
				role: 'human',
				content: { content: 'Hello' },
				name: 'User',
				expiresAt,
			});

			const entry = await memoryRepository.findOne({ where: { id: entryId } });
			expect(entry?.expiresAt).toEqual(expiresAt);
		});
	});

	describe('getMemoryByTurnIds', () => {
		it('should return empty array for empty turnIds', async () => {
			const sessionId = await createTestSession();

			const result = await memoryRepository.getMemoryByTurnIds(sessionId, []);

			expect(result).toEqual([]);
		});

		it('should return only entries matching the specified turnIds', async () => {
			const sessionId = await createTestSession();
			const turnId1 = crypto.randomUUID();
			const turnId2 = crypto.randomUUID();
			const turnId3 = crypto.randomUUID();

			// Create entries with different turnIds
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId1,
				role: 'human',
				content: { content: 'Turn 1' },
				name: 'User',
			});
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId2,
				role: 'human',
				content: { content: 'Turn 2' },
				name: 'User',
			});
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId3,
				role: 'human',
				content: { content: 'Turn 3' },
				name: 'User',
			});

			const result = await memoryRepository.getMemoryByTurnIds(sessionId, [turnId1, turnId3]);

			expect(result).toHaveLength(2);
			// Don't assert order - timestamps may be identical causing non-deterministic ordering
			expect(result.map((e) => e.content)).toEqual(
				expect.arrayContaining([{ content: 'Turn 1' }, { content: 'Turn 3' }]),
			);
		});

		it('should return entries in chronological order', async () => {
			const sessionId = await createTestSession();
			const turnId = crypto.randomUUID();

			// Create entries in reverse order
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId,
				role: 'human',
				content: { content: 'First' },
				name: 'User',
			});

			// Small delay to ensure different createdAt timestamps
			await new Promise((resolve) => setTimeout(resolve, 10));

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId,
				role: 'ai',
				content: { content: 'Second' },
				name: 'AI',
			});

			const result = await memoryRepository.getMemoryByTurnIds(sessionId, [turnId]);

			expect(result).toHaveLength(2);
			expect(result[0].content).toEqual({ content: 'First' });
			expect(result[1].content).toEqual({ content: 'Second' });
		});
	});

	describe('getAllMemoryForNode', () => {
		it('should return all entries for a session and node', async () => {
			const sessionId = await createTestSession();
			const turnId1 = crypto.randomUUID();
			const turnId2 = crypto.randomUUID();

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId1,
				role: 'human',
				content: { content: 'Message 1' },
				name: 'User',
			});
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId2,
				role: 'ai',
				content: { content: 'Message 2' },
				name: 'AI',
			});

			const result = await memoryRepository.getAllMemoryForNode(sessionId);

			expect(result).toHaveLength(2);
		});

		it('should return empty array when no entries exist', async () => {
			const sessionId = await createTestSession();

			const result = await memoryRepository.getAllMemoryForNode(sessionId);

			expect(result).toEqual([]);
		});

		it('should not return entries from other sessions', async () => {
			const session1 = await createTestSession();
			const session2 = await createTestSession();
			const turnId = crypto.randomUUID();

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId: session1,
				turnId,
				role: 'human',
				content: { content: 'Session 1' },
				name: 'User',
			});
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId: session2,
				turnId,
				role: 'human',
				content: { content: 'Session 2' },
				name: 'User',
			});

			const result = await memoryRepository.getAllMemoryForNode(session1);

			expect(result).toHaveLength(1);
			expect(result[0].content).toEqual({ content: 'Session 1' });
		});
	});

	describe('deleteBySessionId', () => {
		it('should delete all entries for a session', async () => {
			const sessionId = await createTestSession();
			const turnId1 = crypto.randomUUID();
			const turnId2 = crypto.randomUUID();

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId1,
				role: 'human',
				content: { content: 'Entry 1' },
				name: 'User',
			});
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId2,
				role: 'ai',
				content: { content: 'Entry 2' },
				name: 'AI',
			});

			await memoryRepository.deleteBySessionId(sessionId);

			const remaining = await memoryRepository.find({ where: { sessionId } });
			expect(remaining).toHaveLength(0);
		});

		it('should not affect other sessions', async () => {
			const session1 = await createTestSession();
			const session2 = await createTestSession();
			const turnId = crypto.randomUUID();

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId: session1,
				turnId,
				role: 'human',
				content: { content: 'Session 1' },
				name: 'User',
			});
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId: session2,
				turnId,
				role: 'human',
				content: { content: 'Session 2' },
				name: 'User',
			});

			await memoryRepository.deleteBySessionId(session1);

			const remaining = await memoryRepository.find({});
			expect(remaining).toHaveLength(1);
			expect(remaining[0].sessionId).toBe(session2);
		});
	});

	describe('deleteExpiredEntries', () => {
		it('should delete entries where expiresAt is in the past', async () => {
			const sessionId = await createTestSession();
			const turnId1 = crypto.randomUUID();
			const turnId2 = crypto.randomUUID();

			// Create expired entry
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId1,
				role: 'human',
				content: { content: 'Expired' },
				name: 'User',
				expiresAt: new Date(Date.now() - 1000),
			});

			// Create valid entry
			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId: turnId2,
				role: 'human',
				content: { content: 'Valid' },
				name: 'User',
				expiresAt: new Date(Date.now() + 3600000),
			});

			const deletedCount = await memoryRepository.deleteExpiredEntries();

			expect(deletedCount).toBe(1);

			const remaining = await memoryRepository.find({ where: { sessionId } });
			expect(remaining).toHaveLength(1);
			expect(remaining[0].content).toEqual({ content: 'Valid' });
		});

		it('should not delete entries with null expiresAt', async () => {
			const sessionId = await createTestSession();
			const turnId = crypto.randomUUID();

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId,
				role: 'human',
				content: { content: 'Permanent' },
				name: 'User',
				expiresAt: null,
			});

			const deletedCount = await memoryRepository.deleteExpiredEntries();

			expect(deletedCount).toBe(0);

			const remaining = await memoryRepository.find({ where: { sessionId } });
			expect(remaining).toHaveLength(1);
		});

		it('should return 0 when no expired entries exist', async () => {
			const sessionId = await createTestSession();
			const turnId = crypto.randomUUID();

			await memoryRepository.createMemoryEntry({
				id: crypto.randomUUID(),
				sessionId,
				turnId,
				role: 'human',
				content: { content: 'Future expiry' },
				name: 'User',
				expiresAt: new Date(Date.now() + 3600000),
			});

			const deletedCount = await memoryRepository.deleteExpiredEntries();

			expect(deletedCount).toBe(0);
		});
	});
});
