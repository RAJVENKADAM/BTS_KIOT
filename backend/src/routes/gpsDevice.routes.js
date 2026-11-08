"use strict";

const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const {
  listGpsDevices,
  saveGpsDevice,
} = require("../controllers/gpsDevice.controller");

const router = express.Router();

router.get("/", authenticateToken, authorizeRoles("superadmin"), listGpsDevices);
router.put(
  "/:deviceId",
  authenticateToken,
  authorizeRoles("superadmin"),
  saveGpsDevice,
);

module.exports = router;
