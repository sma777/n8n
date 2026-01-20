import { testDb, testModules } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import { createMember } from '@test-integration/db/users';

import { ChatHubMemoryCleanupService } from '../chat-hub-memory-cleanup.service';
import { ChatMemoryRepository } from '../chat-memory.repository';
import { ChatMemorySessionRepository } from '../chat-memory-session.repository';
import { ChatHubMessageRepository } from '../chat-message.repository';
import { ChatHubSessionRepository } from '../chat-session.repository';

beforeAll(async () => {
	await testModules.loadModules(['chat-hub']);
	await testDb.init();
});

beforeEach(async () => {
	await testDb.truncate(['ChatMemory', 'ChatMemorySession', 'ChatHubMessage', 'ChatHubSession']);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('ChatHubMemoryCleanupService integration', () => {
	let cleanupService: ChatHubMemoryCleanupService;
	let memoryRepository: ChatMemoryRepository;
	let memorySessionRepository: ChatMemorySessionRepository;
	let messageRepository: ChatHubMessageRepository;
	let chatHubSessionRepository: ChatHubSessionRepository;
	let user: User;

	beforeAll(() => {
		cleanupService = Container.get(ChatHubMemoryCleanupService);
		memoryRepository = Container.get(ChatMemoryRepository);
		memorySessionRepository = Container.get(ChatMemorySessionRepository);
		messageRepository = Container.get(ChatHubMessageRepository);
		chatHubSessionRepository = Container.get(ChatHubSessionRepository);
	});

	beforeEach(async () => {
		user = await createMember();
	});

	describe('runCleanup', () => {
		describe('expired memory cleanup', () => {
			it('should delete expired memory entries', async () => {
				const sessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				// Create an expired memory entry
				const expiredId = crypto.randomUUID();
				await memoryRepository.createMemoryEntry({
					id: expiredId,
					sessionKey,
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
					sessionKey,
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
				const sessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				// Create a memory entry without expiresAt (authenticated session)
				const memoryId = crypto.randomUUID();
				await memoryRepository.createMemoryEntry({
					id: memoryId,
					sessionKey,
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

		describe('orphaned memory session cleanup', () => {
			it('should delete memory sessions with no memory entries', async () => {
				const sessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				await cleanupService.runCleanup();

				const session = await memorySessionRepository.getBySessionKey(sessionKey);
				expect(session).toBeNull();
			});

			it('should not delete memory sessions that have entries', async () => {
				const sessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				// Add a memory entry (non-expired)
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionKey,
					turnId: null,
					role: 'human',
					content: { content: 'message' },
					name: 'User',
					expiresAt: new Date(Date.now() + 3600000), // expires in 1 hour
				});

				await cleanupService.runCleanup();

				const session = await memorySessionRepository.getBySessionKey(sessionKey);
				expect(session).not.toBeNull();
			});

			it('should delete memory sessions after their entries expire', async () => {
				const sessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				// Add an expired memory entry
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionKey,
					turnId: null,
					role: 'human',
					content: { content: 'expired message' },
					name: 'User',
					expiresAt: new Date(Date.now() - 1000), // expired
				});

				await cleanupService.runCleanup();

				// Both the memory entry and session should be deleted
				const memory = await memoryRepository.find({ where: { sessionKey } });
				expect(memory).toHaveLength(0);

				const session = await memorySessionRepository.getBySessionKey(sessionKey);
				expect(session).toBeNull();
			});
		});

		describe('orphaned chat hub session cleanup', () => {
			it('should delete chat hub sessions with no messages', async () => {
				const sessionId = crypto.randomUUID();
				await chatHubSessionRepository.createChatSession({
					id: sessionId,
					ownerId: user.id,
					title: 'Empty Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				await cleanupService.runCleanup();

				const session = await chatHubSessionRepository.findOne({ where: { id: sessionId } });
				expect(session).toBeNull();
			});

			it('should not delete chat hub sessions that have messages', async () => {
				const sessionId = crypto.randomUUID();
				await chatHubSessionRepository.createChatSession({
					id: sessionId,
					ownerId: user.id,
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

				const session = await chatHubSessionRepository.findOne({ where: { id: sessionId } });
				expect(session).not.toBeNull();
			});
		});

		describe('affected count', () => {
			it('should return accurate count of deleted orphaned memory sessions', async () => {
				// Create 3 empty memory sessions (all should be deleted)
				const sessionKeys = [
					`session-${crypto.randomUUID()}`,
					`session-${crypto.randomUUID()}`,
					`session-${crypto.randomUUID()}`,
				];
				for (const sessionKey of sessionKeys) {
					await memorySessionRepository.createSession({
						sessionKey,
						chatHubSessionId: null,
						workflowId: null,
					});
				}

				// Create 1 session with memory (should not be deleted)
				const keptSessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey: keptSessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionKey: keptSessionKey,
					turnId: null,
					role: 'human',
					content: { content: 'Hello' },
					name: 'User',
					expiresAt: new Date(Date.now() + 3600000),
				});

				const deletedCount = await memorySessionRepository.deleteOrphanedSessions();

				expect(deletedCount).toBe(3);

				// Verify the kept session still exists
				const keptSession = await memorySessionRepository.getBySessionKey(keptSessionKey);
				expect(keptSession).not.toBeNull();
			});

			it('should return accurate count of deleted expired memory entries', async () => {
				const sessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				// Create 4 expired memory entries
				for (let i = 0; i < 4; i++) {
					await memoryRepository.createMemoryEntry({
						id: crypto.randomUUID(),
						sessionKey,
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
						sessionKey,
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
				const remainingEntries = await memoryRepository.find({ where: { sessionKey } });
				expect(remainingEntries).toHaveLength(2);
			});
		});

		describe('combined scenarios', () => {
			it('should handle multiple sessions with mixed states', async () => {
				// Memory Session 1: Empty (should be deleted)
				const emptySessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey: emptySessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});

				// Memory Session 2: Has valid memory (should be kept)
				const memorySessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey: memorySessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionKey: memorySessionKey,
					turnId: null,
					role: 'human',
					content: { content: 'valid' },
					name: 'User',
					expiresAt: new Date(Date.now() + 3600000),
				});

				// Memory Session 3: Has expired memory only (should be deleted)
				const expiredMemorySessionKey = `session-${crypto.randomUUID()}`;
				await memorySessionRepository.createSession({
					sessionKey: expiredMemorySessionKey,
					chatHubSessionId: null,
					workflowId: null,
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionKey: expiredMemorySessionKey,
					turnId: null,
					role: 'human',
					content: { content: 'expired' },
					name: 'User',
					expiresAt: new Date(Date.now() - 1000),
				});

				// Chat Hub Session 1: Empty (should be deleted)
				const emptyChatHubSessionId = crypto.randomUUID();
				await chatHubSessionRepository.createChatSession({
					id: emptyChatHubSessionId,
					ownerId: user.id,
					title: 'Empty Chat Hub Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Chat Hub Session 2: Has messages (should be kept)
				const messageChatHubSessionId = crypto.randomUUID();
				await chatHubSessionRepository.createChatSession({
					id: messageChatHubSessionId,
					ownerId: user.id,
					title: 'Session with messages',
					lastMessageAt: new Date(),
					tools: [],
				});
				await messageRepository.createChatMessage({
					id: crypto.randomUUID(),
					sessionId: messageChatHubSessionId,
					name: 'User',
					type: 'human',
					content: 'Hello',
					createdAt: new Date(),
				});

				await cleanupService.runCleanup();

				// Empty memory session should be deleted
				expect(await memorySessionRepository.getBySessionKey(emptySessionKey)).toBeNull();

				// Memory session with valid entries should be kept
				expect(await memorySessionRepository.getBySessionKey(memorySessionKey)).not.toBeNull();

				// Memory session with expired entries should be deleted
				expect(await memorySessionRepository.getBySessionKey(expiredMemorySessionKey)).toBeNull();

				// Empty chat hub session should be deleted
				expect(
					await chatHubSessionRepository.findOne({ where: { id: emptyChatHubSessionId } }),
				).toBeNull();

				// Chat hub session with messages should be kept
				expect(
					await chatHubSessionRepository.findOne({ where: { id: messageChatHubSessionId } }),
				).not.toBeNull();
			});
		});
	});
});
