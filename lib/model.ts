// The token radar's value model and board builder.
//
// The model is deliberately narrow. A protocol's implied value is its TVL multiplied by five
// transparent factors, each derived from the sealed snapshot and none from a hand-kept list of names:
//
//   implied = round( tvl_usd
//                  * category_multiple      // median market-cap / TVL of live protocols in the category
//                  * PRETOKEN_DISCOUNT      // 0.55: launch, liquidity and execution risk
//                  * growth_multiplier      // 7-day TVL change, clamped and damped
//                  * tenure_multiplier      // how long it has run with no token
//                  * chain_multiplier )     // depth and breadth of its chains
//
// The category multiple is learned from the snapshot itself: for every protocol that already records
// a token and a market cap, mcap_usd / tvl_usd is one comparable. A category with at least three
// comparables uses its own median, shrunk nowhere; a thinner category inherits the global median, so
// one noisy token cannot define a category. The result is clamped to 0.05..0.45.
//
// The other factors:
//   growth: clamp(change_7d, -50, +100) per cent, passed through at 30%  -> 0.85x .. 1.30x
//   tenure: a curve over the days since DefiLlama began tracking the protocol (the only age record the
//           snapshot carries), with a two-year sweet spot; unknown listing dates take 0.85x
//   chain:  sum of snapshot TVL on each chain, log-scaled to 0..1; 0.94 + 0.12 * best + 0.008 per
//           extra chain above the median depth, capped at 1.10
//
// Nothing here predicts whether or when a protocol issues a token. It answers a narrower question:
// if this protocol's record stayed as it is, what would a token claim be worth, and how should a
// reader farm it before a launch? A protocol that records no token is described exactly that way.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One category's learned multiple, with the sample it came from. */
export interface CategoryProfile {
  key: string;
  n: number;
  median: number | null;
  multiple: number;
  source: 'category' | 'global';
}

/** One chain's depth, and the 0..1 score the chain multiplier reads. */
export interface ChainProfile {
  chain: string;
  tvl_usd: number;
  score: number;
}

/** The model's constants and learned tables: everything the dashboard needs to explain a row. */
export interface ModelContext {
  name: string;
  version: string;
  formula: string;
  global_multiple: number;
  global_sample: number;
  category_min_sample: number;
  category_floor: number;
  category_cap: number;
  pretoken_discount: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  tenure_curve: Array<{ days: number; multiple: number }>;
  tenure_unknown: number;
  chain_floor: number;
  chain_range: number;
  chain_bonus: number;
  chain_bonus_min_score: number;
  chain_extra_max: number;
  chain_cap: number;
  ratio_floor: number;
  ratio_cap: number;
  categories: CategoryProfile[];
  chains: ChainProfile[];
}

/** Why a row is where it is, in the model's own words. */
export interface RowModel {
  category_key: string;
  category_multiple: number;
  category_source: 'category' | 'global';
  category_sample: number;
  pretoken_discount: number;
  growth_pct: number;
  growth_multiplier: number;
  tenure_multiplier: number;
  chain_multiplier: number;
  chain_best: string | null;
  chain_best_score: number;
  chain_count: number;
  age_days: number | null;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  category_key: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  below_floor: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: RowModel;
  why: string;
  farm_steps: string[];
}

/** A live-token protocol: its market cap is a fact, not a model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  ratio: number;
}

/** The compact row the dashboard renders (board.json keeps the same fields and the plan). */
export interface RadarRow extends BoardRow {}

/** Everything the dashboard renders, written to data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelContext;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  live_with_mcap: number;
  protocol_count: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label, shown on the page and quoted in the source. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar may add. */
export const EARLY_LIMIT = 220;

/** The base constants. Everything that changes a rank is here or learned in buildModelContext. */
export const BASE_CONSTANTS = {
  PRETOKEN_DISCOUNT: 0.55,
  GROWTH_WEIGHT: 0.3,
  GROWTH_FLOOR: -50,
  GROWTH_CAP: 100,
  CATEGORY_MIN_SAMPLE: 3,
  CATEGORY_FLOOR: 0.05,
  CATEGORY_CAP: 0.45,
  RATIO_FLOOR: 0.005,
  RATIO_CAP: 10,
  TENURE_UNKNOWN: 0.85,
  CHAIN_FLOOR: 0.94,
  CHAIN_RANGE: 0.12,
  CHAIN_BONUS: 0.008,
  CHAIN_BONUS_MIN_SCORE: 0.5,
  CHAIN_EXTRA_MAX: 5,
  CHAIN_CAP: 1.1,
};

/**
 * The tenure curve: days since DefiLlama began tracking the protocol -> multiplier.
 * The peak sits at two years. A very new listing is unproven; a very old one has had more chances
 * to launch and its urgency decays. Points are linearly interpolated; beyond the last, it is flat.
 */
export const TENURE_CURVE: Array<{ days: number; multiple: number }> = [
  { days: 0, multiple: 0.6 },
  { days: 90, multiple: 0.8 },
  { days: 730, multiple: 1.15 },
  { days: 1460, multiple: 1.08 },
  { days: 1825, multiple: 1.05 },
  { days: 3650, multiple: 1.0 },
];

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Exchange-branded products are not independent pre-token protocols. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
/** A wrapped or staked product is not a token waiting to be born. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** The categories the house watchlist treats as products of a token that already trades. */
const PRODUCT_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The middle of a list (the mean of the two middles when even), or null for an empty list. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records a token: either DefiLlama field is enough. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Whether a protocol records no token at all: the board's subject. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Retained for callers that used the starter's name: a protocol that records no token. */
export const isPreToken = recordsNoToken;

/**
 * Whether a pre-token protocol is an independent subject rather than a wrapped, staked, bridged,
 * versioned or exchange-branded product. This is the same screen the house applied above the floor;
 * below the floor the entry applies it itself so the early radar does not rank a product as a launch.
 */
export function isIndependentPreToken(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return true;
}

/** A protocol's display category key: null becomes Other. */
export function categoryKey(p: SnapshotProtocol): string {
  return p.category ?? 'Other';
}

/**
 * Learn the model's tables from the snapshot:
 * - the global market-cap / TVL median of protocols that already record a token and a market cap;
 * - per-category medians when the category has at least three such comparables;
 * - each chain's total snapshot TVL and a log-scaled depth score.
 */
export function buildModelContext(snapshot: Snapshot): ModelContext {
  const live = snapshot.protocols
    .filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .map((p) => ({ protocol: p, ratio: (p.mcap_usd as number) / p.tvl_usd }))
    .filter((x) => x.ratio >= BASE_CONSTANTS.RATIO_FLOOR && x.ratio <= BASE_CONSTANTS.RATIO_CAP);
  const globalMultiple = median(live.map((x) => x.ratio)) ?? 0.25;

  const byCategory = new Map<string, number[]>();
  for (const x of live) {
    const key = categoryKey(x.protocol);
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [x.ratio]);
    else list.push(x.ratio);
  }
  const categories: CategoryProfile[] = [...byCategory.entries()]
    .map(([key, ratios]) => {
      const own = median(ratios);
      const useOwn = ratios.length >= BASE_CONSTANTS.CATEGORY_MIN_SAMPLE && own !== null;
      const multiple = Math.min(
        BASE_CONSTANTS.CATEGORY_CAP,
        Math.max(BASE_CONSTANTS.CATEGORY_FLOOR, useOwn ? (own as number) : globalMultiple),
      );
      return {
        key,
        n: ratios.length,
        median: own,
        multiple,
        source: useOwn ? ('category' as const) : ('global' as const),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const chainDepth = new Map<string, number>();
  for (const p of snapshot.protocols) {
    for (const chain of p.chains) chainDepth.set(chain, (chainDepth.get(chain) ?? 0) + p.tvl_usd);
  }
  const depths = [...chainDepth.values()].filter((v) => v > 0);
  const minLog = depths.length > 0 ? Math.log1p(Math.min(...depths)) : 0;
  const maxLog = depths.length > 0 ? Math.log1p(Math.max(...depths)) : 1;
  const span = maxLog - minLog > 0 ? maxLog - minLog : 1;
  const chains: ChainProfile[] = [...chainDepth.entries()]
    .map(([chain, tvl]) => ({ chain, tvl_usd: tvl, score: (Math.log1p(tvl) - minLog) / span }))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));

  return {
    name: 'Radar 2',
    version: MODEL_VERSION,
    formula:
      'implied = round(tvl_usd * category_multiple * pretoken_discount * growth_multiplier * tenure_multiplier * chain_multiplier)',
    global_multiple: round6(globalMultiple),
    global_sample: live.length,
    category_min_sample: BASE_CONSTANTS.CATEGORY_MIN_SAMPLE,
    category_floor: BASE_CONSTANTS.CATEGORY_FLOOR,
    category_cap: BASE_CONSTANTS.CATEGORY_CAP,
    pretoken_discount: BASE_CONSTANTS.PRETOKEN_DISCOUNT,
    growth_weight: BASE_CONSTANTS.GROWTH_WEIGHT,
    growth_floor: BASE_CONSTANTS.GROWTH_FLOOR,
    growth_cap: BASE_CONSTANTS.GROWTH_CAP,
    tenure_curve: TENURE_CURVE,
    tenure_unknown: BASE_CONSTANTS.TENURE_UNKNOWN,
    chain_floor: BASE_CONSTANTS.CHAIN_FLOOR,
    chain_range: BASE_CONSTANTS.CHAIN_RANGE,
    chain_bonus: BASE_CONSTANTS.CHAIN_BONUS,
    chain_bonus_min_score: BASE_CONSTANTS.CHAIN_BONUS_MIN_SCORE,
    chain_extra_max: BASE_CONSTANTS.CHAIN_EXTRA_MAX,
    chain_cap: BASE_CONSTANTS.CHAIN_CAP,
    ratio_floor: BASE_CONSTANTS.RATIO_FLOOR,
    ratio_cap: BASE_CONSTANTS.RATIO_CAP,
    categories,
    chains,
  };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The category's learned multiple, or the global one when the category has no profile. */
export function categoryMultiple(context: ModelContext, key: string): CategoryProfile {
  return (
    context.categories.find((c) => c.key === key) ?? {
      key,
      n: 0,
      median: null,
      multiple: context.global_multiple,
      source: 'global',
    }
  );
}

/** The tenure multiplier at a given age, linearly interpolated through TENURE_CURVE. */
export function tenureMultiplier(age: number | null): number {
  if (age === null) return BASE_CONSTANTS.TENURE_UNKNOWN;
  const d = Math.max(0, age);
  const first = TENURE_CURVE[0]!;
  if (d <= first.days) return first.multiple;
  for (let i = 1; i < TENURE_CURVE.length; i++) {
    const before = TENURE_CURVE[i - 1]!;
    const after = TENURE_CURVE[i]!;
    if (d <= after.days) {
      const t = (d - before.days) / (after.days - before.days);
      return before.multiple + (after.multiple - before.multiple) * t;
    }
  }
  return TENURE_CURVE[TENURE_CURVE.length - 1]!.multiple;
}

/** The growth multiplier: clamp the seven-day change, then pass through at 30%. */
export function growthMultiplier(change7d: number | null): { pct: number; multiplier: number } {
  if (change7d === null) return { pct: 0, multiplier: 1 };
  const pct = Math.min(BASE_CONSTANTS.GROWTH_CAP, Math.max(BASE_CONSTANTS.GROWTH_FLOOR, change7d));
  return { pct, multiplier: 1 + (pct / 100) * BASE_CONSTANTS.GROWTH_WEIGHT };
}

/** The chain multiplier: the deepest chain's score plus a small breadth bonus. */
export function chainMultiplier(
  p: SnapshotProtocol,
  context: ModelContext,
): { multiplier: number; best: string | null; bestScore: number; extra: number } {
  const profiles = p.chains
    .map((chain) => ({ chain, score: context.chains.find((c) => c.chain === chain)?.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
  if (profiles.length === 0) return { multiplier: BASE_CONSTANTS.CHAIN_FLOOR, best: null, bestScore: 0, extra: 0 };
  const best = profiles[0]!;
  const extra = profiles.filter((x, i) => i > 0 && x.score >= BASE_CONSTANTS.CHAIN_BONUS_MIN_SCORE).length;
  const bonus = Math.min(BASE_CONSTANTS.CHAIN_EXTRA_MAX, extra) * BASE_CONSTANTS.CHAIN_BONUS;
  const multiplier = Math.min(
    BASE_CONSTANTS.CHAIN_CAP,
    BASE_CONSTANTS.CHAIN_FLOOR + BASE_CONSTANTS.CHAIN_RANGE * best.score + bonus,
  );
  return { multiplier, best: best.chain, bestScore: best.score, extra };
}

/** The three multipliers and the implied value one protocol gets. */
export interface ImpliedValue {
  implied: number;
  age: number | null;
  category: CategoryProfile;
  growthPct: number;
  growthMult: number;
  tenureMult: number;
  chainMult: number;
  chainBest: string | null;
  chainBestScore: number;
  chainExtra: number;
  raw: number;
}

/** Score one protocol with the context's learned tables. */
export function impliedValue(p: SnapshotProtocol, asOf: string, context: ModelContext): ImpliedValue {
  const age = ageDays(asOf, p.listed_at);
  const key = categoryKey(p);
  const category = categoryMultiple(context, key);
  const growth = growthMultiplier(p.change_7d);
  const tenureMult = tenureMultiplier(age);
  const chain = chainMultiplier(p, context);
  const raw =
    p.tvl_usd * category.multiple * context.pretoken_discount * growth.multiplier * tenureMult * chain.multiplier;
  return {
    implied: Math.max(1, Math.round(raw)),
    age,
    category,
    growthPct: growth.pct,
    growthMult: growth.multiplier,
    tenureMult,
    chainMult: chain.multiplier,
    chainBest: chain.best,
    chainBestScore: chain.bestScore,
    chainExtra: chain.extra,
    raw,
  };
}

/** A sane, exact dollar string for the model's own prose (not the page's short form). */
function usdText(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** 1 -> 1st, 2 -> 2nd, 12 -> 12th. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  return `${n}${mod10 === 1 ? 'st' : mod10 === 2 ? 'nd' : mod10 === 3 ? 'rd' : 'th'}`;
}

/**
 * The row's own explanation, built from the same factors the model used. It names the largest driver,
 * the category's sample, the clamped growth, the tenure and the chain breadth.
 */
export function whyRank(row: BoardRow, tvlRank: number, boardSize: number): string {
  const m = row.model;
  const cat = row.category ?? 'This category';
  const catText =
    m.category_source === 'category'
      ? `${cat} has ${m.category_sample} live comparables, so the model uses their own median multiple of ${m.category_multiple.toFixed(3)}.`
      : `${cat} has ${m.category_sample} live comparable${m.category_sample === 1 ? '' : 's'}, below the ${BASE_CONSTANTS.CATEGORY_MIN_SAMPLE} needed for its own median, so the global ${m.category_multiple.toFixed(3)} multiple applies.`;
  const ageText =
    m.age_days === null
      ? `Its listing date is not recorded, so the model applies the neutral ${m.tenure_multiplier.toFixed(2)} tenure multiplier.`
      : `${m.age_days} days without a token gives the ${m.tenure_multiplier.toFixed(2)} tenure multiplier.`;
  const growthText =
    row.change_7d === null
      ? 'No seven-day change is reported, so growth is neutral.'
      : `The seven-day change is ${row.change_7d.toFixed(2)}%, clamped to ${m.growth_pct.toFixed(2)}% and passed through at ${m.growth_multiplier.toFixed(3)}.`;
  const chainText =
    m.chain_best === null
      ? `No chain is recorded, so the chain multiplier is ${m.chain_multiplier.toFixed(3)}.`
      : `Its deepest chain is ${m.chain_best} (depth score ${m.chain_best_score.toFixed(2)}), and ${m.chain_count} chain${m.chain_count === 1 ? '' : 's'} ${m.chain_count === 1 ? 'gives' : 'give'} the ${m.chain_multiplier.toFixed(3)} chain multiplier.`;
  return `Rank ${row.rank} of ${boardSize}. TVL of ${usdText(row.tvl_usd)} is the ${ordinal(tvlRank)} largest on the board. ${catText} ${ageText} ${growthText} ${chainText}`;
}

/** A farm step as the one string board.json carries: action, cost and time inside the gate's limits. */
export function stepText(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 50;
  return 25;
}

/** How long to hold, from the protocol's tracking age: younger protocols need a longer record. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 90) return 90;
  if (age < 365) return 60;
  if (age < 1095) return 45;
  return 30;
}

/** A rough fee band for the chain, so every plan states a real cost rather than "gas". */
function gasBand(chain: string): string {
  if (chain === 'Ethereum') return '$8-$20';
  if (chain === 'Bitcoin') return '$2-$8';
  const veryCheap = new Set(['Solana', 'Sui', 'Aptos', 'Tron', 'Binance', 'Monad', 'Hyperliquid L1', 'Plasma']);
  if (veryCheap.has(chain)) return '$0.01-$0.50';
  const cheap = new Set([
    'Arbitrum',
    'Optimism',
    'Base',
    'Polygon',
    'Scroll',
    'Linea',
    'zkSync Era',
    'Mantle',
    'Blast',
    'Mode',
    'Sonic',
    'Berachain',
    'Unichain',
    'Ink',
    'Avalanche',
    'Celo',
    'Gnosis',
  ]);
  if (cheap.has(chain)) return '$0.10-$1.50';
  return '$1-$4';
}

/** The category's one main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name}'s ${chain} market, then borrow no more than 25% of it against the position and keep the health factor above 2.0.`;
  }
  if (c.includes('dex') || c.includes('leveraged farm')) {
    return `Provide $${capital} of liquidity to ${name}'s deepest ${chain} pool after checking its TVL and 24-hour volume, and stake the LP receipt if the protocol offers staking.`;
  }
  if (c.includes('restak') || c.includes('staking') || c.includes('liquid staking')) {
    return `Stake $${capital} of ${chain}'s native asset through ${name}, keep the liquid receipt, and confirm the validator or operator set before you sign.`;
  }
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('farm')) {
    return `Deposit $${capital} of USDC into ${name}'s flagship ${chain} vault, confirm its fee and lockup, and keep the receipt token in the same wallet.`;
  }
  if (c.includes('rwa')) {
    return `Mint or subscribe $${capital} of ${name}'s ${chain} yield asset, confirm the redemption window and the issuer, and hold the receipt.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} of USDC as collateral on ${name}, open a small basis position (long spot against a short perpetual), and keep the hedge within 1.2x.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name}, open one small hedged position, and keep leverage below 2x.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} for ${chain}'s main asset, read the waiting period and exclusions, and keep the certificate.`;
  }
  if (c.includes('payment')) {
    return `Route $${capital} of USDC through ${name} to a second wallet you control, confirm settlement, and keep the receipt.`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}'s official gateway, swap half into the chain's gas token, and keep both balances active.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}, confirm the collateral ratio, and keep the position open.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and place one small market position on ${name}, then keep the position open through the hold window.`;
  }
  if (c.includes('index')) {
    return `Mint $${capital} of ${name}'s ${chain} index receipt, confirm its constituents and rebalance rule, and hold it.`;
  }
  if (c.includes('liquidity manager')) {
    return `Deposit $${capital} of USDC into a ${name}-managed ${chain} vault, confirm the manager and its fee, and keep the shares.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain}, confirm the position is visible in the app, and keep the receipt.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written name list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, preferredChain?: string | null): string[] {
  const chain = preferredChain ?? chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const gas = gasBand(chain);
  const action = actionFor(p, capital, chain);
  const onboard =
    chain === 'Ethereum'
      ? `Keep at least ${gas} of ETH in the wallet for the deposit and the exit; if the wallet was funded in ETH, swap only the $${capital} you plan to deposit into USDC.`
      : chain === 'Solana'
        ? `Send $${capital} of USDC to the wallet over Solana and keep 0.05 SOL for fees and token accounts.`
        : `Bridge $${capital} of USDC to ${chain} with the chain's official bridge or a canonical pool, and check the fee before signing.`;
  return [
    stepText(
      `Set up a fresh wallet for this farm only, write its seed phrase offline, and fund it with $${capital} of USDC plus ${gas} for fees on ${chain}.`,
      `$${capital} capital + ${gas} gas`,
      '10 minutes',
    ),
    stepText(
      onboard,
      chain === 'Ethereum' ? `$0 extra if the wallet holds ETH; otherwise $1-$8 swap fee + ${gas} gas` : `$1-$8 bridge or swap fee + ${gas} gas`,
      chain === 'Ethereum' ? '5-10 minutes' : '10-20 minutes',
    ),
    stepText(action, `$${capital} capital + ${gas} gas`, '15-30 minutes'),
    stepText(
      `Make one qualifying action each week for ${weeks} weeks: a small deposit, borrow, swap or governance vote on ${p.name}; vary the amount and the action so it reads as real use.`,
      '$2-$6 gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Keep the position open for at least ${hold} days, across at least two of the protocol's own reporting snapshots, and do not move it to a fresh wallet before the hold ends.`,
      `$${capital} stays deposited; opportunity cost only`,
      `${hold} days`,
    ),
    stepText(
      `Check ${p.name}'s official site and social account once a week for a points, quest or claim page; never pay a fee and never sign a claim that arrives by direct message.`,
      '$0 to check; never pay to claim',
      '5 minutes a week',
    ),
    stepText(
      `Log the wallet, dates, transactions and the vault or pool address; write the exit plan before depositing, with two withdrawal steps and ${gas} kept for the second transaction.`,
      '$0',
      '10 minutes',
    ),
  ];
}

/** The live-token protocols with a recorded market cap: the comparables behind the category multiples. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      ratio: (p.mcap_usd as number) / p.tvl_usd,
    }));
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The ranked board: every watchlist slug, plus every independent pre-token protocol below the floor.
 * Above the floor the house's watchlist is the screen; below it the entry applies the same product
 * screen itself. The two sets never overlap, and a watchlist slug is never dropped.
 */
export function buildBoard(snapshot: Snapshot, context: ModelContext): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isIndependentPreToken(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_LIMIT);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, context) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const tvlOrder = scored
    .slice()
    .sort((a, b) => b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const tvlRank = new Map<string, number>(tvlOrder.map((x, i) => [x.p.slug, i + 1]));
  const watch = new Set(snapshot.watchlist);

  return scored.map(({ p, v }, i) => {
    const row: BoardRow = {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      category_key: v.category.key,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token',
      watchlist: watch.has(p.slug),
      below_floor: p.tvl_usd < snapshot.floor_usd,
      age_days: v.age,
      implied_value_usd: v.implied,
      model: {
        category_key: v.category.key,
        category_multiple: v.category.multiple,
        category_source: v.category.source,
        category_sample: v.category.n,
        pretoken_discount: context.pretoken_discount,
        growth_pct: v.growthPct,
        growth_multiplier: v.growthMult,
        tenure_multiplier: v.tenureMult,
        chain_multiplier: v.chainMult,
        chain_best: v.chainBest,
        chain_best_score: v.chainBestScore,
        chain_count: p.chains.length,
        age_days: v.age,
      },
      why: '',
      farm_steps: farmSteps(p, v.age, v.chainBest ?? (p.chains[0] ?? null)),
    };
    row.why = whyRank(row, tvlRank.get(p.slug) ?? 0, scored.length);
    return row;
  });
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const context = buildModelContext(snapshot);
  const board = buildBoard(snapshot, context);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const liveWithMcap = snapshot.protocols.filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0).length;
  const categoriesOnBoard = new Set(board.map((r) => r.category_key));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: { ...context, chains: context.chains.slice(0, 24), categories: context.categories.filter((c) => categoriesOnBoard.has(c.key)) },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    live_with_mcap: liveWithMcap,
    protocol_count: snapshot.protocols.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. Mirrors the gate's own rows. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, not 100 to 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears more than once';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const invented = board.filter((r) => !known.has(r.slug));
  if (invented.length > 0) return `the board names ${invented.length} slug(s) the snapshot does not list: ${invented.slice(0, 3).map((r) => r.slug).join(', ')}`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
