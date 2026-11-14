import 'dotenv/config';
import { NearRpc } from './near.js';

const rpc = new NearRpc(
  process.env.NEAR_RPC_PRIMARY ?? 'https://rpc.mainnet.fastnear.com',
  process.env.NEAR_RPC_FALLBACK ?? 'https://1rpc.io/near'
);

const probes = [
  { contract: 'meta-pool.near', method: 'get_st_near_price' },
  { contract: 'lst.rhealab.near', method: 'ft_price' },
  { contract: 'linear-protocol.near', method: 'ft_price' }
];

for (const probe of probes) {
  console.log(`\n--- ${probe.contract} :: ${probe.method} ---`);
  try {
    const result = await rpc.view<unknown>(
      probe.contract,
      probe.method,
      {}
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log('CALL FAILED:', String(error));
  }
}
