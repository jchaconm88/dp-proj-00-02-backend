import type { firestore as FirebaseFirestore } from "firebase-admin";
import { listMergedMetrics, listMergedCards, listMergedCharts } from "./dashboard-catalog.service.js";
import type {
  MetricDefinition,
  CardDefinition,
  ChartDefinition,
  CacheEntry,
} from "./dashboard.types.js";

const CACHE_TTL = 300_000; // 5 minutes

// ─── Cache state ──────────────────────────────────────────────────────────────

let metricsCache: CacheEntry<MetricDefinition> | null = null;
let cardsCache: CacheEntry<CardDefinition> | null = null;
let chartsCache: CacheEntry<ChartDefinition> | null = null;

// ─── Generic cache loader with coalescing ─────────────────────────────────────

async function loadWithCache<T>(
  cache: CacheEntry<T> | null,
  loader: (db: FirebaseFirestore.Firestore) => Promise<Array<{ data: T }>>,
  db: FirebaseFirestore.Firestore
): Promise<T[]> {
  const now = Date.now();

  if (cache && now - cache.loadedAt < CACHE_TTL) {
    return cache.data;
  }

  if (cache?.inflight) {
    return cache.inflight;
  }

  const promise = loader(db).then((merged) => merged.map((m) => m.data));

  if (cache) {
    cache.inflight = promise;
  }

  try {
    const data = await promise;
    const entry: CacheEntry<T> = { data, loadedAt: Date.now(), inflight: null };
    if (cache === metricsCache) metricsCache = entry;
    else if (cache === cardsCache) cardsCache = entry;
    else if (cache === chartsCache) chartsCache = entry;
    return data;
  } catch (error) {
    if (cache) {
      cache.inflight = null;
    }
    throw error;
  }
}

// ─── Public cache accessors ───────────────────────────────────────────────────

export async function getMetricsFromCache(
  db: FirebaseFirestore.Firestore
): Promise<MetricDefinition[]> {
  return loadWithCache(metricsCache, (d) => listMergedMetrics(d as any), db);
}

export async function getCardsFromCache(
  db: FirebaseFirestore.Firestore
): Promise<CardDefinition[]> {
  return loadWithCache(cardsCache, (d) => listMergedCards(d as any), db);
}

export async function getChartsFromCache(
  db: FirebaseFirestore.Firestore
): Promise<ChartDefinition[]> {
  return loadWithCache(chartsCache, (d) => listMergedCharts(d as any), db);
}

/**
 * Invalidates all three cache entries, forcing a reload on next access.
 */
export function invalidateCache(): void {
  metricsCache = null;
  cardsCache = null;
  chartsCache = null;
}
