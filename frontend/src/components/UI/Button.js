import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { COLORS, RADIUS, SIZES } from '../../theme';

const Button = ({ title, onPress, loading, disabled, style, textStyle, ...props }) => {
    return (
        <TouchableOpacity
            activeOpacity={0.8}
            onPress={onPress}
            disabled={loading || disabled}
            style={[
                styles.button,
                disabled && styles.disabled,
                style
            ]}
            {...props}
        >
            {loading ? (
                <ActivityIndicator color={COLORS.white} />
            ) : (
                <Text style={[styles.text, textStyle]}>{title}</Text>
            )}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    button: {
        backgroundColor: COLORS.primary,
        height: SIZES.buttonHeight,
        borderRadius: RADIUS.button,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 24,
        shadowColor: COLORS.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 4,
    },
    disabled: {
        opacity: 0.6,
    },
    text: {
        color: COLORS.white,
        fontSize: 16,
        fontWeight: '700',
    },
});

export default Button;
