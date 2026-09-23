import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import {
  mascotPresentation,
  selectMascotState,
  type MascotActivity,
  type MascotPixel,
} from "./mascot";
import { colors } from "./theme";

const CELL = 4;

const PIXEL_COLOR: Record<MascotPixel, string> = {
  o: colors.accent,
  f: colors.user,
  e: colors.canvas,
  s: colors.success,
  r: colors.danger,
};

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) setReduceMotion(enabled);
      })
      .catch(() => {
        if (active) setReduceMotion(true);
      });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      setReduceMotion(enabled);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

export function PixelMascot({ activity }: { activity: MascotActivity }) {
  const reduceMotion = useReduceMotion();
  const presentation = mascotPresentation(selectMascotState(activity), reduceMotion);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents="none"
      style={styles.cat}
    >
      {presentation.rows.map((row, y) => (
        <View key={y} style={styles.row}>
          {Array.from(row, (pixel, x) => {
            const color = pixel === "." ? undefined : PIXEL_COLOR[pixel as MascotPixel];
            return (
              <View key={x} style={color === undefined ? styles.cell : [styles.cell, { backgroundColor: color }]} />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  cat: { width: CELL * 12, height: CELL * 10 },
  row: { flexDirection: "row" },
  cell: { width: CELL, height: CELL },
});
