"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const { runAtlasReadonlyAudit } = require("../../scripts/atlas-readonly-audit");

const MIN_AUDIT_SECRET_BYTES = 32;
let auditInProgress = false;

function isAuditSecretValid(providedSecret, expectedSecret) {
  if (
    typeof providedSecret !== "string" ||
    typeof expectedSecret !== "string" ||
    Buffer.byteLength(expectedSecret, "utf8") < MIN_AUDIT_SECRET_BYTES
  ) {
    return false;
  }

  const providedDigest = createHash("sha256").update(providedSecret).digest();
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

async function runAtlasAudit(req, res) {
  res.set("Cache-Control", "no-store");

  const expectedInstanceId = process.env.BTMS_ATLAS_AUDIT_INSTANCE_ID;
  const currentInstanceId = process.env.RENDER_INSTANCE_ID;
  if (!expectedInstanceId || !currentInstanceId || expectedInstanceId !== currentInstanceId) {
    return res.status(503).json({
      error: "Audit endpoint is not available on this instance.",
      code: "AUDIT_INSTANCE_NOT_CONFIGURED",
    });
  }

  const expectedSecret = process.env.BTMS_ATLAS_AUDIT_SECRET;
  if (!expectedSecret) {
    return res.status(503).json({
      error: "Audit endpoint is not configured.",
      code: "AUDIT_NOT_CONFIGURED",
    });
  }

  if (!isAuditSecretValid(req.get("X-BTMS-Audit-Secret"), expectedSecret)) {
    return res.status(403).json({
      error: "Audit authorization failed.",
      code: "AUDIT_FORBIDDEN",
    });
  }

  if (!mongoose.Types.ObjectId.isValid(req.user.id)) {
    return res.status(403).json({
      error: "Audit authorization failed.",
      code: "AUDIT_FORBIDDEN",
    });
  }

  let user;
  try {
    user = await User.findById(req.user.id)
      .select("_id role is_active deleted_by_user")
      .lean();
  } catch {
    return res.status(503).json({
      error: "Unable to verify the current account status.",
      code: "ACCOUNT_STATUS_UNAVAILABLE",
    });
  }

  if (
    !user ||
    user.role !== "superadmin" ||
    user.is_active !== true ||
    user.deleted_by_user
  ) {
    return res.status(403).json({
      error: "Audit authorization failed.",
      code: "AUDIT_FORBIDDEN",
    });
  }

  if (auditInProgress) {
    return res.status(409).json({
      error: "An audit is already running.",
      code: "AUDIT_IN_PROGRESS",
    });
  }

  auditInProgress = true;
  try {
    const report = await runAtlasReadonlyAudit();
    const statusCode = report.status === "SUCCEEDED"
      ? 200
      : report.status === "PARTIALLY_COMPLETED"
        ? 207
        : 503;
    return res.status(statusCode).json({ audit: report });
  } catch {
    return res.status(503).json({
      error: "The audit could not be completed.",
      code: "AUDIT_FAILED",
    });
  } finally {
    auditInProgress = false;
  }
}

module.exports = { runAtlasAudit };
