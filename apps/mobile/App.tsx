import { parseHealthResponse } from "@lilith/contracts";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3000").replace(/\/$/, "");
const TIMEOUT_MS = 8000;

type ConnectionState =
  | "idle"
  | "loading"
  | "success"
  | "unauthorized"
  | "unreachable"
  | "unexpected";

const STATUS_TEXT: Record<ConnectionState, string> = {
  idle: "Enter the local API token, then check the connection.",
  loading: "Checking connection…",
  success: "Connected.",
  unauthorized: "Unauthorized.",
  unreachable: "API unreachable.",
  unexpected: "Unexpected response.",
};

export default function App() {
  const [token, setToken] = useState("");
  const [state, setState] = useState<ConnectionState>("idle");
  const busy = state === "loading";

  async function checkConnection() {
    setState("loading");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/health`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: controller.signal,
      });
      if (response.status === 401) {
        setState("unauthorized");
        return;
      }
      if (response.status !== 200) {
        setState("unexpected");
        return;
      }
      try {
        const json: unknown = await response.json();
        parseHealthResponse(json);
      } catch {
        setState("unexpected");
        return;
      }
      setState("success");
    } catch {
      setState("unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <Text style={styles.title} accessibilityRole="header">
          Lilith
        </Text>
        <Text style={styles.meta}>API {API_URL}</Text>
        <TextInput
          value={token}
          onChangeText={setToken}
          placeholder="Local API token"
          placeholderTextColor="#8A8A8A"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          editable={!busy}
          accessibilityLabel="Local API token"
          style={styles.input}
        />
        <Pressable
          onPress={() => {
            void checkConnection();
          }}
          disabled={busy || token.trim() === ""}
          accessibilityRole="button"
          accessibilityLabel="Check connection"
          accessibilityState={{ disabled: busy || token.trim() === "", busy }}
          style={({ pressed }) => [
            styles.button,
            (busy || token.trim() === "") && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color="#121212" />
          ) : (
            <Text style={styles.buttonLabel}>Check connection</Text>
          )}
        </Pressable>
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
          style={[
            styles.status,
            state === "success" && styles.statusSuccess,
            (state === "unauthorized" || state === "unreachable" || state === "unexpected") &&
              styles.statusError,
          ]}
        >
          {STATUS_TEXT[state]}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#121212",
  },
  screen: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  title: {
    color: "#F5F5F5",
    fontSize: 32,
    fontWeight: "600",
  },
  meta: {
    color: "#A3A3A3",
    fontSize: 16,
  },
  input: {
    backgroundColor: "#1E1E1E",
    borderColor: "#3F3F3F",
    borderWidth: 1,
    borderRadius: 12,
    color: "#F5F5F5",
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  button: {
    backgroundColor: "#C4B5FD",
    borderRadius: 12,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonLabel: {
    color: "#121212",
    fontSize: 16,
    fontWeight: "600",
  },
  status: {
    color: "#D4D4D4",
    fontSize: 16,
  },
  statusSuccess: {
    color: "#4ADE80",
  },
  statusError: {
    color: "#F87171",
  },
});
