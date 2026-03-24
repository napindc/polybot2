import 'dotenv/config';
import fs from 'node:fs';
import { ClobClient, Chain } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';

function resolveSignatureType(raw: string | undefined): SignatureType {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'eoa' || normalized === '0') return SignatureType.EOA;
  if (normalized === 'poly_gnosis_safe' || normalized === 'gnosis' || normalized === 'safe' || normalized === '2') {
    return SignatureType.POLY_GNOSIS_SAFE;
  }
  return SignatureType.POLY_PROXY;
}

function upsertEnvVar(envText: string, name: string, value: string): string {
  const escaped = value.replace(/"/g, '\\"');
  const line = `${name}="${escaped}"`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(envText)) {
    return envText.replace(pattern, line);
  }
  return `${envText}${envText.endsWith('\n') ? '' : '\n'}${line}\n`;
}

async function main(): Promise<void> {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  const proxyWallet = process.env.POLYMARKET_PROXY_WALLET;
  if (!privateKey || !proxyWallet) {
    throw new Error('Missing WALLET_PRIVATE_KEY or POLYMARKET_PROXY_WALLET');
  }

  const wallet = new Wallet(privateKey);
  const signatureType = resolveSignatureType(process.env.POLYMARKET_SIGNATURE_TYPE);
  const client = new ClobClient(
    'https://clob.polymarket.com',
    Chain.POLYGON,
    wallet,
    undefined,
    signatureType,
    proxyWallet,
  );

  const creds = await client.createOrDeriveApiKey();
  let envText = fs.readFileSync('.env', 'utf8');
  envText = upsertEnvVar(envText, 'POLYMARKET_API_KEY', creds.key);
  envText = upsertEnvVar(envText, 'POLYMARKET_API_SECRET', creds.secret);
  envText = upsertEnvVar(envText, 'POLYMARKET_PASSPHRASE', creds.passphrase);
  envText = upsertEnvVar(envText, 'POLYMARKET_SIGNATURE_TYPE', 'POLY_PROXY');
  fs.writeFileSync('.env', envText, 'utf8');

  console.log('sync-clob-creds: updated .env with derived CLOB credentials');
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`sync-clob-creds: failed - ${msg}`);
  process.exit(1);
});
