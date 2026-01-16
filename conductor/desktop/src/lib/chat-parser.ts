import type { ChatMessage } from "../types";

/**
 * Parse chat.md format back into ChatMessage objects
 * Format: ## Role (timestamp)\n\ncontent\n\n---
 */
export function parseChatMd(content: string): ChatMessage[] {
  if (!content.trim()) return [];

  const messages: ChatMessage[] = [];
  // Split by --- separator
  const blocks = content.split(/\n---\n/).filter(b => b.trim());

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Parse header: ## Role (timestamp)
    const headerMatch = trimmed.match(/^##\s+(\w+)\s*\(([^)]+)\)\s*\n/);
    if (!headerMatch) continue;

    const [, role, timestamp] = headerMatch;
    const msgContent = trimmed.slice(headerMatch[0].length).trim();

    if (!msgContent) continue;

    // Map role to ChatMessage role
    const normalizedRole = role.toLowerCase();
    let chatRole: "user" | "assistant" | "system" = "system";
    if (normalizedRole === "user") chatRole = "user";
    else if (normalizedRole === "assistant") chatRole = "assistant";

    messages.push({
      id: `restored-${timestamp}-${messages.length}`,
      role: chatRole,
      content: msgContent,
      meta: normalizedRole === "user" ? "you" : normalizedRole,
    });
  }

  return messages;
}
