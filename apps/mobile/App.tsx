import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseChatStreamEvent, parseHealthResponse } from "@lilith/contracts";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
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
import {
  CHAT_STORAGE_KEY,
  MAX_MESSAGE_LENGTH,
  appendReply,
  beginReply,
  finishReply,
  parsePersistedChat,
  retryReply,
  serializeChat,
  type ChatMessage,
} from "./chat";

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3000").replace(/\/$/, "");
const TIMEOUT_MS = 8000;

const TOOL_LABELS: Record<OptionalTool, string> = {
  webResearch: "Web research",
  memory: "Memory",
};

type ConnectionState =
  | "idle"
  | "loading"
  | "streaming"
  | "success"
  | "unauthorized"
  | "unreachable"
  | "unexpected";

const STATUS_TEXT: Record<ConnectionState, string> = {
  idle: "Enter the local API token, then check the connection.",
  loading: "Checking connection…",
  streaming: "Lilith is replying…",
  success: "Connected.",
  unauthorized: "Unauthorized.",
  unreachable: "API unreachable. Reconnect to retry.",
  unexpected: "Unexpected response.",
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [persistError, setPersistError] = useState(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveRevision = useRef(0);

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
    const revision = ++saveRevision.current;
    setIdentity(next);
    const save = saveQueue.current
      .catch(() => undefined)
      .then(() => AsyncStorage.setItem(IDENTITY_STORAGE_KEY, serializeIdentity(next)));
    saveQueue.current = save;
    try {
      await save;
      if (revision === saveRevision.current) setPersistError(false);
    } catch {
      if (revision === saveRevision.current) setPersistError(true);
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
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
      <View accessibilityRole="radiogroup" accessibilityLabel="Setup" style={styles.modeGroup}>
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
      </View>
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
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatReady, setChatReady] = useState(false);
  const [chatPersistError, setChatPersistError] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveRevision = useRef(0);
  const request = useRef<XMLHttpRequest | null>(null);
  const list = useRef<FlatList<ChatMessage> | null>(null);
  const idSequence = useRef(0);
  const shouldAutoScroll = useRef(true);
  const busy = state === "loading" || state === "streaming";
  const toolsSummary =
    identity.tools.length === 0
      ? "No optional tools"
      : identity.tools.map((tool) => TOOL_LABELS[tool]).join(", ");

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(CHAT_STORAGE_KEY)
      .then((raw) => {
        if (active) setMessages(parsePersistedChat(raw));
      })
      .catch(() => {
        if (active) setMessages([]);
      })
      .finally(() => {
        if (active) setChatReady(true);
      });
    return () => {
      active = false;
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!chatReady) return;
    const revision = ++saveRevision.current;
    const save = saveQueue.current
      .catch(() => undefined)
      .then(() => AsyncStorage.setItem(CHAT_STORAGE_KEY, serializeChat(messages)));
    saveQueue.current = save;
    void save.then(
      () => {
        if (revision === saveRevision.current) setChatPersistError(false);
      },
      () => {
        if (revision === saveRevision.current) setChatPersistError(true);
      },
    );
  }, [chatReady, messages]);

  function commitName(raw: string) {
    const next = identityFromChoice(raw, identity.mode);
    setName(next.name);
    if (next.name !== identity.name || persistError) onIdentityChange(next);
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
        parseHealthResponse(await response.json());
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

  function nextId(prefix: string) {
    idSequence.current += 1;
    return `${prefix}-${Date.now()}-${idSequence.current}`;
  }

  function streamReply(userId: string, text: string, retry: boolean) {
    if (request.current !== null) return;
    setMessages((current) =>
      retry
        ? retryReply(current, userId)
        : beginReply(current, userId, nextId("assistant"), text)
    );
    setActiveUserId(userId);
    setState("streaming");
    if (Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(`${identity.name} is replying`);
    }

    const xhr = new XMLHttpRequest();
    request.current = xhr;
    let offset = 0;
    let pending = "";
    let spokenReply = "";
    let settled = false;

    function settle(nextState: ConnectionState, replyStatus: "complete" | "failed") {
      if (settled) return;
      settled = true;
      setMessages((current) => finishReply(current, userId, replyStatus));
      setActiveUserId(null);
      setState(nextState);
      request.current = null;
    }

    function consume() {
      if (settled || xhr.status !== 200) return;
      pending += xhr.responseText.slice(offset);
      offset = xhr.responseText.length;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      try {
        for (const line of lines) {
          if (line === "") continue;
          const event = parseChatStreamEvent(JSON.parse(line));
          if (event.type === "delta") {
            spokenReply += event.text;
            setMessages((current) => appendReply(current, userId, event.text));
          } else {
            AccessibilityInfo.announceForAccessibility(
              `${identity.name}: ${spokenReply || "Reply complete"}`,
            );
            settle("success", "complete");
          }
        }
      } catch {
        xhr.abort();
        settle("unexpected", "failed");
      }
    }

    try {
      xhr.open("POST", `${API_URL}/chat`);
      xhr.setRequestHeader("Authorization", `Bearer ${token.trim()}`);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onprogress = consume;
      xhr.onload = () => {
        if (xhr.status === 401) settle("unauthorized", "failed");
        else if (xhr.status !== 200) settle("unexpected", "failed");
        else {
          consume();
          if (!settled) settle("unreachable", "failed");
        }
      };
      xhr.onerror = () => settle("unreachable", "failed");
      xhr.onabort = () => settle("unreachable", "failed");
      xhr.send(JSON.stringify({ message: text }));
    } catch {
      settle("unreachable", "failed");
    }
  }

  function sendMessage() {
    const text = draft.trim();
    if (text === "" || state !== "success" || activeUserId !== null) return;
    const userId = nextId("user");
    shouldAutoScroll.current = true;
    setDraft("");
    streamReply(userId, text, false);
  }

  function retry(userId: string) {
    const user = messages.find((message) => message.id === userId && message.role === "user");
    if (user && state === "success" && activeUserId === null) {
      streamReply(userId, user.text, true);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.chatScreen}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.chatHeader}>
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={() => commitName(name)}
          maxLength={MAX_NAME_LENGTH}
          accessibilityLabel="Companion name"
          style={styles.headerName}
        />
        <Text
          style={styles.headerMeta}
          accessibilityLabel={`Setup ${identity.mode}. ${toolsSummary}.`}
        >
          {toolsSummary}
        </Text>
      </View>
      <View style={styles.connectionRow}>
        <TextInput
          value={token}
          onChangeText={(value) => {
            setToken(value);
            setState("idle");
          }}
          placeholder="Local API token"
          placeholderTextColor="#8A8A8A"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          editable={!busy}
          accessibilityLabel="Local API token"
          style={styles.connectionInput}
        />
        <Pressable
          onPress={() => void checkConnection()}
          disabled={busy || token.trim() === ""}
          accessibilityRole="button"
          accessibilityLabel="Connect"
          accessibilityState={{ disabled: busy || token.trim() === "", busy }}
          style={({ pressed }) => [
            styles.connectButton,
            (busy || token.trim() === "") && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          {state === "loading" ? (
            <ActivityIndicator color="#121212" />
          ) : (
            <Text style={styles.connectLabel}>Connect</Text>
          )}
        </Pressable>
      </View>
      <Text
        accessibilityLiveRegion="polite"
        style={[
          styles.connectionStatus,
          state === "success" && styles.statusSuccess,
          (state === "unauthorized" || state === "unreachable" || state === "unexpected") &&
            styles.statusError,
        ]}
      >
        {STATUS_TEXT[state]}
      </Text>
      {persistError || chatPersistError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not save locally. Try again.
        </Text>
      ) : null}
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            assistantName={identity.name}
            canRetry={state === "success" && activeUserId === null}
            onRetry={retry}
          />
        )}
        contentContainerStyle={messages.length === 0 ? styles.emptyChat : styles.messageList}
        ListEmptyComponent={
          chatReady ? (
            <Text style={styles.emptyText}>Start a conversation with {identity.name}.</Text>
          ) : (
            <ActivityIndicator color="#C4B5FD" />
          )
        }
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={({ nativeEvent }) => {
          const distanceFromEnd =
            nativeEvent.contentSize.height -
            nativeEvent.layoutMeasurement.height -
            nativeEvent.contentOffset.y;
          shouldAutoScroll.current = distanceFromEnd < 80;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (shouldAutoScroll.current) list.current?.scrollToEnd({ animated: true });
        }}
      />
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={state === "success" ? "Message" : "Connect to send a message"}
          placeholderTextColor="#8A8A8A"
          multiline
          maxLength={MAX_MESSAGE_LENGTH}
          editable={state === "success" && activeUserId === null}
          keyboardAppearance="dark"
          accessibilityLabel="Message"
          style={styles.composerInput}
        />
        <Pressable
          onPress={sendMessage}
          disabled={draft.trim() === "" || state !== "success" || activeUserId !== null}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{
            disabled: draft.trim() === "" || state !== "success" || activeUserId !== null,
          }}
          style={({ pressed }) => [
            styles.sendButton,
            (draft.trim() === "" || state !== "success" || activeUserId !== null) &&
              styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text allowFontScaling={false} style={styles.sendLabel}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({
  message,
  assistantName,
  canRetry,
  onRetry,
}: {
  message: ChatMessage;
  assistantName: string;
  canRetry: boolean;
  onRetry: (userId: string) => void;
}) {
  const assistant = message.role === "assistant";
  return (
    <View style={[styles.messageRow, !assistant && styles.userMessageRow]}>
      <View style={[styles.bubble, assistant ? styles.assistantBubble : styles.userBubble]}>
        <Text
          accessibilityLabel={`${assistant ? assistantName : "You"}: ${
            message.text || (message.status === "streaming" ? "Reply streaming" : "Reply interrupted")
          }`}
          style={styles.messageText}
        >
          {message.text || (message.status === "streaming" ? "…" : "Reply interrupted.")}
        </Text>
        {message.status === "failed" && message.replyTo ? (
          <Pressable
            onPress={() => onRetry(message.replyTo!)}
            disabled={!canRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry reply"
            accessibilityState={{ disabled: !canRetry }}
            style={styles.retryButton}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
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
      accessibilityRole="radio"
      accessibilityLabel={`${title}. ${detail}.`}
      accessibilityState={{ checked: selected }}
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
  chatScreen: {
    flex: 1,
  },
  chatHeader: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#2A2A2A",
  },
  headerName: {
    color: "#F5F5F5",
    fontSize: 22,
    fontWeight: "600",
    minHeight: 44,
    padding: 0,
  },
  headerMeta: {
    color: "#8A8A8A",
    fontSize: 13,
  },
  connectionRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  connectionInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: "#1E1E1E",
    color: "#F5F5F5",
    paddingHorizontal: 12,
    fontSize: 16,
  },
  connectButton: {
    minWidth: 88,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: "#C4B5FD",
  },
  connectLabel: {
    color: "#121212",
    fontSize: 15,
    fontWeight: "600",
  },
  connectionStatus: {
    color: "#A3A3A3",
    fontSize: 13,
    minHeight: 28,
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  messageList: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  emptyChat: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  emptyText: {
    color: "#8A8A8A",
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center",
  },
  messageRow: {
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  userMessageRow: {
    justifyContent: "flex-end",
  },
  bubble: {
    maxWidth: "84%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  assistantBubble: {
    backgroundColor: "#262626",
    borderBottomLeftRadius: 6,
  },
  userBubble: {
    backgroundColor: "#6D5CA8",
    borderBottomRightRadius: 6,
  },
  messageText: {
    color: "#F5F5F5",
    fontSize: 17,
    lineHeight: 23,
  },
  retryButton: {
    alignSelf: "flex-start",
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    marginTop: 2,
  },
  retryLabel: {
    color: "#C4B5FD",
    fontSize: 15,
    fontWeight: "600",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2A2A2A",
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 18,
    backgroundColor: "#1E1E1E",
    color: "#F5F5F5",
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#C4B5FD",
  },
  sendLabel: {
    color: "#121212",
    fontSize: 26,
    fontWeight: "600",
    lineHeight: 30,
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
  modeGroup: {
    gap: 16,
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
