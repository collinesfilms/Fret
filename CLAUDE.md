# Fret

Self-hosted WeTransfer replacement. Go backend with the React frontend
compiled into the binary; SQLite for bookkeeping; S3 for bytes. Built for
Collines Films, released as an open package.

`README.md` explains the product and how to deploy it. This file is for
working on it: the things that are not obvious from the code, and the ones
that already cost a session.

## The shape of it

```
cmd/fret            the server
cmd/fret-demo       local preview: in-process in-memory S3, seeded data, no auth
internal/api        handlers, routing, embedded frontend
internal/auth       OIDC + PKCE, sessions, argon2id
internal/storage    S3: presigning, multipart, orphan cleanup
internal/zipstream  the streaming zip writer
internal/sweeper    expiry and reclamation
internal/db         SQLite schema and queries
web/                React + TypeScript
```

## Invariants worth not breaking

**Bytes never pass through the server on upload or single-file download.**
The browser talks to S3 directly over presigned URLs. This is the whole
performance argument; anything that routes payload through Go is a
regression. The archive is the one deliberate exception.

**Presigned URLs may sign `host` and nothing else.** They are consumed by
browsers, which send ordinary browser headers and nothing more. The AWS SDK
will happily sign `x-amz-checksum-mode` into a presigned GET unless told not
to, and any S3 implementation that checks every signed header is present then
refuses the request — with an error that blames the request rather than the
URL. Both checksum settings are pinned to `WhenRequired` in
`storage.New`, and `TestPresignedUrlsSignOnlyHost` guards it. This class of
bug is invisible against a permissive backend and only appears on deploy.

**The slug is reserved before the first byte and inert until the last.**
`TransferBySlug` resolves only `status = 'live'`. That gap is why the copy key
is locked during upload: the link genuinely does not work yet.

**`shared_slug` is written once** — the first time a link is copied — and slug
uniqueness consults it, so a name that was handed out cannot be taken by
anyone else and restoring always succeeds. A rename still kills the old link,
deliberately: you rename because it went to the wrong person.

**Nothing is saved explicitly.** Discrete controls commit on change; text
fields on blur or Enter. Never per keystroke: each intermediate slug would be
a real reservation, and a half-typed password would really be the password
until you finished typing.

**Zip entries are stored, never deflated.** That is what makes the archive
size computable in advance, which is what makes `Content-Length` real, which
is what gives the recipient a true progress bar. Framing costs ~21 GB/s; the
only constraint is server bandwidth.

## Working on it

```sh
go run ./cmd/fret-demo          # terminal 1 — API + fake S3 + seeded data
cd web && npm run dev           # terminal 2 — frontend at :5173, proxied
```

**`cmd/fret-demo` serves the frontend that was compiled into it.** After a
frontend change it needs `npm run build` *and* a rebuild of the Go binary, or
you will debug a stale asset. This has already happened once. `npm run dev`
at :5173 does not have the problem.

```sh
go test ./...                   # includes an end-to-end suite on an in-process S3
cd web && npm run build && cd .. && go build ./cmd/fret
```

Screenshots in `docs/screenshots/` are captured from the running application
by `web/scripts/screenshots.mjs` — never mocked up. Re-run after any visual
change:

```sh
go run ./cmd/fret-demo                                   # terminal 1
cd web && FRET_CHROMIUM=/path/to/chromium npm run screenshots
```

Full-window captures, deliberately: the space around the device is part of the
design. An earlier pass cropped to the panel and it was wrong.

## Design

The original handoff described a physical device: warm off-white body, black
inset readout screen, perforated vent, a few raised keys. Depth is rationed to
the screen, the vent and primary keys — everything else is flat.

- **Type rule.** Machine-generated or countable → Martian Mono, small and
  tracked out. Human-written → Schibsted Grotesk. `lib/format.ts` produces
  every mono value.
- **Accent means one thing:** alert, uploading, unsaved, invalid. It is not a
  focus ring (focus is `--fg2`) and not the restore tag (that is kraft
  `--tag`, a material rather than a warning).
- **No image assets anywhere.** Every mark is divs, borders, radii, gradients
  or a typographic character. The kraft fibre is crosshatched gradients at odd
  angles so the weave never moirés against the pixel grid.
- The device's growth animates a **measured height**, not
  `grid-template-rows`. That interpolation cannot be feature-detected — the
  declaration parses everywhere and simply refuses to animate on older
  engines, so `@supports` reports it as available and the panel snaps open.

## Deployment gotchas

All three of these cost real time on the first deploy. None are Fret bugs;
two are worth remembering because the symptom points elsewhere.

1. **nginx `$host` strips the port.** A proxy in front of S3 that does
   `proxy_set_header Host $host` breaks SigV4 for any non-default port,
   because the signed host included the port and the forwarded one does not.
   Result: `SignatureDoesNotMatch`. Use `$http_host`, or better, point
   `FRET_S3_INTERNAL_ENDPOINT` straight at the backend — the server's own
   calls need no CORS and should not go through a CORS proxy at all.

2. **CORS rejection surfaces to JS as a plain network error.** The spec hides
   the detail, so a missing `Access-Control-Allow-Origin` reads as "network
   error while uploading a part". `ETag` must be in `Expose-Headers` or
   multipart cannot be assembled.

3. **`x-amz-checksum-mode`** — fixed in code, see the invariant above.

The Collines instance: MinIO on the NAS behind an nginx CORS proxy shared with
three other apps, Pocket ID for sign-in, Arcane managing the stack.
`FRET_S3_REGION` is cosmetic unless MinIO has a region configured.

## Repository

`main` is the default branch and CI publishes `ghcr.io/collinesfilms/fret` on
push to it (`latest`) and on `v*` tags (semver). Both build stages are pinned
to `$BUILDPLATFORM` and cross-compile, which took the multi-arch build from
~10 min to ~3. Work goes to `main` or a fresh branch off it.

No release has been tagged yet — only `:latest` exists.

## Open

- The edit modal still has an explicit *Save changes* / *No changes*, while
  the device autosaves. Defensible (a dialog with a destructive action beside
  it) but inconsistent. Raised, not decided.
- "network error while uploading a part" could name the storage origin and
  the CORS possibility. Offered twice, never taken up.
- Second short domain for slugs: deferred to v2. Host handling is not
  hardcoded, so it is configuration rather than a rewrite.
- `shared_slug` reserves a name for the transfer's lifetime, so a busy
  instance slowly accumulates unusable names. Accepted trade at this scale.
