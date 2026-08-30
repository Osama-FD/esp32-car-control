import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { RTCView, type MediaStream } from 'react-native-webrtc';

import type { CarOutput } from '../control/useCarOutput';
import { NEUTRAL, type ControlState } from '../protocol';
import type { MediaStatus } from '../net/useWebRTC';
import type { RelayStatus } from '../net/useRelay';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

const TONE_COLOR: Record<Tone, string> = {
  ok: '#2e7d32',
  warn: '#ef6c00',
  bad: '#c62828',
  idle: '#9e9e9e',
};

const RELAY_LABEL: Record<RelayStatus, { text: string; tone: Tone }> = {
  idle: { text: 'مفصول', tone: 'idle' },
  connecting: { text: 'جارٍ الاتصال', tone: 'warn' },
  online: { text: 'الخادم', tone: 'ok' },
  reconnecting: { text: 'إعادة الاتصال', tone: 'warn' },
  failed: { text: 'فشل الخادم', tone: 'bad' },
};

const MEDIA_LABEL: Record<MediaStatus, { text: string; tone: Tone }> = {
  idle: { text: 'البث متوقف', tone: 'idle' },
  waiting: { text: 'بانتظار المشغّل', tone: 'warn' },
  permission: { text: 'الأذونات…', tone: 'warn' },
  answering: { text: 'جارٍ الرد', tone: 'warn' },
  live: { text: 'يبث', tone: 'ok' },
  reconnecting: { text: 'انقطع البث', tone: 'warn' },
  failed: { text: 'فشل البث', tone: 'bad' },
};

function Pill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: TONE_COLOR[tone] }]} />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

interface Props {
  remoteMode: boolean;
  onToggleRemote: (on: boolean) => void;
  usbConnected: boolean;
  relayStatus: RelayStatus;
  operatorConnected: boolean;
  mediaStatus: MediaStatus;
  relayError: string | null;
  mediaError: string | null;
  output: CarOutput;
  localStream: MediaStream | null;
  cameraEnabled: boolean;
  onToggleCamera: () => void;
  micEnabled: boolean;
  onToggleMic: () => void;
  onOpenSettings: () => void;
}

/** Refresh rate for the frame-age readout. Fast enough to watch, slow enough
 *  not to re-render the preview surface constantly. */
const POLL_MS = 250;

export function RemotePanel({
  remoteMode,
  onToggleRemote,
  usbConnected,
  relayStatus,
  operatorConnected,
  mediaStatus,
  relayError,
  mediaError,
  output,
  localStream,
  cameraEnabled,
  onToggleCamera,
  micEnabled,
  onToggleMic,
  onOpenSettings,
}: Props) {
  const [age, setAge] = useState<number | null>(null);
  const [frames, setFrames] = useState(0);
  const [live, setLive] = useState<ControlState>({ ...NEUTRAL });

  // Polled rather than pushed: control frames land up to 25x a second, and
  // re-rendering the video preview on each one would be wasteful.
  useEffect(() => {
    if (!remoteMode) {
      setAge(null);
      setFrames(0);
      setLive({ ...NEUTRAL });
      return undefined;
    }
    const timer = setInterval(() => {
      setAge(output.frameAgeMs());
      setFrames(output.remoteFramesRef.current ?? 0);
      const now = output.read();
      setLive((prev) =>
        prev.drive === now.drive && prev.steer === now.steer
          && prev.pan === now.pan && prev.tilt === now.tilt
          ? prev
          : { ...now },
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [remoteMode, output]);

  const relay = RELAY_LABEL[relayStatus];
  const media = MEDIA_LABEL[mediaStatus];
  const problem = relayError ?? mediaError;

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>التحكم عن بُعد</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={onOpenSettings} hitSlop={10}>
            <Text style={styles.settings}>إعدادات</Text>
          </Pressable>
          <Switch value={remoteMode} onValueChange={onToggleRemote} disabled={!usbConnected} />
        </View>
      </View>

      {!usbConnected ? (
        <Text style={styles.hint}>وصّل الـ ESP32 عبر USB أولاً.</Text>
      ) : null}

      {remoteMode ? (
        <>
          <View style={styles.pillRow}>
            <Pill label={relay.text} tone={relay.tone} />
            <Pill
              label={operatorConnected ? 'المشغّل متصل' : 'لا يوجد مشغّل'}
              tone={operatorConnected ? 'ok' : 'bad'}
            />
            <Pill label={media.text} tone={media.tone} />
          </View>

          <View style={styles.pillRow}>
            <Pill
              label={age === null ? 'لا أوامر بعد' : `آخر أمر ${age} م.ث`}
              tone={age === null ? 'idle' : age < 300 ? 'ok' : 'bad'}
            />
            <Pill label={`${frames} أمر`} tone="idle" />
          </View>

          {/* What is actually going out over USB right now — the car-side
              confirmation that the operator's commands are landing. */}
          <View style={styles.readout}>
            <Field label="DRV" value={live.drive} />
            <Field label="STR" value={live.steer} />
            <Field label="PAN" value={live.pan} />
            <Field label="TLT" value={live.tilt} />
          </View>

          {output.watchdogTripped ? (
            <View style={styles.alarm}>
              <Text style={styles.alarmText}>
                انقطعت الأوامر — تم تصفير المخرجات محلياً
              </Text>
            </View>
          ) : null}

          {problem ? <Text style={styles.error}>{problem}</Text> : null}

          <View style={styles.mediaRow}>
            {localStream ? (
              <RTCView
                streamURL={localStream.toURL()}
                style={styles.preview}
                objectFit="cover"
                mirror={false}
                zOrder={0}
              />
            ) : (
              <View style={[styles.preview, styles.previewEmpty]}>
                <Text style={styles.previewText}>لا توجد صورة</Text>
              </View>
            )}

            <View style={styles.toggles}>
              <Pressable
                style={[styles.toggle, !cameraEnabled && styles.toggleOff]}
                onPress={onToggleCamera}
              >
                <Text style={styles.toggleText}>{cameraEnabled ? 'الكاميرا: تعمل' : 'الكاميرا: مغلقة'}</Text>
              </Pressable>
              <Pressable
                style={[styles.toggle, !micEnabled && styles.toggleOff]}
                onPress={onToggleMic}
              >
                <Text style={styles.toggleText}>{micEnabled ? 'المايك: يعمل' : 'المايك: مغلق'}</Text>
              </Pressable>
            </View>
          </View>

          <Text style={styles.hint}>
            الأزرار المحلية معطّلة أثناء التحكم عن بُعد.
          </Text>
        </>
      ) : null}
    </View>
  );
}

function Field({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, value !== 0 && styles.fieldValueActive]}>
        {value > 0 ? `+${value}` : String(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 12,
    marginBottom: 24,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { fontSize: 16, fontWeight: '700' },
  settings: { fontSize: 14, color: '#2196F3' },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontVariant: ['tabular-nums'] },
  alarm: {
    backgroundColor: '#c62828',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  alarmText: { color: '#fff', fontSize: 13, fontWeight: '700', textAlign: 'center' },
  error: { color: '#c62828', fontSize: 12 },
  readout: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  field: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  fieldLabel: { fontSize: 10, fontWeight: '700', color: '#888', letterSpacing: 0.6 },
  fieldValue: { fontSize: 12, fontWeight: '700', color: '#999', fontVariant: ['tabular-nums'], width: 32 },
  fieldValueActive: { color: '#2196F3' },
  mediaRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  preview: { width: 120, height: 90, borderRadius: 8, backgroundColor: '#000' },
  previewEmpty: { alignItems: 'center', justifyContent: 'center' },
  previewText: { color: '#888', fontSize: 11 },
  toggles: { flex: 1, gap: 6 },
  toggle: {
    borderWidth: 1,
    borderColor: '#bbb',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  toggleOff: { backgroundColor: '#ffebee', borderColor: '#ef9a9a' },
  toggleText: { fontSize: 13 },
  hint: { fontSize: 12, color: '#888' },
});
