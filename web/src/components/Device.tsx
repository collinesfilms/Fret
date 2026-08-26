/**
 * The device primitives: panel, screen, vent, key, lamp, caret.
 *
 * These are the entire visual vocabulary of the interface. The screen and the
 * keys are the only elements permitted real depth.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'

import { formatBytes } from '../lib/format'
import type { Locale } from '../lib/i18n'

export function Panel({
  children,
  recipient,
  settled,
  ...rest
}: {
  children: ReactNode
  recipient?: boolean
  /** Plays the completion settle once. */
  settled?: boolean
} & React.HTMLAttributes<HTMLDivElement>) {
  const classes = [
    'fret-panel',
    recipient && 'fret-panel--recipient',
    settled && 'fret-panel--settled',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}

export function Vent() {
  // Decorative: it stands in for a speaker grille and carries no information.
  return <div className="fret-vent" aria-hidden="true" />
}

export function Lamp({
  color,
  size = 7,
  pulse,
  breathe,
  bloom,
}: {
  color: string
  size?: number
  pulse?: boolean
  breathe?: boolean
  /** Blooms once, for a lamp that has just come good. */
  bloom?: boolean
}) {
  const className = [
    'fret-lamp',
    pulse && 'fret-lamp--pulse',
    breathe && 'fret-lamp--breathe',
    bloom && 'fret-lamp--bloom',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: `0 0 6px ${color}, inset 0 1px 1px rgba(255,255,255,.5)`,
      }}
    />
  )
}

/**
 * The blinking block cursor that follows a line of type.
 *
 * Sized in em, so it is measured against the type it actually sits beside
 * rather than a number passed in beside it. That distinction is the whole
 * fix: the recipient title is clamp(21px, 3.2vw, 27px), so a caret told it
 * was 20px was drawn a third too small at most window widths, and no amount
 * of tuning the number would have held across the clamp.
 *
 * It sits on the baseline rather than centred in the line box. Centring is
 * what made it look high: a line box carries descender space the letters do
 * not use, so its middle sits below the middle of the visible text. An empty
 * inline-block aligns its bottom edge to the baseline, which is exactly where
 * a block cursor belongs.
 */
export function Caret({ solid }: { solid?: boolean } = {}) {
  return <span className={`fret-caret${solid ? ' fret-caret--solid' : ''}`} aria-hidden="true" />
}

/**
 * Whether this reader has asked for a still interface.
 *
 * The stylesheet answers that on its own for animations, but typing is a
 * timer rather than a keyframe, so it has to ask. Read at the moment it is
 * needed rather than cached: the setting can change under a running tab.
 */
function prefersStillness() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * A line the device types out, with the caret advancing ahead of it.
 *
 * The caret is already on the screen doing nothing; letting it write the line
 * is what makes it a readout rather than a decoration. It holds solid while
 * the characters arrive and only starts blinking once the line is finished,
 * which is what a terminal does — a caret that blinks mid-output reads as a
 * stall.
 *
 * The typed copy is hidden from assistive technology and the whole line is
 * exposed beside it, so a screen reader is given a sentence rather than a
 * sentence being spelled at it one character per re-render.
 */
export function Typed({ children, speed = 24 }: { children: string; speed?: number }) {
  // Starts empty rather than full: initialising to the whole line would paint
  // it once before the effect could clear it, and the line would flash into
  // existence a frame before it started being written.
  const [count, setCount] = useState(() => (prefersStillness() ? children.length : 0))

  useEffect(() => {
    if (prefersStillness()) {
      setCount(children.length)
      return
    }
    setCount(0)
    let shown = 0
    const timer = window.setInterval(() => {
      shown += 1
      setCount(shown)
      if (shown >= children.length) window.clearInterval(timer)
    }, speed)
    return () => window.clearInterval(timer)
  }, [children, speed])

  return (
    <span className="fret-typed">
      <span aria-hidden="true">{children.slice(0, count)}</span>
      <span className="fret-sr">{children}</span>
      <Caret solid={count < children.length} />
    </span>
  )
}

export function Screen({
  children,
  dragging,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  fill,
  draining,
  sheen,
  style,
  label,
}: {
  children: ReactNode
  dragging?: boolean
  onClick?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  /** Height of the rising material, 0-100. */
  fill?: number
  draining?: boolean
  sheen?: boolean
  style?: CSSProperties
  label?: string
}) {
  const droppable = Boolean(onDrop)
  const className = [
    'fret-screen',
    droppable && 'fret-screen--drop',
    dragging && 'fret-screen--dragging',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      style={style}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      onKeyDown={
        droppable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      role={droppable ? 'button' : undefined}
      tabIndex={droppable ? 0 : undefined}
      aria-label={label}
    >
      {fill !== undefined && fill > 0 && (
        <div
          className={`fret-fill${draining ? ' fret-fill--draining' : ''}`}
          style={{ height: `${fill}%`, opacity: draining ? 0 : 1 }}
        />
      )}
      {sheen && <div className="fret-sheen" aria-hidden="true" />}
      <div className="fret-screen__inner">{children}</div>
    </div>
  )
}

/** The status strip along the top of the screen: lamp, label, right-hand note. */
export function Strip({
  color,
  label,
  right,
  pulse,
}: {
  color: string
  label: string
  right?: ReactNode
  pulse?: boolean
}) {
  return (
    <div className="fret-screen__strip">
      <Lamp color={color} size={6} pulse={pulse} />
      <span className="fret-screen__stripLabel">{label}</span>
      {right && <span className="fret-screen__stripRight">{right}</span>}
    </div>
  )
}

/**
 * The list of what is in a transfer.
 *
 * The same list in three places — the device while a transfer is arriving, the
 * recipient page, and a row of the transfers list — because it is the same
 * question in all three: what is actually in this. It sits on the black
 * readout in the first two and on the body material in the third, which is
 * the only thing `plain` changes.
 *
 * Capped and scrolling, because a transfer can be a hundred stills and a list
 * that long would push everything else off the screen. The cap is the point:
 * it is a readout of a transfer, not a file browser.
 */
export function FileList({
  files,
  locale,
  plain,
  cap,
  children,
}: {
  files: { id: string; name: string; size: number }[]
  /** Sizes are machine values, and a machine value still has a language. */
  locale: Locale
  /** On the body material rather than the readout screen. */
  plain?: boolean
  /** Overrides the height it stops growing at. */
  cap?: number
  /** Rendered at the end of each row, e.g. a per-file download. */
  children?: (file: { id: string; name: string; size: number }) => ReactNode
}) {
  return (
    <Scroller
      className={`fret-filelist${plain ? ' fret-filelist--plain' : ''}`}
      style={cap === undefined ? undefined : { maxHeight: cap }}
    >
      {files.map((file) => (
        <div className="fret-filelist__row" key={file.id}>
          <span className="fret-filelist__name">{file.name}</span>
          <span className="fret-filelist__size">{formatBytes(locale, file.size)}</span>
          {children?.(file)}
        </div>
      ))}
    </Scroller>
  )
}

/**
 * A scrolling box that fades only at the edges it is actually hiding content
 * behind.
 *
 * A static gradient at both ends is the usual way to do this and it lies: it
 * dims the first row of a list that is already fully visible, and it keeps
 * dimming the last row after you have scrolled to it, so the one moment you
 * need to read the bottom line is the moment it is faded out. Tracking the
 * scroll position costs one listener and makes the fade mean something —
 * where it appears, there is more.
 */
export function Scroller({
  className = '',
  style,
  children,
}: {
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<'none' | 'top' | 'bottom' | 'both'>('none')

  useLayoutEffect(() => {
    const element = box.current
    if (!element) return

    const measure = () => {
      // A pixel of slack: fractional scroll offsets and zoom leave
      // scrollTop a hair short of the end, which would strand the bottom
      // fade permanently on.
      const above = element.scrollTop > 1
      const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1
      setEdges(above && below ? 'both' : above ? 'top' : below ? 'bottom' : 'none')
    }

    measure()
    element.addEventListener('scroll', measure, { passive: true })
    // The box changes height when the panel grows, and the content changes
    // height when files arrive; both change whether there is anything to fade.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      element.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [children])

  return (
    <div className={`fret-scroll ${className}`.trim()} data-fade={edges} style={style} ref={box}>
      <div className="fret-scroll__inner">{children}</div>
    </div>
  )
}

/**
 * How long an exchange is held open: both lines split into characters, the
 * mode on the box, and the outgoing line still in the DOM.
 *
 * It has to outlast the last thing that moves. A grow lets the lamp set off
 * half a settle ahead and then runs the exchange over the top of it; a shrink
 * runs the exchange and closes the box up inside it, finishing sooner. So the
 * long case is the grow, and only when there is a lamp to lead with.
 *
 * Timing this to the outgoing line alone was wrong, and wrong in a way that
 * looked like a rendering bug rather than a duration: the split is what
 * carries the incoming cascade too, so dropping it the moment the old line
 * had gone put the rest of the new one on screen in a single frame. The word
 * wrote three letters and then simply appeared.
 *
 * The numbers are the durations in tokens.css — --durCascade twice,
 * --durPress, --durFast, and half a --durSettle for the lead — plus a frame
 * or two so the last character is never cut off by a re-render landing as it
 * finishes.
 */
const EXCHANGE_MS = 90 + 120 + 90 + 180
const LEAD_MS = 80

function morphMs(mode: Exchange, lamp: boolean | undefined): number {
  return (lamp && mode === 'grow' ? LEAD_MS : 0) + EXCHANGE_MS + 60
}

/**
 * Splits a line into the characters that will fade one after another.
 *
 * Array.from rather than split(''), so an emoji or an accented character that
 * arrived as a surrogate pair stays one character instead of being torn into
 * two halves that then fade at different times.
 */
function characters(line: string): string[] {
  return Array.from(line)
}

/**
 * A line of text that changes by being replaced rather than rewritten.
 *
 * "Copy link" becoming "Copied to clipboard" is a different sentence, not the
 * same sentence edited, and swapping the characters in place says the wrong
 * thing about it: for one frame the key reads as neither.
 *
 * It used to say so by sliding: the old line up, the new one in from below,
 * like a split-flap. At label size that read as a glitch — the travel is
 * about a third of an em, which is too small to look like a mechanism and too
 * large to go unnoticed, and it is the only type in the interface that moves.
 * So the letters hold still now and fade instead, one after another from left
 * to right, the old line clearing before the new one starts writing.
 *
 * The clearing is not politeness, it is the whole reason this works. The two
 * lines are centred on the same point but are different lengths, so nothing
 * lines up between them — crossfade "Copy link" into "Copied to clipboard"
 * and the key spends a tenth of a second reading "CopieCbpy link". The seam
 * between the two cascades is computed in device.css from the durations
 * either side of it rather than guessed at.
 *
 * The stagger is one number per character — where it sits in the word, 0 at
 * the first and 1 at the last — handed to CSS as --fret-morph-at. How far
 * that spreads is a duration in tokens.css, and it is fixed, so every label
 * takes the same time to change: a three-letter word ripples, a long one
 * wipes.
 *
 * Both lines are laid out in the same cell, so nothing around it moves while
 * they trade places. The split text is hidden from assistive technology and
 * the whole line given once instead — a screen reader handed a span per
 * character reads it out letter by letter.
 */
export function Morph({
  children,
  lamp,
}: {
  children: string
  /**
   * There is a lamp beside this label, so the box's width has to change on a
   * schedule rather than whenever it likes — see device.css. Without one the
   * label is centred on a centre that never moves, and the sequencing would
   * only add a wait to a confirmation somebody is looking at.
   */
  lamp?: boolean
}) {
  const [pair, setPair] = useState<{ current: string; leaving: string | null }>({
    current: children,
    leaving: null,
  })
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    setPair((previous) =>
      previous.current === children ? previous : { current: children, leaving: previous.current },
    )
  }, [children])

  /*
   * Retiring the outgoing line is its own effect, keyed on the line itself.
   *
   * Scheduling it beside the swap above does not work, and fails quietly: the
   * swap changes state, the re-render it causes re-runs the effect, the
   * effect's cleanup cancels the timeout it just set, and the outgoing line
   * stays in the DOM for the life of the page. It is invisible — the
   * animation ends at zero opacity — so the only symptom is one more hidden
   * copy of every label the key has ever shown.
   */
  const arriving = pair.leaving !== null
  const sizer = useRef<HTMLSpanElement>(null)
  const box = useLabelBox(pair.current, sizer)

  useEffect(() => {
    if (pair.leaving === null) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(
      () => setPair((previous) => ({ ...previous, leaving: null })),
      morphMs(box.mode, lamp),
    )
    // Keyed on the mode as well as the line. The mode is settled by a layout
    // effect one level down, so on the render that starts an exchange it can
    // still be the previous one's — and a grow read as a level would take the
    // outgoing line out of the DOM a --durSettle before it has finished
    // leaving. Re-arming when it lands costs a frame and nothing else.
  }, [pair.leaving, box.mode, lamp])

  const classes = [
    'fret-morph',
    lamp && 'fret-morph--lamp',
    arriving && 'fret-morph--exchanging',
    arriving && box.mode !== 'level' && `fret-morph--${box.mode}`,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes} style={box.width ? { width: box.width } : undefined}>
      {/* Not the label, just its width. Hidden from paint and from the
          accessibility tree, but laid out, which is the whole point. */}
      <span className="fret-morph__sizer" aria-hidden="true" ref={sizer}>
        {pair.current}
      </span>
      {pair.leaving !== null && (
        <Cascade className="fret-morph__out" key={pair.leaving} line={pair.leaving} />
      )}
      <span
        className={`fret-morph__in${arriving ? ' fret-morph__in--arriving' : ''}`}
        aria-hidden="true"
      >
        {/* Only split while something is actually animating. The rest of the
            time the label is one text node, which is what it should be. */}
        {/* Keyed on the line: without it React keeps the character spans and
            only swaps their text, so a second change arriving before the
            first has finished inherits the old animation's progress — the new
            word turns up already written, over a line still fading out. */}
        {arriving ? <Characters key={pair.current} line={pair.current} /> : pair.current}
      </span>
      <span className="fret-sr">{pair.current}</span>
    </span>
  )
}

/**
 * Which way the label box is about to move, which decides when it moves.
 *
 * The lamp beside the label is carried by this box's width and by nothing
 * else, so a label that changes length is a lamp that has to travel — and it
 * must not travel across text that is still on screen. Growing, the space it
 * wants is empty, so it goes first and the exchange follows it. Shrinking,
 * the space it wants is where the outgoing line is still standing, so the
 * exchange goes first and the lamp closes up behind it. device.css turns
 * these three words into the two delays that arrange it.
 */
type Exchange = 'level' | 'grow' | 'shrink'

/**
 * The width of the line the key is showing, and which way it just went.
 *
 * The box needs a real number rather than `auto` for two reasons: `auto` is
 * not interpolable, so the lamp would teleport rather than travel, and the
 * leaving line is laid out inside this box — sized by content, a long label
 * reverting to a short one squeezed "Copied to clipboard" into 61px and
 * clipped it while it was still fading.
 *
 * Measuring happens on a hidden twin rather than on the box, since a box
 * carrying an explicit width can no longer report what its content would like
 * to be. `max-width: 100%` still caps the result, so a label too long for its
 * key truncates the way it always did.
 */
function useLabelBox(line: string, sizer: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState<{ width: number; mode: Exchange }>({ width: 0, mode: 'level' })

  const measure = useCallback(() => {
    /*
     * offsetWidth, and one pixel over it.
     *
     * A rect would be the obvious thing to measure and it is the wrong one:
     * it reports the painted box, so an ancestor mid-animation is folded into
     * the answer. Every modal in the app arrives at scale(0.96), which had a
     * key inside one measuring four percent narrow and keeping it — "No
     * changes" locked into a box built for "No chan…". offsetWidth is layout
     * and has no opinion about transforms.
     *
     * The pixel is for its rounding. offsetWidth is an integer, so a line
     * that wants 129.4px reports 129, and text-overflow does not care that it
     * is four tenths short: the key draws an ellipsis beside a label that
     * fits. One over is always enough and never enough to see.
     */
    const node = sizer.current
    const width = node ? node.offsetWidth + 1 : 0
    if (width <= 1) return
    setBox((previous) => {
      const mode: Exchange =
        previous.width === 0 || previous.width === width
          ? 'level'
          : width > previous.width
            ? 'grow'
            : 'shrink'
      if (previous.width === width && previous.mode === mode) return previous
      return { width, mode }
    })
  }, [sizer])

  // Only ever on a change of line, so the mode stays put for the length of the
  // exchange it describes. Re-running it while the cascade is in flight would
  // rewrite animation-delay underneath running animations, and they would
  // jump to wherever the new delay says they should be by now.
  useLayoutEffect(measure, [line, measure])

  // A line measured before its face has loaded is measured in the fallback,
  // and every label on the page is then a few pixels out.
  useEffect(() => {
    let live = true
    void document.fonts?.ready.then(() => live && measure())
    return () => {
      live = false
    }
  }, [measure])

  return box
}

function Cascade({ className, line }: { className: string; line: string }) {
  return (
    <span className={className} aria-hidden="true">
      <Characters line={line} />
    </span>
  )
}

function Characters({ line }: { line: string }) {
  const glyphs = characters(line)
  /* A one-character label has no spread to divide, and dividing by zero would
     hand CSS a NaN it silently ignores — leaving that character with no
     animation at all. It sits at the start of the cascade instead. */
  const last = Math.max(glyphs.length - 1, 1)

  return (
    <>
      {glyphs.map((glyph, index) => (
        <span
          key={index}
          className="fret-morph__ch"
          style={{ '--fret-morph-at': index / last } as CSSProperties}
        >
          {glyph}
        </span>
      ))}
    </>
  )
}

export function Key({
  children,
  variant = 'primary',
  inert,
  pressed,
  lamp,
  className = '',
  ...rest
}: {
  children: ReactNode
  variant?: 'primary' | 'alt'
  inert?: boolean
  /** Held down for as long as whatever it opened stays open. */
  pressed?: boolean
  /** Colour of the state lamp carried on the key itself, if any. */
  lamp?: { color: string; pulse?: boolean; bloom?: boolean }
  className?: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    'fret-key',
    variant === 'alt' && 'fret-key--alt',
    inert && 'fret-key--inert',
    pressed && 'fret-key--pressed',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type="button" className={classes} disabled={inert || rest.disabled} {...rest}>
      {lamp && <Lamp color={lamp.color} size={7} pulse={lamp.pulse} bloom={lamp.bloom} />}
      <span className="fret-key__label">{children}</span>
    </button>
  )
}

/**
 * The link a transfer will be reachable at, shown on the status strip.
 *
 * The host is there from the moment the screen is, so nothing appears out of
 * nowhere: when an upload starts, only the slug is typed onto the end of an
 * address that was already sitting there. A later rename flashes rather than
 * retyping — retyping would read as a second link being minted, when what
 * happened is that one link changed its name.
 */
export function LinkReadout({
  host,
  slug,
  onOpen,
}: {
  host: string
  slug: string
  /** Makes the readout the way to preview, once there is something to open. */
  onOpen?: () => void
}) {
  const [typed, setTyped] = useState(slug)
  const [flash, setFlash] = useState(false)
  const previous = useRef(slug)

  useEffect(() => {
    const before = previous.current
    previous.current = slug
    if (slug === before) return

    if (slug === '') {
      setTyped('')
      return
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Only the first appearance is typed; a rename is a change of name, not
    // an arrival.
    if (before !== '' || reduced) {
      setTyped(slug)
      setFlash(true)
      const done = window.setTimeout(() => setFlash(false), 620)
      return () => window.clearTimeout(done)
    }

    let shown = 0
    setTyped('')
    const tick = window.setInterval(() => {
      shown += 1
      setTyped(slug.slice(0, shown))
      if (shown >= slug.length) window.clearInterval(tick)
    }, 26)
    return () => window.clearInterval(tick)
  }, [slug])

  const body = (
    <>
      <span className="fret-link__host">{host}</span>
      {typed !== '' && (
        <span className={`fret-link__slug${flash ? ' fret-link__slug--flash' : ''}`}>
          /{typed}
        </span>
      )}
    </>
  )

  // The device carries three keys and no more, so previewing lives on the link
  // itself: the address is already on screen, and a link is a thing you click.
  if (onOpen && slug !== '' && typed === slug) {
    return (
      <button type="button" className="fret-link fret-link--open" onClick={onOpen}>
        {body}
      </button>
    )
  }
  return <span className="fret-link">{body}</span>
}
