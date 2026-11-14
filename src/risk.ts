
import type {
  LendingAccount,
  AssetInfo,
  PriceData,
  OracleAssetConfig,
  RiskAsset,
  RiskSnapshot
} from './types.js';

function numeric(value: unknown, label: string): number {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${label}`);
  }

  return n;
}

function amountFromRaw(raw: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Invalid asset decimals: ${decimals}`);
  }

  const value = Number(raw) / (10 ** decimals);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Asset amount overflow or invalid balance');
  }

  return value;
}

export function buildSnapshot(
  accountId: string,
  account: LendingAccount,
  assets: AssetInfo[],
  priceData: PriceData,
  oracleConfigs: Array<[string, OracleAssetConfig]>,
  maxPriceAgeSeconds: number
): RiskSnapshot {
  const assetMap = new Map(assets.map(a => [a.token_id, a]));
  const oracleConfigMap = new Map(oracleConfigs);
  const priceMap = new Map<string, PriceData['prices'][number]>();

  for (const price of priceData.prices) {
    const existing = priceMap.get(price.asset_id);

    if (existing && (
      existing.price_usd !== price.price_usd ||
      existing.timestamp !== price.timestamp
    )) {
      throw new Error(
        `Conflicting duplicate oracle prices for ${price.asset_id}`
      );
    }

    priceMap.set(price.asset_id, price);
  }

  const now = Date.now() / 1000;
  const usedTimestamps: number[] = [];

  const make = (
    entry: { token_id: string; balance: string },
    side: 'collateral' | 'debt'
  ): RiskAsset => {
    const info = assetMap.get(entry.token_id);

    if (!info?.config) {
      throw new Error(
        `Missing on-chain asset config for ${entry.token_id}`
      );
    }

    const ratioRaw = numeric(
      info.config.volatility_ratio,
      `volatility_ratio for ${entry.token_id}`
    );

    const volatilityRatio =
      ratioRaw > 1 ? ratioRaw / 10_000 : ratioRaw;

    if (volatilityRatio <= 0 || volatilityRatio > 1) {
      throw new Error(
        `Unsupported volatility ratio for ${entry.token_id}`
      );
    }

    const oracle = priceMap.get(entry.token_id);

    if (!oracle) {
      throw new Error(
        `No verified USD price route for ${entry.token_id}`
      );
    }

    const priceUsd = numeric(
      oracle.price_usd,
      `USD price for ${entry.token_id}`
    );

    if (priceUsd <= 0) {
      throw new Error(`Invalid USD price for ${entry.token_id}`);
    }

    const timestamp = numeric(
      oracle.timestamp,
      `price timestamp for ${entry.token_id}`
    );

    if (
      timestamp <= 0 ||
      now - timestamp > maxPriceAgeSeconds ||
      timestamp - now > 30
    ) {
      throw new Error(
        `Price for ${entry.token_id} is stale or has an invalid timestamp`
      );
    }

    usedTimestamps.push(timestamp);

    const oracleConfig = oracleConfigMap.get(entry.token_id);

    if (!oracleConfig) {
      throw new Error(
        `Missing oracle asset decimals for ${entry.token_id}`
      );
    }

    const tokenDecimals = numeric(
      oracleConfig.decimals,
      `oracle asset decimals for ${entry.token_id}`
    );

    const extraDecimals = numeric(
      info.config.extra_decimals ?? 0,
      `extra_decimals for ${entry.token_id}`
    );

    const amount = amountFromRaw(
      entry.balance,
      tokenDecimals + extraDecimals
    );

    const adjustedUsd = side === 'collateral'
      ? amount * priceUsd * volatilityRatio
      : amount * priceUsd / volatilityRatio;

    if (!Number.isFinite(adjustedUsd)) {
      throw new Error(
        `Adjusted USD value overflow for ${entry.token_id}`
      );
    }

    return {
      tokenId: entry.token_id,
      symbol:
        info.metadata?.symbol ??
        oracleConfig.token_name ??
        entry.token_id,
      amount,
      priceUsd,
      priceSource: oracle.source,
      volatilityRatio,
      adjustedUsd,
      side
    };
  };

  const collateralEntries = account.collateral ?? [];
  const debtEntries = account.borrowed ?? [];

  const collateral = collateralEntries
    .filter(x => Number(x.balance) > 0)
    .map(x => make(x, 'collateral'));

  const debt = debtEntries
    .filter(x => Number(x.balance) > 0)
    .map(x => make(x, 'debt'));

  const adjustedCollateralUsd = collateral.reduce(
    (sum, item) => sum + item.adjustedUsd,
    0
  );

  const adjustedDebtUsd = debt.reduce(
    (sum, item) => sum + item.adjustedUsd,
    0
  );

  const collateralUsd = collateral.reduce(
    (sum, item) => sum + item.amount * item.priceUsd,
    0
  );

  const debtUsd = debt.reduce(
    (sum, item) => sum + item.amount * item.priceUsd,
    0
  );

  const healthFactor = adjustedDebtUsd === 0
    ? null
    : adjustedCollateralUsd / adjustedDebtUsd;

  if (healthFactor !== null) {
    for (const item of collateral) {
      const otherCollateral =
        adjustedCollateralUsd - item.adjustedUsd;

      const requiredPrice =
        (adjustedDebtUsd - otherCollateral) /
        (item.amount * item.volatilityRatio);

      if (requiredPrice > 0) {
        item.liquidationPriceUsd = requiredPrice;

        item.liquidationMovePct =
          ((requiredPrice / item.priceUsd) - 1) * 100;
      }
    }
  }

  return {
    accountId,
    healthFactor,
    adjustedCollateralUsd,
    adjustedDebtUsd,
    collateralUsd,
    debtUsd,
    collateral,
    debt,
    priceTimestamp: usedTimestamps.length
      ? Math.min(...usedTimestamps)
      : now,
    fetchedAt: now,
    margin: {
      status: 'not-integrated',
     reason: 'Margin trading is not integrated. This health factor covers the verified RHEA Lend position only.'
    }
  };
}

export function formatPct(value: number | null): string {
  return value === null
    ? 'N/A (no debt)'
    : `${(value * 100).toFixed(2)}%`;
}
