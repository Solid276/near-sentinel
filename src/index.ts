import 'dotenv/config';
import { Bot, Keyboard } from 'grammy';
import express from 'express';
import cron from 'node-cron';
import { z } from 'zod';
import { NearRpc } from './near.js';
import { buildSnapshot, formatPct } from './risk.js';
import { Store, type Subscription } from './db.js';
import type { RiskSnapshot } from './types.js';
import { analyzeRisk } from './ai-agent.js';

const env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  NEAR_AI_API_KEY: z.string().optional(),
  NEAR_AI_MODEL: z.string().default('z-ai/glm-5.3-flash'),
  NEAR_RPC_PRIMARY: z.string().url().default('https://rpc.mainnet.near.org'),
  NEAR_RPC_FALLBACK: z.string().url().default('https://1rpc.io/near'),
  LENDING_CONTRACT_ID: z.string().default('contract.main.burrow.near'),
  
  PRICE_CONFIG_CONTRACT_ID: z.string().default('oracle-prices.near'),
  PRICE_CONFIG_METHOD: z.string().default('get_config'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/risk-monitor.sqlite'),
  POLL_SECONDS: z.coerce.number().int().min(60).default(60),
  RATE_LIMIT_SECONDS: z.coerce.number().int().min(1).default(15),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).default(60),
  MAX_PRICE_AGE_SECONDS: z.coerce.number().int().min(30).default(180),
  
}).parse(process.env);

const accountSchema = z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, 'Invalid NEAR account ID format');
const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
const mainMenu = new Keyboard()
  .text('Track 📊').text('Status 📋')
  .row()
  .text('Analyze 🔍').text('Threshold ⚙️')
  .row()
  .text('Stop tracking 🛑')
  .resized()
  .persistent();

const rpc = new NearRpc(env.NEAR_RPC_PRIMARY, env.NEAR_RPC_FALLBACK);
const store = new Store(env.DATABASE_PATH);
const lastFailureNotice = new Map<string, number>();
const pendingInput = new Map<string, 'track' | 'threshold'>();


async function fetchSnapshot(accountId: string): Promise<RiskSnapshot> {
  const account = await rpc.getAccount(
    env.LENDING_CONTRACT_ID,
    accountId
  );

  const tokenIds = [...new Set([
    ...(account.collateral ?? []),
    ...(account.borrowed ?? [])
  ].filter(x => Number(x.balance) > 0).map(x => x.token_id))];

  const assets = await rpc.getAssetsPaged(
    env.LENDING_CONTRACT_ID
  );

  if (tokenIds.length === 0) {
    return {
      accountId,
      healthFactor: null,
      adjustedCollateralUsd: 0,
      adjustedDebtUsd: 0,
      collateralUsd: 0,
      debtUsd: 0,
      collateral: [],
      debt: [],
      priceTimestamp: Date.now() / 1000,
      fetchedAt: Date.now() / 1000,
      margin: {
        status: 'not-integrated',
        reason: 'No active collateral or borrowed positions were found.'
      }
    };
  }

  const [prices, oracleConfigs, positionAssets] = await Promise.all([
    rpc.getPricesForAssets(
      tokenIds,
      env.MAX_PRICE_AGE_SECONDS
    ),

    rpc.getOracleAssetConfigs(
      env.PRICE_CONFIG_CONTRACT_ID,
      env.PRICE_CONFIG_METHOD,
      tokenIds
    ),

    Promise.all(
      tokenIds.map(id =>
        rpc.getAsset(env.LENDING_CONTRACT_ID, id)
      )
    )
  ]);

  const merged = new Map(
    assets.map(a => [a.token_id, a])
  );

  for (const asset of positionAssets) {
    merged.set(asset.token_id, {
      ...merged.get(asset.token_id),
      ...asset
    });
  }

  return buildSnapshot(
    accountId,
    account,
    [...merged.values()],
    prices,
    oracleConfigs,
    env.MAX_PRICE_AGE_SECONDS
  );
}

function renderSnapshot(s: RiskSnapshot): string {
  const lines = [
    `NEAR Sentinel`, `Account: ${s.accountId}`,
    `Health factor: ${formatPct(s.healthFactor)}`,
    `Adjusted collateral: $${s.adjustedCollateralUsd.toFixed(2)}`,
    `Adjusted debt: $${s.adjustedDebtUsd.toFixed(2)}`,
    `Collateral market value: $${s.collateralUsd.toFixed(2)}`,
    `Debt market value: $${s.debtUsd.toFixed(2)}`,
    '', 'Collateral:'
  ];
  if (!s.collateral.length) lines.push('  None');
  for (const a of s.collateral) {
    const liq = a.liquidationPriceUsd === undefined ? 'n/a' : `$${a.liquidationPriceUsd.toPrecision(6)} (${a.liquidationMovePct?.toFixed(2)}% from current)`;
    lines.push(`  ${a.symbol}: ${a.amount.toPrecision(6)} @ $${a.priceUsd.toPrecision(6)} | liquidation price: ${liq}`);
  }
  lines.push('', 'Debt:');
  if (!s.debt.length) lines.push('  None');
  for (const a of s.debt) lines.push(`  ${a.symbol}: ${a.amount.toPrecision(6)} @ $${a.priceUsd.toPrecision(6)}`);
  lines.push('', `Price timestamp: ${new Date(s.priceTimestamp * 1000).toISOString()}`);
  lines.push(`Margin Trading: NOT INCLUDED - ${s.margin.reason}`);
  lines.push('', 'Not financial advice. Data may lag. This monitor is read-only.');
  return lines.join('\n');
}

function alertLevel(hf: number | null, warn: number, crit: number): 'critical' | 'warning' | null {
  if (hf === null) return null;
  const pct = hf * 100;
  if (pct <= crit) return 'critical';
  if (pct <= warn) return 'warning';
  return null;
}

async function pollSubscription(sub: Subscription): Promise<void> {
  try {
    const snapshot = await fetchSnapshot(sub.account_id);
    const now = Math.floor(Date.now() / 1000);
    store.updatePoll(sub.telegram_id, snapshot.healthFactor, now);
    const level = alertLevel(snapshot.healthFactor, sub.warn_pct, sub.crit_pct);
    const last = sub.last_alert_at ?? 0;
    const cooldownPassed = now - last >= env.ALERT_COOLDOWN_MINUTES * 60;
    // Hysteresis: after an alert, don't repeat same/lower severity until HF recovers above warn+5pp.
    const recovered = snapshot.healthFactor === null || snapshot.healthFactor * 100 > sub.warn_pct + 5;
    const escalated = level === 'critical' && sub.last_alert_level !== 'critical';
    const firstAlert = level !== null && sub.last_alert_level === null;
    const sameLevelCooldown = level !== null && level === sub.last_alert_level && cooldownPassed;
    if (level && (firstAlert || escalated || sameLevelCooldown)) {
      await bot.api.sendMessage(sub.telegram_id,
        `âš ï¸ ${level.toUpperCase()} LENDING RISK ALERT\n\n${renderSnapshot(snapshot)}`);
      store.updateAlert(sub.telegram_id, level, now);
    } else if (recovered && sub.last_alert_level) {
      store.updateAlert(sub.telegram_id, null, null);
    }
    lastFailureNotice.delete(sub.telegram_id);
  } catch (error) {
    // Never translate an RPC/oracle failure into an unhealthy-position alert.
    const now = Math.floor(Date.now() / 1000);
    const lastNotice = lastFailureNotice.get(sub.telegram_id) ?? 0;
    if (now - lastNotice > 6 * 3600) {
      try { await bot.api.sendMessage(sub.telegram_id, `Risk monitor temporarily unavailable for ${sub.account_id}. No risk alert was generated because fresh data could not be verified.`); } catch { /* Telegram may be unavailable too */ }
      lastFailureNotice.set(sub.telegram_id, now);
    }
    console.error(`Poll failed for ${sub.account_id}:`, error);
  }
}

bot.use(async (ctx, next) => {
 if (ctx.chat && ctx.chat.type !== 'private' && ctx.message && 'text' in ctx.message && typeof ctx.message.text === 'string' && ctx.message.text.startsWith('/')) {
    await ctx.reply('For privacy, please use this bot in a private chat.');
    return;
  }
  await next();
});

bot.command('start', async ctx => {
  await ctx.reply(
    'Welcome to NEAR Sentinel.\n\n' +
    'Use the buttons below or the commands:\n\n' +
    '/track account.near - track a public NEAR account\n' +
    '/status - view your current position\n' +
    '/analyze - AI-powered risk analysis\n' +
    '/threshold 125 110 - configure alerts\n' +
    '/untrack - stop monitoring\n\n' +
    'Read-only. Never send a seed phrase or private key.',
    { reply_markup: mainMenu }
  );
});

bot.command('help', async ctx => {
  await ctx.reply(
    'NEAR Sentinel commands:\n\n' +
    '/track account.near\n' +
    '/status\n' +
    '/analyze\n' +
    '/threshold 125 110\n' +
    '/untrack\n\n' +
    'Default thresholds: warning 125%, critical 110%. ' +
    'Monitoring interval: 60 seconds.',
    { reply_markup: mainMenu }
  );
});

bot.command('track', async ctx => {
  const id = String(ctx.from?.id ?? '');
  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) return ctx.reply('Please wait a few seconds before trying again.');
  const accountId = (ctx.match ?? '').trim().toLowerCase();
  const parsed = accountSchema.safeParse(accountId);
  if (!parsed.success) return ctx.reply('Usage: /track account.near\nPlease provide a valid NEAR account ID.');
  try {
    await fetchSnapshot(accountId); // Validate the account and all data sources before saving.
    store.upsert(id, accountId);
    await ctx.reply(`Now tracking ${accountId}. I will check every 60 seconds.\nDefault alerts: warning at 125%, critical at 110%.\n\nNot financial advice; data may lag.`);
  } catch (error) {
    await ctx.reply(`Could not verify this position, so it was not added.\n${String(error).slice(0, 350)}`);
  }
});

bot.command('status', async ctx => {
  const id = String(ctx.from?.id ?? '');
  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) return ctx.reply('Please wait a few seconds before trying again.');
  const sub = store.get(id);
  if (!sub) return ctx.reply('You are not tracking an account. Use /track account.near.');
  try { await ctx.reply(renderSnapshot(await fetchSnapshot(sub.account_id))); }
  catch { await ctx.reply('Could not retrieve fresh, verified data. No risk assessment is available right now.'); }
});

bot.command('analyze', async ctx => {
  const id = String(ctx.from?.id ?? '');

  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) {
    return ctx.reply('Please wait a few seconds before trying again.');
  }

  if (!env.NEAR_AI_API_KEY) {
    return ctx.reply('AI analysis is not configured. Please contact the administrator.');
  }

  const sub = store.get(id);

  if (!sub) {
    return ctx.reply('You are not tracking an account. Use /track account.near first.');
  }

  await ctx.reply('NEAR Sentinel AI is analyzing your latest verified lending data. Please wait...');

  try {
    const snapshot = await fetchSnapshot(sub.account_id);
    const analysis = await analyzeRisk(
      snapshot,
      env.NEAR_AI_API_KEY,
      env.NEAR_AI_MODEL
    );

    const message = [
      'NEAR SENTINEL AI RISK ANALYSIS',
      '',
      'ASSESSMENT',
      analysis.summary,
      '',
      'KEY FINDINGS',
      ...analysis.keyFindings.map((item, index) => `${index + 1}. ${item}`),
      '',
      'RECOMMENDED ACTIONS',
      ...analysis.recommendedActions.map((item, index) => `${index + 1}. ${item}`),
      '',
      'DATA QUALITY',
      analysis.dataQuality,
      '',
      'AI-generated interpretation of verified data. Not financial advice. No transactions executed.'
    ].join('\n');

    await ctx.reply(message.slice(0, 4000));
  } catch (error) {
    console.error('AI analysis failed:', error);
    await ctx.reply(
      'NEAR Sentinel could not complete the AI analysis. Your existing risk monitoring remains active. Please try again later.'
    );
  }
});

bot.command('threshold', async ctx => {
  const id = String(ctx.from?.id ?? '');
  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) return ctx.reply('Please wait a few seconds before trying again.');
  if (!store.get(id)) return ctx.reply('Track an account first with /track account.near.');
  const parts = (ctx.match ?? '').trim().split(/\s+/).map(Number);
  const [warn, crit] = parts;
  if (
  parts.length !== 2 ||
  warn === undefined ||
  crit === undefined ||
  !Number.isFinite(warn) ||
  !Number.isFinite(crit) ||
  crit < 100 ||
  warn <= crit ||
  warn > 500
) {
    return ctx.reply('Usage: /threshold 125 110\nRequirements: 100 â‰¤ critical < warning â‰¤ 500.');
  }
  store.updateThresholds(id, warn, crit);
  await ctx.reply(`Thresholds updated: warning ${warn}%, critical ${crit}%.`);
});

bot.command('untrack', async ctx => {
  const id = String(ctx.from?.id ?? '');
  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) return ctx.reply('Please wait a few seconds before trying again.');
  store.remove(id);
  await ctx.reply('Monitoring stopped. Your subscription has been removed.');
});

bot.hears('Status 📋', async ctx => {
  const id = String(ctx.from?.id ?? '');

  if (ctx.chat.type !== 'private') {
    return ctx.reply('Please use NEAR Sentinel in a private chat.');
  }

  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) {
    return ctx.reply('Please wait a few seconds before trying again.');
  }

  const sub = store.get(id);
  if (!sub) {
    return ctx.reply('You are not tracking an account. Tap Track first.');
  }

  try {
    await ctx.reply(renderSnapshot(await fetchSnapshot(sub.account_id)));
  } catch {
    await ctx.reply('Could not retrieve fresh, verified data right now.');
  }
});

bot.hears('Analyze 🔍', async ctx => {
  const id = String(ctx.from?.id ?? '');

  if (ctx.chat.type !== 'private') {
    return ctx.reply('Please use NEAR Sentinel in a private chat.');
  }

  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) {
    return ctx.reply('Please wait a few seconds before trying again.');
  }

  if (!env.NEAR_AI_API_KEY) {
    return ctx.reply('AI analysis is not configured.');
  }

  const sub = store.get(id);
  if (!sub) {
    return ctx.reply('Track an account first using the Track button.');
  }

  await ctx.reply('NEAR Sentinel AI is analyzing your latest verified data. Please wait...');

  try {
    const snapshot = await fetchSnapshot(sub.account_id);
    const analysis = await analyzeRisk(snapshot, env.NEAR_AI_API_KEY, env.NEAR_AI_MODEL);

    const message = [
      'NEAR SENTINEL AI RISK ANALYSIS',
      '',
      'ASSESSMENT',
      analysis.summary,
      '',
      'KEY FINDINGS',
      ...analysis.keyFindings.map((item, index) => `${index + 1}. ${item}`),
      '',
      'RECOMMENDED ACTIONS',
      ...analysis.recommendedActions.map((item, index) => `${index + 1}. ${item}`),
      '',
      'DATA QUALITY',
      analysis.dataQuality,
      '',
      'AI-generated interpretation of verified data. Not financial advice. No transactions executed.'
    ].join('\n');

    await ctx.reply(message.slice(0, 4000));
  } catch (error) {
    console.error('AI analysis failed:', error);
    await ctx.reply('AI analysis could not be completed. Your monitoring remains active.');
  }
});

bot.hears('Stop tracking 🛑', async ctx => {
  const id = String(ctx.from?.id ?? '');

  if (ctx.chat.type !== 'private') {
    return ctx.reply('Please use NEAR Sentinel in a private chat.');
  }

  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) {
    return ctx.reply('Please wait a few seconds before trying again.');
  }

  pendingInput.delete(id);
  store.remove(id);

  await ctx.reply('Monitoring stopped. Your subscription has been removed.');
});

bot.hears('Track 📊', async ctx => {
  const id = String(ctx.from?.id ?? '');
  pendingInput.set(id, 'track');
  await ctx.reply('Send the NEAR account ID you want to monitor, for example: krhuize.tg');
});

bot.hears('Threshold ⚙️', async ctx => {
  const id = String(ctx.from?.id ?? '');

  if (!store.get(id)) {
    return ctx.reply('Track an account first before changing alert thresholds.');
  }

  pendingInput.set(id, 'threshold');
  await ctx.reply('Send your warning and critical thresholds, separated by a space. Example: 125 110');
});

bot.on('message:text', async ctx => {
  const id = String(ctx.from?.id ?? '');
  const action = pendingInput.get(id);

  if (!action || ctx.message.text.startsWith('/')) return;

  if (!store.allowRequest(id, env.RATE_LIMIT_SECONDS)) {
    return ctx.reply('Please wait a few seconds before trying again.');
  }

  pendingInput.delete(id);

  if (action === 'track') {
    const accountId = ctx.message.text.trim().toLowerCase();
    const parsed = accountSchema.safeParse(accountId);

    if (!parsed.success) {
      return ctx.reply('Invalid NEAR account ID. Tap Track again and try another account ID.');
    }

    try {
      await fetchSnapshot(accountId);
      store.upsert(id, accountId);
      await ctx.reply(
        `Now tracking ${accountId}. Monitoring runs every 60 seconds.\\nWarning: 125%. Critical: 110%.`
      );
    } catch {
      await ctx.reply('Could not verify this position, so it was not added. Please check the account and try again.');
    }

    return;
  }

  const parts = ctx.message.text.trim().split(/\s+/).map(Number);

if (
  parts.length !== 2 ||
  !Number.isFinite(parts[0]) ||
  !Number.isFinite(parts[1])
) {
  return ctx.reply('Invalid thresholds. Tap Threshold again and enter two numbers, such as 125 110.');
}

const warn = parts[0]!;
const crit = parts[1]!;

if (crit < 100 || warn <= crit || warn > 500) {
  return ctx.reply('Invalid thresholds. Warning must be greater than critical, and cannot exceed 500.');
}

store.updateThresholds(id, warn, crit);
  await ctx.reply(`Thresholds updated: warning ${warn}%, critical ${crit}%.`);
});

  const app = express();
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
const ipRequests = new Map<string, { count: number; reset: number }>();
app.post('/api/status', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const bucket = ipRequests.get(ip);
  if (bucket && now < bucket.reset && bucket.count >= 10) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  if (!bucket || now >= bucket.reset) ipRequests.set(ip, { count: 1, reset: now + 60_000 });
  else bucket.count++;
  const accountId = String(req.body?.accountId ?? '').trim().toLowerCase();
  const parsed = accountSchema.safeParse(accountId);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid NEAR account ID.' });
  try { return res.json(await fetchSnapshot(accountId)); }
  catch (error) { return res.status(503).json({ error: `Fresh data could not be verified: ${String(error).slice(0, 180)}` }); }
});

const aiRequests = new Map<string, { count: number; reset: number }>();

app.post('/api/analyze', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const bucket = aiRequests.get(ip);

  if (bucket && now < bucket.reset && bucket.count >= 3) {
    return res.status(429).json({
      error: 'AI analysis limit reached. Try again in a minute.'
    });
  }

  if (!bucket || now >= bucket.reset) {
    aiRequests.set(ip, { count: 1, reset: now + 60_000 });
  } else {
    bucket.count++;
  }

  const accountId = String(req.body?.accountId ?? '')
    .trim()
    .toLowerCase();

  const parsed = accountSchema.safeParse(accountId);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Enter a valid NEAR account ID.'
    });
  }

  if (!env.NEAR_AI_API_KEY) {
    return res.status(503).json({
      error: 'AI analysis is currently unavailable.'
    });
  }

  try {
    const snapshot = await fetchSnapshot(accountId);

    const analysis = await analyzeRisk(
      snapshot,
      env.NEAR_AI_API_KEY,
      env.NEAR_AI_MODEL
    );

    return res.json({
      accountId,
      analysis
    });
  } catch (error) {
    console.error('Website AI analysis failed:', error);

    return res.status(503).json({
      error: 'AI analysis could not be completed. Please try again later.'
    });
  }
});

const telegramBotUrl = 'https://t.me/thenearsentinelbot';

console.log('Telegram bot link configured.');

app.get('/api/config', (_req, res) => {
  res.json({ telegramBotUrl });
});

app.listen(env.PORT, env.HOST, () => console.log(`Risk monitor web listening on http://${env.HOST}:${env.PORT}`));
let pollingInProgress = false;

cron.schedule(`*/${Math.max(1, Math.floor(env.POLL_SECONDS / 60))} * * * *`, async () => {
  if (pollingInProgress) {
    console.warn('Previous monitoring cycle is still running. Skipping this cycle.');
    return;
  }

  pollingInProgress = true;

  try {
    const subscriptions = store.all();
let nextIndex = 0;

const workers = Array.from(
  { length: Math.min(3, subscriptions.length) },
  async () => {
    while (nextIndex < subscriptions.length) {
      const index = nextIndex++;
      const sub = subscriptions[index];

      if (sub) {
        await pollSubscription(sub);
      }
    }
  }
);

await Promise.all(workers);
  } catch (error) {
    console.error('Monitoring cycle failed:', error);
  } finally {
    pollingInProgress = false;
  }
});

bot.api.setMyCommands([
  { command: 'start', description: 'Open NEAR Sentinel menu' },
  { command: 'help', description: 'Show available commands' },
  { command: 'track', description: 'Track a NEAR account' },
  { command: 'status', description: 'View current lending risk' },
  { command: 'analyze', description: 'Run AI risk analysis' },
  { command: 'threshold', description: 'Configure risk alert thresholds' },
  { command: 'untrack', description: 'Stop monitoring' }
]).catch(error => console.error('Could not register Telegram commands:', error));

bot.start();
console.log('Telegram bot started. Read-only mode; no signing or transaction code is included.');
