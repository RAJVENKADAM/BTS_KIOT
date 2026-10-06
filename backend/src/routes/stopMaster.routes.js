const express = require("express");
const StopMasterController = require("../controllers/stopMaster.controller");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");

const router = express.Router();
router.use(authenticateToken, authorizeRoles("superadmin"));

router.get("/coordinates", StopMasterController.getCoordinateSheet);
router.post("/coordinates/import", StopMasterController.importCoordinates);

module.exports = router;
