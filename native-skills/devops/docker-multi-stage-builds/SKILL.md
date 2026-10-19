---
name: docker-multi-stage-builds
description: Build a Dockerfile for a compiled or bundled project. Use when adding containerisation, when an image exceeds a few hundred megabytes, or when a build copies source into the runtime layer.
---

# Docker Multi-Stage Builds

## Invariants

1. Compiled and bundled languages get a build stage and a runtime stage. Never one stage.
2. The final image never runs as `root`.
3. Secrets never enter a layer. `COPY .env` is a leak even if a later stage deletes it — layers are additive and readable with `docker history`.

## Workflow

1. Read the existing build.
   - Identify the build command, the artefact directory, and the runtime entrypoint.
   - **Done when:** you can name the exact directory the runtime needs and nothing else.

2. Split the stages.
   - Stage one installs every dependency and builds. Stage two starts from a clean base and copies only the artefact plus production dependencies.
   - Order layers by change frequency: manifest first, `install` second, source last. A source edit must not invalidate the dependency layer.
   - **Done when:** editing one source file rebuilds only the final layers.

3. Drop privileges.
   - Create a user in the runtime stage and switch to it before `CMD`.
   - **Done when:** `docker run --rm IMAGE id -u` prints a non-zero uid.

4. Add a `.dockerignore`.
   - At minimum `node_modules`, `.git`, `.env*`, build output, and test fixtures. Without it the whole working tree enters the build context and slows every build.
   - **Done when:** `docker build` reports a context under a few megabytes for a typical app.

## Node template

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Verification

- `docker build -t app .` succeeds.
- `docker image ls app` shows a size in line with the base image plus the artefact.
- `docker history app` shows no layer containing a secret file.
- The container starts and answers a request.
