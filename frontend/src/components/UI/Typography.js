import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { COLORS, SIZES } from '../../theme';

export const Header = ({ children, style, ...props }) => (
    <Text style={[styles.header, style]} {...props}>{children}</Text>
);

export const Subtitle = ({ children, style, ...props }) => (
    <Text style={[styles.subtitle, style]} {...props}>{children}</Text>
);

export const Body = ({ children, style, ...props }) => (
    <Text style={[styles.body, style]} {...props}>{children}</Text>
);

export const MutedText = ({ children, style, ...props }) => (
    <Text style={[styles.muted, style]} {...props}>{children}</Text>
);

const styles = StyleSheet.create({
    header: {
        fontSize: SIZES.header,
        fontWeight: '900', // Close to bold for modern look
        color: COLORS.textHeader,
        marginBottom: 4,
    },
    subtitle: {
        fontSize: SIZES.body,
        color: COLORS.textBody,
        marginBottom: 16,
    },
    body: {
        fontSize: SIZES.body,
        color: COLORS.textHeader,
    },
    muted: {
        fontSize: SIZES.subtext,
        color: COLORS.textBody,
    },
});
