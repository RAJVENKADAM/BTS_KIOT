import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Image, Animated, StatusBar } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COLORS } from '../theme';
import { Header, Subtitle, MutedText } from '../components/UI/Typography';

export default function SplashScreen() {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 5,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.primary} />

      <View style={styles.container}>
        {/* Logo */}
        <Animated.View
          style={[
            styles.logoContainer,
            { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
          ]}
        >
          <View style={styles.logoCircle}>
            <Image
              source={{
                uri: 'https://cdn-icons-png.flaticon.com/512/159/159657.png',
              }}
              style={styles.logo}
              resizeMode="contain"
            />
          </View>
        </Animated.View>

        {/* Title */}
        <Animated.View style={{ opacity: fadeAnim, alignItems: 'center' }}>
          <Header style={styles.title}>BTS App</Header>
          <Subtitle style={styles.subtitle}>Bus Tracking System</Subtitle>
        </Animated.View>

        {/* Footer */}
        <Animated.View style={[styles.footer, { opacity: fadeAnim }]}>
          <MutedText style={styles.loading}>Loading...</MutedText>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

/**
 * Styles
 */
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.primary,
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    marginBottom: 24,
  },
  logoCircle: {
    width: 120,
    height: 120,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logo: {
    width: 70,
    height: 70,
    tintColor: '#fff',
  },
  title: {
    fontSize: 36,
    color: '#fff',
    fontWeight: '900',
  },
  subtitle: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 4,
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: 60,
  },
  loading: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
});