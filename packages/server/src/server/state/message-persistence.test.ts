/**
 * MessagePersistence Authorization Tests
 *
 * Unit tests for agent-private message authorization boundaries.
 * Verifies that only conversation owners can create/update/delete messages
 * in their private conversations.
 */

import { describe, expect, test, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { vi } from "vitest";
import { MessagePersistence } from "./message-persistence.js";
import type { PaseoState } from "./paseo-state.js";

function createMockLogger(): Logger {
  const noop = () => {};
  return {
    child: function() { return this; },
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  } as any;
}

describe("MessagePersistence Authorization", () => {
  let persistence: MessagePersistence;
  let mockPaseoState: Partial<PaseoState>;

  beforeEach(() => {
    mockPaseoState = {
      conversations: {
        getById: vi.fn(),
      },
      messages: {
        create: vi.fn(),
        getById: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    } as any;

    persistence = new MessagePersistence({
      paseoState: mockPaseoState as PaseoState,
      logger: createMockLogger(),
    });
  });

  describe("authorizedCreate", () => {
    test("allows conversation owner to create message", async () => {
      const conversationId = randomUUID();
      const agentId = randomUUID();

      const mockConversation = {
        id: conversationId,
        agentId, // Conversation owned by this agent
        projectId: randomUUID(),
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      const mockMessage = {
        id: randomUUID(),
        conversationId,
        role: "user" as const,
        content: "Test message",
        createdAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.conversations?.getById as any).mockResolvedValue(mockConversation);
      (mockPaseoState.messages?.create as any).mockResolvedValue(mockMessage);

      const result = await persistence.authorizedCreate(conversationId, agentId, {
        role: "user",
        content: "Test message",
      });

      expect(result).toEqual(mockMessage);
      expect(mockPaseoState.messages?.create).toHaveBeenCalledWith({
        conversationId,
        role: "user",
        content: "Test message",
      });
    });

    test("rejects when agent does not own conversation", async () => {
      const conversationId = randomUUID();
      const requestingAgentId = randomUUID();
      const conversationOwnerId = randomUUID();

      const mockConversation = {
        id: conversationId,
        agentId: conversationOwnerId, // Different agent owns this conversation
        projectId: randomUUID(),
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.conversations?.getById as any).mockResolvedValue(mockConversation);

      await expect(
        persistence.authorizedCreate(conversationId, requestingAgentId, {
          role: "user",
          content: "Unauthorized message",
        }),
      ).rejects.toThrow(/cannot create message in conversation owned by/);

      // Should not call message.create
      expect(mockPaseoState.messages?.create).not.toHaveBeenCalled();
    });

    test("rejects when conversation does not exist", async () => {
      const conversationId = randomUUID();
      const agentId = randomUUID();

      (mockPaseoState.conversations?.getById as any).mockResolvedValue(null);

      await expect(
        persistence.authorizedCreate(conversationId, agentId, {
          role: "user",
          content: "Message",
        }),
      ).rejects.toThrow(/Conversation .* not found/);
    });
  });

  describe("authorizedUpdate", () => {
    test("allows conversation owner to update message", async () => {
      const messageId = randomUUID();
      const conversationId = randomUUID();
      const agentId = randomUUID();

      const mockMessage = {
        id: messageId,
        conversationId,
        role: "user" as const,
        content: "Original content",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const mockConversation = {
        id: conversationId,
        agentId, // Agent owns this conversation
        projectId: randomUUID(),
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      const updatedMessage = { ...mockMessage, content: "Updated content" };

      (mockPaseoState.messages?.getById as any).mockResolvedValue(mockMessage);
      (mockPaseoState.conversations?.getById as any).mockResolvedValue(mockConversation);
      (mockPaseoState.messages?.update as any).mockResolvedValue(updatedMessage);

      const result = await persistence.authorizedUpdate(messageId, agentId, {
        content: "Updated content",
      });

      expect(result).toEqual(updatedMessage);
    });

    test("rejects when agent does not own conversation", async () => {
      const messageId = randomUUID();
      const conversationId = randomUUID();
      const requestingAgentId = randomUUID();
      const conversationOwnerId = randomUUID();

      const mockMessage = {
        id: messageId,
        conversationId,
        role: "user" as const,
        content: "Content",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const mockConversation = {
        id: conversationId,
        agentId: conversationOwnerId, // Different agent owns this
        projectId: randomUUID(),
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.messages?.getById as any).mockResolvedValue(mockMessage);
      (mockPaseoState.conversations?.getById as any).mockResolvedValue(mockConversation);

      await expect(
        persistence.authorizedUpdate(messageId, requestingAgentId, {
          content: "Updated",
        }),
      ).rejects.toThrow(/cannot update message in conversation owned by/);

      // Should not call message.update
      expect(mockPaseoState.messages?.update).not.toHaveBeenCalled();
    });

    test("rejects when message does not exist", async () => {
      const messageId = randomUUID();
      const agentId = randomUUID();

      (mockPaseoState.messages?.getById as any).mockResolvedValue(null);

      await expect(
        persistence.authorizedUpdate(messageId, agentId, { content: "Updated" }),
      ).rejects.toThrow(/Message .* not found/);
    });
  });

  describe("authorizedDelete", () => {
    test("allows conversation owner to delete message", async () => {
      const messageId = randomUUID();
      const conversationId = randomUUID();
      const agentId = randomUUID();

      const mockMessage = {
        id: messageId,
        conversationId,
        role: "user" as const,
        content: "Content",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const mockConversation = {
        id: conversationId,
        agentId, // Agent owns this conversation
        projectId: randomUUID(),
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.messages?.getById as any).mockResolvedValue(mockMessage);
      (mockPaseoState.conversations?.getById as any).mockResolvedValue(mockConversation);
      (mockPaseoState.messages?.delete as any).mockResolvedValue(undefined);

      await persistence.authorizedDelete(messageId, agentId);

      expect(mockPaseoState.messages?.delete).toHaveBeenCalledWith(messageId);
    });

    test("rejects when agent does not own conversation", async () => {
      const messageId = randomUUID();
      const conversationId = randomUUID();
      const requestingAgentId = randomUUID();
      const conversationOwnerId = randomUUID();

      const mockMessage = {
        id: messageId,
        conversationId,
        role: "user" as const,
        content: "Content",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const mockConversation = {
        id: conversationId,
        agentId: conversationOwnerId, // Different agent owns this
        projectId: randomUUID(),
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      (mockPaseoState.messages?.getById as any).mockResolvedValue(mockMessage);
      (mockPaseoState.conversations?.getById as any).mockResolvedValue(mockConversation);

      await expect(
        persistence.authorizedDelete(messageId, requestingAgentId),
      ).rejects.toThrow(/cannot delete message in conversation owned by/);

      // Should not call message.delete
      expect(mockPaseoState.messages?.delete).not.toHaveBeenCalled();
    });

    test("rejects when message does not exist", async () => {
      const messageId = randomUUID();
      const agentId = randomUUID();

      (mockPaseoState.messages?.getById as any).mockResolvedValue(null);

      await expect(
        persistence.authorizedDelete(messageId, agentId),
      ).rejects.toThrow(/Message .* not found/);
    });
  });
});
