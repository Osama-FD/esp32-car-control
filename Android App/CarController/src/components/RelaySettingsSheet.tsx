import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { validateSettings, type Settings } from '../config';

interface Props {
  visible: boolean;
  settings: Settings;
  diagnostics: { label: string; value: string }[];
  onClose: () => void;
  onSave: (next: Settings) => void;
}

/**
 * Relay connection settings. A modal on purpose: changing the address tears the
 * link down, so it must interrupt rather than sit alongside the controls.
 */
export function RelaySettingsSheet({ visible, settings, diagnostics, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed each time it opens, so a cancelled edit does not linger.
  useEffect(() => {
    if (visible) {
      setDraft(settings);
      setError(null);
      setShowToken(false);
    }
  }, [visible, settings]);

  const handleSave = () => {
    const trimmed: Settings = {
      relayUrl: draft.relayUrl.trim(),
      token: draft.token.trim(),
      room: draft.room.trim() === '' ? 'default' : draft.room.trim(),
    };
    const problem = validateSettings(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    onSave(trimmed);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.centre}
        >
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>إعدادات الاتصال</Text>
              <Pressable onPress={onClose} hitSlop={12}>
                <Text style={styles.close}>إغلاق</Text>
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
              <Text style={styles.label}>عنوان الخادم</Text>
              <TextInput
                value={draft.relayUrl}
                onChangeText={(relayUrl) => setDraft((prev) => ({ ...prev, relayUrl }))}
                placeholder="wss://car.your-guide.co/car-ws"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
              />

              <Text style={styles.label}>رمز الدخول</Text>
              <View style={styles.tokenRow}>
                <TextInput
                  value={draft.token}
                  onChangeText={(token) => setDraft((prev) => ({ ...prev, token }))}
                  placeholder="الرمز المشترك"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={!showToken}
                  style={[styles.input, styles.tokenInput]}
                />
                <View style={styles.showRow}>
                  <Text style={styles.showLabel}>إظهار</Text>
                  <Switch value={showToken} onValueChange={setShowToken} />
                </View>
              </View>

              <Text style={styles.label}>الغرفة</Text>
              <TextInput
                value={draft.room}
                onChangeText={(room) => setDraft((prev) => ({ ...prev, room }))}
                placeholder="default"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.hint}>
                يجب أن تطابق الغرفة المضبوطة في تطبيق المشغّل.
              </Text>

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable style={styles.saveBtn} onPress={handleSave}>
                <Text style={styles.saveText}>حفظ</Text>
              </Pressable>

              <Text style={styles.diagTitle}>التشخيص</Text>
              {diagnostics.map((row) => (
                <View key={row.label} style={styles.diagRow}>
                  <Text style={styles.diagLabel}>{row.label}</Text>
                  <Text style={styles.diagValue}>{row.value}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  centre: { flex: 1, justifyContent: 'flex-end' },
  card: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '88%',
    paddingBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ddd',
  },
  title: { fontSize: 17, fontWeight: '700' },
  close: { fontSize: 15, color: '#2196F3' },
  body: { padding: 16, gap: 6 },
  label: { fontSize: 13, color: '#555', marginTop: 10 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenInput: { flex: 1 },
  showRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  showLabel: { fontSize: 12, color: '#666' },
  hint: { fontSize: 12, color: '#888', marginTop: 4 },
  error: { color: '#c62828', fontSize: 13, marginTop: 10 },
  saveBtn: {
    backgroundColor: '#2196F3',
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 18,
  },
  saveText: { color: '#fff', textAlign: 'center', fontSize: 16, fontWeight: '600' },
  diagTitle: { fontSize: 13, fontWeight: '700', color: '#555', marginTop: 24, marginBottom: 4 },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  diagLabel: { fontSize: 13, color: '#777' },
  diagValue: { fontSize: 13, color: '#222', fontVariant: ['tabular-nums'] },
});
