import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { toErrorPayload } from '../domain/errors.js';
import { runTurn } from '../graph/index.js';
import { clearSession } from '../graph/session.js';
import { logger } from '../observability/logger.js';
import { initTracing } from '../observability/tracing.js';
import { getStore } from '../repositories/index.js';
import { ensureSeedData } from '../db/seed.js';
import {
  confirmCodeFor,
  confirmSuggestion,
  dismissSuggestion,
  listPendingSuggestions,
  listUserExecutions,
} from '../services/betting.js';

/**
 * Telegram front-end.
 *
 * It contains no betting logic: `/confirm` calls the same `confirmSuggestion`
 * service the web Confirm button calls, and everything conversational goes
 * through `runTurn` — the same graph entry point the web chat uses. The only
 * channel-specific code here is Telegram plumbing and message formatting.
 */

async function resolveUserId(telegramId: string, displayName: string): Promise<string> {
  const store = getStore();
  const existing = await store.getUserByTelegramId(telegramId);
  if (existing) return existing.id;

  const userId = `usr_tg_${telegramId}`;
  await store.upsertUser({
    id: userId,
    displayName,
    walletAddress: null,
    telegramId,
    limitsOverride: null,
  });
  return userId;
}

export function buildBot(token: string): Bot {
  const bot = new Bot(token);

  bot.command('start', async (telegramCtx) => {
    await telegramCtx.reply(
      [
        'Social betting assistant.',
        '',
        'Ask me about a match, a price, or what the chatter says.',
        'Nothing is ever bet without you confirming it first.',
        '',
        '/bets — your bets and pending confirmations',
        '/confirm CODE — confirm a quoted bet',
        '/cancel CODE — dismiss a quoted bet',
        '/reset — clear the conversation',
      ].join('\n'),
    );
  });

  bot.command('reset', async (telegramCtx) => {
    const userId = await resolveUserId(String(telegramCtx.from?.id), telegramCtx.from?.first_name ?? 'Telegram user');
    clearSession(`sess_${userId}_telegram`);
    await telegramCtx.reply('Conversation cleared.');
  });

  bot.command('bets', async (telegramCtx) => {
    const userId = await resolveUserId(String(telegramCtx.from?.id), telegramCtx.from?.first_name ?? 'Telegram user');
    const [executions, pending] = await Promise.all([
      listUserExecutions(userId, 5),
      listPendingSuggestions(userId, 5),
    ]);

    const lines: string[] = [];
    if (pending.length) {
      lines.push('Awaiting your confirmation:');
      for (const s of pending) {
        lines.push(
          `• ${s.marketId} / ${s.selectionId} — ${s.suggestedStake} @ ${s.odds}  →  /confirm ${confirmCodeFor(s.id)}`,
        );
      }
      lines.push('');
    }
    if (executions.length) {
      lines.push('Recent bets:');
      for (const e of executions) {
        // Status comes straight from the stored tx status — never inferred.
        const status = e.txStatus === 'confirmed' ? `placed (${e.txHash?.slice(0, 12)}…)` : e.txStatus;
        lines.push(`• ${e.marketId} / ${e.selectionId} — ${e.stake} @ ${e.odds} — ${status}`);
      }
    }
    await telegramCtx.reply(lines.length ? lines.join('\n') : 'Nothing yet. Ask me about a match to get started.');
  });

  bot.command('confirm', async (telegramCtx) => {
    const code = telegramCtx.match?.toString().trim();
    if (!code) {
      await telegramCtx.reply('Usage: /confirm CODE — the 6-character code from the quote.');
      return;
    }
    const userId = await resolveUserId(String(telegramCtx.from?.id), telegramCtx.from?.first_name ?? 'Telegram user');
    try {
      const { suggestion } = await confirmSuggestion({ userId, suggestionOrCode: code, channel: 'telegram' });
      await telegramCtx.reply(
        [
          `Confirmed: ${suggestion.suggestedStake} @ ${suggestion.odds} on ${suggestion.selectionId} (${suggestion.marketId}).`,
          'Say "place it" and I will submit it.',
        ].join('\n'),
      );
    } catch (err) {
      const { message } = toErrorPayload(err);
      await telegramCtx.reply(`Could not confirm that: ${message}`);
    }
  });

  bot.command('cancel', async (telegramCtx) => {
    const code = telegramCtx.match?.toString().trim();
    if (!code) {
      await telegramCtx.reply('Usage: /cancel CODE');
      return;
    }
    const userId = await resolveUserId(String(telegramCtx.from?.id), telegramCtx.from?.first_name ?? 'Telegram user');
    try {
      await dismissSuggestion(userId, code);
      await telegramCtx.reply('Dismissed.');
    } catch (err) {
      await telegramCtx.reply(`Could not dismiss that: ${toErrorPayload(err).message}`);
    }
  });

  bot.on('message:text', async (telegramCtx) => {
    const text = telegramCtx.message.text;
    if (text.startsWith('/')) return;

    const userId = await resolveUserId(String(telegramCtx.from.id), telegramCtx.from.first_name ?? 'Telegram user');
    await telegramCtx.replyWithChatAction('typing');

    try {
      const result = await runTurn({
        userId,
        channel: 'telegram',
        message: text,
        sessionId: `sess_${userId}_telegram`,
      });
      await telegramCtx.reply(result.reply);
    } catch (err) {
      logger.error({ component: 'telegram', err }, 'Turn failed');
      await telegramCtx.reply('Something went wrong handling that. Nothing was bet.');
    }
  });

  bot.catch((err) => {
    logger.error({ component: 'telegram', err: err.message }, 'Bot error');
  });

  return bot;
}

async function main(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.fatal({ component: 'telegram' }, 'TELEGRAM_BOT_TOKEN is not configured');
    process.exit(1);
  }
  initTracing();
  await ensureSeedData();

  const bot = buildBot(env.TELEGRAM_BOT_TOKEN);
  logger.info({ component: 'telegram' }, 'Starting Telegram bot (long polling)');
  await bot.start();
}

const invokedDirectly = process.argv[1]?.includes('telegram');
if (invokedDirectly) {
  main().catch((err) => {
    logger.fatal({ err }, 'Telegram bot failed to start');
    process.exit(1);
  });
}
