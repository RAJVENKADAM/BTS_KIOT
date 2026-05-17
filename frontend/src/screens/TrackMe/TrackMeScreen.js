import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

// NOTE:
// This screen was missing in the repo but referenced by BottomNavigator.
// It is implemented as a real navigation target that keeps the app stable.
// You can later integrate it with your existing tracking logic (if any).

export default function TrackMeScreen() {
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Track Me</Text>
        <Text style={styles.subtitle}>Tracking dashboard is not wired in this repo snapshot.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  content: {
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111827',
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
  },
});

