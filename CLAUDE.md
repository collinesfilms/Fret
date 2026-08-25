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

The two exceptions earned it by being places something moves: the drawer's
finger slot, and the expiry track. A pull that is not recessed is not a pull,
and a handle that slides needs a groove to slide in — a channel drawn without
any depth is just a rectangle. Both are kept well under the screen and the
keys: one soft inset pass and a hairline of light along the lower lip.

- **Type rule.** Machine-generated or countable → Martian Mono, small and
  tracked out. Human-written → Schibsted Grotesk. `lib/format.ts` produces
  every mono value.
- **Accent means one thing:** alert, uploading, unsaved, invalid. It is not a
  focus ring — focus is `--fg2`. The palette carries exactly two semantic
  colours and no third.
- **No image assets anywhere.** Every mark is divs, borders, radii, gradients
  or a typographic character. Texture is crosshatched gradients at deliberately
  odd angles — the drawer's brushed grain is at 94° and 86° — so the lines
  never come into register with the pixel grid and moiré.
- **Motion is a vocabulary, not a per-component decision.** Four easings and
  five durations in `tokens.css`; nothing hardcodes a curve. `--easeTray`
  overshoots (weight arriving), `--easeExit` never does (a thing leaving
  should not bounce).
- The device's growth animates a **measured height**, not
  `grid-template-rows`. That interpolation cannot be feature-detected — the
  declaration parses everywhere and simply refuses to animate on older
  engines, so `@supports` reports it as available and the panel snaps open.
- **The options drawer is a sibling of the panel, never a child.** A negative
  `z-index` child paints *above* its own parent's background, so a drawer that
  tucks under the device is not expressible as nesting. It is also positioned
  out of flow, so `.fret-deck` reserves its height as a bottom margin — which
  is what keeps the object centred as it opens, since the stage centres the
  deck and reserving space below is the same act as lifting the panel by half
  of it.

The kraft restore tag is gone: it was a physical object built to carry one
sentence, and `--tag` went with it. What it said now appears in the edit modal,
where it is actually true. The upload device only ever holds a transfer that is
still arriving, so its name has never been anywhere and a rename there costs
nothing — that asymmetry is the reason the warning lives in one place and not
the other.

## An effect that cancels its own timer

This one has now cost three separate bugs, in the transfers list, the morphing
key label and the drawer. It looks like ordinary React:

```tsx
useEffect(() => {
  if (children === current) return
  setLeaving(current)
  setCurrent(children)                                  // ← re-render, deps change
  const timer = setTimeout(() => setLeaving(null), 320)
  return () => clearTimeout(timer)                      // ← cancels the timer above
}, [children, current])
```

The state change the effect makes puts it back in its own dependency list, so
the cleanup runs and kills the timeout before it can fire. Nothing throws and
nothing looks wrong on screen: the leaving element is at zero opacity by then.
It simply never leaves the DOM.

Anything that schedules a **removal** belongs in its own effect keyed on the
thing being removed, or on a ref cleared only on unmount. The rule of thumb:
if an effect both changes state and sets a timer, the timer is probably about
to be cancelled by the change.

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
