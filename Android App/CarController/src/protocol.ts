/**
 * Wire protocol shared with the relay server.
 *
 * Mirrors `phone2-app/src/protocol.ts` and `relay-server/src/protocol.js` — the
 * three are meant to be diffable by eye. This is the *car* side of the same
 * contract: it receives control frames and answers offers, the reverse of the
 * operator app. The server normalises and clamps everything before it gets
 * here, so these types describe what actually arrives, not what is trusted.
 */

export type Role = 'car' | 'controller';

/** The four values this app turns into its 6-byte USB packet. */
export interface ControlState {
  /** Drive motor, -100 (full reverse) .. 100 (full forward). */
  drive: number;
  /** Steering servo, -100 (full left) .. 100 (full right). */
  steer: number;
  /** Camera pan stepper: -1 left, 0 stop, 1 right. Continuous while non-zero. */
  pan: -1 | 0 | 1;
  /** Camera tilt stepper: -1 down, 0 stop, 1 up. Continuous while non-zero. */
  tilt: -1 | 0 | 1;
}

export const NEUTRAL: ControlState = { drive: 0, steer: 0, pan: 0, tilt: 0 };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// --- Outgoing (car -> server) ----------------------------------------------

export type ClientMessage =
  | { type: 'hello'; role: Role; token: string; room: string; name?: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: Record<string, unknown> | null }
  | { type: 'ping'; id: number; t: number }
  | { type: 'pong'; id: number; t: number }
  | { type: 'bye' };

// --- Incoming (server -> car) ----------------------------------------------

export interface WelcomeMessage {
  type: 'welcome';
  role: Role;
  room: string;
  peerConnected: boolean;
  iceServers: IceServer[];
  serverTime: number;
}

/**
 * `neutral` is set on the all-stop frame the relay synthesises when the
 * operator's socket closes. It arrives *before* `peer-left`, deliberately —
 * see `relay-server/src/room.js`.
 */
export interface ControlMessage extends ControlState {
  type: 'control';
  seq?: number;
  t?: number;
  neutral?: boolean;
}

export type ServerMessage =
  | WelcomeMessage
  | ControlMessage
  | { type: 'error'; code: string; message: string }
  | { type: 'peer-joined'; role: Role }
  | { type: 'peer-left'; role: Role }
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: Record<string, unknown> | null }
  | { type: 'ping'; id: number; t: number }
  | { type: 'pong'; id: number; t: number };

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * The relay already clamps pan/tilt to -1..1, but it is the one value that goes
 * straight into a stepper direction, so narrow it here rather than trusting the
 * wire to have been well behaved.
 */
export function asAxis(value: unknown): -1 | 0 | 1 {
  const n = clampInt(Number(value), -1, 1);
  return n === 1 ? 1 : n === -1 ? -1 : 0;
}

export function sameControl(a: ControlState, b: ControlState): boolean {
  return a.drive === b.drive && a.steer === b.steer && a.pan === b.pan && a.tilt === b.tilt;
}

/** Human-readable version of the `error` codes the server can send. */
export const ERROR_HINTS: Record<string, string> = {
  bad_token: 'رمز الدخول غير صحيح — عدّله في الإعدادات.',
  bad_role: 'الخادم لم يتعرّف على الدور — هذا خطأ برمجي.',
  register_timeout: 'الخادم أغلق الاتصال قبل التسجيل.',
  not_registered: 'أُرسل أمر قبل التسجيل — هذا خطأ برمجي.',
  no_peer: 'هاتف المشغّل غير متصل.',
  bad_sdp: 'الخادم رفض إجابة الاتصال المرئي.',
  bad_json: 'الخادم لم يستطع قراءة رسالة أرسلناها.',
  reserved_type: 'حاولنا إرسال رسالة خاصة بالخادم — هذا خطأ برمجي.',
  unknown_type: 'الخادم لا يفهم رسالة أرسلناها.',
};
