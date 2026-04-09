import { Contract, JsonRpcProvider, Wallet } from 'ethers';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

const CONDITIONAL_TOKENS_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
] as const;

export interface CreatePolymarketRedeemerInput {
  readonly privateKey: string;
  readonly rpcUrl: string;
  readonly conditionalTokensAddress: string;
  readonly collateralTokenAddress: string;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly minGasReserveWei?: bigint;
}

export interface RedeemInput {
  readonly conditionId: string;
  readonly indexSets: readonly bigint[];
  readonly parentCollectionId?: string;
  readonly requireResolved?: boolean;
}

export interface RedeemResult {
  readonly txHash: string;
  readonly conditionId: string;
  readonly indexSets: readonly bigint[];
  readonly claimedAtMs: number;
}

export interface RedeemBatchItem {
  readonly conditionId: string;
  readonly outcomeIndex: number;
}

export interface RedeemBatchResult {
  readonly conditionId: string;
  readonly outcomeIndex: number;
  readonly ok: boolean;
  readonly txHash?: string;
  readonly error?: string;
}

export class PolymarketRedeemer {
  private readonly provider: JsonRpcProvider;
  private readonly signer: Wallet;
  private readonly contract: Contract;
  private readonly collateralTokenAddress: string;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly minGasReserveWei: bigint;

  public constructor(input: CreatePolymarketRedeemerInput) {
    this.provider = new JsonRpcProvider(input.rpcUrl);
    this.signer = new Wallet(input.privateKey, this.provider);
    this.contract = new Contract(
      input.conditionalTokensAddress,
      CONDITIONAL_TOKENS_ABI,
      this.signer,
    );
    this.collateralTokenAddress = input.collateralTokenAddress;

    this.maxRetries = Math.max(0, Math.floor(input.maxRetries ?? 2));
    this.baseRetryDelayMs = Math.max(250, Math.floor(input.baseRetryDelayMs ?? 500));
    this.minGasReserveWei = input.minGasReserveWei ?? 1_000_000_000_000_000n;
  }

  public async getSignerAddress(): Promise<string> {
    return (await this.signer.getAddress()).toLowerCase();
  }

  public async hasEnoughGasReserve(): Promise<boolean> {
    const balanceWei = await this.provider.getBalance(await this.getSignerAddress());
    return balanceWei >= this.minGasReserveWei;
  }

  public async redeem(input: RedeemInput): Promise<RedeemResult> {
    const conditionId = normalizeConditionId(input.conditionId);
    if (!conditionId) {
      throw new Error(`Invalid conditionId: ${input.conditionId}`);
    }

    if (!Array.isArray(input.indexSets) || input.indexSets.length === 0) {
      throw new Error('indexSets must include at least one value');
    }

    const normalizedIndexSets = input.indexSets.map((indexSet) => {
      if (indexSet <= 0n) {
        throw new Error(`indexSet must be > 0: ${indexSet.toString()}`);
      }
      return indexSet;
    });

    if (input.requireResolved ?? true) {
      const denominator = await this.contract.payoutDenominator(conditionId) as bigint;
      if (denominator === 0n) {
        throw new Error('Market is not resolved yet (payoutDenominator == 0)');
      }
    }

    const parentCollectionId = input.parentCollectionId ?? ZERO_BYTES32;

    try {
      await this.contract.redeemPositions.staticCall(
        this.collateralTokenAddress,
        parentCollectionId,
        conditionId,
        normalizedIndexSets,
      );
    } catch (error) {
      throw mapKnownRedeemError(error);
    }

    const tx = await this.executeWithRetry(async (attempt) => {
      const gasOptions = await this.buildGasOptions(attempt);
      try {
        return this.contract.redeemPositions(
          this.collateralTokenAddress,
          parentCollectionId,
          conditionId,
          normalizedIndexSets,
          gasOptions,
        );
      } catch (error) {
        throw mapKnownRedeemError(error);
      }
    });

    const receipt = await tx.wait(1);
    const txHash = typeof receipt?.hash === 'string' ? receipt.hash : String(tx.hash ?? 'unknown');

    return {
      txHash,
      conditionId,
      indexSets: normalizedIndexSets,
      claimedAtMs: Date.now(),
    };
  }

  public async redeemSingleOutcome(
    conditionId: string,
    outcomeIndex: number,
    options?: { parentCollectionId?: string; requireResolved?: boolean },
  ): Promise<RedeemResult> {
    if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 30) {
      throw new Error(`Invalid outcomeIndex: ${outcomeIndex}`);
    }

    const indexSet = 1n << BigInt(outcomeIndex);
    return this.redeem({
      conditionId,
      indexSets: [indexSet],
      parentCollectionId: options?.parentCollectionId,
      requireResolved: options?.requireResolved,
    });
  }

  public async redeemBatch(items: readonly RedeemBatchItem[]): Promise<readonly RedeemBatchResult[]> {
    const output: RedeemBatchResult[] = [];

    for (const item of items) {
      try {
        const result = await this.redeemSingleOutcome(item.conditionId, item.outcomeIndex, {
          requireResolved: true,
        });
        output.push({
          conditionId: item.conditionId,
          outcomeIndex: item.outcomeIndex,
          ok: true,
          txHash: result.txHash,
        });
      } catch (error) {
        output.push({
          conditionId: item.conditionId,
          outcomeIndex: item.outcomeIndex,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return output;
  }

  private async executeWithRetry<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= this.maxRetries) {
          break;
        }
        await delay(this.baseRetryDelayMs * (attempt + 1));
      }
    }

    throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
  }

  private async buildGasOptions(attempt: number): Promise<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const feeData = await this.provider.getFeeData();

    const baseMaxFee = feeData.maxFeePerGas ?? 40_000_000_000n;
    const basePriorityFee = feeData.maxPriorityFeePerGas ?? 3_000_000_000n;
    const multiplier = BigInt(100 + attempt * 20);

    return {
      gasLimit: 350_000n,
      maxFeePerGas: (baseMaxFee * multiplier) / 100n,
      maxPriorityFeePerGas: (basePriorityFee * multiplier) / 100n,
    };
  }
}

export function normalizeConditionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}

function isRetryableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const normalized = text.toLowerCase();
  return (
    normalized.includes('timeout')
    || normalized.includes('econnreset')
    || normalized.includes('etimedout')
    || normalized.includes('replacement fee too low')
    || normalized.includes('nonce too low')
    || normalized.includes('429')
  );
}

function mapKnownRedeemError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const normalized = text.toLowerCase();

  if (normalized.includes('payoutdenominator') || normalized.includes('not resolved')) {
    return new Error('Market is not resolved yet; redemption is unavailable.');
  }

  if (
    normalized.includes('resulting payout is zero')
    || normalized.includes('no payout')
    || normalized.includes('insufficient balance')
  ) {
    return new Error('Nothing redeemable for this condition/indexSet (already redeemed or no winning shares).');
  }

  if (normalized.includes('execution reverted')) {
    return new Error(`Redeem reverted on-chain: ${text}`);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
