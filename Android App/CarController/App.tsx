import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView } from 'react-native';
// ScrollView and TouchableOpacity come from gesture handler, not react-native.
// React Native's responder system grants one responder app-wide, so an RN
// TouchableOpacity could not be held while the steering wheel was turned:
// whichever control grabbed the responder second was either ignored or
// cancelled the first, which is why drive and steer never worked together.
// Gesture handler's versions are per-view, so each control keeps its own
// finger — and the scroll view has to come from the same system so it does not
// steal the wheel's drag back through the old responder path.
import {
  GestureHandlerRootView,
  ScrollView,
  TouchableOpacity,
} from 'react-native-gesture-handler';
import Slider from '@react-native-community/slider';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';

import { RemotePanel } from './src/components/RemotePanel';
import { SteeringWheel } from './src/components/SteeringWheel';
import { RelaySettingsSheet } from './src/components/RelaySettingsSheet';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, validateSettings, type Settings } from './src/config';
import { useCarOutput } from './src/control/useCarOutput';
import { useRelay } from './src/net/useRelay';
import { useWebRTC } from './src/net/useWebRTC';
import { asAxis, type ControlState } from './src/protocol';
import { useUsbLink } from './src/usb/useUsbLink';

const WHEEL_SIZE = 150;

export default function App() {
  // The screen must not sleep: a locked phone stops the keepalive, and the car
  // coasts until the ESP32's watchdog trips.
  useKeepAwake();

  const usb = useUsbLink();

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [remoteMode, setRemoteMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((loaded) => { if (!cancelled) setSettings(loaded); })
      .catch(() => { if (!cancelled) setSettings({ ...DEFAULT_SETTINGS }); });
    return () => { cancelled = true; };
  }, []);

  // Mounted on a car and streaming, the phone should be landscape so the
  // operator's landscape viewport is not letterboxed. On the bench it stays
  // portrait, which is how the local UI has always been laid out.
  useEffect(() => {
    void ScreenOrientation.lockAsync(
      remoteMode
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  }, [remoteMode]);

  // The USB port going away must not leave the app believing it is driving.
  useEffect(() => {
    if (!usb.connected && remoteMode) setRemoteMode(false);
  }, [usb.connected, remoteMode]);

  if (!settings) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.status}>جارٍ تحميل الإعدادات…</Text>
      </SafeAreaView>
    );
  }

  return (
    // GestureHandlerRootView must wrap everything: it is what lets the wheel
    // and the drive buttons each own a finger. Without it the gesture-handler
    // controls below silently stop responding on Android.
    <GestureHandlerRootView style={styles.container}>
      <Car
        usb={usb}
        settings={settings}
        setSettings={setSettings}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        remoteMode={remoteMode}
        setRemoteMode={setRemoteMode}
      />
    </GestureHandlerRootView>
  );
}

interface CarProps {
  usb: ReturnType<typeof useUsbLink>;
  settings: Settings;
  setSettings: (next: Settings) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  remoteMode: boolean;
  setRemoteMode: (on: boolean) => void;
}

/**
 * Split from `App` so the relay and WebRTC hooks only ever run with real
 * settings — they open a socket on connect, and mounting them against a
 * placeholder URL would burn a reconnect cycle on every cold start.
 */
function Car({
  usb,
  settings,
  setSettings,
  settingsOpen,
  setSettingsOpen,
  remoteMode,
  setRemoteMode,
}: CarProps) {
  const relay = useRelay(settings);
  const output = useCarOutput(usb, remoteMode);
  const media = useWebRTC(relay, remoteMode);

  const configProblem = validateSettings(settings);

  // --- local UI state (display only; the funnel owns what is actually sent) --
  const [speedMagnitude, setSpeedMagnitude] = useState(0);
  const [speedA, setSpeedA] = useState(0);
  const [steer, setSteer] = useState(0);
  const [pan, setPan] = useState(0);
  const [tilt, setTilt] = useState(0);

  const localEnabled = usb.connected && !remoteMode;

  // Local controls write through the same funnel as the network, which ignores
  // them while the operator has the car.
  useEffect(() => {
    output.setLocal({ drive: speedA, steer, pan: asAxis(pan), tilt: asAxis(tilt) });
  }, [speedA, steer, pan, tilt, output]);

  // Leaving remote mode must not resurrect whatever the local sliders last held.
  useEffect(() => {
    if (remoteMode) {
      setSpeedA(0);
      setSteer(0);
      setPan(0);
      setTilt(0);
    }
  }, [remoteMode]);

  // --- relay lifecycle -----------------------------------------------------

  const connectRef = useRef(relay.connect);
  connectRef.current = relay.connect;
  const disconnectRef = useRef(relay.disconnect);
  disconnectRef.current = relay.disconnect;

  useEffect(() => {
    if (!remoteMode) {
      disconnectRef.current();
      return undefined;
    }
    if (configProblem) return undefined;
    connectRef.current();
    return undefined;
    // Re-dial when the address, credentials or room change under us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteMode, settings.relayUrl, settings.token, settings.room, configProblem]);

  // Control frames -> the funnel. This is the whole point of the network layer.
  useEffect(() => {
    if (!remoteMode) return undefined;
    return relay.subscribe((msg) => {
      switch (msg.type) {
        case 'control':
          output.applyRemote({
            drive: msg.drive,
            steer: msg.steer,
            pan: asAxis(msg.pan),
            tilt: asAxis(msg.tilt),
          } satisfies ControlState);
          break;

        // The relay sends an all-stop control frame before this, but the
        // operator may also have vanished without one. Stop regardless.
        case 'peer-left':
          output.allStop();
          break;

        default:
          break;
      }
    });
  }, [remoteMode, relay, output]);

  // A dropped relay socket is the operator going away as far as the car is
  // concerned. The watchdog would catch it ~400 ms later; this is immediate.
  useEffect(() => {
    if (remoteMode && relay.status !== 'online') output.allStop();
  }, [remoteMode, relay.status, output]);

  // --- settings ------------------------------------------------------------

  const handleSave = useCallback((next: Settings) => {
    setSettings(next);
    void saveSettings(next);
  }, [setSettings]);

  const handleToggleRemote = useCallback((on: boolean) => {
    // Never hand over or take back the car while something is held.
    output.allStop();
    setRemoteMode(on);
  }, [output, setRemoteMode]);

  const diagnostics = useMemo(() => [
    { label: 'USB', value: usb.connected ? 'متصل' : 'مفصول' },
    { label: 'الخادم', value: relay.status },
    { label: 'الغرفة', value: relay.room ?? settings.room },
    { label: 'المشغّل', value: relay.peerConnected ? 'متصل' : 'غير متصل' },
    { label: 'البث', value: media.status },
    { label: 'خوادم ICE', value: String(relay.iceServers.length) },
    { label: 'حزم USB', value: String(usb.writesRef.current ?? 0) },
    ...(configProblem ? [{ label: 'الإعدادات', value: configProblem }] : []),
    ...(relay.error ? [{ label: 'خطأ الخادم', value: relay.error }] : []),
    ...(media.error ? [{ label: 'خطأ البث', value: media.error }] : []),
    // `settingsOpen` is in here on purpose: the USB packet count lives in a ref
    // that does not trigger renders, so recomputing when the sheet opens is what
    // makes that number current rather than whatever it was last render.
  ], [
    settingsOpen, usb.connected, usb.writesRef, relay.status, relay.room,
    relay.peerConnected, relay.iceServers.length, relay.error, media.status,
    media.error, settings.room, configProblem,
  ]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.status}>{usb.status}</Text>

        {!usb.connected && (
          <TouchableOpacity
            style={styles.connectBtn}
            onPress={usb.connect}
            disabled={usb.connecting}
          >
            <Text style={styles.connectText}>
              {usb.connecting ? 'جارٍ الاتصال...' : 'اتصال بالـ ESP32'}
            </Text>
          </TouchableOpacity>
        )}

        <RemotePanel
          remoteMode={remoteMode}
          onToggleRemote={handleToggleRemote}
          usbConnected={usb.connected}
          relayStatus={relay.status}
          operatorConnected={relay.peerConnected}
          mediaStatus={media.status}
          relayError={configProblem ?? relay.error}
          mediaError={media.error}
          output={output}
          localStream={media.localStream}
          cameraEnabled={media.cameraEnabled}
          onToggleCamera={media.toggleCamera}
          micEnabled={media.micEnabled}
          onToggleMic={media.toggleMic}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <View style={styles.sliderBlock}>
          <Text style={styles.label}>Speed: {speedMagnitude}</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={speedMagnitude}
            onValueChange={setSpeedMagnitude}
            disabled={!localEnabled}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Motor A: {speedA}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.dirBtn, !localEnabled && styles.dirBtnOff]}
              disabled={!localEnabled}
              onPressIn={() => setSpeedA(speedMagnitude)}
              onPressOut={() => setSpeedA(0)}
            >
              <Text style={styles.dirBtnText}>Motor A Forward</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.dirBtn, !localEnabled && styles.dirBtnOff]}
              disabled={!localEnabled}
              onPressIn={() => setSpeedA(-speedMagnitude)}
              onPressOut={() => setSpeedA(0)}
            >
              <Text style={styles.dirBtnText}>Motor A Backward</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Steer: {steer}</Text>
          <SteeringWheel size={WHEEL_SIZE} disabled={!localEnabled} onChange={setSteer} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pan: {pan}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.dirBtn, !localEnabled && styles.dirBtnOff]}
              disabled={!localEnabled}
              onPressIn={() => setPan(-1)}
              onPressOut={() => setPan(0)}
            >
              <Text style={styles.dirBtnText}>Pan Left</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.dirBtn, !localEnabled && styles.dirBtnOff]}
              disabled={!localEnabled}
              onPressIn={() => setPan(1)}
              onPressOut={() => setPan(0)}
            >
              <Text style={styles.dirBtnText}>Pan Right</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tilt: {tilt}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.dirBtn, !localEnabled && styles.dirBtnOff]}
              disabled={!localEnabled}
              onPressIn={() => setTilt(-1)}
              onPressOut={() => setTilt(0)}
            >
              <Text style={styles.dirBtnText}>Tilt Up</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.dirBtn, !localEnabled && styles.dirBtnOff]}
              disabled={!localEnabled}
              onPressIn={() => setTilt(1)}
              onPressOut={() => setTilt(0)}
            >
              <Text style={styles.dirBtnText}>Tilt Down</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <RelaySettingsSheet
        visible={settingsOpen}
        settings={settings}
        diagnostics={diagnostics}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSave}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 40 },
  status: { fontSize: 18, textAlign: 'center', marginBottom: 20 },
  connectBtn: {
    backgroundColor: '#2196F3',
    padding: 15,
    borderRadius: 10,
    marginBottom: 30,
  },
  connectText: { color: '#fff', textAlign: 'center', fontSize: 16 },
  sliderBlock: { marginBottom: 30 },
  label: { fontSize: 16, marginBottom: 10, textAlign: 'center' },
  slider: { width: '100%', height: 40 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 16, marginBottom: 10, textAlign: 'center' },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dirBtn: {
    flex: 1,
    backgroundColor: '#4CAF50',
    paddingVertical: 16,
    borderRadius: 10,
    marginHorizontal: 5,
  },
  dirBtnOff: { backgroundColor: '#bdbdbd' },
  dirBtnText: { color: '#fff', textAlign: 'center', fontSize: 14 },
});
