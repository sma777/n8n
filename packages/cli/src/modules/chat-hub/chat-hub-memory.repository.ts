import { Service } from '@n8n/di';
import { DataSource, EntityManager, In, LessThan, Repository } from '@n8n/typeorm';
import type { QueryDeepPartialEntity } from '@n8n/typeorm/query-builder/QueryPartialEntity';
import { StoredMessage, UnexpectedError } from 'n8n-workflow';

import { ChatHubMemory, type ChatHubMemoryRole } from './chat-hub-memory.entity';

export interface CreateMemoryEntryData {
	id: string;
	sessionId: string;
	turnId: string | null;
	role: ChatHubMemoryRole;
	content: StoredMessage;
	name: string;
	expiresAt?: Date | null;
}

@Service()
export class ChatHubMemoryRepository extends Repository<ChatHubMemory> {
	constructor(dataSource: DataSource) {
		super(ChatHubMemory, dataSource.manager);
	}

	async createMemoryEntry(entry: CreateMemoryEntryData, trx?: EntityManager) {
		const em = trx ?? this.manager;

		if (!entry.id) {
			throw new UnexpectedError('Memory entry ID is required');
		}

		if (!entry.sessionId) {
			throw new UnexpectedError('Session ID is required');
		}

		await em.insert(ChatHubMemory, entry as QueryDeepPartialEntity<ChatHubMemory>);
		return entry.id;
	}

	/**
	 * Get memory entries for a specific memory node,
	 * filtered by turn IDs (for branching support).
	 * Turn IDs are correlation IDs linking memory entries to AI messages.
	 */
	async getMemoryByTurnIds(
		sessionId: string,
		turnIds: string[],
		trx?: EntityManager,
	): Promise<ChatHubMemory[]> {
		const em = trx ?? this.manager;

		if (turnIds.length === 0) {
			return [];
		}

		return await em.find(ChatHubMemory, {
			where: {
				sessionId,
				turnId: In(turnIds),
			},
			order: { createdAt: 'ASC' },
		});
	}

	/**
	 * Get all memory entries for a session and memory node.
	 * Used when turnId is not available (e.g., manual executions).
	 */
	async getAllMemoryForNode(sessionId: string, trx?: EntityManager): Promise<ChatHubMemory[]> {
		const em = trx ?? this.manager;

		return await em.find(ChatHubMemory, {
			where: {
				sessionId,
			},
			order: { createdAt: 'ASC' },
		});
	}

	/**
	 * Delete all memory entries for a session.
	 */
	async deleteBySessionId(sessionId: string, trx?: EntityManager): Promise<void> {
		const em = trx ?? this.manager;
		await em.delete(ChatHubMemory, { sessionId });
	}

	/**
	 * Delete all expired memory entries (where expiresAt < NOW).
	 * @returns The number of deleted entries
	 */
	async deleteExpiredEntries(trx?: EntityManager): Promise<number> {
		const em = trx ?? this.manager;
		const result = await em.delete(ChatHubMemory, {
			expiresAt: LessThan(new Date()),
		});
		return result.affected ?? 0;
	}
}
