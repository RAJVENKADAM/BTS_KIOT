import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Platform
} from 'react-native';

const BottomSheet = ({ busData, onPlanClick }) => {
  const [showPlans, setShowPlans] = useState(false);

  const handlePlanPress = (planName) => {
    onPlanClick?.(planName);
    setShowPlans(false);
  };

  return (
    <>
      {/* MAIN BOTTOM SHEET */}
      <View
        style={styles.bottomSheet}
        pointerEvents="auto"
      >
        {/* Handle */}
        <View style={styles.handleContainer}>
          <View style={styles.handle} />
        </View>

        {/* HEADER */}
        <View style={styles.header}>
          <View>
            <Text style={styles.busNumber}>
              {busData?.busNo || 'N/A'}
            </Text>
            <Text style={styles.statusText}>
              • Plan View Only
            </Text>
          </View>

          <View style={styles.etaContainer}>
            <Text style={styles.etaTime}>--</Text>
            <Text style={styles.etaLabel}>No live tracking</Text>
          </View>
        </View>

        <View style={styles.divider} />

        {/* CONTENT */}
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={styles.infoValue}>Plan Mode</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Tracking</Text>
            <Text style={styles.infoValue}>Disabled</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Source</Text>
            <Text style={styles.infoValue}>Database</Text>
          </View>

          {/* PLAN */}
          <TouchableOpacity
            style={styles.planSection}
            onPress={() => setShowPlans(true)}
            activeOpacity={0.8}
          >
            <View style={styles.planHeader}>
              <Text style={styles.sectionTitle}>Current Plan</Text>
              <View style={styles.planTag}>
                <Text style={styles.planTagText}>
                  {busData?.planName || 'Select'}
                </Text>
              </View>
            </View>
            <Text style={styles.planSubtitle}>
              Tap to change route plan
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* PLAN MODAL */}
      <Modal
        visible={showPlans}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPlans(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                Select Plan
              </Text>
              <TouchableOpacity onPress={() => setShowPlans(false)}>
                <Text style={styles.closeText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView>
              <TouchableOpacity
                style={styles.planItem}
                onPress={() => handlePlanPress(busData?.planName)}
              >
                <Text style={styles.planItemText}>
                  {busData?.planName || 'Default'}
                </Text>
              </TouchableOpacity>

              <Text style={styles.noPlansText}>
                More plans coming soon…
              </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
};

export default BottomSheet;

/* ---------------- STYLES ---------------- */
const styles = StyleSheet.create({
  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    minHeight: 280,
    maxHeight: '85%',
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    elevation: 30,
    zIndex: 9999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  handleContainer: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: '#E0E0E0',
    borderRadius: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
    alignItems: 'center',
  },
  busNumber: {
    fontSize: 22,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.9)',
  },
  statusText: {
    color: '#666666',
    fontSize: 14,
    marginTop: 2,
  },
  etaContainer: {
    alignItems: 'flex-end',
    backgroundColor: '#F3F2EF',
    padding: 8,
    borderRadius: 4,
  },
  etaTime: {
    fontSize: 18,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.9)',
  },
  etaLabel: {
    fontSize: 11,
    color: '#666666',
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F2EF',
    marginHorizontal: 0,
  },
  content: {
    padding: 20,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F2EF',
  },
  infoLabel: {
    color: '#666666',
    fontSize: 14,
    fontWeight: '500',
  },
  infoValue: {
    fontWeight: '600',
    fontSize: 14,
    color: 'rgba(0,0,0,0.85)',
  },
  planSection: {
    marginTop: 16,
    marginBottom: 24,
    backgroundColor: '#EDF3F8',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0077B533',
  },
  planHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0077B5',
  },
  planTag: {
    backgroundColor: '#0077B5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  planTagText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
  },
  planSubtitle: {
    marginTop: 4,
    color: '#666666',
    fontSize: 13,
  },
  /* MODAL */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    minHeight: '40%',
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: 'rgba(0,0,0,0.9)',
  },
  closeText: {
    fontSize: 20,
    color: '#666666',
    fontWeight: '300',
  },
  planItem: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F2EF',
  },
  planItemText: {
    fontSize: 16,
    color: 'rgba(0,0,0,0.85)',
    fontWeight: '600',
  },
  noPlansText: {
    textAlign: 'center',
    color: '#666666',
    padding: 24,
    fontSize: 14,
  },
});
