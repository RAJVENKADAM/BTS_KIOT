const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { getRecommendation } = require("../controllers/master.controller");

const router = express.Router();

router.get("/recommendation", authenticateToken, getRecommendation);

module.exports = router;
