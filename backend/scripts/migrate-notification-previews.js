require("dotenv").config();
const mongoose = require("mongoose");
const Notification = require("../src/models/Notification");
const Bus = require("../src/models/Bus");

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const notifications = await Notification.find({
    $or: [
      { old_preview: null, old_bus_no: { $nin: [null, ""] } },
      { new_preview: null, new_bus_no: { $nin: [null, ""] } },
    ],
  }).select("_id old_bus_no new_bus_no old_preview new_preview");

  let updated = 0;
  for (const notification of notifications) {
    const identifiers = [notification.old_bus_no, notification.new_bus_no]
      .filter(Boolean)
      .map((value) => String(value).trim().toUpperCase());
    const buses = identifiers.length
      ? await Bus.find({ bus_no: { $in: identifiers } }).select("bus_no preview_number").lean()
      : [];
    const byBusNo = new Map(buses.map((bus) => [bus.bus_no, bus.preview_number]));
    const update = {};
    if (!notification.old_preview && notification.old_bus_no) {
      update.old_preview = byBusNo.get(String(notification.old_bus_no).toUpperCase()) || null;
    }
    if (!notification.new_preview && notification.new_bus_no) {
      update.new_preview = byBusNo.get(String(notification.new_bus_no).toUpperCase()) || null;
    }
    if (Object.keys(update).length) {
      await Notification.updateOne({ _id: notification._id }, { $set: update });
      updated += 1;
    }
  }

  console.log(`Notification preview migration complete. Updated ${updated} records.`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Notification preview migration failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
