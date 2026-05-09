import { Router } from "express";
import { getAdminFirestore } from "../../../lib/firebase-admin.js";
import {
  createCustomSequence,
  deleteCustomSequence,
  generateSequenceCode,
  getMergedSequenceById,
  listMergedSequences,
  updateCustomSequence,
} from "../../../lib/sequences.service.js";

function requireAccountId(req: any): string {
  const accountId = String(req?.admin?.accountId ?? "").trim();
  if (!accountId) throw new Error("missing_accountId");
  return accountId;
}

function sequenceHttpStatus(error: string): number {
  if (error === "default_sequence_readonly" || error === "entity_required" || error === "companyId_required") return 400;
  if (error === "sequence_entity_duplicate") return 409;
  if (error === "sequence_not_found") return 412;
  if (error === "not_found") return 404;
  return 500;
}

const router = Router();

router.get("/", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const items = await listMergedSequences(getAdminFirestore(), "admin", accountId);
    res.status(200).json(items);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences GET] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const item = await getMergedSequenceById(getAdminFirestore(), "admin", accountId, req.params.id);
    if (!item) return res.status(404).json({ error: "not_found" });
    res.status(200).json(item);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences/:id GET] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

router.post("/", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const out = await createCustomSequence(getAdminFirestore(), "admin", accountId, req.body ?? {});
    res.status(201).json({ ok: true, ...out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences POST] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    await updateCustomSequence(getAdminFirestore(), "admin", accountId, req.params.id, req.body ?? {});
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences PUT] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    await deleteCustomSequence(getAdminFirestore(), "admin", accountId, req.params.id);
    res.status(200).json({ ok: true, id: req.params.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences DELETE] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

router.post("/generate-code", async (req, res) => {
  try {
    const accountId = requireAccountId(req as any);
    const code = await generateSequenceCode(
      getAdminFirestore(),
      "admin",
      accountId,
      String(req.body?.entity ?? ""),
      String(req.body?.currentCode ?? "")
    );
    res.status(200).json({ code });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown_error";
    console.error("[admin/system/admin-sequences/generate-code POST] failed:", msg);
    res.status(sequenceHttpStatus(msg)).json({ error: msg });
  }
});

export default router;

