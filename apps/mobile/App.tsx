import AsyncStorage from "@react-native-async-storage/async-storage";
import { MAX_MEMORY_CONTENT, MAX_QUESTION_CHARS, MEMORY_CONFIRM_REPLY, parseAccountDeleteResponse, parseChatStreamEvent, parseHealthResponse, parseMemoryConfirmResponse, parseMemoryItem, parseMemoryListResponse, parseMemoryPauseRequest, parseRememberContent, parseSubagentCard, parseTaskListResponse, type ApprovalRequest, type BrowserTimeline, type QuestionAnswer, type TaskState } from "@lilith/contracts";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
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
  webResearchEnabledFromIdentity,
  type AgentIdentity,
  type OptionalTool,
  type SetupMode,
} from "./identity";
import {
  CHAT_STORAGE_KEY,
  MAX_MESSAGE_LENGTH,
  appendReply,
  applyServerCards,
  beginReply,
  finishReply,
  parsePersistedChat,
  redactRefusedSecrets,
  retryReply,
  serializeChat,
  setTaskReply,
  upsertSubagent,
  type ChatMessage,
  type SubagentCard,
} from "./chat";
import {
  memoryEnabledFromIdentity,
  memoryRowAccessibilityLabel,
  removeMemory,
  replaceMemory,
  type MemoryItem,
} from "./memory";
import {
  ACCOUNT_DELETION_NOTICE,
  ACCOUNT_STORAGE_KEYS,
  PROVIDER_SIDE_LIMIT,
  RETENTION_SCHEDULE,
  clearLocalAccountData,
  createAccountPurge,
  enqueueAccountWrite,
  markAccountLocalCleared,
  markAccountServerDeleted,
  shouldPersistAccountData,
  type AccountPurge,
  type PersistQueue,
} from "./privacy";
import {
  jpegBytesToDataUri,
  nextScreenshotExpiryDelayMs,
  pruneShotCache,
  rememberShot,
  screenshotExpired,
  shouldFetchScreenshot,
  shotStillVisible,
  type ShotCacheEntry,
} from "./screenshots";
import {
  approvalConsentHint,
  approvalExpiryHint,
  consumedApprovalLabel,
  isStoppableState,
  isTaskDecisionDisabled,
  isTaskStopDisabled,
  type PendingTaskControl,
} from "./task-controls";
import { colors } from "./theme";
import { accountInitials, agentOverviewDestination, type HomeScreen } from "./navigation";

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3000").replace(/\/$/, "");
const TIMEOUT_MS = 8000;
const BROWSER_APPROVE_TIMEOUT_MS = 90_000;

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

const TASK_STATE_LABEL: Record<TaskState, string> = {
  waiting: "Waiting",
  working: "Working",
  needs_input: "Needs input",
  paused: "Paused",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Failed",
};

const BROWSER_OP_LABEL: Record<string, string> = {
  open: "Opened",
  dismissCookies: "Cookie dialog",
  read: "Reading page",
  find: "Find on page",
  scroll: "Scrolled",
  screenshot: "Screenshot",
};

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
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveRevision = useRef(0);
  const accountPurge = useRef(createAccountPurge());

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

  useEffect(() => {
    if (identity !== null || !accountPurge.current.localCleared) return;
    accountPurge.current.serverDeleted = false;
    accountPurge.current.localCleared = false;
  }, [identity]);

  async function persist(next: AgentIdentity) {
    if (identity === null) {
      accountPurge.current.serverDeleted = false;
      accountPurge.current.localCleared = false;
    }
    if (!shouldPersistAccountData(accountPurge.current)) return;
    const revision = ++saveRevision.current;
    setIdentity(next);
    try {
      await enqueueAccountWrite(saveQueue, accountPurge.current, () =>
        AsyncStorage.setItem(IDENTITY_STORAGE_KEY, serializeIdentity(next)),
      );
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
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : identity === null ? (
          <Onboarding onComplete={(next) => void persist(next)} />
        ) : (
          <Home
            identity={identity}
            persistError={persistError}
            identitySaveQueue={saveQueue}
            accountPurge={accountPurge.current}
            onIdentityChange={(next) => void persist(next)}
            onAccountDeleted={() => {
              const revision = ++saveRevision.current;
              markAccountLocalCleared(accountPurge.current);
              if (revision === saveRevision.current) {
                setPersistError(false);
                setIdentity(null);
              }
            }}
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
      <Text accessible={false} importantForAccessibility="no" style={styles.welcomeMark}>✦</Text>
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
  identitySaveQueue,
  accountPurge,
  onIdentityChange,
  onAccountDeleted,
}: {
  identity: AgentIdentity;
  persistError: boolean;
  identitySaveQueue: PersistQueue;
  accountPurge: AccountPurge;
  onIdentityChange: (identity: AgentIdentity) => void;
  onAccountDeleted: () => void;
}) {
  const [name, setName] = useState(identity.name);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatReady, setChatReady] = useState(false);
  const [chatPersistError, setChatPersistError] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [hydrateError, setHydrateError] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [memoryError, setMemoryError] = useState(false);
  const [accountError, setAccountError] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [serverDeleted, setServerDeleted] = useState(accountPurge.serverDeleted);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [memoryPaused, setMemoryPaused] = useState(false);
  const [memoryReady, setMemoryReady] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [screen, setScreen] = useState<HomeScreen>("chat");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingControl, setPendingControl] = useState<PendingTaskControl>(null);
  const pendingTaskLock = useRef<PendingTaskControl>(null);
  const decisionAbort = useRef<AbortController | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
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
  const memoryEnabled = memoryEnabledFromIdentity(identity);
  const webResearchEnabled = webResearchEnabledFromIdentity(identity);

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
    if (!chatReady || !shouldPersistAccountData(accountPurge)) return;
    const revision = ++saveRevision.current;
    void enqueueAccountWrite(saveQueue, accountPurge, () =>
      AsyncStorage.setItem(CHAT_STORAGE_KEY, serializeChat(messages)),
    ).then(
      () => {
        if (revision === saveRevision.current) setChatPersistError(false);
      },
      () => {
        if (revision === saveRevision.current) setChatPersistError(true);
      },
    );
  }, [accountPurge, chatReady, messages]);

  function commitName(raw: string) {
    const next = identityFromChoice(raw, identity.mode);
    setName(next.name);
    if (next.name !== identity.name || persistError) onIdentityChange(next);
  }

  async function checkConnection() {
    setState("loading");
    setHydrateError(false);
    setControlError(false);
    setMemoryError(false);
    setAccountError(false);
    setMemories([]);
    setMemoryPaused(false);
    setMemoryReady(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let connected = false;
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
      connected = true;
      setState("success");
    } catch {
      setState("unreachable");
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!connected) return;
    const hydrateController = new AbortController();
    const hydrateTimer = setTimeout(() => hydrateController.abort(), TIMEOUT_MS);
    try {
      const tasks = await fetch(`${API_URL}/tasks`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: hydrateController.signal,
      });
      if (tasks.status !== 200) throw new Error("hydrate");
      const list = parseTaskListResponse(await tasks.json());
      setMessages((current) => applyServerCards(current, list.tasks));
      setHydrateError(false);
    } catch {
      setHydrateError(true);
    } finally {
      clearTimeout(hydrateTimer);
    }
    await refreshMemories();
  }

  async function refreshMemories() {
    const memoryController = new AbortController();
    const memoryTimer = setTimeout(() => memoryController.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/memories`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: memoryController.signal,
      });
      if (response.status !== 200) throw new Error("hydrate");
      const list = parseMemoryListResponse(await response.json());
      setMemories(list.memories);
      setMemoryPaused(list.paused);
      setMemoryReady(true);
      setMemoryError(false);
    } catch {
      setMemories([]);
      setMemoryPaused(false);
      setMemoryReady(false);
      setMemoryError(true);
    } finally {
      clearTimeout(memoryTimer);
    }
  }

  async function confirmSensitiveMemory(consent: boolean, content: string) {
    setMemoryBusy(true);
    setMemoryError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/memories/confirm`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ consent, content, memoryEnabled }),
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error("memory");
      const result = parseMemoryConfirmResponse(await response.json());
      if (result.confirmed && result.memory !== undefined) {
        const memory = result.memory;
        setMemories((current) => {
          const replaced = replaceMemory(current, memory);
          return replaced === current ? [...current, memory] : replaced;
        });
        setEditingId(null);
        setEditDraft("");
      }
      await refreshMemories();
    } catch {
      setMemoryError(true);
    } finally {
      clearTimeout(timer);
      setMemoryBusy(false);
    }
  }

  function promptSensitiveMemoryConfirm(content: string) {
    Alert.alert(
      "Sensitive memory",
      "This looks like personal or sensitive data. Store it as a memory?",
      [
        { text: "Don't store", style: "cancel", onPress: () => void confirmSensitiveMemory(false, content) },
        { text: "Store", onPress: () => void confirmSensitiveMemory(true, content) },
      ],
    );
  }

  async function setPaused(paused: boolean) {
    if (memoryBusy || state !== "success" || !memoryEnabled) return;
    setMemoryBusy(true);
    setMemoryError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/memories/pause`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ paused }),
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error("memory");
      setMemoryPaused(parseMemoryPauseRequest(await response.json()).paused);
    } catch {
      setMemoryError(true);
    } finally {
      clearTimeout(timer);
      setMemoryBusy(false);
    }
  }

  async function saveEditedMemory() {
    if (editingId === null || memoryBusy || state !== "success") return;
    const content = editDraft.trim();
    if (content === "") return;
    setMemoryBusy(true);
    setMemoryError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/memories/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        promptSensitiveMemoryConfirm(content);
        return;
      }
      if (response.status !== 200) throw new Error("memory");
      const updated = parseMemoryItem(await response.json());
      setMemories((current) => replaceMemory(current, updated));
      setEditingId(null);
      setEditDraft("");
    } catch {
      setMemoryError(true);
    } finally {
      clearTimeout(timer);
      setMemoryBusy(false);
    }
  }

  async function deleteMemoryItem(id: string) {
    if (memoryBusy || state !== "success") return;
    setMemoryBusy(true);
    setMemoryError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error("memory");
      const list = parseMemoryListResponse(await response.json());
      setMemories(list.memories);
      setMemoryPaused(list.paused);
      if (editingId === id) {
        setEditingId(null);
        setEditDraft("");
      }
    } catch {
      setMemoryError(true);
    } finally {
      clearTimeout(timer);
      setMemoryBusy(false);
    }
  }

  async function deleteAccount() {
    if (accountBusy || accountPurge.localCleared) return;
    if (!accountPurge.serverDeleted && state !== "success") return;
    setAccountBusy(true);
    setAccountError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      if (!accountPurge.serverDeleted) {
        const response = await fetch(`${API_URL}/account/delete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ consent: true }),
          signal: controller.signal,
        });
        if (response.status !== 200) throw new Error("account");
        parseAccountDeleteResponse(await response.json());
        request.current?.abort();
        markAccountServerDeleted(accountPurge);
        setServerDeleted(true);
      }
      await clearLocalAccountData([saveQueue, identitySaveQueue], () =>
        AsyncStorage.multiRemove([...ACCOUNT_STORAGE_KEYS]),
      );
      onAccountDeleted();
    } catch {
      setAccountError(true);
    } finally {
      clearTimeout(timer);
      if (!accountPurge.localCleared) setAccountBusy(false);
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
      setMessages((current) => redactRefusedSecrets(finishReply(current, userId, replyStatus)));
      setActiveUserId(null);
      setState(nextState);
      request.current = null;
      if (nextState === "success") {
        void refreshMemories();
        const content = parseRememberContent(text);
        if (spokenReply === MEMORY_CONFIRM_REPLY && content !== undefined) {
          promptSensitiveMemoryConfirm(content);
        }
      }
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
          } else if (event.type === "subagent") {
            const { type: _type, ...card } = event;
            setMessages((current) => upsertSubagent(current, userId, card));
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
      xhr.send(JSON.stringify({ message: text, memoryEnabled, webResearchEnabled }));
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

  const loadScreenshot = useCallback(async (id: string, createdAt: number): Promise<string | undefined> => {
    if (screenshotExpired(createdAt, Date.now()) || token.trim() === "") return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/screenshots/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token.trim()}` },
        signal: controller.signal,
      });
      if (response.status !== 200) return undefined;
      return jpegBytesToDataUri(new Uint8Array(await response.arrayBuffer()));
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }, [token]);

  async function controlTask(taskId: string, action: "stop" | "resume") {
    if (action === "resume" && (pendingTaskLock.current !== null || state !== "success")) return;
    if (action === "stop") {
      if (state !== "success" && state !== "streaming") return;
      if (pendingTaskLock.current?.action === "stop") return;
      decisionAbort.current?.abort();
    }
    const pending: Exclude<PendingTaskControl, null> = {
      taskId,
      action: action === "stop" ? "stop" : "decision",
    };
    pendingTaskLock.current = pending;
    setPendingControl(pending);
    setControlError(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/${action}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          ...(action === "resume" ? { "Content-Type": "application/json" } : {}),
        },
        body: action === "resume" ? JSON.stringify({ consent: true }) : undefined,
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error("control");
      const card = parseSubagentCard(await response.json());
      setMessages((current) => applyServerCards(current, [card]));
    } catch {
      if (pendingTaskLock.current === pending) setControlError(true);
    } finally {
      clearTimeout(timer);
      if (pendingTaskLock.current === pending) {
        pendingTaskLock.current = null;
        setPendingControl(null);
      }
    }
  }

  async function submitTaskDecision(taskId: string, answer: QuestionAnswer | { approval: ApprovalRequest; consent: boolean }) {
    if (pendingTaskLock.current !== null || state !== "success") return;
    const pending: Exclude<PendingTaskControl, null> = { taskId, action: "decision" };
    pendingTaskLock.current = pending;
    setPendingControl(pending);
    setControlError(false);
    const controller = new AbortController();
    decisionAbort.current = controller;
    const timeoutMs = "approval" in answer ? BROWSER_APPROVE_TIMEOUT_MS : TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const poll = setInterval(() => {
      void (async () => {
        try {
          const listed = await fetch(`${API_URL}/tasks`, {
            headers: { Authorization: `Bearer ${token.trim()}` },
          });
          if (listed.status !== 200) return;
          const body = parseTaskListResponse(await listed.json());
          const live = body.tasks.find((card) => card.id === taskId);
          if (live !== undefined) setMessages((current) => applyServerCards(current, [live]));
        } catch {
          // keep waiting for the decision POST
        }
      })();
    }, 500);
    try {
      const response = await fetch(`${API_URL}/tasks/${encodeURIComponent(taskId)}/${"approval" in answer ? "approve" : "answer"}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(answer),
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error("control");
      const card = parseSubagentCard(await response.json());
      setMessages((current) => {
        const next = applyServerCards(current, [card]);
        return card.result === undefined ? next : setTaskReply(next, card.id, card.result);
      });
    } catch {
      if (pendingTaskLock.current === pending && !controller.signal.aborted) setControlError(true);
    } finally {
      clearInterval(poll);
      clearTimeout(timer);
      if (decisionAbort.current === controller) decisionAbort.current = null;
      if (pendingTaskLock.current === pending) {
        pendingTaskLock.current = null;
        setPendingControl(null);
      }
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.chatScreen}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.topBar}>
        <Pressable onPress={() => setScreen(agentOverviewDestination(screen))} accessibilityRole="button" accessibilityLabel="Agent overview" style={styles.iconButton}>
          <Text style={styles.gridIcon} accessible={false}>▦</Text>
        </Pressable>
        <Text style={styles.topBarTitle}>{screen === "chat" ? identity.name : screen === "workspace" ? "Workspace" : screen === "agents" ? "Agents" : screen === "account" ? "Account" : screen === "settings" ? "Settings" : screen === "memories" ? "Memory" : "Privacy"}</Text>
        <Pressable onPress={() => setScreen("workspace")} accessibilityRole="button" accessibilityLabel="Computer workspace" style={styles.iconButton}>
          <Text style={styles.workspaceIcon} accessible={false}>✦</Text>
        </Pressable>
        <Pressable onPress={() => setScreen("account")} accessibilityRole="button" accessibilityLabel="Account and settings" style={styles.accountBadge}>
          <Text style={styles.accountInitials}>{accountInitials(name)}</Text>
        </Pressable>
      </View>
      {screen === "chat" ? <ScrollView style={styles.shell} contentContainerStyle={styles.shellContent} keyboardShouldPersistTaps="handled">
      {screen === "chat" ? <View style={styles.chatHeader}>
        <Text style={styles.headerMeta} accessibilityLabel={`Setup ${identity.mode}. ${toolsSummary}.`}>{toolsSummary}</Text>
      </View> : null}
      <View style={styles.connectionRow}>
        <TextInput
          value={token}
          onChangeText={(value) => {
            setToken(value);
            setState("idle");
            setHydrateError(false);
            setControlError(false);
            setMemoryError(false);
            setAccountError(false);
            setMemories([]);
            setMemoryPaused(false);
            setMemoryReady(false);
            setScreen("chat");
            setEditingId(null);
          }}
          placeholder="Local API token"
          placeholderTextColor={colors.muted}
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
            <ActivityIndicator color={colors.canvas} />
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
      <Text style={styles.privacyNotice}>{PROVIDER_SIDE_LIMIT}</Text>
      {persistError || chatPersistError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not save locally. Try again.
        </Text>
      ) : null}
      {hydrateError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not load tasks. Try again.
        </Text>
      ) : null}
      {controlError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not update the task. Try again.
        </Text>
      ) : null}
      {memoryError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not load or update memories. Try again.
        </Text>
      ) : null}
      {accountError ? (
        <Text accessibilityLiveRegion="polite" style={styles.statusError}>
          Could not delete the account. Try again.
        </Text>
      ) : null}
      </ScrollView> : null}
      {screen === "agents" ? (
        <View style={styles.navigationPanel}>
          <Text style={styles.sectionLabel} accessibilityRole="header">Your agents</Text>
          <Pressable onPress={() => setScreen("chat")} accessibilityRole="button" accessibilityLabel={`Open ${name}, main agent`} style={styles.navigationCard}>
            <Text style={styles.navigationTitle}>{name}</Text><Text style={styles.memoryMeta}>Main agent · research, tools, and coordination</Text>
          </Pressable>
        </View>
      ) : screen === "account" ? (
        <View style={styles.navigationPanel}>
          <Text style={styles.sectionLabel} accessibilityRole="header">Account</Text>
          <Pressable onPress={() => setScreen("settings")} accessibilityRole="button" style={styles.navigationCard}><Text style={styles.navigationTitle}>Settings</Text><Text style={styles.memoryMeta}>Name and starting setup</Text></Pressable>
          <Pressable onPress={() => { setScreen("memories"); if (state === "success") void refreshMemories(); }} accessibilityRole="button" style={styles.navigationCard}><Text style={styles.navigationTitle}>Memory</Text><Text style={styles.memoryMeta}>Review, edit, pause, or delete saved memories</Text></Pressable>
          <Pressable onPress={() => setScreen("privacy")} accessibilityRole="button" style={styles.navigationCard}><Text style={styles.navigationTitle}>Privacy and deletion</Text><Text style={styles.memoryMeta}>Retention and account deletion</Text></Pressable>
        </View>
      ) : screen === "settings" ? (
        <View style={styles.navigationPanel}>
          <Text style={styles.sectionLabel} accessibilityRole="header">Settings</Text>
          <NameField value={name} onChangeText={setName} onEndEditing={() => commitName(name)} />
          <Text style={styles.memoryMeta} accessibilityLabel={`Setup ${identity.mode}. ${toolsSummary}.`}>{toolsSummary}</Text>
        </View>
      ) : screen === "workspace" ? (
        <ScrollView contentContainerStyle={styles.navigationPanel}>
          <Text style={styles.sectionLabel} accessibilityRole="header">Workspace</Text>
          {messages.flatMap((message) => message.subagents ?? []).filter((card) => card.browser !== undefined).map((card) => (
            <View key={card.id} style={styles.navigationCard}>
              <Text style={styles.navigationTitle}>{TASK_STATE_LABEL[card.state]}</Text>
              <Text style={styles.memoryMeta}>{card.assignment}</Text>
              <BrowserTimelineView timeline={card.browser!} loadShot={loadScreenshot} />
            </View>
          ))}
          {!messages.some((message) => message.subagents?.some((card) => card.browser !== undefined)) ? <Text style={styles.emptyText}>Computer sessions and browser screenshots will appear here.</Text> : null}
        </ScrollView>
      ) : screen === "privacy" ? (
        <PrivacyPanel
          connected={state === "success" || serverDeleted}
          busy={accountBusy}
          onDelete={() => {
            Alert.alert("Delete account", ACCOUNT_DELETION_NOTICE, [
              { text: "Cancel", style: "cancel" },
              { text: "Delete account", style: "destructive", onPress: () => void deleteAccount() },
            ]);
          }}
        />
      ) : screen === "memories" ? (
        <MemoriesPanel
          connected={state === "success"}
          enabled={memoryEnabled}
          paused={memoryPaused}
          ready={memoryReady}
          failed={memoryError && !memoryReady}
          busy={memoryBusy || state !== "success"}
          memories={memories}
          editingId={editingId}
          editDraft={editDraft}
          onEditDraft={setEditDraft}
          onPause={(paused) => void setPaused(paused)}
          onStartEdit={(item) => {
            setEditingId(item.id);
            setEditDraft(item.content);
          }}
          onCancelEdit={() => {
            setEditingId(null);
            setEditDraft("");
          }}
          onSaveEdit={() => void saveEditedMemory()}
          onDelete={(id) => void deleteMemoryItem(id)}
        />
      ) : (
      <FlatList
        style={styles.chatSurface}
        ref={list}
        data={messages}
        keyExtractor={(message) => message.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            assistantName={identity.name}
            canRetry={state === "success" && activeUserId === null}
            canControl={state === "success" || state === "streaming"}
            pendingControl={pendingControl}
            onRetry={retry}
            onStop={(taskId) => void controlTask(taskId, "stop")}
            onResume={(taskId) => void controlTask(taskId, "resume")}
            onAnswer={(taskId, answer) => void submitTaskDecision(taskId, answer)}
            onApproval={(approval, consent) => void submitTaskDecision(approval.taskId, { approval, consent })}
            onScreenshot={loadScreenshot}
          />
        )}
        contentContainerStyle={messages.length === 0 ? styles.emptyChat : styles.messageList}
        ListEmptyComponent={
          chatReady ? (
            <View style={styles.emptyCard}>
              <Text accessible={false} importantForAccessibility="no" style={styles.welcomeMark}>✦</Text>
              <Text style={styles.emptyTitle}>{identity.name}</Text>
              <Text style={styles.emptyText}>Start a conversation with {identity.name}.</Text>
            </View>
          ) : (
            <ActivityIndicator color={colors.accent} />
          )
        }
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
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
      )}
      {screen === "chat" ? <View style={styles.composerDock}>
        <Text accessible={false} importantForAccessibility="no" style={styles.mascotSpace}>✦</Text>
        <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={state === "success" ? "Message" : "Connect to send a message"}
          placeholderTextColor={colors.muted}
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
      </View> : null}
    </KeyboardAvoidingView>
  );
}

function PrivacyPanel({
  connected,
  busy,
  onDelete,
}: {
  connected: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const locked = busy || !connected;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={styles.memoryList}
    >
      <View style={styles.memoryCard}>
      <Text style={styles.sectionLabel} accessibilityRole="header">
        Privacy
      </Text>
      {RETENTION_SCHEDULE.map((line) => (
        <Text key={line} style={styles.privacyNotice}>
          {line}
        </Text>
      ))}
      </View>
      <View style={styles.memoryCard}>
      <Text style={styles.sectionLabel} accessibilityRole="header">
        Provider copies
      </Text>
      <Text style={styles.privacyNotice}>{PROVIDER_SIDE_LIMIT}</Text>
      </View>
      <View style={styles.memoryCard}>
      <Text style={styles.sectionLabel} accessibilityRole="header">
        Delete account
      </Text>
      <Text style={styles.privacyNotice}>{ACCOUNT_DELETION_NOTICE}</Text>
      {!connected ? (
        <Text style={styles.memoryMeta}>Connect to delete this account on the server.</Text>
      ) : null}
      <Pressable
        onPress={onDelete}
        disabled={locked}
        accessibilityRole="button"
        accessibilityLabel="Delete account"
        accessibilityHint="Removes chats, tasks, and memories immediately. Backups expire within 30 days."
        accessibilityState={{ disabled: locked, busy }}
        style={({ pressed }) => [styles.taskControl, locked && styles.buttonDisabled, pressed && !locked && styles.buttonPressed]}
      >
        <Text style={styles.destructiveLabel}>Delete account</Text>
      </Pressable>
      </View>
    </ScrollView>
  );
}

function MemoriesPanel({
  connected,
  enabled,
  paused,
  ready,
  failed,
  busy,
  memories,
  editingId,
  editDraft,
  onEditDraft,
  onPause,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  connected: boolean;
  enabled: boolean;
  paused: boolean;
  ready: boolean;
  failed: boolean;
  busy: boolean;
  memories: MemoryItem[];
  editingId: string | null;
  editDraft: string;
  onEditDraft: (text: string) => void;
  onPause: (paused: boolean) => void;
  onStartEdit: (item: MemoryItem) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: (id: string) => void;
}) {
  if (!connected) {
    return (
      <View style={styles.emptyChat}>
        <Text style={styles.emptyText}>Connect to manage memories.</Text>
      </View>
    );
  }
  if (!ready) {
    return (
      <View style={styles.emptyChat}>
        {failed ? (
          <Text style={styles.emptyText}>Could not load memories. Try again.</Text>
        ) : (
          <ActivityIndicator color={colors.accent} accessibilityLabel="Loading memories" />
        )}
      </View>
    );
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={memories.length === 0 ? styles.emptyChat : styles.memoryList}
    >
      <Text style={styles.sectionLabel}>Memories</Text>
      {enabled ? (
        <Pressable
          onPress={() => onPause(!paused)}
          disabled={busy}
          accessibilityRole="switch"
          accessibilityLabel="Pause memory"
          accessibilityHint="Blocks new captures and retrieval. List, edit and delete stay available."
          accessibilityState={{ checked: paused, disabled: busy }}
          style={({ pressed }) => [styles.memoryPause, busy && styles.buttonDisabled, pressed && !busy && styles.buttonPressed]}
        >
          <Text style={styles.taskControlLabel}>{paused ? "Memory paused" : "Pause memory"}</Text>
        </Pressable>
      ) : (
        <Text style={styles.memoryMeta}>Memory is off for the Blank setup. Capture and retrieval are disabled.</Text>
      )}
      {memories.length === 0 ? (
        <Text style={styles.emptyText}>No memories yet. Say Merk dir in chat to store one.</Text>
      ) : (
        memories.map((item) => {
          const editing = editingId === item.id;
          const savedAt = new Date(item.updatedAt).toLocaleString();
          return (
            <View key={item.id} style={styles.memoryCard}>
              {editing ? (
                <TextInput
                  value={editDraft}
                  onChangeText={onEditDraft}
                  multiline
                  maxLength={MAX_MEMORY_CONTENT}
                  keyboardAppearance="dark"
                  accessibilityLabel="Memory content"
                  style={styles.memoryInput}
                />
              ) : (
                <Text style={styles.subagentAssignment}>{item.content}</Text>
              )}
              <Text style={styles.memoryMeta}>
                Chat · {savedAt}
              </Text>
              <View style={styles.memoryActions}>
                {editing ? (
                  <>
                    <Pressable
                      onPress={onSaveEdit}
                      disabled={busy || editDraft.trim() === ""}
                      accessibilityRole="button"
                      accessibilityLabel={memoryRowAccessibilityLabel("Save", editDraft, item.updatedAt)}
                      accessibilityState={{ disabled: busy || editDraft.trim() === "", busy }}
                      style={[styles.taskControl, (busy || editDraft.trim() === "") && styles.buttonDisabled]}
                    >
                      <Text style={styles.taskControlLabel}>Save</Text>
                    </Pressable>
                    <Pressable
                      onPress={onCancelEdit}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel editing"
                      accessibilityState={{ disabled: busy }}
                      style={[styles.taskControl, busy && styles.buttonDisabled]}
                    >
                      <Text style={styles.taskControlLabel}>Cancel</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    onPress={() => onStartEdit(item)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={memoryRowAccessibilityLabel("Edit", item.content, item.updatedAt)}
                    accessibilityState={{ disabled: busy, busy }}
                    style={[styles.taskControl, busy && styles.buttonDisabled]}
                  >
                    <Text style={styles.taskControlLabel}>Edit</Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => onDelete(item.id)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={memoryRowAccessibilityLabel("Delete", item.content, item.updatedAt)}
                  accessibilityHint="Removes this memory so it cannot be retrieved"
                  accessibilityState={{ disabled: busy, busy }}
                  style={[styles.taskControl, busy && styles.buttonDisabled]}
                >
                  <Text style={styles.destructiveLabel}>Delete</Text>
                </Pressable>
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function messageTime(id: string): string {
  const timestamp = Number(id.match(/-(\d+)-/)?.[1] ?? Date.now());
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MessageBubble({
  message,
  assistantName,
  canRetry,
  canControl,
  pendingControl,
  onRetry,
  onStop,
  onResume,
  onAnswer,
  onApproval,
  onScreenshot,
}: {
  message: ChatMessage;
  assistantName: string;
  canRetry: boolean;
  canControl: boolean;
  pendingControl: PendingTaskControl;
  onRetry: (userId: string) => void;
  onStop: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onAnswer: (taskId: string, answer: QuestionAnswer) => void;
  onApproval: (approval: ApprovalRequest, consent: boolean) => void;
  onScreenshot: (id: string, createdAt: number) => Promise<string | undefined>;
}) {
  const assistant = message.role === "assistant";
  const spoken =
    message.text ||
    (message.status === "streaming" ? "Reply streaming" : message.status === "failed" ? "Reply interrupted" : "");
  const visible =
    message.text ||
    (message.status === "streaming" ? "…" : message.status === "failed" ? "Reply interrupted." : "");
  return (
    <View style={[styles.messageRow, !assistant && styles.userMessageRow]}>
      <View style={[styles.bubble, assistant ? styles.assistantBubble : styles.userBubble]}>
        {message.subagents?.map((card) => (
          <SubagentStatusCard
            key={card.id}
            card={card}
            canControl={canControl}
            pendingControl={pendingControl}
            onStop={onStop}
            onResume={onResume}
            onAnswer={onAnswer}
            onApproval={onApproval}
            onScreenshot={onScreenshot}
          />
        ))}
        {visible !== "" ? (
          <Text accessibilityLabel={`${assistant ? assistantName : "You"}: ${spoken}`} style={styles.messageText}>
            {visible}
          </Text>
        ) : null}
        <Text style={styles.messageTime}>{messageTime(message.id)}</Text>
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

function SubagentStatusCard({
  card,
  canControl,
  pendingControl,
  onStop,
  onResume,
  onAnswer,
  onApproval,
  onScreenshot,
}: {
  card: SubagentCard;
  canControl: boolean;
  pendingControl: PendingTaskControl;
  onStop: (taskId: string) => void;
  onResume: (taskId: string) => void;
  onAnswer: (taskId: string, answer: QuestionAnswer) => void;
  onApproval: (approval: ApprovalRequest, consent: boolean) => void;
  onScreenshot: (id: string, createdAt: number) => Promise<string | undefined>;
}) {
  const question = card.question;
  const lockedText = question?.answer !== undefined && "text" in question.answer ? question.answer.text : "";
  const [draft, setDraft] = useState(lockedText);
  const answerLocked = question?.answer !== undefined;
  const decisionDisabled = isTaskDecisionDisabled({
    canControl,
    pending: pendingControl,
    state: card.state,
  });
  const approvalDisabled = isTaskDecisionDisabled({
    canControl,
    pending: pendingControl,
    state: card.state,
    expired: card.approval !== undefined && Date.now() >= card.approval.expiresAt,
  });
  const stopDisabled = isTaskStopDisabled({
    canControl,
    state: card.state,
    pending: pendingControl,
    cardId: card.id,
  });
  const resumeDisabled = isTaskDecisionDisabled({ canControl, pending: pendingControl });
  const answerDisabled = decisionDisabled || answerLocked;
  const canStop = isStoppableState(card.state);
  const stopBusy = pendingControl?.action === "stop" && pendingControl.taskId === card.id;
  const decisionBusy = pendingControl?.action === "decision" && pendingControl.taskId === card.id;
  const detail =
    card.state === "paused" && card.pauseReason === "time"
      ? "Paused after 15 minutes"
      : card.state === "paused" && card.pauseReason === "cost"
        ? "Paused at $1.00"
        : card.result
          ? `${TASK_STATE_LABEL[card.state]}. ${card.result}`
          : TASK_STATE_LABEL[card.state];
  return (
    <View style={styles.subagentCard}>
      <Text style={styles.subagentRole}>Research</Text>
      <Text style={styles.subagentAssignment}>{card.assignment}</Text>
      {card.browser ? <BrowserTimelineView timeline={card.browser} loadShot={onScreenshot} /> : null}
      <Text style={styles.subagentState}>{detail}</Text>
      {card.approval ? (
        <View style={styles.approvalCard}>
          <Text style={styles.questionPrompt}>One-time approval</Text>
          <Text style={styles.subagentAssignment}>Origin: {card.approval.origin}</Text>
          <Text style={styles.subagentAssignment}>Operation: {card.approval.operation}</Text>
          <Text style={styles.subagentAssignment}>Class: {card.approval.actionClass}</Text>
          <Text style={styles.subagentAssignment}>Data: {card.approval.payload || "None"}</Text>
          {card.approval.files.map((file) => (
            <Text key={file.path} style={styles.subagentAssignment}>File: {file.path}{"\n"}{file.content}</Text>
          ))}
          <Text style={styles.subagentAssignment}>Maximum cost: ${(card.approval.maxCostCents / 100).toFixed(2)}</Text>
          <Text style={styles.subagentState}>Expires: {new Date(card.approval.expiresAt).toLocaleString()}</Text>
          <Text selectable style={styles.subagentState}>SHA-256: {card.approval.payloadDigest}</Text>
          <Text accessibilityLiveRegion="polite" style={styles.subagentState}>
            {consumedApprovalLabel(card.approval, card.state)}
          </Text>
          {card.approval.state === "pending" ? (
            <>
              <Text style={styles.subagentState}>{approvalExpiryHint(card.approval)}</Text>
              {[true, false].map((consent) => {
                const locked = approvalDisabled;
                return (
                  <Pressable
                    key={String(consent)}
                    onPress={() => onApproval(card.approval!, consent)}
                    disabled={locked}
                    accessibilityRole="button"
                    accessibilityLabel={consent ? "Approve once" : "Reject action"}
                    accessibilityHint={approvalConsentHint(card.approval!, consent)}
                    accessibilityState={{ disabled: locked, busy: decisionBusy }}
                    style={[styles.taskControl, locked && styles.buttonDisabled]}
                  >
                    <Text style={consent ? styles.taskControlLabel : styles.destructiveLabel}>{consent ? "Approve once" : "Reject"}</Text>
                  </Pressable>
                );
              })}
            </>
          ) : null}
        </View>
      ) : null}
      {question ? (
        <>
          <Text style={styles.questionPrompt}>{question.prompt}</Text>
          {question.options.map((option) => {
            const selected =
              question.answer !== undefined &&
              "optionId" in question.answer &&
              question.answer.optionId === option.id;
            return (
              <Pressable
                key={option.id}
                onPress={() => onAnswer(card.id, { optionId: option.id })}
                disabled={answerDisabled}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{ disabled: answerDisabled, selected }}
                style={({ pressed }) => [
                  styles.questionOption,
                  selected && styles.questionOptionSelected,
                  answerDisabled && styles.buttonDisabled,
                  pressed && !answerDisabled && styles.buttonPressed,
                ]}
              >
                <Text style={styles.questionOptionLabel}>{option.label}</Text>
              </Pressable>
            );
          })}
          {/* ponytail: RN maxLength is UTF-16; POST /answer rejects >400 Unicode code points. */}
          <TextInput
            value={answerLocked ? lockedText : draft}
            onChangeText={setDraft}
            maxLength={MAX_QUESTION_CHARS}
            editable={!answerDisabled}
            multiline
            keyboardAppearance="dark"
            accessibilityLabel="Other answer"
            placeholder="Other answer"
            placeholderTextColor={colors.muted}
            style={styles.questionInput}
          />
          <Pressable
            onPress={() => {
              const text = draft.trim();
              if (text !== "") onAnswer(card.id, { text });
            }}
            disabled={answerDisabled || draft.trim() === ""}
            accessibilityRole="button"
            accessibilityLabel="Send answer"
            accessibilityState={{ disabled: answerDisabled || draft.trim() === "" }}
            style={({ pressed }) => [
              styles.questionSend,
              (answerDisabled || draft.trim() === "") && styles.buttonDisabled,
              pressed && !answerDisabled && styles.buttonPressed,
            ]}
          >
            <Text style={styles.questionSendLabel}>Send</Text>
          </Pressable>
        </>
      ) : null}
      {canStop ? (
        <Pressable
          onPress={() => onStop(card.id)}
          disabled={stopDisabled}
          accessibilityRole="button"
          accessibilityLabel="Stop task"
          accessibilityState={{ disabled: stopDisabled, busy: stopBusy }}
          style={({ pressed }) => [
            styles.taskControl,
            stopDisabled && styles.buttonDisabled,
            pressed && !stopDisabled && styles.buttonPressed,
          ]}
        >
          <Text style={styles.destructiveLabel}>Stop</Text>
        </Pressable>
      ) : null}
      {card.state === "paused" ? (
        <Pressable
          onPress={() => onResume(card.id)}
          disabled={resumeDisabled}
          accessibilityRole="button"
          accessibilityLabel="Resume task"
          accessibilityHint="Continues with a new 15 minute and 1 dollar budget"
          accessibilityState={{ disabled: resumeDisabled, busy: decisionBusy }}
          style={({ pressed }) => [
            styles.taskControl,
            resumeDisabled && styles.buttonDisabled,
            pressed && !resumeDisabled && styles.buttonPressed,
          ]}
        >
          <Text style={styles.taskControlLabel}>Resume</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function BrowserTimelineView({
  timeline,
  loadShot,
}: {
  timeline: BrowserTimeline;
  loadShot: (id: string, createdAt: number) => Promise<string | undefined>;
}) {
  const [shots, setShots] = useState<Record<string, ShotCacheEntry>>({});
  const [missing, setMissing] = useState<Record<string, true>>({});
  const [now, setNow] = useState(() => Date.now());
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = timeline.current;
  const currentLabel = `${BROWSER_OP_LABEL[current.op] ?? current.op}${current.url !== undefined ? ` · ${current.url}` : ""}`;

  useEffect(() => {
    const clearExpiryTimer = () => {
      if (expiryTimer.current !== undefined) clearTimeout(expiryTimer.current);
      expiryTimer.current = undefined;
    };
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") setNow(Date.now());
      else clearExpiryTimer();
    });
    return () => {
      sub.remove();
      clearExpiryTimer();
    };
  }, []);

  useEffect(() => {
    if (expiryTimer.current !== undefined) clearTimeout(expiryTimer.current);
    expiryTimer.current = undefined;
    if (AppState.currentState !== "active") return;
    const delay = nextScreenshotExpiryDelayMs(timeline.steps, shots, Date.now());
    if (delay === undefined) return;
    expiryTimer.current = setTimeout(() => {
      expiryTimer.current = undefined;
      const tick = Date.now();
      setNow(tick);
      setShots((cache) => pruneShotCache(cache, tick));
    }, delay);
    return () => {
      if (expiryTimer.current !== undefined) clearTimeout(expiryTimer.current);
      expiryTimer.current = undefined;
    };
  }, [now, shots, timeline]);

  useEffect(() => {
    setShots((cache) => pruneShotCache(cache, now));
  }, [now]);

  useEffect(() => {
    let active = true;
    const checkedAt = Date.now();
    setNow(checkedAt);
    setShots((cache) => pruneShotCache(cache, checkedAt));
    for (const step of timeline.steps) {
      const id = step.screenshotId;
      if (id === undefined) continue;
      if (!shouldFetchScreenshot(step, checkedAt)) {
        setMissing((currentMissing) => ({ ...currentMissing, [id]: true }));
        setShots((cache) => {
          const next = { ...cache };
          delete next[id];
          return pruneShotCache(next, checkedAt);
        });
        continue;
      }
      void loadShot(id, step.at).then((uri) => {
        if (!active) return;
        const appliedAt = Date.now();
        const expired = screenshotExpired(step.at, appliedAt);
        if (uri === undefined || expired) {
          setShots((cache) => {
            const next = { ...cache };
            delete next[id];
            return pruneShotCache(next, appliedAt);
          });
          if (expired) setNow(appliedAt);
          else setMissing((currentMissing) => ({ ...currentMissing, [id]: true }));
          return;
        }
        setMissing((currentMissing) => {
          if (currentMissing[id] !== true) return currentMissing;
          const next = { ...currentMissing };
          delete next[id];
          return next;
        });
        setShots((cache) => rememberShot(cache, id, uri, step.at, appliedAt));
      });
    }
    return () => {
      active = false;
    };
  }, [loadShot, timeline]);

  return (
    <View>
      <Text accessibilityLiveRegion="polite" style={styles.subagentState}>
        Step: {currentLabel}
      </Text>
      {timeline.steps.map((step, index) => {
        const label = `${BROWSER_OP_LABEL[step.op] ?? step.op}${step.url !== undefined ? ` · ${step.url}` : ""}`;
        const id = step.screenshotId;
        const entry = id === undefined ? undefined : shots[id];
        return (
          <View key={`${step.op}-${step.at}-${index}`} style={styles.browserStep}>
            <Text style={styles.subagentState}>{label}</Text>
            {id === undefined ? null : screenshotExpired(step.at, now) || (entry !== undefined && !shotStillVisible(entry, step.at, now)) ? (
              <Text style={styles.subagentState}>Screenshot expired</Text>
            ) : missing[id] === true ? (
              <Text style={styles.subagentState}>Screenshot unavailable</Text>
            ) : entry?.uri !== undefined ? (
              <Image
                source={{ uri: entry.uri }}
                accessibilityLabel={`Browser screenshot: ${label}`}
                resizeMode="contain"
                style={styles.browserShot}
              />
            ) : (
              <Text style={styles.subagentState}>Loading screenshot</Text>
            )}
          </View>
        );
      })}
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
        placeholderTextColor={colors.muted}
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
  // ponytail: scrollable chrome keeps safety copy reachable at large font sizes.
  shell: {
    maxHeight: "40%",
    flexGrow: 0,
    flexShrink: 0,
  },
  shellContent: { paddingBottom: 8 },
  topBar: {
    minHeight: 64,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  topBarTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "600" },
  iconButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.outline, borderRadius: 12 },
  gridIcon: { color: colors.accent, fontSize: 27, lineHeight: 31 },
  workspaceIcon: { color: colors.accent, fontSize: 25 },
  accountBadge: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  accountInitials: { color: colors.canvas, fontSize: 15, fontWeight: "700" },
  navigationPanel: { flexGrow: 1, paddingHorizontal: 18, paddingVertical: 16, gap: 12 },
  navigationCard: { padding: 16, gap: 6, borderWidth: 1, borderColor: colors.outline, borderRadius: 10, backgroundColor: colors.surface },
  navigationTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  welcomeMark: { color: colors.accent, fontSize: 48, textAlign: "center" },
  emptyCard: {
    width: "100%",
    padding: 24,
    gap: 12,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.surface,
  },
  emptyTitle: { color: colors.text, fontSize: 24, fontWeight: "700", textAlign: "center" },
  approvalCard: {
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  destructiveLabel: { color: colors.danger, fontSize: 15, fontWeight: "600" },
  safe: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  chatScreen: {
    flex: 1,
  },
  chatHeader: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 6,
  },
  headerMeta: {
    color: colors.muted,
    fontSize: 13,
  },
  connectionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  connectionInput: {
    flexGrow: 1,
    flexBasis: 160,
    borderWidth: 1,
    borderColor: colors.outline,
    minHeight: 48,
    borderRadius: 16,
    backgroundColor: colors.inset,
    color: colors.text,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  connectButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    minWidth: 88,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  connectLabel: {
    color: colors.canvas,
    fontSize: 15,
    fontWeight: "600",
  },
  connectionStatus: {
    color: colors.muted,
    fontSize: 13,
    minHeight: 28,
    paddingHorizontal: 14,
    paddingTop: 6,
  },
  messageList: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  chatSurface: { marginHorizontal: 14, flex: 1, borderWidth: 1, borderColor: "#34333F", borderRadius: 16, backgroundColor: "#19191F" },
  emptyChat: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  emptyText: {
    color: colors.muted,
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
    maxWidth: "94%",
    flexShrink: 1,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.outline,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  assistantBubble: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 5,
  },
  userBubble: {
    backgroundColor: colors.user,
    borderColor: colors.accent,
    borderBottomRightRadius: 5,
  },
  messageTime: { color: colors.muted, fontSize: 11, textAlign: "right", marginTop: 4 },
  messageText: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 23,
  },
  retryButton: {
    alignSelf: "flex-start",
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
    marginTop: 2,
  },
  retryLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  subagentCard: {
    gap: 8,
    marginBottom: 8,
    padding: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.outline,
    backgroundColor: colors.inset,
  },
  subagentRole: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  subagentAssignment: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
  },
  subagentState: {
    color: colors.muted,
    fontSize: 13,
  },
  browserStep: {
    gap: 4,
    marginTop: 6,
  },
  browserShot: {
    width: 240,
    height: 180,
    borderRadius: 8,
    backgroundColor: colors.inset,
  },
  questionPrompt: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
    marginTop: 6,
  },
  questionOption: {
    alignSelf: "stretch",
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.outline,
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
    marginTop: 4,
    paddingHorizontal: 8,
    borderRadius: 16,
  },
  questionOptionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.user,
  },
  questionOptionLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  questionInput: {
    borderWidth: 1,
    borderColor: colors.outline,
    minHeight: 48,
    marginTop: 8,
    borderRadius: 18,
    backgroundColor: colors.inset,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  questionSend: {
    alignSelf: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: colors.accent,
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
    marginTop: 4,
  },
  questionSendLabel: {
    color: colors.canvas,
    fontSize: 15,
    fontWeight: "600",
  },
  taskControl: {
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 16,
    backgroundColor: colors.surface,
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
    marginTop: 4,
  },
  taskControlLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  memoryList: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  memoryCard: {
    gap: 10,
    padding: 16,
    borderWidth: 1,
    borderRadius: 22,
    borderColor: colors.outline,
    backgroundColor: colors.surface,
  },
  memoryMeta: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  privacyNotice: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: colors.secondary,
    fontSize: 15,
    lineHeight: 22,
  },
  memoryPause: {
    alignSelf: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
  },
  memoryActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  memoryInput: {
    borderWidth: 1,
    borderColor: colors.outline,
    minHeight: 48,
    borderRadius: 18,
    backgroundColor: colors.inset,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  composerDock: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 8, marginBottom: 12 },
  composer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 26,
  },
  mascotSpace: { width: 30, color: colors.muted, fontSize: 18, textAlign: "center" },
  composerInput: {
    borderWidth: 1,
    borderColor: colors.outline,
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderRadius: 12,
    backgroundColor: colors.inset,
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sendButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
  },
  sendLabel: {
    color: colors.canvas,
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
    color: colors.text,
    fontSize: 36,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
  lede: {
    color: colors.muted,
    fontSize: 17,
    lineHeight: 24,
  },
  meta: {
    color: colors.muted,
    fontSize: 16,
    lineHeight: 22,
  },
  sectionLabel: {
    color: colors.accent,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.2,
    marginTop: 8,
  },
  field: {
    gap: 8,
  },
  fieldLabel: {
    color: colors.secondary,
    fontSize: 13,
    fontWeight: "600",
  },
  input: {
    backgroundColor: colors.inset,
    borderColor: colors.outline,
    borderWidth: 1,
    borderRadius: 18,
    color: colors.text,
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
    backgroundColor: colors.inset,
    borderColor: colors.outline,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  choiceSelected: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
  },
  choicePressed: {
    opacity: 0.85,
  },
  choiceMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.muted,
  },
  choiceMarkSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  choiceCopy: {
    flex: 1,
    gap: 2,
  },
  choiceTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
  choiceDetail: {
    color: colors.muted,
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
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: colors.accent,
    borderRadius: 18,
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
    color: colors.canvas,
    fontSize: 17,
    fontWeight: "600",
  },
  status: {
    color: colors.secondary,
    fontSize: 16,
    lineHeight: 22,
  },
  statusSuccess: {
    color: colors.success,
  },
  statusError: {
    color: colors.danger,
  },
});
