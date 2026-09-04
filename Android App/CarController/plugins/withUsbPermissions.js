const { withAndroidManifest } = require('@expo/config-plugins');

const USB_PERMISSION = 'android.permission.USB_PERMISSION';
const USB_HOST_FEATURE = 'android.hardware.usb.host';

/**
 * Adds the two manifest entries the ESP32-S3 USB link needs:
 *  - <uses-permission android:name="android.permission.USB_PERMISSION" />
 *  - <uses-feature android:name="android.hardware.usb.host" />
 *
 * react-native-usb-serialport-for-android ships no config plugin of its own,
 * so without this these entries have to be hand-edited into
 * android/app/src/main/AndroidManifest.xml after every `expo prebuild --clean`
 * - and get silently wiped when that runs. This plugin makes them survive
 * prebuild automatically instead.
 */
function withUsbPermissions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    if (!Array.isArray(manifest['uses-permission'])) {
      manifest['uses-permission'] = [];
    }
    const hasPermission = manifest['uses-permission'].some(
      (item) => item.$?.['android:name'] === USB_PERMISSION
    );
    if (!hasPermission) {
      manifest['uses-permission'].push({
        $: { 'android:name': USB_PERMISSION },
      });
    }

    if (!Array.isArray(manifest['uses-feature'])) {
      manifest['uses-feature'] = [];
    }
    const hasFeature = manifest['uses-feature'].some(
      (item) => item.$?.['android:name'] === USB_HOST_FEATURE
    );
    if (!hasFeature) {
      manifest['uses-feature'].push({
        $: { 'android:name': USB_HOST_FEATURE },
      });
    }

    return config;
  });
}

module.exports = withUsbPermissions;
