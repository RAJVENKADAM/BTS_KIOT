import React from 'react';
import {
  Modal,
  View,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  PanGestureHandler,
  State,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../theme';
import { Header, Body } from './UI/Typography';

const { height: screenHeight } = Dimensions.get('window');

const BottomSheetModal = ({
  isVisible,
  onClose,
  children,
  title,
  snapPoints = ['50%', '80%'],
  initialSnap = 0,
}) => {
  const translateY = React.useRef(new Animated.Value(screenHeight)).current;
  const snapPosition = React.useRef(snapPoints[initialSnap]).current;

  React.useEffect(() => {
    if (isVisible) {
      translateY.setValue(screenHeight);
      Animated.spring(translateY, {
        toValue: screenHeight - parseFloat(snapPosition),
        tension: 50,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.spring(translateY, {
        toValue: screenHeight,
        tension: 50,
        useNativeDriver: true,
      }).start();
    }
  }, [isVisible, snapPosition]);

  const onGestureEvent = Animated.event(
    [{ nativeEvent: { translationY: translateY } }],
    { useNativeDriver: true }
  );

  const onHandlerStateChange = ({ nativeEvent }) => {
    if (nativeEvent.state === State.END) {
      const { translationY } = nativeEvent;
      const targetY = translationY > parseFloat(snapPoints[0]) / 2 
        ? screenHeight 
        : screenHeight - parseFloat(snapPoints[initialSnap]);

      Animated.spring(translateY, {
        toValue: targetY,
        tension: 50,
        useNativeDriver: true,
      }).start(() => {
        if (targetY === screenHeight) {
          onClose();
        }
      });
    }
  };

  if (!isVisible) return null;

  return (
    <Modal transparent visible={isVisible} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity 
          style={styles.overlayTouchable} 
          activeOpacity={1} 
          onPress={onClose}
        />
        
        <Animated.View 
          style={[
            styles.sheet,
            {
              transform: [{ translateY }],
            },
          ]}
        >
          <PanGestureHandler onGestureEvent={onGestureEvent} onHandlerStateChange={onHandlerStateChange}>
            <View>
              <View style={styles.handle} />
              <View style={styles.header}>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={24} color={COLORS.textBody} />
                </TouchableOpacity>
                {title && <Header style={styles.sheetTitle}>{title}</Header>}
              </View>
              <View style={styles.content}>
                {children}
              </View>
            </View>
          </PanGestureHandler>
        </Animated.View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  overlayTouchable: {
    flex: 1,
  },
  sheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
    maxHeight: '90%',
    ...SHADOWS.heavy,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: COLORS.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginVertical: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  closeBtn: {
    padding: 4,
    marginRight: 'auto',
  },
  sheetTitle: {
    flex: 1,
    textAlign: 'center',
  },
  content: {
    flex: 1,
    paddingHorizontal: SPACING.screenPadding,
    paddingBottom: SPACING.lg,
    paddingTop: SPACING.md,
  },
});

export default BottomSheetModal;
