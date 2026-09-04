import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

interface Props {
  size: number;
  disabled?: boolean;
  /** Called with -100..100 on every change, including the snap back to 0. */
  onChange: (steer: number) => void;
}

/** A quarter turn each way is full lock. */
const MAX_ANGLE_DEG = 90;

/**
 * Touches this close to the hub (as a fraction of the radius) carry almost no
 * angular information — a pixel of movement there swings the angle wildly.
 */
const HUB_DEADZONE = 0.22;

function unwrap(degrees: number): number {
  if (degrees > 180) return degrees - 360;
  if (degrees < -180) return degrees + 360;
  return degrees;
}

/**
 * Rotary steering wheel — the fixed one.
 *
 * The version this replaces read `evt.nativeEvent.locationX/locationY`, which
 * are relative to whichever view actually received the touch. The marker inside
 * the wheel rotates, so when the finger landed on it the frame of reference
 * turned under the finger and the angle jumped. That was the jitter.
 *
 * Four things fix it, and all four are load-bearing:
 *
 *   1. The centre is measured once per grab with `measureInWindow()`, and the
 *      angle comes from absolute `gestureState.moveX/moveY` — screen
 *      coordinates, which no amount of rotation can move.
 *   2. Rotation accumulates the *delta* from the previous sample rather than
 *      being recomputed from the grab angle, so a sweep past ±180° cannot wrap.
 *   3. Samples inside a hub deadzone are ignored.
 *   4. `pointerEvents="none"` on the rotating rim keeps the touch target on the
 *      stationary container.
 *
 * Kept diffable against `phone2-app/src/components/SteeringWheel.tsx`, which is
 * the same control with the operator app's styling. Do not "simplify" either
 * one back to `atan2` on the current touch position — that is the bug.
 *
 * A fifth rule, added later: the gesture comes from
 * `react-native-gesture-handler`, not `PanResponder`. React Native's responder
 * system grants exactly one responder app-wide, so a PanResponder wheel made
 * the drive buttons unpressable while turning (it refused to hand the responder
 * over), and grabbing the wheel while a drive button was held terminated that
 * button and zeroed the motor. Steering and drive could never be used at once.
 * Gesture handler recognisers are per-view and per-pointer, so each control
 * keeps its own finger — which is also why the buttons alongside this wheel use
 * gesture handler's `Pressable`.
 */
export function SteeringWheel({ size, disabled = false, onChange }: Props) {
  const rotation = useRef(new Animated.Value(0)).current;
  const rotationValueRef = useRef(0);
  const centerRef = useRef<{ x: number; y: number } | null>(null);
  const lastAngleRef = useRef<number | null>(null);
  const containerRef = useRef<View>(null);

  const [, setDisplay] = useState(0);
  const displayRef = useRef(0);

  const radiusPx = size / 2;

  const measure = useCallback((_event?: LayoutChangeEvent) => {
    containerRef.current?.measureInWindow((x, y, width, height) => {
      centerRef.current = { x: x + width / 2, y: y + height / 2 };
    });
  }, []);

  const apply = useCallback((next: number) => {
    rotationValueRef.current = next;
    rotation.setValue(next);
    const steer = Math.round((next / MAX_ANGLE_DEG) * 100);
    if (steer !== displayRef.current) {
      displayRef.current = steer;
      setDisplay(steer);
      onChange(steer);
    }
  }, [onChange, rotation]);

  const springHome = useCallback(() => {
    // The value is driven imperatively during the drag, so the spring has to run
    // on the JS driver: a native-driven animation would not keep
    // rotationValueRef (and therefore the steer output) in step.
    Animated.spring(rotation, {
      toValue: 0,
      friction: 6,
      tension: 70,
      useNativeDriver: false,
    }).start();
    rotationValueRef.current = 0;
    displayRef.current = 0;
    setDisplay(0);
    onChange(0);
  }, [onChange, rotation]);

  const angleAt = useCallback((x: number, y: number): number | null => {
    const center = centerRef.current;
    if (!center) return null;
    const dx = x - center.x;
    const dy = y - center.y;
    if (Math.hypot(dx, dy) < radiusPx * HUB_DEADZONE) return null;
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  }, [radiusPx]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Steering must respond to the first degree of rotation, not after the
        // default 10 px activation slop.
        .minDistance(0)
        // The finger routinely leaves the wheel's bounds mid-turn; losing the
        // gesture there would spring the wheel home under the operator's hand.
        .shouldCancelWhenOutside(false)
        // No Reanimated in this app, so the callbacks have to be told to run on
        // the JS thread; they touch refs and Animated values.
        .runOnJS(true)
        .enabled(!disabled)
        .onBegin((event) => {
          // Re-measure on every grab: an orientation change or a layout shift
          // between drags would otherwise leave a stale centre behind.
          measure();
          // Grabbing the wheel mid-spring must adopt where it visually is, and
          // stop the spring from fighting the setValue calls that follow.
          rotation.stopAnimation((current: number) => {
            rotationValueRef.current = current;
          });
          // Null when the grab landed inside the hub deadzone; the first usable
          // sample of the drag seeds it instead. Rule 1: absolute coordinates.
          lastAngleRef.current = angleAt(event.absoluteX, event.absoluteY);
        })
        .onUpdate((event) => {
          const angle = angleAt(event.absoluteX, event.absoluteY);
          if (angle === null) return;
          if (lastAngleRef.current === null) {
            lastAngleRef.current = angle;
            return;
          }
          const delta = unwrap(angle - lastAngleRef.current);
          lastAngleRef.current = angle;
          const next = Math.max(
            -MAX_ANGLE_DEG,
            Math.min(MAX_ANGLE_DEG, rotationValueRef.current + delta),
          );
          apply(next);
        })
        // Fires on release, cancellation and failure alike, so there is no path
        // out of the gesture that leaves the wheel holding a steering angle.
        .onFinalize(() => {
          lastAngleRef.current = null;
          springHome();
        }),
    [angleAt, apply, disabled, measure, rotation, springHome],
  );

  const spin = rotation.interpolate({
    inputRange: [-MAX_ANGLE_DEG, MAX_ANGLE_DEG],
    outputRange: [`-${MAX_ANGLE_DEG}deg`, `${MAX_ANGLE_DEG}deg`],
  });

  return (
    <GestureDetector gesture={pan}>
      <View
        ref={containerRef}
        onLayout={measure}
        collapsable={false}
        style={[
          styles.wheel,
          { width: size, height: size, borderRadius: size / 2 },
          disabled && styles.disabled,
        ]}
      >
        {/* pointerEvents="none" keeps the touch target on the container above,
            even as this spins under the finger. Rule 4 in the header comment. */}
        <Animated.View
          pointerEvents="none"
          style={[styles.inner, { transform: [{ rotate: spin }] }]}
        >
          <View style={[styles.marker, { height: size / 2 - 10 }]} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  wheel: {
    backgroundColor: '#333',
    borderWidth: 4,
    borderColor: '#555',
    alignSelf: 'center',
  },
  disabled: { opacity: 0.35 },
  inner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
  },
  marker: {
    width: 6,
    marginTop: 10,
    backgroundColor: '#FF5252',
    borderRadius: 3,
  },
});
