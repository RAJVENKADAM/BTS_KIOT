import React, { useState } from 'react';
import { View, TextInput, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS, SIZES, SPACING } from '../../theme';

const Input = ({ label, icon, rightIcon, error, ...props }) => {
    const [isFocused, setIsFocused] = useState(false);

    return (
        <View style={styles.container}>
            {label && <Text style={styles.label}>{label}</Text>}
            <View style={[
                styles.inputWrapper,
                isFocused && styles.focused,
                error && styles.error
            ]}>
                {icon && <Ionicons name={icon} size={20} color={isFocused ? COLORS.primary : COLORS.textBody} style={styles.icon} />}
                <TextInput
                    style={styles.input}
                    placeholderTextColor={COLORS.textBody}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    {...props}
                />
                {rightIcon && (
                    <View style={styles.rightIcon}>
                        {rightIcon}
                    </View>
                )}
            </View>
            {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        marginBottom: 20,
        width: '100%',
    },
    label: {
        fontSize: 14,
        fontWeight: '600',
        color: COLORS.textHeader,
        marginBottom: 8,
        marginLeft: 4,
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: COLORS.inputBg,
        borderWidth: 1.5,
        borderColor: 'transparent',
        borderRadius: RADIUS.input,
        paddingHorizontal: 16,
        height: SIZES.inputHeight,
    },
    focused: {
        borderColor: COLORS.primary,
        backgroundColor: COLORS.white, // As per high-end SaaS aesthetic often white on focus
    },
    error: {
        borderColor: COLORS.error,
    },
    icon: {
        marginRight: 12,
    },
    rightIcon: {
        marginLeft: 12,
    },
    input: {
        flex: 1,
        fontSize: 16,
        color: COLORS.textHeader,
        height: '100%',
    },
    errorText: {
        color: COLORS.error,
        fontSize: 12,
        marginTop: 4,
        marginLeft: 4,
    },
});

export default Input;
