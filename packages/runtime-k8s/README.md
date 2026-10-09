# @browserglass/runtime-k8s

Chrome on Kubernetes, one pod per browser. Roadmap tier, interface only:
this package ships a real `capabilities()` and a real `probe()`, and `launch`, `attach`,
`terminate`, `stats`, and `list` throw `NotImplementedError` (or, for
`launch`/`attach`, a `LaunchError`), with every method's real signature
preserved. This is deliberate. Specifying the interface now proves the
`BrowserRuntime` contract holds for a third implementation before anyone
builds one.

## What is real today

* `capabilities()` reports the shape a real implementation would:
  `survivesNodeRestart: true`, `supportsAttach: true`, per-container
  resource limits all enforceable (a Pod's container resource
  requests/limits, the same mechanism docker's container-per-browser
  decision uses), and `fileBridge: {download: false, upload: false}`
  pending the PersistentVolumeClaim design (open design area 2, below).
* `probe()` issues a real check against the in-cluster Kubernetes API
  server's `/version` endpoint, using the pod's own service account
  credentials (`KUBERNETES_SERVICE_HOST`/`_PORT` env vars plus the token
  and CA cert Kubernetes injects at
  `/var/run/secrets/kubernetes.io/serviceaccount/`). It does **not**
  attempt to parse an out-of-cluster `kubeconfig`
  (`~/.kube/config`/`$KUBECONFIG`): that needs a YAML parser (a new
  dependency) and multi-context/auth-plugin resolution disproportionate to
  a stub whose whole point is the interface, not a working cluster
  client. Outside a cluster, `probe()` returns `status: 'unavailable'`
  with an honest detail string rather than a fragile guess.

## Inherited from `runtime-docker`

Same container image, same container agent
(`ghcr.io/browserglass/chrome:<chromeMajor>-<imageRev>`), and the same
container-per-browser, no-published-host-port, unix-socket-transport
decisions `@browserglass/runtime-docker`'s own `README.md` documents. A
real `K8sRuntime` becomes a controller that creates a `Pod` with an owner
reference to a `BrowserInstance` custom resource (deleting the instance
garbage collects the pod without the controller needing to be alive), not
a fresh design of the container's contents.

## Open design areas (do not attempt a real implementation of these yet)

Left as explicit TODOs:

1. **CDP reachability.** No Unix socket crosses a pod boundary. Plan: CDP
   over the pod network with mutual TLS terminated by the container agent
   (the agent needs a TLS listener plus a per-pod certificate issued by
   the node). Rejected/deferred alternative: the node as a sidecar per
   pod, which changes the whole node process model.
2. **Profiles.** A `PersistentVolumeClaim` per persistent profile,
   `ReadWriteOnce`, creates TWO mutual exclusion mechanisms (the lease
   fence and volume attachment state) that can disagree. Must reconcile
   the lease fence against volume attachment state; design for the "pod
   stuck Terminating with volume still attached" failure mode first.
3. **Scheduling.** The router's placement and the Kubernetes scheduler are
   two different schedulers. The router should express intent (resource
   requests, node selectors, topology spread constraints) rather than
   making per-node decisions when the k8s runtime is active.
4. **Startup latency.** Cold start is 2 to 15 seconds (pod scheduling plus
   image pull plus container start). Warm pools become mandatory,
   implemented as a `Deployment` of idle pods the controller claims.

## Not built yet

The pod controller, the `BrowserInstance` custom resource, the mTLS
container agent listener, the PVC reconciliation logic, and the router's
intent-expressing placement mode. `launch()` and `attach()` throw
`LaunchError` coded `E_DOCKER_UNAVAILABLE` (the closest existing
`LaunchErrorCode`; `protocol`'s catalogue has no k8s-specific code yet);
`terminate()`, `stats()`, and
`list()` throw `NotImplementedError` with the same code.
