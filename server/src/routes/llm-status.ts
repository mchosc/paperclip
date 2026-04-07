/**
 * @fileoverview LLM Stack Status route — exposes a unified view of every
 * LLM consumer in the Paperclip stack (adapters, plugins, services) for the
 * dashboard widget.
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { llmStatusService } from "../services/llm-status.js";
import { assertCompanyAccess } from "./authz.js";

export function llmStatusRoutes(db: Db) {
  const router = Router();
  const svc = llmStatusService(db);

  /**
   * GET /api/companies/:companyId/llm-status
   *
   * Returns every LLM consumer the stack is configured to use, grouped into
   * three kinds: agent adapters, LLM-using plugins, and known external
   * services (currently MemOS). Adapter consumers carry per-model usage
   * aggregated from `heartbeat_runs` over the last 7 days.
   */
  router.get("/companies/:companyId/llm-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const data = await svc.getLlmStatus(companyId);
    res.json(data);
  });

  return router;
}
