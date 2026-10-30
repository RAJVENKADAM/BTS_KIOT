require("dotenv").config();
const mongoose = require("mongoose");
const BusRoute = require("../src/models/BusRoute");

function formatTime(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")}${suffix}`;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const rows = await BusRoute.find({
    $or: [
      { arrival_time: null },
      { arrival_time: { $exists: false } },
      { arrival_time: "" },
    ],
  })
    .select("_id bus_id plan_name stop_order")
    .sort({ bus_id: 1, plan_name: 1, stop_order: 1 })
    .lean();

  const groups = new Map();
  for (const row of rows) {
    const key = `${String(row.bus_id)}:${String(row.plan_name).toUpperCase()}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  let updated = 0;
  let groupIndex = 0;
  for (const group of groups.values()) {
    const startMinutes = 8 * 60 + (groupIndex % 5) * 5;
    groupIndex += 1;
    for (let index = 0; index < group.length; index += 1) {
      const offset =
        group.length <= 1
          ? 0
          : Math.round((index * 35) / (group.length - 1));
      const result = await BusRoute.updateOne(
        {
          _id: group[index]._id,
          $or: [
            { arrival_time: null },
            { arrival_time: { $exists: false } },
            { arrival_time: "" },
          ],
        },
        { $set: { arrival_time: formatTime(startMinutes + offset) } },
      );
      updated += result.modifiedCount;
    }
  }

  console.log(
    `Sample arrival-time migration complete. Added times to ${updated} existing route stops between 8:00AM and 8:55AM.`,
  );
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Sample arrival-time migration failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
