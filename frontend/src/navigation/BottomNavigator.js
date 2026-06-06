import React from 'react';

import HomeScreen from '../screens/HomeScreen';

// Bottom navigation removed entirely.
// Keep this component as a simple pass-through so existing navigation routes don't break.
export default function BottomNavigator() {
  return <HomeScreen />;
}

