/**
 * The car side of the media link — the answerer.
 *
 * The inverse of `phone2-app/src/net/useWebRTC.ts`, and a direct port of the
 * flow in `relay-server/tools/car-simulator.html`, which is the working
 * reference for exactly this handshake.
 *
 * The operator always makes the offer. This side never initiates: it waits for
 * an `offer`, applies it, attaches its camera and microphone, and answers.
 *
 * ORDER MATTERS. `setRemoteDescription(offer)` must happen BEFORE `addTrack`.
 * The operator offers one sendrecv audio transceiver and one recvonly video
 * transceiver; applying the remote description first is what makes our tracks
 * pair with those transceivers instead of appending new m-lines the operator
 * never asked for — which would answer with a shape it cannot render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import InCallManager from 'react-native-incall-manager';
import {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';

import type { IceServer, ServerMessage } from '../protocol';
import type { RelayApi } from './useRelay';
import { ensureMediaPermissions } from './permissions';

export type MediaStatus =
  | 'idle'          // not started
  | 'waiting'       // relay up, no offer yet
  | 'permission'    // asking for camera + microphone
  | 'answering'     // offer received, building the answer
  | 'live'          // peer connection established, media flowing
  | 'reconnecting'  // ICE dropped, waiting for the operator to renegotiate
  | 'failed';

export interface WebRTCApi {
  status: MediaStatus;
  /** Our own camera feed, for the local preview. */
  localStream: MediaStream | null;
  /** The operator's microphone, played through this phone's speaker. */
  remoteStream: MediaStream | null;
  cameraEnabled: boolean;
  toggleCamera: () => void;
  micEnabled: boolean;
  toggleMic: () => void;
  error: string | null;
}

const FALLBACK_ICE: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Start conservative. 720p30 over a car's mobile uplink is already optimistic,
 * and the control link must never have to compete with video for bandwidth.
 */
const VIDEO_CONSTRAINTS = {
  facingMode: 'environment',
  width: 1280,
  height: 720,
  frameRate: 30,
} as const;

export function useWebRTC(relay: RelayApi, enabled: boolean): WebRTCApi {
  const [status, setStatus] = useState<MediaStatus>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidate[]>([]);
  const answeringRef = useRef(false);
  const generationRef = useRef(0);
  const inCallStartedRef = useRef(false);

  const relayRef = useRef(relay);
  relayRef.current = relay;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // --- teardown ------------------------------------------------------------

  const closePeer = useCallback(() => {
    generationRef.current++;
    answeringRef.current = false;
    pendingIceRef.current = [];

    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      // Detach first: a closing connection still fires state changes, and those
      // would otherwise resurrect a status we have just cleared.
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    setRemoteStream(null);
  }, []);

  const releaseMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    if (inCallStartedRef.current) {
      InCallManager.stop();
      inCallStartedRef.current = false;
    }
  }, []);

  // --- capture -------------------------------------------------------------

  const getLocalStream = useCallback(async (): Promise<MediaStream> => {
    if (localStreamRef.current) return localStreamRef.current;

    setStatus('permission');
    const granted = await ensureMediaPermissions();
    if (!granted) {
      throw new Error('لم يُسمح باستخدام الكاميرا أو المايك — المشغّل لن يرى أو يسمع شيئاً.');
    }

    const stream = (await mediaDevices.getUserMedia({
      video: VIDEO_CONSTRAINTS,
      audio: true,
    })) as MediaStream;

    localStreamRef.current = stream;
    stream.getVideoTracks().forEach((t) => { t.enabled = cameraEnabled; });
    stream.getAudioTracks().forEach((t) => { t.enabled = micEnabled; });
    setLocalStream(stream);

    // Route the operator's voice to the loudspeaker. Nobody is holding this
    // phone to their ear — it is strapped to a car.
    if (!inCallStartedRef.current) {
      InCallManager.start({ media: 'video' });
      InCallManager.setForceSpeakerphoneOn(true);
      InCallManager.setKeepScreenOn(true);
      inCallStartedRef.current = true;
    }

    return stream;
  }, [cameraEnabled, micEnabled]);

  // --- the answer ----------------------------------------------------------

  const answerOffer = useCallback(async (sdp: string) => {
    if (answeringRef.current) return;
    answeringRef.current = true;
    const generation = ++generationRef.current;
    setError(null);

    try {
      // A fresh offer means the operator restarted negotiation; drop whatever
      // we had rather than trying to reuse it.
      const previous = pcRef.current;
      pcRef.current = null;
      if (previous) {
        previous.onicecandidate = null;
        previous.ontrack = null;
        previous.onconnectionstatechange = null;
        try { previous.close(); } catch { /* already closed */ }
      }
      pendingIceRef.current = [];

      const stream = await getLocalStream();
      if (generation !== generationRef.current) return;

      const iceServers = relayRef.current.iceServers.length > 0
        ? relayRef.current.iceServers
        : FALLBACK_ICE;

      const pc = new RTCPeerConnection({
        iceServers,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      pcRef.current = pc;

      pc.onicecandidate = (event: any) => {
        // A null candidate is end-of-candidates; forward it so the operator
        // stops waiting for more.
        relayRef.current.send({
          type: 'ice',
          candidate: event.candidate ? event.candidate.toJSON() : null,
        });
      };

      pc.ontrack = (event: any) => {
        const [stream0] = event.streams ?? [];
        if (stream0) setRemoteStream(stream0 as MediaStream);
      };

      pc.onconnectionstatechange = () => {
        switch (pc.connectionState) {
          case 'connected':
            setStatus('live');
            setError(null);
            break;
          case 'disconnected':
            setStatus('reconnecting');
            break;
          case 'failed':
            setStatus('failed');
            setError('فشل الاتصال المرئي. بدون خادم TURN هذا متوقّع على بيانات الجوال.');
            break;
          default:
            break;
        }
      };

      setStatus('answering');

      // See the header comment: remote description FIRST, then our tracks.
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      if (generation !== generationRef.current) return;

      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (generation !== generationRef.current) return;

      relayRef.current.send({ type: 'answer', sdp: pc.localDescription?.sdp ?? answer.sdp });

      // Candidates that raced ahead of the offer can be applied now.
      const queued = pendingIceRef.current.splice(0);
      for (const candidate of queued) {
        await pc.addIceCandidate(candidate).catch(() => undefined);
      }
    } catch (err) {
      if (generation === generationRef.current) {
        setStatus('failed');
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      answeringRef.current = false;
    }
  }, [getLocalStream]);

  // --- signalling from the relay -------------------------------------------

  useEffect(() => {
    return relay.subscribe((msg: ServerMessage) => {
      if (!enabledRef.current) return;

      switch (msg.type) {
        case 'offer':
          void answerOffer(msg.sdp);
          break;

        case 'ice': {
          if (!msg.candidate) return; // end-of-candidates
          const pc = pcRef.current;
          const candidate = new RTCIceCandidate(msg.candidate as any);
          if (!pc || !pc.remoteDescription) {
            pendingIceRef.current.push(candidate);
            return;
          }
          pc.addIceCandidate(candidate).catch(() => undefined);
          break;
        }

        case 'peer-left':
          closePeer();
          setStatus('waiting');
          break;

        default:
          break;
      }
    });
  }, [relay, answerOffer, closePeer]);

  // --- lifecycle -----------------------------------------------------------

  useEffect(() => {
    if (!enabled) {
      closePeer();
      releaseMedia();
      setStatus('idle');
      return;
    }
    setStatus((prev) => (prev === 'idle' ? 'waiting' : prev));
  }, [enabled, closePeer, releaseMedia]);

  useEffect(() => () => {
    closePeer();
    releaseMedia();
  }, [closePeer, releaseMedia]);

  // --- controls ------------------------------------------------------------

  const toggleCamera = useCallback(() => {
    setCameraEnabled((prev) => {
      const next = !prev;
      localStreamRef.current?.getVideoTracks().forEach((t) => { t.enabled = next; });
      return next;
    });
  }, []);

  const toggleMic = useCallback(() => {
    setMicEnabled((prev) => {
      const next = !prev;
      localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = next; });
      return next;
    });
  }, []);

  return {
    status,
    localStream,
    remoteStream,
    cameraEnabled,
    toggleCamera,
    micEnabled,
    toggleMic,
    error,
  };
}
