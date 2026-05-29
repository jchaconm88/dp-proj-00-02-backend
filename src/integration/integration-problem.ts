export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
}

export function problem(status: number, detail: string, type?: string, instance?: string): Problem {
  return {
    type: type ?? `https://api.example.com/problems/${status}`,
    title: STATUS_TITLES[status] ?? "Unknown Error",
    status,
    detail,
    instance,
  };
}

const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  503: "Service Unavailable",
};

import type { Request, Response, NextFunction } from "express";

export function problemMiddleware(err: any, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  const status = Number(err?.status ?? err?.statusCode ?? 500);
  const detail = err?.message ?? "Internal Server Error";
  res.status(status).json(problem(status, detail, undefined, req.originalUrl));
}
