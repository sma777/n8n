import { testDb, testModules } from '@n8n/backend-test-utils';
import type { User } from '@n8n/db';
import { Container } from '@n8n/di';
import {
	MEMORY_BUFFER_WINDOW_NODE_TYPE,
	Workflow,
	CHAT_TRIGGER_NODE_TYPE,
	type INode,
} from 'n8n-workflow';

import { createMember } from '@test-integration/db/users';

import { ChatHubMemoryRepository } from '../chat-hub-memory.repository';
import { ChatHubProxyService, isAllowedNode } from '../chat-hub-proxy.service';
import { ChatHubSessionRepository } from '../chat-session.repository';

beforeAll(async () => {
	await testModules.loadModules(['chat-hub']);
	await testDb.init();
});

beforeEach(async () => {
	await testDb.truncate(['ChatHubMemory', 'ChatHubSession', 'User']);
});

afterAll(async () => {
	await testDb.terminate();
});

describe('ChatHubProxyService', () => {
	let proxyService: ChatHubProxyService;
	let memoryRepository: ChatHubMemoryRepository;
	let sessionRepository: ChatHubSessionRepository;
	let user: User;

	beforeAll(() => {
		proxyService = Container.get(ChatHubProxyService);
		memoryRepository = Container.get(ChatHubMemoryRepository);
		sessionRepository = Container.get(ChatHubSessionRepository);
	});

	beforeEach(async () => {
		user = await createMember();
	});

	describe('isAllowedNode', () => {
		it('should return true for Memory Buffer Window node', () => {
			expect(isAllowedNode(MEMORY_BUFFER_WINDOW_NODE_TYPE)).toBe(true);
		});

		it('should return false for other node types', () => {
			expect(isAllowedNode('n8n-nodes-base.code')).toBe(false);
			expect(isAllowedNode('n8n-nodes-base.set')).toBe(false);
			expect(isAllowedNode('@n8n/n8n-nodes-langchain.agent')).toBe(false);
		});
	});

	describe('getChatHubProxy', () => {
		const createTestWorkflow = (overrides?: {
			name?: string;
			agentName?: string;
		}): Workflow => {
			const nodes: Record<string, INode> = {
				trigger: {
					id: 'chat-trigger-1',
					name: 'Chat Trigger',
					type: CHAT_TRIGGER_NODE_TYPE,
					typeVersion: 1.4,
					position: [0, 0],
					parameters: {
						...(overrides?.agentName && { agentName: overrides.agentName }),
					},
				},
				memory: {
					id: 'memory-1',
					name: 'Memory',
					type: MEMORY_BUFFER_WINDOW_NODE_TYPE,
					typeVersion: 1.3,
					position: [200, 0],
					parameters: {},
				},
			};

			return new Workflow({
				// Use undefined to avoid FK constraint on workflowId
				id: undefined as unknown as string,
				name: overrides?.name ?? 'Test Workflow',
				nodes: Object.values(nodes),
				connections: {},
				active: true,
				nodeTypes: {
					getByName: () => undefined,
					getByNameAndVersion: () => undefined,
					getKnownTypes: () => ({}),
				} as unknown as Workflow['nodeTypes'],
			});
		};

		const createMemoryNode = (): INode => ({
			id: 'memory-1',
			name: 'Memory',
			type: MEMORY_BUFFER_WINDOW_NODE_TYPE,
			typeVersion: 1.3,
			position: [200, 0],
			parameters: {},
		});

		it('should throw error for non-allowed node types', async () => {
			const workflow = createTestWorkflow();
			const invalidNode: INode = {
				id: 'code-1',
				name: 'Code',
				type: 'n8n-nodes-base.code',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			};

			await expect(
				proxyService.getChatHubProxy(
					workflow,
					invalidNode,
					'session-1',
					'memory-node-1',
					null,
					null,
				),
			).rejects.toThrow('This proxy is only available for Chat Hub Memory nodes');
		});

		it('should create session when it does not exist', async () => {
			const workflow = createTestWorkflow({ name: 'My Agent' });
			const node = createMemoryNode();
			const sessionId = crypto.randomUUID();

			await proxyService.getChatHubProxy(workflow, node, sessionId, 'memory-1', null, null);

			const session = await sessionRepository.findOne({ where: { id: sessionId } });
			expect(session).not.toBeNull();
			expect(session?.title).toBe('My Agent');
			expect(session?.agentName).toBe('My Agent');
			expect(session?.ownerId).toBeNull();
		});

		it('should use agentName from chat trigger if available', async () => {
			const workflow = createTestWorkflow({
				name: 'Workflow Name',
				agentName: 'Custom Agent Name',
			});
			const node = createMemoryNode();
			const sessionId = crypto.randomUUID();

			await proxyService.getChatHubProxy(workflow, node, sessionId, 'memory-1', null, null);

			const session = await sessionRepository.findOne({ where: { id: sessionId } });
			expect(session?.agentName).toBe('Custom Agent Name');
		});

		it('should fall back to workflow name when agentName is not set', async () => {
			const workflow = createTestWorkflow({ name: 'My Workflow' });
			const node = createMemoryNode();
			const sessionId = crypto.randomUUID();

			await proxyService.getChatHubProxy(workflow, node, sessionId, 'memory-1', null, null);

			const session = await sessionRepository.findOne({ where: { id: sessionId } });
			expect(session?.agentName).toBe('My Workflow');
		});

		it('should create session with ownerId when provided', async () => {
			const workflow = createTestWorkflow();
			const node = createMemoryNode();
			const sessionId = crypto.randomUUID();

			await proxyService.getChatHubProxy(
				workflow,
				node,
				sessionId,
				'memory-1',
				null,
				null,
				user.id,
			);

			const session = await sessionRepository.findOne({ where: { id: sessionId } });
			expect(session?.ownerId).toBe(user.id);
		});

		describe('memory operations', () => {
			it('should add human message with expiresAt for anonymous session', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
				);

				await proxy.addHumanMessage('Hello, world!');

				const entries = await memoryRepository.find({ where: { sessionId } });
				expect(entries).toHaveLength(1);
				expect(entries[0].role).toBe('human');
				expect(entries[0].content).toEqual({ content: 'Hello, world!' });
				expect(entries[0].expiresAt).not.toBeNull();
				// Should expire roughly 1 hour from now
				const expiresIn = entries[0].expiresAt!.getTime() - Date.now();
				expect(expiresIn).toBeGreaterThan(55 * 60 * 1000); // > 55 minutes
				expect(expiresIn).toBeLessThan(65 * 60 * 1000); // < 65 minutes
			});

			it('should add human message without expiresAt for authenticated session', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
					user.id,
				);

				await proxy.addHumanMessage('Hello, authenticated!');

				const entries = await memoryRepository.find({ where: { sessionId } });
				expect(entries).toHaveLength(1);
				expect(entries[0].expiresAt).toBeNull();
			});

			it('should add AI message with tool calls', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
				);

				const toolCalls = [{ id: 'call-1', name: 'search', args: { query: 'test' } }];
				await proxy.addAIMessage('Here is the result', toolCalls);

				const entries = await memoryRepository.find({ where: { sessionId } });
				expect(entries).toHaveLength(1);
				expect(entries[0].role).toBe('ai');
				expect(entries[0].content).toEqual({ content: 'Here is the result', toolCalls });
			});

			it('should add tool message', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
				);

				await proxy.addToolMessage('call-1', 'search', { query: 'test' }, { results: ['a', 'b'] });

				const entries = await memoryRepository.find({ where: { sessionId } });
				expect(entries).toHaveLength(1);
				expect(entries[0].role).toBe('tool');
				expect(entries[0].name).toBe('search');
				expect(entries[0].content).toEqual({
					toolCallId: 'call-1',
					toolName: 'search',
					toolInput: { query: 'test' },
					toolOutput: { results: ['a', 'b'] },
				});
			});

			it('should get memory entries for all turns when previousTurnIds is null', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();
				const turnId1 = crypto.randomUUID();
				const turnId2 = crypto.randomUUID();

				// Create session first (required for FK constraint)
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Test Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Create some memory entries
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-1',
					turnId: turnId1,
					role: 'human',
					content: { content: 'First message' },
					name: 'User',
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-1',
					turnId: turnId2,
					role: 'ai',
					content: { content: 'Response' },
					name: 'AI',
				});

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null, // No previousTurnIds - should get all
				);

				const memory = await proxy.getMemory();
				expect(memory).toHaveLength(2);
			});

			it('should get memory entries only for specified turnIds', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();
				const turnId1 = crypto.randomUUID();
				const turnId2 = crypto.randomUUID();
				const turnId3 = crypto.randomUUID();
				const turnIdCurrent = crypto.randomUUID();

				// Create session first (required for FK constraint)
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Test Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Create memory entries with different turnIds
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-1',
					turnId: turnId1,
					role: 'human',
					content: { content: 'Turn 1 message' },
					name: 'User',
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-1',
					turnId: turnId2,
					role: 'human',
					content: { content: 'Turn 2 message' },
					name: 'User',
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-1',
					turnId: turnId3,
					role: 'human',
					content: { content: 'Turn 3 message' },
					name: 'User',
				});

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					turnIdCurrent,
					[turnId1, turnId3], // Only get turn-1 and turn-3
				);

				const memory = await proxy.getMemory();
				expect(memory).toHaveLength(2);
				// Don't assert order - timestamps may be identical causing non-deterministic ordering
				expect(memory.map((m) => m.content)).toEqual(
					expect.arrayContaining([{ content: 'Turn 1 message' }, { content: 'Turn 3 message' }]),
				);
			});

			it('should clear memory for the specific node', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				// Create session first (required for FK constraint)
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Test Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Create entries for two different memory nodes
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-1',
					turnId: null,
					role: 'human',
					content: { content: 'Node 1 message' },
					name: 'User',
				});
				await memoryRepository.createMemoryEntry({
					id: crypto.randomUUID(),
					sessionId,
					memoryNodeId: 'memory-2',
					turnId: null,
					role: 'human',
					content: { content: 'Node 2 message' },
					name: 'User',
				});

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
				);

				await proxy.clearMemory();

				const remaining = await memoryRepository.find({ where: { sessionId } });
				expect(remaining).toHaveLength(1);
				expect(remaining[0].memoryNodeId).toBe('memory-2');
			});

			it('should link memory entries with turnId', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();
				const turnId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					turnId,
					null,
				);

				await proxy.addHumanMessage('Question');
				await proxy.addAIMessage('Answer', []);

				const entries = await memoryRepository.find({
					where: { sessionId },
					order: { createdAt: 'ASC' },
				});
				expect(entries).toHaveLength(2);
				expect(entries[0].turnId).toBe(turnId);
				expect(entries[1].turnId).toBe(turnId);
			});

			it('should generate turnId when not provided', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null, // No turnId provided
					null,
				);

				await proxy.addHumanMessage('Message 1');
				await proxy.addAIMessage('Response', []);

				const entries = await memoryRepository.find({ where: { sessionId } });
				expect(entries).toHaveLength(2);
				// Both should have the same generated turnId
				expect(entries[0].turnId).toBe(entries[1].turnId);
				expect(entries[0].turnId).not.toBeNull();
			});
		});

		describe('getOwnerId', () => {
			it('should return ownerId when set', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
					user.id,
				);

				expect(proxy.getOwnerId()).toBe(user.id);
			});

			it('should return undefined when ownerId not set', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
				);

				expect(proxy.getOwnerId()).toBeUndefined();
			});
		});

		describe('session access control', () => {
			it('should not allow accessing another users session', async () => {
				const user2 = await createMember();
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				// Create session owned by user (first user)
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: user.id,
					title: 'User 1 Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Try to access as user2
				await expect(
					proxyService.getChatHubProxy(workflow, node, sessionId, 'memory-1', null, null, user2.id),
				).rejects.toThrow('You are not allowed to access this session');
			});

			it('should allow owner to access their session', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				// Create session owned by user
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: user.id,
					title: 'User Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Access as owner should work
				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
					user.id,
				);

				expect(proxy).toBeDefined();
			});

			it('should allow anonymous access to anonymous session', async () => {
				const workflow = createTestWorkflow();
				const node = createMemoryNode();
				const sessionId = crypto.randomUUID();

				// Create anonymous session
				await sessionRepository.createChatSession({
					id: sessionId,
					ownerId: null,
					title: 'Anonymous Session',
					lastMessageAt: new Date(),
					tools: [],
				});

				// Anonymous access should work
				const proxy = await proxyService.getChatHubProxy(
					workflow,
					node,
					sessionId,
					'memory-1',
					null,
					null,
				);

				expect(proxy).toBeDefined();
			});
		});
	});
});
