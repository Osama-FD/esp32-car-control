/**
 * The single funnel every output goes through.
 *
 * Both the local on-screen controls and the operator's control frames write
 * here, and exactly one of them is allowed to at a time. Everything that
 * reaches the ESP32 leaves from this file, which is what makes the watchdog
 * below trustworthy — there is no second path that could keep the car moving.
 *
 * Three layers stop the car, and this file is the middle one:
 *
 *   | Layer                  | Trigger                        | Latency |
 *   | relay all-stop         | operator's socket closes       | immediate |
 *   | THIS network watchdog  | no control frame for ~400 ms   | ~400 ms |
 *   | ESP32 watchdog         | no valid USB packet for 500 ms | <=500 ms |
 *
 * The ESP32's own timeout does NOT cover the case this file exists for: if the
 * network stalls while Phone 1 keeps happily rewriting the last command it
 * heard at 150 ms, the ESP32 sees a healthy stream of valid packets and drives
 * on. Only this watchdog notices that the *source* went quiet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { TUNING } from '../config';
import { NEUTRAL, type ControlState } from '../protocol';
import type { UsbLink } from '../usb/useUsbLink';

export interface CarOutput {
  /** Current output, mutated in place. Read it; never keep a copy. */
  read: () => ControlState;
  /** Local UI writes. Ignored while the remote link owns the car. */
  setLocal: (patch: Partial<ControlState>) => void;
  /** A control frame from the operator. Ignored unless remote mode is on. */
  applyRemote: (control: ControlState) => void;
  /** Zero everything now. Safe to call from anywhere, including unmount paths. */
  allStop: () => void;
  /** True once the watchdog has fired and not yet been cleared by a new frame. */
  watchdogTripped: boolean;
  /** Control frames accepted from the operator since remote mode came up. */
  remoteFramesRef: React.RefObject<number>;
  /** ms since the last accepted frame, or null if none has arrived yet. */
  frameAgeMs: () => number | null;
}

export function useCarOutput(usb: UsbLink, remoteActive: boolean): CarOutput {
  const outputRef = useRef<ControlState>({ ...NEUTRAL });
  const lastRemoteAtRef = useRef(0);
  const remoteFramesRef = useRef(0);
  const [watchdogTripped, setWatchdogTripped] = useState(false);

  // The keepalive and watchdog run from timers created once; they must see the
  // live values, not the ones captured when the effect was set up.
  const remoteActiveRef = useRef(remoteActive);
  remoteActiveRef.current = remoteActive;
  const usbRef = useRef(usb);
  usbRef.current = usb;

  const writeNow = useCallback(() => {
    usbRef.current.write(outputRef.current);
  }, []);

  const allStop = useCallback(() => {
    outputRef.current.drive = 0;
    outputRef.current.steer = 0;
    outputRef.current.pan = 0;
    outputRef.current.tilt = 0;
    writeNow();
  }, [writeNow]);

  const setLocal = useCallback((patch: Partial<ControlState>) => {
    // While the operator has the car, the on-screen controls are inert. They are
    // also visually disabled, but a race between a finger and a mode switch
    // must not be able to inject a command.
    if (remoteActiveRef.current) return;
    Object.assign(outputRef.current, patch);
    writeNow();
  }, [writeNow]);

  const applyRemote = useCallback((control: ControlState) => {
    if (!remoteActiveRef.current) return;
    outputRef.current.drive = control.drive;
    outputRef.current.steer = control.steer;
    outputRef.current.pan = control.pan;
    outputRef.current.tilt = control.tilt;
    lastRemoteAtRef.current = Date.now();
    remoteFramesRef.current++;
    setWatchdogTripped((prev) => (prev ? false : prev));
    writeNow();
  }, [writeNow]);

  const frameAgeMs = useCallback(
    () => (lastRemoteAtRef.current === 0 ? null : Date.now() - lastRemoteAtRef.current),
    [],
  );

  // --- USB keepalive -------------------------------------------------------
  // Rewrite the current output on a fixed interval whether or not it changed,
  // so the ESP32's 500 ms timeout never trips during a long press or between
  // network frames. This is the behaviour the local app has always had.
  useEffect(() => {
    if (!usb.connected) return undefined;
    const timer = setInterval(writeNow, TUNING.usbKeepaliveMs);
    return () => clearInterval(timer);
  }, [usb.connected, writeNow]);

  // --- Network watchdog ----------------------------------------------------
  useEffect(() => {
    if (!remoteActive || !usb.connected) return undefined;
    const timer = setInterval(() => {
      // Nothing has arrived yet: the output is still neutral, so there is
      // nothing to stop and nothing worth alarming about.
      if (lastRemoteAtRef.current === 0) return;
      if (Date.now() - lastRemoteAtRef.current <= TUNING.networkWatchdogMs) return;
      const out = outputRef.current;
      const alreadyStopped = out.drive === 0 && out.steer === 0 && out.pan === 0 && out.tilt === 0;
      if (!alreadyStopped) allStop();
      setWatchdogTripped((prev) => (prev ? prev : true));
    }, TUNING.watchdogTickMs);
    return () => clearInterval(timer);
  }, [remoteActive, usb.connected, allStop]);

  // --- Mode changes --------------------------------------------------------
  // Switching either way zeroes the car, so a throttle held in one mode cannot
  // survive into the other.
  useEffect(() => {
    lastRemoteAtRef.current = 0;
    remoteFramesRef.current = 0;
    setWatchdogTripped(false);
    allStop();
  }, [remoteActive, allStop]);

  // --- Backgrounding -------------------------------------------------------
  // A locked phone or an incoming call must not leave the car driving. In
  // remote mode the operator is still sending, so this is the case the network
  // watchdog cannot see.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') allStop();
    });
    return () => sub.remove();
  }, [allStop]);

  // Losing the port entirely: nothing to write to, but keep the in-memory state
  // honest so a reconnect does not resume a stale command.
  useEffect(() => {
    if (!usb.connected) {
      outputRef.current = { ...NEUTRAL };
    }
  }, [usb.connected]);

  // Memoised because callers put this object in effect dependency arrays: a
  // fresh identity every render would re-run the local-control write and the
  // relay subscription on every single render.
  return useMemo(
    () => ({
      read: () => outputRef.current,
      setLocal,
      applyRemote,
      allStop,
      watchdogTripped,
      remoteFramesRef,
      frameAgeMs,
    }),
    [setLocal, applyRemote, allStop, watchdogTripped, frameAgeMs],
  );
}
