import { testDb, testModules } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';

import { ChatHubMemoryCleanupService } from '../chat-hub-memory-cleanup.service';
import { ChatHubMemoryRepository } from '../chat-hub-memory.repository';
import { ChatHubMessageRepository } from '../chat-message.repository';
import { ChatHubSessionRepository } from '../chat-session.repository';

beforeAll(async () => {
	await testModules.loadModules(['chat-hub']);
	await testDb.init();
});

beforeEach(async () => {
	await testDb.truncate(['ChatHubMemory', 'ChatHubMessage', 'ChatHubSession']);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('ChatHubMemoryCleanupService integration', () => {
	let cleanupService: ChatHubMemoryCleanupService;
	let memoryRepository: ChatHubMemoryRepository;
	let messageRepository: ChatHubMessageRepository;
	let sessionRepository: ChatHubSessionRepository;

	beforeAll(() => {
		cleanupService = Container.get(ChatHubMemoryCleanupService);
		memoryRepository = Container.get(ChatHubMemoryRepository);
		messageRepository = Container.get(ChatHubMessageRepository);
		sessionRepository = Container.get(ChatHubSessionRepository);
	});

	describe('runCleanup', () => {
		describe('expired memory cleanup', () => {
			it('should delete expired memory entries', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Test Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Create an expired memory entry
				const expiredId = crypto.randomUUID();
				await memoryRepository.createMemoryEntry({
					id: expiredId,
					sessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'expired message' },
					name: 'User',
					expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
				});

				// Create a non-expired memory entry
				const validId = crypto.randomUUID();
				await memoryRepository.createMemoryEntry({
					id: validId,
					sessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'valid message' },
					name: 'User',
					expiresAt: new Date(Date.now() + 3600000), // expires in 1 hour
				});

				await cleanupService.runCleanup();

				// Expired entry should be deleted
				const expiredEntry = await memoryRepository.findOne({ where: { id: expiredId } });
				expect(expiredEntry).toBeNull();

				// Valid entry should still exist
				const validEntry = await memoryRepository.findOne({ where: { id: validId } });
				expect(validEntry).not.toBeNull();
			});

			it('should not delete memory entries without expiresAt', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Test Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Create a memory entry without expiresAt (authenticated session)
				const memoryId = crypto.randomUUID();
				await memoryRepository.createMemoryEntry({
					id: memoryId,
					sessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'permanent message' },
					name: 'User',
					expiresAt: null,
				});

				await cleanupService.runCleanup();

				// Entry should still exist
				const entry = await memoryRepository.findOne({ where: { id: memoryId } });
				expect(entry).not.toBeNull();
			});
		});

		describe('orphaned session cleanup', () => {
			it('should delete sessions with no messages and no memory', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Empty Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				await cleanupService.runCleanup();

				const session = await sessionRepository.findOne({ where: { id: sessionId } });
				expect(session).toBeNull();
			});

			it('should not delete sessions that have messages', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Session with messages',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Add a message to the session
				await messageRepository.createChatMessage({
					id: crypto.randomUUID(),
					sessionId,
					name: 'User',
					type: 'human',
					content: 'Hello',
					createdAt: new Date(),
				});

				await cleanupService.runCleanup();

				const session = await sessionRepository.findOne({ where: { id: sessionId } });
				expect(session).not.toBeNull();
			});

			it('should not delete sessions that have memory entries', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Session with memory',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Add a memory entry (non-expired)
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'message' },
					name: 'User',
					expiresAt: new Date(Date.now() + 3600000), // expires in 1 hour
				});

				await cleanupService.runCleanup();

				const session = await sessionRepository.findOne({ where: { id: sessionId } });
				expect(session).not.toBeNull();
			});

			it('should delete sessions after their memory entries expire', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Session with expired memory',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Add an expired memory entry
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'expired message' },
					name: 'User',
					expiresAt: new Date(Date.now() - 1000), // expired
				});

				await cleanupService.runCleanup();

				// Both the memory entry and session should be deleted
				const memory = await memoryRepository.find({ where: { sessionId } });
				expect(memory).toHaveLength(0);

				const session = await sessionRepository.findOne({ where: { id: sessionId } });
				expect(session).toBeNull();
			});
		});

		describe('affected count', () => {
			it('should return accurate count of deleted orphaned sessions', async () => {
				// Create 3 empty sessions (all should be deleted)
				const sessionIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
				for (const id of sessionIds) {
					await sessionRepository.createChatSession({
						id,
						ownerId: null,
						title: `Empty Session ${id}`,
						lastMessageAt: new Date(),
						tools: [],
					});
				}

				// Create 1 session with a message (should not be deleted)
				const keptSessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: keptSessionId,
					ownerId: null,
					title: 'Session with message',
					lastMessageAt: new Date(),
					tools: [],
				});
				await messageRepository.createChatMessage({
					id: crypto.randomUUID(),
					sessionId: keptSessionId,
					name: 'User',
					type: 'human',
					content: 'Hello',
					createdAt: new Date(),
				});

				const deletedCount = await sessionRepository.deleteOrphanedSessions();

				expect(deletedCount).toBe(3);

				// Verify the kept session still exists
				const keptSession = await sessionRepository.findOne({ where: { id: keptSessionId } });
				expect(keptSession).not.toBeNull();
			});

			it('should return accurate count of deleted expired memory entries', async () => {
				const sessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Test Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Create 4 expired memory entries
				for (let i = 0; i < 4; i++) {
					await memoryRepository.createMemoryEntry({
						id: crypto.randomUUID(),
						sessionId,
						memoryNodeId: 'node-1',
						turnId: null,
						role: 'human',
						content: { content: `expired message ${i}` },
						name: 'User',
						expiresAt: new Date(Date.now() - 1000), // expired
					});
				}

				// Create 2 non-expired memory entries
				for (let i = 0; i < 2; i++) {
					await memoryRepository.createMemoryEntry({
						id: crypto.randomUUID(),
						sessionId,
						memoryNodeId: 'node-1',
						turnId: null,
						role: 'human',
						content: { content: `valid message ${i}` },
						name: 'User',
						expiresAt: new Date(Date.now() + 3600000), // expires in 1 hour
					});
				}

				const deletedCount = await memoryRepository.deleteExpiredEntries();

				expect(deletedCount).toBe(4);

				// Verify the valid entries still exist
				const remainingEntries = await memoryRepository.find({ where: { sessionId } });
				expect(remainingEntries).toHaveLength(2);
			});
		});

		describe('combined scenarios', () => {
			it('should handle multiple sessions with mixed states', async () => {
				// Session 1: Empty (should be deleted)
				const emptySessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: emptySessionId,
					ownerId: null,
					title: 'Empty Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Session 2: Has messages (should be kept)
				const messageSessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: messageSessionId,
					ownerId: null,
					title: 'Session with messages',
					lastMessageAt: new Date(),
					tools: [],
				});
				await messageRepository.createChatMessage({
					id: crypto.randomUUID(),
					sessionId: messageSessionId,
					name: 'User',
					type: 'human',
					content: 'Hello',
					createdAt: new Date(),
				});

				// Session 3: Has valid memory (should be kept)
				const memorySessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: memorySessionId,
					ownerId: null,
					title: 'Session with memory',
					lastMessageAt: new Date(),
					tools: [],
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId: memorySessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'valid' },
					name: 'User',
					expiresAt: new Date(Date.now() + 3600000),
				});

				// Session 4: Has expired memory only (should be deleted)
				const expiredMemorySessionId = crypto.randomUUID();
				await sessionRepository.createChatSession({
					id: expiredMemorySessionId,
					ownerId: null,
					title: 'Session with expired memory',
					lastMessageAt: new Date(),
					tools: [],
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId: expiredMemorySessionId,
					memoryNodeId: 'node-1',
					turnId: null,
					role: 'human',
					content: { content: 'expired' },
					name: 'User',
					expiresAt: new Date(Date.now() - 1000),
				});

				await cleanupService.runCleanup();

				// Empty session should be deleted
				expect(await sessionRepository.findOne({ where: { id: emptySessionId } })).toBeNull();

				// Session with messages should be kept
				expect(await sessionRepository.findOne({ where: { id: messageSessionId } })).not.toBeNull();

				// Session with valid memory should be kept
				expect(await sessionRepository.findOne({ where: { id: memorySessionId } })).not.toBeNull();

				// Session with expired memory should be deleted
				expect(
					await sessionRepository.findOne({ where: { id: expiredMemorySessionId } }),
				).toBeNull();
			});
		});
	});
});
