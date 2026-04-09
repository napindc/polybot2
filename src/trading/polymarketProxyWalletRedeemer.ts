import { Contract, Interface, JsonRpcProvider, Wallet, getCreate2Address, keccak256, solidityPacked } from 'ethers';

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const OWNER_SLOT = '0x734a2a5caf82146a5ddd5263d9af379f9f72724959f0567ddc9df2c40cf2cc20';

const PROXY_WALLET_ABI = [
  'function proxy((uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[] returnValues)',
] as const;

const PROXY_WALLET_FACTORY_ABI = [
  'function getImplementation() view returns (address)',
  'function proxy((uint8 typeCode,address to,uint256 value,bytes data)[] calls) payable returns (bytes[] returnValues)',
] as const;

const CONDITIONAL_TOKENS_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
] as const;

interface ProxyCall {
  readonly typeCode: number;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
}

export interface CreatePolymarketProxyWalletRedeemerInput {
  readonly rpcUrl: string;
  readonly proxyWallet: string;
  readonly ownerPrivateKey: string;
  readonly conditionalTokensAddress: string;
  readonly collateralTokenAddress: string;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly minGasReserveWei?: bigint;
}

export interface ProxyRedeemResult {
  readonly txHash: string;
  readonly conditionId: string;
  readonly outcomeIndex: number;
  readonly claimedAtMs: number;
}

export class PolymarketProxyWalletRedeemer {
  private readonly provider: JsonRpcProvider;
  private readonly ownerSigner: Wallet;
  private readonly proxyWallet: string;
  private factoryAddress: string | null = null;
  private readonly factoryInterface: Interface;
  private readonly ctfInterface: Interface;
  private readonly conditionalTokensAddress: string;
  private readonly collateralTokenAddress: string;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly minGasReserveWei: bigint;

  public constructor(input: CreatePolymarketProxyWalletRedeemerInput) {
    this.provider = new JsonRpcProvider(input.rpcUrl);
    this.ownerSigner = new Wallet(input.ownerPrivateKey, this.provider);
    this.proxyWallet = input.proxyWallet;
    this.factoryInterface = new Interface(['function cloneConstructor(bytes)']);
    this.ctfInterface = new Interface(CONDITIONAL_TOKENS_ABI);
    this.conditionalTokensAddress = input.conditionalTokensAddress;
    this.collateralTokenAddress = input.collateralTokenAddress;
    this.maxRetries = Math.max(0, Math.floor(input.maxRetries ?? 2));
    this.baseRetryDelayMs = Math.max(250, Math.floor(input.baseRetryDelayMs ?? 500));
    this.minGasReserveWei = input.minGasReserveWei ?? 1_000_000_000_000_000n;
  }

  public async getOwnerSignerAddress(): Promise<string> {
    return (await this.ownerSigner.getAddress()).toLowerCase();
  }

  public async hasEnoughGasReserve(): Promise<boolean> {
    const balanceWei = await this.provider.getBalance(await this.getOwnerSignerAddress());
    return balanceWei >= this.minGasReserveWei;
  }

  public async isCompatibleAndOwnedBySigner(): Promise<boolean> {
    const code = await this.provider.getCode(this.proxyWallet);
    if (code === '0x') {
      return false;
    }

    const factoryAddress = await this.readFactoryFromStorageSlot();
    if (!factoryAddress) {
      return false;
    }
    this.factoryAddress = factoryAddress;

    const factoryCode = await this.provider.getCode(factoryAddress);
    if (factoryCode === '0x') {
      return false;
    }

    try {
      const derived = await this.deriveProxyAddress(factoryAddress, await this.getOwnerSignerAddress());
      if (derived.toLowerCase() !== this.proxyWallet.toLowerCase()) {
        return false;
      }

      const factory = new Contract(factoryAddress, PROXY_WALLET_FACTORY_ABI, this.ownerSigner);
      await factory.proxy.staticCall([]);
      return true;
    } catch {
      return false;
    }
  }

  public async redeemSingleOutcome(conditionId: string, outcomeIndex: number): Promise<ProxyRedeemResult> {
    if (!/^0x[a-fA-F0-9]{64}$/.test(conditionId)) {
      throw new Error(`Invalid conditionId: ${conditionId}`);
    }
    if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex > 30) {
      throw new Error(`Invalid outcomeIndex: ${outcomeIndex}`);
    }

    const indexSet = 1n << BigInt(outcomeIndex);
    const data = this.ctfInterface.encodeFunctionData('redeemPositions', [
      this.collateralTokenAddress,
      ZERO_BYTES32,
      conditionId,
      [indexSet],
    ]);

    const call: ProxyCall = {
      typeCode: 1,
      to: this.conditionalTokensAddress,
      value: 0n,
      data,
    };

    const factoryAddress = this.factoryAddress ?? await this.readFactoryFromStorageSlot();
    if (!factoryAddress) {
      throw new Error('Proxy wallet factory not found in owner slot');
    }

    const factory = new Contract(factoryAddress, PROXY_WALLET_FACTORY_ABI, this.ownerSigner);

    const txResponse = await this.executeWithRetry(async (attempt) => {
      await factory.proxy.staticCall([call]);
      const gasOptions = await this.buildGasOptions(attempt);
      return factory.proxy([call], gasOptions);
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

  private async readFactoryFromStorageSlot(): Promise<string | null> {
    const raw = await this.provider.getStorage(this.proxyWallet, OWNER_SLOT);
    if (!raw || raw === '0x') {
      return null;
    }

    const normalized = raw.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    const addressHex = normalized.slice(24);
    if (!/[1-9a-f]/.test(addressHex)) {
      return null;
    }

    return `0x${addressHex}`;
  }

  private async deriveProxyAddress(factoryAddress: string, signerAddress: string): Promise<string> {
    const factory = new Contract(factoryAddress, PROXY_WALLET_FACTORY_ABI, this.provider);
    const implementation = await factory.getImplementation() as string;
    const constructorData = this.factoryInterface.encodeFunctionData('cloneConstructor', ['0x']);
    const initCode = `0x${
      '3d3d606380380380913d393d73'
    }${factoryAddress.slice(2).toLowerCase()}${
      '5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73'
    }${implementation.slice(2).toLowerCase()}${
      '5af43d82803e903d91602b57fd5bf3'
    }${constructorData.slice(2).toLowerCase()}`;

    const salt = keccak256(solidityPacked(['address'], [signerAddress]));
    return getCreate2Address(factoryAddress, salt, keccak256(initCode));
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
