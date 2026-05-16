import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type { TenantStats } from "./dashboard.types.js";
import { listMergedMetrics } from "./dashboard-catalog.service.js";

const COLLECTION = "tenant-stats";

/**
 * Builds the tenant-stats document ID.
 * Format: `{accountId}_{companyId}` or `{accountId}___` if no companyId.
 */
function buildDocId(accountId: string, companyId?: string): string {
  return companyId ? `${accountId}_${companyId}` : `${accountId}___`;
}

async function computeEntityCount(
  db: FirebaseFirestore.Firestore,
  collectionName: string,
  accountId: string
): Promise<number> {
  const snap = await db
    .collection(collectionName)
    .where("accountId", "==", accountId)
    .get();
  return snap.size;
}

async function computeSum(
  db: FirebaseFirestore.Firestore,
  collectionName: string,
  fieldName: string,
  accountId: string
): Promise<number> {
  const snap = await db
    .collection(collectionName)
    .where("accountId", "==", accountId)
    .get();
  let total = 0;
  snap.forEach((doc) => {
    const val = Number(doc.data()?.[fieldName] ?? 0);
    if (!isNaN(val)) total += val;
  });
  return total;
}

/**
 * Recalculates all counters for a tenant by querying source collections.
 * Handles entityCount (count) and sum (field sum) metric types.
 * Custom/ratio metric types are derived later in the compose step.
 */
export async function recalculate(
  db: FirebaseFirestore.Firestore,
  params: { accountId: string; companyId?: string }
): Promise<TenantStats> {
  const { accountId, companyId } = params;
  const docId = buildDocId(accountId, companyId);
  const docRef = db.collection(COLLECTION).doc(docId);

  // Get all active metric definitions
  const mergedMetrics = await listMergedMetrics(db);
  const activeMetrics = mergedMetrics
    .map((m) => m.data)
    .filter((m) => m.active && m.source?.collectionName);

  const counters: Record<string, number> = {};

  const countQueries = activeMetrics
    .filter(
      (m) =>
        m.type === "entityCount" &&
        m.source.deltaType === "count"
    )
    .map(async (m) => {
      const value = await computeEntityCount(db, m.source.collectionName, accountId);
      return { key: m.metricKey, value };
    });

  const sumQueries = activeMetrics
    .filter(
      (m) =>
        m.type === "sum" &&
        m.source.deltaType === "sum" &&
        m.source.fieldName
    )
    .map(async (m) => {
      const value = await computeSum(db, m.source.collectionName, m.source.fieldName!, accountId);
      return { key: m.metricKey, value };
    });

  const results = await Promise.all([...countQueries, ...sumQueries]);
  for (const { key, value } of results) {
    counters[key] = value;
  }

  // Write recomputed counters to tenant-stats
  const stats: Omit<TenantStats, "id"> = {
    accountId,
    companyId: companyId ?? null,
    counters,
    updatedAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
  };

  await docRef.set(stats);

  return { id: docId, ...stats } as TenantStats;
}
