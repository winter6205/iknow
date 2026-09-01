# iknow web UI

Vite + React console for the Session API.

## Development

1. Start the backend (Session API, default port **8787**):

   ```bash
   npm run serve
   # or: npx tsx src/cli.ts serve --port 8787
   ```

2. Start the Vite dev server (proxies `/api` to the backend when configured):

   ```bash
   npm run web:dev
   # or from this directory: npm run dev
   ```

Open the URL Vite prints (usually `http://127.0.0.1:5173`).

## Production

1. Build static assets into `web/dist`:

   ```bash
   npm run web:build
   ```

2. Serve API + SPA from one process (backend prefers `web/dist` when present):

   ```bash
   npm run serve
   # open http://127.0.0.1:8787/
   ```

## Scripts (repo root)

| Script                  | Action                                 |
| ----------------------- | -------------------------------------- |
| `npm run web:dev`       | Vite HMR dev server                    |
| `npm run web:build`     | Typecheck + production build → `dist/` |
| `npm run web:typecheck` | `tsc --noEmit` only                    |
