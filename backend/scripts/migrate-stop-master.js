require("dotenv").config();
const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const BusRoute = require("../src/models/BusRoute");
const StopMaster = require("../src/models/StopMaster");
const findVerifiedStop = require("../src/utils/findVerifiedStop");

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeName = (value) =>
  String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

async function findOrCreatePendingStop(name, cache) {
  const key = normalizeName(name);
  if (cache.has(key)) return cache.get(key);

  const exact = new RegExp(`^${escapeRegExp(key)}$`, "i");
  let stop = await StopMaster.findOne({ name: exact, status: "PENDING" });
  if (!stop) {
    stop = await StopMaster.create({
      stopId: `STOP-${randomUUID()}`,
      name: String(name).trim().replace(/\s+/g, " "),
      source: "EXISTING_STOP",
      status: "PENDING",
    });
  }
  cache.set(key, stop.stopId);
  return stop.stopId;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const rows = await BusRoute.find({
    $or: [{ stopId: null }, { stopId: { $exists: false } }],
  })
    .select("_id stop_name")
    .lean();
  const pendingByName = new Map();
  let linked = 0;

  for (const row of rows) {
    const match = await findVerifiedStop({ name: row.stop_name });
    const stopId =
      match.stop?.stopId ||
      (await findOrCreatePendingStop(row.stop_name, pendingByName));
    await BusRoute.updateOne({ _id: row._id }, { $set: { stopId } });
    linked += 1;
  }

  console.log(
    `Stop Master migration complete. Linked ${linked} route stops; unresolved names remain pending for superadmin verification.`,
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Stop Master migration failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
