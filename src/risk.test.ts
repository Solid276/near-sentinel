
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './risk.js';

const now = Math.floor(Date.now() / 1000);

const oracleConfigs = [
  ['collateral.near', { decimals: 0, token_name: 'COL' }],
  ['debt.near', { decimals: 0, token_name: 'DEBT' }]
] as Array<[string, { decimals: number; token_name: string }]>;

test('calculates adjusted health factor from on-chain volatility ratios', () => {
  const assets = [
    {
      token_id: 'collateral.near',
      metadata: { decimals: 0, symbol: 'COL' },
      config: { volatility_ratio: 9000, extra_decimals: 0 }
    },
    {
      token_id: 'debt.near',
      metadata: { decimals: 0, symbol: 'DEBT' },
      config: { volatility_ratio: 10000, extra_decimals: 0 }
    }
  ];

  const prices = {
    prices: [
      {
        asset_id: 'collateral.near',
        price_usd: 100,
        source: 'test-feed',
        timestamp: now,
        source_timestamp: now
      },
      {
        asset_id: 'debt.near',
        price_usd: 1,
        source: 'test-feed',
        timestamp: now,
        source_timestamp: now
      }
    ]
  };

  const snapshot = buildSnapshot(
    'alice.near',
    {
      account_id: 'alice.near',
      collateral: [{ token_id: 'collateral.near', balance: '10' }],
      borrowed: [{ token_id: 'debt.near', balance: '500' }]
    },
    assets,
    prices,
    oracleConfigs,
    180
  );

  assert.equal(snapshot.healthFactor, 1.8);
  assert.equal(snapshot.collateral[0]?.priceUsd, 100);
  assert.equal(snapshot.debt[0]?.priceUsd, 1);
  assert.ok(
    Math.abs(
      (snapshot.collateral[0]?.liquidationPriceUsd ?? 0) - 55.55555555555556
    ) < 0.000001
  );
});

test('uses normalized USD prices and correct token decimal scaling', () => {
  const assets = [
    {
      token_id: 'wrap.near',
      metadata: { decimals: 24, symbol: 'wNEAR' },
      config: { volatility_ratio: 10000, extra_decimals: 0 }
    },
    {
      token_id: 'usdt.tether-token.near',
      metadata: { decimals: 6, symbol: 'USDt' },
      config: { volatility_ratio: 10000, extra_decimals: 0 }
    }
  ];

  const prices = {
    prices: [
      {
        asset_id: 'wrap.near',
        price_usd: 1.89,
        source: 'aggregate-oracle.near',
        timestamp: now,
        source_timestamp: now
      },
      {
        asset_id: 'usdt.tether-token.near',
        price_usd: 1,
        source: 'aggregate-oracle.near',
        timestamp: now,
        source_timestamp: now
      }
    ]
  };

  const configs: Array<[string, { decimals: number; token_name: string }]> = [
    ['wrap.near', { decimals: 24, token_name: 'wNEAR' }],
    ['usdt.tether-token.near', { decimals: 6, token_name: 'USDt' }]
  ];

  const snapshot = buildSnapshot(
    'alice.near',
    {
      account_id: 'alice.near',
      collateral: [
        {
          token_id: 'wrap.near',
          balance: '1000000000000000000000000'
        }
      ],
      borrowed: [
        {
          token_id: 'usdt.tether-token.near',
          balance: '1000000'
        }
      ]
    },
    assets,
    prices,
    configs,
    180
  );

  assert.equal(snapshot.collateral[0]?.amount, 1);
  assert.equal(snapshot.debt[0]?.amount, 1);
  assert.equal(snapshot.collateral[0]?.priceUsd, 1.89);
  assert.equal(snapshot.debt[0]?.priceUsd, 1);
  assert.equal(snapshot.healthFactor, 1.89);
});

test('rejects a missing price instead of silently treating it as zero', () => {
  const assets = [
    {
      token_id: 'collateral.near',
      metadata: { decimals: 0, symbol: 'COL' },
      config: { volatility_ratio: 10000, extra_decimals: 0 }
    }
  ];

  assert.throws(
    () =>
      buildSnapshot(
        'alice.near',
        {
          account_id: 'alice.near',
          collateral: [
            { token_id: 'collateral.near', balance: '10' }
          ],
          borrowed: []
        },
        assets,
        { prices: [] },
        [['collateral.near', { decimals: 0, token_name: 'COL' }]],
        180
      ),
    /No verified USD price route/
  );
});

test('rejects stale prices', () => {
  const staleTimestamp = now - 300;

  const assets = [
    {
      token_id: 'collateral.near',
      metadata: { decimals: 0, symbol: 'COL' },
      config: { volatility_ratio: 10000, extra_decimals: 0 }
    }
  ];

  assert.throws(
    () =>
      buildSnapshot(
        'alice.near',
        {
          account_id: 'alice.near',
          collateral: [
            { token_id: 'collateral.near', balance: '10' }
          ],
          borrowed: []
        },
        assets,
        {
          prices: [
            {
              asset_id: 'collateral.near',
              price_usd: 100,
              source: 'test-feed',
              timestamp: staleTimestamp,
              source_timestamp: staleTimestamp
            }
          ]
        },
        [['collateral.near', { decimals: 0, token_name: 'COL' }]],
        180
      ),
    /stale or has an invalid timestamp/
  );
});
