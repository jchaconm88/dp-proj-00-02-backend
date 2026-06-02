import { getWebFirestore } from "../lib/firebase-admin.js";
import crypto from "node:crypto";

/**
 * Envía webhooks pendientes en la outbox.
 * Sin reintentos: si falla, se marca como "failed" inmediatamente.
 */
export async function processOutbox(): Promise<{ sent: number; failed: number }> {
  const db = getWebFirestore();
  console.log("[processOutbox] Querying pending outbox entries...");
  const snap = await db.collection("integration-webhook-outbox")
    .where("status", "==", "pending")
    .limit(20)
    .get();

  console.log(`[processOutbox] Found ${snap.size} pending entries`);

  let sent = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
    console.log(`[processOutbox] Processing entry ${doc.id}: event=${data.event}, credentialId=${data.credentialId}`);
    const credentialSnap = await db.collection("integration-credentials").doc(data.credentialId).get();
    if (!credentialSnap.exists) {
      await doc.ref.update({ status: "failed", lastError: "Credential not found" });
      failed++;
      continue;
    }
    const cred = credentialSnap.data() ?? {};
    const webhookUrl = String(cred.webhookUrl ?? "").trim();
    const webhookSecret = String(cred.webhookSecret ?? "").trim();
    if (!webhookUrl) {
      await doc.ref.update({ status: "failed", lastError: "No webhook URL configured" });
      failed++;
      continue;
    }

    console.log(`[processOutbox] Sending to: ${webhookUrl}`);

    const body = JSON.stringify({
      event: data.event,
      data: data.payload,
      timestamp: Math.floor(Date.now() / 1000),
    });
    const signature = crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ERP-Signature": signature,
          "X-ERP-Timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body,
        signal: AbortSignal.timeout(15000),
      });

      console.log(`[processOutbox] Response: ${response.status} ${response.statusText}`);

      if (response.ok) {
        const responseBody = await response.text();
        console.log(`[processOutbox] Success response body: ${responseBody.substring(0, 200)}`);
        await doc.ref.update({ status: "sent", lastError: "" });
        sent++;
      } else {
        const errorBody = await response.text();
        const errorMsg = `HTTP ${response.status}: ${errorBody.substring(0, 200)}`;
        console.log(`[processOutbox] Failed: ${errorMsg}`);
        await doc.ref.update({ status: "failed", lastError: errorMsg });
        failed++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "unknown";
      console.log(`[processOutbox] Exception: ${errorMsg}`);
      await doc.ref.update({ status: "failed", lastError: errorMsg });
      failed++;
    }
  }

  console.log(`[processOutbox] Done: sent=${sent}, failed=${failed}`);
  return { sent, failed };
}
