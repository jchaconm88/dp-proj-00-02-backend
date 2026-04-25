# dp-proj-00-02-backend

Backend (Cloud Run) basado en Express.

## Local

```bash
npm install
npm run dev
```

Healthcheck: `GET /healthz`

## Docker (Cloud Run)

Build:

```bash
docker build -t dp-proj-00-02-backend .
```

Run:

```bash
docker run -p 8080:8080 -e PORT=8080 dp-proj-00-02-backend
```

