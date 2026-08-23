# Paseo Docker Setup

This document explains how to run Paseo daemon in Docker while using the Electron desktop app locally.

## Architecture

```
┌─────────────────────────────┐
│   Electron Desktop App      │  (localhost)
│   (macOS/Linux/Windows)     │
└──────────────┬──────────────┘
               │
      WebSocket (ws://)
               │
     ┌─────────▼─────────┐
     │   Docker Network  │
     │   (paseo-network) │
     └─────────┬─────────┘
               │
    ┌──────────▼──────────┐
    │   Paseo Daemon      │  (localhost:6767)
    │   (Node.js)         │
    └──────────┬──────────┘
               │
    ┌──────────▼──────────┐
    │   FeltDB Storage    │  (/data/feltdb)
    │   Agent Data        │  (/data/paseo)
    └─────────────────────┘
```

## Quick Start

### 1. Prerequisites

- Docker and Docker Compose installed
- Node.js 20+ for building the desktop app

### 2. Build and Start the Daemon

```bash
# Build the Docker image
npm run docker:build

# Start the daemon in the background
npm run docker:up

# View logs
npm run docker:logs

# Check daemon health
curl http://localhost:6767/health
```

### 3. Connect Desktop App

1. Open Paseo desktop app (or build it):
   ```bash
   npm run dev --workspace=@getpaseo/desktop
   ```

2. Go to **Settings** → **Add Server**

3. Enter:
   - **Host**: `localhost`
   - **Port**: `6767`
   - **Name**: "Docker Daemon" (or custom)

4. Click **Connect**

## Available Commands

Add these to `package.json` in the root workspace:

```json
{
  "scripts": {
    "docker:build": "docker-compose build --no-cache",
    "docker:up": "docker-compose up -d",
    "docker:down": "docker-compose down",
    "docker:logs": "docker-compose logs -f paseo-daemon",
    "docker:status": "docker-compose ps",
    "docker:clean": "docker-compose down -v",
    "docker:setup": "bash scripts/docker-setup.sh"
  }
}
```

## Environment Variables

The daemon container uses these environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PASEO_HOME` | `/data/paseo` | Daemon state, agent data, logs |
| `FELTDB_PATH` | `/data/feltdb` | FeltDB database storage |
| `NODE_ENV` | `production` | Node environment |

To override, edit `docker-compose.yml`:

```yaml
environment:
  PASEO_HOME: /custom/path/paseo
  FELTDB_PATH: /custom/path/feltdb
```

## Persistence

The daemon uses two Docker volumes:

- **`paseo-home`**: Contains agent state, configuration, and daemon logs
- **`feltdb-data`**: Contains FeltDB database files

These volumes persist across container restarts. To clean everything:

```bash
npm run docker:clean  # Removes containers AND volumes
```

## Debugging

### View daemon logs
```bash
npm run docker:logs
```

### Check container status
```bash
npm run docker:status
```

### Access the container
```bash
docker-compose exec paseo-daemon sh
```

### View FeltDB files
```bash
docker-compose exec paseo-daemon ls -la /data/feltdb/
```

### View agent state
```bash
docker-compose exec paseo-daemon ls -la /data/paseo/agents/
```

## Troubleshooting

### "Cannot connect to daemon"

1. Check if container is running:
   ```bash
   npm run docker:status
   ```

2. Check logs for errors:
   ```bash
   npm run docker:logs
   ```

3. Verify the port is accessible:
   ```bash
   curl http://localhost:6767/health
   ```

### "Port 6767 already in use"

If port 6767 is already in use, change it in `docker-compose.yml`:

```yaml
ports:
  - "7777:6767"  # Access daemon at localhost:7777
```

Then connect the desktop app to `localhost:7777`.

### "FeltDB data not persisting"

Ensure the volume is mounted:

```bash
docker volume ls | grep feltdb-data
docker volume inspect paseo_feltdb-data
```

If the volume doesn't exist, recreate it:

```bash
npm run docker:clean
npm run docker:up
```

### "Build fails with dependency errors"

Clear the build cache and rebuild:

```bash
docker-compose down
docker system prune -f
npm run docker:build
```

## Production Deployment

For production, consider:

1. **Private Registry**: Push image to your registry
   ```bash
   docker tag paseo-daemon:latest your-registry/paseo-daemon:latest
   docker push your-registry/paseo-daemon:latest
   ```

2. **Kubernetes**: Use the provided Docker image with Helm charts or manual deployment

3. **Environment Secrets**: Use `.env` file for secrets (never commit)
   ```bash
   # .env
   FELTDB_PATH=/mnt/secure/feltdb
   PASEO_HOME=/mnt/secure/paseo
   ```

4. **Backup Strategy**: Regularly backup the `feltdb-data` and `paseo-home` volumes

## Network Configuration

### Connect from remote machine

To access the daemon from a different machine:

1. Expose the daemon on all interfaces in `docker-compose.yml`:
   ```yaml
   ports:
     - "0.0.0.0:6767:6767"  # WARNING: Exposes to all interfaces
   ```

2. Connect desktop app to `<machine-ip>:6767`

⚠️ **Security Warning**: Only expose on trusted networks. Use Paseo's relay for secure remote access.

See [SECURITY.md](SECURITY.md) for the relay threat model.

## Related Documentation

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Development workflow
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — System architecture
- [packages/desktop/README.md](packages/desktop/README.md) — Desktop app info
- [SECURITY.md](SECURITY.md) — Security and relay setup
