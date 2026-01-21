import type { PushMessage } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { OnLifecycleEvent, type NodeExecuteAfterContext } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { ensureError } from 'n8n-workflow';

import { Push } from '@/push';
import { OwnershipService } from '@/services/ownership.service';

/**
 * Service that handles browser API calls triggered by workflow nodes.
 * When a node sets browserApi metadata, this service sends a push message
 * to connected browser sessions to invoke the appropriate browser API.
 *
 * Security: Messages are sent only to the user who triggered the execution
 * (for manual executions) or to the workflow owner (for production executions).
 * Messages are never broadcast to all connected users.
 *
 */
@Service()
export class BrowserApiService {
	constructor(
		private readonly push: Push,
		private readonly logger: Logger,
		private readonly ownershipService: OwnershipService,
	) {
		this.logger = this.logger.scoped('push');
	}

	@OnLifecycleEvent('nodeExecuteAfter')
	async handleNodeExecuteAfter(ctx: NodeExecuteAfterContext) {
		const browserApi = ctx.taskData.metadata?.browserApi;

		if (!browserApi) {
			return;
		}

		const pushMessage = {
			type: 'browserApi',
			data: {
				...browserApi,
				workflowId: ctx.workflow.id,
				workflowName: ctx.workflow.name,
			},
		} as PushMessage;

		const pushRef = ctx.executionData.pushRef;
		if (pushRef) {
			this.logger.debug('Sending browser API message to session', {
				workflowId: ctx.workflow.id,
				nodeName: ctx.nodeName,
				type: browserApi.type,
				pushRef,
			});
			this.push.send(pushMessage, pushRef);
			return;
		}

		const manualUserId = ctx.executionData.manualData?.userId;
		if (manualUserId) {
			this.logger.debug('Sending browser API message to user', {
				workflowId: ctx.workflow.id,
				nodeName: ctx.nodeName,
				type: browserApi.type,
				userId: manualUserId,
			});
			this.push.sendToUsers(pushMessage, [manualUserId]);
			return;
		}

		try {
			const project = await this.ownershipService.getWorkflowProjectCached(ctx.workflow.id);
			const owner = await this.ownershipService.getPersonalProjectOwnerCached(project.id);

			if (owner) {
				this.logger.debug('Sending browser API message to workflow owner', {
					workflowId: ctx.workflow.id,
					nodeName: ctx.nodeName,
					type: browserApi.type,
					ownerId: owner.id,
				});
				this.push.sendToUsers(pushMessage, [owner.id]);
			} else {
				this.logger.debug('Skipping browser API message for team project workflow', {
					workflowId: ctx.workflow.id,
					nodeName: ctx.nodeName,
					type: browserApi.type,
					projectId: project.id,
				});
			}
		} catch (error) {
			this.logger.warn('Failed to determine workflow owner for browser API message', {
				workflowId: ctx.workflow.id,
				nodeName: ctx.nodeName,
				error: ensureError(error),
			});
		}
	}
}
