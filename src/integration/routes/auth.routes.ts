import { Router } from "express";
import { authenticate } from "../integration-auth.service.js";

export const authRouter = Router();

authRouter.post("/", async (req, res) => {
  try {
    const { api_key, api_secret } = req.body ?? {};
    if (!api_key || !api_secret) {
      res.status(422).json({
        type: "https://api.example.com/problems/validation-error",
        title: "Validation failed",
        status: 422,
        detail: "api_key and api_secret are required",
        instance: "/api/v1/auth/token",
      });
      return;
    }
    const result = await authenticate(String(api_key), String(api_secret));
    res.status(200).json(result);
  } catch (err: any) {
    const status = Number(err?.status ?? 500);
    res.status(status).json({
      type: `https://api.example.com/problems/${status}`,
      title: status === 401 ? "Unauthorized" : "Internal Server Error",
      status,
      detail: err?.message ?? "Authentication failed",
      instance: "/api/v1/auth/token",
    });
  }
});
