import { useEffect, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import type { AppearanceId } from "./identity";
import {
  MASCOT_MARK_COLOR,
  mascotPresentation,
  paintMascotAppearance,
  selectMascotState,
  type MascotActivity,
} from "./mascot";
import { colors } from "./theme";

const CELL = 4;

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

export function PixelMascot({
  activity,
  appearance = "classic",
  accent = colors.accent,
}: {
  activity: MascotActivity;
  appearance?: AppearanceId;
  accent?: string;
}) {
  const reduceMotion = useReduceMotion();
  const presentation = mascotPresentation(selectMascotState(activity), reduceMotion);
  const rows = paintMascotAppearance(presentation.rows, appearance);
  const pixelColor: Record<string, string> = {
    f: colors.user,
    e: colors.canvas,
    s: colors.success,
    r: colors.danger,
    ...MASCOT_MARK_COLOR,
    o: accent,
  };
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents="none"
      style={styles.cat}
    >
      {rows.map((row, y) => (
        <View key={y} style={styles.row}>
          {Array.from(row, (pixel, x) => {
            const color = pixel === "." ? undefined : pixelColor[pixel];
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
  cat: { width: CELL * 12, height: CELL * 10, flexShrink: 0 },
  row: { flexDirection: "row" },
  cell: { width: CELL, height: CELL },
});
