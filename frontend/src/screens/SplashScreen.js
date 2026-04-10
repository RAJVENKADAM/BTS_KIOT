import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Image, Animated, StatusBar } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../theme';
import { Header, Subtitle, MutedText } from '../components/UI/Typography';
import { useAuth } from '../context/AuthContext';

export default function SplashScreen({ navigation }) {
  const { token } = useAuth();

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    // Animation
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 800,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 6,
        useNativeDriver: true,
      }),
    ]).start();

    // Navigation after delay
    const timer = setTimeout(() => {
      if (token) {
        navigation.replace('MainApp'); // ✅ Logged in
      } else {
        navigation.replace('Login'); // ✅ Not logged in
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, [token]);

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
        <Animated.View style={[styles.textContainer, { opacity: fadeAnim }]}>
          <Header style={styles.title}>BTS App</Header>
          <Subtitle style={styles.subtitle}>Bus Tracking System</Subtitle>
        </Animated.View>

        {/* Footer */}
        <Animated.View style={[styles.footer, { opacity: fadeAnim }]}>
          <MutedText style={styles.loading}>Tracking...</MutedText>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

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
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  logo: {
    width: 70,
    height: 70,
    tintColor: COLORS.white,
  },
  textContainer: {
    alignItems: 'center',
  },
  title: {
    fontSize: 36,
    color: COLORS.white,
    marginBottom: 4,
    fontWeight: '900',
  },
  subtitle: {
    fontSize: 16,
    color: 'rgba(255, 255, 255, 0.7)',
    fontWeight: '600',
  },
  footer: {
    position: 'absolute',
    bottom: 60,
    alignItems: 'center',
  },
  loading: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    fontSize: 11,
  },
});