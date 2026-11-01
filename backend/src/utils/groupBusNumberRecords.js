const normalizeBusNumber = require("./normalizeBusNumber");

function groupBusNumberRecords(buses) {
  const groups = new Map();
  for (const bus of buses) {
    const busNo = String(bus.bus_no ?? "").trim();
    if (!/^(0?[1-9])$/.test(busNo)) continue;

    const canonicalBusNo = normalizeBusNumber(busNo);
    const group = groups.get(canonicalBusNo) || [];
    group.push(bus);
    groups.set(canonicalBusNo, group);
  }

  return [...groups.entries()]
    .filter(([canonicalBusNo, group]) =>
      group.length > 1 || String(group[0].bus_no).trim() !== canonicalBusNo,
    )
    .map(([canonicalBusNo, group]) => {
      const keeper = group.find(
        (bus) => String(bus.bus_no).trim() === canonicalBusNo,
      ) || group[0];
      return {
        canonicalBusNo,
        keeper,
        buses: group,
        duplicates: group.filter((bus) => String(bus._id) !== String(keeper._id)),
      };
    });
}

module.exports = groupBusNumberRecords;
