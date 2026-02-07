import { API_BASE_URL } from '../api/api';
import Constants from 'expo-constants';

export const debugNetwork = async () => {
  console.log('=== Network Debug Info ===');
  console.log('API_BASE_URL:', API_BASE_URL);
  
  // Log Expo constants
  console.log('Expo Config Host URI:', Constants.expoConfig?.hostUri);
  console.log('Manifest Debugger Host:', Constants.manifest?.debuggerHost);
  console.log('Manifest2 Extra ExpoClient Host URI:', Constants.manifest2?.extra?.expoClient?.hostUri);
  
  // Try to ping the health endpoint
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    console.log('Health check response status:', response.status);
    const data = await response.json();
    console.log('Health check response data:', data);
    return { success: true, data };
  } catch (error) {
    console.error('Network debug error:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    return { success: false, error };
  }
};