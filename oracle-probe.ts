
import 'dotenv/config';
import { NearRpc } from './near.js';

const rpc = new NearRpc(
  process.env.NEAR_RPC_PRIMARY ?? 'https://rpc.mainnet.fastnear.com',
  process.env.NEAR_RPC_FALLBACK ?? 'https://1rpc.io/near'
);

const feeds = {
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  NEAR: 'c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750',
  DAI: 'b0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd',
  USDT: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b'
};

const result = await rpc.view<unknown>(
  'aggregate-oracle.near',
  'list_prices_no_older_than',
  {
    price_ids: Object.values(feeds),
    age: 60
  }
);

console.log('AGGREGATE ORACLE BATCH RESPONSE:');
console.log(JSON.stringify(result, null, 2));
