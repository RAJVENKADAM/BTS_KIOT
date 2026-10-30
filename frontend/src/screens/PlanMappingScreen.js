import React from "react";
import { Text, View } from "react-native";
import { useAuth } from "../context/AuthContext";

export default function PlanMappingScreen() {
  const { user } = useAuth();
  if (String(user?.role || "").toLowerCase() !== "superadmin") {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text>Plan mapping is only available to super admins.</Text>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>Open Plan Mapping in a web browser.</Text>
      <Text style={{ marginTop: 8, textAlign: "center" }}>
        The visual bus-cluster editor is designed for the super-admin website.
      </Text>
    </View>
  );
}
