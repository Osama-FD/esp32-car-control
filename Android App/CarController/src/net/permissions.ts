import { PermissionsAndroid, Platform } from 'react-native';

/** The union of the manifest strings, so requestMultiple's result can be indexed. */
type AndroidPermission =
  (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS];

/**
 * Ask for the camera and microphone up front.
 *
 * The WebRTC config plugin puts CAMERA and RECORD_AUDIO in the manifest, but
 * Android still needs a runtime grant. Unlike the operator app, this one really
 * does open a camera — it is the car's eyes.
 */
export async function ensureMediaPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const wanted: AndroidPermission[] = [
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ];

    const missing: AndroidPermission[] = [];
    for (const permission of wanted) {
      if (!(await PermissionsAndroid.check(permission))) missing.push(permission);
    }
    if (missing.length === 0) return true;

    const result = await PermissionsAndroid.requestMultiple(missing);
    return missing.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}
