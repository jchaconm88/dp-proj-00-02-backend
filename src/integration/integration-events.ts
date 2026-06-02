import { getWebFirestore } from "../lib/firebase-admin.js";

export type IntegrationEventType =
  | "stock_updated"
  | "price_updated"
  | "order_status_changed"
  | "shipment_created"
  | "shipment_updated"
  | "invoice_generated"
  | "product_changed";

export type ProductChangeAction = "created" | "updated" | "deleted" | "unpublished";

export interface ProductChangedPayload {
  sku: string;
  action: ProductChangeAction;
  product_id: string;
  timestamp: string;
}

export interface IntegrationEventPayload {
  companyId: string;
  accountId: string;
  type: IntegrationEventType;
  payload: Record<string, unknown>;
}

/**
 * Encola un evento de integración en la colección integration-webhook-outbox.
 * Fire-and-forget: el dispatcher asíncrono lo procesa en background.
 */
export async function emit(event: IntegrationEventPayload): Promise<void> {
  try {
    console.log(`[integration-events] emit called: type=${event.type}, companyId=${event.companyId}, payload=`, JSON.stringify(event.payload));
    const db = getWebFirestore();
    const credentialsSnap = await db
      .collection("integration-credentials")
      .where("companyId", "==", event.companyId)
      .where("status", "==", "active")
      .where("syncMode", "==", "event_driven")
      .get();
    if (credentialsSnap.empty) {
      console.log(`[integration-events] No active event_driven credentials found for companyId=${event.companyId}`);
      return;
    }
    console.log(`[integration-events] Found ${credentialsSnap.size} credential(s) for companyId=${event.companyId}`);
    const batch = db.batch();
    for (const credDoc of credentialsSnap.docs) {
      const credData = credDoc.data();
      if (!credData.webhookUrl) {
        console.log(`[integration-events] Credential ${credDoc.id} has no webhookUrl, skipping`);
        continue;
      }
      console.log(`[integration-events] Queuing outbox entry for credential ${credDoc.id} → ${credData.webhookUrl}`);
      const outboxRef = db.collection("integration-webhook-outbox").doc();
      batch.set(outboxRef, {
        accountId: event.accountId,
        companyId: event.companyId,
        credentialId: credDoc.id,
        event: event.type,
        payload: event.payload,
        status: "pending",
        lastError: "",
        createdAt: new Date(),
      });
    }
    await batch.commit();
    console.log(`[integration-events] Outbox committed, triggering processOutbox`);
    const { processOutbox } = await import("./integration-webhook.dispatcher.js");
    setImmediate(() => { processOutbox().catch((err) => { console.error("[integration-events] processOutbox error:", err); }); });
  } catch (e) {
    console.error("[integration-events] emit failed:", e instanceof Error ? e.message : "unknown");
  }
}
