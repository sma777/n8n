import type { Logger } from '@n8n/backend-common';
import { mockInstance } from '@n8n/backend-test-utils';
import type { NodeExecuteAfterContext } from '@n8n/decorators';
import { mock } from 'jest-mock-extended';

import { Push } from '@/push';
import { OwnershipService } from '@/services/ownership.service';

import { BrowserApiService } from '../browser-api.service';

describe('BrowserApiService', () => {
	const logger = mock<Logger>();
	const push = mockInstance(Push);
	const ownershipService = mockInstance(OwnershipService);

	let service: BrowserApiService;

	beforeEach(() => {
		jest.clearAllMocks();
		logger.scoped.mockReturnValue(logger);
		service = new BrowserApiService(push, logger, ownershipService);
	});

	const createMockContext = (overrides: {
		taskDataMetadata?: Record<string, unknown>;
		executionDataOverrides?: Record<string, unknown>;
	}): NodeExecuteAfterContext => {
		const ctx = mock<NodeExecuteAfterContext>();
		Object.assign(ctx, {
			workflow: { id: 'workflow-123', name: 'Test Workflow' },
			nodeName: 'Browser Notification',
			taskData: { metadata: overrides.taskDataMetadata ?? {} },
			executionData: overrides.executionDataOverrides ?? {},
		});
		return ctx;
	};

	describe('handleNodeExecuteAfter', () => {
		it('should do nothing when no browserApi metadata is present', async () => {
			const ctx = createMockContext({});

			await service.handleNodeExecuteAfter(ctx);

			expect(push.send).not.toHaveBeenCalled();
			expect(push.sendToUsers).not.toHaveBeenCalled();
		});

		it('should send to pushRef when available (manual execution with session)', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'notification',
						notification: { title: 'Test' },
					},
				},
				executionDataOverrides: { pushRef: 'push-ref-123' },
			});

			await service.handleNodeExecuteAfter(ctx);

			expect(push.send).toHaveBeenCalledWith(
				{
					type: 'browserApi',
					data: {
						type: 'notification',
						notification: { title: 'Test' },
						workflowId: 'workflow-123',
						workflowName: 'Test Workflow',
					},
				},
				'push-ref-123',
			);
			expect(push.sendToUsers).not.toHaveBeenCalled();
		});

		it('should send to userId when pushRef is not available but manualData.userId is', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'playSound',
						playSound: { sound: 'success', volume: 1 },
					},
				},
				executionDataOverrides: { manualData: { userId: 'user-456' } },
			});

			await service.handleNodeExecuteAfter(ctx);

			expect(push.send).not.toHaveBeenCalled();
			expect(push.sendToUsers).toHaveBeenCalledWith(
				{
					type: 'browserApi',
					data: {
						type: 'playSound',
						playSound: { sound: 'success', volume: 1 },
						workflowId: 'workflow-123',
						workflowName: 'Test Workflow',
					},
				},
				['user-456'],
			);
		});

		it('should send to workflow owner for production executions', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'notification',
						notification: { title: 'Production Alert' },
					},
				},
				executionDataOverrides: {},
			});

			ownershipService.getWorkflowProjectCached.mockResolvedValue({
				id: 'project-789',
			} as Awaited<ReturnType<typeof ownershipService.getWorkflowProjectCached>>);
			ownershipService.getPersonalProjectOwnerCached.mockResolvedValue({
				id: 'owner-999',
			} as Awaited<ReturnType<typeof ownershipService.getPersonalProjectOwnerCached>>);

			await service.handleNodeExecuteAfter(ctx);

			expect(ownershipService.getWorkflowProjectCached).toHaveBeenCalledWith('workflow-123');
			expect(ownershipService.getPersonalProjectOwnerCached).toHaveBeenCalledWith('project-789');
			expect(push.sendToUsers).toHaveBeenCalledWith(
				{
					type: 'browserApi',
					data: {
						type: 'notification',
						notification: { title: 'Production Alert' },
						workflowId: 'workflow-123',
						workflowName: 'Test Workflow',
					},
				},
				['owner-999'],
			);
		});

		it('should skip sending for team projects (no personal owner)', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'notification',
						notification: { title: 'Team Notification' },
					},
				},
				executionDataOverrides: {},
			});

			ownershipService.getWorkflowProjectCached.mockResolvedValue({
				id: 'team-project',
			} as Awaited<ReturnType<typeof ownershipService.getWorkflowProjectCached>>);
			ownershipService.getPersonalProjectOwnerCached.mockResolvedValue(null);

			await service.handleNodeExecuteAfter(ctx);

			expect(push.send).not.toHaveBeenCalled();
			expect(push.sendToUsers).not.toHaveBeenCalled();
			expect(logger.debug).toHaveBeenCalledWith(
				'Skipping browser API message for team project workflow',
				expect.objectContaining({
					workflowId: 'workflow-123',
					projectId: 'team-project',
				}),
			);
		});

		it('should handle errors when determining workflow owner', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'notification',
						notification: { title: 'Test' },
					},
				},
				executionDataOverrides: {},
			});

			const error = new Error('Database error');
			ownershipService.getWorkflowProjectCached.mockRejectedValue(error);

			await service.handleNodeExecuteAfter(ctx);

			expect(push.send).not.toHaveBeenCalled();
			expect(push.sendToUsers).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to determine workflow owner for browser API message',
				expect.objectContaining({
					workflowId: 'workflow-123',
					nodeName: 'Browser Notification',
				}),
			);
		});

		it('should prioritize pushRef over userId', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'notification',
						notification: { title: 'Test' },
					},
				},
				executionDataOverrides: {
					pushRef: 'push-ref-123',
					manualData: { userId: 'user-456' },
				},
			});

			await service.handleNodeExecuteAfter(ctx);

			expect(push.send).toHaveBeenCalledWith(expect.any(Object), 'push-ref-123');
			expect(push.sendToUsers).not.toHaveBeenCalled();
		});

		it('should prioritize userId over owner lookup', async () => {
			const ctx = createMockContext({
				taskDataMetadata: {
					browserApi: {
						type: 'notification',
						notification: { title: 'Test' },
					},
				},
				executionDataOverrides: {
					manualData: { userId: 'user-456' },
				},
			});

			await service.handleNodeExecuteAfter(ctx);

			expect(push.sendToUsers).toHaveBeenCalledWith(expect.any(Object), ['user-456']);
			expect(ownershipService.getWorkflowProjectCached).not.toHaveBeenCalled();
		});
	});
});
