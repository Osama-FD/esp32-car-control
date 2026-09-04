# Car app (Phone 1) — notes for future sessions

## Read this first

**Expo HAS CHANGED.** Read the exact versioned docs at
<https://docs.expo.dev/versions/v57.0.0/> before writing any code here. This
project is on **Expo SDK 57 → React Native 0.86, React 19.2.3, New Architecture
on by default** — and there is no opt-out any more (see
`docs/09-decisions-and-open-questions.md` §9.5). Answers written for SDK 49–53
are wrong in ways that compile.

## What this app is

Phone 1 rides on the car, plugged into the ESP32-S3 over USB. It does two jobs:

| Mode | Who drives | Transport |
|---|---|---|
| **Local** | the on-screen controls | USB only; no network |
| **Remote** | the operator (Phone 2) | relay WebSocket in, USB out, WebRTC for camera + voice |

The toggle in the remote panel switches between them. They are mutually
exclusive by construction, not by convention — see rule 2.

## Hard rules

1. **`src/control/useCarOutput.ts` is the only thing that writes to the ESP32.**
   Local controls and network frames both go through it. Adding a second write
   path would silently defeat the watchdog below, which is the one piece of this
   app that stops a runaway car.

2. **Exactly one control source at a time.** `setLocal()` returns early while
   remote mode is on, and `applyRemote()` returns early while it is off. The UI
   also disables the inactive one, but that is cosmetic — the guard in the funnel
   is what makes it true. Switching modes all-stops in both directions.

3. **The network watchdog is not optional.** If no control frame has arrived in
   `TUNING.networkWatchdogMs` (400 ms), the funnel zeroes the outputs itself.
   The ESP32's own 500 ms timeout does **not** cover this: during a network
   stall Phone 1 is still rewriting the last command it heard every 150 ms, so
   the firmware sees a perfectly healthy packet stream and keeps driving. Only
   this watchdog notices the *source* went quiet.

   | Layer | Trigger | Latency |
   |---|---|---|
   | Relay all-stop | operator's socket closes | immediate |
   | **This watchdog** | **no control frame for ~400 ms** | **~400 ms** |
   | ESP32 watchdog | no valid USB packet for 500 ms | ≤500 ms |

4. **Keep the 150 ms USB keepalive.** It is what stops the ESP32's timeout from
   firing between network frames and during long local presses.

5. **This app is always the WebRTC answerer.** It never offers. In
   `useWebRTC.ts`, `setRemoteDescription(offer)` must run **before** `addTrack` —
   that is what pairs our camera and mic with the transceivers the operator
   already offered instead of appending m-lines it cannot render.

6. **Do not delete `patches/`.** The patch registers the ESP32-S3's CDC device
   (VID `0x303A`, PID `0x1001`) and removes the dead `jcenter()` repository.
   Without it the build succeeds and then never sees the ESP32.

7. **Controls that must work at the same time come from
   `react-native-gesture-handler`, never from `react-native`.** RN's responder
   system grants one responder for the whole app, so an RN `TouchableOpacity`
   could not be held while the wheel was turned, and grabbing the wheel while a
   drive button was held terminated that button and zeroed the motor. The wheel
   uses `Gesture.Pan()`; the local direction buttons and the surrounding
   `ScrollView` come from gesture handler; `App.tsx` wraps everything in
   `GestureHandlerRootView`, without which none of them respond on Android.
   `RelaySettingsSheet` lives inside an RN `Modal`, which sits outside that root
   view — its plain RN `Pressable`s must stay plain.

## Layout

```
App.tsx                    local UI + wiring; the network lives in src/
src/
  protocol.ts              TS mirror of the relay wire format (car side)
  config.ts                relay settings + TUNING constants
  usb/useUsbLink.ts        port, permissions, 6-byte packet, hex transport
  control/useCarOutput.ts  THE FUNNEL: keepalive, watchdog, mode arbitration
  net/useRelay.ts          WebSocket as role:'car'; near-copy of Phone 2's
  net/useWebRTC.ts         the answerer
  net/permissions.ts       camera + microphone runtime grants
  components/
    RemotePanel.tsx        status pills, live output readout, preview, toggles
    RelaySettingsSheet.tsx relay URL / token / room + diagnostics
```

`src/protocol.ts`, `src/config.ts` and `src/net/useRelay.ts` are deliberately
near-copies of their `phone2-app/src/` counterparts. Keep them diffable by eye;
that is worth more than factoring them into a shared package.

## The steering wheel — fixed, and easy to un-fix

`src/components/SteeringWheel.tsx` replaced the inline wheel that read
`locationX/locationY`. Those are relative to whichever view received the touch,
and the marker inside the wheel rotates, so the frame of reference turned under
the finger and the angle jumped.

Four things fix it and all four are load-bearing: the centre is measured once
per grab with `measureInWindow()`; the angle comes from the gesture's absolute
`absoluteX/absoluteY`; rotation accumulates the *delta* from the previous
sample so a sweep past ±180° cannot wrap; and `pointerEvents="none"` on the
rotating rim keeps the touch target on the stationary container. A hub deadzone
drops samples too close to the centre, where a pixel swings the angle wildly.

A fifth rule was added when steering and drive turned out to be mutually
exclusive: the gesture is `Gesture.Pan()` from `react-native-gesture-handler`,
not a `PanResponder`. `.minDistance(0)` makes it answer the first degree of
rotation, `.shouldCancelWhenOutside(false)` keeps the turn alive when the finger
leaves the rim, `.runOnJS(true)` is required because there is no Reanimated in
this app, and `.onFinalize()` — not `.onEnd()` — is what springs the wheel home,
so cancellation and failure cannot leave a steering angle latched.

**Do not "simplify" this back to `atan2` on the current touch position** — that
is exactly the bug. The file is kept diffable against
`phone2-app/src/components/SteeringWheel.tsx`; the only intended difference is
styling. Fix geometry in both or neither.

## Running it

```bash
npm install                  # postinstall applies patches/
cp .env.example .env         # relay URL, token, room
npx expo prebuild --clean    # native dirs; this is not Expo Go
npx expo run:android
```

`react-native-usb-serialport-for-android`, `react-native-webrtc` and
`react-native-incall-manager` all contain native code, so **Expo Go cannot run
this app** and any dependency change needs a rebuild.

## Testing without the operator phone

Point Phone 2 (or `relay-server/tools/car-simulator.html`, which is a browser
operator as well as a browser car) at the same relay and room. For the control
path alone, `relay-server/tools/fake-car.js` occupies the `car` role — so run it
only when this app is *not* connected, or the relay will evict one of them.
