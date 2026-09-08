import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseHealthResponse } from "@lilith/contracts";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  DEFAULT_NAME,
  IDENTITY_STORAGE_KEY,
  MAX_NAME_LENGTH,
  identityFromChoice,
  parsePersistedIdentity,
  serializeIdentity,
  type AgentIdentity,
  type OptionalTool,
  type SetupMode,
} from "./identity";

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3000").replace(/\/$/, "");
const TIMEOUT_MS = 8000;

const TOOL_LABELS: Record<OptionalTool, string> = {
  webResearch: "Web research",
  memory: "Memory",
};

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
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [persistError, setPersistError] = useState(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(IDENTITY_STORAGE_KEY)
      .then((raw) => {
        if (active) setIdentity(parsePersistedIdentity(raw));
      })
      .catch(() => {
        if (active) setIdentity(null);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  async function persist(next: AgentIdentity) {
    setIdentity(next);
    try {
      await AsyncStorage.setItem(IDENTITY_STORAGE_KEY, serializeIdentity(next));
      setPersistError(false);
    } catch {
      setPersistError(true);
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          enabled={Platform.OS === "ios"}
        >
          {!ready ? (
            <View style={styles.loading} accessibilityLabel="Loading">
              <ActivityIndicator color="#C4B5FD" />
            </View>
          ) : identity === null ? (
            <Onboarding onComplete={(next) => void persist(next)} />
          ) : (
            <Home
              identity={identity}
              persistError={persistError}
              onIdentityChange={(next) => void persist(next)}
            />
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Onboarding({ onComplete }: { onComplete: (identity: AgentIdentity) => void }) {
  const [name, setName] = useState(DEFAULT_NAME);
  const [mode, setMode] = useState<SetupMode | null>(null);

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.scroll}
    >
      <Text style={styles.title} accessibilityRole="header">
        Welcome
      </Text>
      <Text style={styles.lede}>Name your companion and choose a starting setup.</Text>
      <NameField value={name} onChangeText={setName} />
      <Text style={styles.sectionLabel}>Setup</Text>
      <ModeChoice
        mode="recommended"
        title="Recommended"
        detail="Web research and Memory"
        selected={mode === "recommended"}
        onSelect={setMode}
      />
      <ModeChoice
        mode="blank"
        title="Blank"
        detail="No optional tools"
        selected={mode === "blank"}
        onSelect={setMode}
      />
      <View style={styles.spacer} />
      <Pressable
        onPress={() => {
          if (mode !== null) onComplete(identityFromChoice(name, mode));
        }}
        disabled={mode === null}
        accessibilityRole="button"
        accessibilityLabel="Continue"
        accessibilityHint="Saves the name and starting setup"
        accessibilityState={{ disabled: mode === null }}
        style={({ pressed }) => [
          styles.button,
          mode === null && styles.buttonDisabled,
          pressed && mode !== null && styles.buttonPressed,
        ]}
      >
        <Text style={styles.buttonLabel}>Continue</Text>
      </Pressable>
    </ScrollView>
  );
}

function Home({
  identity,
  persistError,
  onIdentityChange,
}: {
  identity: AgentIdentity;
  persistError: boolean;
  onIdentityChange: (identity: AgentIdentity) => void;
}) {
  const [name, setName] = useState(identity.name);
  const [token, setToken] = useState("");
  const [state, setState] = useState<ConnectionState>("idle");
  const busy = state === "loading";
  const toolsSummary =
    identity.tools.length === 0
      ? "No optional tools"
      : identity.tools.map((tool) => TOOL_LABELS[tool]).join(", ");

  function commitName(raw: string) {
    const next = identityFromChoice(raw, identity.mode);
    setName(next.name);
    if (next.name !== identity.name) onIdentityChange(next);
  }

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
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.scroll}
    >
      <Text style={styles.title} accessibilityRole="header">
        {identity.name}
      </Text>
      <Text style={styles.meta} accessibilityLabel={`Setup ${identity.mode === "recommended" ? "Recommended" : "Blank"}. ${toolsSummary}.`}>
        {identity.mode === "recommended" ? "Recommended" : "Blank"} · {toolsSummary}
      </Text>
      <NameField
        value={name}
        onChangeText={setName}
        onEndEditing={() => commitName(name)}
      />
      {persistError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not save. Try again.
        </Text>
      ) : null}
      <Text style={styles.sectionLabel}>Connection</Text>
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
        textContentType="none"
        editable={!busy}
        keyboardAppearance="dark"
        returnKeyType="done"
        accessibilityLabel="Local API token"
        underlineColorAndroid="transparent"
        textAlignVertical="center"
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
          pressed && !(busy || token.trim() === "") && styles.buttonPressed,
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
    </ScrollView>
  );
}

function NameField({
  value,
  onChangeText,
  onEndEditing,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onEndEditing?: () => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
        maxLength={MAX_NAME_LENGTH}
        placeholder={DEFAULT_NAME}
        placeholderTextColor="#8A8A8A"
        autoCapitalize="words"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        keyboardAppearance="dark"
        returnKeyType="done"
        accessibilityLabel="Companion name"
        underlineColorAndroid="transparent"
        textAlignVertical="center"
        style={styles.input}
      />
    </View>
  );
}

function ModeChoice({
  mode,
  title,
  detail,
  selected,
  onSelect,
}: {
  mode: SetupMode;
  title: string;
  detail: string;
  selected: boolean;
  onSelect: (mode: SetupMode) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(mode)}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}.`}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
      ]}
    >
      <View
        importantForAccessibility="no"
        style={[styles.choiceMark, selected && styles.choiceMarkSelected]}
      />
      <View style={styles.choiceCopy}>
        <Text style={styles.choiceTitle}>{title}</Text>
        <Text style={styles.choiceDetail}>{detail}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#121212",
  },
  flex: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 24,
    gap: 16,
  },
  title: {
    color: "#F5F5F5",
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  lede: {
    color: "#A3A3A3",
    fontSize: 17,
    lineHeight: 24,
  },
  meta: {
    color: "#A3A3A3",
    fontSize: 16,
    lineHeight: 22,
  },
  sectionLabel: {
    color: "#D4D4D4",
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.2,
    marginTop: 8,
  },
  field: {
    gap: 8,
  },
  fieldLabel: {
    color: "#D4D4D4",
    fontSize: 13,
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#1E1E1E",
    borderColor: "#3F3F3F",
    borderWidth: 1,
    borderRadius: 12,
    color: "#F5F5F5",
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  choice: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "#1E1E1E",
    borderColor: "#3F3F3F",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  choiceSelected: {
    borderColor: "#C4B5FD",
  },
  choicePressed: {
    opacity: 0.85,
  },
  choiceMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#8A8A8A",
  },
  choiceMarkSelected: {
    borderColor: "#C4B5FD",
    backgroundColor: "#C4B5FD",
  },
  choiceCopy: {
    flex: 1,
    gap: 2,
  },
  choiceTitle: {
    color: "#F5F5F5",
    fontSize: 17,
    fontWeight: "600",
  },
  choiceDetail: {
    color: "#A3A3A3",
    fontSize: 15,
    lineHeight: 20,
  },
  spacer: {
    flexGrow: 1,
    minHeight: 8,
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
    fontSize: 17,
    fontWeight: "600",
  },
  status: {
    color: "#D4D4D4",
    fontSize: 16,
    lineHeight: 22,
  },
  statusSuccess: {
    color: "#4ADE80",
  },
  statusError: {
    color: "#F87171",
  },
});
