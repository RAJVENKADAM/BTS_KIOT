import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS, RADIUS, SHADOWS } from '../../theme';

const Card = ({ children, style, ...props }) => {
    return (
        <View style={[styles.card, style]} {...props}>
            {children}
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        backgroundColor: COLORS.white,
        borderRadius: RADIUS.card,
        borderWidth: 1,
        borderColor: COLORS.border,
        padding: 20,
        ...SHADOWS.soft,
    },
});

export default Card;
