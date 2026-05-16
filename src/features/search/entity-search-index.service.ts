import type { firestore as FirebaseFirestore } from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const COLLECTION = "entity-search-indexes";

export interface EntitySearchIndexParams {
  accountId: string;
  companyId: string;
  entityId: string;
  action: "create" | "update" | "delete";
  recordId: string;
  fields: Record<string, string | undefined>;
}

export function normalizeFieldsForIndex(
  fields: Record<string, string | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const str = String(value ?? "");
    normalized[key] = str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }
  return normalized;
}

export async function updateEntitySearchIndex(
  db: FirebaseFirestore.Firestore,
  params: EntitySearchIndexParams
): Promise<void> {
  const { accountId, companyId, entityId, action, recordId, fields } = params;

  if (!companyId || !entityId || !recordId) {
    console.warn("[entity-search-index] missing required fields", {
      companyId,
      entityId,
      recordId,
    });
    return;
  }

  try {
    const docRef = db.collection(COLLECTION).doc(companyId);

    if (action === "delete") {
      const deletePath = `entities.${entityId}.${recordId}`;
      await docRef.update({
        [deletePath]: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      const cleanFields: Record<string, string> = {};
      for (const [key, value] of Object.entries(fields)) {
        cleanFields[key] = String(value ?? "");
      }
      const setPath = `entities.${entityId}.${recordId}`;
      await docRef.set(
        {
          companyId,
          accountId,
          [setPath]: {
            fields: cleanFields,
            fieldsNormalized: normalizeFieldsForIndex(cleanFields),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    console.error("[entity-search-index] update failed:", error);
  }
}

type IndexRecord = {
  fields: Record<string, string>;
  fieldsNormalized: Record<string, string>;
};

type RebuildSummary = Record<string, number>;

function buildIndexRecord(fields: Record<string, string | undefined>): IndexRecord {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    clean[key] = String(value ?? "");
  }
  return {
    fields: clean,
    fieldsNormalized: normalizeFieldsForIndex(clean),
  };
}

export async function rebuildEntitySearchIndexForCompany(
  db: FirebaseFirestore.Firestore,
  params: { accountId: string; companyId: string }
): Promise<RebuildSummary> {
  const { accountId, companyId } = params;
  const entities: Record<string, Record<string, IndexRecord>> = {
    trip: {},
    client: {},
    employee: {},
    "purchase-order": {},
    "sale-order": {},
    quotation: {},
    product: {},
  };

  const [
    tripsSnap,
    clientsSnap,
    employeesSnap,
    purchaseOrdersSnap,
    saleOrdersSnap,
    quotationsSnap,
    productsSnap,
  ] = await Promise.all([
    db.collection("trips").where("companyId", "==", companyId).get(),
    db.collection("clients").where("companyId", "==", companyId).get(),
    db.collection("employees").where("companyId", "==", companyId).get(),
    db.collection("purchase-orders").where("companyId", "==", companyId).get(),
    db.collection("sale-orders").where("companyId", "==", companyId).get(),
    db.collection("quotations").where("companyId", "==", companyId).get(),
    db.collection("products").where("companyId", "==", companyId).get(),
  ]);

  for (const d of tripsSnap.docs) {
    const row = d.data() ?? {};
    entities.trip[d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      origin: String(row.origin ?? row.route ?? ""),
      destination: String(row.destination ?? row.client ?? ""),
    });
  }
  for (const d of clientsSnap.docs) {
    const row = d.data() ?? {};
    entities.client[d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      businessName: String(row.businessName ?? ""),
      documentNumber: String(row.documentNumber ?? ""),
    });
  }
  for (const d of employeesSnap.docs) {
    const row = d.data() ?? {};
    entities.employee[d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      fullName: String(row.fullName ?? `${String(row.firstName ?? "")} ${String(row.lastName ?? "")}`).trim(),
      documentNumber: String(row.documentNumber ?? row.documentNo ?? ""),
    });
  }
  for (const d of purchaseOrdersSnap.docs) {
    const row = d.data() ?? {};
    entities["purchase-order"][d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      providerName: String(row.providerName ?? row.supplierName ?? ""),
      status: String(row.status ?? ""),
    });
  }
  for (const d of saleOrdersSnap.docs) {
    const row = d.data() ?? {};
    entities["sale-order"][d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      clientName: String(row.clientName ?? ""),
      status: String(row.status ?? ""),
    });
  }
  for (const d of quotationsSnap.docs) {
    const row = d.data() ?? {};
    entities.quotation[d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      clientName: String(row.clientName ?? ""),
      status: String(row.status ?? ""),
    });
  }
  for (const d of productsSnap.docs) {
    const row = d.data() ?? {};
    entities.product[d.id] = buildIndexRecord({
      code: String(row.code ?? ""),
      name: String(row.name ?? ""),
      status: String(
        row.status ?? (row.active === false ? "inactive" : "active")
      ),
    });
  }

  const summary: RebuildSummary = Object.fromEntries(
    Object.entries(entities).map(([k, v]) => [k, Object.keys(v).length])
  );
  await db.collection(COLLECTION).doc(companyId).set(
    {
      companyId,
      accountId,
      entities,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: false }
  );

  return summary;
}
