import { webhookCallback } from 'grammy';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { buildBot } from './index.js';

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

/**
 * Mounts the Telegram bot as a webhook on the API service.
 *
 * Long polling (`bot.start()`) is the right choice locally but wrong on a
 * scale-to-zero platform: it needs a process running permanently, which either
 * costs an always-on instance or gets killed mid-poll. As a webhook the bot
 * becomes request-driven — it scales to zero with everything else, and updates
 * arrive with lower latency than polling gives.
 *
 * Both shapes drive the identical agent graph; only the transport differs.
 */
export async function registerTelegramWebhook(app: FastifyInstance): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.info({ component: 'telegram' }, 'TELEGRAM_BOT_TOKEN not set — webhook not mounted');
    return;
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    // Without the shared secret anyone who learns the URL can post fake updates
    // as any user — and this bot places bets. Refuse rather than run open.
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set. ' +
        'Generate one with `openssl rand -hex 32` and pass the same value to setWebhook.',
    );
  }

  const bot = buildBot(env.TELEGRAM_BOT_TOKEN);
  // Telegram will not deliver updates until the bot's own identity is known.
  await bot.init();

  const handle = webhookCallback(bot, 'fastify', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
    // Telegram retries on non-2xx, so a slow agent turn must not look like an
    // error. Return early and let the turn finish in the background instead.
    timeoutMilliseconds: 55_000,
    onTimeout: 'return',
  });

  app.post(TELEGRAM_WEBHOOK_PATH, handle);

  logger.info(
    { component: 'telegram', path: TELEGRAM_WEBHOOK_PATH, username: bot.botInfo.username },
    'Telegram webhook mounted',
  );
}
