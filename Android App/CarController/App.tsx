import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  PanResponder,
  Animated,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { UsbSerialManager, Parity } from 'react-native-usb-serialport-for-android';

const PACKET_START = 0xaa;

function buildPacket(
  speedA: number,
  steer: number,
  pan: number,
  tilt: number
): Uint8Array {
  const a = speedA & 0xff;
  const st = steer & 0xff;
  const p = pan & 0xff;
  const t = tilt & 0xff;
  const checksum = (PACKET_START ^ a ^ st ^ p ^ t) & 0xff;
  return new Uint8Array([PACKET_START, a, st, p, t, checksum]);
}

const HEX_CHARS = '0123456789ABCDEF';

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    result += HEX_CHARS[(byte >> 4) & 0xf];
    result += HEX_CHARS[byte & 0xf];
  }
  return result;
}

const PERMISSION_POLL_INTERVAL_MS = 300;
const PERMISSION_TIMEOUT_MS = 15000;
const KEEPALIVE_INTERVAL_MS = 150;

const WHEEL_SIZE = 150;
const WHEEL_MAX_ANGLE_DEG = 90; // quarter turn each way = full lock

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Angle (in degrees) of a touch point relative to the wheel's center.
function angleFromCenter(x: number, y: number): number {
  const c = WHEEL_SIZE / 2;
  return (Math.atan2(y - c, x - c) * 180) / Math.PI;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// tryRequestPermission() only fires the system dialog and returns immediately
// (see react-native-usb-serialport-for-android's index.tsx docstring) - it does
// not wait for the user's response. There's no broadcast/event for the result
// either, so we have to poll hasPermission() until it flips true or we time out.
async function waitForPermission(deviceId: number): Promise<boolean> {
  const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await UsbSerialManager.hasPermission(deviceId)) {
      return true;
    }
    await delay(PERMISSION_POLL_INTERVAL_MS);
  }
  return false;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [statusText, setStatusText] = useState('غير متصل');
  const [speedMagnitude, setSpeedMagnitude] = useState(0);
  const [speedA, setSpeedA] = useState(0);
  const [steer, setSteer] = useState(0);
  const [pan, setPan] = useState(0);
  const [tilt, setTilt] = useState(0);
  const portRef = useRef<any>(null);

  // Mirrors of the latest speedA/steer/pan/tilt, for the keepalive interval
  // below to read without needing to restart on every state change.
  const speedARef = useRef(0);
  const steerRef = useRef(0);
  const panRef = useRef(0);
  const tiltRef = useRef(0);

  // Mirrors `connected`, so the PanResponder (created once via useRef) can
  // check the latest value without going stale.
  const connectedRef = useRef(false);
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Steering wheel drag state.
  const rotationAnim = useRef(new Animated.Value(0)).current;
  const touchStartAngleRef = useRef(0);
  const dragStartRotationRef = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => connectedRef.current,
      onMoveShouldSetPanResponder: () => connectedRef.current,
      onPanResponderGrant: (evt) => {
        touchStartAngleRef.current = angleFromCenter(
          evt.nativeEvent.locationX,
          evt.nativeEvent.locationY
        );
        rotationAnim.stopAnimation((currentValue) => {
          dragStartRotationRef.current = currentValue;
        });
      },
      onPanResponderMove: (evt) => {
        const currentAngle = angleFromCenter(
          evt.nativeEvent.locationX,
          evt.nativeEvent.locationY
        );
        let delta = currentAngle - touchStartAngleRef.current;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;

        const newRotation = clamp(
          dragStartRotationRef.current + delta,
          -WHEEL_MAX_ANGLE_DEG,
          WHEEL_MAX_ANGLE_DEG
        );
        rotationAnim.setValue(newRotation);
        setSteer(Math.round((newRotation / WHEEL_MAX_ANGLE_DEG) * 100));
      },
      onPanResponderRelease: () => {
        setSteer(0);
        Animated.spring(rotationAnim, {
          toValue: 0,
          friction: 6,
          useNativeDriver: true,
        }).start();
      },
      onPanResponderTerminate: () => {
        setSteer(0);
        Animated.spring(rotationAnim, {
          toValue: 0,
          friction: 6,
          useNativeDriver: true,
        }).start();
      },
    })
  ).current;

  const connectToDevice = async () => {
    if (isConnecting || connected) return;
    setIsConnecting(true);
    try {
      const devices = await UsbSerialManager.list();
      console.log('USB devices:', devices);
      if (devices.length === 0) {
        setStatusText('ما في أجهزة USB متصلة');
        return;
      }

      const deviceId = devices[0].deviceId;
      const alreadyGranted = await UsbSerialManager.tryRequestPermission(deviceId);
      const granted = alreadyGranted || (await waitForPermission(deviceId));
      if (!granted) {
        setStatusText('تم رفض إذن USB');
        return;
      }

      const port = await UsbSerialManager.open(deviceId, {
        baudRate: 115200,
        parity: Parity.None,
        dataBits: 8,
        stopBits: 1,
      });

      portRef.current = port;
      setConnected(true);
      setStatusText('متصل ✅');
    } catch (err) {
      console.log('Connection error:', err);
      setStatusText('فشل الاتصال');
    } finally {
      setIsConnecting(false);
    }
  };

  const sendCommand = async (
    a: number,
    steerValue: number,
    p: number,
    t: number
  ) => {
    if (!portRef.current) return;
    try {
      const packet = buildPacket(a, steerValue, p, t);
      console.log('Sending packet bytes:', Array.from(packet));
      await portRef.current.send(bytesToHex(packet));
    } catch (err) {
      console.log('Send error:', err);
    }
  };

  useEffect(() => {
    speedARef.current = speedA;
    steerRef.current = steer;
    panRef.current = pan;
    tiltRef.current = tilt;
    sendCommand(speedA, steer, pan, tilt);
  }, [speedA, steer, pan, tilt]);

  // Keepalive: resend the current packet on a fixed interval while connected,
  // so the ESP32's safety timeout doesn't trigger during a long button press.
  useEffect(() => {
    if (!connected) return;
    const intervalId = setInterval(() => {
      sendCommand(
        speedARef.current,
        steerRef.current,
        panRef.current,
        tiltRef.current
      );
    }, KEEPALIVE_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [connected]);

  useEffect(() => {
    return () => {
      if (portRef.current) {
        portRef.current.close();
      }
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.status}>{statusText}</Text>

        {!connected && (
          <TouchableOpacity
            style={styles.connectBtn}
            onPress={connectToDevice}
            disabled={isConnecting}
          >
            <Text style={styles.connectText}>
              {isConnecting ? 'جارٍ الاتصال...' : 'اتصال بالـ ESP32'}
            </Text>
          </TouchableOpacity>
        )}

        <View style={styles.sliderBlock}>
          <Text style={styles.label}>Speed: {speedMagnitude}</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            step={1}
            value={speedMagnitude}
            onValueChange={setSpeedMagnitude}
            disabled={!connected}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Motor A: {speedA}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.dirBtn}
              disabled={!connected}
              onPressIn={() => setSpeedA(speedMagnitude)}
              onPressOut={() => setSpeedA(0)}
            >
              <Text style={styles.dirBtnText}>Motor A Forward</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dirBtn}
              disabled={!connected}
              onPressIn={() => setSpeedA(-speedMagnitude)}
              onPressOut={() => setSpeedA(0)}
            >
              <Text style={styles.dirBtnText}>Motor A Backward</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Steer: {steer}</Text>
          <View
            style={styles.wheel}
            {...panResponder.panHandlers}
          >
            <Animated.View
              style={[
                styles.wheelInner,
                {
                  transform: [
                    {
                      rotate: rotationAnim.interpolate({
                        inputRange: [-180, 180],
                        outputRange: ['-180deg', '180deg'],
                      }),
                    },
                  ],
                },
              ]}
            >
              <View style={styles.wheelMarker} />
            </Animated.View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pan: {pan}</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.dirBtn}
              disabled={!connected}
              onPressIn={() => setPan(-1)}
              onPressOut={() => setPan(0)}
            >
              <Text style={styles.dirBtnText}>Pan Left</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dirBtn}
              disabled={!connected}
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
              style={styles.dirBtn}
              disabled={!connected}
              onPressIn={() => setTilt(-1)}
              onPressOut={() => setTilt(0)}
            >
              <Text style={styles.dirBtnText}>Tilt Up</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.dirBtn}
              disabled={!connected}
              onPressIn={() => setTilt(1)}
              onPressOut={() => setTilt(0)}
            >
              <Text style={styles.dirBtnText}>Tilt Down</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
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
  dirBtnText: { color: '#fff', textAlign: 'center', fontSize: 14 },
  wheel: {
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
    borderRadius: WHEEL_SIZE / 2,
    backgroundColor: '#333',
    borderWidth: 4,
    borderColor: '#555',
    alignSelf: 'center',
  },
  wheelInner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
  },
  wheelMarker: {
    width: 6,
    height: WHEEL_SIZE / 2 - 10,
    marginTop: 10,
    backgroundColor: '#FF5252',
    borderRadius: 3,
  },
});
