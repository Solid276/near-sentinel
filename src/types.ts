
export interface AccountAsset {
  token_id: string;
  balance: string;
  shares?: string;
}

export interface LendingAccount {
  account_id: string;
  supplied?: AccountAsset[];
  collateral?: AccountAsset[];
  borrowed?: AccountAsset[];
  [key: string]: unknown;
}

export interface AssetConfig {
  volatility_ratio?: number | string;
  extra_decimals?: number | string;
  [key: string]: unknown;
}

export interface AssetInfo {
  token_id: string;
  config?: AssetConfig;
  metadata?: { decimals?: number; symbol?: string; name?: string };
  [key: string]: unknown;
}

export interface OracleAssetConfig {
  decimals: number;
  token_name?: string;
}

export interface NormalizedPrice {
  asset_id: string;
  price_usd: number;
  source: string;
  timestamp: number;
  source_timestamp: number;
}

export interface PriceData {
  prices: NormalizedPrice[];
}

export interface RiskAsset {
  tokenId: string;
  symbol: string;
  amount: number;
  priceUsd: number;
  priceSource: string;
  volatilityRatio: number;
  adjustedUsd: number;
  side: 'collateral' | 'debt';
  liquidationPriceUsd?: number;
  liquidationMovePct?: number;
}

export interface RiskSnapshot {
  accountId: string;
  healthFactor: number | null;
  adjustedCollateralUsd: number;
  adjustedDebtUsd: number;
  collateralUsd: number;
  debtUsd: number;
  collateral: RiskAsset[];
  debt: RiskAsset[];
  priceTimestamp: number;
  fetchedAt: number;
  margin: {
    status: 'not-integrated';
    reason: string;
  };
}
