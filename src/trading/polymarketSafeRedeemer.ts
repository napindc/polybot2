import { Contract, Interface, JsonRpcProvider, Signature, Wallet, ZeroAddress } from 'ethers';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
] as const;

const CONDITIONAL_TOKENS_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
] as const;

export interface CreatePolymarketSafeRedeemerInput {
  readonly rpcUrl: string;
  readonly safeAddress: string;
  readonly ownerPrivateKey: string;
  readonly conditionalTokensAddress: string;
  readonly collateralTokenAddress: string;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly minGasReserveWei?: bigint;
}

export interface SafeRedeemResult {
  readonly txHash: string;
  readonly conditionId: string;
  readonly outcomeIndex: number;
  readonly claimedAtMs: number;
}

export class PolymarketSafeRedeemer {
  private readonly provider: JsonRpcProvider;
  private readonly ownerSigner: Wallet;
  private readonly safeContract: Contract;
  private readonly ctfInterface: Interface;
  private readonly conditionalTokensAddress: string;
  private readonly collateralTokenAddress: string;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly minGasReserveWei: bigint;

  public constructor(input: CreatePolymarketSafeRedeemerInput) {
    this.provider = new JsonRpcProvider(input.rpcUrl);
    this.ownerSigner = new Wallet(input.ownerPrivateKey, this.provider);
    this.safeContract = new Contract(input.safeAddress, SAFE_ABI, this.ownerSigner);
    this.ctfInterface = new Interface(CONDITIONAL_TOKENS_ABI);
    this.conditionalTokensAddress = input.conditionalTokensAddress;
    this.collateralTokenAddress = input.collateralTokenAddress;
    this.maxRetries = Math.max(0, Math.floor(input.maxRetries ?? 2));
    this.baseRetryDelayMs = Math.max(250, Math.floor(input.baseRetryDelayMs ?? 500));
    this.minGasReserveWei = input.minGasReserveWei ?? 1_000_000_000_000_000n;
  }

  public async getOwnerAddress(): Promise<string> {
    return (await this.ownerSigner.getAddress()).toLowerCase();
  }

  public async hasEnoughGasReserve(): Promise<boolean> {
    const balanceWei = await this.provider.getBalance(await this.getOwnerAddress());
    return balanceWei >= this.minGasReserveWei;
  }

  public async redeemSingleOutcome(conditionId: string, outcomeIndex: number): Promise<SafeRedeemResult> {
    if (!/^0x[a-fA-F0-9]{64}$/.test(conditionId)) {
      throw new Error(`Invalid conditionId: ${conditionId}`);
    }
    if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 30) {
      throw new Error(`Invalid outcomeIndex: ${outcomeIndex}`);
    }

    await this.assertSafeOwnerThresholdOne();

    const indexSet = 1n << BigInt(outcomeIndex);
    const data = this.ctfInterface.encodeFunctionData('redeemPositions', [
      this.collateralTokenAddress,
      ZERO_BYTES32,
      conditionId,
      [indexSet],
    ]);

    const txResponse = await this.executeWithRetry(async (attempt) => {
      const nonce = await this.safeContract.nonce() as bigint;
      const safeTxHash = await this.safeContract.getTransactionHash(
        this.conditionalTokensAddress,
        0,
        data,
        0,
        0,
        0,
        0,
        ZeroAddress,
        ZeroAddress,
        nonce,
      ) as string;

      const signature = this.buildSafeSignature(safeTxHash);

      await this.safeContract.execTransaction.staticCall(
        this.conditionalTokensAddress,
        0,
        data,
        0,
        0,
        0,
        0,
        ZeroAddress,
        ZeroAddress,
        signature,
      );

      const gasOptions = await this.buildGasOptions(attempt);
      return this.safeContract.execTransaction(
        this.conditionalTokensAddress,
        0,
        data,
        0,
        0,
        0,
        0,
        ZeroAddress,
        ZeroAddress,
        signature,
        gasOptions,
      );
    });

    const receipt = await txResponse.wait(1);
    const txHash = typeof receipt?.hash === 'string' ? receipt.hash : String(txResponse.hash ?? 'unknown');

    return {
      txHash,
      conditionId,
      outcomeIndex,
      claimedAtMs: Date.now(),
    };
  }

  private async assertSafeOwnerThresholdOne(): Promise<void> {
    const owner = await this.getOwnerAddress();
    const isOwner = await this.safeContract.isOwner(owner) as boolean;
    if (!isOwner) {
      throw new Error(`Configured owner ${owner} is not a Safe owner`);
    }

    const threshold = await this.safeContract.getThreshold() as bigint;
    if (threshold !== 1n) {
      throw new Error(`Safe threshold ${threshold.toString()} is not supported by auto-redeem (requires threshold=1)`);
    }
  }

  private buildSafeSignature(safeTxHash: string): string {
    const signed = this.ownerSigner.signingKey.sign(safeTxHash);
    return Signature.from(signed).serialized;
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

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async buildGasOptions(attempt: number): Promise<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const feeData = await this.provider.getFeeData();

    const baseMaxFee = feeData.maxFeePerGas ?? 40_000_000_000n;
    const basePriorityFee = feeData.maxPriorityFeePerGas ?? 3_000_000_000n;
    const multiplier = BigInt(100 + attempt * 20);

    return {
      gasLimit: 500_000n,
      maxFeePerGas: (baseMaxFee * multiplier) / 100n,
      maxPriorityFeePerGas: (basePriorityFee * multiplier) / 100n,
    };
  }
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
    || normalized.includes('already known')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
