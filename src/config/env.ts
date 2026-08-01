import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Minimal .env loader — avoids a dotenv dependency and keeps precedence explicit:
 * a value already present in process.env always wins over the file.
 */
function loadDotEnv(file = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const num = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().finite());

/** Placeholder values from .env.example must never be treated as configured. */
const placeholder = (v: string | undefined): boolean =>
  v === undefined || v === '' || (v.startsWith('<') && v.endsWith('>'));

const clean = z.string().optional().transform((v) => (placeholder(v) ? undefined : v));

export const executionModes = ['stub', 'simulate', 'onchain'] as const;
export type ExecutionMode = (typeof executionModes)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: clean,

  ANTHROPIC_API_KEY: clean,
  OPENAI_API_KEY: clean,
  PRIMARY_MODEL: z.string().default('anthropic:claude-sonnet-5'),
  FALLBACK_MODEL: clean,
  PERSONA_MODEL: clean,

  LANGSMITH_TRACING: bool.optional().default(false),
  LANGSMITH_API_KEY: clean,
  LANGSMITH_PROJECT: z.string().default('agentic-bet'),
  LANGSMITH_ENDPOINT: z.string().default('https://api.smith.langchain.com'),

  EXECUTION_MODE: z.enum(executionModes).default('stub'),
  CHAIN_ID: num(84532),
  CHAIN_RPC_URL: z.string().default('https://sepolia.base.org'),
  BET_CONTRACT_ADDRESS: z.string().default('0x0000000000000000000000000000000000000000'),
  OPERATOR_PRIVATE_KEY: clean,
  TX_CONFIRMATIONS: num(1),
  TX_TIMEOUT_MS: num(120_000),

  MIN_STAKE: num(1),
  MAX_STAKE_PER_BET: num(250),
  MAX_STAKE_PER_DAY: num(1000),
  MAX_OPEN_BETS: num(10),
  MAX_ODDS: num(25),
  CONFIRMATION_TTL_SECONDS: num(900),

  TELEGRAM_BOT_TOKEN: clean,
  /** Shared secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token. */
  TELEGRAM_WEBHOOK_SECRET: clean,
  WEB_API_KEY: clean,

  // --- deployment shape ----------------------------------------------------
  /**
   * `inline` runs the reconciler on an in-process timer (local dev).
   * `external` disables it, for platforms that throttle CPU between requests —
   * on Cloud Run a background timer does not reliably fire, so the sweep is
   * driven by a Cloud Run Job on a Cloud Scheduler trigger instead.
   */
  RECONCILER_MODE: z.enum(['inline', 'external']).optional(),
  /** Applying schema on every cold start is wasteful; deploy pipelines run it once. */
  RUN_MIGRATIONS_ON_BOOT: bool.optional(),
  /** Demo markets and social fixtures. Never wanted in production. */
  SEED_DEMO_DATA: bool.optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env: Env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Deployment-shape defaults. Local development gets the convenient behaviour
 * (timer-driven reconciler, auto-migrate, demo fixtures); production gets none
 * of it unless explicitly asked for.
 */
export const reconcilerMode: 'inline' | 'external' =
  env.RECONCILER_MODE ?? (isProduction ? 'external' : 'inline');

export const runMigrationsOnBoot: boolean = env.RUN_MIGRATIONS_ON_BOOT ?? !isProduction;

export const seedDemoData: boolean = env.SEED_DEMO_DATA ?? !isProduction;

/** True when a real Neon/Postgres connection string is configured. */
export const hasDatabase = Boolean(env.DATABASE_URL);

/** True when at least one LLM provider key is configured. */
export const hasLlm = Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);

/** True when LangSmith tracing is both enabled and credentialed. */
export const hasTracing = env.LANGSMITH_TRACING && Boolean(env.LANGSMITH_API_KEY);
