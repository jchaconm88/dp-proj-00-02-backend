import { getWebFirestore } from "../lib/firebase-admin.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const JWT_SECRET = String(process.env.INTEGRATION_JWT_SECRET ?? "integration-dev-secret-do-not-use-in-prod");
const JWT_TTL_SECONDS = 3600;

export interface IntegrationCredential {
  id: string;
  accountId: string;
  companyId: string;
  apiKey: string;
  apiKeyHash: string;
  apiSecretHash: string;
  status: string;
}

export interface TokenResponse {
  token: string;
  expires_at: number;
}

export async function authenticate(apiKey: string, apiSecret: string): Promise<TokenResponse> {
  const db = getWebFirestore();
  const snap = await db
    .collection("integration-credentials")
    .where("apiKey", "==", apiKey)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (snap.empty) throw Object.assign(new Error("Invalid API key or secret"), { status: 401 });
  const doc = snap.docs[0]!;
  const data = doc.data() as Omit<IntegrationCredential, "id">;
  const valid = await bcrypt.compare(apiSecret, data.apiSecretHash);
  if (!valid) throw Object.assign(new Error("Invalid API key or secret"), { status: 401 });
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + JWT_TTL_SECONDS;
  const tokenPayload = {
    sub: data.apiKey,
    companyId: data.companyId,
    accountId: data.accountId,
    credentialId: doc.id,
    iat: now,
    exp: expiresAt,
  };
  const token = jwt.sign(tokenPayload, JWT_SECRET, { algorithm: "HS256" });
  await db.collection("integration-credentials").doc(doc.id).update({
    lastUsedAt: new Date(),
  });
  return { token, expires_at: expiresAt };
}

export function verifyToken(token: string): jwt.JwtPayload {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    return decoded;
  } catch {
    throw Object.assign(new Error("Invalid or expired token"), { status: 401 });
  }
}
