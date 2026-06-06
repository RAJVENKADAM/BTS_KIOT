const axios = require('axios');
const Bus = require('../models/Bus');
const BusLiveLocation = require('../models/BusLiveLocation');

class BusTrackerService {
  constructor() {
    this.busTrackingState = {};
    this.pollingInterval = null;
    this.pollFrequency = 30000; // 30 seconds
  }

  async startTracking() {
    console.log('🚀 Starting bus tracking from GPS API...');

    this.pollingInterval = setInterval(async () => {
      try {
        const buses = await Bus.find({ status: 'active' });

        for (const bus of buses) {
          try {
            const location = await this.fetchBusLocation(bus.gps_device_id, bus.reg_no);
            if (location) {
              this.updateBusLocationState(bus.bus_no, location);
              
              // Also update MongoDB
              await BusLiveLocation.updateOne(
                { bus_id: bus._id },
                {
                  latitude: location.latitude,
                  longitude: location.longitude,
                  speed: location.speed,
                  is_online: true,
                  updatedAt: new Date()
                },
                { upsert: true }
              );
            }
          } catch (error) {
            console.error(`Error fetching location for ${bus.bus_no}:`, error.message);
          }
        }
      } catch (error) {
        console.error('Error in bus tracking poll:', error.message);
      }
    }, this.pollFrequency);
  }

  stopTracking() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log('⏹️ Bus tracking stopped');
    }
  }

  async fetchBusLocation(deviceId, regNo) {
    try {
      const response = await axios.get('https://app.gpstrack.in/api/get_current_data', {
        params: {
          token: '1v7XQwPwhKqcNEZc8m4rarQKqNFubSMJ',
          email: 'kiotcollege@gmail.com',
          device_id: deviceId,
          reg_no: regNo
        },
        timeout: 8000
      });

      if (response.data?.status === 'success' && response.data?.data) {
        const data = response.data.data;
        return {
          latitude: parseFloat(data.latitude),
          longitude: parseFloat(data.longitude),
          speed: parseFloat(data.speed) || 0,
          timestamp: Date.now(),
          status: 'online'
        };
      }
      return null;
    } catch (error) {
      console.error(`GPS fetch error for device ${deviceId}:`, error.message);
      return null;
    }
  }

  updateBusLocationState(busNo, location) {
    if (!this.busTrackingState[busNo]) {
      this.busTrackingState[busNo] = {};
    }
    this.busTrackingState[busNo] = {
      ...location,
      busNo,
      updatedAt: new Date()
    };
  }

  getBusLocation(busNo) {
    return this.busTrackingState[busNo] || null;
  }

  getAllBusLocations() {
    return Object.values(this.busTrackingState);
  }
}

module.exports = new BusTrackerService();
