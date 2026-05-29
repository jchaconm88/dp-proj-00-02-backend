import { getWebFirestore } from "../lib/firebase-admin.js";
import crypto from "node:crypto";

const MAX_ATTEMPTS = 4;
const BACKOFF_SECONDS = [30, 120, 600];

/**
 * Intenta enviar webhooks pendientes en la outbox.
 * Se invoca en background tras emit() o desde un endpoint interno.
 */
export async function processOutbox(): Promise<{ sent: number; failed: number }> {
  const db = getWebFirestore();
  const snap = await db.collection("integration-webhook-outbox")
    .where("status", "==", "pending")
    .where("nextRetryAt", "<=", new Date())
    .limit(20)
    .get();

  let sent = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const data = doc.data() ?? {};
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

      if (response.ok) {
        await doc.ref.update({ status: "sent", lastError: "" });
        sent++;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      const attempts = Number(data.attempts ?? 0) + 1;
      const errorMsg = err instanceof Error ? err.message : "unknown";
      if (attempts >= MAX_ATTEMPTS) {
        await doc.ref.update({ status: "failed", attempts, lastError: errorMsg });
        failed++;
      } else {
        const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 600;
        const nextRetry = new Date(Date.now() + backoff * 1000);
        await doc.ref.update({ status: "pending", attempts, lastError: errorMsg, nextRetryAt: nextRetry });
        failed++;
      }
    }
  }

  return { sent, failed };
}
