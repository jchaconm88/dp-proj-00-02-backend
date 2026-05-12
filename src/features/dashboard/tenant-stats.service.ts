import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import type { TenantStats } from "./dashboard.types.js";

const COLLECTION = "tenant-stats";

/**
 * Builds the tenant-stats document ID.
 * Format: `{accountId}_{companyId}` or `{accountId}___` if no companyId.
 */
function buildDocId(accountId: string, companyId?: string): string {
  return companyId ? `${accountId}_${companyId}` : `${accountId}___`;
}

/**
 * Adjusts a counter for a tenant atomically.
 * Called by other backend services when entities are created/deleted
 * (trips, invoices, settlements, etc.).
 *
 * Uses Firestore `set` with merge to create the document if it doesn't exist,
 * and `FieldValue.increment(delta)` for atomic counter updates.
 */
export async function adjustCount(
  db: FirebaseFirestore.Firestore,
  params: {
    accountId: string;
    companyId?: string;
    metricKey: string;
    delta: number;
  }
): Promise<void> {
  const { accountId, companyId, metricKey, delta } = params;
  const docId = buildDocId(accountId, companyId);
  const docRef = db.collection(COLLECTION).doc(docId);

  await docRef.set(
    {
      accountId,
      companyId: companyId ?? null,
      [`counters.${metricKey}`]: FieldValue.increment(delta),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Recalculates all counters for a tenant by reading the existing tenant-stats document.
 *
 * Note: The full recalculation from source collections will be enhanced when the
 * snapshot composer is built. For now, this returns the existing document data.
 */
export async function recalculate(
  db: FirebaseFirestore.Firestore,
  params: { accountId: string; companyId?: string }
): Promise<TenantStats> {
  const { accountId, companyId } = params;
  const docId = buildDocId(accountId, companyId);
  const docRef = db.collection(COLLECTION).doc(docId);
  const snap = await docRef.get();

  if (snap.exists) {
    return { id: snap.id, ...snap.data() } as TenantStats;
  }

  // Document doesn't exist yet — create an empty one and return it
  const emptyStats: Omit<TenantStats, "id"> = {
    accountId,
    companyId: companyId ?? null,
    counters: {},
    updatedAt: FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp,
  };

  await docRef.set(emptyStats);

  return { id: docId, ...emptyStats } as TenantStats;
}
