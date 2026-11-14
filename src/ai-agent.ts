import { z } from 'zod';
import type { RiskSnapshot } from './types.js';

const analysisSchema = z.object({
  summary: z.string().min(1).max(1200),
  keyFindings: z.array(z.string().min(1).max(400)).max(5),
  recommendedActions: z.array(z.string().min(1).max(400)).max(5),
  dataQuality: z.string().min(1).max(500)
});

export type AIAnalysis = z.infer<typeof analysisSchema>;

interface AIResponse {
  error?: {
    message?: string;
    type?: string;
  };
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
    };
  }>;
}

export async function analyzeRisk(
  snapshot: RiskSnapshot,
  apiKey: string,
  model: string
): Promise<AIAnalysis> {
  const input = {
    accountId: snapshot.accountId,
    healthFactor: snapshot.healthFactor,
    adjustedCollateralUsd: snapshot.adjustedCollateralUsd,
    adjustedDebtUsd: snapshot.adjustedDebtUsd,
    collateralUsd: snapshot.collateralUsd,
    debtUsd: snapshot.debtUsd,
    collateral: snapshot.collateral.map(asset => ({
      tokenId: asset.tokenId,
      symbol: asset.symbol,
      amount: asset.amount,
      priceUsd: asset.priceUsd,
      priceSource: asset.priceSource,
      adjustedUsd: asset.adjustedUsd,
      liquidationPriceUsd: asset.liquidationPriceUsd,
      liquidationMovePct: asset.liquidationMovePct
    })),
    debt: snapshot.debt.map(asset => ({
      tokenId: asset.tokenId,
      symbol: asset.symbol,
      amount: asset.amount,
      priceUsd: asset.priceUsd,
      priceSource: asset.priceSource,
      adjustedUsd: asset.adjustedUsd
    })),
    priceTimestamp: snapshot.priceTimestamp,
    fetchedAt: snapshot.fetchedAt,
    margin: snapshot.margin
  };

  const response = await fetch(
    'https://cloud-api.near.ai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
          content: [
  'You are NEAR Sentinel, a DeFi risk analyst for the NEAR ecosystem.',
  'Refer to the lending product as RHEA Lend in all user-facing analysis. The underlying on-chain contract is Burrow, but never call a user position a Burrow position.',
  'Analyze the supplied verified lending snapshot only.',
  'All financial calculations are performed by the deterministic risk engine. Never invent or modify financial figures.',
  'Identify the most important risks and explain them in plain language.',
  'If healthFactor is null, state that no active lending position was detected.',
  'Disclose missing, stale or uncertain data.',
  'Never claim a position is liquidatable unless the supplied data establishes that.',
'Treat liquidationPriceUsd and liquidationMovePct as isolated-collateral sensitivity estimates that hold debt values and other collateral constant. They are not necessarily valid for market shocks that also change debt asset prices.',
'If the same tokenId appears in both collateral and debt, do not describe its depeg as a liquidation trigger based on the collateral liquidation price alone. Explain that repricing both sides can offset, and assess risk using the supplied health factor and adjusted values.',
  'Provide informational recommendations only. Never execute transactions.',
  'Return a concise JSON object with exactly these fields:',
  '{"summary":"...","keyFindings":["..."],"recommendedActions":["..."],"dataQuality":"..."}',
  'Keep summary under 500 characters, keyFindings to at most 3 items, recommendedActions to at most 3 items, and dataQuality under 250 characters.'
].join(' ')  
          },
          {
            role: 'user',
            content: JSON.stringify(input)
          }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000
      })
    }
  );

  const body = await response.json() as AIResponse;

  if (!response.ok) {
    throw new Error(
      `NEAR AI request failed (${response.status}): ${body.error?.message ?? 'Unknown API error'}`
    );
  }

  const choice = body.choices?.[0];

  if (choice?.finish_reason === 'length') {
    throw new Error('AI analysis was cut off before completion. Please try again.');
  }

  const content = choice?.message?.content;

  if (!content) {
    throw new Error('NEAR AI returned no analysis content.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('NEAR AI returned an invalid JSON analysis.');
  }

  const result = analysisSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error('NEAR AI returned an analysis in an unexpected format.');
  }

  return result.data;
}
