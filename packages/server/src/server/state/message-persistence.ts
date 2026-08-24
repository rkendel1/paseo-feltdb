/**
 * MessagePersistence - Agent-Private Conversation Security
 *
 * Phase 2 Enforcement: Authorization checks for message creation/mutation.
 *
 * CRITICAL SECURITY BOUNDARY:
 * Messages belong to conversations, which belong to individual agents.
 * Only the owning agent can create/modify messages in that conversation.
 *
 * This prevents Agent A from writing messages to Agent B's private conversation.
 * The conversation's actual owner (conversation.agentId) is the authority,
 * not caller-supplied parameters.
 *
 * Design principles:
 * - Conversation ownership is immutable (established at conversation creation)
 * - Message creation must validate conversation.agentId against requesting agent
 * - Authorization at domain layer (PaseoState), not in streaming/message layer
 * - Separate from context policy (authorization is different from relevance)
 */

import type { Logger } from "pino";
import type { PaseoState } from "./paseo-state.js";
import type { Message } from "./feltdb/schema.js";
import { createAuthorityGuard } from "./handoff-authority-guard.js";

export interface MessagePersistenceOptions {
  paseoState: PaseoState;
  logger: Logger;
}

/**
 * MessagePersistence manages agent-private message storage with authorization.
 */
export class MessagePersistence {
  private readonly paseoState: PaseoState;
  private readonly logger: Logger;
  private readonly authorityGuard: ReturnType<typeof createAuthorityGuard>;

  constructor(options: MessagePersistenceOptions) {
    this.paseoState = options.paseoState;
    this.logger = options.logger.child({ module: "message-persistence" });
    this.authorityGuard = createAuthorityGuard(options.paseoState, this.logger);
  }

  /**
   * Create a conversation with authorization check.
   *
   * Authorization: Agent must be in the target workspace/project.
   * This prevents agents from creating conversations outside their scope.
   *
   * @throws Error if agent is not authorized to create conversation
   */
  async authorizedCreateConversation(
    agentId: string,
    workspaceId: string,
    projectId: string,
  ): Promise<any> {
    // 1. Fetch agent to validate workspace membership
    const agent = await this.paseoState.repos.agents.getById(agentId);
    if (!agent) {
      this.logger.warn({ agentId }, "Cannot create conversation: Agent not found");
      throw new Error(`Agent ${agentId} not found`);
    }

    // 2. Fetch workspace to verify authority
    const workspace = await this.paseoState.repos.workspaces.getById(agent.workspaceId);
    if (!workspace) {
      this.logger.warn({ agentId, workspaceId: agent.workspaceId }, "Cannot create conversation: Workspace not found");
      throw new Error(`Workspace ${agent.workspaceId} not found`);
    }

    // 3. Verify workspace/project matches agent's scope
    if (workspace.id !== workspaceId || workspace.projectId !== projectId) {
      this.logger.warn(
        {
          agentId,
          requestedWorkspaceId: workspaceId,
          requestedProjectId: projectId,
          agentWorkspaceId: workspace.id,
          agentProjectId: workspace.projectId,
        },
        "Cannot create conversation: Requested workspace/project does not match agent scope",
      );
      throw new Error(
        `Agent ${agentId} cannot create conversation in workspace ${workspaceId}/project ${projectId}`,
      );
    }

    // 4. HANDOFF-AWARE AUTHORITY CHECK via AuthorityGuard
    try {
      await this.authorityGuard.authorize({
        agentId,
        operation: "create",
        entityType: "message",
        entityId: `conversation-${Date.now()}`,
        workspaceId,
        projectId,
      });
    } catch (err) {
      this.logger.warn(
        {
          agentId,
          workspaceId,
          projectId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Conversation creation denied by AuthorityGuard",
      );
      throw err;
    }

    // 5. Create conversation
    const conversation = await this.paseoState.conversations.create({
      projectId,
      workspaceId,
      agentId,
    });

    this.logger.debug(
      { conversationId: conversation.id, agentId, workspaceId, projectId },
      "Conversation created (authorized)",
    );

    return conversation;
  }

  /**
   * Create a message with authorization check.
   *
   * CRITICAL: The conversation's actual owner (conversation.agentId) is the authority.
   * We do NOT trust caller-supplied agentId. We derive it from the conversation.
   *
   * Authorization:
   * - Requesting agent must own the conversation
   * - conversation.agentId === requestingAgentId
   *
   * This prevents:
   * - Agent A from writing messages to Conversation B (owned by Agent B)
   * - Cross-agent message injection
   * - Contamination of private conversation history
   *
   * @throws Error if agent is not authorized to create message in this conversation
   */
  async authorizedCreate(
    conversationId: string,
    requestingAgentId: string,
    data: Omit<Message, "id" | "createdAt" | "conversationId">,
  ): Promise<Message> {
    // 1. Fetch the conversation to establish true ownership
    const conversation = await this.paseoState.conversations.getById(conversationId);
    if (!conversation) {
      this.logger.warn(
        { conversationId, requestingAgentId },
        "Cannot create message: Conversation not found",
      );
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // 2. Authorization check: The conversation's ACTUAL owner must match requesting agent
    // This is NOT based on caller input - it's based on the durable conversation record
    if (conversation.agentId !== requestingAgentId) {
      this.logger.warn(
        {
          conversationId,
          conversationOwner: conversation.agentId,
          requestingAgent: requestingAgentId,
        },
        "Cannot create message: Agent not authorized (different agent owns this conversation)",
      );
      throw new Error(
        `Agent ${requestingAgentId} cannot create message in conversation owned by Agent ${conversation.agentId}`,
      );
    }

    // 3. HANDOFF-AWARE AUTHORITY CHECK via AuthorityGuard
    // Even though conversation owner check passed, verify agent has handoff authority if delegated
    try {
      await this.authorityGuard.authorize({
        agentId: requestingAgentId,
        operation: "create",
        entityType: "message",
        entityId: `message-${conversationId}`,
        workspaceId: conversation.workspaceId,
        projectId: conversation.projectId,
        context: { conversationId },
      });
    } catch (err) {
      this.logger.warn(
        {
          agentId: requestingAgentId,
          conversationId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Message creation denied by AuthorityGuard (handoff scope mismatch)",
      );
      throw err;
    }

    // 4. Perform authorized create
    // Filter out null values to match schema expectations
    const createData: any = { conversationId };
    for (const [key, value] of Object.entries(data)) {
      if (value !== null) {
        createData[key] = value;
      }
    }
    const message = await this.paseoState.messages.create(createData);

    this.logger.debug(
      { messageId: message.id, conversationId, agentId: requestingAgentId },
      "Message created (authorized)",
    );

    return message;
  }

  /**
   * Update a message with authorization check.
   *
   * Same authorization as create: only the conversation owner can modify messages.
   *
   * @throws Error if agent is not authorized to update message
   */
  async authorizedUpdate(
    messageId: string,
    requestingAgentId: string,
    data: Partial<Message>,
  ): Promise<Message> {
    // 1. Fetch the message
    const message = await this.paseoState.messages.getById(messageId);
    if (!message) {
      this.logger.warn(
        { messageId, requestingAgentId },
        "Cannot update message: Message not found",
      );
      throw new Error(`Message ${messageId} not found`);
    }

    // 2. Fetch the conversation to verify ownership
    const conversation = await this.paseoState.conversations.getById(message.conversationId);
    if (!conversation) {
      this.logger.warn(
        { messageId, conversationId: message.conversationId, requestingAgentId },
        "Cannot update message: Conversation not found",
      );
      throw new Error(`Conversation ${message.conversationId} not found`);
    }

    // 3. Authorization check: Must own the conversation
    if (conversation.agentId !== requestingAgentId) {
      this.logger.warn(
        {
          messageId,
          conversationId: message.conversationId,
          conversationOwner: conversation.agentId,
          requestingAgent: requestingAgentId,
        },
        "Cannot update message: Agent not authorized (does not own conversation)",
      );
      throw new Error(
        `Agent ${requestingAgentId} cannot update message in conversation owned by Agent ${conversation.agentId}`,
      );
    }

    // 4. Perform authorized update
    const updated = await this.paseoState.messages.update(messageId, data);

    this.logger.debug(
      { messageId, conversationId: message.conversationId, agentId: requestingAgentId },
      "Message updated (authorized)",
    );

    return updated;
  }

  /**
   * Delete a message with authorization check.
   *
   * Same authorization as create/update: only the conversation owner can delete.
   *
   * @throws Error if agent is not authorized to delete message
   */
  async authorizedDelete(messageId: string, requestingAgentId: string): Promise<void> {
    // 1. Fetch the message
    const message = await this.paseoState.messages.getById(messageId);
    if (!message) {
      this.logger.warn(
        { messageId, requestingAgentId },
        "Cannot delete message: Message not found",
      );
      throw new Error(`Message ${messageId} not found`);
    }

    // 2. Fetch the conversation to verify ownership
    const conversation = await this.paseoState.conversations.getById(message.conversationId);
    if (!conversation) {
      this.logger.warn(
        { messageId, conversationId: message.conversationId, requestingAgentId },
        "Cannot delete message: Conversation not found",
      );
      throw new Error(`Conversation ${message.conversationId} not found`);
    }

    // 3. Authorization check: Must own the conversation
    if (conversation.agentId !== requestingAgentId) {
      this.logger.warn(
        {
          messageId,
          conversationId: message.conversationId,
          conversationOwner: conversation.agentId,
          requestingAgent: requestingAgentId,
        },
        "Cannot delete message: Agent not authorized (does not own conversation)",
      );
      throw new Error(
        `Agent ${requestingAgentId} cannot delete message in conversation owned by Agent ${conversation.agentId}`,
      );
    }

    // 4. Perform authorized delete
    await this.paseoState.messages.delete(messageId);

    this.logger.debug(
      { messageId, conversationId: message.conversationId, agentId: requestingAgentId },
      "Message deleted (authorized)",
    );
  }
}

export function createMessagePersistence(options: MessagePersistenceOptions): MessagePersistence {
  return new MessagePersistence(options);
}
