import { createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { env, type ExecutionMode } from '../config/env.js';
import { ConfigurationError, ExecutionNotConfirmedError } from '../domain/errors.js';
import { logger } from '../observability/logger.js';
import { socialBetBookAbi } from './abi.js';

/** Stake token decimals. USDC-style 6dp is the common case for betting settlement. */
const STAKE_DECIMALS = 6;

export interface ExecutionRequest {
  executionId: string;
  userId: string;
  /** On-chain address the bet is booked against. */
  bettor: Address;
  marketId: string;
  selectionId: string;
  stake: number;
  odds: number;
  /** Hash of the exact parameters the user confirmed; carried on-chain. */
  intentHash: string;
}

export interface BroadcastResult {
  txHash: string;
  /** Wall-clock ms spent in the broadcast call, for latency tracking. */
  elapsedMs: number;
}

export interface VerificationResult {
  status: 'confirmed' | 'failed';
  txHash: string;
  blockNumber: number | null;
  /** Intent hash as read back from the chain — compared against the request. */
  onChainIntentHash: string | null;
  betId: string | null;
  reason: string | null;
}

/**
 * Two-phase execution, deliberately. `broadcast` returning is NOT success —
 * only `verify` returning `status: 'confirmed'` is. Every caller must go
 * through both, and the Bet Placement Agent may only tell the user "placed"
 * after the second one. This split is the structural fix for the production
 * incident called out in Section 2 of the spec.
 */
export interface BetExecutor {
  readonly mode: ExecutionMode;
  broadcast(request: ExecutionRequest): Promise<BroadcastResult>;
  verify(request: ExecutionRequest, txHash: string): Promise<VerificationResult>;
}

// ---------------------------------------------------------------------------
// Stub executor — milestones 1-3. Logs instead of executing.
// ---------------------------------------------------------------------------

export class StubExecutor implements BetExecutor {
  readonly mode = 'stub' as const;
  private readonly broadcasts = new Map<string, ExecutionRequest>();

  async broadcast(request: ExecutionRequest): Promise<BroadcastResult> {
    const started = Date.now();
    const txHash = `0x${createHash('sha256').update(`${request.executionId}:${request.intentHash}`).digest('hex')}`;
    this.broadcasts.set(txHash, request);
    logger.info(
      {
        component: 'executor',
        mode: this.mode,
        executionId: request.executionId,
        marketId: request.marketId,
        selectionId: request.selectionId,
        stake: request.stake,
        odds: request.odds,
        txHash,
      },
      'STUB: would place bet on-chain',
    );
    // Simulated network latency so the pending -> confirmed transition is real
    // rather than instantaneous, and races are observable in dev.
    await sleep(50);
    return { txHash, elapsedMs: Date.now() - started };
  }

  async verify(request: ExecutionRequest, txHash: string): Promise<VerificationResult> {
    await sleep(50);
    const known = this.broadcasts.get(txHash);
    if (!known) {
      // Verification must fail for a hash the executor never broadcast — this is
      // what stops a hallucinated tx hash from being reported as a real bet.
      return {
        status: 'failed',
        txHash,
        blockNumber: null,
        onChainIntentHash: null,
        betId: null,
        reason: 'Transaction hash was never broadcast by this executor',
      };
    }
    if (known.intentHash !== request.intentHash) {
      return {
        status: 'failed',
        txHash,
        blockNumber: null,
        onChainIntentHash: known.intentHash,
        betId: null,
        reason: 'Intent hash mismatch between broadcast and verification',
      };
    }
    return {
      status: 'confirmed',
      txHash,
      blockNumber: 0,
      onChainIntentHash: known.intentHash,
      betId: `0x${createHash('sha256').update(`bet:${txHash}`).digest('hex')}`,
      reason: null,
    };
  }
}

// ---------------------------------------------------------------------------
// EVM executor — simulate (eth_call only) and onchain (sign + broadcast + wait).
// ---------------------------------------------------------------------------

export class EvmExecutor implements BetExecutor {
  readonly mode: ExecutionMode;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | null;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private readonly contract: Address;

  constructor(mode: Exclude<ExecutionMode, 'stub'>) {
    this.mode = mode;

    if (!isAddress(env.BET_CONTRACT_ADDRESS)) {
      throw new ConfigurationError('BET_CONTRACT_ADDRESS is not a valid address', {
        value: env.BET_CONTRACT_ADDRESS,
      });
    }
    this.contract = env.BET_CONTRACT_ADDRESS as Address;

    const chain = defineChain({
      id: env.CHAIN_ID,
      name: `chain-${env.CHAIN_ID}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [env.CHAIN_RPC_URL] } },
    });

    this.publicClient = createPublicClient({ chain, transport: http(env.CHAIN_RPC_URL) }) as PublicClient;

    if (mode === 'onchain') {
      if (!env.OPERATOR_PRIVATE_KEY) {
        throw new ConfigurationError('EXECUTION_MODE=onchain requires OPERATOR_PRIVATE_KEY');
      }
      this.account = privateKeyToAccount(env.OPERATOR_PRIVATE_KEY as `0x${string}`);
      this.walletClient = createWalletClient({ account: this.account, chain, transport: http(env.CHAIN_RPC_URL) });
    } else {
      this.account = null;
      this.walletClient = null;
    }
  }

  private args(request: ExecutionRequest) {
    return [
      request.bettor,
      keccak256(stringToHex(request.marketId)),
      keccak256(stringToHex(request.selectionId)),
      parseUnits(request.stake.toFixed(STAKE_DECIMALS), STAKE_DECIMALS),
      BigInt(Math.round(request.odds * 10_000)),
      `0x${request.intentHash}` as Hash,
    ] as const;
  }

  async broadcast(request: ExecutionRequest): Promise<BroadcastResult> {
    const started = Date.now();
    const args = this.args(request);

    // Always simulate first: a revert caught here never costs gas and never
    // leaves an ambiguous "did it land?" state for the verification step.
    const { request: simulated } = await this.publicClient.simulateContract({
      address: this.contract,
      abi: socialBetBookAbi,
      functionName: 'placeBetOnBehalfOf',
      args,
      account: this.account ?? undefined,
    });

    if (this.mode === 'simulate') {
      const pseudoHash = keccak256(stringToHex(`${request.executionId}:${request.intentHash}`));
      logger.info(
        { component: 'executor', mode: this.mode, executionId: request.executionId, pseudoHash },
        'SIMULATE: contract call succeeded, not broadcasting',
      );
      return { txHash: pseudoHash, elapsedMs: Date.now() - started };
    }

    if (!this.walletClient || !this.account) throw new ConfigurationError('Wallet client unavailable');

    const txHash = await this.walletClient.writeContract({ ...simulated, account: this.account });
    logger.info(
      { component: 'executor', mode: this.mode, executionId: request.executionId, txHash },
      'Bet transaction broadcast',
    );
    return { txHash, elapsedMs: Date.now() - started };
  }

  async verify(request: ExecutionRequest, txHash: string): Promise<VerificationResult> {
    if (this.mode === 'simulate') {
      // Nothing was broadcast, so there is nothing to confirm. Reporting success
      // here would be exactly the bug this system must not have.
      return {
        status: 'failed',
        txHash,
        blockNumber: null,
        onChainIntentHash: null,
        betId: null,
        reason: 'EXECUTION_MODE=simulate never broadcasts a transaction, so no bet was placed',
      };
    }

    let receipt;
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash as Hash,
        confirmations: Math.max(1, env.TX_CONFIRMATIONS),
        timeout: env.TX_TIMEOUT_MS,
      });
    } catch (err) {
      throw new ExecutionNotConfirmedError('Timed out waiting for the transaction receipt', {
        txHash,
        executionId: request.executionId,
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    if (receipt.status !== 'success') {
      return {
        status: 'failed',
        txHash,
        blockNumber: Number(receipt.blockNumber),
        onChainIntentHash: null,
        betId: null,
        reason: `Transaction reverted (status=${receipt.status})`,
      };
    }

    // A successful receipt is necessary but not sufficient: the BetPlaced event
    // must exist and carry the intent hash we confirmed with the user.
    const expectedIntent = `0x${request.intentHash}`.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.contract.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: socialBetBookAbi, data: log.data, topics: log.topics });
        if (decoded.eventName !== 'BetPlaced') continue;
        const eventArgs = decoded.args as unknown as { intentHash: string; betId: string };
        if (eventArgs.intentHash.toLowerCase() !== expectedIntent) {
          return {
            status: 'failed',
            txHash,
            blockNumber: Number(receipt.blockNumber),
            onChainIntentHash: eventArgs.intentHash,
            betId: null,
            reason: 'On-chain intent hash does not match the confirmed bet parameters',
          };
        }
        return {
          status: 'confirmed',
          txHash,
          blockNumber: Number(receipt.blockNumber),
          onChainIntentHash: eventArgs.intentHash,
          betId: eventArgs.betId,
          reason: null,
        };
      } catch {
        continue; // not one of ours
      }
    }

    return {
      status: 'failed',
      txHash,
      blockNumber: Number(receipt.blockNumber),
      onChainIntentHash: null,
      betId: null,
      reason: 'Transaction succeeded but no matching BetPlaced event was emitted',
    };
  }
}

// ---------------------------------------------------------------------------

let cachedExecutor: BetExecutor | null = null;

export function getExecutor(): BetExecutor {
  if (cachedExecutor) return cachedExecutor;
  cachedExecutor = env.EXECUTION_MODE === 'stub' ? new StubExecutor() : new EvmExecutor(env.EXECUTION_MODE);
  logger.info({ component: 'executor', mode: cachedExecutor.mode }, 'Bet executor initialised');
  return cachedExecutor;
}

/** Test hook. */
export function setExecutor(executor: BetExecutor | null): void {
  cachedExecutor = executor;
}

/** Derives a deterministic placeholder address for users without a linked wallet. */
export function derivedWalletAddress(userId: string): Address {
  const hash = keccak256(stringToHex(`agentic-bet:wallet:${userId}`));
  return (`0x${hash.slice(-40)}`) as Address;
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { toHex };
