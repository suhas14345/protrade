# ProTrade Alpha — Dashboard

React + Vite single-page monitoring UI for the ProTrade Alpha system. It reads Firestore and
calls the gateway to display run status, positions, history, logs, and Kite settings.

- **Live:** [suhas-ag.web.app](https://suhas-ag.web.app)
- **Backend:** the `gateway` Cloud Function (`{ "action": "..." }` POST). See the root
  [README.md](../README.md) and [CONTEXT.md](../CONTEXT.md).

## Develop

```bash
npm install
npm run dev        # local dev server (HMR)
npm run build      # production build → dist/
```

## Deploy

```bash
npm run build && cd .. && firebase deploy --only hosting --project suhas-ag
```

If the UI looks stale after deploy, you shipped an old `dist/` — rebuild first.

## Structure

- `src/App.tsx` — main app; tabs for Dashboard, History, Logs, Settings.
- Talks to the gateway at `https://us-central1-suhas-ag.cloudfunctions.net/gateway`.
