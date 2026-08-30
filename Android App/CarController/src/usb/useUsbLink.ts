/**
 * The USB link to the ESP32-S3.
 *
 * Lifted out of App.tsx unchanged in behaviour — same packet format, same
 * permission dance, same hex-string transport — so that both the local UI and
 * the relay path write through one place. The only new thing is that the port
 * lives in a ref the control funnel can call from a timer.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { UsbSerialManager, Parity } from 'react-native-usb-serialport-for-android';

import type { ControlState } from '../protocol';

const PACKET_START = 0xaa;

const PERMISSION_POLL_INTERVAL_MS = 300;
const PERMISSION_TIMEOUT_MS = 15000;

/**
 * 6 bytes: [0xAA, drive, steer, pan, tilt, checksum], checksum = XOR of the
 * four preceding bytes. Signed values ride as two's-complement bytes; the
 * firmware reads them back as int8.
 */
export function buildPacket(drive: number, steer: number, pan: number, tilt: number): Uint8Array {
  const d = drive & 0xff;
  const st = steer & 0xff;
  const p = pan & 0xff;
  const t = tilt & 0xff;
  const checksum = (PACKET_START ^ d ^ st ^ p ^ t) & 0xff;
  return new Uint8Array([PACKET_START, d, st, p, t, checksum]);
}

const HEX_CHARS = '0123456789ABCDEF';

export function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    result += HEX_CHARS[(byte >> 4) & 0xf];
    result += HEX_CHARS[byte & 0xf];
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * tryRequestPermission() only fires the system dialog and returns immediately
 * (see react-native-usb-serialport-for-android's index.tsx docstring) — it does
 * not wait for the user's response. There is no broadcast/event for the result
 * either, so poll hasPermission() until it flips true or we time out.
 */
async function waitForPermission(deviceId: number): Promise<boolean> {
  const deadline = Date.now() + PERMISSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await UsbSerialManager.hasPermission(deviceId)) return true;
    await delay(PERMISSION_POLL_INTERVAL_MS);
  }
  return false;
}

export interface UsbLink {
  connected: boolean;
  connecting: boolean;
  status: string;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Fire-and-forget. Returns false when there is no port; never throws, because
   * it is called from a 150 ms timer and an unhandled rejection there would take
   * the keepalive down with it.
   */
  write: (control: ControlState) => boolean;
  /** Frames written since the port opened — the local half of the diagnostics. */
  writesRef: React.RefObject<number>;
}

export function useUsbLink(): UsbLink {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('غير متصل');

  const portRef = useRef<any>(null);
  const writesRef = useRef(0);

  const connect = useCallback(async () => {
    if (portRef.current || connecting) return;
    setConnecting(true);
    try {
      const devices = await UsbSerialManager.list();
      console.log('USB devices:', devices);
      const device = devices[0];
      if (!device) {
        setStatus('ما في أجهزة USB متصلة');
        return;
      }

      const deviceId = device.deviceId;
      const alreadyGranted = await UsbSerialManager.tryRequestPermission(deviceId);
      const granted = alreadyGranted || (await waitForPermission(deviceId));
      if (!granted) {
        setStatus('تم رفض إذن USB');
        return;
      }

      portRef.current = await UsbSerialManager.open(deviceId, {
        baudRate: 115200,
        parity: Parity.None,
        dataBits: 8,
        stopBits: 1,
      });
      writesRef.current = 0;
      setConnected(true);
      setStatus('متصل ✅');
    } catch (err) {
      console.log('Connection error:', err);
      setStatus('فشل الاتصال');
    } finally {
      setConnecting(false);
    }
  }, [connecting]);

  const disconnect = useCallback(async () => {
    const port = portRef.current;
    portRef.current = null;
    setConnected(false);
    setStatus('غير متصل');
    if (port) {
      try {
        await port.close();
      } catch {
        // already gone
      }
    }
  }, []);

  const write = useCallback((control: ControlState): boolean => {
    const port = portRef.current;
    if (!port) return false;
    try {
      const packet = buildPacket(control.drive, control.steer, control.pan, control.tilt);
      // Deliberately not awaited: the caller is a timer, and a slow write must
      // not delay the next tick. Errors are swallowed for the same reason.
      port.send(bytesToHex(packet))?.catch?.(() => undefined);
      writesRef.current++;
      return true;
    } catch (err) {
      console.log('Send error:', err);
      return false;
    }
  }, []);

  useEffect(() => () => {
    portRef.current?.close?.();
    portRef.current = null;
  }, []);

  return { connected, connecting, status, connect, disconnect, write, writesRef };
}
