/**
 * The relay socket, car side.
 *
 * Deliberately a near-copy of `phone2-app/src/net/useRelay.ts`: registration,
 * reconnection with backoff, and fan-out of relayed messages are the same
 * problem on both ends, and keeping the two diffable is worth more than any
 * factoring. The differences are exactly three:
 *
 *   1. `role: 'car'` in the hello.
 *   2. No ping loop of its own — the operator measures RTT, this side only
 *      answers. One prober per link is enough, and the car has better things
 *      to do than time round trips it does not display.
 *   3. `control` frames are the payload that matters here, and they are
 *      delivered to subscribers like everything else.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TUNING, type Settings } from '../config';
import type { ClientMessage, IceServer, ServerMessage } from '../protocol';
import { ERROR_HINTS } from '../protocol';

export type RelayStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'failed';

export interface RelayState {
  status: RelayStatus;
  /** True once the operator has registered in the same room. */
  peerConnected: boolean;
  /** ICE servers the relay handed us in its welcome message. */
  iceServers: IceServer[];
  /** Last human-readable problem, cleared on a successful registration. */
  error: string | null;
  room: string | null;
}

export interface RelayApi extends RelayState {
  send: (msg: ClientMessage) => boolean;
  /** Register a handler for relayed messages. Returns an unsubscribe function. */
  subscribe: (handler: (msg: ServerMessage) => void) => () => void;
  connect: () => void;
  disconnect: () => void;
}

const INITIAL: RelayState = {
  status: 'idle',
  peerConnected: false,
  iceServers: [],
  error: null,
  room: null,
};

export function useRelay(settings: Settings): RelayApi {
  const [state, setState] = useState<RelayState>(INITIAL);

  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(new Set<(msg: ServerMessage) => void>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const wantConnectedRef = useRef(false);

  // Settings can change while a socket is open; the reconnect path must pick up
  // the new values.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const send = useCallback((msg: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1 /* OPEN */) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const subscribe = useCallback((handler: (msg: ServerMessage) => void) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const openSocket = useCallback(() => {
    const { relayUrl, token, room } = settingsRef.current;

    // Close any half-dead socket before opening another, or the relay will see
    // two cars and evict the new one's predecessor mid-handshake.
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      socketRef.current.onmessage = null;
      socketRef.current.onopen = null;
      try {
        socketRef.current.close();
      } catch {
        // already gone
      }
      socketRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      status: attemptRef.current === 0 ? 'connecting' : 'reconnecting',
    }));

    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl);
    } catch (err) {
      setState((prev) => ({ ...prev, status: 'failed', error: `عنوان غير صالح: ${String(err)}` }));
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      send({ type: 'hello', role: 'car', token, room, name: 'car-phone' });
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      handleServerMessage(msg);
    };

    socket.onerror = () => {
      // React Native gives no useful detail here; onclose follows and carries
      // the code, so only set a message if nothing better arrives.
      setState((prev) => (prev.error ? prev : { ...prev, error: 'تعذّر الوصول إلى خادم الربط.' }));
    };

    socket.onclose = (event) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;

      setState((prev) => ({
        ...prev,
        status: wantConnectedRef.current ? 'reconnecting' : 'idle',
        peerConnected: false,
        // 4003 is the relay's "unauthorized"; retrying with the same token is
        // pointless, so surface it plainly instead of a generic drop message.
        error: event?.code === 4003 ? ERROR_HINTS.bad_token ?? 'غير مصرّح.' : prev.error,
      }));

      if (!wantConnectedRef.current) return;
      if (event?.code === 4003) {
        wantConnectedRef.current = false;
        setState((prev) => ({ ...prev, status: 'failed' }));
        return;
      }
      scheduleReconnect();
    };

    function handleServerMessage(msg: ServerMessage) {
      switch (msg.type) {
        case 'welcome':
          attemptRef.current = 0;
          setState((prev) => ({
            ...prev,
            status: 'online',
            room: msg.room,
            peerConnected: msg.peerConnected,
            iceServers: msg.iceServers ?? [],
            error: null,
          }));
          break;

        case 'peer-joined':
          setState((prev) => ({ ...prev, peerConnected: true }));
          break;

        case 'peer-left':
          setState((prev) => ({ ...prev, peerConnected: false }));
          break;

        case 'ping':
          // The operator times the round trip; answer so its RTT pill works.
          send({ type: 'pong', id: msg.id, t: msg.t });
          break;

        case 'error':
          setState((prev) => ({
            ...prev,
            error: ERROR_HINTS[msg.code] ?? `${msg.code}: ${msg.message}`,
          }));
          break;

        default:
          break;
      }

      for (const handler of handlersRef.current) handler(msg);
    }

    function scheduleReconnect() {
      if (reconnectTimerRef.current) return;
      const attempt = attemptRef.current++;
      const base = Math.min(TUNING.reconnectMinMs * 2 ** attempt, TUNING.reconnectMaxMs);
      // Jitter keeps a car and a controller that dropped together from
      // reconnecting in lockstep forever.
      const delay = base * (0.7 + Math.random() * 0.6);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (wantConnectedRef.current) openSocket();
      }, delay);
    }
  }, [send]);

  const connect = useCallback(() => {
    wantConnectedRef.current = true;
    attemptRef.current = 0;
    setState((prev) => ({ ...prev, error: null }));
    openSocket();
  }, [openSocket]);

  const disconnect = useCallback(() => {
    wantConnectedRef.current = false;
    clearTimers();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try {
        socket.send(JSON.stringify({ type: 'bye' }));
      } catch {
        // best effort
      }
      socket.close(1000, 'car disconnected');
    }
    setState({ ...INITIAL });
  }, [clearTimers]);

  useEffect(() => () => {
    wantConnectedRef.current = false;
    clearTimers();
    socketRef.current?.close();
    socketRef.current = null;
  }, [clearTimers]);

  return useMemo(
    () => ({ ...state, send, subscribe, connect, disconnect }),
    [state, send, subscribe, connect, disconnect],
  );
}
