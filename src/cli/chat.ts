/**
 * Terminal chat client. Drives the same graph as the web and Telegram
 * front-ends, so it is the quickest way to exercise the whole system.
 *
 *   npm run chat                       # web persona
 *   npm run chat -- --channel telegram # telegram persona, same graph
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ensureSeedData } from '../db/seed.js';
import { runTurn } from '../graph/index.js';
import { initTracing } from '../observability/tracing.js';
import { getStore } from '../repositories/index.js';
import {
  confirmCodeFor,
  confirmSuggestion,
  listPendingSuggestions,
  listUserExecutions,
} from '../services/betting.js';
import { hasLlm } from '../config/env.js';

const args = process.argv.slice(2);
const channelArg = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : 'web';
const channel = channelArg === 'telegram' ? ('telegram' as const) : ('web' as const);
const userId = args.includes('--user') ? args[args.indexOf('--user') + 1]! : 'usr_demo';

async function main(): Promise<void> {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

  if (!hasLlm) {
    stdout.write(
      '\nNo LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env to chat.\n' +
        'The non-LLM paths still work: try `npm run verify:boundary`.\n\n',
    );
    process.exit(1);
  }

  initTracing();
  await ensureSeedData();
  await getStore().upsertUser({
    id: userId,
    displayName: userId,
    walletAddress: null,
    telegramId: null,
    limitsOverride: null,
  });

  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(
    [
      '',
      `agentic-bet CLI — ${channel} persona, user ${userId}`,
      'Type a message. Commands: /confirm CODE, /bets, /quit',
      '',
    ].join('\n'),
  );

  const sessionId = `sess_${userId}_${channel}_cli`;

  for (;;) {
    const line = (await rl.question('you › ')).trim();
    if (!line) continue;
    if (line === '/quit' || line === '/exit') break;

    if (line.startsWith('/confirm')) {
      const code = line.split(/\s+/)[1];
      if (!code) {
        stdout.write('usage: /confirm CODE\n');
        continue;
      }
      try {
        const { suggestion } = await confirmSuggestion({ userId, suggestionOrCode: code, channel });
        stdout.write(
          `confirmed: ${suggestion.suggestedStake} @ ${suggestion.odds} on ${suggestion.selectionId} — say "place it"\n`,
        );
      } catch (err) {
        stdout.write(`could not confirm: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      continue;
    }

    if (line === '/bets') {
      const [bets, pending] = await Promise.all([listUserExecutions(userId, 5), listPendingSuggestions(userId, 5)]);
      for (const s of pending) {
        stdout.write(
          `  pending  ${confirmCodeFor(s.id)}  ${s.marketId}/${s.selectionId}  ${s.suggestedStake} @ ${s.odds}  (${s.status})\n`,
        );
      }
      for (const b of bets) {
        stdout.write(
          `  bet      ${b.id}  ${b.marketId}/${b.selectionId}  ${b.stake} @ ${b.odds}  ${b.txStatus}  ${b.txHash?.slice(0, 12) ?? ''}\n`,
        );
      }
      if (!bets.length && !pending.length) stdout.write('  (nothing yet)\n');
      continue;
    }

    try {
      const result = await runTurn({ userId, channel, message: line, sessionId });
      stdout.write(`\nbot › ${result.reply}\n`);
      if (result.traceUrl) stdout.write(`      trace: ${result.traceUrl}\n`);
      stdout.write('\n');
    } catch (err) {
      stdout.write(`\n[error] ${err instanceof Error ? err.message : String(err)}\n\n`);
    }
  }

  rl.close();
  process.exit(0);
}

main().catch((err) => {
  stdout.write(`chat crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
