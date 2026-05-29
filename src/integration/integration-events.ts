import { getWebFirestore } from "../lib/firebase-admin.js";

export type IntegrationEventType =
  | "stock_updated"
  | "price_updated"
  | "order_status_changed"
  | "shipment_created"
  | "shipment_updated"
  | "invoice_generated";

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
    const db = getWebFirestore();
    const credentialsSnap = await db
      .collection("integration-credentials")
      .where("companyId", "==", event.companyId)
      .where("status", "==", "active")
      .where("syncMode", "==", "event_driven")
      .get();
    if (credentialsSnap.empty) return;
    const batch = db.batch();
    for (const credDoc of credentialsSnap.docs) {
      const credData = credDoc.data();
      if (!credData.webhookUrl) continue;
      const outboxRef = db.collection("integration-webhook-outbox").doc();
      batch.set(outboxRef, {
        accountId: event.accountId,
        companyId: event.companyId,
        credentialId: credDoc.id,
        event: event.type,
        payload: event.payload,
        status: "pending",
        attempts: 0,
        nextRetryAt: new Date(),
        lastError: "",
        createdAt: new Date(),
      });
    }
    await batch.commit();
    const { processOutbox } = await import("./integration-webhook.dispatcher.js");
    setImmediate(() => { processOutbox().catch(() => {}); });
  } catch (e) {
    console.error("[integration-events] emit failed:", e instanceof Error ? e.message : "unknown");
  }
}
