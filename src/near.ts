
import { Buffer } from 'node:buffer';
import type {
  LendingAccount,
  AssetInfo,
  PriceData,
  NormalizedPrice,
  OracleAssetConfig
} from './types.js';

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

const PYTH_ORACLE = 'aggregate-oracle.near';
const RATE_SCALE = 1e24;

const PYTH_FEEDS: Record<string, string> = {
  'wrap.near':
    'c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750',

  'aurora':
    'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',

  'usdt.tether-token.near':
    '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',

  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near':
    'b0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd',

  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near':
    'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',

  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1':
    'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a'
};

const LST_SOURCES: Record<string, {
  contract: string;
  method: string;
  source: string;
}> = {
  'meta-pool.near': {
    contract: 'meta-pool.near',
    method: 'get_st_near_price',
    source: 'meta-pool.near'
  },

  'lst.rhealab.near': {
    contract: 'lst.rhealab.near',
    method: 'ft_price',
    source: 'lst.rhealab.near'
  },

  'linear-protocol.near': {
    contract: 'linear-protocol.near',
    method: 'ft_price',
    source: 'linear-protocol.near'
  }
};

interface PythPrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

export class NearRpc {
  private endpoints: string[];
  private requestId = 0;

  constructor(primary: string, fallback: string) {
    this.endpoints = [...new Set([primary, fallback].filter(Boolean))];
  }

  private async rpc<T>(payload: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (const endpoint of this.endpoints) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: ++this.requestId,
              ...payload
            }),
            signal: AbortSignal.timeout(12_000)
          });

          if (!response.ok) {
            throw new Error(`RPC HTTP ${response.status}`);
          }

          const json = await response.json() as {
            result?: T;
            error?: { message?: string };
          };

          if (json.error) {
            throw new Error(json.error.message ?? 'NEAR RPC error');
          }

          if (json.result === undefined) {
            throw new Error('RPC response has no result');
          }

          return json.result;
        } catch (error) {
          lastError = error;
          if (attempt === 0) await sleep(350);
        }
      }
    }

    throw new Error(`All NEAR RPC endpoints failed: ${String(lastError)}`);
  }

  async view<T>(
    contractId: string,
    methodName: string,
    args: object
  ): Promise<T> {
    const argsBase64 = Buffer
      .from(JSON.stringify(args))
      .toString('base64');

    const result = await this.rpc<{
      result: number[];
      block_height: number;
      block_timestamp: string;
    }>({
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: methodName,
        args_base64: argsBase64
      }
    });

    if (!Array.isArray(result.result)) {
      throw new Error(`${methodName} returned malformed bytes`);
    }

    const decoded = Buffer.from(result.result).toString('utf8');

    try {
      return JSON.parse(decoded) as T;
    } catch {
      throw new Error(
        `${methodName} returned invalid JSON: ${decoded.slice(0, 160)}`
      );
    }
  }

  async getAccount(
    contractId: string,
    accountId: string
  ): Promise<LendingAccount> {
    return this.view<LendingAccount>(
      contractId,
      'get_account',
      { account_id: accountId }
    );
  }

  async getAsset(
    contractId: string,
    tokenId: string
  ): Promise<AssetInfo> {
    return this.view<AssetInfo>(
      contractId,
      'get_asset',
      { token_id: tokenId }
    );
  }

  async getAssetsPaged(contractId: string): Promise<AssetInfo[]> {
    const all: AssetInfo[] = [];
    const pageSize = 100;

    for (let from = 0; from < 1000; from += pageSize) {
      const page = await this.view<AssetInfo[]>(
        contractId,
        'get_assets_paged',
        { from_index: from, limit: pageSize }
      );

      if (!Array.isArray(page)) {
        throw new Error('get_assets_paged did not return an array');
      }

      all.push(...page);

      if (page.length < pageSize) break;
    }

    return all;
  }

  async getOracleAssetConfigs(
    configContractId: string,
    method: string,
    assetIds: string[]
  ): Promise<Array<[string, OracleAssetConfig]>> {
    return this.view<Array<[string, OracleAssetConfig]>>(
      configContractId,
      method,
      { keys: assetIds }
    );
  }

  private async getPythPrices(
    feedIds: string[],
    maxAgeSeconds: number
  ): Promise<Map<string, PythPrice>> {
    if (feedIds.length === 0) return new Map();

    const response = await this.view<Record<string, PythPrice>>(
      PYTH_ORACLE,
      'list_prices_no_older_than',
      {
        price_ids: feedIds,
        age: maxAgeSeconds
      }
    );

    if (!response || typeof response !== 'object') {
      throw new Error('Pyth batch oracle returned an invalid response');
    }

    return new Map(Object.entries(response));
  }

  private async getExchangeRate(
    contractId: string,
    method: string
  ): Promise<number> {
    const raw = await this.view<string>(contractId, method, {});
    const rate = Number(raw) / RATE_SCALE;

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid exchange rate from ${contractId}.${method}`);
    }

    return rate;
  }

  async getPricesForAssets(
    assetIds: string[],
    maxAgeSeconds: number
  ): Promise<PriceData> {
    const uniqueIds = [...new Set(assetIds)];

    const requiredFeeds = new Set<string>();

    for (const assetId of uniqueIds) {
      const feed = PYTH_FEEDS[assetId];
      if (feed) requiredFeeds.add(feed);

      if (LST_SOURCES[assetId]) {
        const nearFeed = PYTH_FEEDS['wrap.near'];
        if (!nearFeed) {
  throw new Error('Missing configured NEAR/USD Pyth feed');
}
requiredFeeds.add(nearFeed);
      }
    }

    const pyth = await this.getPythPrices(
      [...requiredFeeds],
      maxAgeSeconds
    );

    const now = Date.now() / 1000;

    const readPyth = (feedId: string): {
      priceUsd: number;
      timestamp: number;
    } => {
      const item = pyth.get(feedId);

      if (!item) {
        throw new Error(`Pyth oracle did not return feed ${feedId}`);
      }

      const price = Number(item.price) * (10 ** item.expo);
      const timestamp = Number(item.publish_time);

      if (
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isFinite(timestamp) ||
        timestamp <= 0 ||
        now - timestamp > maxAgeSeconds ||
        timestamp - now > 30
      ) {
        throw new Error(`Invalid or stale Pyth price for feed ${feedId}`);
      }

      return { priceUsd: price, timestamp };
    };

    const normalized: NormalizedPrice[] = [];

    for (const assetId of uniqueIds) {
      const feedId = PYTH_FEEDS[assetId];

      if (feedId) {
        const p = readPyth(feedId);

        normalized.push({
          asset_id: assetId,
          price_usd: p.priceUsd,
          source: `aggregate-oracle.near (Pyth: ${feedId})`,
          timestamp: p.timestamp,
          source_timestamp: p.timestamp
        });

        continue;
      }

      const lst = LST_SOURCES[assetId];

      if (lst) {
        const nearFeed = PYTH_FEEDS['wrap.near'];
if (!nearFeed) {
  throw new Error('Missing configured NEAR/USD Pyth feed');
}
        const near = readPyth(nearFeed);
        const exchangeRate = await this.getExchangeRate(
          lst.contract,
          lst.method
        );

        normalized.push({
          asset_id: assetId,
          price_usd: exchangeRate * near.priceUsd,
          source: `${lst.source}.${lst.method} × NEAR/USD`,
          timestamp: near.timestamp,
          source_timestamp: near.timestamp
        });
      }
    }

    return { prices: normalized };
  }
}
