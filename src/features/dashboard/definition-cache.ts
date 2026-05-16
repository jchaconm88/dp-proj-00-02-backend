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
async function loadMetricsWithCache(
  db: FirebaseFirestore.Firestore
): Promise<MetricDefinition[]> {
  const now = Date.now();
  const cache = metricsCache;

  if (cache && now - cache.loadedAt < CACHE_TTL) {
    return cache.data;
  }

  if (cache?.inflight) {
    return cache.inflight;
  }

  const promise = listMergedMetrics(db).then((merged) => merged.map((m) => m.data));

  if (cache) {
    cache.inflight = promise;
  }

  try {
    const data = await promise;
    const entry: CacheEntry<MetricDefinition> = { data, loadedAt: Date.now(), inflight: null };
    metricsCache = entry;
    return data;
  } catch (error) {
    if (cache) {
      cache.inflight = null;
    }
    throw error;
  }
}

async function loadCardsWithCache(
  db: FirebaseFirestore.Firestore
): Promise<CardDefinition[]> {
  const now = Date.now();
  const cache = cardsCache;

  if (cache && now - cache.loadedAt < CACHE_TTL) {
    return cache.data;
  }

  if (cache?.inflight) {
    return cache.inflight;
  }

  const promise = listMergedCards(db).then((merged) => merged.map((m) => m.data));

  if (cache) {
    cache.inflight = promise;
  }

  try {
    const data = await promise;
    const entry: CacheEntry<CardDefinition> = { data, loadedAt: Date.now(), inflight: null };
    cardsCache = entry;
    return data;
  } catch (error) {
    if (cache) {
      cache.inflight = null;
    }
    throw error;
  }
}

async function loadChartsWithCache(
  db: FirebaseFirestore.Firestore
): Promise<ChartDefinition[]> {
  const now = Date.now();
  const cache = chartsCache;

  if (cache && now - cache.loadedAt < CACHE_TTL) {
    return cache.data;
  }

  if (cache?.inflight) {
    return cache.inflight;
  }

  const promise = listMergedCharts(db).then((merged) => merged.map((m) => m.data));

  if (cache) {
    cache.inflight = promise;
  }

  try {
    const data = await promise;
    const entry: CacheEntry<ChartDefinition> = { data, loadedAt: Date.now(), inflight: null };
    chartsCache = entry;
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
  return loadMetricsWithCache(db);
}

export async function getCardsFromCache(
  db: FirebaseFirestore.Firestore
): Promise<CardDefinition[]> {
  return loadCardsWithCache(db);
}

export async function getChartsFromCache(
  db: FirebaseFirestore.Firestore
): Promise<ChartDefinition[]> {
  return loadChartsWithCache(db);
}

/**
 * Invalidates all three cache entries, forcing a reload on next access.
 */
export function invalidateCache(): void {
  metricsCache = null;
  cardsCache = null;
  chartsCache = null;
}
