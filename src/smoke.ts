
import 'dotenv/config';
import { z } from 'zod';
import { NearRpc } from './near.js';
import { buildSnapshot } from './risk.js';

const cfg = z.object({
  PUBLIC_ACCOUNT_ID: z.string().min(2),
  NEAR_RPC_PRIMARY: z.string().url().default('https://rpc.mainnet.fastnear.com'),
  NEAR_RPC_FALLBACK: z.string().url().default('https://1rpc.io/near'),
  LENDING_CONTRACT_ID: z.string().default('contract.main.burrow.near'),
  PRICE_CONFIG_CONTRACT_ID: z.string().default('oracle-prices.near'),
  PRICE_CONFIG_METHOD: z.string().default('get_config'),
  MAX_PRICE_AGE_SECONDS: z.coerce.number().int().min(30).default(180)
}).parse(process.env);

const accountId = cfg.PUBLIC_ACCOUNT_ID.toLowerCase();

if (
  !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(accountId) ||
  accountId.length > 64
) {
  throw new Error('Invalid NEAR account ID');
}

const rpc = new NearRpc(
  cfg.NEAR_RPC_PRIMARY,
  cfg.NEAR_RPC_FALLBACK
);

const account = await rpc.getAccount(
  cfg.LENDING_CONTRACT_ID,
  accountId
);

console.log('get_account: OK');
console.log('Account:', account.account_id);

const tokenIds = [...new Set([
  ...(account.collateral ?? []),
  ...(account.borrowed ?? [])
].filter(x => Number(x.balance) > 0).map(x => x.token_id))];

console.log('\nActive position assets:');
console.log(JSON.stringify(tokenIds, null, 2));

if (tokenIds.length === 0) {
  console.log('No active collateral or debt positions.');
  process.exit(0);
}

const [assets, prices, configs] = await Promise.all([
  rpc.getAssetsPaged(cfg.LENDING_CONTRACT_ID),
  rpc.getPricesForAssets(tokenIds, cfg.MAX_PRICE_AGE_SECONDS),
  rpc.getOracleAssetConfigs(
    cfg.PRICE_CONFIG_CONTRACT_ID,
    cfg.PRICE_CONFIG_METHOD,
    tokenIds
  )
]);

console.log('\nNORMALIZED USD PRICES:');
console.log(JSON.stringify(prices.prices, null, 2));

const pricedIds = new Set(
  prices.prices.map(p => p.asset_id)
);

const missing = tokenIds.filter(id => !pricedIds.has(id));

console.log('\nPRICE COVERAGE:', `${pricedIds.size}/${tokenIds.length}`);

if (missing.length > 0) {
  console.log('Assets without a verified price route:');
  console.log(JSON.stringify(missing, null, 2));
}

const positionAssets = await Promise.all(
  tokenIds.map(id =>
    rpc.getAsset(cfg.LENDING_CONTRACT_ID, id)
  )
);

const merged = new Map(
  assets.map(a => [a.token_id, a])
);

for (const asset of positionAssets) {
  merged.set(asset.token_id, {
    ...merged.get(asset.token_id),
    ...asset
  });
}

const snapshot = buildSnapshot(
  accountId,
  account,
  [...merged.values()],
  prices,
  configs,
  cfg.MAX_PRICE_AGE_SECONDS
);

console.log('\nRISK SNAPSHOT:');
console.log(JSON.stringify(snapshot, null, 2));

console.log('\nSMOKE TEST PASSED');
