---
name: kubernetes-deployment-hardening
description: Write or review a Kubernetes Deployment, Service, or Helm chart. Use when a workload has no resource limits, no probes, or runs privileged.
---

# Kubernetes Deployment Hardening

## Invariants

1. Every container declares `resources.requests` and `resources.limits`. Without requests the scheduler cannot place the pod sensibly; without limits one pod can starve a node.
2. Every container declares a readiness probe. Without one, traffic reaches a pod that is still starting.
3. `securityContext` runs non-root with a read-only root filesystem unless the workload provably needs otherwise.

## Workflow

1. Read the current manifest and name what is missing.
   - Check for: requests, limits, readiness, liveness, securityContext, and an explicit image tag (never `latest`).
   - **Done when:** you have a written list of the missing fields.

2. Set resources from measurement, not from a guess.
   - If no measurement exists, say so and set a conservative starting point, then note that it must be revisited against real usage.
   - **Done when:** requests and limits are present and the basis for the numbers is stated.

3. Separate the two probes.
   - Readiness gates traffic. Liveness restarts. Pointing both at the same endpoint means a slow dependency triggers a restart loop.
   - **Done when:** readiness and liveness use different endpoints or different thresholds.

4. Constrain the security context.
   - `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and drop all capabilities.
   - **Done when:** the pod starts with those settings, or you have named the exact capability it needs and why.

## Template

```yaml
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: app
          image: registry/app:1.4.2
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          readinessProbe:
            httpGet: { path: /readyz, port: 8080 }
            initialDelaySeconds: 3
          livenessProbe:
            httpGet: { path: /livez, port: 8080 }
            periodSeconds: 20
            failureThreshold: 3
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
```

## Verification

- `kubectl apply --dry-run=server -f manifest.yaml` accepts it.
- `kubectl rollout status deploy/app` completes.
- Killing the readiness endpoint removes the pod from the Service endpoints without restarting it.
