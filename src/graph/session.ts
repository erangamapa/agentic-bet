import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * Short-term conversational memory, per session.
 *
 * Kept in process and deliberately shallow. Long-lived state that matters —
 * suggestions, confirmations, executions — lives in Postgres, not in the message
 * history, so a restart can never lose or resurrect a betting decision. The
 * history exists only so the persona can follow a conversation.
 */
const MAX_TURNS = 12;

interface Session {
  id: string;
  messages: BaseMessage[];
  updatedAt: number;
}

const sessions = new Map<string, Session>();

/** Sessions idle for longer than this are dropped on the next access. */
const SESSION_TTL_MS = 60 * 60 * 1000;

export function getSession(sessionId: string): Session {
  pruneExpired();
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: Session = { id: sessionId, messages: [], updatedAt: Date.now() };
  sessions.set(sessionId, created);
  return created;
}

export function recordTurn(sessionId: string, userMessage: string, reply: string): void {
  const session = getSession(sessionId);
  session.messages.push(new HumanMessage(userMessage), new AIMessage(reply));
  // Trim from the front so the window holds the most recent exchanges.
  const maxMessages = MAX_TURNS * 2;
  if (session.messages.length > maxMessages) {
    session.messages = session.messages.slice(session.messages.length - maxMessages);
  }
  session.updatedAt = Date.now();
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function sessionCount(): number {
  return sessions.size;
}

function pruneExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.updatedAt < cutoff) sessions.delete(id);
  }
}
