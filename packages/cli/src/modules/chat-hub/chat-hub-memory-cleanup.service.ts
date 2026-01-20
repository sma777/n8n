import { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { OnLeaderStepdown, OnLeaderTakeover, OnShutdown } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { ensureError } from 'n8n-workflow';

import { ChatHubMemoryRepository } from './chat-hub-memory.repository';
import { ChatHubSessionRepository } from './chat-session.repository';

const CLEANUP_INTERVAL_MS = 15 * Time.minutes.toMilliseconds;

/**
 * Responsible for cleaning up expired chat hub memory entries and orphaned anonymous sessions.
 *
 * - Runs every 15 minutes on the leader instance
 * - Deletes memory entries where expiresAt < NOW
 * - Deletes sessions that have no memory entries and no messages
 */
@Service()
export class ChatHubMemoryCleanupService {
	private cleanupInterval: NodeJS.Timeout | undefined;

	private isShuttingDown = false;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly memoryRepository: ChatHubMemoryRepository,
		private readonly sessionRepository: ChatHubSessionRepository,
	) {
		this.logger = this.logger.scoped('chat-hub');
	}

	private get isEnabled() {
		return this.instanceSettings.instanceType === 'main' && this.instanceSettings.isLeader;
	}

	@OnLeaderTakeover()
	startCleanup() {
		if (!this.isEnabled || this.isShuttingDown) return;

		this.scheduleCleanup();

		this.logger.debug('Started chat hub memory cleanup timer');
	}

	@OnLeaderStepdown()
	stopCleanup() {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = undefined;
			this.logger.debug('Stopped chat hub memory cleanup timer');
		}
	}

	private scheduleCleanup() {
		this.cleanupInterval = setInterval(async () => {
			await this.runCleanup();
		}, CLEANUP_INTERVAL_MS);

		this.logger.debug(
			`Chat hub memory cleanup every ${CLEANUP_INTERVAL_MS * Time.milliseconds.toMinutes} minutes`,
		);
	}

	async runCleanup(): Promise<void> {
		try {
			this.logger.debug('Running chat hub memory cleanup');

			// Delete expired memory entries
			const deletedMemoryCount = await this.memoryRepository.deleteExpiredEntries();
			if (deletedMemoryCount > 0) {
				this.logger.debug('Deleted expired memory entries', { count: deletedMemoryCount });
			}

			// Delete orphaned chat hub sessions (with no messages and no memory entries)
			const deletedSessionCount = await this.sessionRepository.deleteOrphanedSessions();
			if (deletedSessionCount > 0) {
				this.logger.debug('Deleted orphaned chat hub sessions', { count: deletedSessionCount });
			}
		} catch (error) {
			this.logger.error('Failed to run chat hub memory cleanup', { error: ensureError(error) });
		} finally {
			this.logger.debug('Chat hub memory cleanup completed');
		}
	}

	@OnShutdown()
	shutdown(): void {
		this.isShuttingDown = true;
		this.stopCleanup();
	}
}
