# Lilith

Local development slice: an Expo app calls one authenticated Node health endpoint through a shared TypeScript contract.

This is not production. Traffic is **plain HTTP** and the Bearer token is a **throwaway local secret**. SPEC.md requires HTTPS and real authentication before any real user data.

## Requirements

- Node 24+
- npm
- Windows PowerShell
- Android emulator AVD `Lilith_API_36` and/or a physical iPhone with Expo Go on the same Wi-Fi as this PC
- Expo Go must match this app's Expo SDK (`expo install --check`). If your phone is on a newer SDK, run `npm exec --workspace=@lilith/mobile -- expo install --fix`.

## Setup

```powershell
cd D:\Projekte\Lilith
npm install
Copy-Item services\api\.env.example services\api\.env
Copy-Item apps\mobile\.env.example apps\mobile\.env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value into `services\api\.env` as `LOCAL_API_TOKEN`; keep `ALPHA_OWNER_ID=local-owner` for the private Alpha. Enter the token in the app when prompted. The owner ID is server-controlled, and the app keeps the token in memory only; neither value is written to `EXPO_PUBLIC_*` or app storage.

## Run

Terminal 1:

```powershell
cd D:\Projekte\Lilith
npm run dev:api
```

Terminal 2:

```powershell
cd D:\Projekte\Lilith
npm run dev:mobile
```

Checks:

```powershell
cd D:\Projekte\Lilith
npm run typecheck
npm test
npm exec --workspace=@lilith/mobile -- expo install --check
```

## Android emulator (`Lilith_API_36`)

Default API URL is `http://10.0.2.2:3000` (Android emulator alias for this PC's loopback). Default API bind is `127.0.0.1:3000`.

```powershell
emulator -avd Lilith_API_36
cd D:\Projekte\Lilith
npm run dev:api
npm run dev:mobile
```

In the Expo terminal press `a`, or:

```powershell
cd D:\Projekte\Lilith\apps\mobile
npx expo start --android
```

In the app: paste `LOCAL_API_TOKEN`, tap **Connect**, then send a test message. Until gated Issue #8 is complete, the API streams an explicit “No model is connected yet” test reply. Chat history persists locally; the token does not. To exercise Stop without a provider, send exactly `Halte den Recherche-Unteragenten, bis ich stoppe oder fortsetze`. To exercise a question card, send exactly `Frage mich, ob du kurz oder ausführlich antworten sollst`.

## One-time approval test (Issue #13)

Send exactly `Simuliere eine externe Schreibaktion mit Einmalfreigabe`. The chat previews the mock origin, operation, data, file contents, SHA-256 digest, maximum USD cost and five-minute expiry. **Reject** makes no call; **Approve once** dispatches one mock call. Neither path sends data externally. Reconnect to reload the server state; after expiry, send the prompt again for a fresh preview and consent.

The authenticated `POST /tasks/:id/approve` accepts only `{ approval: <the displayed binding>, consent: true | false }`. The server compares it with its stored binding and actual tool arguments, checks ownership, task limits and expiry, and persists consumption before dispatch. Stop invalidates pending consent. Changed bindings, repeated submissions and consumed action IDs cannot dispatch. A crash or uncertain tool outcome leaves consent consumed, not retryable; the task reloads as failed and does not treat a late result as success. The action ID is passed as the downstream idempotency key.

This is a single-process mock gateway, not an activated provider or general network tool. Future external-write and data-disclosure tools must dispatch through this gate and enforce their own destination and actual-cost limits; multiple API writers require a transactional database claim instead of the current JSON task store.

## Physical iPhone (Expo Go)

Expo's tunnel does **not** carry this API. Phone and PC must share Wi-Fi, and the API must listen on the LAN.

1. Find the PC Wi-Fi IPv4:

```powershell
ipconfig
```

2. Set `HOST=0.0.0.0` in `services\api\.env`.
3. Set `EXPO_PUBLIC_API_URL=http://<PC-LAN-IPv4>:3000` in `apps\mobile\.env` (example: `http://192.168.1.20:3000`).
4. Allow inbound TCP 3000 in Windows Firewall.
5. Restart both `npm run dev:api` and `npm run dev:mobile` (`expo start --lan`).
6. Scan the QR code with Expo Go. Allow local-network access if iOS asks.

## Security limitation

- Development only. Do not expose this process to the public internet.
- Do not put real secrets or user data through this HTTP endpoint.
- Wrong or missing `LOCAL_API_TOKEN` or `ALPHA_OWNER_ID` must refuse to serve. Never commit `.env`.
- `ALPHA_OWNER_ID` is fixed server-side. This private Alpha does not claim multi-user isolation.
